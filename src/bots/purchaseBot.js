'use strict';
// Purchase & Procurement Bot (Line 414) — spec Phases A and C.3/C.4.
//  Vendor side:  stock broadcast, stock ingestion, IVR follow-up with
//                dynamic suppression, PO placement + confirmation call,
//                hourly invoice chase, transit marking.
//  Internal side: listens on the bus for 'procure.request' from the
//                Customer Bot, and also understands mirrored #PROCURE
//                WhatsApp messages (so bots can run as separate processes).
const config = require('../config');
const store = require('../store');
const bus = require('../bus');
const ai = require('../core/ai');
const procurement = require('../core/procurement');
const ivr = require('../integrations/ivr');
const { createTransport } = require('../wa/transport');

const STOCK_REQUEST_MSG =
  'Good day! This is the Cartrends purchase desk. ' +
  'Please share your *current stock list* (item, quantity, price per line) so we can place today\'s orders. Thank you!';

const VEHICLE_RE = /\b([A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{3,4})\b/i;

class PurchaseBot {
  constructor() {
    this.key = 'purchase';
    this.transport = createTransport(this.key);
  }

  async start() {
    this.transport.onMessage((m) => this.handleMessage(m));
    bus.on('procure.request', (req) => this.handleProcureRequest(req));
    await this.transport.start();
  }

  // ---------- Phase A: stock aggregation ----------

  async broadcastStockRequest() {
    const vendors = store.vendors();
    if (!vendors.length) {
      store.log(this.key, 'stock broadcast skipped — no vendors registered yet (add them in the console)');
      return;
    }
    const now = new Date().toISOString();
    for (const v of vendors) {
      if (!v.phone) continue;
      await this.transport.sendText(v.phone, STOCK_REQUEST_MSG);
      v.lastRequestAt = now;
    }
    store.save();
    store.log(this.key, `stock request broadcast sent to ${vendors.length} vendor(s)`);
  }

  // vendors who have NOT sent stock since the last broadcast get a voice call
  async ivrFollowupNonResponders() {
    const pending = store.vendors().filter((v) => {
      if (!v.phone || !v.lastRequestAt) return false;
      return !v.lastStockAt || v.lastStockAt < v.lastRequestAt; // dynamic suppression
    });
    if (!pending.length) {
      store.log(this.key, 'IVR follow-up: all vendors have submitted stock — no calls needed');
      return;
    }
    for (const v of pending) {
      await ivr.call(
        v.phone,
        `Hello, this is an automated call from Cartrends purchase team. We are awaiting your stock list on WhatsApp. Please send it at the earliest. Thank you.`,
        'stock follow-up: ' + v.name
      );
    }
    store.log(this.key, `IVR follow-up calls placed to ${pending.length} non-responding vendor(s)`);
  }

  // ---------- Phase C: procurement ----------

  async handleProcureRequest(req) {
    const po = procurement.createFromRequest(req);
    const vendor = store.vendors().find((v) => v.id === req.vendorId);
    if (!vendor || !vendor.phone) {
      store.log(this.key, `${po.id}: vendor ${req.vendorName} has no phone on record — PO held`);
      return;
    }
    await this.transport.sendText(vendor.phone, procurement.poMessage(po));
    await ivr.call(
      vendor.phone,
      `Hello, this is Cartrends. An order has been placed with you on WhatsApp. Please confirm it and generate and issue the invoice. Thank you.`,
      'PO confirmation: ' + po.id
    );
    store.log(this.key, `${po.id} sent to vendor ${vendor.name} — awaiting their confirmation`);
  }

  // "har ek ghante mein vendor ko call karega jab tak bill na aaye" —
  // hourly WhatsApp reminder AND an automated voice call until the bill arrives
  async chasePendingInvoices() {
    const pending = procurement.pendingInvoiceChase();
    for (const po of pending) {
      const vendor = store.vendors().find((v) => v.id === po.vendorId);
      if (!vendor || !vendor.phone) continue;
      po.chaseCount += 1;
      await this.transport.sendText(
        vendor.phone,
        `Reminder from Cartrends: invoice/bill for *${po.poNumber || po.id}* is still pending. Please send the bill here so we can process it. (reminder #${po.chaseCount})`
      );
      await ivr.call(
        vendor.phone,
        `Hello, this is Cartrends. The bill for your order is still pending. Please send the bill on WhatsApp at the earliest. Thank you.`,
        'invoice chase: ' + (po.poNumber || po.id)
      );
    }
    if (pending.length) {
      store.save();
      store.log(this.key, `invoice chase: reminded ${pending.length} vendor(s)`);
    }
  }

  // ---------- inbound messages ----------

  async handleMessage(m) {
    if (m.isGroup) return false; // 414 is vendor-DM centric

    // mirrored inter-bot command from the Customer Bot
    if (config.bots.customer.number && m.from === config.bots.customer.number && /^#PROCURE/i.test(m.body)) {
      await this.handleMirroredProcure(m.body);
      return true;
    }

    const vendor = store.findVendorByPhone(m.from);
    if (!vendor) return false; // not a vendor — another role on a shared line may claim it

    const text = (m.body || '').trim();
    const openPo = procurement.openPoForVendor(vendor.id);

    // 1) PO confirmation
    if (openPo && openPo.status === procurement.STATUS.AWAITING_VENDOR_CONFIRM && ai.CONFIRM_RE.test(text)) {
      await procurement.vendorConfirmed(openPo);
      await this.transport.sendText(
        vendor.phone,
        `Thank you! Order confirmed — *${openPo.poNumber}*. Please generate the invoice/bill and send it here. Kindly include the vehicle number once goods are dispatched.`
      );
      return true;
    }

    // 2) invoice / bill (media or text mentioning bill) for a placed PO
    if (openPo && openPo.status === procurement.STATUS.PLACED && (m.hasMedia || /\b(bill|invoice)\b/i.test(text))) {
      const invoiceLines = ai.parseLinesBlock(text);
      const issues = await procurement.invoiceReceived(openPo, {
        via: m.hasMedia ? 'media' : 'text',
        text,
        lines: invoiceLines,
      });
      if (issues.length) {
        await this.transport.sendText(
          vendor.phone,
          `We received the bill for *${openPo.poNumber}*, but found mismatches:\n- ${issues.join('\n- ')}\nPlease verify and resend the corrected bill.`
        );
        return true;
      }
      await this.transport.sendText(vendor.phone, `Bill received and uploaded for *${openPo.poNumber}*. Please share the vehicle number and expected delivery time for dispatch.`);
      const vehicle = text.match(VEHICLE_RE);
      await procurement.markInTransit(openPo, { vehicle: vehicle ? vehicle[1].toUpperCase() : null, note: 'auto from invoice message' });
      return true;
    }

    // 3) vehicle details after invoice -> transit metadata update
    const vehicleMatch = text.match(VEHICLE_RE);
    if (vehicleMatch) {
      const transitPo = [...store.pos()].reverse().find(
        (p) => p.vendorId === vendor.id && [procurement.STATUS.INVOICED, procurement.STATUS.IN_TRANSIT].includes(p.status)
      );
      if (transitPo) {
        if (transitPo.status === procurement.STATUS.IN_TRANSIT) {
          transitPo.transit.vehicle = vehicleMatch[1].toUpperCase();
          store.save();
          bus.emit('po.transit', { po: transitPo }); // re-alert warehouse with the real vehicle no.
        } else {
          await procurement.markInTransit(transitPo, { vehicle: vehicleMatch[1].toUpperCase() });
        }
        await this.transport.sendText(vendor.phone, `Noted — vehicle ${vehicleMatch[1].toUpperCase()} recorded. Our warehouse team has been alerted for inbound receiving.`);
        return true;
      }
    }

    // 4) otherwise: try to parse as a stock list (Phase A ingestion)
    const lines = await ai.parseVendorStock(text);
    if (lines.length) {
      store.setVendorStock(vendor.id, lines);
      await this.transport.sendText(
        vendor.phone,
        `Thank you! Stock list received — ${lines.length} item(s) recorded. You will not receive further follow-up calls today.`
      );
      store.log(this.key, `stock list from ${vendor.name}: ${lines.length} items (IVR suppressed)`);
      return true;
    }
    return false;
  }

  // "#PROCURE SO-123 | VENDOR: Northend | Brake Pad x 5 | Oil Filter x 2"
  async handleMirroredProcure(body) {
    const parts = body.split('|').map((s) => s.trim());
    const soNumber = (parts[0].match(/#PROCURE\s+(\S+)/i) || [])[1] || null;
    const vendorName = ((parts.find((p) => /^VENDOR:/i.test(p)) || '').split(':')[1] || '').trim();
    const vendor = store.findVendorByName(vendorName);
    if (!vendor) return;
    // dedupe: bus event already created this PO in single-process mode
    const dup = store.pos().find((p) => p.soNumber === soNumber && p.vendorId === vendor.id);
    if (dup) return;
    const lines = parts
      .filter((p) => /x\s*\d+/i.test(p) && !/^VENDOR:/i.test(p) && !/^#PROCURE/i.test(p))
      .map((p) => {
        const mm = p.match(/^(.+?)\s*x\s*(\d+)$/i);
        return mm ? { item: mm[1].trim(), qty: parseInt(mm[2], 10), price: null } : null;
      })
      .filter(Boolean);
    if (lines.length) {
      await this.handleProcureRequest({ soNumber, vendorId: vendor.id, vendorName: vendor.name, lines });
    }
  }
}

module.exports = PurchaseBot;
