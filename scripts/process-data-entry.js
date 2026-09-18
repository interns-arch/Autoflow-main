'use strict';
// Turn approved "[Data Entry] Customer Creation Request" mails into Dealer
// Portal accounts.
//
//   node scripts/process-data-entry.js            # show what it WOULD do
//   node scripts/process-data-entry.js --create   # actually create
//
// Creating is opt-in twice over: this flag AND MAIL_AUTO_CREATE=true in .env.
// Making a customer account is not something a dry run should be one typo away
// from doing, and a duplicate account is messy to unpick in a live portal.
const config = require('../src/config');
const store = require('../src/store');
const mailbox = require('../src/integrations/mailbox');
const portal = require('../src/integrations/dealerPortal');
const cr = require('../src/core/dataEntryRequests');
const naming = require('../src/core/partNaming');

async function main() {
  const args = process.argv.slice(2);
  const wantCreate = args.includes('--create');
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 20;

  if (!mailbox.enabled()) {
    console.error('Mailbox is not configured. Set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in .env.');
    process.exit(1);
  }
  const create = wantCreate && config.mailbox.autoCreate;
  if (wantCreate && !create) {
    console.error('--create was passed but MAIL_AUTO_CREATE is not true in .env. Refusing.');
    process.exit(1);
  }
  console.log(create ? 'MODE: CREATING accounts in the live portal\n' : 'MODE: dry run — nothing will be created\n');

  store.load();
  const mails = await mailbox.fetchRequests({ limit });
  if (!mails.length) {
    console.log('No unread request mails.');
    return;
  }

  let made = 0;
  let skipped = 0;
  // A Gmail thread can hold the same request twice (the approval reply sits in
  // the same thread), and both copies match the search. Creating the account
  // once per copy is exactly the duplicate this whole flow must not produce.
  const seenThisRun = new Set();

  for (const mail of mails) {
    console.log('─'.repeat(70));
    console.log(mail.subject);

    const fields = cr.parseRequest(mail.subject, mail.body);
    if (!fields) {
      console.log('  could not read this mail as a request — left unread');
      skipped++;
      continue;
    }
    const account = cr.buildAccount(fields);

    // Already handled. The token cannot mark mail read, so this is tracked by
    // request id in our own state — which is the better record anyway: it
    // survives someone opening the mail by hand, and it answers "was this one
    // done?" without anybody having to interpret a read/unread flag.
    if (mailbox.isDone(account.requestId)) {
      console.log('  already done earlier — skipping');
      continue;
    }
    if (account.requestId && seenThisRun.has(account.requestId)) {
      console.log('  duplicate copy of a request already handled in this run — skipping');
      continue;
    }
    if (account.requestId) seenThisRun.add(account.requestId);
    const problems = cr.validate(account);

    console.log(`  type      : ${account.kind}`);
    if (account.kind === 'inventory') {
      // The catalogue name in the house style, same as the watcher uses.
      const nm = await naming.nameFor(account);
      Object.assign(account, { standardName: nm.name, nameSource: nm.source, nameCheck: nm.check });
      console.log(`  part no   : ${account.partNo}`);
      console.log(`  part name : ${account.partName}`);
      console.log(`  catalogue : ${account.standardName}  (${nm.source}${nm.check ? ', CHECK' : ''})`);
      console.log(`  brand     : ${account.brand}`);
      console.log(`  mrp       : ${account.mrpValue ?? '-'}   hsn: ${account.hsnCode || '-'}   gst: ${account.gstPercent ?? '-'}%`);
    } else {
      console.log(`  firm      : ${account.name}`);
      console.log(`  username  : ${account.username}`);
      console.log(`  password  : ${account.password}`);
      console.log(`  phone     : ${account.phone}`);
      console.log(`  gst       : ${account.gstNo || '-'}`);
      console.log(`  credit_days  : ${account.creditDays ?? '-'}`);
      console.log(`  credit_limit : ${account.creditLimit ?? '-'}`);
    }

    // Named out loud every time. A PAN that quietly never reaches the portal
    // is the kind of gap that surfaces in an audit a year later.
    const dropped = cr.droppedFields(account);
    if (dropped.length) console.log(`  NOT stored in the portal: ${dropped.join(', ')}`);

    if (problems.length) {
      console.log(`  SKIPPED — ${problems.join('; ')}`);
      skipped++;
      continue;
    }
    // Same rule as the watcher: only a name from the list, or one all its
    // siblings agree on, is created. Anything else is made by hand.
    if (account.kind === 'inventory' && !naming.safeToCreate({ source: account.nameSource, check: account.nameCheck })) {
      console.log('  HELD — the name is not certain; create this part by hand with the right name');
      skipped++;
      continue;
    }
    if (!create) {
      console.log('  would create (dry run)');
      continue;
    }

    try {
      // A VEND- request must never become a customer account. The two live on
      // different endpoints and mean different things to the portal.
      const res =
        account.kind === 'vendor'
          ? await portal.createVendor(account)
          : account.kind === 'inventory'
            ? await portal.createPart(account)
            : await portal.createCustomer(account);
      console.log(`  CREATED — ${account.kind} account ${res.accountId || '(id not returned)'}`);
      // Only now. A crash before this leaves the mail unread and the request
      // is picked up again next run, rather than being lost.
      mailbox.markDone(account.requestId, { kind: account.kind, accountId: res.accountId || res.partNo || null });
      store.log('mailbox', `created "${account.name}" from ${account.requestId}`);
      made++;
    } catch (e) {
      console.log(`  FAILED — ${String((e && e.message) || e).slice(0, 200)}`);
      console.log('  not recorded as done; it will be retried next run');
      skipped++;
    }
  }

  console.log('─'.repeat(70));
  console.log(`${mails.length} mail(s): ${made} created, ${skipped} skipped`);
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
