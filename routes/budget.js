const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const { uploadFile, deleteFile } = require('../lib/storage');

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
    living_sqft, finish_cost_sqft, foundation_sqft, porch_sqft, garage_sqft, contingency_pct,
    gc_fee_type, gc_fee_val, gc_fee_amount, build_budget, total_budget, calc_data
  } = req.body;

  const row = { project_id: pid, living_sqft, finish_cost_sqft, foundation_sqft, porch_sqft, garage_sqft,
      contingency_pct, gc_fee_type, gc_fee_val, gc_fee_amount, build_budget, total_budget,
      updated_at: new Date().toISOString() };
  if(calc_data !== undefined) row.calc_data = calc_data;

  const { data, error } = await supabaseAdmin
    .from('budget_configs')
    .upsert(row, { onConflict: 'project_id' })
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

    // Replace this section's items wholesale: delete all, then insert the incoming set.
    // NOTE (scale): this is a full delete+insert on every save. Fine at current scale
    // (tens of items/project). Revisit with a diff-based sync (insert new / update
    // changed / delete removed) once budget_items are referenced by id elsewhere
    // (e.g. transactions linking to a specific item id) so ids stay stable.
    await supabaseAdmin.from('budget_items').delete()
      .eq('section_id', secData.id).eq('project_id', pid);
    if(sec.items && sec.items.length) {
      const itemRows = sec.items.map((it, i) => ({
        section_id:    secData.id,
        project_id:    pid,
        name:          it.name,
        item_type:     it.type || 'fixed',
        rate:          (it.rate === 0 || it.rate) ? it.rate : null,
        quantity:      it.quantity != null ? it.quantity : null,
        budget_amount: it.budget || 0,
        sort_order:    i,
      }));
      await supabaseAdmin.from('budget_items').insert(itemRows);
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
  const { item_name, amount, payee, txn_date, notes, attachments } = req.body;

  const patch = { item_name, amount, payee, txn_date: txn_date || null, notes };
  // Only touch attachments when the caller sent them — a normal edit must not
  // wipe receipts that were uploaded separately.
  if(Array.isArray(attachments)) patch.attachments = attachments;

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update(patch)
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/:projectId/budget/transactions/:id/attachments
// Receipts and invoices backing a transaction. Private bucket — these carry
// vendor pricing and are builder-only.
router.post('/transactions/:id/attachments', requireAuth, requireRole('owner','builder','pm'),
            requireProjectAccess, upload.array('files', 10), async (req, res) => {
  try {
    if(!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });

    const { data: txn } = await supabaseAdmin.from('transactions')
      .select('id, attachments').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!txn) return res.status(404).json({ error: 'Transaction not found' });

    const existing = Array.isArray(txn.attachments) ? txn.attachments : [];
    const added = [];
    for(const file of req.files){
      const safe = (file.originalname || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = req.params.projectId + '/receipts/' + req.params.id + '/' + Date.now() + '_' + safe;
      try {
        const stored = await uploadFile('files', path, file.buffer, file.mimetype);
        added.push({ id: 'rc_' + Date.now() + '_' + added.length,
                     name: file.originalname, path: stored,
                     size: file.size, mime_type: file.mimetype });
      } catch(e){
        console.error('[Budget] receipt upload failed:', e && (e.message||e));
      }
    }
    if(!added.length) return res.status(500).json({ error: 'Upload failed' });

    const merged = existing.concat(added);
    const { error } = await supabaseAdmin.from('transactions')
      .update({ attachments: merged }).eq('id', txn.id);
    if(error) return res.status(400).json({ error: error.message });

    res.status(201).json({ attachments: merged, added: added.length });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// DELETE one attachment off a transaction
router.delete('/transactions/:id/attachments/:fileId', requireAuth,
              requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  try {
    const { data: txn } = await supabaseAdmin.from('transactions')
      .select('id, attachments').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!txn) return res.status(404).json({ error: 'Transaction not found' });

    const existing = Array.isArray(txn.attachments) ? txn.attachments : [];
    const gone = existing.find(function(f){ return f.id === req.params.fileId; });
    const kept = existing.filter(function(f){ return f.id !== req.params.fileId; });
    if(gone && gone.path){
      try { await deleteFile('files', gone.path); }
      catch(e){ console.log('[Budget] receipt cleanup failed:', e.message); }
    }
    const { error } = await supabaseAdmin.from('transactions')
      .update({ attachments: kept }).eq('id', txn.id);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ attachments: kept });
  } catch(e){ res.status(500).json({ error: e.message }); }
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
