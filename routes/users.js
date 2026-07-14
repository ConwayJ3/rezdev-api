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
    .select(`*, users!pm_assignments_user_id_fkey(first_name, last_name, email, company_id), projects(name)`);

  if(error) return res.status(400).json({ error: error.message });
  // Filter to this company (the embedded user's company)
  const filtered = (data||[]).filter(r => r.users && r.users.company_id === req.companyId);
  res.json(filtered);
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

// POST /users — create a new user (invite)
router.post('/', requireAuth, requireRole('owner','builder','pm'), async (req, res) => {
  try {
    const { first_name, last_name, email, role, password } = req.body;
    if(!email || !role) return res.status(400).json({ error: 'email and role required' });

    // Create auth user in Supabase Auth
    const tempPassword = password || 'RezDev' + Math.random().toString(36).slice(2,10) + '!';
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });
    if(authErr) return res.status(400).json({ error: authErr.message });

    // Create user record
    const { data, error } = await supabaseAdmin
      .from('users')
      .insert({
        id:         authData.user.id,
        email,
        first_name: first_name || '',
        last_name:  last_name  || '',
        role,
        status:     'active',
        company_id: req.companyId,
      })
      .select('id, first_name, last_name, email, role, status, created_at')
      .single();

    if(error) return res.status(400).json({ error: error.message });
    res.status(201).json({ ...data, temp_password: tempPassword });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// DELETE /users/:id — remove a user
router.delete('/:id', requireAuth, requireRole('owner','builder'), async (req, res) => {
  try {
    // Remove from users table
    await supabaseAdmin.from('users').delete().eq('id', req.params.id).eq('company_id', req.companyId);
    // Remove auth user
    await supabaseAdmin.auth.admin.deleteUser(req.params.id);
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
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

// CONTRACTOR BANKING ─────────────────────────────────────────
router.get('/banking', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('contractor_banking')
      .select('*')
      .eq('user_id', req.userId)
      .single();
    if(error && error.code !== 'PGRST116') return res.status(400).json({ error: error.message });
    res.json(data || {});
  } catch(e){ res.status(500).json({ error: e.message }); }
});

router.post('/banking', requireAuth, async (req, res) => {
  try {
    const { bank_name, account_holder, account_number, routing_number, account_type, ach_same_as_wire, ach_account_number, ach_routing_number } = req.body;
    const { data, error } = await supabaseAdmin
      .from('contractor_banking')
      .upsert({
        user_id: req.userId,
        bank_name, account_holder, account_number, routing_number,
        account_type: account_type || 'checking',
        ach_same_as_wire: ach_same_as_wire !== false,
        ach_account_number, ach_routing_number,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' })
      .select().single();
    if(error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── Company routes ────────────────────────────────────
// GET /companies/me — the logged-in user's company record
router.get('/companies/me', requireAuth, async (req, res) => {
  try {
    if(!req.companyId) return res.status(400).json({ error: 'No company for this user' });
    const { data, error } = await supabaseAdmin
      .from('companies').select('*').eq('id', req.companyId).maybeSingle();
    if(error) return res.status(400).json({ error: error.message });
    if(!data) return res.status(404).json({ error: 'Company not found' });
    res.json(data);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// PUT /companies/:id
router.put('/companies/:id', requireAuth, async (req, res) => {
  if(!req.user || !['owner','builder'].includes(req.userRole)){
    return res.status(403).json({ error: 'Not authorized' });
  }
  const allowed = ['name','legal_name','address','city','state','zip','phone','email','website','primary_color','secondary_color','license_number'];
  const updates = {};
  allowed.forEach(k => { if(req.body[k] !== undefined) updates[k] = req.body[k]; });
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('companies')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if(error) return res.status(400).json({ error: error.message });
  res.json(data);
});
