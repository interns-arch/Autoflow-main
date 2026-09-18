'use strict';
// Operations console (http://localhost:3010) — dev/testing only; production
// runs headless.
//   - bot status + QR codes for linking the live number
//   - simulator: inject messages as a customer
//   - Dealer Portal status, and a mock-stock loader for offline testing
//   - sale-loss report and learned-knowledge view
//   - live view of orders and logs
const path = require('path');
const express = require('express');
const config = require('../config');
const store = require('../store');
const signature = require('../wa/signature');
const portal = require('../integrations/dealerPortal');
const inquiries = require('../core/inquiries');
const knowledge = require('../core/knowledge');
const { SimTransport } = require('../wa/transport');

function start(bots) {
  const app = express();
  // The RAW body is kept: a re-serialised object hashes differently, so the
  // Meta signature can only be checked against the bytes that arrived.
  app.use(express.json({ limit: '15mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Meta Cloud API webhook (GET = verify handshake, POST = messages) ----
  const cloudTransports = () =>
    [...new Set(Object.values(bots).map((b) => b.transport))].filter((t) => t.mode === 'CLOUD');
  app.get('/webhook/wa', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.cloud.verifyToken) {
      store.log('cloud', 'webhook verified by Meta ✅');
      return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });
  app.post('/webhook/wa', (req, res) => {
    // Meta signs every POST. Without this check the public webhook URL was an
    // open door: anyone who knew it could post a message as any customer,
    // including a "yes". Unset secret = checked as before (nothing breaks),
    // and that is logged once so it is not forgotten.
    if (signature.configured() && !signature.valid(req.rawBody || '', req.get('x-hub-signature-256'))) {
      store.log('cloud', 'webhook REJECTED: signature does not match WA_APP_SECRET');
      return res.sendStatus(403);
    }
    res.sendStatus(200); // ack immediately, process in the background
    for (const t of cloudTransports()) t.handleWebhook(req.body).catch(() => {});
  });

  app.get('/api/status', (req, res) => {
    const out = {};
    for (const [key, bot] of Object.entries(bots)) {
      out[key] = { label: config.bots[key].label, number: config.bots[key].number || null, ...bot.transport.status() };
    }
    res.json({
      bots: out,
      portalMock: portal.isMock,
      portalEnabled: portal.enabled(),
      extraBots: config.enableExtraBots,
      tz: config.tz,
    });
  });

  // ---- simulator ----
  app.post('/api/sim/:bot/message', async (req, res) => {
    const bot = bots[req.params.bot];
    if (!bot) return res.status(404).json({ error: 'unknown bot' });
    if (!(bot.transport instanceof SimTransport)) {
      return res.status(400).json({ error: 'bot is LIVE — talk to it on WhatsApp' });
    }
    const { from, body, isGroup, chatName, hasMedia, mediaBase64, mediaMime } = req.body;
    const fromN = store.normPhone(from);
    await bot.transport.injectIncoming({
      from: fromN,
      chatId: isGroup ? 'simgroup-' + (chatName || 'group') : 'sim-' + fromN,
      chatName: chatName || '',
      isGroup: Boolean(isGroup),
      body: body || '',
      hasMedia: Boolean(hasMedia || mediaBase64),
      mediaType: mediaBase64 ? 'image' : hasMedia ? 'document' : 'chat',
      mediaBase64: mediaBase64 || undefined,
      mediaMime: mediaMime || undefined,
    });
    res.json({ ok: true });
  });
  app.get('/api/sim/:bot/outbox', (req, res) => {
    const bot = bots[req.params.bot];
    if (!bot) return res.status(404).json({ error: 'unknown bot' });
    res.json({ outbox: bot.transport.outbox || [] });
  });

  // ---- Dealer Portal ----
  app.get('/api/portal', (req, res) =>
    res.json({ enabled: portal.enabled(), mock: portal.isMock, baseUrl: config.dealerPortal.baseUrl || null })
  );
  // Offline testing only: seed what the MOCK portal will answer with.
  // rows: [{ part_no, name, quantity, price, mrp, vendor }]
  app.post('/api/portal/mock-stock', (req, res) => {
    if (!Array.isArray(req.body.rows)) return res.status(400).json({ error: 'rows[] required' });
    const n = portal.setMockStock(req.body.rows);
    res.json({ ok: true, count: n });
  });
  app.post('/api/portal/analyze', async (req, res) => {
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    res.json({ resolved: await require('../core/availability').resolve(lines) });
  });

  // ---- WhatsApp groups (Cloud API) ----
  app.get('/api/groups', (req, res) => res.json({ groups: require('../core/groups').all() }));
  app.post('/api/groups', async (req, res) => {
    const { subject, customer, participants } = req.body || {};
    if (!subject) return res.status(400).json({ error: 'subject required' });
    try {
      const g = await require('../core/groups').create(bots.customer.transport, {
        subject,
        customer,
        participants: Array.isArray(participants) ? participants : String(participants || '').split(','),
      });
      res.json({ group: g });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- sale loss + knowledge ----
  app.get('/api/loss', (req, res) =>
    res.json({ days: Number(req.query.days) || 7, lost: inquiries.lostSales(Number(req.query.days) || 7) })
  );
  app.get('/api/inquiries', (req, res) => res.json({ inquiries: inquiries.recent(100) }));
  app.get('/api/knowledge', (req, res) => res.json(knowledge.all()));
  app.post('/api/knowledge', (req, res) => {
    const { phrase, partNo } = req.body;
    if (!phrase || !partNo) return res.status(400).json({ error: 'phrase and partNo required' });
    res.json({ entry: knowledge.learnAlias(phrase, partNo, 'console') });
  });

  // ---- customers / engagement ----
  app.get('/api/customers', (req, res) => res.json({ customers: store.customers() }));
  app.post('/api/customers', (req, res) => {
    const c = store.upsertCustomer(req.body.phone, req.body.name);
    if (!c) return res.status(400).json({ error: 'phone required' });
    res.json({ customer: c });
  });
  app.get('/api/credit-notes', (req, res) =>
    res.json({ creditNotes: [...store.load().creditNotes].reverse().slice(0, 50) })
  );
  app.post('/api/credit-notes', async (req, res) => {
    const { customerPhone, cnNumber, amount, reason } = req.body;
    if (!customerPhone || !amount) return res.status(400).json({ error: 'customerPhone and amount required' });
    try {
      res.json({ creditNote: await bots.customer.shareCreditNote({ customerPhone, cnNumber, amount, reason }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/api/cross-sell', (req, res) => res.json({ crossSell: store.load().crossSell }));
  app.post('/api/cross-sell', (req, res) => {
    if (typeof req.body.crossSell !== 'object') return res.status(400).json({ error: 'crossSell map required' });
    store.load().crossSell = req.body.crossSell;
    store.save();
    res.json({ ok: true });
  });
  app.post('/api/actions/broadcast-offer', async (req, res) => {
    if (!req.body.text) return res.status(400).json({ error: 'text required' });
    try {
      res.json({ ok: true, sentTo: await bots.customer.broadcastOffer(req.body.text) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/orders', (req, res) => res.json({ orders: [...store.orders()].reverse().slice(0, 50) }));
  // ---- Inbox: who is messaging the line, and what the bot answered ----
  // Reads core/chatLog, which every transport writes to. Roles come from
  // .env, so a number is shown as what it IS (admin, sales, helper) rather
  // than as ten digits nobody can place.
  const chatLog = require('../core/chatLog');
  // A number is often more than one thing - 9999492550 is the parts helper
  // AND an admin - so every role it holds is shown, not just the first.
  const roleOf = (phone) => {
    const p = store.normPhone(phone);
    if (!p) return '';
    const roles = [];
    if ((config.adminNumbers || []).includes(p)) roles.push('admin');
    if ((config.salesTeamNumbers || []).includes(p)) roles.push('sales team');
    if ((config.dataEntryAlertNumbers || []).includes(p)) roles.push('data entry');
    if (store.normPhone(config.escalationNumber) === p) roles.push('parts helper');
    if (store.normPhone(config.voiceEscalationNumber) === p) roles.push('voice helper');
    return roles.length ? roles.join(' · ') : 'customer';
  };
  const knownName = (phone) => {
    const p = store.normPhone(phone);
    const hit = store.customers().find((c) => store.normPhone(c.phone) === p);
    return (hit && hit.name) || '';
  };
  app.get('/api/chats', (req, res) => {
    const rows = chatLog.chats({ limit: Number(req.query.limit) || 200 });
    res.json({ chats: rows.map((c) => ({ ...c, role: roleOf(c.phone), name: c.name || knownName(c.phone) })) });
  });
  app.get('/api/chats/:id', (req, res) => {
    const id = req.params.id;
    res.json({
      id,
      role: roleOf(id),
      name: knownName(id),
      messages: chatLog.messages(id, { limit: Number(req.query.limit) || 400 }),
    });
  });

  // The photos and voice notes themselves. chatLog generates the name, so
  // anything that is not a plain file name is a probe, not a request.
  app.get('/api/media/:name', (req, res) => {
    const name = String(req.params.name || "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.sendStatus(400);
    res.sendFile(path.join(config.sharedDir, 'media', name), (err) => {
      if (err) res.sendStatus(404);
    });
  });

  app.get('/api/logs', (req, res) => res.json({ logs: store.load().logs.slice(-120).reverse() }));

  // ---- parked roles (ENABLE_EXTRA_BOTS=true) ----
  if (config.enableExtraBots) {
    app.get('/api/vendors', (req, res) =>
      res.json({ vendors: store.vendors().map((v) => ({ ...v, stock: store.vendorStock(v.id) })) })
    );
    app.post('/api/vendors', (req, res) => {
      const { name, phone, aliases } = req.body;
      if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
      res.json({ vendor: store.upsertVendor({ name, phone, aliases: aliases || [] }) });
    });
    app.get('/api/pos', (req, res) => res.json({ pos: [...store.pos()].reverse().slice(0, 50) }));
    app.get('/api/picklists', (req, res) =>
      res.json({ picklists: [...store.load().picklists].reverse().slice(0, 50) })
    );
    const actions = {
      broadcast: () => bots.purchase.broadcastStockRequest(),
      'ivr-followup': () => bots.purchase.ivrFollowupNonResponders(),
      'invoice-chase': () => bots.purchase.chasePendingInvoices(),
      'payment-reminders': () => bots.finance.sendPaymentReminders(),
    };
    app.post('/api/actions/:name', async (req, res) => {
      const fn = actions[req.params.name];
      if (!fn) return res.status(404).json({ error: 'unknown action' });
      try {
        await fn();
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  app.listen(config.consolePort, () => {
    store.log('console', `operations console running at http://localhost:${config.consolePort}`);
  });
  return app;
}

module.exports = { start };
