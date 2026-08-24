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
const { sendRfpInvite, sendBidReceived, sendBidDeclined, sendBidAwarded, sendLienWaiverRequest } = require('../lib/email');
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

  // Invite the external contractors. Fire-and-forget: a mail failure must
  // never lose the RFP that was just created.
  let invitedCount = 0;
  try {
    const emails = Array.isArray(external_emails) ? external_emails : [];
    if(emails.length && data && data.public_token){
      const appUrl = process.env.FRONTEND_URL || 'https://www.rezdevos.com';
      const bidUrl = appUrl + '/rfp-landing.html?token=' + data.public_token;
      const { data: me } = await supabaseAdmin.from('users')
        .select('first_name,last_name').eq('id', req.userId).maybeSingle();
      const { data: co } = await supabaseAdmin.from('companies')
        .select('name').eq('id', req.companyId).maybeSingle();
      const { data: proj } = await supabaseAdmin.from('projects')
        .select('name,address').eq('id', req.params.projectId).maybeSingle();
      for(const addr of emails){
        try {
          await sendRfpInvite({
            to: addr,
            companyName: co && co.name,
            builderName: me ? [me.first_name, me.last_name].filter(Boolean).join(' ') : '',
            projectName: proj ? (proj.name || proj.address) : '',
            rfpTitle: data.title,
            deadline: data.deadline,
            bidUrl,
          });
          invitedCount++;
        } catch(e){ console.log('[RFP] invite failed for', addr, e.message); }
      }
    }
  } catch(e){ console.log('[RFP] invite step failed:', e.message); }

  res.status(201).json(Object.assign({}, data, { invited_count: invitedCount }));
});

// Award: one transaction. Records every bid's outcome, flips the RFP, creates
// the winner's portal account, and emails everyone involved.
rfpRouter.post('/:id/award', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const { bid_id } = req.body;
    if(!bid_id) return res.status(400).json({ error: 'bid_id required' });

    const { data: rfp } = await supabaseAdmin.from('rfps')
      .select('id, title, company_id, project_id')
      .eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
    if(!rfp) return res.status(404).json({ error: 'RFP not found' });

    const { data: bids } = await supabaseAdmin.from('rfp_bids').select('*').eq('rfp_id', rfp.id);
    const all = bids || [];
    const winner = all.find(function(b){ return b.id === bid_id; });
    if(!winner) return res.status(404).json({ error: 'Bid not found on this RFP' });

    // 1. Outcomes first — the award stands even if a later step fails.
    for(const b of all){
      await supabaseAdmin.from('rfp_bids')
        .update({ status: b.id === bid_id ? 'awarded' : 'declined',
                  reviewed_at: new Date().toISOString() })
        .eq('id', b.id);
    }
    await supabaseAdmin.from('rfps').update({ status: 'awarded' }).eq('id', rfp.id);

    // 2. Context for the emails
    let builderName = '', companyName = '', projectName = '';
    try {
      const { data: me } = await supabaseAdmin.from('users')
        .select('first_name,last_name').eq('id', req.userId).maybeSingle();
      if(me) builderName = [me.first_name, me.last_name].filter(Boolean).join(' ');
      const { data: co } = await supabaseAdmin.from('companies')
        .select('name').eq('id', req.companyId).maybeSingle();
      if(co) companyName = co.name;
      const { data: proj } = await supabaseAdmin.from('projects')
        .select('name,address').eq('id', rfp.project_id).maybeSingle();
      if(proj) projectName = proj.name || proj.address || '';
    } catch(e){ /* non-fatal */ }

    // 3. Portal account for the winner. Only now — bidding needs no account.
    let setupUrl = null;
    try {
      if(winner.email){
        const emailNorm = String(winner.email).trim().toLowerCase();
        const { data: contractor } = await supabaseAdmin.from('contractors')
          .select('id, user_id').eq('company_id', rfp.company_id)
          .ilike('email', emailNorm).maybeSingle();

        if(contractor && !contractor.user_id){
          const first = (winner.contractor_name || 'Contractor').split(' ')[0];
          const last  = (winner.contractor_name || '').split(' ').slice(1).join(' ');
          const tempPassword = 'RezDev' + Math.random().toString(36).slice(2,12) + '!A';
          const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
            email: winner.email,
            password: tempPassword,
            email_confirm: true,
            user_metadata: { first_name: first, last_name: last, role: 'contractor' },
          });

          let userId = authUser && authUser.user && authUser.user.id;
          if(authErr){
            if(/already|registered|exists/i.test(authErr.message)){
              const { data: existing } = await supabaseAdmin.from('users')
                .select('id').ilike('email', emailNorm).maybeSingle();
              userId = existing && existing.id;
            } else {
              console.log('[RFP] contractor account creation failed:', authErr.message);
            }
          }

          if(userId){
            try {
              await supabaseAdmin.from('users').insert({
                id: userId, company_id: rfp.company_id,
                first_name: first, last_name: last,
                email: winner.email, role: 'contractor', status: 'pending',
              });
            } catch(e){ /* profile may already exist */ }

            await supabaseAdmin.from('contractors')
              .update({ user_id: userId, status: 'active' }).eq('id', contractor.id);

            const appUrl = process.env.FRONTEND_URL || 'https://www.rezdevos.com';
            const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
              type: 'recovery', email: winner.email,
              options: { redirectTo: appUrl + '/set-password.html' },
            });
            setupUrl = (linkData && linkData.properties && linkData.properties.action_link)
                       || (appUrl + '/set-password.html');
          }
        } else if(contractor && contractor.user_id){
          await supabaseAdmin.from('contractors')
            .update({ status: 'active' }).eq('id', contractor.id);
        }
      }
    } catch(e){ console.log('[RFP] winner account step failed:', e.message); }

    // 4. Emails — never let a failure undo the award
    try {
      await sendBidAwarded({
        to: winner.email, contractorName: winner.contractor_name,
        companyName, rfpTitle: rfp.title, projectName,
        amount: winner.amount, setupUrl,
      });
    } catch(e){ console.log('[RFP] award email failed:', e.message); }

    for(const b of all){
      if(b.id === bid_id || !b.email) continue;
      try {
        await sendBidDeclined({
          to: b.email, contractorName: b.contractor_name,
          companyName, rfpTitle: rfp.title, projectName,
        });
      } catch(e){ console.log('[RFP] decline email failed:', e.message); }
    }

    res.json({ success: true, awarded_to: winner.contractor_name,
               declined_count: Math.max(0, all.length - 1), portal_invited: !!setupUrl });
  } catch(e){ res.status(500).json({ error: e.message }); }
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

