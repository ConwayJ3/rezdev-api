const express = require('express');
const multer  = require('multer');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { uploadFile, getSignedUrl, deleteFile } = require('../lib/storage');
const { requireAuth, requireRole, requireProjectAccess } = require('../middleware/auth');
const { calendarFromSettings, makeIsWorkDay, addDays, iso } = require('../lib/workdays');

// Compute cascaded start/end dates for phases from a project start date.
// Phases run sequentially in sort_order; phases flagged simultaneous run
// parallel to the previous phase (share its start), not after it.
// An explicit start_date already on a phase re-anchors the chain from there.
function computePhaseDates(phases, scheduleStart, calendar, delays){
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
    // A logged delay lengthens the phase. The delay form asks for actual
    // days against scheduled days, so it is work that took longer, not work
    // that started late — and everything downstream moves with it.
    const lost = (delays && delays[p.id]) ? delays[p.id] : 0;
    const days = Math.max(1, (parseInt(p.days,10) || 7) + lost);
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

  // Total the days logged against each phase. Without this the delay log
  // was a note nothing read.
  const delayDays = {};
  try {
    const { data: logged } = await supabaseAdmin.from('delay_log')
      .select('phase_id, days_delayed').eq('project_id', req.params.projectId);
    (logged || []).forEach(function(d){
      if(!d.phase_id) return;
      delayDays[d.phase_id] = (delayDays[d.phase_id] || 0) + (parseInt(d.days_delayed, 10) || 0);
    });
  } catch(e){}

  // Dates cascade through the whole ordered list, so compute against every phase
  // BEFORE any filtering — otherwise a trimmed list produces a schedule with holes
  // and the wrong dates.
  const computed = computePhaseDates(data || [], scheduleStart, calendar, delayDays);

  // A contractor sees only the phases for the trades they hold on this project.
  // Done here rather than in the portal: filtering in the browser would still have
  // sent them the entire schedule. Trades are free text entered on two different
  // screens, so match trimmed and case-insensitively.
  if(req.userRole === 'contractor'){
    try {
      const { data: mine } = await supabaseAdmin
        .from('project_contractors')
        .select('trade')
        .eq('project_id', req.params.projectId)
        .eq('user_id', req.userId);
      const trades = new Set(
        (mine || [])
          .map(function(r){ return String(r.trade || '').trim().toLowerCase(); })
          .filter(Boolean)
      );
      const mineOnly = computed.filter(function(p){
        return trades.has(String(p.assignee || '').trim().toLowerCase());
      });
      return res.json(mineOnly);
    } catch(e){
      // Can't establish which trades are theirs — send nothing rather than
      // everything. An empty list is a visible bug; a leaked schedule is not.
      console.warn('[Phases] contractor trade scope failed:', e && e.message);
      return res.json([]);
    }
  }

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
  // qc_items is the phase's QC checklist. It must be named here or it is
  // dropped without a word — the same way tasks and contractor were.
  const { name, status, start_date, end_date, actual_end, notes, sort_order, tasks, completed_tasks, progress, days, color, simultaneous, assignee, contractor, qc_items } = req.body;

  const { data, error } = await supabaseAdmin
    .from('phases')
    // Undefined fields are omitted by supabase-js, so a caller that doesn't send
    // qc_items leaves the stored checklist alone.
    .update({ name, status, start_date, end_date, actual_end, notes, sort_order, tasks, completed_tasks, progress, days, color, simultaneous, assignee, contractor, qc_items, updated_at: new Date().toISOString() })
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


// ── Task photos ──────────────────────────────────────────────────────────────
// A task is identified by (project_id, phase_id, task_idx), the same key
// project_inspections already uses, rather than a second scheme.

const PHOTO_MIN_TO_COMPLETE = 5;   // the gate the portal's design always implied
const PHOTO_MAX_PER_TASK    = 12;  // matches the original modal's cap

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },  // 25MB — phone photos, not plan sets
});

// Load the phase and, for a contractor, confirm it is one of their trades on
// this project. requireProjectAccess only proves they are ON the project; it
// says nothing about which trade's work is theirs to touch.
async function loadPhaseForCaller(req, phaseId){
  const { data: phase } = await supabaseAdmin
    .from('phases').select('*')
    .eq('id', phaseId).eq('project_id', req.params.projectId)
    .maybeSingle();
  if(!phase) return { status: 404, message: 'Phase not found' };

  if(req.userRole === 'contractor'){
    const { data: mine } = await supabaseAdmin
      .from('project_contractors').select('trade')
      .eq('project_id', req.params.projectId).eq('user_id', req.userId);
    const trades = new Set(
      (mine || [])
        .map(function(r){ return String(r.trade || '').trim().toLowerCase(); })
        .filter(Boolean)
    );
    if(!trades.has(String(phase.assignee || '').trim().toLowerCase())){
      return { status: 403, message: 'That phase is not your trade on this project' };
    }
  }
  return { phase: phase };
}

