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
  const { title, explanation, category, amount, notes, link } = req.body;
  if(!title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await supabaseAdmin.from('change_orders')
    .insert({ project_id: req.params.projectId, title, explanation, category, amount, notes, link, status: 'pending_review', submitted_by: req.userId })
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
    const storagePath = await uploadFile('selections', path, file.buffer, file.mimetype).catch(function(err){
      console.error('[Selections] image upload failed:', err && (err.message||err));
      return null;
    });
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

// Upload a redlined/revised DOCX for an existing contract.
// Creates a NEW contract row superseding the original; the original is untouched.
ctrRouter.post('/:id/revised-docx', requireAuth, requireRole('owner','builder'),
               requireProjectAccess, upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const name = (req.file.originalname || '').toLowerCase();
    if(!name.endsWith('.docx')){
      return res.status(400).json({ error: 'Revised contract must be a .docx file' });
    }

    // Original must exist AND belong to this project.
    const { data: orig, error: origErr } = await supabaseAdmin.from('contracts')
      .select('*')
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId)
      .single();
    if(origErr || !orig) return res.status(404).json({ error: 'Contract not found' });

    // Private bucket — a redlined contract carries negotiated terms.
    const safe = (req.file.originalname || 'revised.docx').replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = req.params.projectId + '/contracts/' + Date.now() + '_' + safe;
    let storedPath;
    try {
      storedPath = await uploadFile('files', storagePath, req.file.buffer, req.file.mimetype);
    } catch(e){
      console.error('[Contracts] revised docx upload failed:', e && (e.message || e));
      return res.status(500).json({ error: 'Upload failed' });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('contracts')
      .insert({
        project_id:             req.params.projectId,
        title:                  orig.title,
        body:                   orig.body,
        contractor_id:          orig.contractor_id,
        contracted_amount:      orig.contracted_amount,
        start_date:             orig.start_date,
        contract_type:          orig.contract_type,
        recipient_email:        orig.recipient_email,
        status:                 'draft',
        source:                 'uploaded_revision',
        revised_docx_url:       storedPath,
        supersedes_contract_id: orig.id,
        tag_rules:              [],
        created_by:             req.userId,
        activity_log: [{ action: 'revision uploaded', at: now, file: req.file.originalname }],
      })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });

    res.status(201).json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Signed URL for a revised contract's DOCX (private bucket).
ctrRouter.get('/:id/revised-docx-url', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const { data: c } = await supabaseAdmin.from('contracts')
      .select('revised_docx_url')
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId)
      .single();
    if(!c || !c.revised_docx_url) return res.status(404).json({ error: 'No revised document' });
    const url = await getSignedUrl('files', c.revised_docx_url);
    res.json({ url });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Delete an UNSENT revision draft. Intentionally narrow: sent contracts and