// Attach a file to THIS RFP. Deliberately NOT added to the project file
// library — RFP attachments are scoped to the solicitation.
rfpRouter.post('/:id/files', requireAuth, requireRole('owner','builder'),
               upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { data: rfp } = await supabaseAdmin.from('rfps')
      .select('id, rfp_files')
      .eq('id', req.params.id)
      .eq('company_id', req.companyId)
      .maybeSingle();
    if(!rfp) return res.status(404).json({ error: 'RFP not found' });

    const safe = (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = req.params.projectId + '/rfps/' + req.params.id + '/' + Date.now() + '_' + safe;
    let stored;
    try {
      stored = await uploadFile('files', path, req.file.buffer, req.file.mimetype);
    } catch(e){
      console.error('[RFP] attachment upload failed:', e && (e.message||e));
      return res.status(500).json({ error: 'Upload failed' });
    }

    const entry = {
      id: 'rf_' + Date.now(),
      name: req.file.originalname,
      path: stored,
      size: req.file.size,
      mime_type: req.file.mimetype,
    };
    const files = (Array.isArray(rfp.rfp_files) ? rfp.rfp_files : []).concat([entry]);
    const { error } = await supabaseAdmin.from('rfps').update({ rfp_files: files }).eq('id', rfp.id);
    if(error) return res.status(400).json({ error: error.message });

    res.status(201).json(entry);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

rfpRouter.delete('/:id/files/:fileId', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const { data: rfp } = await supabaseAdmin.from('rfps')
      .select('id, rfp_files').eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
    if(!rfp) return res.status(404).json({ error: 'RFP not found' });
    const files = (Array.isArray(rfp.rfp_files) ? rfp.rfp_files : []);
    const gone = files.find(function(f){ return f.id === req.params.fileId; });
    const kept = files.filter(function(f){ return f.id !== req.params.fileId; });
    if(gone && gone.path){
      try {
        const { deleteFile } = require('../lib/storage');
        await deleteFile('files', gone.path);
      } catch(e){ console.log('[RFP] attachment cleanup failed:', e.message); }
    }
    const { error } = await supabaseAdmin.from('rfps').update({ rfp_files: kept }).eq('id', rfp.id);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
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

// Signed URL for a file in this project's storage area.
// The path guard is the whole point: it must live under this project, or an
// authenticated user could sign paths belonging to other companies.
const pFileRouter = require('express').Router({ mergeParams: true });
pFileRouter.get('/signed-url', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const path = req.query.path;
    if(!path) return res.status(400).json({ error: 'path required' });
    if(path.indexOf('..') !== -1) return res.status(400).json({ error: 'Invalid path' });
    if(path.indexOf(req.params.projectId + '/') !== 0){
      return res.status(403).json({ error: 'That file does not belong to this project' });
    }
    const url = await getSignedUrl('files', path);
    res.json({ url });
  } catch(e){ res.status(500).json({ error: e.message }); }
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
pContractorRouter.delete('/:userId', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('project_contractors')
      .delete()
      .eq('project_id', req.params.projectId)
      .eq('user_id', req.params.userId);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
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
    let q = supabaseAdmin.from('lien_waivers').select('*').eq('project_id', req.params.projectId);
    if(req.query.draw_id) q = q.eq('draw_id', req.query.draw_id);
    const { data, error } = await q.order('created_at', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});
lienRouter.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { contractor_id, contractor_name, amount, waiver_type,
            draw_id, through_date, notes, line_item_names } = req.body;
    const { data, error } = await supabaseAdmin.from('lien_waivers').insert({
      project_id: req.params.projectId,
      contractor_id, contractor_name, amount,
      waiver_type: waiver_type || 'conditional',
      draw_id: draw_id || null,
      through_date: through_date || null,
      notes: notes || null,
      line_item_names: Array.isArray(line_item_names) ? line_item_names : [],
      requested_at: new Date().toISOString(),
      status: 'pending',
    }).select().single();
    if(error) return res.status(400).json({ error: error.message });

    // Tell the sub. A waiver sitting unseen in a portal helps nobody.
    try {
      let email = null, name = contractor_name;
      if(contractor_id){
        const { data: c } = await supabaseAdmin.from('contractors')
          .select('email, contact_name, company_name').eq('id', contractor_id).maybeSingle();
        if(c){ email = c.email; name = name || c.contact_name || c.company_name; }
      }
      if(email){
        const { data: co } = await supabaseAdmin.from('companies')
          .select('name').eq('id', req.companyId).maybeSingle();
        const { data: proj } = await supabaseAdmin.from('projects')
          .select('name, address').eq('id', req.params.projectId).maybeSingle();
        await sendLienWaiverRequest({
          to: email, contractorName: name,
          companyName: co && co.name,
          projectName: proj ? (proj.name || proj.address) : '',
          amount, throughDate: through_date,
        });
      }
    } catch(e){ console.log('[Lien] waiver request email failed:', e.message); }

    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Remove an unsigned request. A signed waiver is a legal release — it stays.
lienRouter.delete('/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { data: w } = await supabaseAdmin.from('lien_waivers')
      .select('id, status').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!w) return res.status(404).json({ error: 'Waiver not found' });
    if(w.status === 'signed'){
      return res.status(409).json({ error: 'A signed waiver cannot be deleted' });
    }
    const { error } = await supabaseAdmin.from('lien_waivers').delete().eq('id', w.id);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});
lienRouter.put('/:id/sign', requireAuth, async (req, res) => {
  try {
    // A lien waiver is a legal release. Scope it to the project, and only let
    // the named contractor — or the builder — sign. Previously any
    // authenticated user knowing the id could sign anyone's waiver.
    const { data: w } = await supabaseAdmin.from('lien_waivers')
      .select('*').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!w) return res.status(404).json({ error: 'Waiver not found' });
    if(w.status === 'signed') return res.status(409).json({ error: 'Already signed' });

    const isBuilder = ['owner','builder','pm'].includes(req.userRole);
    let isNamedContractor = false;
    if(w.contractor_id){
      const { data: c } = await supabaseAdmin.from('contractors')
        .select('user_id').eq('id', w.contractor_id).maybeSingle();
      isNamedContractor = !!(c && c.user_id && c.user_id === req.userId);
    }
    if(!isBuilder && !isNamedContractor){
      return res.status(403).json({ error: 'You are not the contractor named on this waiver' });
    }

    const { data, error } = await supabaseAdmin.from('lien_waivers')
      .update({ status: 'signed', signed_at: new Date().toISOString() })
      .eq('id', w.id).select().single();
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
      .select('id, title, trade, trades, description, scope, deadline, start_date, duration, notes, status, project_id, company_id, attached_file_ids, rfp_files, rfp_bids(id)')
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

    // Files attached directly to the RFP by the builder (not library files).
    try {
      const own = Array.isArray(data.rfp_files) ? data.rfp_files : [];
      const signed = await Promise.all(own.map(async function(f){
        let url = null;
        try { url = await getSignedUrl('files', f.path); } catch(e){}
        return url ? { id: f.id, name: f.name, size: f.size, mime_type: f.mime_type, url: url } : null;
      }));
      files = files.concat(signed.filter(Boolean));
    } catch(e){ /* none attached */ }

    const payload = Object.assign({}, data, { agreement, files });
    delete payload.attached_file_ids;
    delete payload.rfp_files;
    res.json(payload);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// PUBLIC estimate upload. Anyone holding the RFP link can reach this, so it
// is deliberately narrow: image/PDF only, 10 MB, and a cap on how many files
// one token can accumulate. NOTE: the counter is per-process and resets on
// deploy — a brake on casual abuse, not a real rate limiter.
const RFP_ESTIMATE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const RFP_ESTIMATE_MAX_BYTES = 10 * 1024 * 1024;
const RFP_ESTIMATE_MAX_PER_TOKEN = 5;
const _rfpUploadCounts = Object.create(null);

publicRfpRouter.post('/:token/estimate', upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if(RFP_ESTIMATE_TYPES.indexOf(req.file.mimetype) === -1){
      return res.status(400).json({ error: 'Estimates must be a PDF, JPG or PNG' });
    }
    if(req.file.size > RFP_ESTIMATE_MAX_BYTES){
      return res.status(400).json({ error: 'File is too large (10 MB maximum)' });
    }

    const { data: rfp } = await supabaseAdmin.from('rfps')
      .select('id, status, deadline, project_id')
      .eq('public_token', req.params.token).maybeSingle();
    if(!rfp) return res.status(404).json({ error: 'RFP not found' });
    if(rfp.status !== 'open') return res.status(400).json({ error: 'RFP is no longer accepting bids' });
    if(rfp.deadline && new Date(rfp.deadline) < new Date()){
      return res.status(400).json({ error: 'Bid deadline has passed' });
    }

    const seen = _rfpUploadCounts[req.params.token] || 0;
    if(seen >= RFP_ESTIMATE_MAX_PER_TOKEN){
      return res.status(429).json({ error: 'Too many uploads for this RFP link' });
    }
    _rfpUploadCounts[req.params.token] = seen + 1;

    const safe = (req.file.originalname || 'estimate').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = rfp.project_id + '/rfps/' + rfp.id + '/estimates/' + Date.now() + '_' + safe;
    let stored;
    try {
      stored = await uploadFile('files', path, req.file.buffer, req.file.mimetype);
    } catch(e){
      console.error('[RFP] estimate upload failed:', e && (e.message||e));
      return res.status(500).json({ error: 'Upload failed' });
    }

    res.status(201).json({
      name: req.file.originalname,
      path: stored,
      size: req.file.size,
      mime_type: req.file.mimetype,
    });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

publicRfpRouter.post('/:token/bid', async (req, res) => {
  try {
    const { data: rfp } = await supabaseAdmin.from('rfps')
      .select('id, status, deadline, company_id')
      .eq('public_token', req.params.token).single();
    if(!rfp) return res.status(404).json({ error: 'RFP not found' });
    if(rfp.status !== 'open') return res.status(400).json({ error: 'RFP is no longer accepting bids' });
    if(rfp.deadline && new Date(rfp.deadline) < new Date()) return res.status(400).json({ error: 'Bid deadline has passed' });

    const {
      contractor_name, company_name, email, phone,
      trade, trades, company_info, reference_contacts,
      year_established, employees, license_number, certifications,
      insurance_confirmed, agreement_accepted, estimate_files,
      amount, timeframe, timeline_days, notes,
    } = req.body;
    if(!contractor_name || !email) return res.status(400).json({ error: 'name and email required' });

    const tradeList = Array.isArray(trades) ? trades : (trade ? [trade] : []);
    // References arrive as {name, phone} objects. Older submissions sent
    // plain strings; normalise both so the builder view has one shape.
    const refs = (Array.isArray(reference_contacts) ? reference_contacts : [])
      .map(function(r){
        if(!r) return null;
        if(typeof r === 'string') return r.trim() ? { name: r.trim(), phone: '' } : null;
        const name = (r.name || '').trim(), phone = (r.phone || '').trim();
        return (name || phone) ? { name: name, phone: phone } : null;
      })
      .filter(Boolean);

    // Bidders become real contractor records so they land in the directory and
    // can be invited to future RFPs. Deduped on email within the company;
    // status 'prospect' keeps them distinct from contractors the builder vetted.
    let contractorId = null;
    try {
      const emailNorm = String(email).trim().toLowerCase();
      const { data: existing } = await supabaseAdmin.from('contractors')
        .select('id').eq('company_id', rfp.company_id).ilike('email', emailNorm).limit(1);
      if(existing && existing.length){
        contractorId = existing[0].id;
      } else {
        const { data: created, error: cErr } = await supabaseAdmin.from('contractors')
          .insert({
            company_id:   rfp.company_id,
            company_name: company_name || contractor_name,
            contact_name: contractor_name,
            trade:        tradeList.length ? tradeList[0] : null,
            email:          emailNorm,
            phone:          phone || null,
            license_number: license_number || null,
            status:         'prospect',
            notes:        'Added automatically from an RFP bid submission.',
          })
          .select('id').single();
        if(cErr) console.log('[RFP] contractor create failed:', cErr.message);
        if(created) contractorId = created.id;
      }
    } catch(e){ console.log('[RFP] contractor lookup failed:', e.message); }

    const { data, error } = await supabaseAdmin.from('rfp_bids')
      .insert({
        rfp_id:              rfp.id,
        contractor_id:       contractorId,
        contractor_name, company_name, email, phone,
        trades:              tradeList,
        company_info:        company_info || null,
        year_established:    year_established || null,
        employees:           employees || null,
        license_number:      license_number || null,
        certifications:      certifications || null,
        reference_contacts:  refs,
        insurance_confirmed: !!insurance_confirmed,
        agreement_accepted:  !!agreement_accepted,
        estimate_files:      Array.isArray(estimate_files) ? estimate_files : [],
        amount,
        timeframe:           timeframe || null,
        timeline_days:       (timeline_days != null && timeline_days !== '') ? timeline_days : null,
        notes:               notes || null,
        status:              'submitted',
        submitted_at:        new Date().toISOString(),
      })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });

    // Tell the builder. Fire-and-forget — a mail failure must not lose the bid.
    try {
      const { data: full } = await supabaseAdmin.from('rfps')
        .select('title, created_by, project_id').eq('id', rfp.id).maybeSingle();
      if(full && full.created_by){
        const { data: builder } = await supabaseAdmin.from('users')
          .select('email, first_name').eq('id', full.created_by).maybeSingle();
        const { data: proj } = await supabaseAdmin.from('projects')
          .select('name,address').eq('id', full.project_id).maybeSingle();
        if(builder && builder.email){
          await sendBidReceived({
            to: builder.email,
            builderName: builder.first_name,
            rfpTitle: full.title,
            contractorName: contractor_name,
            companyName: company_name,
            amount: amount,
            projectName: proj ? (proj.name || proj.address) : '',
          });
        }
      }
    } catch(e){ console.log('[RFP] bid notification failed:', e.message); }

    res.status(201).json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// exports moved to end of file

// LENDER DRAWS ─────────────────────────────────────────────
// The bank reimbursing project cost. Distinct from GC draws, which are the
// builder drawing against their own fee.
const lenderDrawRouter = require('express').Router({ mergeParams: true });

// How much of each transaction has been FUNDED so far, across all draws.
// A line's approved amount is apportioned pro rata over its transactions,
// because the lender approves per line item, not per receipt.
async function lenderFundedByTxn(projectId){
  const funded = {};
  const { data: draws } = await supabaseAdmin.from('lender_draws')
    .select('id, status').eq('project_id', projectId);
  const ids = (draws || []).map(function(d){ return d.id; });
  if(!ids.length) return funded;

  const { data: lines } = await supabaseAdmin.from('lender_draw_lines')
    .select('*').in('draw_id', ids);

  (lines || []).forEach(function(ln){
    const approved = (ln.approved_amount === null || ln.approved_amount === undefined)
      ? null : Number(ln.approved_amount);
    if(approved === null || !approved) return;
    const txnIds = Array.isArray(ln.transaction_ids) ? ln.transaction_ids : [];
    const requested = Number(ln.requested_amount) || 0;
    if(!txnIds.length || !requested) return;
    const ratio = approved / requested;
    // Each transaction in the line absorbs its share of what was approved.
    txnIds.forEach(function(entry){
      const tid = (entry && entry.id) ? entry.id : entry;
      const share = (entry && entry.amount != null) ? Number(entry.amount) : (requested / txnIds.length);
      funded[tid] = (funded[tid] || 0) + (share * ratio);
    });
  });
  return funded;
}

// GET available — every transaction with an unfunded balance, grouped by line.
lenderDrawRouter.get('/available', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const { data: txns } = await supabaseAdmin.from('transactions')
      .select('id, item_name, amount, payee, txn_date, section_id, attachments')
      .eq('project_id', req.params.projectId)
      .order('txn_date', { ascending: true });

    const funded = await lenderFundedByTxn(req.params.projectId);
    const groups = {};

    (txns || []).forEach(function(t){
      const amount = Number(t.amount) || 0;
      const already = funded[t.id] || 0;
      const outstanding = Math.round((amount - already) * 100) / 100;
      if(outstanding <= 0.01) return;   // funded in full

      const key = t.item_name || '(no item)';
      if(!groups[key]) groups[key] = { item_name: key, section_id: t.section_id,
                                       outstanding: 0, transactions: [] };
      groups[key].outstanding += outstanding;
      groups[key].transactions.push({
        id: t.id, payee: t.payee, txn_date: t.txn_date,
        amount: amount, funded: already, outstanding: outstanding,
        attachment_count: Array.isArray(t.attachments) ? t.attachments.length : 0,
      });
    });

    res.json(Object.keys(groups).map(function(k){ return groups[k]; }));
  } catch(e){ res.status(500).json({ error: e.message }); }
});

lenderDrawRouter.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    const { data: draws, error } = await supabaseAdmin.from('lender_draws')
      .select('*').eq('project_id', req.params.projectId)
      .order('draw_number', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });

    const ids = (draws || []).map(function(d){ return d.id; });
    let lines = [];
    if(ids.length){
      const { data: l } = await supabaseAdmin.from('lender_draw_lines')
        .select('*').in('draw_id', ids);
      lines = l || [];
    }
    res.json((draws || []).map(function(d){
      return Object.assign({}, d, {
        lines: lines.filter(function(x){ return x.draw_id === d.id; }),
      });
    }));
  } catch(e){ res.status(500).json({ error: e.message }); }
});