function taskNameAt(phase, idx){
  const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
  const raw = tasks[idx];
  if(typeof raw === 'string') return raw;
  return (raw && raw.name) || null;
}

async function countTaskPhotos(projectId, phaseId, taskIdx){
  const { count } = await supabaseAdmin
    .from('task_photos').select('id', { count: 'exact', head: true })
    .eq('project_id', projectId).eq('phase_id', phaseId).eq('task_idx', taskIdx);
  return count || 0;
}

// GET /projects/:projectId/phases/:id/photos[?task_idx=]
router.get('/:id/photos', requireAuth, requireProjectAccess, async (req, res) => {
  const scope = await loadPhaseForCaller(req, req.params.id);
  if(scope.status) return res.status(scope.status).json({ error: scope.message });

  let q = supabaseAdmin.from('task_photos').select('*')
    .eq('project_id', req.params.projectId).eq('phase_id', scope.phase.id)
    .order('uploaded_at', { ascending: true });
  if(req.query.task_idx != null && req.query.task_idx !== ''){
    q = q.eq('task_idx', parseInt(req.query.task_idx, 10));
  }

  const { data, error } = await q;
  if(error) return res.status(400).json({ error: error.message });

  const withUrls = await Promise.all((data || []).map(async function(p){
    try { return Object.assign({}, p, { signed_url: await getSignedUrl('files', p.storage_url) }); }
    catch(e){ return Object.assign({}, p, { signed_url: null }); }
  }));
  res.json(withUrls);
});

// POST /projects/:projectId/phases/:id/photos  (multipart: photos[], task_idx)
router.post('/:id/photos', requireAuth, requireProjectAccess,
  photoUpload.array('photos', PHOTO_MAX_PER_TASK), async (req, res) => {
  const scope = await loadPhaseForCaller(req, req.params.id);
  if(scope.status) return res.status(scope.status).json({ error: scope.message });

  if(!req.files || !req.files.length) return res.status(400).json({ error: 'No photos uploaded' });

  const taskIdx = parseInt(req.body.task_idx, 10);
  if(isNaN(taskIdx)) return res.status(400).json({ error: 'task_idx required' });
  const taskName = taskNameAt(scope.phase, taskIdx);
  if(!taskName) return res.status(400).json({ error: 'No such task on this phase' });

  const already = await countTaskPhotos(req.params.projectId, scope.phase.id, taskIdx);
  const room = Math.max(0, PHOTO_MAX_PER_TASK - already);
  if(room === 0){
    return res.status(400).json({ error: 'This task already has the maximum of ' + PHOTO_MAX_PER_TASK + ' photos' });
  }

  const uploaded = [];
  const rejected = [];
  for(const file of req.files.slice(0, room)){
    // Photos, not documents. The gate exists so the builder can see the work.
    if(!/^image\//.test(file.mimetype || '')){
      rejected.push({ name: file.originalname, reason: 'not an image' });
      continue;
    }
    const safe = String(file.originalname || 'photo').replace(/[^a-zA-Z0-9.-]/g, '_');
    const path = req.params.projectId + '/tasks/' + scope.phase.id + '/' + taskIdx + '/' + Date.now() + '-' + safe;
    try {
      const storagePath = await uploadFile('files', path, file.buffer, file.mimetype);
      const { data, error } = await supabaseAdmin.from('task_photos').insert({
        project_id:  req.params.projectId,
        phase_id:    scope.phase.id,
        task_idx:    taskIdx,
        task_name:   taskName,
        storage_url: storagePath,
        name:        file.originalname,
        file_size:   file.size,
        mime_type:   file.mimetype,
        uploaded_by: req.userId,
      }).select().single();
      if(error) rejected.push({ name: file.originalname, reason: error.message });
      else uploaded.push(data);
    } catch(e){
      console.error('[TaskPhotos] upload failed:', e && e.message);
      rejected.push({ name: file.originalname, reason: 'storage error' });
    }
  }

  if(!uploaded.length){
    return res.status(400).json({ error: 'No photos could be stored', rejected: rejected });
  }
  res.status(201).json({
    uploaded: uploaded,
    rejected: rejected,
    total: already + uploaded.length,
    required: PHOTO_MIN_TO_COMPLETE,
  });
});

