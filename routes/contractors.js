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
