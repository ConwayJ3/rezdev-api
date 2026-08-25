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
// Names of the footer parts in a DOCX, in document order.
function footerPartNames(zip){
  return Object.keys(zip.files)
    .filter(function(n){ return /^word\/footer\d*\.xml$/.test(n); })
    .sort();
}

// Visible text of a footer part. Paragraphs are joined with newlines; runs
// within a paragraph are concatenated exactly as applyRulesToXml sees them,
// so occurrence COUNTS line up between the editor and the applier.
function xmlToVisibleText(xml){
  const paras = xml.split(/<w:p[ >]/).slice(1);
  const out = [];
  paras.forEach(function(p){
    let t = '', m;
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    while((m = re.exec(p)) !== null){ t += m[1]; }
    t = t.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    if(t.length) out.push(t);
  });
  return out.join('\n');
}

// Footer text for the tagging editor. mammoth.extractRawText cannot see this.
function extractFooterText(docxBuffer){
  const zip = new PizZip(docxBuffer);
  const names = footerPartNames(zip);
  const nonEmpty = [];
  names.forEach(function(n){
    const entry = zip.file(n);
    if(!entry) return;
    const text = xmlToVisibleText(entry.asText());
    if(text.trim().length) nonEmpty.push({ name: n, text: text });
  });
  return {
    text: nonEmpty.length ? nonEmpty[0].text : '',
    parts: nonEmpty.length,
  };
}

// The run-mapping core, extracted so it can run against any XML part.
// Handles Word splitting a phrase across multiple <w:t> runs by working on the
// concatenated text and redistributing.
function applyRulesToXml(xml, rules){
  const runRegex = /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g;
  let m; const runs = [];
  while((m = runRegex.exec(xml)) !== null){
    runs.push({ open: m[1], text: m[2], close: m[3], start: m.index, full: m[0] });
  }

  // Flattened text across all runs, plus where each run begins in it.
  let globalText = '';
  const runStarts = [];
  runs.forEach(function(r){
    runStarts.push(globalText.length);
    globalText += r.text;
  });

  // Which run contains a given global offset.
  function runAt(offset){
    for(let k = runs.length - 1; k >= 0; k--){
      if(offset >= runStarts[k]) return k;
    }
    return 0;
  }

  // A match may span several runs — Word splits text unpredictably. Record an
  // edit per affected run: the replacement goes in the first, and the matched
  // portion is CUT from each later one. Missing that cut was the old bug.
  const edits = [];   // { runIndex, start, end, insert }

  rules.forEach(function(rule){
    const find = (rule.find || '').replace(/^\s+|\s+$/g, '');
    const replacement = rule.raw_replace ? rule.raw_replace : ('{{' + rule.tag + '}}');
    if(!find) return;

    const occ = [];
    let i2 = 0;
    while((i2 = globalText.indexOf(find, i2)) !== -1){ occ.push(i2); i2 += find.length; }
    if(!occ.length) return;

    let targets;
    if(rule.occurrence_index != null && rule.occurrence_index >= 0){
      targets = occ[rule.occurrence_index] != null ? [occ[rule.occurrence_index]] : [];
    } else {
      targets = occ;
    }

    targets.forEach(function(globalStart){
      const globalEnd = globalStart + find.length;   // exclusive
      const firstRun = runAt(globalStart);
      const lastRun  = runAt(globalEnd - 1);

      for(let ri = firstRun; ri <= lastRun; ri++){
        const runStart = runStarts[ri];
        const runEnd   = runStart + runs[ri].text.length;
        const cutFrom  = Math.max(globalStart, runStart) - runStart;
        const cutTo    = Math.min(globalEnd, runEnd) - runStart;
        if(cutTo <= cutFrom) continue;
        edits.push({
          runIndex: ri,
          start: cutFrom,
          end: cutTo,
          // Only the first run receives the replacement text; the rest are
          // pure deletions of the leftover match.
          insert: (ri === firstRun) ? replacement : '',
        });
      }
    });
  });

  // Apply per run, rightmost first, so earlier offsets stay valid.
  const byRun = {};
  edits.forEach(function(e){ (byRun[e.runIndex] = byRun[e.runIndex] || []).push(e); });
  Object.keys(byRun).forEach(function(ri){
    const list = byRun[ri].sort(function(a,b){ return b.start - a.start; });
    let t = runs[ri].text;
    list.forEach(function(e){
      t = t.slice(0, e.start) + e.insert + t.slice(e.end);
    });
    runs[ri].text = t;
  });

  let rebuilt = ''; let cursor = 0;
  runs.forEach(function(r){
    rebuilt += xml.slice(cursor, r.start);
    const openTag = /xml:space=/.test(r.open) ? r.open : r.open.replace(/>$/, ' xml:space="preserve">');
    rebuilt += openTag + r.text + r.close;
    cursor = r.start + r.full.length;
  });
  rebuilt += xml.slice(cursor);
  return rebuilt;
}

