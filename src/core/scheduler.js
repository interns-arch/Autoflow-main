'use strict';
// Recurring jobs.
//
// Sales scope: only the daily admin report runs. The vendor stock broadcast,
// IVR follow-up and invoice chase belong to the PARKED purchase bot and are
// scheduled only when ENABLE_EXTRA_BOTS=true. The old ProcureHub stock sync
// is gone entirely — stock now lives in the Dealer Portal.
const cron = require('node-cron');
const config = require('../config');
const store = require('../store');

function cronFromTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m} ${h} * * *`;
}

function schedule(hhmm, fn, name) {
  cron.schedule(cronFromTime(hhmm), () => run(fn, name), { timezone: config.tz });
  store.log('sched', `${name} scheduled daily at ${hhmm} (${config.tz})`);
}

async function run(fn, name) {
  try {
    await fn();
  } catch (e) {
    store.log('sched', `${name} failed: ${e.message}`);
  }
}

function start({ bots, admin }) {
  if (admin && bots && config.adminNumbers.length && /^\d{1,2}:\d{2}$/.test(config.dailyReportTime)) {
    schedule(config.dailyReportTime, () => admin.sendDailyReport(bots), 'daily admin report');
  }

  if (!config.enableExtraBots) return;

  // ---- parked roles ----
  if (bots.purchase) {
    for (const t of config.stockBroadcastTimes) {
      schedule(t, () => bots.purchase.broadcastStockRequest(), 'vendor stock broadcast');
    }
    for (const t of config.ivrFollowupTimes) {
      schedule(t, () => bots.purchase.ivrFollowupNonResponders(), 'IVR stock follow-up');
    }
    cron.schedule(config.invoiceChaseCron, () => run(() => bots.purchase.chasePendingInvoices(), 'invoice chase'), {
      timezone: config.tz,
    });
    store.log('sched', `invoice chase scheduled: "${config.invoiceChaseCron}" (${config.tz})`);
  }
  if (bots.finance && config.isLive('finance')) {
    schedule('10:00', () => bots.finance.sendPaymentReminders(), 'payment reminders');
  }
}

module.exports = { start };
