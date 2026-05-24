const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url        = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey    = process.env.SUPABASE_ANON_KEY;

if(!url || !serviceKey){ console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1); }

let wsTransport;
try { wsTransport = require('ws'); } catch(e) {}
const rtOpts = wsTransport ? { realtime: { transport: wsTransport } } : {};

const supabaseAdmin = createClient(url, serviceKey, { auth: { autoRefreshToken:false, persistSession:false }, ...rtOpts });

function supabaseForUser(accessToken){
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken:false, persistSession:false }, ...rtOpts
  });
}

module.exports = { supabaseAdmin, supabaseForUser };
