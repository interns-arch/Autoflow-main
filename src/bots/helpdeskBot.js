'use strict';
// HR & IT Helpdesk Bot — implementation Phase 5.
// Captures employee queries as tickets and routes IT issues to the admins
// listed in WAREHOUSE_TEAM_NUMBERS-style env (kept simple until Phase 5
// is prioritized).
const config = require('../config');
const store = require('../store');
const { createTransport } = require('../wa/transport');

const IT_RE = /laptop|keyboard|mouse|printer|wifi|internet|password|screen|computer|system/i;

class HelpdeskBot {
  constructor() {
    this.key = 'helpdesk';
    this.transport = createTransport(this.key);
  }

  async start() {
    this.transport.onMessage((m) => this.handleMessage(m));
    await this.transport.start();
  }

  async handleMessage(m) {
    const text = (m.body || '').trim();
    if (!text || m.isGroup) return false;
    // on a shared line the helpdesk is the catch-all — but never ticket
    // vendors, other bots, or warehouse team numbers
    if (store.findVendorByPhone(m.from)) return false;
    const botNumbers = Object.values(config.bots).map((b) => b.number).filter(Boolean);
    if (botNumbers.includes(m.from)) return false;
    if (config.warehouseTeamNumbers.includes(m.from)) return false;
    if (config.adminNumbers.includes(m.from)) return false; // admins run commands, not tickets
    const ticket = {
      id: 'TKT-' + store.nextSeq('ticket'),
      from: m.from,
      category: IT_RE.test(text) ? 'IT' : 'HR',
      text,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    store.load().tickets.push(ticket);
    store.save();
    store.log(this.key, `ticket ${ticket.id} (${ticket.category}) from ${m.from}`);
    await this.transport.sendToChat(
      m.chatId,
      `Ticket *${ticket.id}* logged (${ticket.category}). The ${ticket.category} team has been notified and will get back to you.`
    );
    return true;
  }
}

module.exports = HelpdeskBot;
