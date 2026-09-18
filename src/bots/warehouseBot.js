'use strict';
// Warehouse Manager & Dispatch Bot — spec Phase D (implementation Phase 3).
// Active today: inbound transit alerts (fed by the Purchase Bot pipeline)
// and DO-confirmed picklist generation + picker assignment via WhatsApp.
// GRN verification stays human by design — the bot only alerts the team.
const config = require('../config');
const store = require('../store');
const bus = require('../bus');
const portal = require('../integrations/dealerPortal');
const { createTransport } = require('../wa/transport');

class WarehouseBot {
  constructor() {
    this.key = 'warehouse';
    this.transport = createTransport(this.key);
    this.pickers = []; // registered via console or "REGISTER PICKER" message
  }

  async start() {
    this.transport.onMessage((m) => this.handleMessage(m));
    bus.on('po.transit', ({ po }) => this.inboundAlert(po));
    await this.transport.start();
  }

  // vendor goods on the road -> alert inbound/GRN team
  async inboundAlert(po) {
    const msg =
      `🚚 *Inbound — ${po.poNumber || po.id} In Transit*\n` +
      `Vendor: ${po.vendorName}\n` +
      po.lines.map((l, i) => `${i + 1}. ${l.item} x ${l.qty}`).join('\n') +
      `\nVehicle: ${(po.transit && po.transit.vehicle) || 'to be shared'}\n` +
      `Prepare for unloading and GRN verification on arrival.`;
    if (!config.warehouseTeamNumbers.length) {
      store.log(this.key, `inbound alert (no WAREHOUSE_TEAM_NUMBERS yet):\n${msg}`);
      return;
    }
    for (const n of config.warehouseTeamNumbers) await this.transport.sendText(n, msg);
  }

  // Phase 3: called when Dealer Portal marks an order "DO Confirmed"
  // (wire to a portal webhook, or trigger from the console / a WhatsApp command)
  async onDoConfirmed(soNumber) {
    const { lines } = await portal.getPicklist(soNumber);
    if (!lines.length) {
      store.log(this.key, `DO ${soNumber}: no picklist lines found`);
      return;
    }
    const picklist = {
      id: 'PL-' + Date.now(),
      soNumber,
      lines,
      picker: this.pickers[0] || null,
      status: 'assigned',
      createdAt: new Date().toISOString(),
    };
    store.load().picklists.push(picklist);
    store.save();

    const msg =
      `🧾 *Picklist — ${soNumber}*\n` +
      lines.map((l, i) => `${i + 1}. ${l.item} x ${l.qty}  (shelf ${l.shelf})`).join('\n') +
      `\nPick and stage for dispatch. Reply DONE ${soNumber} when completed.`;
    const targets = picklist.picker ? [picklist.picker] : config.warehouseTeamNumbers;
    for (const n of targets) await this.transport.sendText(n, msg);
    store.log(this.key, `picklist for ${soNumber} sent to ${targets.length ? targets.join(', ') : 'nobody (configure pickers)'}`);
  }

  async handleMessage(m) {
    const text = (m.body || '').trim();
    let mm = text.match(/^REGISTER PICKER/i);
    if (mm) {
      if (!this.pickers.includes(m.from)) this.pickers.push(m.from);
      await this.transport.sendToChat(m.chatId, 'Registered as picker. You will receive picklists here.');
      return true;
    }
    mm = text.match(/^DONE\s+(\S+)/i);
    if (mm) {
      const pl = store.load().picklists.find((p) => p.soNumber === mm[1]);
      if (pl) {
        pl.status = 'picked';
        store.save();
        await this.transport.sendToChat(m.chatId, `Noted — ${mm[1]} marked picked. Dispatch team will take it from here.`);
        return true;
      }
    }
    mm = text.match(/^DO\s+(\S+)/i); // manual trigger: "DO SO-20001"
    if (mm) {
      await this.onDoConfirmed(mm[1]);
      return true;
    }
    return false;
  }
}

module.exports = WarehouseBot;
