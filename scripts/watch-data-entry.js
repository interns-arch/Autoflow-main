'use strict';
// Watch the IT mailbox and create approved Data Entry requests as they arrive.
//
//   node scripts/watch-data-entry.js            # watch, report, create nothing
//   node scripts/watch-data-entry.js --create   # watch and create
//
// ONLY MAILS THAT ARRIVE FROM NOW ON. The mailbox holds ~200 historical
// requests that were entered by hand months ago; a watcher that "caught up" on
// startup would create two hundred duplicate accounts in a live portal. The
// cutoff is the moment this process starts, and it is never widened.
//
// One line of stdout per thing that happened, so this can be tailed or watched.
const config = require('../src/config');
const store = require('../src/store');
const mailbox = require('../src/integrations/mailbox');
const portal = require('../src/integrations/dealerPortal');
const cr = require('../src/core/dataEntryRequests');
const naming = require('../src/core/partNaming');
const approvals = require('../src/core/partApprovals');

const args = process.argv.slice(2);
const wantCreate = args.includes('--create');
const everyMs = Math.max(60, parseInt(args[args.indexOf('--every') + 1], 10) || 120) * 1000;

// Gmail's `after:` takes seconds. Anything already in the mailbox the FIRST
// time this ever runs is history and is left alone — the mailbox holds ~200
// requests entered by hand months ago.
//
// After that the cutoff is REMEMBERED. Tying it to process start meant every
// restart silently moved the window forward, and a request that arrived while
// the container was rebuilding was never fetched by anyone — no account, no
// alert, no log line. Two real requests were lost that way on 9 Sep during a
// run of deploys.
//
// The stored mark is rewound by one polling interval so a mail landing in the
// same second as a tick cannot fall between two windows; `isDone` already
// keeps a re-fetched request from being created twice.
const OVERLAP_S = 300;
function loadCutoff() {
  const st = store.load();
  if (!st.dataEntryWatch) st.dataEntryWatch = {};
  const seen = Number(st.dataEntryWatch.lastSeen) || 0;
  if (seen) return { at: Math.max(0, seen - OVERLAP_S), resumed: true };
  const now = Math.floor(Date.now() / 1000);
  st.dataEntryWatch.lastSeen = now;
  store.save();
  return { at: now, resumed: false };
}
function saveCutoff(sec) {
  const st = store.load();
  if (!st.dataEntryWatch) st.dataEntryWatch = {};
  st.dataEntryWatch.lastSeen = sec;
  store.save();
}
const boot = loadCutoff();
let startedAt = boot.at;

function say(line) {
  process.stdout.write(line + '\n');
}

// Container logs are not a report. Anything a person has to ACT on — an
// account that was created, a field the portal could not store, a request that
// was refused — goes to DATA_ENTRY_ALERT_NUMBERS on WhatsApp, because that is
// where the person who chases these already is. Left in stdout only, an
// incomplete request would sit unread in `docker logs` for weeks.
let waTransport = null;
// Returns the message ids, so a swipe-reply to "naam ye rakhun?" can be tied
// back to the part it asked about.
async function tellAdmins(text) {
  const nums = config.dataEntryAlertNumbers || [];
  if (!nums.length) return [];
  const ids = [];
  try {
    if (!waTransport) {
      const { createTransport } = require('../src/wa/transport');
      waTransport = createTransport('customer');
      await waTransport.start();
    }
    for (const n of nums) ids.push(await waTransport.sendText(n, text));
  } catch (e) {
    // Never let a failed notification stop the account creation that already
    // succeeded — the log line still exists either way.
    say(`   (admin notify failed: ${String((e && e.message) || e).slice(0, 100)})`);
  }
  return ids.filter(Boolean).map(String);
}

// What actually went to the portal, written the way it will be read: on a
// phone, by someone checking the bot's work without opening the portal. Only
// fields that were really sent appear — a line reading "credit: —" teaches the
// reader nothing and buries the ones that matter.
const BRANCH_NAMES = {
  23: 'BIJWASAN',
  1078: 'MAANSAROVAR',
  1079: 'GURUGRAM',
  1080: 'NOIDA',
  460: 'KAROL BAGH',
};

// Where the catalogue name came from, so a person knows which ones to glance at.
const NAME_FROM = {
  list: 'from the reference list',
  confirmed: 'confirmed earlier on WhatsApp',
  learned: 'same as its sibling parts in the list',
  ai: 'written in the house style by the AI',
  basic: 'from the mail only',
};