lenderDrawRouter.post('/', requireAuth, requireRole('owner','builder','pm'),
                      requireProjectAccess, async (req, res) => {
  try {
    const { lines, notes } = req.body;
    if(!Array.isArray(lines) || !lines.length){
      return res.status(400).json({ error: 'At least one line is required' });
    }

    const { data: last } = await supabaseAdmin.from('lender_draws')
      .select('draw_number').eq('project_id', req.params.projectId)
      .order('draw_number', { ascending: false }).limit(1);
    const nextNumber = (last && last.length ? Number(last[0].draw_number) : 0) + 1;

    const { data: draw, error } = await supabaseAdmin.from('lender_draws')
      .insert({ project_id: req.params.projectId, draw_number: nextNumber,
                status: 'draft', notes: notes || null, created_by: req.userId })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });

    const rows = lines.map(function(ln){
      return {
        draw_id: draw.id,
        section_key: ln.section_key || null,
        item_name: ln.item_name,
        requested_amount: Number(ln.requested_amount) || 0,
        transaction_ids: Array.isArray(ln.transaction_ids) ? ln.transaction_ids : [],
      };
    });
    const { data: saved, error: lineErr } = await supabaseAdmin
      .from('lender_draw_lines').insert(rows).select();
    if(lineErr) return res.status(400).json({ error: lineErr.message });

    res.status(201).json(Object.assign({}, draw, { lines: saved || [] }));
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Edit while unfunded. Once funded the draw is a record of what happened.
lenderDrawRouter.put('/:id', requireAuth, requireRole('owner','builder','pm'),
                     requireProjectAccess, async (req, res) => {
  try {
    const { data: draw } = await supabaseAdmin.from('lender_draws')
      .select('*').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!draw) return res.status(404).json({ error: 'Draw not found' });
    if(draw.status === 'funded' || draw.status === 'partially_funded'){
      return res.status(409).json({ error: 'A funded draw cannot be edited' });
    }

    const { notes, lines } = req.body;
    if(notes !== undefined){
      await supabaseAdmin.from('lender_draws').update({ notes }).eq('id', draw.id);
    }
    if(Array.isArray(lines)){
      await supabaseAdmin.from('lender_draw_lines').delete().eq('draw_id', draw.id);
      const rows = lines.map(function(ln){
        return {
          draw_id: draw.id,
          section_key: ln.section_key || null,
          item_name: ln.item_name,
          requested_amount: Number(ln.requested_amount) || 0,
          transaction_ids: Array.isArray(ln.transaction_ids) ? ln.transaction_ids : [],
        };
      });
      if(rows.length) await supabaseAdmin.from('lender_draw_lines').insert(rows);
    }

    const { data: out } = await supabaseAdmin.from('lender_draws')
      .select('*').eq('id', draw.id).single();
    const { data: outLines } = await supabaseAdmin.from('lender_draw_lines')
      .select('*').eq('draw_id', draw.id);
    res.json(Object.assign({}, out, { lines: outLines || [] }));
  } catch(e){ res.status(500).json({ error: e.message }); }
});

