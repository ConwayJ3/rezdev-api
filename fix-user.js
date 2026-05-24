require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {auth:{autoRefreshToken:false,persistSession:false}});

async function run(){
  // Fix the email case on the vertexdevs user
  const { data, error } = await sb.from('users')
    .update({ email: 'conway@vertexdevs.com' })
    .eq('id', 'a58eee42-cccc-42f8-b971-22788aa37b75')
    .select().single();
  console.log(error ? 'Error: '+error.message : 'Fixed: '+data.email);
}
run().catch(console.error);
