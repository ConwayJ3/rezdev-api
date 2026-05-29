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

module.exports = router;
