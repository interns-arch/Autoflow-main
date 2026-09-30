'use strict';
// PDFs the bot sends: a customer's ledger (to a sales agent) and the 6 pm
// report (to the Sales Heads). pdfkit, in-process — no browser in the image.
// The built-in fonts have no ₹, so money is written "Rs.".
const PDFDocument = require('pdfkit');

const COMPANY = 'M/S CARTREND AUTO PARTS PRIVATE LIMITED';

function rs(v) {
  const n = Number(v || 0);
  return (n < 0 ? '-' : '') + 'Rs.' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dmy(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// A table that wraps its cells and breaks onto new pages, repeating the
// header. cols: [{ label, width, align }]; rows: arrays of strings.
function table(doc, cols, rows, { fontSize = 8, header = true } = {}) {
  const x0 = doc.page.margins.left;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(fontSize);
    let x = x0;
    const y = doc.y;
    const h = Math.max(...cols.map((c) => doc.heightOfString(c.label, { width: c.width - 6 }))) + 6;
    doc.rect(x0, y, cols.reduce((s, c) => s + c.width, 0), h).fill('#e8eef7').fillColor('#000');
    for (const c of cols) {
      doc.text(c.label, x + 3, y + 3, { width: c.width - 6, align: c.align || 'left' });
      x += c.width;
    }
    doc.y = y + h;
    doc.font('Helvetica').fontSize(fontSize);
  };
  if (header) drawHeader();
  rows.forEach((r, i) => {
    const h = Math.max(...cols.map((c, j) => doc.heightOfString(String(r[j] == null ? '' : r[j]), { width: c.width - 6 }))) + 5;
    if (doc.y + h > bottom()) {
      doc.addPage();
      if (header) drawHeader();
    }
    const y = doc.y;
    if (r.bold) doc.font('Helvetica-Bold');
    if (i % 2 === 1) doc.rect(x0, y, cols.reduce((s, c) => s + c.width, 0), h).fill('#f7f7f7').fillColor('#000');
    let x = x0;
    cols.forEach((c, j) => {
      doc.text(String(r[j] == null ? '' : r[j]), x + 3, y + 2.5, { width: c.width - 6, align: c.align || 'left' });
      x += c.width;
    });
    if (r.bold) doc.font('Helvetica');
    doc.y = y + h;
  });
  doc.x = x0;
}

function heading(doc, title, sub) {
  doc.font('Helvetica-Bold').fontSize(13).text(COMPANY, { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(11).text(title, { align: 'center' });
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('#444').text(sub, { align: 'center' }).fillColor('#000');
  doc.moveDown(0.6);
}

// A customer's ledger. s = odoo.statement(); c = { name, phone, gst, address,
// portalId, creditLimit, collectionDays }.
async function ledgerPdf(s, c = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `Ledger — ${c.name || s.name}` } });
  heading(doc, 'CUSTOMER LEDGER', `${dmy(s.from)} to ${dmy(s.to)}`);
  doc.font('Helvetica-Bold').fontSize(10).text(c.name || s.name);
  doc.font('Helvetica').fontSize(9);
  const who = [
    c.phone ? 'Phone: ' + c.phone : null,
    c.gst ? 'GSTIN: ' + c.gst : null,
    c.portalId ? 'Account id: ' + c.portalId : null,
    c.creditLimit != null ? `Credit: ${rs(c.creditLimit)}${c.collectionDays ? ' / collection ' + c.collectionDays + ' days' : ''}` : null,
  ].filter(Boolean);
  if (who.length) doc.text(who.join('   ·   '));
  if (c.address) doc.text(c.address);
  doc.moveDown(0.5);

  const cols = [
    { label: 'Date', width: 58 },
    { label: 'Voucher', width: 100 },
    { label: 'Particulars', width: 150 },
    { label: 'Debit', width: 70, align: 'right' },
    { label: 'Credit', width: 70, align: 'right' },
    { label: 'Balance', width: 75, align: 'right' },
  ];
  const drcr = (v) => (Math.abs(v) < 0.005 ? rs(0) : rs(Math.abs(v)) + (v > 0 ? ' Dr' : ' Cr'));
  const rows = [Object.assign([dmy(s.from), '', 'Opening balance', '', '', drcr(s.opening)], { bold: true })];
  for (const l of s.lines) rows.push([dmy(l.date), l.voucher || '', l.particulars, l.debit ? rs(l.debit) : '', l.credit ? rs(l.credit) : '', drcr(l.balance)]);
  rows.push(Object.assign(['', '', 'Total', rs(s.debit), rs(s.credit), ''], { bold: true }));
  rows.push(Object.assign([dmy(s.to), '', 'Closing balance', '', '', drcr(s.closing)], { bold: true }));
  table(doc, cols, rows);
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(10).text(
    s.closing >= 1 ? `Amount due: ${rs(s.closing)}` : s.closing <= -1 ? `Advance / credit with us: ${rs(-s.closing)}` : 'Balance settled — nothing due.',
  );
  doc.font('Helvetica').fontSize(7).fillColor('#666').text(`From Odoo, as on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Dr = customer owes us; Cr = in the customer's favour.`);
  return toBuffer(doc);
}

