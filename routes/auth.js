const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendClientInvite } = require('../lib/email');

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

  // Update last login; activate the account on first login (pending -> active)
  const loginUpdate = { last_login: new Date().toISOString() };
  if(profile?.status === 'pending') loginUpdate.status = 'active';
  await supabaseAdmin.from('users').update(loginUpdate).eq('id', data.user.id);
  if(loginUpdate.status) profile.status = 'active';

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

// POST /auth/invite-client — create a client account and email a branded set-password invite
router.post('/invite-client', requireAuth, async (req, res) => {
  if(!['owner','builder','pm'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Not authorized to invite clients' });
  }
  const { email, first_name, last_name, project_id } = req.body;
  const role = ['client','pm','builder'].includes(req.body.role) ? req.body.role : 'client';
  if(!email || !first_name) {
    return res.status(400).json({ error: 'email and first_name required' });
  }

  try {
    // 1. Create the auth account (unconfirmed; they'll set their own password)
    const tempPassword = 'RezDev' + Math.random().toString(36).slice(2,12) + '!A';
    const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,   // allow immediate login once they set a password
      user_metadata: { first_name, last_name: last_name || '', role }
    });
    if(authErr) {
      if(/already|registered|exists/i.test(authErr.message)) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      return res.status(400).json({ error: authErr.message });
    }

    // 2. Create the profile row
    const { error: profileErr } = await supabaseAdmin
      .from('users')
      .insert({
        id:         authUser.user.id,
        company_id: req.companyId,
        first_name,
        last_name:  last_name || '',
        email,
        role,
        status:     'pending',
      });
    if(profileErr) return res.status(400).json({ error: profileErr.message });

    // 3. Generate a secure set-password (recovery) link pointing to our branded page
    const appUrl = process.env.FRONTEND_URL || 'https://rezdevos.com';
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: appUrl + '/set-password.html' }
    });
    if(linkErr) return res.status(400).json({ error: 'Account created but could not generate invite link: ' + linkErr.message });

    const setupUrl = (linkData && linkData.properties && linkData.properties.action_link) || (appUrl + '/set-password.html');

    // 4. Look up the inviting builder + company name for the email
    let builderName = '', companyName = '';
    try {
      const { data: me } = await supabaseAdmin.from('users').select('first_name,last_name').eq('id', req.userId).maybeSingle();
      if(me) builderName = [me.first_name, me.last_name].filter(Boolean).join(' ');
      const { data: co } = await supabaseAdmin.from('companies').select('name').eq('id', req.companyId).maybeSingle();
      if(co) companyName = co.name;
    } catch(e){ /* non-fatal */ }

    // 5. Send the branded email
    try {
      await sendClientInvite({ to: email, clientName: first_name, builderName, companyName, setupUrl, role });
    } catch(emailErr){
      try { await supabaseAdmin.from('users').delete().eq('id', authUser.user.id); } catch(e){}
      try { await supabaseAdmin.auth.admin.deleteUser(authUser.user.id); } catch(e){}
      return res.status(502).json({ error: 'Could not send invite email: ' + emailErr.message });
    }

    res.json({ success: true, user_id: authUser.user.id, message: 'Invite sent to ' + email });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
