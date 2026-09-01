// Fetch executed contract PDFs from SignWell and store them in our bucket.
//
// Why a job and not the webhook: SignWell's completed PDF isn't ready when
// document_completed fires, and an in-process retry doesn't survive Railway
// recycling the container. Why not fetch on read: that puts a SignWell
// download inside a client's page load, which gets worse with volume.

// Railway injects env vars directly; running this by hand needs .env loaded.
try { require('dotenv').config(); } catch(e){ /* not installed is fine */ }

const { supabaseAdmin } = require('../lib/supabase');
const { uploadFile } = require('../lib/storage');

const SIGNWELL_API = 'https://www.signwell.com/api/v1';
const SW_KEY = process.env.SIGNWELL_API_KEY;

// Don't chase contracts signed long ago that have never resolved — something
// else is wrong with those and retrying forever wastes calls.
const MAX_AGE_DAYS = 7;

async function run(){
  if(!SW_KEY){
    console.error('[job] SIGNWELL_API_KEY is not configured');
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString();

  const { data: pending, error } = await supabaseAdmin
    .from('contracts')
    .select('id, company_id, signwell_document_id, signed_at, signed_pdf_url')
    .eq('status', 'signed')
    .is('signed_pdf_url', null)
    .not('signwell_document_id', 'is', null)
    .gte('signed_at', cutoff);

  if(error){
    console.error('[job] could not load contracts:', error.message);
    process.exit(1);
  }

  if(!pending || !pending.length){
    console.log('[job] nothing to fetch');
    return;
  }

  console.log('[job] fetching executed PDFs for', pending.length, 'contract(s)');
  let stored = 0, notReady = 0, failed = 0;

  for(const c of pending){
    try {
      const r = await fetch(SIGNWELL_API + '/documents/' + c.signwell_document_id + '/completed_pdf', {
        headers: { 'X-Api-Key': SW_KEY },
      });
      if(!r.ok){
        notReady++;
        console.log('[job]', c.id, 'not ready:', r.status);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if(!buf.length){
        notReady++;
        console.log('[job]', c.id, 'empty response');
        continue;
      }

      const name = (c.company_id || 'company') + '/signed/' + c.id + '_signed.pdf';
      const path = await uploadFile('contracts', name, buf, 'application/pdf');

      // Store the PATH — signed on read, same as everywhere else.
      const { error: uErr } = await supabaseAdmin.from('contracts')
        .update({ signed_pdf_url: path }).eq('id', c.id);
      if(uErr){ failed++; console.error('[job]', c.id, 'update failed:', uErr.message); continue; }

      stored++;
      console.log('[job] stored', c.id);
    } catch(e){
      failed++;
      console.error('[job]', c.id, 'failed:', e && e.message);
    }
  }

  console.log('[job] done — stored', stored, '| not ready', notReady, '| failed', failed);
}

run()
  .then(function(){ process.exit(0); })
  .catch(function(e){ console.error('[job] fatal:', e); process.exit(1); });
