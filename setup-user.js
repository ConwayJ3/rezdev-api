require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {auth:{autoRefreshToken:false,persistSession:false}});

async function run(){
  const { data: users } = await sb.auth.admin.listUsers();
  const u = users.users.find(x => x.email === 'conway@vertexdevs.com');
  console.log('Auth user id:', u?.id);

  const { data: co } = await sb.from('companies').select('id').limit(1).single();
  console.log('Company id:', co?.id);

  if(!u || !co){ console.log('Missing user or company'); return; }

  const { data, error } = await sb.from('users').insert({
    id: u.id,
    company_id: co.id,
    first_name: 'Conway',
    last_name: 'Johnson',
    email: 'conway@vertexdevs.com',
    role: 'owner',
    status: 'active'
  }).select().single();

  console.log(error ? 'Error: ' + error.message : 'Profile created: ' + data.id);
}
run().catch(console.error);
