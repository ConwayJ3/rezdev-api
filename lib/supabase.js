const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey   = process.env.SUPABASE_ANON_KEY;

if(!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

// Service client — bypasses RLS, used only in server-side operations
// NEVER expose this key to the frontend
const supabaseAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Anon client factory — creates a client scoped to a specific user JWT
// RLS policies apply based on the user's role
function supabaseForUser(accessToken) {
  return createClient(url, anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` }
    },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

module.exports = { supabaseAdmin, supabaseForUser };
