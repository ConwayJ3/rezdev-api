const PDFDocument = require('pdfkit');

// Resolve {{merge_tags}} in a template body against a data object.
// Unknown tags are left as a visible blank line so nothing silently breaks.
function mergeTemplate(body, data){
  if(!body) return '';
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    const v = data[key];
    return (v === undefined || v === null || v === '') ? '__________' : String(v);
  });
}

// Build the merge-data object from project + company + extra fields.
function buildMergeData({ project, company, builder, client, extra }){
  const p = project || {};
  const cfg = (p.budget_configs && (Array.isArray(p.budget_configs) ? p.budget_configs[0] : p.budget_configs)) || {};
  const fmtMoney = n => (n || n===0) ? '$'+Number(n).toLocaleString('en-US') : '__________';
  const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  return Object.assign({
    client_name:     client?.name || p.client_name || '',
    client_email:    client?.email || '',
    project_address: p.address || '',
    project_city:    p.city || '',
    project_state:   p.state || '',
    project_name:    p.name || p.address || '',
    contract_price:  fmtMoney(cfg.total_budget),
    build_budget:    fmtMoney(cfg.build_budget),
    total_sqft:      p.total_sf || '',
    living_sqft:     p.livable_sf || '',
    beds:            p.beds || '',
    baths:           p.baths || '',
    builder_name:    builder?.name || '',
    company_name:    company?.name || '',
    company_phone:   company?.phone || '',
    company_address: company?.address || '',
    date:            today,
  }, extra || {});
}

// Generate a branded contract PDF buffer.
// opts: { title, bodyText, company, logoBuffer }
function generateContractPdf(opts){
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size:'LETTER', margins:{ top:72, bottom:72, left:72, right:72 } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const NAVY = '#0C2340';
      const TEAL = '#128995';

      // Header band
      doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
      if(opts.logoBuffer){
        try { doc.image(opts.logoBuffer, 72, 26, { fit:[120, 40] }); } catch(e){}
      }
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(18)
         .text(opts.company?.name || 'RezDev', 72, 34, { align: opts.logoBuffer ? 'right' : 'left' });
      doc.fillColor('#FFFFFF').font('Helvetica').fontSize(9)
         .text(opts.company?.address || '', 72, 58, { align:'right' });

      doc.moveDown(2);
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
         .text(opts.title || 'Construction Contract', 72, 120, { align:'center' });
      doc.moveTo(72, 150).lineTo(doc.page.width-72, 150).strokeColor(TEAL).lineWidth(2).stroke();

      // Body
      doc.moveDown(2);
      doc.fillColor('#1a1a1a').font('Helvetica').fontSize(10.5);
      const paragraphs = String(opts.bodyText || '').split(/\n{2,}/);
      paragraphs.forEach(para => {
        const trimmed = para.trim();
        if(!trimmed) return;
        // Lines in ALL CAPS or ending with ':' treated as headings
        const isHeading = /^[A-Z0-9 .,'\-&()]{4,}$/.test(trimmed) && trimmed.length < 60;
        if(isHeading){
          doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text(trimmed).moveDown(0.3);
          doc.font('Helvetica').fontSize(10.5).fillColor('#1a1a1a');
        } else {
          doc.text(trimmed, { align:'left', lineGap:2 }).moveDown(0.7);
        }
      });

      // Signature block
      doc.moveDown(3);
      const y = doc.y > 640 ? (doc.addPage(), 100) : doc.y;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Signatures', 72, y);
      doc.moveDown(1.5);
      const colW = (doc.page.width - 144 - 40) / 2;
      const sy = doc.y;
      // Lines drawn; SignWell will place actual signature fields over these regions
      doc.strokeColor('#888').lineWidth(1);
      doc.moveTo(72, sy+30).lineTo(72+colW, sy+30).stroke();
      doc.moveTo(72+colW+40, sy+30).lineTo(72+colW+40+colW, sy+30).stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      doc.text('Client Signature', 72, sy+34);
      doc.text('Builder Signature', 72+colW+40, sy+34);
      doc.text('Date', 72, sy+60);
      doc.text('Date', 72+colW+40, sy+60);

      doc.end();
    } catch(e){ reject(e); }
  });
}

module.exports = { mergeTemplate, buildMergeData, generateContractPdf };
