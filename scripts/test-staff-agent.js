#!/usr/bin/env node
'use strict';
// THE STAFF AGENT, WITH THE REAL MODEL (founder, 28 Sep: "reply must be
// agentic not deterministic"). A salesman's conversation, played against the
// mock portal and a simulated WhatsApp: nothing reaches a real chat, the live
// portal or Odoo. Needs GEMINI_API_KEY; without it every case is skipped.
//
//   npm run test:staff
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();
process.env.CUSTOMER_BOT_NUMBER = '';
process.env.ENABLE_EXTRA_BOTS = 'false';
process.env.CUSTOMER_TRANSPORT = 'linked';
process.env.WA_CLOUD_TOKEN = '';
process.env.WA_PHONE_NUMBER_ID = '';
process.env.WEBHOOK_RELAY_URL = '';
process.env.DEALER_PORTAL_BASE_URL = '';
process.env.DEALER_PORTAL_TOKEN = '';
process.env.DEALER_PORTAL_USERNAME = '';
process.env.DEALER_PORTAL_PASSWORD = '';
process.env.ODOO_URL = '';
process.env.DATABASE_URL = '';
process.env.VAHAN_API_KEY = '';
process.env.GST_API_KEY = '';

const config = require('../src/config');
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoflow-staff-'));
config.customerSearchBy = 'any';
const SALES = '919000000871';
config.salesTeamNumbers = [SALES];
config.escalationNumber = '917004130460';

const portal = require('../src/integrations/dealerPortal');
const CustomerBot = require('../src/bots/customerBot');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond || !detail ? '' : '\n        ' + String(detail).slice(0, 400)));
};

(async () => {
  if (!config.gemini || !config.gemini.apiKey) {
    console.log('  SKIP  the staff agent needs GEMINI_API_KEY');
    process.exit(0);
  }
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', gst_no: '06AABCK1234L1Z5', phone: '9811122233' }]);
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 100, mrp: 120, vendor: 'K' }]);
  const bot = new CustomerBot();
  await bot.start();
  const chat = 'sim-' + SALES;
  const say = async (body) => {
    bot.transport.outbox.length = 0;
    await bot.transport.injectIncoming({ id: 'wamid.staff-' + Math.random(), from: SALES, chatId: chat, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    const out = bot.transport.outbox.filter((o) => String(o.to || '').indexOf(SALES) >= 0).map((o) => o.text || (o.fileName ? '[file ' + o.fileName + ']' : '')).join('\n---\n');
    console.log('\n  > ' + body + '\n  < ' + out.replace(/\n/g, '\n    '));
    return out;
  };

  console.log('\nA SALESMAN, UNDERSTOOD BY THE STAFF AGENT\n');
  const r1 = await say('order karna hai 9811122233');
  ok('"order karna hai <number>" is understood: it does not ask for the number', !/number bhejiye|send the (customer'?s )?number/i.test(r1) && /Kalra/i.test(r1), r1);
  let r2 = r1;
  if (/Mock Customer/.test(r1) && /Kalra/.test(r1)) r2 = await say((r1.match(/(\d)\.\s*Kalra/) || [])[1] || '2');
  ok('...the order is for Kalra Motors, and the parts are asked for', /Kalra/i.test(r2) && /part/i.test(r2), r2);
  const r3 = await say('16510M65L10 2 pcs');
  ok('parts go into that order, with the portal price', /16510M65L10/.test(r3) && /(₹|Rs\.?)\s?\d/.test(r3), r3);
  const r4 = await say('iska ledger bhi bhej do');
  ok('"iska ledger" is Kalra Motors\' ledger — no number asked', /Kalra/i.test(r4) && !/Kiska ledger|whose ledger/i.test(r4), r4);
  // Odoo is off here, so no PDF can have gone.
  ok('...and it is never said to be sent when no file went', !require('../src/agent/staff')._claimsFileSent(r4) || /\[file /.test(r4), r4);
  const r5 = await say('Customer Testing ke liye naya account banana hai, number 9812345670');
  ok('a new account for a number: the form starts for it, not asking the number again', /9812345670/.test(r5) && !/WhatsApp number bhejiye/i.test(r5), r5);
  ok('the replies are written by the model, not the desk templates', !/^Theek hai, Kalra Motors\. Parts bataiye\.$/m.test(r2));

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
