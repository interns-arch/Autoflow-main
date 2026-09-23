#!/usr/bin/env node
'use strict';
// WHEN A PERSON GETS ASKED, AND WHEN THEY DO NOT.
//
// Founder, 23 Sep: message Prateek sir only when we cannot get the data from
// the dealer portal. These are the rules that came out of that, and the ones
// that are easiest to break by accident later:
//
//   * the same part, asked by three customers, is ONE message to him - and
//     all three still get the answer (the bug this nearly introduced: a
//     suppressed duplicate leaving the second customer waiting forever)
//   * a voice note is never deduplicated - every recording is its own
//     question even though they all carry the label "voice note"
//   * the portal is asked first, and a single confident hit means nobody is
//     disturbed; ambiguous or unreachable means they are
//   * an answer to a business question is accepted without a swipe-reply
//     when exactly one is open, and chatter never reaches a customer
//
//   npm run test:escalation
const path = require('path');
const os = require('os');
process.env.SCRATCH = process.env.SCRATCH || path.join(os.tmpdir(), 'autoflow-esc-test');
require('fs').mkdirSync(process.env.SCRATCH, { recursive: true });
require('fs').writeFileSync(path.join(process.env.SCRATCH, 'state.json'), '{}');
process.env.DATA_DIR = process.env.SCRATCH;
process.env.ESCALATION_NUMBER = '919999492550';
process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.DATABASE_URL = '';

let portalRows = [];
let portalThrows = false;
function stub(mod, exports) {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
stub('../src/integrations/dealerPortal', {
  searchByName: async () => { if (portalThrows) throw new Error('portal down'); return { top: portalRows }; },
  analyze: async (p) => p, commercialAnalyze: async () => null,
});
// The REAL brand check, captured before the stub goes in.
//
// escalation asks the portal by name one last time before disturbing anybody,
// and a single hit that contradicts the question must not be accepted — that
// is how "kya tum log sunday ko khule ho" became a part number. Stubbing this
// out with a function that always says yes would test nothing, so the double
// carries the real rule.
const realMatchTrustworthy = require('../src/core/availability').matchTrustworthy;
stub('../src/core/availability', {
  resolve: async (l) => l.map((x) => ({ item: x.item, partNo: x.item, qty: 1, source: 'available' })),
  describe: (l) => l.item + ' - available',
  matchTrustworthy: realMatchTrustworthy,
});
stub('../src/core/orders', {
  getOrCreateDraft: () => ({ id: 'SO', lines: [] }),
  addLines: (o, l) => o.lines.push(...l),
  ack: (l) => 'added: ' + l.map((x) => x.item).join(', '),
});

const escalation = require('../src/core/escalation');
let toHelper = [];
let toCustomer = [];
const transport = {
  number: '919289015775', mode: 'CLOUD', state: 'connected',
  sendText: async (to, t) => { toHelper.push({ to, t }); return 'wamid.H' + toHelper.length; },
  sendToChat: async (c, t) => { toCustomer.push({ chat: c, t }); return 'w'; },
  onMessage: () => {},
};
const bot = {
  key: 'customer', transport, inquiryOnly: () => false,
  askToConfirmLater: () => {}, answerInquiry: async () => 'inq', offerPriced: async () => {},
};
bot._allBots = { customer: bot };

let pass = 0; const fails = [];
const check = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fails.push(n); console.log('  FAIL  ' + n + (d ? '\n          ' + d : '')); } };
const ask = (item, phone, reason) =>
  escalation.create(bot, { chatId: phone + '@c.us', item, qty: 1, kind: 'order', reason: reason || 'NOT_IN_CATALOGUE', customerPhone: phone, customerMessageId: 'wamid.C' });

