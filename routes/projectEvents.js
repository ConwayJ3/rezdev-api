const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');

// GET /projects/:projectId/events — list events
// Clients only see events flagged visible_to_client.
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    let q = supabaseAdmin
      .from('project_events')
      .select('*')
      .eq('project_id', req.params.projectId)
      .order('event_date')
      .order('event_time', { nullsFirst: true });
    const role = req.user && req.user.role;
    if(role === 'client'){ q = q.eq('visible_to_client', true); }
    const { data, error } = await q;
    if(error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// POST /projects/:projectId/events — create
router.post('/', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  try {
    const { title, type, event_date, event_time, end_time, location, notes, visible_to_client } = req.body;
    if(!title || !event_date) return res.status(400).json({ error: 'title and event_date required' });
    const { data, error } = await supabaseAdmin
      .from('project_events')
      .insert({
        project_id: req.params.projectId,
        company_id: req.companyId,
        title, type: type || 'meeting',
        event_date,
        event_time: event_time || null,
        end_time: end_time || null,
        location: location || null,
        notes: notes || null,
        visible_to_client: visible_to_client !== false,
        created_by: req.userId,
      })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// PUT /projects/:projectId/events/:id — update
router.put('/:id', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  try {
    const allowed = ['title','type','event_date','event_time','end_time','location','notes','visible_to_client'];
    const updates = {};
    allowed.forEach(k => { if(req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('project_events')
      .update(updates)
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId)
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// DELETE /projects/:projectId/events/:id
router.delete('/:id', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('project_events')
      .delete()
      .eq('id', req.params.id)
      .eq('project_id', req.params.projectId);
    if(error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

module.exports = router;
