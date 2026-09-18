'use strict';
// Cartrends webhook relay — Render (free tier) par deploy hota hai.
// Meta ke WhatsApp webhooks receive karke memory-queue mein rakhta hai;
// AutoFlow (EC2) har kuch second /pull karke le jaata hai.
// Koi dependency nahi — pure Node http (crypto Node ke andar hi hai).
//
// Render env vars:
//   VERIFY_TOKEN  = cartrends-autoflow-verify-2026   (Meta handshake)
//   RELAY_SECRET  = koi lamba random string          (poll auth)
//   APP_SECRET    = Meta App Secret                  (webhook signature)
//
// 13 Sep: /pull used to hand the whole queue over AND delete it in the same
// breath. If the bot died half way through a batch, the rest of that batch was
// gone for good. Now a poller that asks for it (`?lease=1`) gets the messages
// on LOAN: they stay here until it says `/ack`, and if it never does they are
// offered again after RELAY_LEASE_MS. A poller that does not ask still gets the
// old behaviour, so old and new builds work in either deploy order.
//
// The raw body and Meta's signature travel with every event, so the bot can
// check the signature itself against the exact bytes Meta signed.
const http = require('http');
const crypto = require('crypto');

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'cartrends-autoflow-verify-2026';
const RELAY_SECRET = process.env.RELAY_SECRET || 'change-me';
const APP_SECRET = (process.env.APP_SECRET || '').trim();
const PORT = process.env.PORT || 10000;
const LEASE_MS = parseInt(process.env.RELAY_LEASE_MS || '30000', 10);
const MAX_QUEUE = 500;

if (RELAY_SECRET === 'change-me') console.warn('WARNING: RELAY_SECRET is the default — set it on Render');
if (!APP_SECRET) console.warn('WARNING: APP_SECRET not set — webhook signatures are NOT checked');

// Meta signs the raw body with the app secret. The bytes must be the ones that
// arrived: re-serialising the JSON changes the hash.
function signatureOk(raw, header) {
  if (!APP_SECRET) return true;
  const got = String(header || '');
  if (!got.startsWith('sha256=')) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The secret may come as a header (does not land in access logs) or, as
// before, in the query string — older AutoFlow builds still send that.
function authorised(req, url) {
  const auth = String(req.headers.authorization || '');
  const fromHeader = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return (fromHeader || url.searchParams.get('secret')) === RELAY_SECRET;
}

let nextId = 0;
const queue = []; // { id, ts, body, raw, sig, leasedAt }

function readBody(req, limit, done) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) return req.destroy();
    chunks.push(c);
  });
  req.on('end', () => done(Buffer.concat(chunks)));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // Meta webhook verification handshake
  if (req.method === 'GET' && url.pathname === '/webhook/wa') {
    if (url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
      res.writeHead(200);
      return res.end(url.searchParams.get('hub.challenge') || '');
    }
    res.writeHead(403);
    return res.end();
  }

  // Meta webhook events -> queue
  if (req.method === 'POST' && url.pathname === '/webhook/wa') {
    return readBody(req, 2e6, (raw) => {
      const sig = req.headers['x-hub-signature-256'];
      if (!signatureOk(raw, sig)) {
        console.warn('webhook rejected: bad signature');
        res.writeHead(403);
        return res.end();
      }
      try {
        queue.push({
          id: ++nextId,
          ts: Date.now(),
          body: JSON.parse(raw.toString('utf8')),
          raw: raw.toString('utf8'),
          sig: sig || null,
          leasedAt: 0,
        });
        if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      } catch {}
      res.writeHead(200);
      res.end('OK');
    });
  }

  // AutoFlow poll
  if (req.method === 'GET' && url.pathname === '/pull') {
    if (!authorised(req, url)) {
      res.writeHead(403);
      return res.end();
    }
    let out;
    if (url.searchParams.get('lease') === '1') {
      // On loan: offered again if no /ack arrives within LEASE_MS.
      const now = Date.now();
      const ready = queue.filter((e) => !e.leasedAt || now - e.leasedAt > LEASE_MS);
      for (const e of ready) e.leasedAt = now;
      out = ready;
    } else {
      // The old contract: take everything, and it is gone from here.
      out = queue.splice(0, queue.length);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out.map(({ id, ts, body, raw, sig }) => ({ id, ts, body, raw, sig }))));
  }

  // AutoFlow: "these are handled, forget them"
  if (req.method === 'POST' && url.pathname === '/ack') {
    if (!authorised(req, url)) {
      res.writeHead(403);
      return res.end();
    }
    return readBody(req, 1e5, (raw) => {
      let ids = [];
      try {
        ids = (JSON.parse(raw.toString('utf8')).ids || []).map(Number);
      } catch {}
      const drop = new Set(ids);
      let acked = 0;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (drop.has(queue[i].id)) {
          queue.splice(i, 1);
          acked++;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ acked }));
    });
  }

  // health
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('cartrends-relay ok | queued: ' + queue.length);
});

// `node server.js` on Render starts it; the smoke test requires it and picks
// its own port.
if (require.main === module) server.listen(PORT, () => console.log('relay listening on', PORT));

module.exports = { server, queue };
