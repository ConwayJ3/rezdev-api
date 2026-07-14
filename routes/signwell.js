const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const SIGNWELL_API = 'https://www.signwell.com/api/v1';
const SW_KEY = process.env.SIGNWELL_API_KEY;
const { mergeTemplate, buildMergeData, generateContractPdf } = require('../lib/contractPdf');
const { fillDocx, convertDocxToPdf, applyTagsToDocx, applySignatureAnchors } = require('../lib/docxContract');
const { uploadFile } = require('../lib/storage');

// POST /signwell/send
router.post('/send', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { contract_id, signer_name, signer_email, contract_type, body } = req.body;
    if(!signer_email) return res.status(400).json({ error: 'signer_email required' });
    
    let contract = null;
    if(contract_id && !contract_id.startsWith('temp-')){
      const { data: c, error: cErr } = await supabaseAdmin.from('contracts').select('*').eq('id', contract_id).single();
      if(!cErr && c) contract = c;
    }
    
    // If no contract found, create one in the database
    if(!contract){
      const { data: newContract, error: createErr } = await supabaseAdmin
        .from('contracts')
        .insert({
          project_id:         req.body.project_id || null,
          title:              req.body.title || contract_type || 'Contract',
          body:               body || 'Sent via SignWell template',
          contractor_id:      null,
          contracted_amount:  req.body.amount || 0,
          start_date:         req.body.start_date || null,
          status:             'draft',
          created_by:         req.userId,
          contract_type:      contract_type || 'contractor',
        })
        .select().single();
      if(createErr){ console.log('[SignWell] Contract create error:', createErr.message); }
      contract = newContract || {
        id: null,
        contract_type: contract_type || 'contractor',
        body: body || '',
        title: req.body.title || 'Contract',
      };
    }

    const contractType = contract.contract_type || 'contractor';
    console.log('[SignWell] Looking for template, type:', contractType, 'company:', req.companyId);
    const { data: tmplRecord } = await supabaseAdmin
      .from('signwell_templates')
      .select('signwell_template_id')
      .eq('company_id', req.companyId)
      .eq('contract_type', contractType)
      .single();

    console.log('[SignWell Send] User:', req.user?.email, 'Company:', req.companyId);
    const recipients = [
      { id: '1', name: signer_name || 'Recipient', email: signer_email, role: 'signer' },
      { id: '2', name: req.user.first_name+' '+req.user.last_name, email: req.user.email, role: 'signer' },
    ];

    let swRes;
    if(tmplRecord && tmplRecord.signwell_template_id){
      const templateRecipients = [
        { id: '1', placeholder_name: 'Recipient', name: signer_name || 'Recipient', email: signer_email },
        { id: '2', placeholder_name: 'Builder', name: req.user.first_name+' '+req.user.last_name, email: req.user.email },
      ];
      // Build field data from request body fields object
      const fieldData = req.body.fields || {};
      const templateFields = Object.entries(fieldData).map(([api_id, value]) => ({ api_id, value: String(value||'') }));
      swRes = await fetch(SIGNWELL_API+'/document_templates/documents', {
        method: 'POST',
        headers: { 'X-Api-Key': SW_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_mode: false,
          template_id: tmplRecord.signwell_template_id,
          name: contract.title || 'RezDev Contract',
          recipients: templateRecipients,
          embedded_signing: true,
          reminder_enabled: true,
          apply_signing_order: true,
          fields: templateFields.length ? [templateFields] : undefined,
        }),
      });
    } else {
      swRes = await fetch(SIGNWELL_API+'/documents', {
        method: 'POST',
        headers: { 'X-Api-Key': SW_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_mode: false,
          name: contract.title || 'RezDev Contract',
          text: contract.body || '',
          recipients,
          embedded_signing: true,
          reminder_enabled: true,
          apply_signing_order: true,
        }),
      });
    }

    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error', details: swData });

    // Extract the recipient's embedded signing URL (recipient id '1')
    let signingUrl = null;
    if(swData.recipients && Array.isArray(swData.recipients)){
      const recipient = swData.recipients.find(r => r.id === '1') || swData.recipients[0];
      signingUrl = recipient ? (recipient.embedded_signing_url || recipient.signing_url) : null;
    }

    // Update the contract record (use the actual contract.id from DB)
    const contractDbId = contract.id || contract_id;
    if(contractDbId && !String(contractDbId).startsWith('temp-')){
      await supabaseAdmin.from('contracts').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        signwell_document_id: swData.id,
        signing_url: signingUrl,
        recipient_email: signer_email,
      }).eq('id', contractDbId);
    }
    res.json({ success: true, document_id: swData.id, signing_url: signingUrl });
  } catch(e) {
    console.error('[SignWell] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /signwell/send-contract — generate a branded contract PDF from the company's
// template + project data, then send it to SignWell for signature.
router.post('/send-contract', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { project_id, contract_type, client_name, client_email, extra_fields } = req.body;
    const ctype = contract_type || 'client';
    const providedTitle = (req.body.title || '').trim();
    if(!project_id) return res.status(400).json({ error: 'project_id required' });
    if(!client_email) return res.status(400).json({ error: 'client_email required' });

    // 1. Load the company's template for this contract type
    const { data: tmpl } = await supabaseAdmin
      .from('contract_templates')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('contract_type', ctype)
      .maybeSingle();
    if(!tmpl || !tmpl.body) return res.status(400).json({ error: 'No contract template configured for type: '+ctype });

    // 2. Load project + company
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('*, budget_configs(total_budget, build_budget)')
      .eq('id', project_id).single();
    const { data: company } = await supabaseAdmin
      .from('companies').select('*').eq('id', req.companyId).maybeSingle();

    const builderName = (req.user.first_name||'')+' '+(req.user.last_name||'');

    // 3. Merge data into the template
    const data = buildMergeData({
      project, company,
      builder: { name: builderName.trim() },
      client:  { name: client_name||'', email: client_email },
      extra:   extra_fields || {},
    });
    const mergedBody = mergeTemplate(tmpl.body, data);

    // 4. Optional: fetch company logo for the header
    let logoBuffer = null;
    if(company && company.logo_url){
      try { const r = await fetch(company.logo_url); if(r.ok) logoBuffer = Buffer.from(await r.arrayBuffer()); } catch(e){}
    }

    // 5. Generate the branded PDF
    const titleMap = { client:'Construction Contract', contractor:'Contractor Agreement', subcontractor:'Subcontractor Agreement', nda:'Non-Disclosure Agreement', change_order:'Change Order Authorization' };
    const pdfBuffer = await generateContractPdf({
      title: titleMap[ctype] || 'Contract',
      bodyText: mergedBody,
      company: company || {},
      logoBuffer,
    });

    // 6. Upload PDF to Supabase storage, get a public URL for SignWell
    const fileName = `${req.companyId}/${project_id}/${ctype}_${Date.now()}.pdf`;
    await uploadFile('contracts', fileName, pdfBuffer, 'application/pdf');
    const { data: urlData } = supabaseAdmin.storage.from(
      process.env.STORAGE_BUCKET_CONTRACTS || 'contracts'
    ).getPublicUrl(fileName);
    const fileUrl = urlData.publicUrl;

    // 7. Create a contracts record
    const { data: contractRow } = await supabaseAdmin.from('contracts').insert({
      project_id, title: titleMap[ctype] || 'Contract', body: mergedBody,
      status:'draft', created_by: req.userId, contract_type: ctype,
      contracted_amount: 0,
    }).select().single();

    // 8. Send to SignWell as a document built from the generated PDF
    const recipients = [
      { id:'1', name: client_name || 'Client', email: client_email },
      { id:'2', name: builderName.trim() || 'Builder', email: req.user.email },
    ];
    const swRes = await fetch(SIGNWELL_API+'/documents', {
      method:'POST',
      headers:{ 'X-Api-Key': SW_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({
        test_mode: false,
        name: (titleMap[ctype]||'Contract')+' — '+(project?.name||project?.address||''),
        files: [{ name:'contract.pdf', file_url: fileUrl }],
        recipients,
        embedded_signing: true,
        reminder_enabled: true,
        apply_signing_order: true,
        fields: [[
          { api_id:'sig_client',  type:'signature', page:-1, x:75,  y:690, required:true, recipient_id:'1' },
          { api_id:'date_client', type:'date',      page:-1, x:75,  y:720, required:true, recipient_id:'1' },
          { api_id:'sig_builder', type:'signature', page:-1, x:320, y:690, required:true, recipient_id:'2' },
          { api_id:'date_builder',type:'date',      page:-1, x:320, y:720, required:true, recipient_id:'2' },
        ]],
      }),
    });
    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error', details: swData });

    let signingUrl = null;
    if(Array.isArray(swData.recipients)){
      const r = swData.recipients.find(x=>x.id==='1') || swData.recipients[0];
      signingUrl = r ? (r.embedded_signing_url || r.signing_url) : null;
    }
    if(contractRow){
      await supabaseAdmin.from('contracts').update({
        status:'sent', sent_at:new Date().toISOString(),
        signwell_document_id: swData.id, signing_url: signingUrl, recipient_email: client_email,
        pdf_url: fileUrl,
      }).eq('id', contractRow.id);
    }
    res.json({ success:true, document_id: swData.id, signing_url: signingUrl, pdf_url: fileUrl, contract_id: contractRow?.id });
  } catch(e){
    console.error('[SignWell send-contract] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/webhook', async (req, res) => {
  try {
    const event = req.body || {};
    // Log the full payload once so we can see SignWell's exact structure
    console.log('[SignWell] Webhook RAW:', JSON.stringify(event).slice(0, 800));
    // SignWell nests the event under different keys depending on version — check all
    const type = event.event_type || event.type
              || (event.event && (event.event.type || event.event.event_type))
              || (event.data && event.data.event_type);
    console.log('[SignWell] Webhook type:', type);
    const doc = event.data || (event.event && event.event.data) || {};
    const docId = doc.id || (doc.object && doc.object.id) || (event.data && event.data.object && event.data.object.id);
    if(!docId){ return res.json({ received: true }); }

    if(type === 'document_completed'){
      // Per SignWell docs: GET /documents/{id} returns completed_pdf_url once signing is complete.
      let signedUrl = null;
      try {
        const r = await fetch(`${SIGNWELL_API}/documents/${docId}`, { headers: { 'X-Api-Key': SW_KEY } });
        if(r.ok){
          const j = await r.json();
          signedUrl = j.completed_pdf_url || j.pdf_url || (Array.isArray(j.files) && j.files[0] && (j.files[0].url || j.files[0].file_url)) || null;
          console.log('[SignWell] completed_pdf_url ->', signedUrl);
        }
      } catch(e){ console.log('[SignWell] completed pdf fetch failed:', e.message); }
      await supabaseAdmin.from('contracts').update({
        status: 'signed', signed_at: new Date().toISOString(),
        ...(signedUrl ? { signed_pdf_url: signedUrl } : {}),
      }).eq('signwell_document_id', docId);
    } else if(type === 'document_viewed'){
      await supabaseAdmin.from('contracts').update({ status: 'viewed', viewed_at: new Date().toISOString() }).eq('signwell_document_id', docId).eq('status','sent');
    } else if(type === 'document_declined'){
      await supabaseAdmin.from('contracts').update({ status: 'declined', declined_at: new Date().toISOString() }).eq('signwell_document_id', docId);
    } else if(type === 'document_signed'){
      // A single signer completed (sequential order: client first, then builder).
      // Advance to 'partially_signed' unless already fully signed.
      const { data: upd, error: updErr } = await supabaseAdmin.from('contracts')
        .update({ status: 'partially_signed' })
        .eq('signwell_document_id', docId)
        .neq('status', 'signed')
        .select('id, status');
      console.log('[SignWell] document_signed update ->', JSON.stringify(upd), updErr ? ('err:'+updErr.message) : '');
    }
    res.json({ received: true });
  } catch(e) {
    console.error('[SignWell webhook] error:', e.message);
    res.status(200).json({ received: true, error: e.message }); // 200 so SignWell doesn't retry-storm
  }
});

// GET /signwell/status/:documentId
router.get('/status/:documentId', requireAuth, async (req, res) => {
  try {
    const swRes = await fetch(`${SIGNWELL_API}/documents/${req.params.documentId}`, { headers: { 'X-Api-Key': SW_KEY } });
    res.json(await swRes.json());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /signwell/templates/upload — upload PDF to Supabase Storage and return public URL
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20*1024*1024 } });

router.options('/templates/upload', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.sendStatus(200);
});

router.post('/templates/upload', requireAuth, requireRole('owner','builder'), upload.single('file'), async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    if(!req.file) return res.status(400).json({ error: 'No file provided' });
    const contractType = req.body.contract_type || 'contract';
    const fileName = `${req.companyId}/${contractType}_${Date.now()}.pdf`;
    const { uploadFile } = require('../lib/storage');
    const storagePath = await uploadFile('contracts', fileName, req.file.buffer, 'application/pdf');
    const { supabaseAdmin } = require('../lib/supabase');
    const { data: urlData } = supabaseAdmin.storage.from('contracts').getPublicUrl(storagePath);
    res.json({ success: true, url: urlData.publicUrl, path: storagePath });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /signwell/templates/create — upload PDF and create SignWell template
router.post('/templates/create', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const { contract_type, template_name, file_url } = req.body;
    if(!contract_type || !file_url) return res.status(400).json({ error: 'contract_type and file_url required' });

    // Create template in SignWell from file URL
    const swRes = await fetch(`${SIGNWELL_API}/document_templates`, {
      method: 'POST',
      headers: { 'X-Api-Key': SW_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: template_name || contract_type + ' template',
        files: [{ name: template_name || contract_type, file_url }],
        test_mode: false,
        draft: false,
        placeholders: [
          { id: '1', name: 'Recipient' },
          { id: '2', name: 'Builder' }
        ],
        fields: [[
          { api_id: 'sig_recipient', type: 'signature', page: 0, x: 70, y: 700, required: true, placeholder_id: '1' },
          { api_id: 'date_recipient', type: 'date', page: 0, x: 300, y: 700, required: true, placeholder_id: '1', date_format: 'MM/DD/YYYY' },
          { api_id: 'sig_builder', type: 'signature', page: 0, x: 70, y: 600, required: true, placeholder_id: '2' }
        ]],
      }),
    });
    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error', details: swData });

    // Save template ID to Supabase
    const { data, error } = await supabaseAdmin
      .from('signwell_templates')
      .upsert({
        company_id:           req.companyId,
        contract_type,
        signwell_template_id: swData.id,
        template_name:        template_name || contract_type,
      }, { onConflict: 'company_id,contract_type' })
      .select().single();

    if(error) return res.status(400).json({ error: error.message });
    res.json({ success: true, template_id: swData.id, record: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /signwell/templates — get all templates for this company (DOCX-based)
router.get('/templates', requireAuth, async (req, res) => {
  try {
    // Read from contract_templates (DOCX flow) — has docx_url + fill_fields
    const { data, error } = await supabaseAdmin
      .from('contract_templates')
      .select('*')
      .eq('company_id', req.companyId);
    if(error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /signwell/templates/:contract_type — remove a template
router.delete('/templates/:contract_type', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    await supabaseAdmin.from('signwell_templates')
      .delete()
      .eq('company_id', req.companyId)
      .eq('contract_type', req.params.contract_type);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /signwell/templates/upload-docx — upload a builder's .docx contract template
router.post('/templates/upload-docx', requireAuth, requireRole('owner','builder'), upload.single('file'), async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    if(!req.file) return res.status(400).json({ error: 'No file provided' });
    const contractType = req.body.contract_type || 'client';
    const templateName = req.body.template_name || contractType + ' contract';
    const { uploadFile } = require('../lib/storage');
    const fileName = `${req.companyId}/templates/${contractType}_${Date.now()}.docx`;
    const storagePath = await uploadFile('contracts', fileName, req.file.buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const { data: urlData } = supabaseAdmin.storage.from('contracts').getPublicUrl(storagePath);
    const docxUrl = urlData.publicUrl;

    // Upsert: the uploaded file is the PRISTINE ORIGINAL. Reset tag_rules/fill_fields
    // because a fresh upload starts tagging over. docx_url mirrors the original here;
    // the tagged render is produced on demand from original + tag_rules.
    const { data, error } = await supabaseAdmin
      .from('contract_templates')
      .upsert({
        company_id:         req.companyId,
        contract_type:      contractType,
        template_name:      templateName,
        docx_url:           docxUrl,
        docx_path:          storagePath,
        original_docx_url:  docxUrl,
        original_docx_path: storagePath,
        tag_rules:          [],
        fill_fields:        [],
      }, { onConflict: 'company_id,contract_type' })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json({ success: true, docx_url: docxUrl, record: data });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// Build the merge-data object used to fill DOCX tags (flat key/value for docxtemplater)
async function buildDocxMergeData({ companyId, projectId, clientName, clientEmail, builderUser, extra }){
  const { data: project } = await supabaseAdmin
    .from('projects').select('*, budget_configs(total_budget, build_budget)').eq('id', projectId).maybeSingle();
  const { data: company } = await supabaseAdmin
    .from('companies').select('*').eq('id', companyId).maybeSingle();
  // Load the full budget config for this project
  const { data: budget } = await supabaseAdmin
    .from('budget_configs').select('*').eq('project_id', projectId).maybeSingle();

  const fmtMoney = n => (n==null||n==='') ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum   = n => (n==null||n==='') ? '' : Number(n).toLocaleString('en-US');
  const fmtPct   = n => (n==null||n==='') ? '' : Number(n) + '%';
  const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const builderName = ((builderUser.first_name||'')+' '+(builderUser.last_name||'')).trim();
  const b = budget || {};
  const totalBudget = b.total_budget != null ? b.total_budget : (b.build_budget != null ? b.build_budget : null);

  // Numeric-word / long form of the total for contracts that spell out the price
  const livingSqft = b.living_sqft;
  const pricePerSqft = (totalBudget && livingSqft) ? (Number(totalBudget)/Number(livingSqft)) : null;

  return Object.assign({
    date: today,
    // Company
    company_name:    (company && company.name) || '',
    company_address: (company && company.address) || '',
    company_phone:   (company && company.phone) || '',
    company_email:   (company && company.email) || '',
    company_license: (company && (company.license_number||company.license)) || '',
    builder_name:    builderName,
    // Recipient (whoever the contract is sent to — client, contractor, etc.)
    recipient_name:  clientName || '',
    recipient_email: clientEmail || '',
    // Client (aliases — kept for existing templates)
    client_name:     clientName || '',
    client_email:    clientEmail || '',
    // Contractor (aliases so contractor/subcontractor templates read naturally)
    contractor_name:  clientName || '',
    contractor_email: clientEmail || '',
    // Contract-specific values supplied at send time (scope, amount, trade, etc.)
    contract_amount:  (extra && extra.contract_amount) || '',
    scope_of_work:    (extra && extra.scope_of_work) || '',
    trade:            (extra && extra.trade) || '',
    // Project
    project_name:    (project && project.name) || '',
    project_address: (project && project.address) || '',
    project_city:    (project && project.city) || '',
    project_state:   (project && project.state) || '',
    project_type:    (project && project.project_type) || '',
    project_beds:    (project && project.beds) || '',
    project_baths:   (project && project.baths) || '',
    // Budget — money
    total_project_budget: fmtMoney(totalBudget),
    contract_price:       fmtMoney(totalBudget),   // alias
    build_budget:         fmtMoney(b.build_budget),
    gc_fee_amount:        fmtMoney(b.gc_fee_amount),
    // Budget — square footage
    living_sqft:     fmtNum(b.living_sqft),
    foundation_sqft: fmtNum(b.foundation_sqft),
    porch_sqft:      fmtNum(b.porch_sqft),
    garage_sqft:     fmtNum(b.garage_sqft),
    total_sqft:      fmtNum((Number(b.living_sqft||0)+Number(b.porch_sqft||0)+Number(b.garage_sqft||0)) || ''),
    price_per_sqft:  fmtMoney(pricePerSqft),
    finish_cost_sqft: fmtMoney(b.finish_cost_sqft),
    // Budget — rates
    contingency_pct: fmtPct(b.contingency_pct),
    gc_fee_type:     b.gc_fee_type || '',
    gc_fee_val:      b.gc_fee_val != null ? String(b.gc_fee_val) : '',
    // Signature anchors
    sig_client: '', sig_builder: '',
  }, extra || {});
}

// POST /signwell/send-docx-contract — fill DOCX template, convert to PDF, send via SignWell
router.post('/send-docx-contract', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { project_id, contract_type, client_name, client_email, extra_fields } = req.body;
    const ctype = contract_type || 'client';
    const providedTitle = (req.body.title || '').trim();
    if(!project_id) return res.status(400).json({ error: 'project_id required' });
    if(!client_email || !client_email.trim()){
      return res.status(400).json({ error: 'The selected recipient has no email address on file. Add their email before sending.' });
    }
    if(!req.user || !req.user.email){
      return res.status(400).json({ error: 'Your account has no email address — cannot add you as a signer.' });
    }

    // 1. Load the template
    const { data: tmpl } = await supabaseAdmin
      .from('contract_templates').select('*')
      .eq('company_id', req.companyId).eq('contract_type', ctype).maybeSingle();
    if(!tmpl || (!tmpl.original_docx_url && !tmpl.docx_url)) return res.status(400).json({ error: 'No DOCX template configured for type: ' + ctype });

    // 2. Render the tagged DOCX fresh from the pristine original + saved tag_rules
    let taggedBuffer;
    try { taggedBuffer = await renderTaggedDocx(tmpl); }
    catch(e){ return res.status(400).json({ error: 'Could not render template: ' + e.message }); }

    // 3. Fill merge tags with real data
    const data = await buildDocxMergeData({
      companyId: req.companyId, projectId: project_id,
      clientName: client_name, clientEmail: client_email,
      builderUser: req.user, extra: extra_fields,
    });
    let filledDocx;
    try { filledDocx = fillDocx(taggedBuffer, data); }
    catch(e){ return res.status(400).json({ error: 'Template merge failed: ' + (e.message||'check your {{tags}}') }); }

    // 3b. Convert signature markers (##SIG_CLIENT## etc.) into SignWell text tags
    filledDocx = applySignatureAnchors(filledDocx);

    // 4. Convert to PDF
    const pdfBuffer = await convertDocxToPdf(filledDocx, 'contract.docx');

    // 5. Upload the PDF
    const { uploadFile } = require('../lib/storage');
    const pdfName = `${req.companyId}/${project_id}/${ctype}_${Date.now()}.pdf`;
    await uploadFile('contracts', pdfName, pdfBuffer, 'application/pdf');
    const { data: pdfUrlData } = supabaseAdmin.storage.from('contracts').getPublicUrl(pdfName);
    const fileUrl = pdfUrlData.publicUrl;

    // 6. Create the contract record
    const titleMap = { client:'Construction Contract', contractor:'Contractor Agreement', subcontractor:'Subcontractor Agreement', change_order:'Change Order Authorization' };
    const title = providedTitle || titleMap[ctype] || 'Contract';
    const { data: contractRow } = await supabaseAdmin.from('contracts').insert({
      project_id, title, status:'draft', created_by: req.userId, contract_type: ctype, contracted_amount: 0, pdf_url: fileUrl,
    }).select().single();

    // 7. Send to SignWell
    const builderName = ((req.user.first_name||'')+' '+(req.user.last_name||'')).trim();
    const swRes = await fetch(SIGNWELL_API+'/documents', {
      method:'POST',
      headers:{ 'X-Api-Key': SW_KEY, 'Content-Type':'application/json' },
      body: JSON.stringify({
        test_mode: false,
        name: title,
        files: [{ name:'contract.pdf', file_url: fileUrl }],
        recipients: [
          { id:'1', name: client_name || 'Client', email: client_email },
          { id:'2', name: builderName || 'Builder', email: req.user.email },
        ],
        embedded_signing: true, reminder_enabled: true, apply_signing_order: true,
        text_tags: true,
      }),
    });
    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error', details: swData });

    let signingUrl = null;
    if(Array.isArray(swData.recipients)){
      const r = swData.recipients.find(x=>x.id==='1') || swData.recipients[0];
      signingUrl = r ? (r.embedded_signing_url || r.signing_url) : null;
    }
    if(contractRow){
      await supabaseAdmin.from('contracts').update({
        status:'sent', sent_at:new Date().toISOString(),
        signwell_document_id: swData.id, signing_url: signingUrl, recipient_email: client_email, pdf_url: fileUrl,
      }).eq('id', contractRow.id);
    }
    res.json({ success:true, document_id: swData.id, signing_url: signingUrl, pdf_url: fileUrl, contract_id: contractRow?.id });
  } catch(e){
    console.error('[SignWell send-docx-contract] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /signwell/templates/:type/text — extract the DOCX's readable text for in-app tagging
router.get('/templates/:type/text', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const ctype = req.params.type;
    const { data: tmpl } = await supabaseAdmin
      .from('contract_templates').select('*')
      .eq('company_id', req.companyId).eq('contract_type', ctype).maybeSingle();
    if(!tmpl || (!tmpl.original_docx_url && !tmpl.docx_url)) return res.status(404).json({ error: 'No DOCX template uploaded for this type' });

    // Always read the PRISTINE ORIGINAL text (tags are never baked in)
    const origUrl = tmpl.original_docx_url || tmpl.docx_url;
    const docxRes = await fetch(origUrl);
    if(!docxRes.ok) return res.status(400).json({ error: 'Could not download template DOCX' });
    const docxBuffer = Buffer.from(await docxRes.arrayBuffer());

    const mammoth = require('mammoth');
    const textResult = await mammoth.extractRawText({ buffer: docxBuffer });

    res.json({
      success: true,
      contract_type: ctype,
      text: textResult.value || '',
      tag_rules: Array.isArray(tmpl.tag_rules) ? tmpl.tag_rules : [],
      fill_fields: Array.isArray(tmpl.fill_fields) ? tmpl.fill_fields : [],
    });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// Render a tagged DOCX buffer from the pristine original + the saved tag_rules.
// This is the single source of truth: original never changes; tags are data.
async function renderTaggedDocx(tmpl){
  const origUrl = tmpl.original_docx_url || tmpl.docx_url;
  const docxRes = await fetch(origUrl);
  if(!docxRes.ok) throw new Error('Could not download original template DOCX');
  const originalBuffer = Buffer.from(await docxRes.arrayBuffer());
  const rules = Array.isArray(tmpl.tag_rules) ? tmpl.tag_rules : [];
  if(!rules.length) return originalBuffer;
  return applyTagsToDocx(originalBuffer, rules);
}

// POST /signwell/templates/:type/apply-tags — SAVE tagging rules (does not mutate original).
// Body: { rules: [ {find, occurrence_index, all, occurrence_count, mode, tag, raw_replace, label, field_type, key} ... ] }
// The full rules array REPLACES the stored one (frontend sends the complete current set).
router.post('/templates/:type/apply-tags', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const ctype = req.params.type;
    const rules = Array.isArray(req.body.rules) ? req.body.rules : [];

    const { data: tmpl } = await supabaseAdmin
      .from('contract_templates').select('*')
      .eq('company_id', req.companyId).eq('contract_type', ctype).maybeSingle();
    if(!tmpl || (!tmpl.original_docx_url && !tmpl.docx_url)) return res.status(404).json({ error: 'No DOCX template for this type' });

    // Derive fill_fields from the fill-type rules (single source: the rules)
    const fillFields = rules
      .filter(r => r.mode === 'fill' && r.key)
      .map(r => ({ key: r.key, label: r.label || r.key, type: r.field_type || 'text' }));
    // dedupe by key
    const byKey = {}; fillFields.forEach(f => { byKey[f.key] = f; });

    await supabaseAdmin.from('contract_templates')
      .update({ tag_rules: rules, fill_fields: Object.values(byKey) })
      .eq('company_id', req.companyId).eq('contract_type', ctype);

    res.json({ success: true, saved_rules: rules.length });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// GET /signwell/my-contracts/:projectId — contracts for the logged-in client on a project
router.get('/my-contracts/:projectId', requireAuth, async (req, res) => {
  try {
    const projectId = req.params.projectId;
    // Resolve the client's email (from their profile)
    const clientEmail = (req.user && req.user.email) || '';
    const { data, error } = await supabaseAdmin
      .from('contracts')
      .select('id, title, status, contract_type, signing_url, pdf_url, signed_pdf_url, recipient_email, sent_at, signed_at, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });
    // Only return contracts addressed to this client (by recipient_email), or all if builder/pm/owner
    const role = req.userRole;
    let rows = data || [];
    if(role === 'client'){
      rows = rows.filter(r => (r.recipient_email||'').toLowerCase() === clientEmail.toLowerCase());
    }
    res.json(rows);
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// GET /signwell/builder-signing-url/:contractId — fetch the builder's (recipient 2) embedded signing URL
router.get('/builder-signing-url/:contractId', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { data: contract } = await supabaseAdmin
      .from('contracts').select('signwell_document_id')
      .eq('id', req.params.contractId).maybeSingle();
    if(!contract || !contract.signwell_document_id) return res.status(404).json({ error: 'Contract or SignWell document not found' });

    const swRes = await fetch(`${SIGNWELL_API}/documents/${contract.signwell_document_id}`, {
      headers: { 'X-Api-Key': SW_KEY },
    });
    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error' });

    // Recipient id '2' is the builder
    let url = null;
    if(Array.isArray(swData.recipients)){
      const b = swData.recipients.find(r => r.id === '2') || swData.recipients[1];
      url = b ? (b.embedded_signing_url || b.signing_url) : null;
    }
    if(!url) return res.status(404).json({ error: 'Builder signing URL not available yet (client may still need to sign first)' });
    res.json({ signing_url: url });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// DELETE /signwell/contracts/:id — delete a contract (builder/owner/pm)
router.delete('/contracts/:id', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('contracts').delete().eq('id', req.params.id);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /signwell/signed-pdf/:contractId — fetch (and cache) the completed PDF URL from SignWell.
// Done on demand because completed_pdf_url is often not ready at webhook time.
router.get('/signed-pdf/:contractId', requireAuth, async (req, res) => {
  try {
    const { data: contract } = await supabaseAdmin
      .from('contracts').select('id, signwell_document_id, signed_pdf_url, pdf_url, status')
      .eq('id', req.params.contractId).maybeSingle();
    if(!contract) return res.status(404).json({ error: 'Contract not found' });

    // Already cached — but only trust URLs we host ourselves (SignWell URLs can't be iframed)
    if(contract.signed_pdf_url && !/signwell\.com/i.test(contract.signed_pdf_url)){
      return res.json({ url: contract.signed_pdf_url, signed: true });
    }

    if(!contract.signwell_document_id){
      return res.json({ url: contract.pdf_url || null, signed: false });
    }

    // Download the completed PDF BINARY from SignWell, then store it in our own storage.
    // (SignWell's own URLs block iframe embedding, and we want an archived copy anyway.)
    const r = await fetch(`${SIGNWELL_API}/documents/${contract.signwell_document_id}/completed_pdf`, {
      headers: { 'X-Api-Key': SW_KEY },
    });
    if(!r.ok){
      const t = await r.text();
      console.log('[SignedPDF] completed_pdf failed:', r.status, t.slice(0,200));
      return res.json({ url: contract.pdf_url || null, signed: false });
    }
    const pdfBuffer = Buffer.from(await r.arrayBuffer());
    console.log('[SignedPDF] downloaded signed PDF bytes:', pdfBuffer.length);
    if(!pdfBuffer.length) return res.json({ url: contract.pdf_url || null, signed: false });

    const { uploadFile } = require('../lib/storage');
    const fileName = `${req.companyId}/signed/${contract.id}_signed.pdf`;
    const storagePath = await uploadFile('contracts', fileName, pdfBuffer, 'application/pdf');
    const { data: urlData } = supabaseAdmin.storage.from('contracts').getPublicUrl(storagePath);
    const signedUrl = urlData.publicUrl;

    await supabaseAdmin.from('contracts').update({ signed_pdf_url: signedUrl }).eq('id', contract.id);
    res.json({ url: signedUrl, signed: true });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// GET /signwell/my-contracts — ALL contracts addressed to the logged-in user (across projects)
router.get('/my-contracts', requireAuth, async (req, res) => {
  try {
    const email = ((req.user && req.user.email) || '').toLowerCase();
    if(!email) return res.json([]);
    const { data, error } = await supabaseAdmin
      .from('contracts')
      .select('id, title, status, contract_type, signing_url, pdf_url, signed_pdf_url, recipient_email, sent_at, signed_at, created_at, project_id, projects(name, address)')
      .ilike('recipient_email', email)
      .order('created_at', { ascending: false });
    if(error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

// GET /signwell/my-signing-url/:contractId — fetch the CURRENT embedded signing URL
// for the logged-in recipient (recipient 1). Fetched fresh because stored URLs can expire.
router.get('/my-signing-url/:contractId', requireAuth, async (req, res) => {
  try {
    const email = ((req.user && req.user.email) || '').toLowerCase();
    const { data: contract } = await supabaseAdmin
      .from('contracts').select('id, signwell_document_id, recipient_email')
      .eq('id', req.params.contractId).maybeSingle();
    if(!contract || !contract.signwell_document_id) return res.status(404).json({ error: 'Contract not found' });
    // Only the addressed recipient (or a builder/pm/owner) may fetch it
    const role = req.userRole;
    const isRecipient = (contract.recipient_email||'').toLowerCase() === email;
    if(!isRecipient && !['owner','builder','pm'].includes(role)) return res.status(403).json({ error: 'Not your contract' });

    const swRes = await fetch(`${SIGNWELL_API}/documents/${contract.signwell_document_id}`, {
      headers: { 'X-Api-Key': SW_KEY },
    });
    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error' });

    // Find the recipient whose email matches (fallback to recipient id 1)
    let url = null;
    if(Array.isArray(swData.recipients)){
      const match = swData.recipients.find(r => (r.email||'').toLowerCase() === email)
                 || swData.recipients.find(r => r.id === '1')
                 || swData.recipients[0];
      url = match ? (match.embedded_signing_url || match.signing_url) : null;
      console.log('[SigningURL] recipient:', match && match.id, '| embedded:', !!(match && match.embedded_signing_url));
    }
    if(!url) return res.status(404).json({ error: 'Signing URL not available' });
    res.json({ signing_url: url });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
