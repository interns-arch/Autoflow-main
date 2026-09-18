'use strict';
// Admin over WhatsApp — no UI needed. Numbers in ADMIN_NUMBERS can message
// any bot line and run commands; a daily ops report is pushed to them at
// DAILY_REPORT_TIME.
//
// Commands (DM only, case-insensitive):
//   REPORT                      operations report
//   LOSS [days]                 sale loss — what we said NO to (default 1 day)
//   ORDERS                      recent sales orders
//   LEARN <phrase> = <part no>  teach a part permanently
//   KNOWN                       what the bot has learned so far
//   CUSTOMER ADD <name>, <phone>
//   OFFER <text>                broadcast an offer to all customers
//   CN <phone> <amount> <reason>
//   HELP
//
// Parked-bot commands (only with ENABLE_EXTRA_BOTS=true):
//   STOCK · POS · VENDOR ADD name, phone · STOCKREQ · CHASE
const config = require('../config');
const store = require('../store');
const inquiries = require('./inquiries');
const knowledge = require('./knowledge');

function isAdmin(from) {
  return config.adminNumbers.includes(from);
}

function report() {
  const s = store.load();
  const orders = s.orders.filter((o) => o.status === 'confirmed');
  const drafts = s.orders.filter((o) => o.status === 'draft');
  const lost = inquiries.lostSales(1);
  const portal = require('../integrations/dealerPortal');
  const learned = Object.keys(knowledge.all().aliases).length;

  let msg =
    `📊 *Cartrends AutoFlow — Ops Report*\n` +
    `Sales orders: ${orders.length} confirmed, ${drafts.length} draft\n` +
    `Customers: ${s.customers.length} | Learned parts: ${learned}\n` +
    `Dealer Portal: ${portal.isMock ? '⚠️ MOCK (not connected)' : 'connected'}\n` +
    `Sale loss today: ${lost.length} part(s) we could not supply\n`;
  if (lost.length) {
    msg += lost
      .slice(0, 5)
      .map((r) => `  • ${r.item} — ${r.customers} customer(s), ${r.requests} request(s)`)
      .join('\n');
    msg += `\nReply LOSS 7 for the week.\n`;
  }
  if (config.enableExtraBots) {
    const poOpen = s.pos.filter((p) => p.status !== 'received');
    msg += `POs open: ${poOpen.length} | Tickets open: ${s.tickets.filter((t) => t.status === 'open').length}\n`;
  }
  return msg + `Reply HELP for all commands.`;
}

function ordersSummary() {
  const rows = [...store.orders()].reverse().slice(0, 10);
  if (!rows.length) return 'No orders yet.';
  return rows
    .map((o) => `${o.soNumber || o.id} [${o.status}] ${o.lines.map((l) => `${l.requested || l.item} x ${l.qty}`).join(', ')}`)
    .join('\n');
}

function knownSummary() {
  const aliases = knowledge.all().aliases;
  const keys = Object.keys(aliases);
  if (!keys.length) return 'Nothing learned yet. Teach me with: LEARN <phrase> = <part number>';
  return (
    `*Learned parts (${keys.length}):*\n` +
    keys
      .slice(-25)
      .map((k) => `  ${k} → ${aliases[k].partNo}${aliases[k].hits ? ` (used ${aliases[k].hits}x)` : ''}`)
      .join('\n')
  );
}

const HELP =
  'Admin commands:\n' +
  'REPORT · LOSS [days] · ORDERS · KNOWN · HELP\n' +
  'LEARN <phrase> = <part no>\n' +
  'CUSTOMER ADD name, phone\n' +
  'OFFER <message>\n' +
  'CN <phone> <amount> <reason>';