// The 6 pm report. r = dailyApprovalReport.build().
async function reportPdf(r) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: `Daily report — ${r.ymd}` } });
  heading(doc, 'DAILY REPORT', dmy(r.ymd));
  doc.font('Helvetica').fontSize(9).text(String(r.summary || '').replace(/\*/g, '').replace(/^📊\s*/, '').split('\n').slice(1).join('   ·   '));
  doc.moveDown(0.6);
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

  doc.font('Helvetica-Bold').fontSize(10).text(`1. Customers created today (${r.created.length})`);
  doc.moveDown(0.2);
  table(
    doc,
    [
      { label: 'Time', width: 34 },
      { label: 'Customer', width: 95 },
      { label: 'WhatsApp', width: 62 },
      { label: 'GSTIN', width: 78 },
      { label: 'Business / contact', width: 85 },
      { label: 'Email', width: 88 },
      { label: 'Address', width: 105 },
      { label: 'DOB / bank', width: 75 },
      { label: 'Branch / login / Odoo', width: 65 },
      { label: 'Opened / approved by', width: 95 },
    ],
    r.created.length
      ? r.created.map((e) => [
          time(e.at),
          e.customer,
          e.phone,
          e.gst,
          [e.businessType, e.contactPerson].filter(Boolean).join(' · '),
          e.email,
          e.address,
          [e.dob, e.bank].filter(Boolean).join(' · '),
          [r.branchOf ? r.branchOf(e) : e.homeBranch, e.username, e.odooPartner ? 'Odoo ' + e.odooPartner : null].filter(Boolean).join(' · '),
          [e.openedBy || r.askedBy?.[e.id], e.by].filter(Boolean).join(' / '),
        ])
      : [['', 'None today']],
    { fontSize: 7 },
  );
  doc.moveDown(0.8);

  const total = r.sales.reduce((s, o) => s + o.amount, 0);
  doc.font('Helvetica-Bold').fontSize(10).text(`2. Sales today (${r.sales.length} order(s), ${rs(total)})`);
  doc.moveDown(0.2);
  table(
    doc,
    [
      { label: 'Time', width: 34 },
      { label: 'Order', width: 60 },
      { label: 'Portal order', width: 60 },
      { label: 'Customer', width: 120 },
      { label: 'WhatsApp', width: 70 },
      { label: 'Parts (part x qty @ rate)', width: 260 },
      { label: 'Qty', width: 30, align: 'right' },
      { label: 'Amount', width: 70, align: 'right' },
      { label: 'Approved by', width: 58 },
    ],
    r.sales.length
      ? r.sales.map((o) => [
          time(o.at),
          o.id,
          o.portalOrders,
          o.customer,
          o.phone,
          o.lines.map((l) => `${l.partNo} x${l.qty} @ ${l.rate}${l.discount ? ` (${l.discount}% off)` : ''}`).join('; '),
          o.qty,
          rs(o.amount),
          o.approvedBy,
        ])
      : [['', 'None today']],
    { fontSize: 7 },
  );
  doc.moveDown(0.8);

  doc.font('Helvetica-Bold').fontSize(10).text(`3. Approvals today (${r.events.length} event(s)${r.pending.length ? ', ' + r.pending.length + ' still waiting' : ''})`);
  doc.moveDown(0.2);
  table(
    doc,
    [
      { label: 'Time', width: 34 },
      { label: 'Type', width: 55 },
      { label: 'Request', width: 80 },
      { label: 'Event', width: 60 },
      { label: 'Customer', width: 130 },
      { label: 'Details', width: 283 },
      { label: 'By', width: 120 },
    ],
    r.events.length
      ? r.events.map((e) => [
          time(e.at),
          e.kind,
          e.id,
          r.pending.some((p) => p.kind === e.kind && p.id === e.id && p.at === e.at) ? 'waiting' : e.event,
          e.customer,
          e.kind === 'account' ? [e.gst, e.businessType].filter(Boolean).join(' · ') : e.detail || (e.amount ? rs(e.amount) : ''),
          e.by,
        ])
      : [['', '', 'None today']],
    { fontSize: 7 },
  );
  return toBuffer(doc);
}

module.exports = { ledgerPdf, reportPdf, rs };