// template contracts are never deletable here — removing either would break
// the audit chain this feature exists to preserve.
ctrRouter.delete('/:id', requireAuth, requireRole('owner','builder'),
                 requireProjectAccess, async (req, res) => {
  try {
    const { data: c } = await supabaseAdmin.from('contracts')
      .select('*')
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId)
      .maybeSingle();
    if(!c) return res.status(404).json({ error: 'Contract not found' });

    if(c.source !== 'uploaded_revision'){
      return res.status(409).json({ error: 'Only uploaded revisions can be deleted here' });
    }
    if(c.status !== 'draft' || c.signwell_document_id){
      return res.status(409).json({ error: 'This revision has already been sent and cannot be deleted' });
    }

    const { data: children } = await supabaseAdmin.from('contracts')
      .select('id').eq('supersedes_contract_id', c.id).limit(1);
    if(children && children.length){
      return res.status(409).json({ error: 'Another revision supersedes this one' });
    }

    // Best effort — a stranded file is better than a failed delete.
    if(c.revised_docx_url){
      try {
        const { deleteFile } = require('../lib/storage');
        await deleteFile('files', c.revised_docx_url);
      } catch(e){ console.log('[Contracts] revision file cleanup failed:', e.message); }
    }

    const { error } = await supabaseAdmin.from('contracts').delete().eq('id', c.id);
    if(error) return res.status(400).json({ error: error.message });

    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Archive / unarchive. Non-destructive, so allowed at any status — unlike
// delete, which is limited to unsent revision drafts.
ctrRouter.put('/:id/archive', requireAuth, requireRole('owner','builder'),
              requireProjectAccess, async (req, res) => {
  try {
    const archived = req.body.archived !== false;
    const { data, error } = await supabaseAdmin.from('contracts')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId)
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    if(!data)  return res.status(404).json({ error: 'Contract not found' });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// CONTRACTOR PAYMENTS — /projects/:projectId/payments
// ═══════════════════════════════════════════════════════════════════
const payRouter = express.Router({ mergeParams: true });

payRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db.from('contractor_payments')
    .select(`id, project_id, contracted_amount, payment_method, contractor_name, created_at, payment_draws(*), contracts(title, contractor_id)`)
    .eq('project_id', req.params.projectId);
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

payRouter.post('/', requireAuth, requireRole('owner','builder'), requireProjectAccess, async (req, res) => {
  const { contract_id, contractor_id, contracted_amount, payment_method, contractor_name, phase, notes } = req.body;
  // contractor_id is optional — only include if it looks like a UUID
  const isUUID = contractor_id && /^[0-9a-f-]{36}$/.test(contractor_id);
  const insert = {
    project_id:        req.params.projectId,
    contracted_amount: contracted_amount||0,
    payment_method:    payment_method||'wire',
    contractor_name:   contractor_name || '',
  };
  if(contract_id) insert.contract_id = contract_id;
  if(isUUID) insert.contractor_id = contractor_id;
  const { data, error } = await supabaseAdmin.from('contractor_payments')
    .insert(insert).select().single();
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
const rfpRouter = express.Router({ mergeParams: true });

rfpRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await req.db.from('rfps').select(`*, rfp_bids(*)`).eq('company_id', req.companyId).eq('project_id', req.params.projectId).order('created_at', { ascending: false });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

rfpRouter.post('/', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { title, trade, trades, description, scope, due_date, deadline, start_date, duration, notes, external_emails, sent_to, attached_file_ids, is_public } = req.body;
  const crypto = require('crypto');
  const public_token = crypto.randomBytes(16).toString('hex');
  const { data, error } = await supabaseAdmin.from('rfps')
    .insert({
      company_id: req.companyId,
      project_id: req.params.projectId,
      title, trade, description, scope, due_date,
      trades:            Array.isArray(trades) ? trades : [],
      deadline:          deadline || due_date,
      start_date:        start_date || null,
      duration:          duration || null,
      notes:             notes || null,
      external_emails:   Array.isArray(external_emails) ? external_emails : [],
      sent_to:           Array.isArray(sent_to) ? sent_to : [],
      attached_file_ids: Array.isArray(attached_file_ids) ? attached_file_ids : [],
      is_public:         is_public || false,
      created_by:        req.userId,
      public_token,
      status: 'open',
    })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

rfpRouter.put('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const allowed = ['title','trade','trades','description','scope','due_date','deadline',
                   'start_date','duration','notes','external_emails','sent_to',
                   'attached_file_ids','status'];
  const patch = {};
  for(const k of allowed) if(k in req.body) patch[k] = req.body[k];
  if(!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
  const { data, error } = await supabaseAdmin.from('rfps')
    .update(patch)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  if(!data)  return res.status(404).json({ error: 'RFP not found' });
  res.json(data);
});

rfpRouter.delete('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  // Never destroy an RFP that contractors have already bid on — cancel it instead.
  const { data: bids } = await supabaseAdmin.from('rfp_bids')
    .select('id').eq('rfp_id', req.params.id).limit(1);
  if(bids && bids.length){
    return res.status(409).json({ error: 'This RFP has bids. Cancel it instead of deleting.' });
  }
  const { error } = await supabaseAdmin.from('rfps')
    .delete().eq('id', req.params.id).eq('company_id', req.companyId);
  if(error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
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

// PROJECT CONTRACTORS
const pContractorRouter = require('express').Router({ mergeParams: true });
pContractorRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('project_contractors').select('*, users(id, first_name, last_name, email)').eq('project_id', req.params.projectId);
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
pContractorRouter.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { user_id, trade } = req.body;
    if(!user_id) return res.status(400).json({ error: 'user_id required' });
    const { data, error } = await supabaseAdmin.from('project_contractors').upsert({ project_id: req.params.projectId, user_id, trade }, { onConflict: 'project_id,user_id' }).select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
pContractorRouter.delete('/:userId', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    await supabaseAdmin.from('project_contractors').delete().eq('project_id', req.params.projectId).eq('user_id', req.params.userId);
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// LIEN WAIVERS
const lienRouter = require('express').Router({ mergeParams: true });
lienRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('lien_waivers').select('*').eq('project_id', req.params.projectId).order('created_at', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
lienRouter.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { contractor_id, contractor_name, amount, waiver_type } = req.body;
    const { data, error } = await supabaseAdmin.from('lien_waivers').insert({ project_id: req.params.projectId, contractor_id, contractor_name, amount, waiver_type: waiver_type||'conditional', status: 'pending' }).select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
lienRouter.put('/:id/sign', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('lien_waivers').update({ status: 'signed', signed_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// PM TEMPLATES ────────────────────────────────────────────
const tmplRouter = require('express').Router();
tmplRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('pm_templates').select('*').eq('company_id', req.companyId).order('created_at');
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
tmplRouter.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { name, description, icon, phase_data } = req.body;
    if(!name) return res.status(400).json({ error: 'name required' });
    const { data, error } = await supabaseAdmin.from('pm_templates')
      .insert({ company_id: req.companyId, name, description, icon: icon||'📋', phase_data: phase_data||[], created_by: req.userId })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
tmplRouter.delete('/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    await supabaseAdmin.from('pm_templates').delete().eq('id', req.params.id).eq('company_id', req.companyId);
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// PUBLIC endpoint — no auth required — lookup RFP by token
const publicRfpRouter = require('express').Router();
publicRfpRouter.get('/:token', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rfps')
      .select('id, title, trade, trades, description, scope, deadline, start_date, duration, notes, status, project_id, company_id, attached_file_ids, rfp_bids(id)')
      .eq('public_token', req.params.token)
      .single();
    if(error || !data) return res.status(404).json({ error: 'RFP not found' });

    // Bidders are unauthenticated, so the RFP payload must CARRY everything they need.
    // 1. The company's contractor agreement (the pristine original template)
    let agreement = null;
    try {
      const { data: tmpl } = await supabaseAdmin
        .from('contract_templates')
        .select('template_name, original_docx_url, docx_url')
        .eq('company_id', data.company_id)
        .eq('contract_type', 'contractor')
        .maybeSingle();
      const url = tmpl && (tmpl.original_docx_url || tmpl.docx_url);
      if(url) agreement = { name: (tmpl.template_name || 'Contractor Agreement'), url };
    } catch(e){ /* no agreement configured */ }

    // 2. Project files shared with this RFP (signed URLs — bidders are unauthenticated)
    // SECURITY: only files the builder explicitly attached to THIS rfp are exposed.
    // An empty/absent attached_file_ids means expose nothing — never the whole project.
    let files = [];
    const allowedFileIds = Array.isArray(data.attached_file_ids)
      ? data.attached_file_ids.map(String)
      : [];
    try {
      if(!allowedFileIds.length) throw new Error('no files attached to this rfp');
      const { data: pf } = await supabaseAdmin
        .from('project_files')
        .select('id, name, storage_url, file_size, mime_type')
        .eq('project_id', data.project_id)
        .in('id', allowedFileIds)
        .order('uploaded_at', { ascending: false });
      const { getSignedUrl } = require('../lib/storage');
      files = await Promise.all((pf||[]).map(async f => {
        let url = null;
        try { url = await getSignedUrl('files', f.storage_url); } catch(e){}
        return { id: f.id, name: f.name, size: f.file_size, mime_type: f.mime_type, url };
      }));
      files = files.filter(f => f.url);
    } catch(e){ /* no files */ }

    const payload = Object.assign({}, data, { agreement, files });
    delete payload.attached_file_ids;
    res.json(payload);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

publicRfpRouter.post('/:token/bid', async (req, res) => {
  try {
    const { data: rfp } = await supabaseAdmin.from('rfps').select('id, status, deadline').eq('public_token', req.params.token).single();
    if(!rfp) return res.status(404).json({ error: 'RFP not found' });
    if(rfp.status !== 'open') return res.status(400).json({ error: 'RFP is no longer accepting bids' });
    if(rfp.deadline && new Date(rfp.deadline) < new Date()) return res.status(400).json({ error: 'Bid deadline has passed' });
    const { contractor_name, company_name, email, phone, trade, amount, timeline_days, notes } = req.body;
    if(!contractor_name || !email) return res.status(400).json({ error: 'name and email required' });
    const { data, error } = await supabaseAdmin.from('rfp_bids')
      .insert({ rfp_id: rfp.id, contractor_name, company_name, email, phone, trade, amount, timeline_days, notes, status: 'submitted', submitted_at: new Date().toISOString() })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// exports moved to end of file

// GC DRAWS ─────────────────────────────────────────────────
const gcDrawRouter = require('express').Router({ mergeParams: true });
gcDrawRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('gc_draws').select('*').eq('project_id', req.params.projectId).order('created_at');
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
gcDrawRouter.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { label, amount, due_date, notes } = req.body;
  if(!label) return res.status(400).json({ error: 'label required' });
  const { data, error } = await supabaseAdmin.from('gc_draws').insert({ project_id: req.params.projectId, label, amount: amount||0, due_date: due_date||null, notes: notes||'' }).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
gcDrawRouter.put('/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const allowed = ['label','amount','due_date','notes','status','paid_date'];
  const updates = {};
  allowed.forEach(k => { if(req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabaseAdmin.from('gc_draws').update(updates).eq('id', req.params.id).eq('project_id', req.params.projectId).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
gcDrawRouter.delete('/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  await supabaseAdmin.from('gc_draws').delete().eq('id', req.params.id).eq('project_id', req.params.projectId);
  res.json({ success: true });
});

// INSPECTIONS ──────────────────────────────────────────────
const inspRouter = require('express').Router({ mergeParams: true });
inspRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('project_inspections').select('*').eq('project_id', req.params.projectId);
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
inspRouter.post('/', requireAuth, async (req, res) => {
  const { phase_id, task_idx, result, notes } = req.body;
  const { data, error } = await supabaseAdmin.from('project_inspections')
    .upsert({ project_id: req.params.projectId, phase_id, task_idx, result, notes: notes||'', inspected_by: req.userId, inspected_at: new Date().toISOString() }, { onConflict: 'project_id,phase_id,task_idx' })
    .select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// INVESTMENTS ──────────────────────────────────────────────
const invRouter = require('express').Router({ mergeParams: true });
invRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('project_investments').select('*').eq('project_id', req.params.projectId).order('created_at');
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
invRouter.post('/', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { investor, amount, equity_pct, notes, invested_at } = req.body;
  if(!investor) return res.status(400).json({ error: 'investor required' });
  const { data, error } = await supabaseAdmin.from('project_investments').insert({ project_id: req.params.projectId, investor, amount: amount||0, equity_pct: equity_pct||0, notes: notes||'', invested_at: invested_at||null }).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
invRouter.delete('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  await supabaseAdmin.from('project_investments').delete().eq('id', req.params.id).eq('project_id', req.params.projectId);
  res.json({ success: true });
});

// DELAY LOG ────────────────────────────────────────────────
const delayRouter = require('express').Router({ mergeParams: true });
delayRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('delay_log').select('*').eq('project_id', req.params.projectId).order('logged_at', { ascending: false });
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
delayRouter.post('/', requireAuth, async (req, res) => {
  const { phase_id, contractor, reason, days_delayed } = req.body;
  const { data, error } = await supabaseAdmin.from('delay_log').insert({ project_id: req.params.projectId, phase_id, contractor, reason, days_delayed: days_delayed||0 }).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
delayRouter.delete('/:id', requireAuth, async (req, res) => {
  await supabaseAdmin.from('delay_log').delete().eq('id', req.params.id).eq('project_id', req.params.projectId);
  res.json({ success: true });
});

// CLOSING COSTS ────────────────────────────────────────────
const closingRouter = require('express').Router({ mergeParams: true });
closingRouter.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('closing_costs').select('*').eq('project_id', req.params.projectId).order('created_at');
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
closingRouter.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { label, amount, category, notes } = req.body;
  if(!label) return res.status(400).json({ error: 'label required' });
  const { data, error } = await supabaseAdmin.from('closing_costs').insert({ project_id: req.params.projectId, label, amount: amount||0, category: category||'other', notes: notes||'' }).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
closingRouter.put('/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { amount, notes } = req.body;
  const { data, error } = await supabaseAdmin.from('closing_costs').update({ amount: amount||0, notes: notes||'' }).eq('id', req.params.id).eq('project_id', req.params.projectId).select().single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
closingRouter.delete('/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  await supabaseAdmin.from('closing_costs').delete().eq('id', req.params.id).eq('project_id', req.params.projectId);
  res.json({ success: true });
});

module.exports = { coRouter, selRouter, ctrRouter, payRouter, wrnRouter, qcRouter, rfpRouter, pContractorRouter, lienRouter, publicRfpRouter, tmplRouter, gcDrawRouter, inspRouter, invRouter, delayRouter, closingRouter };
