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

module.exports = { fillDocx, convertDocxToPdf };
