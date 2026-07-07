const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

function fillDocx(docxBuffer, data){
  const zip = new PizZip(docxBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
    nullGetter: () => '',
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function convertDocxToPdf(docxBuffer, filename = 'contract.docx'){
  const key = process.env.CLOUDCONVERT_API_KEY;
  if(!key) throw new Error('CLOUDCONVERT_API_KEY is not configured');

  const CC = 'https://api.cloudconvert.com/v2';
  const headers = { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };

  const jobRes = await fetch(CC + '/jobs', {
    method: 'POST', headers,
    body: JSON.stringify({
      tasks: {
        'upload-docx':  { operation: 'import/upload' },
        'convert-pdf':  { operation: 'convert', input: 'upload-docx', input_format: 'docx', output_format: 'pdf' },
        'export-pdf':   { operation: 'export/url', input: 'convert-pdf' },
      },
    }),
  });
  const job = await jobRes.json();
  if(!jobRes.ok) throw new Error('CloudConvert job create failed: ' + JSON.stringify(job));

  const uploadTask = job.data.tasks.find(t => t.name === 'upload-docx');
  const form = uploadTask.result.form;
  const fd = new FormData();
  Object.entries(form.parameters).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', new Blob([docxBuffer]), filename);
  const upRes = await fetch(form.url, { method: 'POST', body: fd });
  if(!upRes.ok && upRes.status !== 201) throw new Error('CloudConvert upload failed: ' + upRes.status);

  const jobId = job.data.id;
  let exportTask = null;
  for(let i = 0; i < 40; i++){
    await new Promise(r => setTimeout(r, 1000));
    const statusRes = await fetch(CC + '/jobs/' + jobId, { headers });
    const status = await statusRes.json();
    if(status.data.status === 'finished'){
      exportTask = status.data.tasks.find(t => t.name === 'export-pdf');
      break;
    }
    if(status.data.status === 'error'){
      throw new Error('CloudConvert job errored: ' + JSON.stringify(status.data.tasks.filter(t=>t.status==='error')));
    }
  }
  if(!exportTask || !exportTask.result || !exportTask.result.files || !exportTask.result.files[0]){
    throw new Error('CloudConvert conversion timed out or produced no file');
  }

  const pdfUrl = exportTask.result.files[0].url;
  const pdfRes = await fetch(pdfUrl);
  if(!pdfRes.ok) throw new Error('Failed to download converted PDF');
  return Buffer.from(await pdfRes.arrayBuffer());
}

// Apply a list of { find, replace, all } rules into a DOCX buffer, preserving formatting.
// Handles Word splitting a phrase across multiple <w:t> runs by working on the
// concatenated text of each paragraph and redistributing.
// Returns the modified DOCX buffer.
function applyTagsToDocx(docxBuffer, rules){
  const zip = new PizZip(docxBuffer);
  const docXmlPath = 'word/document.xml';
  let xml = zip.file(docXmlPath).asText();

  // Track per-rule how many replacements remain (for "just this one" = 1)
  const state = rules.map(r => ({
    find: r.find,
    replace: '{{' + r.tag + '}}',
    remaining: r.all ? Infinity : (r.occurrence_count || 1),
  }));

  // Work paragraph by paragraph so run boundaries within a paragraph can be merged.
  // Match each <w:p>...</w:p> block.
  xml = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    // Extract the text runs (<w:t ...>text</w:t>) and their concatenated text
    const tMatches = [...paragraph.matchAll(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g)];
    if(!tMatches.length) return paragraph;
    let combined = tMatches.map(m => m[2]).join('');

    let changed = false;
    for(const s of state){
      if(s.remaining <= 0) continue;
      let idx;
      while(s.remaining > 0 && (idx = combined.indexOf(s.find)) !== -1){
        combined = combined.slice(0, idx) + s.replace + combined.slice(idx + s.find.length);
        s.remaining--;
        changed = true;
      }
    }
    if(!changed) return paragraph;

    // Put all combined text into the FIRST run, empty the rest (preserves the
    // first run's formatting for the whole paragraph's replaced text).
    let firstDone = false;
    let out = paragraph;
    let ti = 0;
    out = out.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (full, open, text, close) => {
      if(!firstDone){
        firstDone = true;
        // ensure xml:space preserve so leading/trailing spaces survive
        const openTag = /xml:space=/.test(open) ? open : open.replace(/>$/, ' xml:space="preserve">');
        return openTag + escapeXml(combined) + close;
      }
      return open + close; // empty subsequent runs
    });
    return out;
  });

  zip.file(docXmlPath, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(s){
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { fillDocx, convertDocxToPdf, applyTagsToDocx };
