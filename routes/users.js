const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /users — all users in company
router.get('/', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { data, error } = await req.db
    .from('users')
    .select('id, first_name, last_name, email, role, status, last_login, created_at')
    .eq('company_id', req.companyId)
    .order('created_at');

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /users/pm-assignments
router.get('/pm-assignments', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { data, error } = await req.db
    .from('pm_assignments')
    .select(`*, users(first_name, last_name, email), projects(name)`)
    .eq('users.company_id', req.companyId);

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /users/pm-assignments — bulk update PM project assignments
router.put('/pm-assignments', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { user_id, project_ids } = req.body;
  if(!user_id || !Array.isArray(project_ids)) return res.status(400).json({ error: 'user_id and project_ids required' });

  // Delete existing assignments for this PM
  await supabaseAdmin.from('pm_assignments').delete().eq('user_id', user_id);

  // Insert new ones
  if(project_ids.length) {
    const rows = project_ids.map(pid => ({ project_id: pid, user_id, assigned_by: req.userId }));
    const { error } = await supabaseAdmin.from('pm_assignments').insert(rows);
    if(error) return res.status(400).json({ error: error.message });
  }

  res.json({ success: true, assigned: project_ids.length });
});

// PUT /users/:id — update user profile / role
router.put('/:id', requireAuth, async (req, res) => {
  const isSelf  = req.params.id === req.userId;
  const isAdmin = ['owner','builder'].includes(req.userRole);
  if(!isSelf && !isAdmin) return res.status(403).json({ error: 'Cannot edit another user' });

  const allowed = isSelf
    ? ['first_name','last_name','phone','avatar_url']
    : ['first_name','last_name','phone','avatar_url','role','status','lock_reason'];
  const updates = {};
  allowed.forEach(k => { if(req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select('id, first_name, last_name, email, role, status')
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /users/:id/lock
router.put('/:id/lock', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { reason } = req.body;
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ status: 'locked', lock_reason: reason || '' })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// PUT /users/:id/unlock
router.put('/:id/unlock', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ status: 'active', lock_reason: '' })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .select()
    .single();
  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /users/audit-log
router.get('/audit-log', requireAuth, requireRole('owner','builder'), async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const { data, error } = await req.db
    .from('audit_log')
    .select('*')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /users/audit-log — record an action
router.post('/audit-log', requireAuth, async (req, res) => {
  const { action, target, detail } = req.body;
  const { data, error } = await supabaseAdmin
    .from('audit_log')
    .insert({ company_id: req.companyId, user_id: req.userId, action, target, detail })
    .select()
    .single();
  if(error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