// DELETE /projects/:projectId/phases/:id/photos/:photoId
router.delete('/:id/photos/:photoId', requireAuth, requireProjectAccess, async (req, res) => {
  const scope = await loadPhaseForCaller(req, req.params.id);
  if(scope.status) return res.status(scope.status).json({ error: scope.message });

  const { data: photo } = await supabaseAdmin.from('task_photos')
    .select('id, storage_url, uploaded_by, task_idx, task_name')
    .eq('id', req.params.photoId).eq('phase_id', scope.phase.id)
    .maybeSingle();
  if(!photo) return res.status(404).json({ error: 'Photo not found' });

  const isAdmin = ['owner','builder','pm'].includes(req.userRole);
  if(!isAdmin && photo.uploaded_by !== req.userId){
    return res.status(403).json({ error: 'You can only remove photos you uploaded' });
  }

  try { await deleteFile('files', photo.storage_url); }
  catch(e){ console.warn('[TaskPhotos] storage delete failed:', e && e.message); }
  await supabaseAdmin.from('task_photos').delete().eq('id', photo.id);

  // A completed task that drops below the minimum stops being complete. Work
  // should not stay marked done on evidence that is no longer there.
  let uncompleted = false;
  const left = await countTaskPhotos(req.params.projectId, scope.phase.id, photo.task_idx);
  const done = Array.isArray(scope.phase.completed_tasks) ? scope.phase.completed_tasks.slice() : [];
  const at = photo.task_name ? done.indexOf(photo.task_name) : -1;
  if(at >= 0 && left < PHOTO_MIN_TO_COMPLETE){
    done.splice(at, 1);
    const total = Array.isArray(scope.phase.tasks) ? scope.phase.tasks.length : 0;
    await supabaseAdmin.from('phases').update({
      completed_tasks: done,
      progress: total ? Math.round((done.length / total) * 100) : 0,
      updated_at: new Date().toISOString(),
    }).eq('id', scope.phase.id).eq('project_id', req.params.projectId);
    uncompleted = true;
  }

  res.json({ success: true, remaining: left, required: PHOTO_MIN_TO_COMPLETE, uncompleted: uncompleted });
});

// PUT /projects/:projectId/phases/:id/task-complete  { task_idx, complete }
// The photo minimum is enforced here. In the original design it lived only in
// the browser, which means it was advisory — anyone calling the API directly
// could mark work complete with nothing to show for it.
router.put('/:id/task-complete', requireAuth, requireProjectAccess, async (req, res) => {
  const scope = await loadPhaseForCaller(req, req.params.id);
  if(scope.status) return res.status(scope.status).json({ error: scope.message });

  const taskIdx = parseInt(req.body.task_idx, 10);
  if(isNaN(taskIdx)) return res.status(400).json({ error: 'task_idx required' });
  const taskName = taskNameAt(scope.phase, taskIdx);
  if(!taskName) return res.status(400).json({ error: 'No such task on this phase' });

  const complete = req.body.complete !== false;

  if(complete){
    const have = await countTaskPhotos(req.params.projectId, scope.phase.id, taskIdx);
    if(have < PHOTO_MIN_TO_COMPLETE){
      return res.status(400).json({
        error: 'Upload at least ' + PHOTO_MIN_TO_COMPLETE + ' photos to mark this task complete',
        photos: have, required: PHOTO_MIN_TO_COMPLETE,
      });
    }
  }

  const tasks = Array.isArray(scope.phase.tasks) ? scope.phase.tasks : [];
  const done  = Array.isArray(scope.phase.completed_tasks) ? scope.phase.completed_tasks.slice() : [];
  const at    = done.indexOf(taskName);
  if(complete && at < 0) done.push(taskName);
  if(!complete && at >= 0) done.splice(at, 1);

  // Keep phases.progress in step, so the builder's progress bar reflects the
  // work instead of having to be set by hand.
  const progress = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;

  const { data, error } = await supabaseAdmin.from('phases')
    .update({ completed_tasks: done, progress: progress, updated_at: new Date().toISOString() })
    .eq('id', scope.phase.id).eq('project_id', req.params.projectId)
    .select().single();
  if(error) return res.status(400).json({ error: error.message });

  res.json({
    success: true,
    completed_tasks: data.completed_tasks,
    progress: data.progress,
    all_complete: tasks.length > 0 && done.length === tasks.length,
  });
});

module.exports = router;
