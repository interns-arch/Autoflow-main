#!/usr/bin/env node
'use strict';
// The 22 Sep wiper-blade case, run end to end against the REAL dealer portal.
//
// What happened that day:
//   customer  "Cartend wiper blade 16 number"   x9 sizes
//   bot       "We could not confirm ... please share the exact part number"
//   Prateek   "Whenever any customer ask for Wiper Blade for Cartrends then it
//              has sizes. 12 INCHES PART NUMBER: CTWBSI26P-12INCH, ..."
//   bot       forwarded that instruction to the customer, word for word
//
// What must happen instead: read it, learn the range, look each size up on the
// portal, and answer the customer with what the portal says.
//
// Writes to a scratch DATA_DIR, so production state is untouched. Sends
// nothing to WhatsApp: the transport is captured.
require('dotenv').config();

const PRATEEK_REPLY =
  'Whenever any customer ask for Wiper Blade for Cartrends then it has sizes. ' +
  '12 INCHES PART NUMBER: CTWBSI26P-12INCH, 14 INCHES PART NUMBER: CTWBSI26P-14INCH,  ' +
  '16 INCHES PART NUMBER: CTWBSI26P-16 Inch, 17 INCHES PART NUMBER: CTWBSI26P-17INCH, ' +
  '18 INCHES PART NUMBER: CTWBSI26P-18INCH, 19 INCHES PART NUMBER: CTWBSI26P-19INCH, ' +
  '20 INCHES PART NUMBER: CTWBSI26P-20INCH, 21 INCHES PART NUMBER: CTWBSI26P-21INCH, ' +
  '22 INCHES PART NUMBER: CTWBSI26P-22INCH, 24 INCHES PART NUMBER: CTWBSI26P-24INCH, ' +
  '26 INCHES PART NUMBER: CTWBSI26P-26INCH';

const HELPER = (process.env.ESCALATION_NUMBER || '919999492550').replace(/\D/g, '');

// --bare: he just types the list, with no swipe-reply and no #id. That is how
// he actually replies, so both paths are worth being able to check.
const BARE = process.argv.includes('--bare');

const escalation = require('../src/core/escalation');
const knowledge = require('../src/core/knowledge');
const availability = require('../src/core/availability');
const store = require('../src/store');

const toCustomer = [];
const toHelper = [];

const transport = {
  number: (process.env.CUSTOMER_BOT_NUMBER || '919289015775').replace(/\D/g, ''),
  mode: 'CLOUD',
  state: 'connected',
  sendText: async (to, t) => {
    toHelper.push(t);
    return 'wamid.H' + toHelper.length;
  },
  sendToChat: async (chatId, t) => {
    toCustomer.push({ chatId, text: t });
    return 'wamid.C' + toCustomer.length;
  },
  onMessage: () => {},
};

const bot = {
  key: 'customer',
  transport,
  inquiryOnly: () => false,
  askToConfirmLater: () => {},
  answerInquiry: async (parts) => 'inquiry: ' + parts.join(', '),
  offerPriced: async (ctx, req, rows) => {
    toCustomer.push({
      chatId: ctx.chatId,
      text: 'SIZES OFFERED:\n' + rows.map((r) => '  ' + r.partNo + '  ' + (r.available ? r.available + ' in stock' : 'nil')).join('\n'),
    });
  },
};
bot._allBots = { customer: bot };

const SIZES = ['16', '17', '18'];
const line = (s) => console.log(s);

(async () => {
  line('\n=========== THE 22 SEP WIPER CASE, REPLAYED ===========\n');

  // ---- 1. customers ask, exactly as they did
  line('1. Customers ask (portal does not recognise the wording):');
  for (const size of SIZES) {
    const item = 'Cartend wiper blade ' + size + ' number';
    await escalation.create(bot, {
      chatId: '9190000000' + size + '@c.us',
      customerPhone: '9190000000' + size,
      item,
      qty: 1,
      kind: 'order',
      reason: 'NOT_IN_CATALOGUE',
      partNo: item,
      customerMessageId: 'wamid.CUST' + size,
    });
    line('   "' + item + '"');
  }
  line('\n   -> messages sent to Prateek sir: ' + toHelper.length + (toHelper.length === 1 ? '   (asked ONCE, not three times)' : ''));

  // ---- 2. Prateek sir answers, once, with the range
  line('\n2. Prateek sir replies with the size list ' + (BARE ? '- typed BARE, no swipe-reply, no #id:' : '(swipe-reply on #1):'));
  toCustomer.length = 0;
  const claimed = await escalation.handleReply({ from: HELPER, body: (BARE ? '' : '#1 ') + PRATEEK_REPLY, isGroup: false });
  line('   accepted as an answer: ' + claimed);

  // ---- 3. what each customer actually received
  line('\n3. What the CUSTOMERS received:');
  if (!toCustomer.length) line('   (nothing)');
  for (const c of toCustomer) {
    const relayed = c.text.includes('Whenever any customer ask');
    line('   ' + c.chatId.padEnd(22) + (relayed ? '*** PRATEEK SIR MESSAGE FORWARDED VERBATIM ***' : c.text.replace(/\n/g, ' | ').slice(0, 88)));
  }

  // ---- 4. what was learned
  line('\n4. What the bot LEARNED:');
  const fams = (store.load().knowledge.families || []).filter((f) => /wiper/i.test(f.subject));
  for (const f of fams) {
    line('   family "' + f.subject + '" with ' + f.variants.length + ' sizes');
    line('     ' + f.variants.map((v) => v.key + '->' + v.partNo).join('  '));
  }
  if (!fams.length) line('   (no family learned)');

  // ---- 5. a NEW customer asks, nobody is asked again
  line('\n5. A NEW customer asks the same way — is Prateek sir asked again?');
  const before = toHelper.length;
  for (const ask of ['Cartend wiper blade 20 number', 'cartrends wiper blade 22', 'wiper blade 24 cartend chahiye']) {
    const hit = knowledge.lookupAlias(ask);
    let portal = '-';
    if (hit) {
      try {
        const r = await availability.resolve([{ item: hit, qty: 1 }]);
        portal = r && r[0] ? availability.describe(r[0], 'x@c.us') : '-';
      } catch (e) {
        portal = 'portal error: ' + String(e.message).slice(0, 40);
      }
    }
    line('   "' + ask + '"');
    line('      resolved part : ' + (hit || 'NOT RESOLVED'));
    line('      portal says   : ' + portal);
  }
  line('\n   -> further messages to Prateek sir: ' + (toHelper.length - before));
  line('\n======================================================\n');
})().catch((e) => {
  console.error('FAILED: ' + (e && e.stack));
  process.exit(1);
});
