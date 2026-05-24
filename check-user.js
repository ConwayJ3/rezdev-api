require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {auth:{autoRefreshToken:false,persistSession:false}});

async function run(){
  // Check all users in the table
  const { data, error } = await sb.from('users').select('*');
  console.log('All users:', JSON.stringify(data, null, 2));
  console.log('Error:', error?.message);
  
  // Also check auth users
  const { data: auth } = await sb.auth.admin.listUsers();
  console.log('Auth users:', auth.users.map(u => ({id: u.id, email: u.email})));
}
run().catch(console.error);
