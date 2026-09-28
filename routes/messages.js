const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireProjectAccess } = require('../middleware/auth');
const { sendMessageNotification } = require('../lib/email');

// Which conversation does this request belong to?
//
// A client or contractor is PINNED to their own: whatever they ask for, they
// get their own thread and nothing else. Only the builder side chooses.
//
// Messages sent before per-party threads have thread_with empty. Every one of
// those was builder-to-client, so empty is read as the client conversation.
async function resolveThread(req){
  const role = req.userRole;
  if(['owner','builder','pm'].includes(role)){
    const asked = (req.query.with || req.body.thread_with || '').trim();
    return { threadWith: asked || null, pinned: false };
  }
  return { threadWith: req.userId, pinned: true };
}

// Older client messages have no thread_with. For the client's own thread, and
// for the builder viewing it, those still belong in the conversation.
async function isClientThread(projectId, userId){
  if(!userId) return true;
  const { data } = await supabaseAdmin.from('project_clients')
    .select('id').eq('project_id', projectId).eq('user_id', userId).limit(1);
  return !!(data && data.length);
}

// GET /messages/mine — a contractor's or client's conversations, one per
// project. Mounted outside the project scope because they need the list
// before choosing a project, the same shape as /rfps/mine.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const uid = req.userId;

    let projectIds = [];
    const { data: asCrew } = await supabaseAdmin.from('project_contractors')
      .select('project_id').eq('user_id', uid);
    (asCrew || []).forEach(function(r){ projectIds.push(r.project_id); });
    const { data: asClient } = await supabaseAdmin.from('project_clients')
      .select('project_id').eq('user_id', uid);
    (asClient || []).forEach(function(r){ projectIds.push(r.project_id); });
    projectIds = [...new Set(projectIds)];
    if(!projectIds.length) return res.json([]);

    const { data: projects } = await supabaseAdmin.from('projects')
      .select('id, name, address, created_by').in('id', projectIds);

    const { data: msgs } = await supabaseAdmin.from('messages')
      .select('project_id, thread_with, from_user_id, text, sent_at')
      .in('project_id', projectIds).order('sent_at', { ascending: false });

    const { data: seen } = await supabaseAdmin.from('message_reads')
      .select('project_id, last_seen_at').eq('user_id', uid);
    const seenBy = {};
    (seen || []).forEach(function(r){ seenBy[r.project_id] = r.last_seen_at; });

    const out = (projects || []).map(function(p){
      // Their own thread only. Legacy messages with no thread_with were
      // builder-to-client, so a client still sees their history.
      const mine = (msgs || []).filter(function(m){
        if(m.project_id !== p.id) return false;
        if(m.thread_with) return m.thread_with === uid;
        return (asClient || []).some(function(c){ return c.project_id === p.id; });
      });
      const since = seenBy[p.id];
      return {
        project_id: p.id,
        project_name: p.name || p.address || 'Project',
        last_message: mine.length ? mine[0].text : null,
        last_at: mine.length ? mine[0].sent_at : null,
        unread: mine.filter(function(m){
          return m.from_user_id !== uid && (!since || m.sent_at > since);
        }).length,
      };
    });

    out.sort(function(a,b){ return (b.last_at || '') > (a.last_at || '') ? 1 : -1; });
    res.json(out);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /projects/:projectId/messages/threads — the conversation list
