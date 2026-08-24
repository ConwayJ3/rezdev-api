const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /contractors
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await req.db
    .from('contractors')
    .select(`*, contractor_scores(overall_score, schedule_score, inspection_score, utilization_score, project_id)`)
    .eq('company_id', req.companyId)
    .order('company_name');

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /contractors/:id/invite — give a directory contractor portal access.
// Without this, a contractor added by hand can never sign a lien waiver or
// see their contracts: only the RFP award flow created accounts.
router.post('/:id/invite', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const { data: c } = await supabaseAdmin.from('contractors')
      .select('*').eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
    if(!c) return res.status(404).json({ error: 'Contractor not found' });
    if(c.user_id) return res.status(409).json({ error: 'This contractor already has portal access' });
    if(!c.email) return res.status(400).json({ error: 'Add an email address before inviting' });

    const emailNorm = String(c.email).trim().toLowerCase();
    const first = (c.contact_name || c.company_name || 'Contractor').split(' ')[0];
    const last  = (c.contact_name || '').split(' ').slice(1).join(' ');

    let userId = null;
    const tempPassword = 'RezDev' + Math.random().toString(36).slice(2,12) + '!A';
    const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: emailNorm,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { first_name: first, last_name: last, role: 'contractor' },
    });

    if(authErr){
      if(/already|registered|exists/i.test(authErr.message)){
        // They already have an account from elsewhere — link it rather than fail.
        const { data: existing } = await supabaseAdmin.from('users')
          .select('id').ilike('email', emailNorm).maybeSingle();
        userId = existing && existing.id;
        if(!userId) return res.status(409).json({ error: 'That email already has an account we cannot link' });
      } else {
        return res.status(400).json({ error: authErr.message });
      }
    } else {
      userId = authUser && authUser.user && authUser.user.id;
    }
    if(!userId) return res.status(500).json({ error: 'Could not create the account' });

    try {
      await supabaseAdmin.from('users').insert({
        id: userId, company_id: req.companyId,
        first_name: first, last_name: last,
        email: emailNorm, role: 'contractor', status: 'pending',
      });
    } catch(e){ /* profile may already exist */ }

    await supabaseAdmin.from('contractors')
      .update({ user_id: userId }).eq('id', c.id);

    const appUrl = process.env.FRONTEND_URL || 'https://www.rezdevos.com';
    const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery', email: emailNorm,
      options: { redirectTo: appUrl + '/set-password.html' },
    });
    const setupUrl = (linkData && linkData.properties && linkData.properties.action_link)
                     || (appUrl + '/set-password.html');

    let builderName = '', companyName = '';
    try {
      const { data: me } = await supabaseAdmin.from('users')
        .select('first_name,last_name').eq('id', req.userId).maybeSingle();
      if(me) builderName = [me.first_name, me.last_name].filter(Boolean).join(' ');
      const { data: co } = await supabaseAdmin.from('companies')
        .select('name').eq('id', req.companyId).maybeSingle();
      if(co) companyName = co.name;
    } catch(e){ /* non-fatal */ }

    try {
      const { sendClientInvite } = require('../lib/email');
      await sendClientInvite({
        to: emailNorm, clientName: first, builderName, companyName,
        setupUrl, role: 'contractor',
      });
    } catch(e){
      return res.status(502).json({ error: 'Account created but the invite email failed: ' + e.message });
    }

    res.json({ success: true, user_id: userId });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /contractors/:id
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await req.db
    .from('contractors')
    .select(`*, contractor_scores(*), contractor_activity(*)`)
    .eq('id', req.params.id)
    .single();

  if(error) return res.status(404).json({ error: 'Contractor not found' });

  // Mask banking details for non-owners/builders
  if(!['owner','builder'].includes(req.userRole)) {
    delete data.bank_account;
    delete data.wire_routing;
    delete data.ach_routing;
  }

  res.json(data);
});

// POST /contractors
router.post('/', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { company_name, contact_name, trade, email, phone, address,
    license_number, insurance_exp, insurance_carrier, notes } = req.body;

  if(!company_name) return res.status(400).json({ error: 'company_name required' });

  const { data, error } = await supabaseAdmin
    .from('contractors')
    .insert({ company_id: req.companyId, company_name, contact_name, trade, email, phone,
      address, license_number, insurance_exp, insurance_carrier, notes })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /contractors/:id
router.put('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const allowed = ['company_name','contact_name','trade','email','phone','address',
    'license_number','insurance_exp','insurance_carrier','status','notes',
    'bank_holder','bank_name','bank_account_type','bank_account','wire_routing','ach_routing'];
  const updates = {};
  allowed.forEach(k => { if(req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('contractors')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /contractors/:id/banking — contractor self-updates banking info
router.put('/:id/banking', requireAuth, async (req, res) => {
  // Contractors can only update their own record
  const { data: contractor } = await supabaseAdmin
    .from('contractors')
    .select('user_id')
    .eq('id', req.params.id)
    .single();

  const isSelf = contractor?.user_id === req.userId;
  const isAdmin = ['owner','builder'].includes(req.userRole);
  if(!isSelf && !isAdmin) return res.status(403).json({ error: 'Cannot update banking info for another contractor' });

  const { bank_holder, bank_name, bank_account_type, bank_account, wire_routing, ach_routing } = req.body;

  const { data, error } = await supabaseAdmin
    .from('contractors')
    .update({ bank_holder, bank_name, bank_account_type, bank_account, wire_routing, ach_routing, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('id, company_name, bank_holder, bank_name, bank_account_type, updated_at')
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /contractors/:id/score
router.get('/:id/score', requireAuth, async (req, res) => {
  const { data, error } = await req.db
    .from('contractor_scores')
    .select('*')
    .eq('contractor_id', req.params.id)
    .order('computed_at', { ascending: false });

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /contractors/:id/score/compute — trigger score recalculation
router.post('/:id/score/compute', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { project_id } = req.body;
  const contractorId = req.params.id;

  // Fetch QC submissions and inspections for scoring
  const [qcResult, inspResult, phaseResult] = await Promise.all([
    supabaseAdmin.from('qc_submissions').select('status').eq('contractor_id', contractorId),
    supabaseAdmin.from('inspections').select('result').eq('project_id', project_id || null),
    supabaseAdmin.from('trade_assignments').select('project_id').eq('contractor_id', contractorId),
  ]);

  const qcSubs   = qcResult.data || [];
  const insps    = inspResult.data || [];
  const approved = qcSubs.filter(q => q.status === 'approved').length;
  const total    = qcSubs.length || 1;
  const passInsp = insps.filter(i => i.result === 'pass').length;
  const totalInsp = insps.length || 1;

  const scheduleScore    = Math.round((approved / total) * 100);
  const inspectionScore  = Math.round((passInsp / totalInsp) * 100);
  const utilizationScore = Math.min(100, (phaseResult.data?.length || 0) * 20);
  const overallScore     = Math.round(scheduleScore * 0.6 + inspectionScore * 0.3 + utilizationScore * 0.1);

  const { data, error } = await supabaseAdmin
    .from('contractor_scores')
    .upsert({
      contractor_id:     contractorId,
      project_id:        project_id || null,
      schedule_score:    scheduleScore,
      inspection_score:  inspectionScore,
      utilization_score: utilizationScore,
      overall_score:     overallScore,
      computed_at:       new Date().toISOString(),
    }, { onConflict: 'contractor_id,project_id' })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /contractors/:id
router.delete('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('contractors')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
