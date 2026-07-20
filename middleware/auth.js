const { supabaseAdmin, supabaseForUser } = require('../lib/supabase');

// ---------------------------------------------------------------------------
// Auth resilience
//
// Every protected request used to make two Supabase round-trips (validate the
// JWT, then load the profile). Under a transient network blip between the API
// host and Supabase those calls time out (UND_ERR_CONNECT_TIMEOUT) and the
// request returned 401 -- which the frontend reads as "session expired" and
// signs the user out. Two changes fix that:
//   1. Cache successful validations briefly so a page load with many sections
//      makes one auth call instead of a dozen.
//   2. Distinguish "Supabase unreachable" (503, retryable) from "bad token"
//      (401, genuine), and retry transient failures before giving up.
// ---------------------------------------------------------------------------
const AUTH_CACHE_TTL_MS = 60 * 1000;   // re-validate a token at most once a minute
const _authCache = new Map();          // token -> { profile, user, expires }

function _cacheGet(token){
  const hit = _authCache.get(token);
  if(!hit) return null;
  if(Date.now() > hit.expires){ _authCache.delete(token); return null; }
  return hit;
}
function _cacheSet(token, user, profile){
  _authCache.set(token, { user, profile, expires: Date.now() + AUTH_CACHE_TTL_MS });
  // keep the map from growing without bound
  if(_authCache.size > 500){
    const now = Date.now();
    for(const [k, v] of _authCache) if(now > v.expires) _authCache.delete(k);
  }
}

// A network/connection failure -- as opposed to a rejected token.
function _isTransient(err){
  if(!err) return false;
  const code = err.code || (err.cause && err.cause.code) || '';
  const msg  = (err.message || '') + ' ' + ((err.cause && err.cause.message) || '');
  return /UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(code + ' ' + msg);
}

// Retry transient failures with a short backoff.
async function _withRetry(fn, attempts = 3){
  let lastErr;
  for(let i = 0; i < attempts; i++){
    try { return await fn(); }
    catch(err){
      lastErr = err;
      if(!_isTransient(err)) throw err;
      if(i < attempts - 1) await new Promise(r => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

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

    let user, profile;
    const cached = _cacheGet(token);

    if(cached){
      user    = cached.user;
      profile = cached.profile;
    } else {
      // Verify the JWT with Supabase Auth (retrying transient network failures)
      let authRes;
      try {
        authRes = await _withRetry(() => supabaseAdmin.auth.getUser(token));
      } catch(err){
        if(_isTransient(err)){
          console.warn('[auth] Supabase unreachable while validating token:', err.message);
          return res.status(503).json({ error: 'Auth service temporarily unavailable', retryable: true });
        }
        throw err;
      }

      if(authRes && authRes.error && _isTransient(authRes.error)){
        console.warn('[auth] transient auth error:', authRes.error.message);
        return res.status(503).json({ error: 'Auth service temporarily unavailable', retryable: true });
      }

      user = authRes && authRes.data ? authRes.data.user : null;
      if((authRes && authRes.error) || !user){
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      // Load the user's profile (role, company_id, status)
      let profRes;
      try {
        profRes = await _withRetry(() => supabaseAdmin
          .from('users')
          .select('id, company_id, first_name, last_name, email, role, status')
          .eq('id', user.id)
          .single());
      } catch(err){
        if(_isTransient(err)){
          console.warn('[auth] Supabase unreachable while loading profile:', err.message);
          return res.status(503).json({ error: 'Auth service temporarily unavailable', retryable: true });
        }
        throw err;
      }

      profile = profRes ? profRes.data : null;
      if((profRes && profRes.error) || !profile){
        if(profRes && profRes.error && _isTransient(profRes.error)){
          return res.status(503).json({ error: 'Auth service temporarily unavailable', retryable: true });
        }
        return res.status(401).json({ error: 'User profile not found' });
      }

      _cacheSet(token, user, profile);
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
