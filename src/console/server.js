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

// ---- THE KEY IN FRONT OF THE WHOLE CONSOLE (founder, 28 Sep: the dashboard
// on port 3010, with the console one click from it) ----
//
// The console serves customers' chats and photos, customer lists, logs, a
// simulator that posts as any customer and a broadcast to every customer. It
// was safe only while the port was reachable from the server alone. With the
// port open, every page and API behind it needs DASHBOARD_KEY: entered once on
// /login (or on the dashboard), then carried as an HttpOnly cookie. Only the
// Meta webhook stays open - it is checked by its own signature.
const crypto = require('crypto');
const COOKIE = 'cf_console';
const SESSION_S = 12 * 60 * 60;
const sessionToken = () => crypto.createHmac('sha256', config.dashboardKey).update('console-session-v1').digest('hex');
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const keyOk = (k) => Boolean(config.dashboardKey) && sameSecret(k, config.dashboardKey);
function cookieOf(req) {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
}
const signedIn = (req) => Boolean(config.dashboardKey) && sameSecret(cookieOf(req), sessionToken());
// Behind the Cloudflare Tunnel every request arrives from the tunnel on this
// machine, so the visitor is read from Cloudflare's own header - trusted only
// when the connection itself is local (the tunnel), never from the open net.
const loopback = (req) => /^(::1|127\.|::ffff:127\.)/.test(String((req.socket && req.socket.remoteAddress) || ''));
function visitor(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && loopback(req)) return String(cf).trim();
  return (req.socket && req.socket.remoteAddress) || '?';
}
const overHttps = (req) => String(req.headers['x-forwarded-proto'] || '').includes('https') || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''));
function signIn(res, req) {
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_S}${req && overHttps(req) ? '; Secure' : ''}`);
}
// Wrong keys, per visitor: ten in fifteen minutes and that visitor waits.
const misses = new Map();
function tooMany(req) {
  const ip = visitor(req);
  const m = misses.get(ip);
  return Boolean(m && Date.now() - m.at < 15 * 60 * 1000 && m.n >= 10);
}
function missed(req) {
  const ip = visitor(req);
  const m = misses.get(ip);
  const fresh = m && Date.now() - m.at < 15 * 60 * 1000;
  misses.set(ip, { n: fresh ? m.n + 1 : 1, at: fresh ? m.at : Date.now() });
  store.log('console', `wrong dashboard key from ${ip}`);
}
const OPEN_PATHS = new Set(['/webhook/wa', '/login', '/logout', '/dashboard', '/dashboard/xlsx.js', '/api/dashboard', '/favicon.ico']);

function loginPage(msg, next) {
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cartrends Console</title>
<style>:root{--bg:#f5f6f8;--panel:#fff;--ink:#1b1f24;--muted:#667085;--line:#e4e7ec;--accent:#1f5fbf;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--ink:#e8eaed;--muted:#98a2b3;--line:#2a3038;--accent:#7aa7ff;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{max-width:380px;margin:12vh auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 6px}p{color:var(--muted);margin:0 0 14px}
input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit}
button{margin-top:12px;padding:9px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}.err{color:var(--bad);margin-top:10px}</style></head>
<body><form method="post" action="/login"><h1>Cartrends Console</h1><p>Enter the dashboard key (DASHBOARD_KEY on the server).</p>
<input type="password" name="key" autofocus autocomplete="current-password" placeholder="key"><input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Open</button>${msg ? `<div class="err">${esc(msg)}</div>` : ''}</form></body></html>`;
}
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\s]*$/.test(n) ? n : '/dashboard');

function mountGate(app) {
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.get('/login', (req, res) => res.type('html').send(loginPage('', safeNext(req.query.next))));
  app.post('/login', (req, res) => {
    const next = safeNext(req.body && req.body.next);
    if (tooMany(req)) return res.status(429).type('html').send(loginPage('Too many wrong keys — wait 15 minutes.', next));
    if (!keyOk(req.body && req.body.key)) {
      missed(req);
      return res.status(401).type('html').send(loginPage(config.dashboardKey ? 'Wrong key.' : 'DASHBOARD_KEY is not set on the server.', next));
    }
    signIn(res, req);
    res.redirect(303, next);
  });
  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.redirect(303, '/login');
  });
  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (signedIn(req)) return next();
    const k = req.get('x-dashboard-key');
    if (k && !tooMany(req) && keyOk(k)) {
      signIn(res, req);
      return next();
    }
    if (k) missed(req);
    // No key set on this machine: the console answers only on the machine
    // itself, as it did before the port was opened.
    if (!config.dashboardKey && loopback(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'sign in with the dashboard key' });
    return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl || '/'));
  });
}

// ---- the dashboard (founder, 26 Sep) ----
// Customers created, orders placed, discounts and payments: who asked, who
// approved, where each stands. The page is public/dashboard.html; its data
// needs DASHBOARD_KEY (?key= or the x-dashboard-key header).
function mountDashboard(app) {
  app.get('/', (req, res) => res.redirect('/dashboard'));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
  // The Excel writer the page builds its downloads with (founder, 29 Sep:
  // "dashboard data download in xlsx") - the xlsx package the server already
  // has, served from here rather than a CDN. A library, no data: open like
  // the page itself.
  app.get('/dashboard/xlsx.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(require.resolve('xlsx/dist/xlsx.full.min.js'));
  });
  app.get('/api/dashboard', async (req, res) => {
    const key = String(req.query.key || req.get('x-dashboard-key') || '');
    if (!config.dashboardKey) return res.status(503).json({ error: 'DASHBOARD_KEY is not set on the server' });
    if (!signedIn(req)) {
      if (tooMany(req)) return res.status(429).json({ error: 'too many wrong keys — wait 15 minutes' });
      if (!keyOk(key)) {
        missed(req);
        return res.status(401).json({ error: 'wrong key' });
      }
      // The same key opens the console: the dashboard's "Console" link
      // needs no second sign-in.
      signIn(res, req);
    }
    try {
      res.json(await require('../core/dashboardData').buildLive());
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
}

// THE DASHBOARD ALONE, ON ITS OWN PORT (founder, 28 Sep: "deploy the
// dashboard" - reachable by the team, not only through an SSH tunnel). The
// console on consolePort serves chats, media, customer lists, a simulator that
// posts as any customer and a broadcast to every customer - none of it behind a
// key - so that port stays on 127.0.0.1. This one serves the dashboard page and
// its key-checked data, and nothing else: no static folder, no other route.
function startDashboard() {
  if (!config.dashboardPort) return null;
  const app = express();
  app.disable('x-powered-by');
  mountDashboard(app);
  app.use((req, res) => res.sendStatus(404));
  return app.listen(config.dashboardPort, () => {
    store.log('boot', `dashboard (only) on port ${config.dashboardPort}${config.dashboardKey ? '' : ' — DASHBOARD_KEY is not set, it will show nothing'}`);
  });
}

function start(bots) {
  startDashboard();
  const app = express();
  // The RAW body is kept: a re-serialised object hashes differently, so the
  // Meta signature can only be checked against the bytes that arrived.
  app.use(express.json({ limit: '15mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  // Everything below needs the dashboard key (mountGate) - the static pages
  // included, so the gate goes in before them.
  mountGate(app);
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

  mountDashboard(app);

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

  // ---- self-learning knowledge base (Postgres + pgvector), token-protected ----
  require('./kbRoutes').mount(app);
  // ---- imported WhatsApp history: examples, part mappings, approval ----
  require('./historyRoutes').mount(app);

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

module.exports = { start, _startDashboard: startDashboard };
