const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');

// Compute cascaded start/end dates for phases from a project start date.
// Phases run sequentially in sort_order; phases flagged simultaneous run
// parallel to the previous phase (share its start), not after it.
// An explicit start_date already on a phase re-anchors the chain from there.
function computePhaseDates(phases, scheduleStart){
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
  const iso = d => d.toISOString().slice(0,10);
  let anchor = scheduleStart ? new Date(scheduleStart+'T00:00:00') : null;
  let prevStart = null, prevEnd = null;
  return phases.map(p => {
    const days = Math.max(1, parseInt(p.days,10) || 7);
    // If this phase has an explicitly set start_date, re-anchor to it.
    if(p.start_date){ anchor = new Date(p.start_date+'T00:00:00'); }
    if(!anchor){
      // No anchor available yet — leave dates null.
      return { ...p, start_date: p.start_date || null, end_date: p.end_date || null };
    }
    let start;
    if(p.simultaneous && prevStart){
      start = new Date(prevStart);            // parallel to previous phase
    } else {
      start = prevEnd ? addDays(prevEnd, 1) : new Date(anchor);
    }
    const end = addDays(start, days - 1);
    prevStart = start;
    // For simultaneous phases, don't advance the sequential cursor past a
    // longer preceding phase — keep the later of the two ends as the cursor.
    prevEnd = (p.simultaneous && prevEnd && prevEnd > end) ? prevEnd : end;
    return { ...p, start_date: iso(start), end_date: iso(end) };
  });
}

// GET /projects/:projectId/phases
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('phases')
    .select('*')
    .eq('project_id', req.params.projectId)
    .order('sort_order');

  if(error) return res.status(400).json({ error: error.message });

  // Look up the project's schedule start date to anchor the cascade.
  let scheduleStart = null;
  try {
    const { data: proj } = await supabaseAdmin
      .from('projects').select('schedule_start_date').eq('id', req.params.projectId).maybeSingle();
    scheduleStart = proj && proj.schedule_start_date ? proj.schedule_start_date : null;
  } catch(e){}

  const computed = computePhaseDates(data || [], scheduleStart);
  res.json(computed);
});

// POST /projects/:projectId/phases
router.post('/', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { name, status, start_date, end_date, notes, sort_order, tasks, completed_tasks, progress, days, color, simultaneous, assignee, contractor } = req.body;
  if(!name) return res.status(400).json({ error: 'Phase name required' });

  const { data, error } = await supabaseAdmin
    .from('phases')
    .insert({ project_id: req.params.projectId, name, status: status||'pending', start_date, end_date, notes, sort_order: sort_order||0, tasks: tasks||[], completed_tasks: completed_tasks||[], progress: progress||0, days: days||7, color: color||'#128995', simultaneous: simultaneous||false, assignee: assignee||'', contractor: contractor||'' })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /projects/:projectId/phases/:id
router.put('/:id', requireAuth, requireRole('owner','builder','pm'), requireProjectAccess, async (req, res) => {
  const { name, status, start_date, end_date, actual_end, notes, sort_order, tasks, completed_tasks, progress, days, color, simultaneous, assignee, contractor } = req.body;

  const { data, error } = await supabaseAdmin
    .from('phases')
    .update({ name, status, start_date, end_date, actual_end, notes, sort_order, tasks, completed_tasks, progress, days, color, simultaneous, assignee, contractor, updated_at: new Date().toISOString() })
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
      .update({ name: ph.name, status: ph.status, start_date: ph.start_date, end_date: ph.end_date, sort_order: ph.sort_order, tasks: ph.tasks, completed_tasks: ph.completed_tasks, progress: ph.progress, updated_at: new Date().toISOString() })
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