lenderDrawRouter.post('/:id/submit', requireAuth, requireRole('owner','builder','pm'),
                      requireProjectAccess, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('lender_draws')
      .update({ status: 'submitted', submitted_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('project_id', req.params.projectId)
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    if(!data) return res.status(404).json({ error: 'Draw not found' });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Record what the lender actually approved, per line. Anything short stays
// outstanding and reappears in the next draw's available pool automatically.
lenderDrawRouter.post('/:id/fund', requireAuth, requireRole('owner','builder','pm'),
                      requireProjectAccess, async (req, res) => {
  try {
    const { lines, funded_at } = req.body;
    if(!Array.isArray(lines)) return res.status(400).json({ error: 'lines required' });

    const { data: draw } = await supabaseAdmin.from('lender_draws')
      .select('*').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!draw) return res.status(404).json({ error: 'Draw not found' });

    for(const ln of lines){
      if(!ln.id) continue;
      await supabaseAdmin.from('lender_draw_lines')
        .update({ approved_amount: Number(ln.approved_amount) || 0,
                  variance_note: ln.variance_note || null })
        .eq('id', ln.id).eq('draw_id', draw.id);
    }

    const { data: allLines } = await supabaseAdmin.from('lender_draw_lines')
      .select('requested_amount, approved_amount').eq('draw_id', draw.id);
    const requested = (allLines||[]).reduce(function(s,l){ return s + (Number(l.requested_amount)||0); }, 0);
    const approved  = (allLines||[]).reduce(function(s,l){ return s + (Number(l.approved_amount)||0); }, 0);
    const status = (approved + 0.01 >= requested) ? 'funded' : 'partially_funded';

    const { data: out, error } = await supabaseAdmin.from('lender_draws')
      .update({ status, funded_at: funded_at || new Date().toISOString() })
      .eq('id', draw.id).select().single();
    if(error) return res.status(400).json({ error: error.message });

    res.json(Object.assign({}, out, { requested_total: requested, approved_total: approved }));
  } catch(e){ res.status(500).json({ error: e.message }); }
});

lenderDrawRouter.delete('/:id', requireAuth, requireRole('owner','builder'),
                        requireProjectAccess, async (req, res) => {
  try {
    const { data: draw } = await supabaseAdmin.from('lender_draws')
      .select('status').eq('id', req.params.id)
      .eq('project_id', req.params.projectId).maybeSingle();
    if(!draw) return res.status(404).json({ error: 'Draw not found' });
    if(draw.status !== 'draft'){
      return res.status(409).json({ error: 'Only draft draws can be deleted' });
    }
    const { error } = await supabaseAdmin.from('lender_draws')
      .delete().eq('id', req.params.id);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

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

module.exports = { coRouter, selRouter, ctrRouter, payRouter, wrnRouter, qcRouter, rfpRouter, pContractorRouter, lienRouter, publicRfpRouter, tmplRouter, gcDrawRouter, inspRouter, invRouter, delayRouter, closingRouter, pFileRouter, lenderDrawRouter };
