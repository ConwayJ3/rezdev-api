require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {auth:{autoRefreshToken:false,persistSession:false}});
async function run(){
  const { data, error } = await sb.auth.signInWithPassword({ email: 'conway@vertexdevs.com', password: 'Test1234!' });
  if(error){ console.log('Login error:', error.message); return; }
  console.log('Auth OK, id:', data.user.id);
  const { data: profile, error: pe } = await sb.from('users').select('*').eq('id', data.user.id).single();
  console.log('Profile:', JSON.stringify(profile));
  console.log('Profile error:', pe?.message);
}
run().catch(console.error);