function creationReceipt(a) {
  const L = [];
  if (a.kind === 'inventory') {
    L.push(`*${a.partNo}* — ${a.standardName || a.partName || ''}`);
    if (a.nameSource) L.push(`name: ${NAME_FROM[a.nameSource] || a.nameSource}`);
    if (a.brand) L.push(`brand: ${a.brand}`);
    if (a.hsnCode) L.push(`HSN: ${a.hsnCode}`);
    if (a.gstPercent != null) L.push(`GST: ${a.gstPercent}%`);
    if (a.mrpValue != null) L.push(`MRP: ${a.mrpValue}`);
    return L;
  }
  L.push(`*${a.name}*`);
  if (a.phone) L.push(`mobile: ${a.phone}`);
  if (a.email) L.push(`email: ${a.email}`);
  if (a.gstNo) L.push(`GST: ${a.gstNo}`);
  if (a.address) L.push(`address: ${String(a.address).slice(0, 90)}`);
  const credit = [
    a.creditDays != null ? `${a.creditDays} days` : null,
    a.creditLimit != null ? `limit ${a.creditLimit}` : null,
  ].filter(Boolean);
  if (credit.length) L.push(`credit: ${credit.join(' / ')}`);
  if (a.category) L.push(`category: ${a.category}`);
  if (a.branchId) L.push(`home branch: ${BRANCH_NAMES[a.branchId] || a.branchId}`);
  if (a.userType) L.push(`role: ${a.userType}`);
  L.push(`login: ${a.username} / ${a.password}`);
  if (a.alsoVendor) L.push('also created as a VENDOR (the mail said both)');
  if (a.alsoCustomer) L.push('also created as a CUSTOMER (the mail said both)');
  return L;
}

function describe(a) {
  if (a.kind === 'inventory') {
    return [
      `part_no=${a.partNo}`,
      `part_name=${a.standardName || a.partName}`,
      a.nameSource ? `name_from=${a.nameSource}${a.nameCheck ? ' (CHECK)' : ''}` : null,
      `brand=${a.brand}`,
      a.mrpValue != null ? `mrp=${a.mrpValue}` : null,
      a.hsnCode ? `hsn=${a.hsnCode}` : null,
      a.gstPercent != null ? `gst=${a.gstPercent}%` : null,
    ]
      .filter(Boolean)
      .join('  ');
  }
  return [
    `name=${a.name}`,
    `username=${a.username}`,
    `password=${a.password}`,
    `phone=${a.phone}`,
    a.gstNo ? `gst=${a.gstNo}` : null,
    a.creditDays != null ? `credit_days=${a.creditDays}` : null,
    a.creditLimit != null ? `credit_limit=${a.creditLimit}` : null,
    a.address ? `address=${a.address}` : null,
  ]
    .filter(Boolean)
    .join('  ');
}

