require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const TABLES = ['companies','users','projects','lot_groups','phases','budget_configs','budget_sections','budget_items','transactions','investments','gc_draws','selections','selection_images','selection_links','change_orders','contracts','lien_waivers','warranties','warranty_claims','contractor_payments','payment_draws','qc_submissions','messages','project_files','contractors','rfps','rfp_bids'];

async function test(){
  console.log('\n🔍 RezDev Connection Test');
  console.log('URL:', process.env.SUPABASE_URL);
  console.log('Service key set:', !!process.env.SUPABASE_SERVICE_KEY);
  console.log('Anon key set:', !!process.env.SUPABASE_ANON_KEY, '\n');

  let found=0, missing=0;
  for(const t of TABLES){
    const { error } = await supabaseAdmin.from(t).select('id').limit(1);
    const gone = error && (error.message.includes('not found') || error.code==='42P01');
    console.log(gone ? `  ✗ ${t} MISSING` : `  ✓ ${t}`);
    gone ? missing++ : found++;
  }

  console.log(`\n${found}/${TABLES.length} tables found`);
  const { data:u, error:ae } = await supabaseAdmin.auth.admin.listUsers({page:1,perPage:1});
  console.log(ae ? '⚠️  Auth: '+ae.message : '✅ Auth OK — users: '+(u.total_count??0));
  const { data:b } = await supabaseAdmin.storage.listBuckets();
  const bn=(b||[]).map(x=>x.name);
  ['project-files','selections','drive','contracts','avatars','logos'].forEach(x=>console.log((bn.includes(x)?'✓':'✗')+' bucket: '+x));
  console.log(missing===0?'\n✅ Ready! Run: npm run dev':'\n⚠️  Run schema SQL first');
}
test().catch(e=>console.error('Fatal:',e.message));
