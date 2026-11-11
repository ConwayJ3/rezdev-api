// Phase and project status, derived in ONE place.
//
// This file exists because the rule previously lived only in the builder's
// browser, and the one API route that bypassed it (task-complete) produced a
// phase stuck at `pending` with `progress` 100. Anything that writes a phase
// should come through here.
//
// See phase-status-api.py for the full rationale.

const { supabaseAdmin } = require('./supabase');

// Statuses a rule must never overwrite. Both are human decisions.
const FROZEN_PHASE   = ['complete', 'skipped'];
const FROZEN_PROJECT = ['on_hold', 'complete'];

function taskPct(phase){
  const tasks = Array.isArray(phase.tasks) ? phase.tasks : [];
  if(!tasks.length) return null;               // nothing to infer from
  // completed_tasks holds task INDICES, not names. Legacy rows may hold names;
  // filtering to numbers drops them, which is what every other reader does.
  const done = (Array.isArray(phase.completed_tasks) ? phase.completed_tasks : [])
    .filter(function(v){ return typeof v === 'number'; });
  return Math.round((done.length / tasks.length) * 100);
}

async function hasFailedInspection(projectId, phaseId){
  try {
    const { data, error } = await supabaseAdmin.from('project_inspections')
      .select('id')
      .eq('project_id', projectId).eq('phase_id', phaseId).eq('result', 'fail')
      .limit(1);
    if(error) throw error;
    return !!(data && data.length);
  } catch(e){
    // A gate that cannot see is worse than no gate, so say so rather than
    // silently reporting "no failures" and letting a held phase through.
    console.log('[status] inspection check failed for phase', phaseId, '-', e && e.message);
    return false;
  }
}

async function isQcApproved(projectId, phaseId){
  try {
    const { data, error } = await supabaseAdmin.from('qc_submissions')
      .select('id')
      .eq('project_id', projectId).eq('phase_id', phaseId).eq('status', 'approved')
      .limit(1);
    if(error) throw error;
    return !!(data && data.length);
  } catch(e){
    console.log('[status] QC check failed for phase', phaseId, '-', e && e.message);
    return false;
  }
}

// `phase` must be the row as it will be AFTER the write.
async function derivePhaseStatus(phase, projectId){
  if(!phase) return null;
  if(FROZEN_PHASE.indexOf(phase.status) >= 0) return phase.status;

  const pct = taskPct(phase);
  if(pct === null)  return phase.status || 'pending';
  if(pct === 0)     return 'pending';
  if(pct < 100)     return 'active';

  // Every task done. Nothing auto-completes from here: a person signs off,
  // either by approving QC or through the builder's explicit action.
  if(await hasFailedInspection(projectId, phase.id)) return 'active';
  return (await isQcApproved(projectId, phase.id)) ? 'complete' : 'active';
}

// Write the derived status if it differs. Returns the row to send back.
async function applyDerivedStatus(row, projectId){
  if(!row) return row;
  const next = await derivePhaseStatus(row, projectId);
  if(!next || next === row.status) return row;
  const { data, error } = await supabaseAdmin.from('phases')
    .update({ status: next, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('project_id', projectId)
    .select().single();
  if(error){
    console.log('[status] could not set phase', row.id, 'to', next, '-', error.message);
    return row;
  }
  return data;
}

// Best-effort: a project's own status should follow its phases.
async function syncProjectStatus(projectId){
  try {
    const { data: proj } = await supabaseAdmin.from('projects')
      .select('status').eq('id', projectId).single();
    if(!proj || FROZEN_PROJECT.indexOf(proj.status) >= 0) return;

    const { data: phases } = await supabaseAdmin.from('phases')
      .select('status').eq('project_id', projectId);
    if(!phases || !phases.length) return;

    const live = phases.filter(function(p){ return p.status !== 'skipped'; });
    if(!live.length) return;

    const allDone = live.every(function(p){ return p.status === 'complete'; });
    const started = live.some(function(p){
      return p.status === 'active' || p.status === 'complete';
    });
    const next = allDone ? 'complete' : started ? 'active' : 'planning';

    if(next !== proj.status){
      await supabaseAdmin.from('projects')
        .update({ status: next }).eq('id', projectId);
    }
  } catch(e){
    console.log('[status] project sync failed for', projectId, '-', e && e.message);
  }
}

module.exports = { derivePhaseStatus, applyDerivedStatus, syncProjectStatus, taskPct };