// Marker so the patch script can tell this version is applied: spansRuns

// Apply tag rules into a DOCX, routing each rule to the part it was placed in.
// Rules without `part` are body rules — that's every rule saved before footer
// tagging existed, so they keep working untouched.
function applyTagsToDocx(docxBuffer, rules){
  const zip = new PizZip(docxBuffer);
  const all = Array.isArray(rules) ? rules : [];
  const bodyRules   = all.filter(function(r){ return (r.part || 'body') === 'body'; });
  const footerRules = all.filter(function(r){ return r.part === 'footer'; });

  if(bodyRules.length){
    const p = 'word/document.xml';
    const entry = zip.file(p);
    if(entry) zip.file(p, applyRulesToXml(entry.asText(), bodyRules));
  }

  if(footerRules.length){
    // Primary footer only — see LIMIT note. The editor warns when parts > 1.
    const names = footerPartNames(zip);
    for(let i = 0; i < names.length; i++){
      const entry = zip.file(names[i]);
      if(!entry) continue;
      if(!xmlToVisibleText(entry.asText()).trim().length) continue;
      zip.file(names[i], applyRulesToXml(entry.asText(), footerRules));
      break;
    }
  }

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(s){
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function applySignatureAnchors(docxBuffer, hasClient2){
  const zip = new PizZip(docxBuffer);

  // SignWell assigns each {{signature:N}} / {{initial:N}} to the Nth recipient by
  // POSITION (not id). Recipients are sent in order: Client 1 (pos 1),
  // [Client 2 (pos 2) if present], Builder (last). So the builder is position 2
  // when solo, position 3 with a co-signer.
  const builderPos = hasClient2 ? '3' : '2';

  const map = [
    ['##SIG_CLIENT##',   '{{signature:1}}'],
    ['##DATE_CLIENT##',  '{{date:1}}'],
    ['##INIT_CLIENT##',  '{{initial:1}}'],
    ['##SIG_CLIENT2##',  '{{signature:2}}'],
    ['##DATE_CLIENT2##', '{{date:2}}'],
    ['##INIT_CLIENT2##', '{{initial:2}}'],
    ['##SIG_BUILDER##',  '{{signature:'+builderPos+'}}'],
    ['##DATE_BUILDER##', '{{date:'+builderPos+'}}'],
    ['##INIT_BUILDER##', '{{initial:'+builderPos+'}}'],
  ];

  // Headers and footers live in their OWN xml parts. A footer repeats on every
  // page of the converted PDF, so a marker there yields one field per page —
  // which is how per-page initials work without page counting or coordinates.
  const parts = Object.keys(zip.files).filter(function(name){
    return /^word\/(document|header\d*|footer\d*)\.xml$/.test(name);
  });

  parts.forEach(function(p){
    const entry = zip.file(p);
    if(!entry) return;
    let xml = entry.asText();
    if(xml.indexOf('##') === -1) return;   // nothing to do in this part

    // No co-signer: strip Client 2 markers entirely; builder moves to position 2.
    if(!hasClient2){
      ['##SIG_CLIENT2##','##DATE_CLIENT2##','##INIT_CLIENT2##'].forEach(function(marker){
        xml = xml.split(marker).join('');
      });
    }

    // Replace each marker with a self-contained WHITE run holding just the tag, so
    // SignWell places the field at the tag but the tag text is invisible — WITHOUT
    // affecting any surrounding label text (e.g. "Owner Signature", "Date").
    // We close the current run before the tag, insert a white run, then reopen a run.
    map.forEach(function(pair){
      const marker = pair[0], tag = pair[1];
      const whiteRun = '</w:t></w:r><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">'
                     + tag
                     + '</w:t></w:r><w:r><w:t xml:space="preserve">';
      xml = xml.split(marker).join(whiteRun);
    });

    zip.file(p, xml);
  });

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { fillDocx, convertDocxToPdf, applyTagsToDocx, applySignatureAnchors, extractFooterText };
