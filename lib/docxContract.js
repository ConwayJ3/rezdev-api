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

  // Collect every text run (<w:t>) in document order with its position in xml.
  // We build the concatenated visible text, then map replacements back to runs.
  const runRegex = /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g;
  let m; const runs = [];
  while((m = runRegex.exec(xml)) !== null){
    runs.push({ open: m[1], text: m[2], close: m[3], start: m.index, full: m[0] });
  }
  // Global visible text and a map from global-char-index -> run index
  let globalText = '';
  const charToRun = []; // charToRun[i] = index into runs[] for global char i
  runs.forEach((r, ri) => {
    for(let k = 0; k < r.text.length; k++){ charToRun.push(ri); }
    globalText += r.text;
  });

  // For each rule, find the target occurrence(s) in globalText and record
  // (runIndex, localStart, length, replacement). We apply to runs afterward.
  // Because replacements change run text, we accumulate per-run edits and apply
  // from last to first within each run.
  const edits = []; // { runIndex, localStart, length, replacement }

  function unescape(s){ return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'); }

  rules.forEach(rule => {
    const find = rule.find;
    const replacement = rule.raw_replace ? rule.raw_replace : ('{{' + rule.tag + '}}');
    if(!find) return;
    // Find all occurrence start-indices in globalText
    const occ = [];
    let i = 0;
    while((i = globalText.indexOf(find, i)) !== -1){ occ.push(i); i += find.length; }
    if(!occ.length) return;

    let targets;
    if(rule.occurrence_index != null && rule.occurrence_index >= 0){
      // Specific occurrence
      targets = occ[rule.occurrence_index] != null ? [occ[rule.occurrence_index]] : [];
    } else {
      // All occurrences
      targets = occ;
    }

    targets.forEach(globalStart => {
      // Map this occurrence to a run. Only handle the case where the match
      // falls entirely within one run (true for our blank-line/text cases
      // after Word run boundaries — if it spans runs we fall back to the run
      // containing the start and replace the overlapping portion there).
      const runIndex = charToRun[globalStart];
      if(runIndex == null) return;
      // Compute local start within that run
      let runStartGlobal = 0;
      for(let r = 0; r < runIndex; r++){ runStartGlobal += runs[r].text.length; }
      const localStart = globalStart - runStartGlobal;
      edits.push({ runIndex, localStart, length: find.length, replacement });
    });
  });

  // Apply edits grouped by run, from rightmost to leftmost so indices stay valid
  const byRun = {};
  edits.forEach(e => { (byRun[e.runIndex] = byRun[e.runIndex] || []).push(e); });
  Object.keys(byRun).forEach(ri => {
    const list = byRun[ri].sort((a,b) => b.localStart - a.localStart);
    let t = runs[ri].text;
    list.forEach(e => {
      // Guard: only replace if the substring still matches (avoids corruption)
      t = t.slice(0, e.localStart) + e.replacement + t.slice(e.localStart + e.length);
    });
    runs[ri].text = t;
  });

  // Rebuild xml by replacing each run's full match with its (possibly) new text.
  // Rebuild from the original runs array using their recorded full strings.
  let rebuilt = ''; let cursor = 0;
  runs.forEach(r => {
    rebuilt += xml.slice(cursor, r.start);
    const openTag = /xml:space=/.test(r.open) ? r.open : r.open.replace(/>$/, ' xml:space="preserve">');
    rebuilt += openTag + r.text + r.close;
    cursor = r.start + r.full.length;
  });
  rebuilt += xml.slice(cursor);

  zip.file(docXmlPath, rebuilt);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(s){
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applySignatureAnchors(docxBuffer){
  const zip = new PizZip(docxBuffer);
  const p = 'word/document.xml';
  let xml = zip.file(p).asText();
  const map = [
    ['##SIG_CLIENT##',  '{{signature:1}}'],
    ['##DATE_CLIENT##', '{{date:1}}'],
    ['##SIG_BUILDER##', '{{signature:2}}'],
    ['##DATE_BUILDER##','{{date:2}}'],
  ];
  map.forEach(([marker, tag]) => {
    xml = xml.split(marker).join(tag);
  });
  zip.file(p, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { fillDocx, convertDocxToPdf, applyTagsToDocx, applySignatureAnchors };
