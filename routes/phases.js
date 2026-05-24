const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');

// GET /projects/:projectId/phases
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('phases')
    .select('*')
    .eq('project_id', req.params.projectId)
    .order('sort_order');

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/:projectId/phases
router.post('/', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { name, status, start_date, end_date, notes, sort_order } = req.body;
  if(!name) return res.status(400).json({ error: 'Phase name required' });

  const { data, error } = await supabaseAdmin
    .from('phases')
    .insert({ project_id: req.params.projectId, name, status: status||'pending', start_date, end_date, notes, sort_order: sort_order||0 })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /projects/:projectId/phases/:id
router.put('/:id', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { name, status, start_date, end_date, actual_end, notes, sort_order } = req.body;

  const { data, error } = await supabaseAdmin
    .from('phases')
    .update({ name, status, start_date, end_date, actual_end, notes, sort_order, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /projects/:projectId/phases — bulk update (reorder + status)
router.put('/', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { phases } = req.body;
  if(!Array.isArray(phases)) return res.status(400).json({ error: 'phases array required' });

  const updates = await Promise.all(phases.map(ph =>
    supabaseAdmin.from('phases')
      .update({ name: ph.name, status: ph.status, start_date: ph.start_date, end_date: ph.end_date, sort_order: ph.sort_order, updated_at: new Date().toISOString() })
      .eq('id', ph.id)
      .eq('project_id', req.params.projectId)
      .select()
  ));

  const errors = updates.filter(u => u.error);
  if(errors.length) return res.status(400).json({ error: errors[0].error.message });
  res.json(updates.map(u => u.data));
});

// DELETE /projects/:projectId/phases/:id
router.delete('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('phases')
    .delete()
    .eq('id', req.params.id)
    .eq('project_id', req.params.projectId);

  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// Phase templates
// GET /projects/:projectId/phases/templates
router.get('/templates', requireAuth, async (req, res) => {
  const { data, error } = await req.db
    .from('phase_templates')
    .select('*')
    .eq('company_id', req.companyId)
    .order('created_at');

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /projects/:projectId/phases/templates
router.post('/templates', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  const { name, phases } = req.body;
  if(!name || !phases) return res.status(400).json({ error: 'name and phases required' });

  const { data, error } = await supabaseAdmin
    .from('phase_templates')
    .insert({ company_id: req.companyId, name, phases, created_by: req.userId })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
