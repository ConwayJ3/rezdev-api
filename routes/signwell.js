const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const SIGNWELL_API = 'https://www.signwell.com/api/v1';
const SW_KEY = process.env.SIGNWELL_API_KEY;
const { mergeTemplate, buildMergeData, generateContractPdf } = require('../lib/contractPdf');
const { fillDocx, convertDocxToPdf } = require('../lib/docxContract');
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
    const event = req.body;
    console.log('[SignWell] Webhook:', event.event_type);
    if(event.event_type === 'document_completed') {
      const docId = event.data?.id;
      if(docId) await supabaseAdmin.from('contracts').update({ status: 'signed', signed_at: new Date().toISOString() }).eq('signwell_document_id', docId);
    }
    res.json({ received: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
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

// GET /signwell/templates — get all templates for this company
router.get('/templates', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('signwell_templates')
      .select('*')
      .eq('company_id', req.companyId);
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
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

    // Upsert the contract_templates record (docx path)
    const { data, error } = await supabaseAdmin
      .from('contract_templates')
      .upsert({
        company_id:    req.companyId,
        contract_type: contractType,
        template_name: templateName,
        docx_url:      docxUrl,
        docx_path:     storagePath,
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
  const cfg = project && (Array.isArray(project.budget_configs) ? project.budget_configs[0] : project.budget_configs);
  const total = cfg && (cfg.total_budget || cfg.build_budget);
  const fmtMoney = n => (n==null||n==='') ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const builderName = ((builderUser.first_name||'')+' '+(builderUser.last_name||'')).trim();
  return Object.assign({
    date: today,
    company_name:    (company && company.name) || '',
    company_address: (company && company.address) || '',
    company_phone:   (company && company.phone) || '',
    company_email:   (company && company.email) || '',
    builder_name:    builderName,
    client_name:     clientName || '',
    client_email:    clientEmail || '',
    project_name:    (project && project.name) || '',
    project_address: (project && project.address) || '',
    project_city:    (project && project.city) || '',
    project_state:   (project && project.state) || '',
    contract_price:  fmtMoney(total),
    sig_client: '', sig_builder: '',  // signature anchors render blank in the doc
  }, extra || {});
}

// POST /signwell/send-docx-contract — fill DOCX template, convert to PDF, send via SignWell
router.post('/send-docx-contract', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { project_id, contract_type, client_name, client_email, extra_fields } = req.body;
    const ctype = contract_type || 'client';
    if(!project_id || !client_email) return res.status(400).json({ error: 'project_id and client_email required' });

    // 1. Load the DOCX template
    const { data: tmpl } = await supabaseAdmin
      .from('contract_templates').select('*')
      .eq('company_id', req.companyId).eq('contract_type', ctype).maybeSingle();
    if(!tmpl || !tmpl.docx_url) return res.status(400).json({ error: 'No DOCX template configured for type: ' + ctype });

    // 2. Download the DOCX
    const docxRes = await fetch(tmpl.docx_url);
    if(!docxRes.ok) return res.status(400).json({ error: 'Could not download template DOCX' });
    const docxBuffer = Buffer.from(await docxRes.arrayBuffer());

    // 3. Fill merge tags
    const data = await buildDocxMergeData({
      companyId: req.companyId, projectId: project_id,
      clientName: client_name, clientEmail: client_email,
      builderUser: req.user, extra: extra_fields,
    });
    let filledDocx;
    try { filledDocx = fillDocx(docxBuffer, data); }
    catch(e){ return res.status(400).json({ error: 'Template merge failed: ' + (e.message||'check your {{tags}}') }); }

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
    const title = titleMap[ctype] || 'Contract';
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
        name: title + ' — ' + (client_name||''),
        files: [{ name:'contract.pdf', file_url: fileUrl }],
        recipients: [
          { id:'1', name: client_name || 'Client', email: client_email },
          { id:'2', name: builderName || 'Builder', email: req.user.email },
        ],
        embedded_signing: true, reminder_enabled: true, apply_signing_order: true,
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
        signwell_document_id: swData.id, signing_url: signingUrl, recipient_email: client_email, pdf_url: fileUrl,
      }).eq('id', contractRow.id);
    }
    res.json({ success:true, document_id: swData.id, signing_url: signingUrl, pdf_url: fileUrl, contract_id: contractRow?.id });
  } catch(e){
    console.error('[SignWell send-docx-contract] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
