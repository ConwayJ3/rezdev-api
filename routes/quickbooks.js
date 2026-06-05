const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const QB_CLIENT_ID     = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI  = process.env.QB_REDIRECT_URI;
const QB_ENVIRONMENT   = process.env.QB_ENVIRONMENT || 'sandbox';

const QB_API_BASE = QB_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

const QB_AUTH_URL  = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// In-memory state store for CSRF protection during OAuth (short-lived)
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for(const [k,v] of oauthStates){ if(now - v.created > 600000) oauthStates.delete(k); }
}, 60000);

// ─── GET /integrations/quickbooks/status ───────────────────
router.get('/status', requireAuth, async (req, res) => {
  const { data } = await supabaseAdmin.from('quickbooks_tokens')
    .select('realm_id, connected_at, updated_at').eq('company_id', req.companyId).single();
  res.json({ connected: !!data, ...(data || {}) });
});

// ─── GET /integrations/quickbooks/connect ──────────────────
// Returns the Intuit authorize URL for the frontend to redirect to
router.get('/connect', requireAuth, requireRole('owner','builder'), async (req, res) => {
  if(!QB_CLIENT_ID || !QB_REDIRECT_URI) return res.status(500).json({ error: 'QuickBooks not configured' });
  const state = req.companyId + ':' + Math.random().toString(36).slice(2);
  oauthStates.set(state, { companyId: req.companyId, userId: req.userId, created: Date.now() });
  const params = new URLSearchParams({
    client_id: QB_CLIENT_ID,
    redirect_uri: QB_REDIRECT_URI,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state,
  });
  res.json({ url: QB_AUTH_URL + '?' + params.toString() });
});

// ─── GET /integrations/quickbooks/callback ─────────────────
// Intuit redirects here after the user authorizes. No auth middleware
// (the user arrives via browser redirect, identity carried in state).
router.get('/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;
  if(error) return res.redirect(frontendReturn('error', error));
  const stored = oauthStates.get(state);
  if(!stored) return res.redirect(frontendReturn('error', 'invalid_state'));
  oauthStates.delete(state);

  try {
    // Exchange authorization code for tokens
    const tokenResp = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(QB_CLIENT_ID + ':' + QB_CLIENT_SECRET).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: QB_REDIRECT_URI,
      }).toString(),
    });
    const tok = await tokenResp.json();
    if(!tok.access_token) return res.redirect(frontendReturn('error', 'token_exchange_failed'));

    const now = Date.now();
    await supabaseAdmin.from('quickbooks_tokens').upsert({
      company_id: stored.companyId,
      realm_id: realmId,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      access_token_expires_at: new Date(now + tok.expires_in*1000).toISOString(),
      refresh_token_expires_at: new Date(now + tok.x_refresh_token_expires_in*1000).toISOString(),
      connected_by: stored.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id' });

    res.redirect(frontendReturn('connected'));
  } catch(e){
    console.error('QB callback error:', e);
    res.redirect(frontendReturn('error', 'exception'));
  }
});

// ─── POST /integrations/quickbooks/disconnect ──────────────
router.post('/disconnect', requireAuth, requireRole('owner','builder'), async (req, res) => {
  await supabaseAdmin.from('quickbooks_tokens').delete().eq('company_id', req.companyId);
  res.json({ success: true });
});

// Helper: build the frontend return URL
function frontendReturn(status, detail){
  const base = process.env.FRONTEND_URL || 'https://rezdevos.com';
  let url = base + '/company-settings.html?qb=' + status;
  if(detail) url += '&detail=' + encodeURIComponent(detail);
  return url;
}

// ─── Helper: call the QuickBooks API with a valid token ────
async function qbApiCall(companyId, method, path, body){
  const tok = await getValidToken(companyId);
  if(!tok) throw new Error('QuickBooks not connected');
  const url = QB_API_BASE + '/v3/company/' + tok.realmId + path;
  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + tok.accessToken,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };
  if(body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch(e){ json = { raw: text }; }
  if(!resp.ok){
    const err = new Error('QB API error: ' + resp.status);
    err.detail = json; err.status = resp.status;
    throw err;
  }
  return json;
}

