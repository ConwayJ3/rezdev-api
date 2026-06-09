const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');

// GET /projects/:projectId/budget — full budget snapshot
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const pid = req.params.projectId;

  const [config, sections, transactions, gcDraws, investments] = await Promise.all([
    supabaseAdmin.from('budget_configs').select('*').eq('project_id', pid).single(),
    supabaseAdmin.from('budget_sections').select(`*, budget_items(*)`).eq('project_id', pid).order('sort_order'),
    supabaseAdmin.from('transactions').select('*').eq('project_id', pid).order('txn_date'),
    supabaseAdmin.from('gc_draws').select('*').eq('project_id', pid).order('created_at'),
    supabaseAdmin.from('investments').select('*').eq('project_id', pid).order('date'),
  ]);

  res.json({
    config:       config.data || null,
    sections:     sections.data || [],
    transactions: transactions.data || [],
    gc_draws:     gcDraws.data || [],
    investments:  investments.data || [],
  });
});

// PUT /projects/:projectId/budget/config — save general settings
router.put('/config', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const pid = req.params.projectId;
  const {
    living_sqft, finish_cost_sqft, foundation_sqft, porch_sqft, contingency_pct,
    gc_fee_type, gc_fee_val, gc_fee_amount, build_budget, total_budget
  } = req.body;

  const { data, error } = await supabaseAdmin
    .from('budget_configs')
    .upsert({ project_id: pid, living_sqft, finish_cost_sqft, foundation_sqft, porch_sqft,
      contingency_pct, gc_fee_type, gc_fee_val, gc_fee_amount, build_budget, total_budget,
      updated_at: new Date().toISOString() },
      { onConflict: 'project_id' })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /projects/:projectId/budget/sections — bulk upsert sections + items
router.put('/sections', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const pid = req.params.projectId;
  const { sections } = req.body;
  if(!Array.isArray(sections)) return res.status(400).json({ error: 'sections array required' });

  for(const sec of sections) {
    const { data: secData, error: secErr } = await supabaseAdmin
      .from('budget_sections')
      .upsert({ project_id: pid, section_id: sec.id, label: sec.label, icon: sec.icon,
        budget_amount: sec.budget || 0, sort_order: sec.sort_order || 0 },
        { onConflict: 'project_id,section_id' })
      .select()
      .single();

    if(secErr) continue;

    // Upsert items for this section
    if(sec.items && sec.items.length) {
      const itemRows = sec.items.map((it, i) => ({
        section_id:    secData.id,
        project_id:    pid,
        name:          it.name,
        item_type:     it.type || 'fixed',
        rate:          it.rate || null,
        budget_amount: it.budget || 0,
        sort_order:    i,
      }));
      await supabaseAdmin.from('budget_items').upsert(itemRows, { onConflict: 'section_id,project_id,name', ignoreDuplicates: false });
    }
  }

  res.json({ success: true });
});

// GET /projects/:projectId/budget/transactions
router.get('/transactions', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('transactions')
    .select(`*, budget_sections(section_id, label)`)
    .eq('project_id', req.params.projectId)
    .order('txn_date', { ascending: false });

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/:projectId/budget/transactions
router.post('/transactions', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { section_id, item_name, amount, payee, txn_date, notes } = req.body;
  if(!amount) return res.status(400).json({ error: 'amount required' });

  // section_id from frontend is a text key like 'soft' — resolve to budget_sections UUID
  let sectionUuid = null;
  if(section_id){
    // If it's already a UUID, use as-is; otherwise look up by text key
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(section_id);
    if(isUuid){
      sectionUuid = section_id;
    } else {
      let { data: secRow } = await supabaseAdmin
        .from('budget_sections')
        .select('id')
        .eq('project_id', req.params.projectId)
        .eq('section_id', section_id)
        .maybeSingle();
      if(!secRow){
        const labelMap = { soft:'Soft Costs', site:'Site Costs', meps:'MEPs', struct:'Structure', sel:'Selections', misc:'Miscellaneous' };
        const { data: created, error: createErr } = await supabaseAdmin
          .from('budget_sections')
          .upsert({ project_id: req.params.projectId, section_id, label: labelMap[section_id] || section_id, icon: '', budget_amount: 0, sort_order: 0 },
            { onConflict: 'project_id,section_id' })
          .select('id')
          .single();
        if(createErr) console.error('Section auto-create failed:', createErr.message);
        secRow = created;
      }
      sectionUuid = secRow ? secRow.id : null;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .insert({ project_id: req.params.projectId, section_id: sectionUuid, item_name, amount, payee, txn_date: txn_date || null, notes, created_by: req.userId })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /projects/:projectId/budget/transactions/:id
router.put('/transactions/:id', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { item_name, amount, payee, txn_date, notes } = req.body;

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({ item_name, amount, payee, txn_date: txn_date || null, notes })
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /projects/:projectId/budget/transactions/:id
router.delete('/transactions/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('transactions')
    .delete()
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId);

  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── GC Draws ─────────────────────────────────────────────────────
// GET /projects/:projectId/budget/gc-draws
router.get('/gc-draws', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('gc_draws')
    .select('*')
    .eq('project_id', req.params.projectId)
    .order('created_at');

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/:projectId/budget/gc-draws
router.post('/gc-draws', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { label, amount, due_date, notes } = req.body;
  if(!amount) return res.status(400).json({ error: 'amount required' });

  const { data, error } = await supabaseAdmin
    .from('gc_draws')
    .insert({ project_id: req.params.projectId, label, amount, due_date, notes })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /projects/:projectId/budget/gc-draws/:id/pay
router.put('/gc-draws/:id/pay', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('gc_draws')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /projects/:projectId/budget/gc-draws/:id
router.delete('/gc-draws/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('gc_draws')
    .delete()
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId);

  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── Investments ───────────────────────────────────────────────────
router.get('/investments', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('investments')
    .select('*')
    .eq('project_id', req.params.projectId)
    .order('date');
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.post('/investments', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { investor_name, amount, investment_type, date, notes } = req.body;
  const { data, error } = await supabaseAdmin
    .from('investments')
    .insert({ project_id: req.params.projectId, investor_name, amount, investment_type, date, notes })
    .select()
    .single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/investments/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('investments').delete()
    .eq('id', req.params.id).eq('project_id', req.params.projectId);
  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
