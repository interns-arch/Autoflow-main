'use strict';
// Accounts & Finance Bot — implementation Phase 4.
// Payment reminders + ledger dispatch run off the invoicesOutstanding table
// (populate it from the Dealer Portal or the console). Reconciliation against
// Dealer Portal records is wired through the portal adapter when the real
// API endpoints are shared.
const store = require('../store');
const { createTransport } = require('../wa/transport');

class FinanceBot {
  constructor() {
    this.key = 'finance';
    this.transport = createTransport(this.key);
  }

  async start() {
    this.transport.onMessage((m) => this.handleMessage(m));
    await this.transport.start();
  }

  async sendPaymentReminders() {
    const today = new Date().toISOString().slice(0, 10);
    const due = store.load().invoicesOutstanding.filter((i) => i.dueDate <= today && i.phone);
    for (const inv of due) {
      await this.transport.sendText(
        inv.phone,
        `Gentle reminder from Cartrends Accounts: payment of Rs.${inv.amount} for ${inv.customer} was due on ${inv.dueDate}. ` +
          `Kindly arrange payment, or reply STATEMENT for your ledger statement.`
      );
      inv.lastReminderAt = new Date().toISOString();
    }
    store.save();
    store.log(this.key, `payment reminders sent: ${due.length}`);
  }

  async handleMessage(m) {
    if (/^STATEMENT/i.test((m.body || '').trim())) {
      const rows = store.load().invoicesOutstanding.filter((i) => store.normPhone(i.phone) === m.from);
      const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      const body = rows.length
        ? `*Ledger statement*\n` + rows.map((r) => `${r.dueDate}  Rs.${r.amount}  (${r.customer})`).join('\n') + `\nOutstanding: Rs.${total}`
        : 'No outstanding entries on your ledger. Thank you!';
      return this.transport.sendToChat(m.chatId, body);
    }
  }
}

module.exports = FinanceBot;
