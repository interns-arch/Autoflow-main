'use strict';
// Render relay se incoming Cloud API webhooks kheenchta hai aur cloud
// transports ko de deta hai.
//
// 13 Sep, three things that lost or trusted messages they should not have:
//   * /pull deleted the batch the moment it was handed over, so a bot that
//     died half way through lost the rest. Now messages are taken on LEASE and
//     acknowledged only after they were handled; an old relay that does not
//     understand `lease=1` simply behaves as before.
//   * Every error was swallowed with `.catch(() => {})`. Now it is logged, and
//     a batch that failed is not acknowledged, so the relay offers it again.
//     A message that keeps failing is let go after MAX_ATTEMPTS, so one bad
//     payload cannot block the line forever.
//   * The signature Meta put on the webhook was never checked on this path.
//     With WA_APP_SECRET set it now is, against the exact bytes Meta signed.
const config = require('../config');
const store = require('../store');
const signature = require('./signature');

const MAX_ATTEMPTS = 3;

// true = genuine, false = forged, null = cannot tell (the relay did not send
// the raw body - an older relay build).
function verify(evt) {
  if (!signature.configured()) return true;
  if (!evt || typeof evt.raw !== 'string') return null;
  return signature.valid(Buffer.from(evt.raw, 'utf8'), evt.sig);
}

function start(bots) {
  if (!config.relay.url || !config.relay.secret) return;
  const cloudTransports = [...new Set(Object.values(bots).map((b) => b.transport))].filter(
    (t) => t.mode === 'CLOUD'
  );
  if (!cloudTransports.length) {
    store.log('relay', 'relay URL set hai par koi CLOUD transport nahi (CUSTOMER_TRANSPORT=cloud karo) — poller off');
    return;
  }
  const auth = { Authorization: `Bearer ${config.relay.secret}` };
  // The secret is ALSO still sent in the query: the relay on Render is only
  // updated when someone pushes, and an old relay reads it from there.
  const q = `secret=${encodeURIComponent(config.relay.secret)}`;
  const attempts = new Map(); // relay event id -> failures so far
  let failures = 0;
  let busy = false;
  let warnedUnverifiable = false;
  let warnedNoAck = false;

  // ONE QUEUE PER CHAT, NOT ONE FOR EVERYONE.
  //
  // 25 Sep, live: a salesman sent a photo per part — each read by vision and
  // priced, ~10 s apiece — and every other customer waited behind all of them.
  // "Bot not responding" was a customer's message sitting at the back of
  // somebody else's photo queue. A chat's own messages still go strictly in
  // order (a quantity must follow its part); different chats no longer wait
  // for each other, and the poll keeps pulling while they are answered.
  const chains = new Map(); // chat -> the promise its next message waits on
  const inFlight = new Set(); // relay event ids taken and not yet finished

  const chatOf = (evt) => {
    try {
      const v = evt.body.entry[0].changes[0].value;
      const msg = (v.messages || [])[0];
      if (msg && msg.from) return 'chat:' + msg.from;
    } catch (_) {
      /* not a message: a status, a template update */
    }
    return 'evt:' + (evt.id || Math.random()); // nothing to keep in order with
  };

  const ack = async (ids) => {
    if (!ids.length) return;
    try {
      const res = await fetch(`${config.relay.url}/ack?${q}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(15000),
      });
      // An old relay has no /ack: it already deleted what it handed over.
      if (!res.ok && !warnedNoAck) {
        warnedNoAck = true;
        store.log('relay', 'relay did not accept /ack (HTTP ' + res.status + ') - running without acknowledgements');
      }
    } catch (e) {
      store.log('relay', 'ack failed: ' + String((e && e.message) || e).slice(0, 100) + ' - the relay will offer these again; duplicates are dropped by message id');
    }
  };

  // One event, start to finish: handed to the transports, then acknowledged —
  // or, after MAX_ATTEMPTS failures, let go.
  const handle = async (evt) => {
    let failed = false;
    for (const t of cloudTransports) {
      try {
        await t.handleWebhook(evt.body);
      } catch (e) {
        failed = true;
        store.log('relay', 'webhook handling failed: ' + String((e && e.message) || e).slice(0, 160));
      }
    }
    if (!evt.id) return; // an old relay: nothing to acknowledge
    if (!failed) {
      attempts.delete(evt.id);
      return ack([evt.id]);
    }
    const n = (attempts.get(evt.id) || 0) + 1;
    attempts.set(evt.id, n);
    if (n >= MAX_ATTEMPTS) {
      store.log('relay', 'event ' + evt.id + ' failed ' + n + ' times - dropping it');
      attempts.delete(evt.id);
      return ack([evt.id]);
    }
  };

  setInterval(async () => {
    // Only the PULL is guarded now: answering happens on the chats' own queues.
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(`${config.relay.url}/pull?${q}&lease=1`, {
        headers: auth,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const events = await res.json();
      failures = 0;
      const rejected = [];
      let taken = 0;
      for (const evt of events) {
        // Still being answered, offered again because its lease ran out.
        if (evt.id && inFlight.has(evt.id)) continue;
        const genuine = verify(evt);
        if (genuine === false) {
          store.log('relay', 'webhook REJECTED: signature does not match WA_APP_SECRET');
          if (evt.id) rejected.push(evt.id);
          continue;
        }
        if (genuine === null && !warnedUnverifiable) {
          warnedUnverifiable = true;
          store.log('relay', 'WA_APP_SECRET is set but the relay sends no raw body - signatures cannot be checked until Render runs the new relay');
        }
        taken++;
        if (evt.id) inFlight.add(evt.id);
        const key = chatOf(evt);
        const next = (chains.get(key) || Promise.resolve())
          .then(() => handle(evt))
          .catch((e) => store.log('relay', 'event failed: ' + String((e && e.message) || e).slice(0, 120)))
          .finally(() => {
            if (evt.id) inFlight.delete(evt.id);
            if (chains.get(key) === next) chains.delete(key);
          });
        chains.set(key, next);
      }
      await ack(rejected);
      if (taken) store.log('relay', `${taken} webhook event(s) taken (${chains.size} chat queue(s) busy)`);
    } catch (e) {
      failures++;
      if (failures === 5 || failures % 100 === 0) {
        store.log('relay', `poll failing (${failures}x): ${String(e.message || e).slice(0, 80)} — Render service so raha hoga, jagane ki koshish jaari`);
      }
    } finally {
      busy = false;
    }
  }, Math.max(2000, config.relay.pollMs));
  store.log('relay', `webhook relay poller on: ${config.relay.url} (har ${config.relay.pollMs}ms)`);
}

module.exports = { start, _verify: verify };