(async () => {
  // THE KEY CASE: two customers ask the same part; one ask, BOTH answered.
  escalation._forgetInMemory(); toHelper = []; toCustomer = []; portalRows = [];
  await ask('Cartend wiper blade 16 number', '917000000001');
  await ask('Cartend wiper blade 16 no.', '917000000002');
  await ask('cartend wiper blade 16 number', '917000000003');
  check('three customers, same part -> helper asked ONCE', toHelper.length === 1, 'asked ' + toHelper.length + ' times');

  toCustomer = [];
  await escalation.handleReply({ from: '919999492550', body: '#1 CTWBSI26P-16INCH', isGroup: false });
  const chats = new Set(toCustomer.map((x) => x.chat));
  check('...and ALL THREE customers get the answer',
    chats.has('917000000001@c.us') && chats.has('917000000002@c.us') && chats.has('917000000003@c.us'),
    'answered: ' + [...chats].join(', '));

  // voice notes are never deduped
  escalation._forgetInMemory(); toHelper = [];
  await ask('voice note', '917000000004', 'VOICE');
  await ask('voice note', '917000000005', 'VOICE');
  check('two different voice notes -> helper asked twice', toHelper.length === 2, 'asked ' + toHelper.length);

  // business questions are never deduped
  escalation._forgetInMemory(); toHelper = [];
  await ask('Please collect cheque tomorrow', '917000000006', 'NOT_A_PART');
  await ask('Please collect cheque tomorrow', '917000000007', 'NOT_A_PART');
  check('two business questions -> helper asked twice', toHelper.length === 2, 'asked ' + toHelper.length);

  // portal gate
  escalation._forgetInMemory(); toHelper = []; toCustomer = [];
  portalRows = [{ partNo: 'CTCP-SWIFT-01', name: 'Clutch Plate Swift', available: 4 }];
  const r = await ask('clutch plate swift', '917000000008');
  check('portal has it -> helper NOT asked', toHelper.length === 0 && r && r.fromPortal, JSON.stringify(r));

  // ONE ROW IS NOT THE SAME AS THE RIGHT ROW.
  //
  // Live, 23 Sep: "kya tum log sunday ko khule ho" went to the catalogue,
  // which drops words until something matches, and came back with exactly one
  // row — B102AKYAA01. One row reads as confidence, so the phrase was learned
  // as an alias for that part, permanently. Every customer asking about
  // Sunday opening would have been quoted a body kit.
  //
  // A single hit now has to agree with what was actually asked.
  escalation._forgetInMemory(); toHelper = []; toCustomer = [];
  const aliasesBefore = Object.keys(require('../src/core/knowledge').all().aliases || {}).length;
  portalRows = [{ partNo: 'B102AKYAA01', name: 'AKYAA HO BODY KIT', available: 2 }];
  const q = await ask('kya tum log sunday ko khule ho', '917000000021');
  check(
    'a question that happens to match one part is NOT answered from the catalogue',
    toHelper.length === 1 && !(q && q.fromPortal),
    JSON.stringify(q),
  );
  check(
    '...and that phrase is never learned as a part number',
    Object.keys(require('../src/core/knowledge').all().aliases || {}).length === aliasesBefore,
  );

  escalation._forgetInMemory(); toHelper = [];
  portalRows = [{ partNo: 'A1' }, { partNo: 'B2' }];
  await ask('vague thing', '917000000009');
  check('portal ambiguous -> helper asked', toHelper.length === 1);

  escalation._forgetInMemory(); toHelper = []; portalThrows = true;
  await ask('another vague thing', '917000000010');
  check('portal down -> helper asked', toHelper.length === 1);
  portalThrows = false;

  // business answer without swipe-reply
  escalation._forgetInMemory(); toHelper = []; portalRows = [];
  for (let i = 0; i < 5; i++) await ask('Cartend distinct part ' + i, '91711111000' + i);
  await escalation.create(bot, { chatId: '917000000011@c.us', item: 'Can I return this product?', qty: 1, kind: 'inquiry', reason: 'NOT_A_PART', customerPhone: '917000000011' });
  toCustomer = [];
  const claimed = await escalation.handleReply({ from: '919999492550', body: 'Yes, if unused and within 7 days.', isGroup: false });
  check('business answer with no swipe-reply is accepted', claimed === true && toCustomer.length > 0, 'claimed=' + claimed);

  escalation._forgetInMemory(); toCustomer = [];
  await escalation.create(bot, { chatId: 'x@c.us', item: 'Warranty?', qty: 1, kind: 'inquiry', reason: 'NOT_A_PART', customerPhone: '917000000012' });
  toCustomer = [];
  const chat = await escalation.handleReply({ from: '919999492550', body: 'ok dekh lunga', isGroup: false });
  check('chatter never reaches a customer', chat === false && toCustomer.length === 0, 'claimed=' + chat);

  // --- a SHORTCUT part number: learned once, then recognised however it is typed
  const knowledge = require('../src/core/knowledge');
  escalation._forgetInMemory(); toHelper = []; portalRows = [];
  await ask('CTWB 18', '917000000021');
  await escalation.handleReply({ from: '919999492550', body: '#1 CTWBSI26P-18INCH', isGroup: false });
  check('a shortcut part number is saved against the real one',
    knowledge.lookupAlias('CTWB 18') === 'CTWBSI26P-18INCH', 'got ' + knowledge.lookupAlias('CTWB 18'));
  check('...and is found when retyped without the space',
    knowledge.lookupAlias('CTWB18') === 'CTWBSI26P-18INCH', 'got ' + knowledge.lookupAlias('CTWB18'));
  check('...but a DIFFERENT number never borrows from it',
    !knowledge.lookupAlias('CTWB180') && !knowledge.lookupAlias('CTWB 19'),
    'CTWB180 -> ' + knowledge.lookupAlias('CTWB180') + ', CTWB 19 -> ' + knowledge.lookupAlias('CTWB 19'));

  // --- "not available" is an answer too, and must not be asked twice
  escalation._forgetInMemory(); toHelper = []; toCustomer = [];
  await ask('OBSOLETE-STRUT-77', '917000000022');
  await escalation.handleReply({ from: '919999492550', body: '#1 no', isGroup: false });
  escalation._forgetInMemory(); toHelper = []; toCustomer = [];
  await ask('OBSOLETE-STRUT-77', '917000000023');
  check('a part he already refused does NOT reach him again',
    toHelper.length === 0, 'helper messages: ' + toHelper.length);
  check('...and that customer is still told, straight away',
    toCustomer.some((x) => /not available|available nahi/i.test(String(x.t))),
    JSON.stringify(toCustomer.map((x) => String(x.t).slice(0, 60))));


  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  process.exit(fails.length ? 1 : 0);
})();
