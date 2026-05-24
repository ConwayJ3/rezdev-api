const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
  if(error) return res.status(401).json({ error: error.message });

  // Load user profile
  const { data: profile } = await supabaseAdmin
    .from('users')
    .select('id, company_id, first_name, last_name, email, role, status, avatar_url')
    .eq('id', data.user.id)
    .single();

  if(profile?.status === 'locked') {
    await supabaseAdmin.auth.signOut();
    return res.status(403).json({ error: 'Account is locked. Contact your administrator.' });
  }

  // Update last login
  await supabaseAdmin.from('users').update({ last_login: new Date().toISOString() }).eq('id', data.user.id);

  res.json({
    access_token:  data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at:    data.session.expires_at,
    user: profile,
  });
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.auth.admin.signOut(req.token);
  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// POST /auth/refresh — exchange refresh token for new access token
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if(!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token });
  if(error) return res.status(401).json({ error: error.message });

  res.json({
    access_token:  data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at:    data.session.expires_at,
  });
});

// GET /auth/me — current user profile
router.get('/me', requireAuth, async (req, res) => {
  res.json(req.user);
});

// POST /auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if(!email) return res.status(400).json({ error: 'Email required' });

  const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
    redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
  });

  // Always return success to prevent email enumeration
  res.json({ success: true });
});

// POST /auth/reset-password
router.post('/reset-password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if(!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(req.userId, { password });
  if(error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// POST /auth/invite — create user account (builder admin only)
router.post('/invite', requireAuth, async (req, res) => {
  if(!['owner','builder'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Only owners and builders can invite users' });
  }

  const { email, first_name, last_name, role, projects } = req.body;
  if(!email || !first_name || !last_name || !role) {
    return res.status(400).json({ error: 'email, first_name, last_name, role required' });
  }

  // Create auth account
  const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: false,   // sends invite email
    user_metadata: { first_name, last_name, role }
  });

  if(authErr) return res.status(400).json({ error: authErr.message });

  // Create profile
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('users')
    .insert({
      id:          authUser.user.id,
      company_id:  req.companyId,
      first_name,
      last_name,
      email,
      role,
      status:      'pending',
    })
    .select()
    .single();

  if(profileErr) return res.status(400).json({ error: profileErr.message });

  // If PM and projects provided, create assignments
  if(role === 'pm' && projects && projects.length) {
    await supabaseAdmin.from('pm_assignments').insert(
      projects.map(pid => ({ project_id: pid, user_id: authUser.user.id, assigned_by: req.userId }))
    );
  }

  res.status(201).json(profile);
});

module.exports = router;
