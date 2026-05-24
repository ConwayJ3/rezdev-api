// ═══════════════════════════════════════════════════════════════════
// CHANGE ORDERS — /projects/:projectId/change-orders
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');

const coRouter = express.Router({ mergeParams: true });

coRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('change_orders').select('*').eq('project_id', req.params.projectId).order('submitted_at', { ascending: false });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

coRouter.post('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { title, explanation, category, amount, notes } = req.body;
  if(!title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await supabaseAdmin.from('change_orders')
    .insert({ project_id: req.params.projectId, title, explanation, category, amount, notes, status: 'pending_review', submitted_by: req.userId })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

coRouter.put('/:id', requireAuth, requireProjectAccess, async (req, res) => {
  const { status, builder_cost, builder_notes } = req.body;
  const updates = {};
  if(status)        updates.status = status;
  if(builder_cost  !== undefined) updates.builder_cost = builder_cost;
  if(builder_notes !== undefined) updates.builder_notes = builder_notes;
  if(['approved','denied'].includes(status)) { updates.reviewed_by = req.userId; updates.reviewed_at = new Date().toISOString(); }
  if(status === 'approved') updates.approved_at = new Date().toISOString();
  if(['denied','client_denied'].includes(status)) updates.declined_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('change_orders').update(updates).eq('id', req.params.id).eq('project_id', req.params.projectId).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════
// SELECTIONS — /projects/:projectId/selections
// ═══════════════════════════════════════════════════════════════════
const multer  = require('multer');
const { uploadFile, getSignedUrl } = require('../lib/storage');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const selRouter = express.Router({ mergeParams: true });

selRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('selections')
    .select(`*, selection_images(id, storage_url, file_name, added_at), selection_links(id, url, label, added_at)`)
    .eq('project_id', req.params.projectId);
  if(error) return res.status(400).json({ error: error.message });
  // Generate signed URLs for images
  const withUrls = await Promise.all(data.map(async sel => ({
    ...sel,
    selection_images: await Promise.all((sel.selection_images||[]).map(async img => ({
      ...img, signed_url: await getSignedUrl('selections', img.storage_url).catch(()=>null)
    })))
  })));
  res.json(withUrls);
});

selRouter.put('/:itemName', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { budget_amount, actual_cost, vendor, notes, chosen_type, chosen_id } = req.body;
  const { data, error } = await supabaseAdmin.from('selections')
    .upsert({ project_id: req.params.projectId, item_name: req.params.itemName, budget_amount, actual_cost, vendor, notes, chosen_type, chosen_id, updated_at: new Date().toISOString() }, { onConflict: 'project_id,item_name' })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

selRouter.post('/:itemName/images', requireAuth, requireRole('owner','builder'), requireProjectAccess, upload.array('images',10), async (req, res) => {
  const { data: sel } = await supabaseAdmin.from('selections').select('id').eq('project_id', req.params.projectId).eq('item_name', req.params.itemName).single();
  if(!sel) return res.status(404).json({ error: 'Selection not found — save it first' });
  const uploaded = [];
  for(const file of req.files||[]) {
    const path = `${req.params.projectId}/${sel.id}/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g,'_')}`;
    const storagePath = await uploadFile('selections', path, file.buffer, file.mimetype).catch(()=>null);
    if(storagePath) {
      const { data } = await supabaseAdmin.from('selection_images').insert({ selection_id: sel.id, storage_url: storagePath, file_name: file.originalname, file_size: file.size }).select().single();
      if(data) uploaded.push(data);
    }
  }
  res.status(201).json(uploaded);
});

selRouter.post('/:itemName/links', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { url, label } = req.body;
  if(!url) return res.status(400).json({ error: 'url required' });
  const { data: sel } = await supabaseAdmin.from('selections').select('id').eq('project_id', req.params.projectId).eq('item_name', req.params.itemName).single();
  if(!sel) return res.status(404).json({ error: 'Selection not found' });
  const { data, error } = await supabaseAdmin.from('selection_links').insert({ selection_id: sel.id, url, label }).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTS — /projects/:projectId/contracts
// ═══════════════════════════════════════════════════════════════════
const ctrRouter = express.Router({ mergeParams: true });

ctrRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('contracts').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

ctrRouter.post('/', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { title, body, contractor_id, contracted_amount, start_date } = req.body;
  const { data, error } = await supabaseAdmin.from('contracts')
    .insert({ project_id: req.params.projectId, title, body, contractor_id, contracted_amount, start_date, status: 'draft', created_by: req.userId })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

ctrRouter.put('/:id/send', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('contracts')
    .update({ status: 'sent', sent_at: new Date().toISOString(), activity_log: supabaseAdmin.sql`activity_log || '[{"action":"sent","at":"${new Date().toISOString()}"}]'::jsonb` })
    .eq('id', req.params.id).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

ctrRouter.put('/:id/sign', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('contracts')
    .update({ status: 'signed', signed_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

ctrRouter.put('/:id/decline', requireAuth, async (req, res) => {
  const { reason } = req.body;
  const { data, error } = await supabaseAdmin.from('contracts')
    .update({ status: 'declined', declined_at: new Date().toISOString(), decline_reason: reason || '' })
    .eq('id', req.params.id).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTOR PAYMENTS — /projects/:projectId/payments
// ═══════════════════════════════════════════════════════════════════
const payRouter = express.Router({ mergeParams: true });

payRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('contractor_payments')
    .select(`*, payment_draws(*), contracts(title, contractor_id)`)
    .eq('project_id', req.params.projectId);
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

payRouter.post('/', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { contract_id, contractor_id, contracted_amount, payment_method } = req.body;
  const { data, error } = await supabaseAdmin.from('contractor_payments')
    .insert({ project_id: req.params.projectId, contract_id, contractor_id, contracted_amount: contracted_amount||0, payment_method: payment_method||'wire' })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

payRouter.post('/:paymentId/draws', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { label, amount, draw_date, notes } = req.body;
  if(!amount) return res.status(400).json({ error: 'amount required' });
  const { data, error } = await supabaseAdmin.from('payment_draws')
    .insert({ payment_id: req.params.paymentId, project_id: req.params.projectId, label, amount, draw_date, notes })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

payRouter.put('/:paymentId/draws/:drawId/pay', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('payment_draws')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', req.params.drawId).eq('payment_id', req.params.paymentId).select().single();
  if(error) return res.status(400).json({ error: error.message });

  // Check if fully paid — auto-trigger lien waiver
  const { data: payment } = await supabaseAdmin.from('contractor_payments').select('contracted_amount, contractor_id, contract_id').eq('id', req.params.paymentId).single();
  const { data: draws }   = await supabaseAdmin.from('payment_draws').select('amount, status').eq('payment_id', req.params.paymentId);
  const totalPaid = (draws||[]).filter(d=>d.status==='paid').reduce((s,d)=>s+d.amount,0);

  if(payment && totalPaid >= payment.contracted_amount && payment.contracted_amount > 0) {
    await supabaseAdmin.from('lien_waivers').insert({
      project_id: req.params.projectId, contract_id: payment.contract_id,
      contractor_id: payment.contractor_id, waiver_type: 'unconditional_final',
      amount: payment.contracted_amount, status: 'pending',
    });
  }

  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════
// WARRANTIES — /projects/:projectId/warranties
// ═══════════════════════════════════════════════════════════════════
const wrnRouter = express.Router({ mergeParams: true });

wrnRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('warranties').select(`*, warranty_claims(*)`).eq('project_id', req.params.projectId);
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

wrnRouter.post('/', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { warranty_type, contractor_id, contractor_name, start_date, end_date, coverage_desc, notes } = req.body;
  const { data, error } = await supabaseAdmin.from('warranties')
    .insert({ project_id: req.params.projectId, warranty_type, contractor_id, contractor_name, start_date, end_date, coverage_desc, notes })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

wrnRouter.post('/:warrantyId/claims', requireAuth, requireProjectAccess, async (req, res) => {
  const { description, claim_date } = req.body;
  if(!description) return res.status(400).json({ error: 'description required' });
  const { data, error } = await supabaseAdmin.from('warranty_claims')
    .insert({ warranty_id: req.params.warrantyId, project_id: req.params.projectId, description, claim_date: claim_date || new Date().toISOString().slice(0,10), created_by: req.userId })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

wrnRouter.put('/:warrantyId/claims/:claimId', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { status, resolution_notes, resolved_date } = req.body;
  const { data, error } = await supabaseAdmin.from('warranty_claims')
    .update({ status, resolution_notes, resolved_date }).eq('id', req.params.claimId).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════════
// QC — /projects/:projectId/qc
// ═══════════════════════════════════════════════════════════════════
const qcRouter = express.Router({ mergeParams: true });

qcRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('qc_submissions').select('*').eq('project_id', req.params.projectId).order('submitted_at', { ascending: false });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

qcRouter.post('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { phase_id, contractor_id, contractor_name, trade, checklist_items } = req.body;
  const { data, error } = await supabaseAdmin.from('qc_submissions')
    .insert({ project_id: req.params.projectId, phase_id, contractor_id, contractor_name, trade, checklist_items: checklist_items||[], status: 'submitted' })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

qcRouter.put('/:id/approve', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { data, error } = await supabaseAdmin.from('qc_submissions')
    .update({ status: 'approved', reviewed_by: req.userId, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

qcRouter.put('/:id/revision', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { revision_notes } = req.body;
  const { data, error } = await supabaseAdmin.from('qc_submissions')
    .update({ status: 'revision_requested', revision_notes, reviewed_by: req.userId, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// RFPs — /rfps
const rfpRouter = express.Router();

rfpRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await req.db.from('rfps').select(`*, rfp_bids(*)`).eq('company_id', req.companyId).order('created_at', { ascending: false });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

rfpRouter.post('/', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { project_id, title, trade, description, scope, due_date, budget_range, is_public } = req.body;
  const { data, error } = await supabaseAdmin.from('rfps')
    .insert({ company_id: req.companyId, project_id, title, trade, description, scope, due_date, budget_range, is_public: is_public||false, created_by: req.userId })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

rfpRouter.post('/:id/bids', async (req, res) => {
  const { contractor_name, contractor_id, amount, timeline_days, notes } = req.body;
  const { data, error } = await supabaseAdmin.from('rfp_bids')
    .insert({ rfp_id: req.params.id, contractor_id, contractor_name, amount, timeline_days, notes })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

rfpRouter.put('/:id/bids/:bidId', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabaseAdmin.from('rfp_bids')
    .update({ status, reviewed_at: new Date().toISOString() }).eq('id', req.params.bidId).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = { coRouter, selRouter, ctrRouter, payRouter, wrnRouter, qcRouter, rfpRouter };
