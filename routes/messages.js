const express = require('express');
const router  = express.Router({ mergeParams: true });
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireProjectAccess } = require('../middleware/auth');
const { sendMessageNotification } = require('../lib/email');

// GET /projects/:projectId/messages
router.get('/', requireAuth, requireProjectAccess, async (req, res) => {
  const { data, error } = await req.db
    .from('messages')
    .select('id, from_name, from_role, text, sent_at')
    .eq('project_id', req.params.projectId)
    .order('sent_at');

  if(error) return res.status(400).json({ error: error.message });

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

  const { data, error } = await supabaseAdmin
    .from('messages')
    .insert({
      project_id:  req.params.projectId,
      from_user_id: req.userId,
      from_name:   `${req.user.first_name} ${req.user.last_name}`,
      from_role:   req.userRole,
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
      if(senderRole === 'client'){
        // Client sent -> notify the builder (project creator).
        const { data: proj } = await supabaseAdmin.from('projects').select('created_by, name, address').eq('id', pid).maybeSingle();
        if(proj && proj.created_by){
          const { data: u } = await supabaseAdmin.from('users').select('email, first_name').eq('id', proj.created_by).maybeSingle();
          if(u){ toEmail = u.email; toName = u.first_name; }
        }
        var projName = proj && (proj.name || proj.address);
      } else {
        // Builder/PM sent -> notify the linked client.
        const { data: pc } = await supabaseAdmin.from('project_clients').select('email, client_name').eq('project_id', pid).maybeSingle();
        if(pc){ toEmail = pc.email; toName = pc.client_name; }
        const { data: proj } = await supabaseAdmin.from('projects').select('name, address').eq('id', pid).maybeSingle();
        var projName = proj && (proj.name || proj.address);
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