// Everyone the builder can talk to on this project: the client, and each
// assigned contractor, with unread counts.
router.get('/threads', requireAuth, requireProjectAccess, async (req, res) => {
  try {
    if(!['owner','builder','pm'].includes(req.userRole)){
      return res.status(403).json({ error: 'Not authorized' });
    }
    const pid = req.params.projectId;

    const threads = [];

    const { data: clients } = await supabaseAdmin.from('project_clients')
      .select('user_id, users(id, first_name, last_name, email)').eq('project_id', pid);
    (clients || []).forEach(function(c){
      const u = c.users || {};
      threads.push({
        user_id: c.user_id,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Client',
        role: 'client',
        subtitle: 'Client',
      });
    });

    const { data: crew } = await supabaseAdmin.from('project_contractors')
      .select('user_id, trade, users(id, first_name, last_name, email)').eq('project_id', pid);
    for(const c of (crew || [])){
      const u = c.users || {};
      // Prefer the company name — that's how a builder thinks of a sub.
      let label = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Contractor';
      try {
        const { data: rows } = await supabaseAdmin.from('contractors')
          .select('company_name').eq('user_id', c.user_id).limit(1);
        if(rows && rows[0] && rows[0].company_name) label = rows[0].company_name;
      } catch(e){}
      threads.push({
        user_id: c.user_id,
        name: label,
        role: 'contractor',
        subtitle: c.trade || 'Contractor',
      });
    }

    // Unread per conversation, from this user's last-seen marker.
    const { data: seen } = await supabaseAdmin.from('message_reads')
      .select('last_seen_at').eq('project_id', pid).eq('user_id', req.userId).maybeSingle();
    const since = seen && seen.last_seen_at;

    const { data: msgs } = await supabaseAdmin.from('messages')
      .select('thread_with, from_user_id, sent_at, text')
      .eq('project_id', pid).order('sent_at', { ascending: false });

    threads.forEach(function(t){
      const mine = (msgs || []).filter(function(m){
        if(m.thread_with) return m.thread_with === t.user_id;
        return t.role === 'client';   // legacy messages belong to the client
      });
      t.last_message = mine.length ? mine[0].text : null;
      t.last_at      = mine.length ? mine[0].sent_at : null;
      t.unread = mine.filter(function(m){
        return m.from_user_id !== req.userId && (!since || m.sent_at > since);
      }).length;
    });

    threads.sort(function(a,b){ return (b.last_at || '') > (a.last_at || '') ? 1 : -1; });
    res.json(threads);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// GET /projects/:projectId/messages
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { threadWith } = await resolveThread(req);

  let q = req.db
    .from('messages')
    .select('id, from_name, from_role, text, sent_at, thread_with')
    .eq('project_id', req.params.projectId)
    .order('sent_at');

  const { data: all, error } = await q;
  if(error) return res.status(400).json({ error: error.message });

  // Legacy messages (no thread_with) belong to the client conversation.
  const clientThread = await isClientThread(req.params.projectId, threadWith);
  const data = (all || []).filter(function(m){
    if(m.thread_with) return m.thread_with === threadWith;
    return clientThread;
  });

  // Mark as read for this user
  await supabaseAdmin.from('message_reads').upsert(
    { project_id: req.params.projectId, user_id: req.userId, last_seen_at: new Date().toISOString() },
    { onConflict: 'project_id,user_id' }
  );

  res.json(data);
});

// POST /projects/:projectId/messages
router.post('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { text } = req.body;
  if(!text || !text.trim()) return res.status(400).json({ error: 'Message text required' });

  const { threadWith } = await resolveThread(req);
  if(!threadWith){
    return res.status(400).json({ error: 'Choose who this message is for' });
  }

  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({
      project_id:  req.params.projectId,
      from_user_id: req.userId,
      from_name:   `${req.user.first_name} ${req.user.last_name}`,
      from_role:   req.userRole,
      thread_with: threadWith,
      text:        text.trim(),
    })
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);

  // Notify the OTHER party by email (fire-and-forget; never blocks the response).
  (async () => {
    try {
      const pid = req.params.projectId;
      const senderRole = req.userRole;
      let toEmail = null, toName = null;

      const { data: proj } = await supabaseAdmin.from('projects')
        .select('created_by, name, address').eq('id', pid).maybeSingle();
      const projName = proj && (proj.name || proj.address);

      if(['owner','builder','pm'].includes(senderRole)){
        // Builder side -> notify whoever this conversation is with, which may
        // be the client or a contractor. It used to always assume the client.
        const target = data && data.thread_with;
        if(target){
          const { data: u } = await supabaseAdmin.from('users')
            .select('email, first_name').eq('id', target).maybeSingle();
          if(u){ toEmail = u.email; toName = u.first_name; }
        }
      } else {
        // Client or contractor -> notify the builder who owns the project.
        if(proj && proj.created_by){
          const { data: u } = await supabaseAdmin.from('users')
            .select('email, first_name').eq('id', proj.created_by).maybeSingle();
          if(u){ toEmail = u.email; toName = u.first_name; }
        }
      }
      if(toEmail){
        await sendMessageNotification({
          to: toEmail,
          recipientName: toName,
          senderName: `${req.user.first_name} ${req.user.last_name}`.trim(),
          projectName: projName || '',
        });
      }
    } catch(e){ console.log('[Messages] notification email failed:', e.message); }
  })();
});

// GET /projects/:projectId/messages/unread-count
router.get('/unread-count', requireAuth, requireProjectAccess, async (req, res) => {
  const { data: readRecord } = await supabaseAdmin
    .from('message_reads')
    .select('last_seen_at')
    .eq('project_id', req.params.projectId)
    .eq('user_id', req.userId)
    .single();

  const lastSeen = readRecord?.last_seen_at || '2000-01-01';

  const { count, error } = await supabaseAdmin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', req.params.projectId)
    .neq('from_user_id', req.userId)
    .gt('sent_at', lastSeen);

  if(error) return res.status(400).json({ error: error.message });
  res.json({ unread: count || 0 });
});

module.exports = router;
