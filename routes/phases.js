const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');
const { calendarFromSettings, makeIsWorkDay, addDays, iso } = require('../lib/workdays');

// Compute cascaded start/end dates for phases from a project start date.
// Phases run sequentially in sort_order; phases flagged simultaneous run
// parallel to the previous phase (share its start), not after it.
// An explicit start_date already on a phase re-anchors the chain from there.
function computePhaseDates(phases, scheduleStart, calendar){
  const cal = calendar || calendarFromSettings(null);
  const anchorYear = scheduleStart ? parseInt(scheduleStart.slice(0,4), 10) : new Date().getUTCFullYear();
  // Enough span for a long build plus its holidays either side.
  const isWorkDay = makeIsWorkDay(cal, anchorYear, anchorYear + 5);
  const nextWorkDay = d => { let x = new Date(d); while(!isWorkDay(x)) x = addDays(x, 1); return x; };
  // Advance n WORKING days from a working day (n=1 is the next one).
  const addWorkDays = (d, n) => { let x = new Date(d); for(let i=0;i<n;i++){ do { x = addDays(x,1); } while(!isWorkDay(x)); } return x; };

  let anchor = scheduleStart ? new Date(scheduleStart+'T00:00:00Z') : null;
  let prevStart = null, prevEnd = null;
  return phases.map(p => {
    const days = Math.max(1, parseInt(p.days,10) || 7);
    // If this phase has an explicitly set start_date, re-anchor to it.
    if(p.start_date){ anchor = new Date(p.start_date+'T00:00:00Z'); }
    if(!anchor){
      // No anchor available yet — leave dates null.
      return { ...p, start_date: p.start_date || null, end_date: p.end_date || null };
    }
    let start;
    if(p.simultaneous && prevStart){
      start = new Date(prevStart);            // parallel to previous phase
    } else {
      start = prevEnd ? addWorkDays(prevEnd, 1) : nextWorkDay(anchor);
    }
    // A duration is a count of WORK days, so the last day is days-1 working
    // days after the first — weekends and holidays in between don't count.
    const end = addWorkDays(start, days - 1);
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

  // Look up the project's schedule start date to anchor the cascade, and the
  // company's working calendar so durations skip weekends and holidays.
  let scheduleStart = null;
  let calendar = calendarFromSettings(null);
  try {
    const { data: proj } = await supabaseAdmin
      .from('projects').select('schedule_start_date, company_id').eq('id', req.params.projectId).maybeSingle();
    scheduleStart = proj && proj.schedule_start_date ? proj.schedule_start_date : null;
    if(proj && proj.company_id){
      const { data: co } = await supabaseAdmin
        .from('companies').select('settings').eq('id', proj.company_id).maybeSingle();
      calendar = calendarFromSettings(co && co.settings);
    }
  } catch(e){}

  const computed = computePhaseDates(data || [], scheduleStart, calendar);
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
