'use strict';
// Cartrends AutoFlow — entrypoint.
//
// CURRENT SCOPE: the customer/sales bot only. It reads availability from the
// Dealer Portal and punches sales orders there. Vendor stock reaches the
// portal from ProcureHub, not from this process.
//
// The purchase / warehouse / finance / helpdesk bots are PARKED — their code
// is intact but they do not boot unless ENABLE_EXTRA_BOTS=true.
const config = require('./config');
const store = require('./store');
const scheduler = require('./core/scheduler');
const consoleServer = require('./console/server');
const portal = require('./integrations/dealerPortal');

const CustomerBot = require('./bots/customerBot');

function buildBots() {
  const bots = { customer: new CustomerBot() };
  if (!config.enableExtraBots) return bots;

  // Parked roles, switched on explicitly.
  bots.purchase = new (require('./bots/purchaseBot'))();
  bots.warehouse = new (require('./bots/warehouseBot'))();
  bots.finance = new (require('./bots/financeBot'))();
  bots.helpdesk = new (require('./bots/helpdeskBot'))();
  return bots;
}

async function main() {
  store.load();
  store.log('boot', '=== Cartrends AutoFlow starting (sales bot) ===');
  for (const key of config.BOTS) {
    store.log(
      'boot',
      `${config.bots[key].label}: ${config.isLive(key) ? 'LIVE as ' + config.bots[key].number : 'SIMULATION (no number in .env)'}`
    );
  }
  store.log(
    'boot',
    portal.enabled()
      ? 'Dealer Portal: LIVE — availability and order punching go to the portal'
      : 'Dealer Portal: MOCK (no DEALER_PORTAL_BASE_URL/credentials) — using data/mock-stock.json'
  );
  if (!config.enableExtraBots) {
    store.log('boot', 'purchase / warehouse / finance / helpdesk are PARKED (set ENABLE_EXTRA_BOTS=true to run them)');
  }

  const bots = buildBots();

  // admin-over-WhatsApp registers FIRST so admin commands outrank bot roles
  const admin = require('./core/admin');
  admin.attach(bots);
  require('./core/escalation').attach(bots); // helper replies claim before roles

  consoleServer.start(bots); // dev/testing console — production runs headless
  scheduler.start({ bots, admin });

  // start live bots sequentially (each spawns a headless browser); sims are instant
  for (const bot of Object.values(bots)) {
    try {
      await bot.start();
    } catch (e) {
      store.log('boot', `${bot.key} failed to start: ${e.message}`);
    }
  }

  require('./wa/relayPoller').start(bots); // Cloud API incoming via Render relay

  // Every GSTIN the portal already holds, pulled in the background. There
  // is no "is this GSTIN taken" route — the only way to know is the full
  // customer list, which is 7551 rows and 84 SECONDS. Warmed here so the
  // first customer who types a GSTIN is not the one who finds that out.
  // Nothing waits on it: until it lands, a duplicate check says so.
  require('./integrations/dealerPortal')
    .warmGstIndex()
    .catch(() => {});

  // The knowledge base, if one is configured. Reported at boot rather than
  // discovered on the first customer question: "schema missing" is a five
  // second fix when you read it at startup and a mystery when you read it in
  // the middle of a busy line.
  const kb = require('./core/kb');
  if (!kb.enabled()) {
    store.log('boot', 'knowledge base: OFF (no DATABASE_URL) — questions go to a person, as before');
  } else {
    kb.health()
      .then((h) => {
        store.log(
          'boot',
          h.ok
            ? `knowledge base: ready, ${h.approved} approved answer(s)`
            : 'knowledge base: NOT USABLE — ' + h.reason,
        );
        if (h.ok) return kb.backfillEmbeddings();
        return 0;
      })
      .then((n) => {
        if (n) store.log('kb', 'embedded ' + n + ' entry(ies) that had none');
      })
      .catch(() => {});
    // Entries approved while the embedding service was unreachable would stay
    // unsearchable forever otherwise.
    setInterval(() => kb.backfillEmbeddings().catch(() => {}), 60 * 60 * 1000).unref();
  }

  store.log('boot', 'ready. Console: http://localhost:' + config.consolePort);
}

// LAST LINE OF DEFENCE.
//
// A rejected promise that nobody catches — inside a setTimeout, a webhook
// callback, an event handler — terminates the whole process in Node 18+. One
// network blip while replying to a customer would take the bot down minutes
// after the message that caused it, and the stack trace points at the timer,
// not at the message. Individual call sites are guarded, but "every async path
// is guarded forever" is not a promise any codebase keeps.
process.on('unhandledRejection', (err) => {
  const msg = String((err && err.stack) || err).slice(0, 400);
  console.error('[unhandledRejection]', msg);
  try { store.log('crash', 'unhandled rejection — survived: ' + msg.slice(0, 200)); } catch {}
});

// A synchronous throw that escaped every handler is different: Node's own
// guidance is that the process state is no longer trustworthy afterwards. For
// a process that punches real orders into the Dealer Portal, staying up with
// corrupted state is worse than being down. So: log loudly, then exit so a
// restart brings back a known-good process.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.stack) || err).slice(0, 400);
  console.error('[uncaughtException] exiting:', msg);
  try { store.log('crash', 'uncaught exception — exiting: ' + msg.slice(0, 200)); } catch {}
  process.exit(1);
});

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