// ─── GET /integrations/quickbooks/customers ────────────────
// List all Customers from the connected QB company
router.get('/customers', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const q = encodeURIComponent('SELECT * FROM Customer MAXRESULTS 1000');
    const data = await qbApiCall(req.companyId, 'GET', '/query?query=' + q);
    const customers = (data.QueryResponse && data.QueryResponse.Customer) || [];
    res.json(customers.map(c => ({
      id: c.Id, name: c.DisplayName || c.CompanyName || c.FullyQualifiedName,
      active: c.Active, balance: c.Balance,
    })));
  } catch(e){
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// ─── GET /integrations/quickbooks/mappings ─────────────────
// List this company's projects and their QB customer mapping
router.get('/mappings', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { data: projects } = await supabaseAdmin.from('projects')
    .select('id, name, address, city, state').eq('company_id', req.companyId);
  const { data: maps } = await supabaseAdmin.from('quickbooks_customer_map')
    .select('project_id, qb_customer_id, qb_customer_name').eq('company_id', req.companyId);
  const mapByProject = {};
  (maps || []).forEach(m => { mapByProject[m.project_id] = m; });
  res.json((projects || []).map(p => ({
    project_id: p.id,
    project_name: p.name || p.address,
    address: [p.address, p.city, p.state].filter(Boolean).join(', '),
    qb_customer_id: mapByProject[p.id]?.qb_customer_id || null,
    qb_customer_name: mapByProject[p.id]?.qb_customer_name || null,
  })));
});

// ─── POST /integrations/quickbooks/mappings ────────────────
// Link a project to an existing QB customer
router.post('/mappings', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { project_id, qb_customer_id, qb_customer_name } = req.body;
  if(!project_id || !qb_customer_id) return res.status(400).json({ error: 'project_id and qb_customer_id required' });
  const { data, error } = await supabaseAdmin.from('quickbooks_customer_map').upsert({
    company_id: req.companyId, project_id, qb_customer_id, qb_customer_name: qb_customer_name || null,
  }, { onConflict: 'project_id' }).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ─── DELETE /integrations/quickbooks/mappings/:projectId ───
router.delete('/mappings/:projectId', requireAuth, requireRole('owner','builder'), async (req, res) => {
  await supabaseAdmin.from('quickbooks_customer_map').delete()
    .eq('company_id', req.companyId).eq('project_id', req.params.projectId);
  res.json({ success: true });
});

// ─── POST /integrations/quickbooks/customers/create ────────
// Create a new QB customer from a RezDev project, then map it
router.post('/customers/create', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { project_id } = req.body;
  if(!project_id) return res.status(400).json({ error: 'project_id required' });
  const { data: proj } = await supabaseAdmin.from('projects')
    .select('id, name, address, city, state, zip').eq('id', project_id).eq('company_id', req.companyId).single();
  if(!proj) return res.status(404).json({ error: 'Project not found' });
  try {
    const displayName = proj.name || proj.address || ('Project ' + project_id.slice(0,8));
    const customerBody = {
      DisplayName: displayName,
      CompanyName: displayName,
    };
    if(proj.address){
      customerBody.BillAddr = {
        Line1: proj.address, City: proj.city || '', CountrySubDivisionCode: proj.state || '', PostalCode: proj.zip || '',
      };
    }
    const created = await qbApiCall(req.companyId, 'POST', '/customer', customerBody);
    const qbCust = created.Customer;
    await supabaseAdmin.from('quickbooks_customer_map').upsert({
      company_id: req.companyId, project_id,
      qb_customer_id: qbCust.Id, qb_customer_name: qbCust.DisplayName,
    }, { onConflict: 'project_id' });
    res.status(201).json({ qb_customer_id: qbCust.Id, qb_customer_name: qbCust.DisplayName });
  } catch(e){
    res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
});

// ─── Token refresh helper (exported for use by sync/webhook) ──
async function getValidToken(companyId){
  const { data: row } = await supabaseAdmin.from('quickbooks_tokens')
    .select('*').eq('company_id', companyId).single();
  if(!row) return null;

  // Refresh if access token expires within 5 minutes
  if(new Date(row.access_token_expires_at).getTime() - Date.now() < 300000){
    const resp = await fetch(QB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(QB_CLIENT_ID + ':' + QB_CLIENT_SECRET).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: row.refresh_token,
      }).toString(),
    });
    const tok = await resp.json();
    if(tok.access_token){
      const now = Date.now();
      await supabaseAdmin.from('quickbooks_tokens').update({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || row.refresh_token,
        access_token_expires_at: new Date(now + tok.expires_in*1000).toISOString(),
        refresh_token_expires_at: tok.x_refresh_token_expires_in ? new Date(now + tok.x_refresh_token_expires_in*1000).toISOString() : row.refresh_token_expires_at,
        updated_at: new Date().toISOString(),
      }).eq('company_id', companyId);
      return { accessToken: tok.access_token, realmId: row.realm_id };
    }
    return null;
  }
  return { accessToken: row.access_token, realmId: row.realm_id };
}

router.getValidToken = getValidToken;
router.qbApiCall = qbApiCall;
router.QB_API_BASE = QB_API_BASE;
module.exports = router;
