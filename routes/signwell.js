const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const SIGNWELL_API = 'https://www.signwell.com/api/v1';
const SW_KEY = process.env.SIGNWELL_API_KEY;

// POST /signwell/send
router.post('/send', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { contract_id, signer_name, signer_email } = req.body;
    if(!contract_id || !signer_email) return res.status(400).json({ error: 'contract_id and signer_email required' });
    const { data: contract, error: cErr } = await supabaseAdmin.from('contracts').select('*').eq('id', contract_id).single();
    if(cErr || !contract) return res.status(404).json({ error: 'Contract not found' });
    const swRes = await fetch(`${SIGNWELL_API}/documents`, {
      method: 'POST',
      headers: { 'X-Api-Key': SW_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_mode: false,
        name: contract.title || 'RezDev Contract',
        text: contract.body || '',
        recipients: [
          { id: '1', name: signer_name || 'Client', email: signer_email, role: 'signer' },
          { id: '2', name: req.user.first_name+' '+req.user.last_name, email: req.user.email, role: 'signer' }
        ],
        reminder_enabled: true,
        apply_signing_order: true,
      }),
    });
    const swData = await swRes.json();
    if(!swRes.ok) return res.status(400).json({ error: swData.error || 'SignWell error', details: swData });
    await supabaseAdmin.from('contracts').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', contract_id);
    res.json({ success: true, document_id: swData.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /signwell/webhook
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
        with_signature_page: false,
        test_mode: false,
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

module.exports = router;
