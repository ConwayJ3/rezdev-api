const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

// Contract templates — per company + contract_type
// Body is rich text / HTML with {{merge_tags}}

// GET /contract-templates — all templates for this company
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('contract_templates')
      .select('*')
      .eq('company_id', req.companyId);
    if(error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /contract-templates/:type — one template
router.get('/:type', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('contract_templates')
      .select('*')
      .eq('company_id', req.companyId)
      .eq('contract_type', req.params.type)
      .maybeSingle();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data || null);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// PUT /contract-templates/:type — save (upsert) a template
router.put('/:type', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    const { body, signer_roles } = req.body;
    const row = {
      company_id:    req.companyId,
      contract_type: req.params.type,
      body:          body || '',
      updated_at:    new Date().toISOString(),
    };
    if(signer_roles !== undefined) row.signer_roles = signer_roles;
    const { data, error } = await supabaseAdmin
      .from('contract_templates')
      .upsert(row, { onConflict: 'company_id,contract_type' })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

module.exports = router;
