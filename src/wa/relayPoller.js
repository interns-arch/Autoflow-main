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

  setInterval(async () => {
    // A batch with a photo in it takes longer than the poll interval. A second
    // poll starting on top of it would be handed the same work.
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
      const done = [];
      for (const evt of events) {
        const genuine = verify(evt);
        if (genuine === false) {
          store.log('relay', 'webhook REJECTED: signature does not match WA_APP_SECRET');
          if (evt.id) done.push(evt.id);
          continue;
        }
        if (genuine === null && !warnedUnverifiable) {
          warnedUnverifiable = true;
          store.log('relay', 'WA_APP_SECRET is set but the relay sends no raw body - signatures cannot be checked until Render runs the new relay');
        }
        let failed = false;
        for (const t of cloudTransports) {
          try {
            await t.handleWebhook(evt.body);
          } catch (e) {
            failed = true;
            store.log('relay', 'webhook handling failed: ' + String((e && e.message) || e).slice(0, 160));
          }
        }
        if (!evt.id) continue; // an old relay: nothing to acknowledge
        if (!failed) {
          done.push(evt.id);
          attempts.delete(evt.id);
        } else {
          const n = (attempts.get(evt.id) || 0) + 1;
          attempts.set(evt.id, n);
          if (n >= MAX_ATTEMPTS) {
            store.log('relay', 'event ' + evt.id + ' failed ' + n + ' times - dropping it');
            done.push(evt.id);
            attempts.delete(evt.id);
          }
        }
      }
      if (done.length) {
        try {
          const ack = await fetch(`${config.relay.url}/ack?${q}`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: done }),
            signal: AbortSignal.timeout(15000),
          });
          // An old relay has no /ack: it already deleted what it handed over.
          if (!ack.ok && !warnedNoAck) {
            warnedNoAck = true;
            store.log('relay', 'relay did not accept /ack (HTTP ' + ack.status + ') - running without acknowledgements');
          }
        } catch (e) {
          store.log('relay', 'ack failed: ' + String((e && e.message) || e).slice(0, 100) + ' - the relay will offer these again; duplicates are dropped by message id');
        }
      }
      if (events.length) store.log('relay', `${events.length} webhook event(s) processed`);
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