async function tick() {
  // Taken BEFORE the fetch: anything arriving while this tick runs must fall
  // inside the next window, not be skipped by it.
  const tickAt = Math.floor(Date.now() / 1000);
  const query = `${config.mailbox.query.replace(/\s*newer_than:\S+/, '')} after:${startedAt}`;
  let mails = [];
  try {
    mails = await mailbox.fetchRequests({ limit: 10, query });
  } catch (e) {
    say(`ERROR reading mailbox: ${String((e && e.message) || e).slice(0, 150)}`);
    return; // cutoff NOT advanced — the same window is retried next tick
  }

  for (const mail of mails) {
    const fields = cr.parseRequest(mail.subject, mail.body);
    if (!fields) {
      say(`UNREADABLE  ${mail.subject}`);
      continue;
    }
    const a = cr.buildAccount(fields);
    if (mailbox.isDone(a.requestId)) continue; // handled on an earlier tick

    const problems = cr.validate(a);
    if (problems.length) {
      mailbox.markDone(a.requestId, { skipped: problems.join('; ') });
      say(`SKIPPED  ${a.requestId}  (${a.kind})  — ${problems.join('; ')}`);

      // Two very different reasons to skip, and only one is worth a message.
      //
      // MRP and discount changes can NEVER be automated — the portal has no
      // field to write an MRP through. Those arrive regularly and the team
      // already handles them in super admin, so a WhatsApp every time would
      // be pure noise, and noise is what makes people stop reading alerts.
      //
      // A request missing its mobile or firm name is the opposite: the mail
      // itself is incomplete, somebody has to go back to the requester, and
      // nobody would ever find out otherwise.
      const notAutomatable = a.kind === 'mrp' || a.kind === 'discount';
      if (!notAutomatable) {
        await tellAdmins(
          `⚠️ *Information missing in this request* — ${a.requestId} (${a.kind})\n` +
            `${a.name || a.partNo || ''}\n\n${problems.join('\n')}\n\n` +
            `The mail did not carry this, so the account was not created.`
        );
      }
      continue;
    }

    // The catalogue name in the house style — not the bare "windshield" the
    // mail carries. Worked out before the dry run so it shows there too.
    if (a.kind === 'inventory') {
      const nm = await naming.nameFor(a);
      Object.assign(a, {
        standardName: nm.name,
        nameSource: nm.source,
        nameCheck: nm.check,
        foundHsn: nm.hsn || null,
        nameEvidence: nm.evidence || null,
      });
    }

    const dropped = cr.droppedFields(a);
    if (!wantCreate) {
      say(`WOULD CREATE  ${a.requestId}  (${a.kind})  ${describe(a)}`);
      if (dropped.length) say(`   not stored in the portal: ${dropped.join(', ')}`);
      mailbox.markDone(a.requestId, { dryRun: true });
      continue;
    }

    // Founder's rule (11 Sep): the name must be exactly in the list's format
    // and nothing wrong may be created. A name the reference list does not
    // confirm is asked on WhatsApp first — "naam ye rakhun?" — and the sales
    // bot, which receives the answer, creates the part (core/partApprovals).
    if (a.kind === 'inventory' && !naming.safeToCreate({ source: a.nameSource, check: a.nameCheck })) {
      const pending = {
        requestId: a.requestId,
        fields: {
          partNo: a.partNo,
          partName: a.partName,
          brand: a.brand,
          // The mail's HSN when it has one; else the one the research found,
          // shown in the question so the desk OKs it together with the name.
          hsnCode: a.hsnCode || a.foundHsn || null,
          gstPercent: a.gstPercent,
          mrpValue: a.mrpValue,
        },
        hsnFound: !a.hsnCode && Boolean(a.foundHsn),
        suggested: a.standardName,
        evidence: a.nameEvidence,
        doneLink: mailbox.doneLink(mail.body, a.requestId),
      };
      approvals.add(pending);
      const ids = await tellAdmins(approvals.askText(pending));
      approvals.add({ ...pending, askedWamids: ids });
      mailbox.markDone(a.requestId, { kind: a.kind, awaitingOk: true, suggested: a.standardName });
      say(`ASKED  ${a.requestId}  (inventory)  — waiting for an OK on WhatsApp  ${describe(a)}`);
      continue;
    }

    try {
      const res =
        a.kind === 'vendor'
          ? await portal.createVendor(a)
          : a.kind === 'inventory'
            ? await portal.createPart(a)
            : await portal.createCustomer(a);

      // Recorded BEFORE ticking the dashboard: if the tick fails we must never
      // create the same account again, and an unticked box is the smaller
      // problem of the two.
      mailbox.markDone(a.requestId, { kind: a.kind, accountId: res.accountId || res.partNo || null });
      say(`CREATED  ${a.requestId}  (${a.kind})  portal_id=${res.accountId || res.partNo || '?'}  ${describe(a)}`);
      if (dropped.length) say(`   not stored in the portal: ${dropped.join(', ')}`);

      const link = mailbox.doneLink(mail.body, a.requestId);
      const done = await mailbox.clickDone(link);
      say(done.ok ? `   dashboard marked done` : `   dashboard NOT marked: ${done.reason || 'HTTP ' + done.status}`);

      // A receipt, because nobody can check the bot's work without one. It
      // names every field that went in, where the account landed, and what
      // the portal has no field for.
      const where =
        a.kind === 'inventory'
          ? `part *${res.partNo}* is in the catalogue`
          : `portal id *${res.accountId || "?"}*`;
      await tellAdmins(
        [
          `✅ *Created* — ${a.requestId} (${a.kind})`,
          where,
          '',
          ...creationReceipt(a),
          ...(dropped.length ? ['', `_Portal has no field for:_ ${dropped.join(', ')}`] : []),
          ...(done.ok ? [] : ['', '⚠️ Dashboard NOT ticked — please tick it by hand.']),
        ].join('\n'),
      );

      // A failed dashboard tick is named at the foot of that receipt, so it
      // gets no second message of its own.
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 180);
      say(`FAILED  ${a.requestId}  (${a.kind})  — ${why}`);
      // Recorded, so the request is neither quietly forgotten nor attempted a
      // second time. The window moves on at the end of every tick, so "it will
      // be retried" was never true — the WhatsApp below is the safety net and
      // a person finishes it.
      mailbox.markDone(a.requestId, { kind: a.kind, failed: why });
      say(`   recorded as failed; a person has to finish this one`);
      // Same class as a refusal: the record does not exist and somebody has to
      // deal with it. Silence here would leave a request quietly undone.
      await tellAdmins(
        `⚠️ *This request could not be created* — ${a.requestId} (${a.kind})\n` +
          `${a.name || a.partNo || ''}\n\n` +
          `The portal refused it: ${why.slice(0, 160)}\n\n` +
          `Please add it by hand — or ignore this if the account already exists.`
      );
    }
  }

  // Only once every mail in this window has been dealt with. A crash or a
  // refusal above leaves the mark where it was, so the same window is read
  // again rather than skipped.
  startedAt = tickAt;
  saveCutoff(tickAt);
}

async function main() {
  store.load();
  if (!mailbox.enabled()) {
    say('ERROR: Gmail credentials are not set in .env');
    process.exit(1);
  }
  if (wantCreate && !config.mailbox.autoCreate) {
    say('ERROR: --create needs MAIL_AUTO_CREATE=true in .env');
    process.exit(1);
  }
  say(
    `watching ${config.mailbox.query} — ${wantCreate ? 'WILL CREATE' : 'dry run'}, ` +
      `${boot.resumed ? 'resuming from' : 'first run — starting at'} ` +
      `${new Date(startedAt * 1000).toLocaleString('en-IN')}, every ${everyMs / 1000}s`
  );
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

main().catch((e) => {
  say('watcher crashed: ' + e);
  process.exit(1);
});
