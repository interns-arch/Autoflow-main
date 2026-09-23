#!/usr/bin/env node
'use strict';
// OUR OWN MESSAGE, SENT BACK TO US.
//
// 23 Sep: the bot listed sixty wiper blades, the customer forwarded the list
// straight back, and the bot read its own message as an order and put two of
// them in the cart.
//
// The line these tests hold: a WHOLE message of ours coming back is ignored,
// and one line quoted out of it is not - that is how a customer picks from a
// list, and it has to keep working.
//
//   npm run test:echo
require('dotenv').config();
const path = require('path');
process.env.DATA_DIR = process.env.SCRATCH || path.join(require('os').tmpdir(), 'autoflow-echo-test');
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
require('fs').writeFileSync(path.join(process.env.DATA_DIR, 'state.json'), '{}');
const conversation = require('../src/core/conversation');
const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'bots', 'customerBot.js'), 'utf8');
// lift the two helpers out so they can be exercised without booting a bot
const body = src.slice(src.indexOf('const ECHO_MIN_CHARS'), src.indexOf('function rememberMsg'));
const isEcho = new Function('conversation', body + '; return isOurOwnMessageBack;')(conversation);

const CHAT = 'c@c.us';
const OUR_LIST =
  'wiper blade (60 fit - the first 5):\n\n1. CTWBSI26P-24INCH — 24 Inches · All Cars · All Variants\n   in stock\n' +
  '2. CTWBSI26P-22INCH — 22 Inches · All Cars · All Variants\n   in stock\n3. CTWBSI26P-20INCH — 20 Inches\n   in stock';
conversation.record(CHAT, 'us', OUR_LIST);
conversation.record(CHAT, 'us', 'Your list has 2 item - anything to add, or shall I confirm?');

const cases = [
  ['our whole list, forwarded back', OUR_LIST, true],
  ['our list with a forward header', 'Forwarded\n' + OUR_LIST, true],
  ['our list, rewrapped by WhatsApp', OUR_LIST.replace(/\n+/g, ' '), true],
  ['ONE line quoted to pick it', '1. CTWBSI26P-24INCH — 24 Inches · All Cars · All Variants', false],
  ['a part number on its own', 'CTWBSI26P-24INCH', false],
  ['a real order of their own', 'Cartend wiper blade 16 number 10 pcs, 17 number 10 pcs, 18 number 10 pcs', false],
  ['short reply', 'Price', false],
  ['our short line back', 'Your list has 2 item - anything to add, or shall I confirm?', true],
  ['a long genuine question', 'Bhai mujhe wiper blade chahiye 18 inch wala, Swift Dzire 2019 model ke liye, 10 piece', false],
];
let bad = 0;
for (const [label, text, want] of cases) {
  const got = isEcho(CHAT, text);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? '  ok   ' : '  WRONG') + '  ' + (got ? 'IGNORED ' : 'handled ') + ' ' + label);
}
console.log(bad ? '\n' + bad + ' wrong' : '\nall correct');
process.exit(bad ? 1 : 0);