function attach(bots) {
  const transports = new Set(Object.values(bots).map((b) => b.transport));
  for (const transport of transports) {
    transport.onMessage(async (m) => {
      if (m.isGroup || !isAdmin(m.from)) return false;
      const text = (m.body || '').trim();
      const send = async (t) => {
        await transport.sendToChat(m.chatId, t);
        return true;
      };

      if (/^REPORT$/i.test(text)) return send(report());
      if (/^ORDERS$/i.test(text)) return send(ordersSummary());
      if (/^KNOWN$/i.test(text)) return send(knownSummary());
      if (/^HELP$/i.test(text)) return send(HELP);

      let mm = text.match(/^LOSS(?:\s+(\d+))?$/i);
      if (mm) return send(inquiries.lostSalesMessage(parseInt(mm[1] || '1', 10)));

      // LEARN clutch plate swift dzire petrol = 22400M74L00
      mm = text.match(/^LEARN\s+(.+?)\s*=\s*(\S+)$/i);
      if (mm) {
        const entry = knowledge.learnAlias(mm[1].trim(), mm[2].trim(), 'admin');
        return send(
          entry
            ? `Learned: "${mm[1].trim()}" → ${mm[2].trim()}. I will not ask about this again.`
            : 'Could not learn that — check the format: LEARN <phrase> = <part number>'
        );
      }

      // GROUP Rahul | 919812345678, 919887654321
      mm = text.match(/^GROUP\s+([^|]+?)(?:\s*\|\s*(.+))?$/i);
      if (mm) {
        try {
          const g = await require('./groups').create(bots.customer.transport, {
            subject: `${config.groupSubjectPrefix} - ${mm[1].trim()}`,
            participants: (mm[2] || '').split(','),
          });
          return send(
            [
              `Group created: "${g.subject}"`,
              `ID: ${g.groupId}`,
              `Members added: ${g.participants.length}`,
              g.inviteLink ? `Invite: ${g.inviteLink}` : null,
            ]
              .filter(Boolean)
              .join('\n')
          );
        } catch (e) {
          return send('Could not create the group: ' + e.message);
        }
      }
      if (/^GROUPS$/i.test(text)) {
        const rows = require('./groups').all();
        return send(
          rows.length
            ? '*Groups:*\n' +
                rows.map((g) => `${g.subject} — ${g.groupId} (${g.participants.length})`).join('\n')
            : 'No groups created yet. Use: GROUP <name> | <phone1>, <phone2>'
        );
      }
      mm = text.match(/^CUSTOMER ADD\s+(.+?),\s*(\+?[\d\s-]+)$/i);
      if (mm) {
        const c = store.upsertCustomer(mm[2], mm[1].trim());
        return send(c ? `Customer saved: ${c.name || c.phone}.` : 'Could not save — check the phone number.');
      }
      mm = text.match(/^OFFER\s+([\s\S]+)$/i);
      if (mm) {
        const n = await bots.customer.broadcastOffer(mm[1].trim());
        return send(`Offer broadcast to ${n} customer(s).`);
      }
      mm = text.match(/^CN\s+(\+?[\d\s-]+?)\s+(\d+(?:\.\d+)?)\s*(.*)$/i);
      if (mm) {
        const cn = await bots.customer.shareCreditNote({
          customerPhone: mm[1],
          amount: parseFloat(mm[2]),
          reason: mm[3].trim(),
        });
        return send(`Credit Note ${cn.cnNumber} of Rs.${mm[2]} shared with ${cn.customerPhone}.`);
      }

      // ---- parked-bot commands ----
      if (bots.purchase) {
        if (/^STOCKREQ$/i.test(text)) {
          await bots.purchase.broadcastStockRequest();
          return send('Vendor stock broadcast sent.');
        }
        if (/^CHASE$/i.test(text)) {
          await bots.purchase.chasePendingInvoices();
          return send('Invoice chase run completed.');
        }
        mm = text.match(/^VENDOR ADD\s+(.+?),\s*(\+?[\d\s-]+)$/i);
        if (mm) {
          const v = store.upsertVendor({ name: mm[1].trim(), phone: mm[2] });
          return send(`Vendor saved: ${v.name} (${v.phone}).`);
        }
        if (/^POS$/i.test(text)) {
          const rows = [...store.pos()].reverse().slice(0, 10);
          return send(rows.length ? rows.map((p) => `${p.poNumber || p.id} [${p.status}] ${p.vendorName}`).join('\n') : 'No purchase orders yet.');
        }
      }

      return false; // not an admin command — let the bot roles handle it
    });
  }
  if (config.adminNumbers.length) {
    store.log('admin', `WhatsApp admin enabled for: ${config.adminNumbers.join(', ')}`);
  }
}

// daily push report + the sale-loss report the founder actually asked for
async function sendDailyReport(bots) {
  if (!config.adminNumbers.length) return;
  const transport =
    (Object.values(bots).find((b) => b.transport.mode === 'LIVE' && b.transport.state === 'connected') ||
      bots.customer).transport;
  for (const n of config.adminNumbers) {
    await transport.sendText(n, report());
    await transport.sendText(n, inquiries.lostSalesMessage(1));
  }
  store.log('admin', `daily report sent to ${config.adminNumbers.length} admin(s)`);
}

module.exports = { attach, sendDailyReport, report };
