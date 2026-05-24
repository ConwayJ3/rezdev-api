const { supabaseAdmin, supabaseForUser } = require('../lib/supabase');

/**
 * requireAuth — verifies JWT, attaches user + company to req
 * Every protected route uses this middleware.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if(!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];

    // Verify the JWT with Supabase Auth
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if(error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Load the user's profile (role, company_id, status)
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('users')
      .select('id, company_id, first_name, last_name, email, role, status')
      .eq('id', user.id)
      .single();

    if(profileErr || !profile) {
      return res.status(401).json({ error: 'User profile not found' });
    }

    if(profile.status === 'locked') {
      return res.status(403).json({ error: 'Account is locked. Contact your administrator.' });
    }

    // Attach to request for downstream use
    req.user      = profile;
    req.userId    = profile.id;
    req.companyId = profile.company_id;
    req.userRole  = profile.role;
    req.token     = token;

    // Create a user-scoped Supabase client (RLS applies)
    req.db = supabaseForUser(token);

    next();
  } catch(err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * requireRole — restrict endpoint to specific roles
 * Usage: router.post('/...', requireAuth, requireRole('owner','builder'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if(!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({
        error: `This action requires one of these roles: ${roles.join(', ')}`
      });
    }
    next();
  };
}

/**
 * requireProjectAccess — ensures user can access the requested project
 * Builders/owners: all company projects
 * PMs: assigned projects only
 * Clients: linked projects only
 * Contractors: their assigned projects
 */
async function requireProjectAccess(req, res, next) {
  try {
    const projectId = req.params.projectId || req.params.id;
    if(!projectId) return next();

    const role = req.userRole;

    // Owners and builders see all company projects
    if(['owner','builder'].includes(role)) return next();

    // PMs — check assignment
    if(role === 'pm') {
      const { data } = await supabaseAdmin
        .from('pm_assignments')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', req.userId)
        .single();
      if(!data) return res.status(403).json({ error: 'You are not assigned to this project' });
      return next();
    }

    // Clients — check project_clients
    if(role === 'client') {
      const { data } = await supabaseAdmin
        .from('project_clients')
        .select('id')
        .eq('project_id', projectId)
        .eq('user_id', req.userId)
        .single();
      if(!data) return res.status(403).json({ error: 'You do not have access to this project' });
      return next();
    }

    // Contractors — check trade_assignments or contracts
    if(role === 'contractor') {
      const { data: contractor } = await supabaseAdmin
        .from('contractors')
        .select('id')
        .eq('user_id', req.userId)
        .single();
      if(contractor) {
        const { data } = await supabaseAdmin
          .from('trade_assignments')
          .select('id')
          .eq('project_id', projectId)
          .eq('contractor_id', contractor.id)
          .single();
        if(data) return next();
      }
      return res.status(403).json({ error: 'You do not have access to this project' });
    }

    return res.status(403).json({ error: 'Access denied' });
  } catch(err) {
    console.error('Project access check error:', err);
    res.status(500).json({ error: 'Access check failed' });
  }
}

module.exports = { requireAuth, requireRole, requireProjectAccess };
