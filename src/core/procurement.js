'use strict';
// Purchase Order lifecycle (spec Phase C.3/C.4), driven by the Purchase Bot:
//   procure.request  -> PO created, order placed with vendor on WhatsApp
//                       + automated confirmation call
//   vendor "yes"     -> PO punched into Dealer Portal
//   hourly chase     -> WhatsApp reminder until the bill/invoice arrives
//   invoice received -> uploaded + validated against PO -> 'In Transit'
//                       -> warehouse inbound alert with vehicle details
const store = require('../store');
const portal = require('../integrations/dealerPortal');
const bus = require('../bus');

const STATUS = {
  AWAITING_VENDOR_CONFIRM: 'awaiting_vendor_confirm',
  PLACED: 'placed', // punched in portal, waiting for invoice
  INVOICED: 'invoiced',
  IN_TRANSIT: 'in_transit',
  RECEIVED: 'received',
};

function createFromRequest(req) {
  const po = {
    id: 'REQ-' + store.nextSeq('po'),
    poNumber: null,
    soNumber: req.soNumber || null,
    orderId: req.orderId || null,
    vendorId: req.vendorId,
    vendorName: req.vendorName,
    lines: req.lines,
    status: STATUS.AWAITING_VENDOR_CONFIRM,
    invoice: null,
    transit: null,
    chaseCount: 0,
    createdAt: new Date().toISOString(),
  };
  store.pos().push(po);
  store.save();
  return po;
}

function openPoForVendor(vendorId) {
  // newest PO for this vendor that is still moving through the pipeline
  const list = store.pos().filter(
    (p) => p.vendorId === vendorId && [STATUS.AWAITING_VENDOR_CONFIRM, STATUS.PLACED].includes(p.status)
  );
  return list[list.length - 1] || null;
}

async function vendorConfirmed(po) {
  const { poNumber } = await portal.createPurchaseOrder({
    vendorId: po.vendorId,
    vendorName: po.vendorName,
    soNumber: po.soNumber,
    lines: po.lines,
  });
  po.poNumber = poNumber;
  po.status = STATUS.PLACED;
  po.placedAt = new Date().toISOString();
  store.save();
  store.log('procure', `${po.id} vendor confirmed -> ${poNumber} punched in Dealer Portal; awaiting invoice`);
  return po;
}

// Validate invoice lines against the PO (item/qty). Returns list of mismatches.
function validateInvoice(po, invoiceLines) {
  const issues = [];
  if (!invoiceLines || !invoiceLines.length) return issues; // media-only invoice, no OCR yet
  for (const inv of invoiceLines) {
    const match = po.lines.find((l) => l.item.toLowerCase() === String(inv.item).toLowerCase());
    if (!match) issues.push(`invoice item "${inv.item}" not on PO`);
    else if (Number(inv.qty) !== Number(match.qty)) issues.push(`${inv.item}: invoice qty ${inv.qty} vs PO qty ${match.qty}`);
  }
  return issues;
}

async function invoiceReceived(po, invoice) {
  po.invoice = { ...invoice, receivedAt: new Date().toISOString() };
  po.status = STATUS.INVOICED;
  const issues = validateInvoice(po, invoice.lines);
  po.invoice.validationIssues = issues;
  await portal.uploadInvoice(po.poNumber || po.id, po.invoice);
  store.save();
  store.log('procure', `${po.poNumber || po.id} invoice received${issues.length ? ' with ISSUES: ' + issues.join('; ') : ' (validated OK)'}`);
  return issues;
}

async function markInTransit(po, transit) {
  po.transit = { ...transit, at: new Date().toISOString() };
  po.status = STATUS.IN_TRANSIT;
  await portal.markInTransit(po.poNumber || po.id, po.transit);
  store.save();
  bus.emit('po.transit', { po });
  store.log('procure', `${po.poNumber || po.id} marked IN TRANSIT (vehicle ${transit.vehicle || 'n/a'}) — warehouse inbound alerted`);
}

// POs placed but not yet invoiced — targets of the hourly chase.
function pendingInvoiceChase() {
  return store.pos().filter((p) => p.status === STATUS.PLACED);
}

function poMessage(po) {
  const lines = po.lines.map((l, i) => `${i + 1}. ${l.item} x ${l.qty}` + (l.price ? ` @ Rs.${l.price}` : '')).join('\n');
  return (
    `*New Purchase Order from Cartrends*${po.soNumber ? ` (against ${po.soNumber})` : ''}\n` +
    `${lines}\n\n` +
    `Please confirm this order, and send the bill here once it is ready.`
  );
}

module.exports = {
  STATUS,
  createFromRequest,
  openPoForVendor,
  vendorConfirmed,
  invoiceReceived,
  markInTransit,
  pendingInvoiceChase,
  poMessage,
  validateInvoice,
};
