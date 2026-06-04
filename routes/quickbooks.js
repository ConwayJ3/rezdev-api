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
router.QB_API_BASE = QB_API_BASE;
module.exports = router;
