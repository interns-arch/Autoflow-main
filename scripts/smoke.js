'use strict';
// End-to-end smoke test of the SALES BOT in simulation mode, against the
// MOCK Dealer Portal. Run with: npm run smoke
// Uses a throwaway data dir — never touches data/.
// Hermetic: force SIMULATION + mock portal no matter what the real .env says.
process.env.CUSTOMER_BOT_NUMBER = '';
process.env.ENABLE_EXTRA_BOTS = 'false';
process.env.CUSTOMER_TRANSPORT = 'linked'; // never the live Cloud API
process.env.GREETING_NUDGE_SEC = '3'; // 75s live; the suite cannot wait that long
process.env.CONFIRM_NUDGE_SEC = '5'; // 40s live
process.env.WA_CLOUD_TOKEN = '';
process.env.WA_PHONE_NUMBER_ID = '';
process.env.WEBHOOK_RELAY_URL = '';
process.env.DEALER_PORTAL_BASE_URL = ''; // force mock portal
process.env.DEALER_PORTAL_TOKEN = '';
process.env.DEALER_PORTAL_USERNAME = '';
process.env.DEALER_PORTAL_PASSWORD = '';
// Number-plate lookups run against data/mock-vehicles.json, never Cashfree:
// the live API is IP-whitelisted and would fail here for a reason that has
// nothing to do with the code under test.
process.env.VAHAN_API_KEY = '';
// GSTIN lookups are metered (a live key spends a credit per call) and the
// register is a third party we must not depend on to pass. Blanked here; the
// prefill path is tested below against a stub instead.
process.env.GST_API_KEY = '';
// The house account used to read portal MRP for an unregistered customer.
// Blanked with the rest of the portal settings: the rate tests below stub
// Odoo and assert the fallback, and a real value in .env would quietly send
// them down the portal path instead.
process.env.DEALER_PORTAL_ACCOUNT_ID = '';
process.env.ANTHROPIC_API_KEY = ''; // deterministic parsers only
process.env.ODOO_URL = ''; // no live ERP either - MRP and ledgers are stubbed below
process.env.ODOO_DB = '';
process.env.ODOO_USERNAME = '';
process.env.ODOO_API_KEY = '';
process.env.GEMINI_API_KEY = ''; // voice notes are not transcribed in the suite
// The photo tests read the fixture with LOCAL OCR — with both AI keys blanked
// above there is no vision path, so this is the only reader left. It used to
// be inherited: config defaults ai.ocr to true on win32, so the suite passed
// here and would have failed on Linux. Pinned so the result no longer depends
// on the machine, or on whatever AI_OCR happens to say in .env.
process.env.AI_OCR = 'on';
process.env.ORDER_CONFIRM_ENABLED = 'true'; // mock portal — safe to punch here

const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('../src/config');
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoflow-smoke-'));
config.customerDms = ['919899555001'];
config.adminNumbers = ['919800000009'];
config.escalationNumber = '917004130460';
config.groupDefaultMembers = ['919800000777']; // a Cartrends staff member sitting in every group

const store = require('../src/store');
const portal = require('../src/integrations/dealerPortal');
const knowledge = require('../src/core/knowledge');
const inquiries = require('../src/core/inquiries');
const orders = require('../src/core/orders');
const availability = require('../src/core/availability');
const CustomerBot = require('../src/bots/customerBot');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name);
  if (!cond) failures++;
}
const lastOut = (bot) => (bot.transport.outbox[bot.transport.outbox.length - 1] || {}).text || '';
const sent = (bot) => bot.transport.outbox.map((o) => o.text).join('\n---\n');

// The bot asks "Confirm karun?" once the customer stops adding - a timer
// these tests switch off (CONFIRM_NUDGE_SEC=3600). This marks the ask the
// way that nudge would, so a yes can place the order. Without an ask the
// bot asks instead of ordering, which is the rule SO 626 cost us.
const markAsked = (chatId) => {
  const o = require('../src/core/orders').findDraft(chatId);
  if (o) {
    o.confirmAskedAt = new Date().toISOString();
    require('../src/store').save();
  }
};

async function dm(bot, from, body) {
  await bot.transport.injectIncoming({
    from,
    chatId: 'sim-' + from,
    chatName: '',
    isGroup: false,
    body,
    hasMedia: false,
    mediaType: 'chat',
  });
}
async function group(bot, from, body) {
  await bot.transport.injectIncoming({
    from,
    chatId: 'simgroup-delhi dealers',
    chatName: 'Delhi Dealers',
    isGroup: true,
    body,
    hasMedia: false,
    mediaType: 'chat',
  });
}

async function main() {
  console.log('\n--- Cartrends AutoFlow smoke test: SALES BOT + mock Dealer Portal ---\n');

  // The mock portal's "stock" — stands in for DP's analyze API.
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 3, price: 210, mrp: 280, vendor: 'Mohan' },
    { part_no: '22400M74L00', name: 'Clutch Plate Swift', quantity: 12, price: 1850, mrp: 2400, vendor: 'Northend' },
    // KNOWN to the portal but ZERO stock — the founder's AC-gas case. This is
    // a sale loss, NOT a question for a human.
    { part_no: 'ACG-R134', name: 'AC Gas', quantity: 0, price: 0, mrp: 0, vendor: '' },
  ]);

  // The bot only speaks in groups IT created, so register the test group the
  // same way a real one would be — no whitelist involved.
  require('../src/core/groups').record({
    groupId: 'simgroup-delhi dealers',
    subject: 'Delhi Dealers',
    customer: '919899000888',
  });

  const customer = new CustomerBot();
  const bots = { customer };
  require('../src/core/admin').attach(bots);
  const escalation = require('../src/core/escalation');
  escalation.attach(bots);
  await customer.start();

  const CUST = '919899555001';

  // ---- 1. availability from the portal ----
  console.log('[1] availability check');
  await dm(customer, CUST, 'brake pad available?');
  check('quotes availability from the portal', /available/i.test(lastOut(customer)));
  check('no local stock table is used', store.load().internalStock === undefined);

  // ---- 2. order -> draft ----
  console.log('\n[2] order capture');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Brake Pad - 5\nOil Filter - 10');
  const draftMsg = lastOut(customer);
  check('draft created and shown', /Brake Pad x ?5/i.test(draftMsg));
  check('partial line flagged (only 3 of 10 oil filters)', /only 3 available/i.test(draftMsg) && !/rest on order/i.test(draftMsg));

  // ---- 3. modification ----
  console.log('\n[3] in-chat modification');
  await dm(customer, CUST, 'Brake Pad to 8');
  check('quantity updated', /Brake Pad x ?8/i.test(lastOut(customer)));
  await dm(customer, CUST, 'remove oil filter');
  check('line removed', !/Oil Filter/i.test(lastOut(customer)));

  // ---- 4. sale-loss logging ----
  console.log('\n[4] sale loss (the founder\'s AC-gas problem)');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'AC Gas - 4');
  const lost = inquiries.lostSales(1);
  check('unavailable item recorded as sale loss', lost.some((r) => /ac gas/i.test(r.item)));
  check('customer told it is on order ~1 week', /1 week|on order/i.test(sent(customer)));

  // ---- 5. confirm -> SO punched ----
  console.log('\n[5] confirmation punches the sales order');
  customer.transport.outbox.length = 0;
  markAsked('sim-' + CUST);
  await dm(customer, CUST, 'yes');
  // The yes punches the order and it comes back as a DRAFT to check: on
  // the portal it is pending, nothing allocated (12 Sep, founder).
  const confirmMsg = sent(customer);
  check('SO number returned to the customer', /SO-\d+/.test(confirmMsg));
  check('...as a draft SO for the customer to check', /draft so/i.test(confirmMsg));
  const order = store.orders().find((o) => o.status === 'confirmed');
  check('order marked confirmed with an SO number', Boolean(order && order.soNumber));
  // Founder, 14 Sep: only what is in stock is punched; the rest is said, never "reserved".
  check('the punch message is only "Draft SO X ready" - nothing about what stayed out', !/reserved|reserve hai|not in stock|stock mein nahi|jitna stock|in the SO for what/i.test(confirmMsg));
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'yes');
  check('the yes on the draft SO confirms it, and packing starts', /confirm ho gaya|confirmed/i.test(sent(customer)));

  // ---- 5b. stale quote: stock moved between the check and the YES ----
  console.log('\n[5b] stale quote — stock moved before confirm');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Brake Pad - 4');
  const draft = orders.findDraft('sim-' + CUST);
  // pretend the quote was given 2 hours ago, and the shelf emptied since
  draft.quotedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  store.save();
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 1, price: 450, mrp: 600, vendor: 'Northend' },
  ]);
  customer.transport.outbox.length = 0;
  markAsked('sim-' + CUST);
  await dm(customer, CUST, 'yes');
  const staleMsg = lastOut(customer);
  check('customer is told the stock changed', /stock changed/i.test(staleMsg));
  check('new quantity shown', /only 1 available/i.test(staleMsg) && !/rest on order/i.test(staleMsg));
  check('order NOT placed on the refresh message', !/Sales Order number/i.test(staleMsg));
  check('draft still open for a fresh yes', orders.findDraft('sim-' + CUST) !== null);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'yes'); // now they agree to the figure they were shown
  check('second YES places the order as a draft SO', /draft so/i.test(sent(customer)));
  await dm(customer, CUST, 'yes');

  // ---- 5b-ii. No ask, no order ----
  // 12 Sep: the "Confirm karun?" lived in a setTimeout, a deploy restarted
  // the bot, the question never went out, and the customer next "Ok" -
  // meaning "ok, noted" - punched SO 626.
  // ---- 5b-iii. a confirm while another question is open ----
  // 12 Sep: the bot asked "4 items in the order. Confirm sir?", the
  // customer sent a photo, the bot asked "Kaunsi gaadi?" about it, and the
  // customer swipe-replied "Yes confirm" - which was read as the name of a
  // car. The order never went in.
  // ---- 5b-iv. a label read as "number + name" ----
  // 12 Sep: a photo of a Maruti box was read as "11610M55RA1 MOUNTING COMP
  // ENG RH". The name search found 33 matches and the bot asked "Kaunsi
  // gaadi?" - about a part the portal knows perfectly well.
  // ---- 5b-v. the confirm question shows the list ----
  // 12 Sep: "11 items in the order. Confirm sir?" hid four items left over
  // from a list started 19 minutes earlier. The yes bought them (SO 632).
  console.log('\n[5b-v] the confirm question shows what will be ordered');
  await dm(customer, CUST, 'Brake Pad - 2');
  customer.transport.outbox.length = 0;
  await customer.askToConfirmNow({ chatId: 'sim-' + CUST, from: CUST, isGroup: false });
  const askText5 = lastOut(customer);
  check('the question lists the parts, not just a count', /Brake Pad/i.test(askText5) && /confirm/i.test(askText5));
  check('...no bare item count stands in for the list', !/\d+ items? in the order/i.test(askText5));
  check('...and asking is what lets a yes place it', Boolean(orders.findDraft('sim-' + CUST).confirmAskedAt));

  console.log('\n[5b-iv] a label that carries the number AND the name');
  check('the part number is picked out of a longer line', require('../src/core/ai').partNumberIn('11610M55RA1 MOUNTING COMP ENG RH') === '11610M55RA1');
  check('a plain name has none', require('../src/core/ai').partNumberIn('brake pad for swift') === null);
  check('a quantity with its unit is not a part number', require('../src/core/ai').partNumberIn('40pcs') === null);
  customer.transport.outbox.length = 0;
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter', quantity: 12, price: 105, mrp: 130, vendor: 'Northend' }]);
  await dm(customer, CUST, '16510M65L10 OIL FILTER ASSY 2');
  check('a label line is priced by its part number', /16510M65L10/i.test(sent(customer)));
  check('...and nobody is asked "Kaunsi gaadi?" about it', !/kaunsi gaadi|which vehicle/i.test(sent(customer)));
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 1, price: 450, mrp: 600, vendor: 'Northend' }]);

  console.log('\n[5b-iii] a confirm while Kaunsi gaadi is open');
  const clarify5 = require('../src/core/clarify');
  clarify5.ask('sim-' + CUST, { base: 'brake pad', qty: 1 }, { text: 'Kaunsi gaadi?', key: 'vehicle' });
  check('"wagonr" is read as the answer to it', clarify5.isAnswerTo('sim-' + CUST, 'wagonr'));
  check('"Yes confirm" is NOT', !clarify5.isAnswerTo('sim-' + CUST, 'Yes confirm'));
  check('"haan" is NOT', !clarify5.isAnswerTo('sim-' + CUST, 'haan'));
  check('"cancel" is NOT', !clarify5.isAnswerTo('sim-' + CUST, 'cancel'));
  check('but "haan wagonr" still is', clarify5.isAnswerTo('sim-' + CUST, 'haan wagonr'));
  clarify5.clear('sim-' + CUST);

  console.log('\n[5b-ii] a yes nobody was asked for');
  await dm(customer, CUST, 'Brake Pad - 1');
  const unasked = orders.findDraft('sim-' + CUST);
  check('a fresh draft carries no ask', !unasked.confirmAskedAt);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'ok');
  check('an unasked ok does NOT place the order', !/Sales Order number/i.test(sent(customer)));
  check('...the bot shows the list and asks instead', /place this order|punch kar dun/i.test(lastOut(customer)));
  check('...and the ask is written on the draft, so a restart cannot lose it', Boolean(orders.findDraft('sim-' + CUST).confirmAskedAt));
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'ok');
  check('the ok AFTER the question places it', /draft so/i.test(sent(customer)));
  await dm(customer, CUST, 'yes');

  // ---- 5b-vi. the draft SO: check it, correct it, confirm it ----
  // Founder, 12 Sep: "maine yes bola to draft SO bhejna tha, phir confirm
  // krvana tha". The order sits on the portal as pending - nothing
  // allocated - until it is called right. A line cannot be taken out of a
  // punched order (PUT is ignored by the portal, tried on 632 and 633), so
  // the order is cancelled and the rest punched again.
  console.log('\n[5b-vi] the draft SO is checked before anything is allocated');
  const soReview6 = require('../src/core/soReview');
  const REV = '919000000266';
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 40, price: 210, mrp: 280, vendor: 'Mohan' },
  ]);
  const docs6 = [];
  const hadDoc6 = customer.transport.sendDocument;
  customer.transport.sendDocument = async (chatId, buf, name) => { docs6.push(name); };
  await dm(customer, REV, 'Brake Pad - 2\nOil Filter - 1');
  markAsked('sim-' + REV);
  customer.transport.outbox.length = 0;
  await dm(customer, REV, 'yes');
  check('the yes punches it and the draft SO comes back', /draft so/i.test(sent(customer)));
  check('...as the portal own document', docs6.length === 1 && /^Draft SO /.test(docs6[0]));
  const rev6 = soReview6.get('sim-' + REV);
  check('...and the lines it was punched from are kept, to punch again if needed', !!rev6 && rev6.lines.length === 2);
  // Asked for by name: sent again, and never handed to a person.
  customer.transport.outbox.length = 0;
  await dm(customer, REV, 'pdf mai bhejo');
  check('a PDF asked for is the PDF sent again', docs6.length === 2 && /sahi hai|all good/i.test(sent(customer)));
  check('...and it never becomes a question for a person', !/team ko bata|note kar liya/i.test(sent(customer)));
  const realPdf6 = portal.soPdf;
  portal.soPdf = async () => null;
  customer.transport.outbox.length = 0;
  await dm(customer, REV, 'pdf bhej do');
  // The Odoo SO print only exists once the order reaches billing (order 641,
  // 12 Sep: confirmed, no SO for ten minutes). Until then the bill is the
  // document, if there is one.
  check('with no SO print, the bill goes instead', docs6.length === 3 && /^Bill /.test(docs6[2]) && /bill hai|that is the bill/i.test(sent(customer)));
  const realBill6 = portal.invoicePdf;
  portal.invoicePdf = async () => null;
  customer.transport.outbox.length = 0;
  await dm(customer, REV, 'pdf bhej do');
  check('with neither, it says what is true and sends nothing', /billing tak pahunchne par|reaches billing/i.test(sent(customer)) && docs6.length === 3);
  portal.invoicePdf = realBill6;
  portal.soPdf = realPdf6;
  const first6 = rev6.orderIds[0];
  portal._setMockOrderLines(String(first6).replace(/[^0-9]/g, ''), [
    { part_no: 'BP-1001', quantity: 2, dealer_id: 23, price: 450, tat_days: 0 },
    { part_no: 'OF-2002', quantity: 1, dealer_id: 23, price: 210, tat_days: 0 },
  ]);
  customer.transport.outbox.length = 0;
  await dm(customer, REV, '2 hata do');
  check('an item named by its number is taken out', /OF-2002/.test(sent(customer)));
  const rev6b = soReview6.get('sim-' + REV);
  check('...the punched order is replaced, not edited', !!rev6b && rev6b.orderIds[0] !== first6);
  check('...and only what is left is punched again', !!rev6b && rev6b.lines.length === 1 && /BP-1001/i.test(rev6b.lines[0].partNo || rev6b.lines[0].item));
  check('...with a fresh draft SO to check', /draft so/i.test(sent(customer)) && docs6.length === 4);
  customer.transport.outbox.length = 0;
  await dm(customer, REV, 'haan');
  check('the yes on the draft SO confirms it', /confirm ho gaya|confirmed/i.test(sent(customer)));
  check('...and the CONFIRMED SO document follows it', docs6.length === 5 && /^SO /.test(docs6[4]));
  check('...and the draft is closed', !soReview6.get('sim-' + REV));

  // A draft the customer turns down is taken back, not left on the portal.
  portal._setMockOrderLines('701', [{ part_no: 'BP-1001', quantity: 1, dealer_id: 23, price: 450, tat_days: 0 }]);
  soReview6.open('sim-' + REV, { orderIds: ['701'], phone: REV });
  customer.transport.outbox.length = 0;
  await dm(customer, REV, 'cancel');
  check('a cancel takes the order back', /cancel kar diya|cancelled/i.test(sent(customer)));
  check('...and closes the draft', !soReview6.get('sim-' + REV));
  customer.transport.sendDocument = hadDoc6;
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 1, price: 450, mrp: 600, vendor: 'Northend' }]);

  // ---- 5b-vii. the portal refusing to punch ----
  // A credit hold is not a breakdown: the customer hears what it is, and
  // the people who can clear it are actually told (core/punchRefused).
  console.log('\n[5b-vii] an order the portal refuses on credit');
  const BLOCKED = '919000000267';
  const realConfirm7 = portal.confirm;
  portal.confirm = async () => {
    const e = new Error('Dealer Portal POST /purchase-orders/confirm -> HTTP 409');
    e.status = 409;
    e.body = {
      detail: {
        message: 'Customer credit control blocked order confirmation.',
        credit_control: { allowed: false, block_reasons: ['ONE_DAY_OPEN_EXPOSURE'], account_id: 8191, account_name: 'Mock Customer' },
      },
    };
    throw e;
  };
  // Account 8191 on 12 Sep: blocked, and yet nothing owed - one order was
  // already open on a 1-day credit term. The portal is asked, not guessed.
  portal._setMockCredit({
    allowed: false,
    block_reasons: ['ONE_DAY_OPEN_EXPOSURE'],
    account_id: 8191, account_name: 'Mock Customer',
    credit_days: 1, credit_limit: 100000,
    open_invoice_residual: 0, net_receivable_amount: 0, uncovered_overdue_amount: 0,
    pending_invoices: [], overdue_invoices: [],
    pipeline_order_amount: 1688.58,
    pipeline_orders: [{ portal_order_id: 633, odoo_so_name: '235954', amount: 1688.58 }],
    available_credit_after_pdc: 98311.42,
    configuration_blocked: false, credit_days_blocked: false, single_order_blocked: true, credit_limit_blocked: false,
  });
  const alerts7 = [];
  const hadText7 = customer.transport.sendText;
  customer.transport.sendText = async (to, text) => { alerts7.push({ to, text }); };
  await dm(customer, BLOCKED, 'Brake Pad - 1');
  markAsked('sim-' + BLOCKED);
  customer.transport.outbox.length = 0;
  await dm(customer, BLOCKED, 'yes');
  check('the customer hears one short line, and no reason at all', /system order accept nahi|system is not taking/i.test(sent(customer)) && !/credit/i.test(sent(customer)));
  check('...no SO number is invented', !/SO-/.test(sent(customer)));
  check('...the admins are really told, with the reason', alerts7.length === config.adminNumbers.length && /already open/i.test(alerts7[0].text));
  check('...and that nothing is owed, so nobody chases the customer for money', /Owed: nothing/.test(alerts7[0].text) && /633 . SO 235954/.test(alerts7[0].text));
  check('...and it only says the team is on it because the team was', /team dekh rahi|team is on it/i.test(sent(customer)));
  check('...and it never asks a customer who owes nothing to clear a payment', !/pending|clear/i.test(sent(customer)));
  check('...the draft is kept, so a yes after it is cleared still works', !!orders.findDraft('sim-' + BLOCKED));
  // The other kind: money really is pending. Then it IS the customer to
  // ask - the same thing the team says on the phone.
  alerts7.length = 0;
  portal._setMockCredit({
    allowed: false,
    block_reasons: ['OVERDUE_INVOICES'],
    account_id: 8191, account_name: 'Mock Customer',
    credit_days: 1, credit_limit: 100000,
    open_invoice_residual: 43500, net_receivable_amount: 43500, uncovered_overdue_amount: 43500,
    pending_invoices: [{ name: 'CT-1' }], overdue_invoices: [{ name: 'CT-1', amount: 43500 }],
    pipeline_order_amount: 0, pipeline_orders: [],
    available_credit_after_pdc: 56500,
    configuration_blocked: false, credit_days_blocked: false, single_order_blocked: false, credit_limit_blocked: true,
  });
  customer.transport.outbox.length = 0;
  markAsked('sim-' + BLOCKED);
  await dm(customer, BLOCKED, 'yes');
  check('a customer who really owes money is told so, plainly', /pichhla payment.*pending|payment is still pending/i.test(sent(customer)));
  check('...with what happens next, and no lecture', /clear hote hi laga dunga|place it right away/i.test(sent(customer)));
  check('...and the admins get the figure', /43,500/.test(alerts7[0].text) && /payment pending/i.test(alerts7[0].text));
  alerts7.length = 0;
  portal._setMockCredit(null);
  portal.confirm = async () => { throw new Error('Dealer Portal POST /purchase-orders/confirm -> HTTP 500 upstream'); };
  customer.transport.outbox.length = 0;
  markAsked('sim-' + BLOCKED);
  await dm(customer, BLOCKED, 'yes');
  check('any other refusal reads the same to the customer, and still reaches a person', /system order accept nahi|system is not taking/i.test(sent(customer)) && alerts7.length > 0);
  customer.transport.sendText = hadText7;
  portal.confirm = realConfirm7;

  // ---- 5c. GROUP safety: only the customer's unmistakable YES orders ----
  console.log('\n[5c] group — staff are not customers, filler words do not confirm');
  const STAFF = '919800000777';
  const GCUST = '919899000888';
  customer.transport.outbox.length = 0;
  await group(customer, STAFF, 'Brake Pad - 5');
  check('staff message in group is ignored (no draft, no reply)', customer.transport.outbox.length === 0);
  await group(customer, GCUST, 'Brake Pad - 5');
  check('customer message in group creates a draft', /Brake Pad x ?5/i.test(lastOut(customer)));
  customer.transport.outbox.length = 0;
  await group(customer, STAFF, 'yes');
  check('staff "yes" does NOT confirm the customer\'s order', !/Sales Order number/i.test(sent(customer)));
  await group(customer, GCUST, 'ok');
  check('customer "ok" (filler) does NOT confirm in a group', !/Sales Order number/i.test(sent(customer)));
  await group(customer, GCUST, 'thik hai');
  check('customer "thik hai" does NOT confirm in a group', !/Sales Order number/i.test(sent(customer)));
  await group(customer, GCUST, 'yes');
  // In a group the bot never nudges, so the first yes brings the question.
  check('a group yes brings the question first', /place this order|punch kar dun/i.test(lastOut(customer)));
  customer.transport.outbox.length = 0;
  await group(customer, GCUST, 'yes');
  check('customer explicit "yes" DOES place it in a group', /draft so/i.test(sent(customer)));

  // ---- 5c. REAL customer message formats ----
  // Har line seedhe Kalra Motor / Car Place Noida / Lagan Motors ki
  // WhatsApp chat se uthayi hui hai. Yeh regression guard hai — customer
  // aise hi likhte hain, aur parser inhe todna nahi chahiye.
  console.log('\n[5c] asli chats ke message formats');
  const ai = require('../src/core/ai');
  const formats = [
    ['57611M68P00 1', [['57611M68P00', 1]]],
    ['43401m68p01 2', [['43401m68p01', 2]]],                       // lowercase
    ['10pcs timing seal 16141M68K00', [['16141M68K00', 10]]],      // qty pehle
    ['10pcs dicky latch dzire 82500M75L00', [['82500M75L00', 10]]],
    ['Bill no. 2565', []],                                          // bill, order nahi
    ['Send 4pc', []],
    ['Jai mata di ram ram ji', []],                                 // greeting
  ];
  // Conversation must NEVER become a part lookup. This exact message once
  // made the bot search the portal for "nhi ye batao".
  const chat = await ai.parseCustomerMessage('Available hai ki nhi ye batao', []);
  check('plain conversation is not looked up as a part', chat.noPart === true && (chat.items || []).length === 0);
  let fmtOk = 0;
  for (const [msg, want] of formats) {
    const p = await ai.parseCustomerMessage(msg, []);
    const got = [...(p.lines || []), ...(p.items || []).map((i) => ({ item: i, qty: 1 }))];
    const norm = (x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ok =
      got.length === want.length &&
      want.every(([part, q], i) => norm(got[i].item) === norm(part) && got[i].qty === q);
    if (ok) fmtOk++;
    else console.log(`      MISMATCH ${JSON.stringify(msg)} -> ${JSON.stringify(got)}`);
  }
  check(`real chat formats parsed correctly (${fmtOk}/${formats.length})`, fmtOk === formats.length);

  // ---- 5d. photo caption carries the quantity ----
  // Kalra Motor chat: customer sends a picture of the part, caption is just
  // "2pc" / "3pise". The part is in the image, the number in the caption.
  console.log('\n[5d] photo + caption');
  const png = fs.readFileSync(path.join(__dirname, 'fixtures', 'test_order.png')).toString('base64');
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: CUST, chatId: 'sim-' + CUST, chatName: '', isGroup: false,
    body: '3pise', hasMedia: true, mediaType: 'image',
    mediaBase64: png, mediaMime: 'image/png',
  });
  const photoMsg = lastOut(customer);
  check('photo read into an order', /Your order from the photo/i.test(photoMsg));
  // This fixture's image ALREADY carries quantities ("Brake Pad - 5"), so the
  // caption must NOT overwrite them — a number the customer wrote inside the
  // picture beats a loose one in the caption.
  check('image quantities win over the caption', /Brake Pad x ?5/i.test(photoMsg));
  // And the caption-only path is unit-tested directly:
  check('bare caption quantities parsed', ai.bareQty('3pise') === 3 && ai.bareQty('2pc') === 2 && ai.bareQty('Ye hai ji') === null);

  // ---- 6. two-status rule ----
  console.log('\n[6] status replies (founder: only TWO statuses)');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'order kahan hai');
  const st = lastOut(customer);
  check('no vendor-leg detail leaks to the customer', !/vendor|invoiced|in_transit|billed/i.test(st));
  // Later sections added more orders to this same chat, and orderStatus
  // reports the LATEST non-cancelled one — so mark exactly that.
  const latest = [...store.orders()].reverse().find((o) => o.chatId === 'sim-' + CUST && o.status !== 'cancelled');
  latest.status = 'packed';
  store.save();
  await dm(customer, CUST, 'status');
  check(
    'packed status reported',
    /packed and ready for dispatch|pack ho gaya hai, dispatch ke liye taiyar/i.test(lastOut(customer))
  );

  // ---- 7. escalation learns permanently ----
  console.log('\n[7] escalation is asked ONCE, then learned forever');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'clutch set dzire petrol - 2');
  const askedText = sent(customer);
  check('helper was asked', askedText.includes('Question *#'));
  // read the real escalation id rather than assuming it is E1
  const eid = (askedText.match(/\*#(\d+)\*/) || [])[1];
  check('escalation id captured', Boolean(eid));
  // helper answers with the real part number
  await dm(customer, '917004130460', `E${eid} 22400M74L00`);
  check('answer learned permanently', knowledge.lookupAlias('clutch set dzire petrol') === '22400M74L00');

  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'clutch set dzire petrol - 3');
  check('same question NOT escalated again', !sent(customer).includes('Question *#'));
  check('answered straight from memory', /Clutch Plate Swift|confirm/i.test(sent(customer)));

  // The customer must never be left staring at an empty chat. A message whose
  // every line went to a human used to produce no reply at all — the helper
  // was being asked in the background and the customer saw nothing.
  console.log('\n[7b] a customer is never left in silence');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'gadi ka wo wala part - 1');
  check('unresolvable item still gets an answer', customer.transport.outbox.length > 0);
  check('name lookup is attempted before giving up', availability.isNameQuery('brake pad') === true);
  check('a part number is not sent to the name search', availability.isNameQuery('13780M68P01') === false);

  // ---- 6c. the master switch actually stops a real order ----
  // Every stray "yes" during live testing created an order someone had to
  // cancel by hand. The switch is checked before the portal is touched, so
  // there is no path from a customer message to a real order while it is off.
  console.log('\n[6c] ORDER_CONFIRM_ENABLED master switch');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Brake Pad - 2');
  const switchDraft = orders.findDraft('sim-' + CUST);
  config.dealerPortal.confirmEnabled = false;
  const blocked = await orders.confirm(switchDraft);
  check('confirm is refused while the switch is off', blocked.blocked === true);
  check('the draft is kept, not cancelled', orders.findDraft('sim-' + CUST) !== null);
  check('no SO number was issued', !switchDraft.soNumber);
  customer.transport.outbox.length = 0;
  markAsked('sim-' + CUST);
  await dm(customer, CUST, 'yes');
  check(
    'customer gets an acknowledgement, not an SO',
    !/SO-\d+/.test(lastOut(customer)) && /noted your order|order note kar liya/i.test(lastOut(customer))
  );
  config.dealerPortal.confirmEnabled = true; // back on for the rest of the run

  // ---- 6b. the confirm response is read the way the portal actually sends it ----
  // The portal replies {primary_order:{order_id}}. Reading only top-level
  // so_number/order_number/id found nothing and threw, so the customer was told
  // "our system did not accept it" for orders that had in fact been created —
  // three of them existed in the portal before this was caught.
  console.log('\n[6b] confirm response shape');
  const readConfirm = require('../src/integrations/dealerPortal')._readConfirmResponse;
  check(
    'order number is read from primary_order.order_id',
    readConfirm({ primary_order: { order_id: 20800001, status: 'confirmed' } }).soNumber === '20800001'
  );
  check(
    'falls back to a top-level order number',
    readConfirm({ so_number: 'SO-123' }).soNumber === 'SO-123'
  );
  check(
    'the unallocated order is reported too',
    readConfirm({ primary_order: { order_id: 1 }, unallocated_order: { order_id: 2 } }).unallocatedOrderId === 2
  );
  check('odoo sync status is carried back', readConfirm({ primary_order: { order_id: 1 }, odoo_sync_status: 'linked' }).odooSyncStatus === 'linked');
  let threw = '';
  try {
    readConfirm({ weird: 1, shape: 2 });
  } catch (e) {
    threw = e.message;
  }
  check('an unrecognised response names its own keys', /weird,shape/.test(threw));

  // ---- 7g. the part number written INSIDE the description ----
  // Customers write "wiper bottel pipe 38402M72R00". Sending that whole phrase
  // to the portal as a part number found nothing, so 60 of 74 escalations in
  // one replay were questions a person had no reason to be asked.
  console.log('\n[7g] part numbers embedded in the customer\'s words');
  check('number is taken out of the description', availability.extractPartNo('wiper bottel pipe 38402M72R00') === '38402M72R00');
  check('a trailing pack suffix is kept', availability.extractPartNo('hendal 82802M81A60-5pk') === '82802M81A60-5pk');
  check('a model year is not mistaken for a part', availability.extractPartNo('rear shocker swift 2025 model 41800m75t00') === '41800m75t00');
  check('a quantity prefix does not confuse it', availability.extractPartNo('10pcs dicky latch dzire 82500M75L00') === '82500M75L00');
  check('a pure description yields nothing', availability.extractPartNo('xuv 300 parts') === null);
  check('a plain name yields nothing', availability.extractPartNo('brake pad') === null);

  // ---- 7f. the four things that made it read like a machine ----
  console.log('\n[7f] conversation quality');
  const clarify2 = require('../src/core/clarify');

  // (a) OCR reading the same label twice, one character apart, must not put
  //     two lines in the cart once the portal has named them the same part.
  const dupOrder = { id: 'ORD-DUP', lines: [] };
  orders.addLines(dupOrder, [{ item: '17521m52TOO', partNo: '17521M52T00', qty: 10, source: 'unavailable', available: 0 }], { replace: true });
  orders.addLines(dupOrder, [{ item: '17521M52T00', partNo: '17521M52T00', qty: 10, source: 'unavailable', available: 0 }], { replace: true });
  check('the same part read two ways stays ONE line', dupOrder.lines.length === 1);

  // (b) eight unidentified items must be one message, not eight.
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'zzz alpha bracket - 1\nzzz beta bracket - 1\nzzz gamma bracket - 1');
  const beforeFlood = customer.transport.outbox.length;
  await new Promise((r) => setTimeout(r, 1800));
  const floodMsgs = customer.transport.outbox.slice(beforeFlood).filter((o) => /confirm nahi ho paye?/i.test(o.text || ''));
  check('unidentified items are answered in ONE message', floodMsgs.length <= 1);

  // (c) the same question is never asked twice in a row.
  clarify2.ask('sim-q', { base: 'brake pad' }, { facet: 2, text: 'Thoda aur detail bata dijiye?' });
  check('a repeated question is recognised', clarify2.alreadyAsked('sim-q', 'Thoda aur detail bata dijiye?') === true);
  check('a different question is not', clarify2.alreadyAsked('sim-q', 'Kaunsi gaadi?') === false);

  // (d) an item the portal could not resolve is not put in the cart, because
  //     the customer cannot buy it — that is how one cart reached 14 items.
  const cartBefore = (orders.findDraft('sim-' + CUST) || { lines: [] }).lines.length;
  await dm(customer, CUST, 'zzz delta bracket - 1');
  const cartAfter = (orders.findDraft('sim-' + CUST) || { lines: [] }).lines.length;
  check('unresolvable items never enter the cart', cartAfter === cartBefore);

  // ---- 7d. helper answers by REPLYING, with several questions open ----
  // This is how the sales desk actually answers: swipe-to-reply on the bot's
  // question and type just the part number. No "E7" prefix, and two or three
  // questions open at once — which the prefix-only parser could not resolve.
  console.log('\n[7d] helper replies by quoting, no E-prefix');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, '68P clatch wier - 5');
  await dm(customer, CUST, '74L clutch wier - 5');
  const asks = customer.transport.outbox.filter((o) => (o.text || '').includes('Question *#'));
  check('two questions are open at once', asks.length === 2);

  const askA = asks[0];
  const askB = asks[1];
  const idA = (askA.text.match(/\*#(\d+)\*/) || [])[1];
  const idB = (askB.text.match(/\*#(\d+)\*/) || [])[1];

  // answer the SECOND one first, by quoting it — order must not matter
  await customer.transport.injectIncoming({
    from: config.escalationNumber,
    chatId: 'sim-' + config.escalationNumber,
    isGroup: false,
    body: '23710M74L00',
    contextId: askB.id,
    mediaType: 'chat',
  });
  check('quoted reply is matched to the right question', knowledge.lookupAlias('74L clutch wier') === '23710M74L00');
  check('the other question is untouched', knowledge.lookupAlias('68P clatch wier') === null);

  await customer.transport.injectIncoming({
    from: config.escalationNumber,
    chatId: 'sim-' + config.escalationNumber,
    isGroup: false,
    body: '23710M68P21',
    contextId: askA.id,
    mediaType: 'chat',
  });
  check('second quoted reply is matched too', knowledge.lookupAlias('68P clatch wier') === '23710M68P21');
  check('both escalations were distinct', idA !== idB);

  // ---- 7e. a LATE answer is still learned ----
  // The helper often answers well after the customer has been told we could
  // not confirm in time. Dropping the question at the timeout threw that
  // answer away, so the same part went to a human again the next day — the
  // exact opposite of "ask once, know forever".
  console.log('\n[7e] a late helper answer is still learned');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'rear bumper bracket baleno - 2');
  const lateAsk = customer.transport.outbox.find((o) => (o.text || '').includes('Question *#'));
  check('helper was asked', Boolean(lateAsk));
  const lateId = (lateAsk.text.match(/\*#(\d+)\*/) || [])[1];

  // the 5-minute fallback fires: customer is told, question stays open
  await escalation._testTimeout(Number(lateId));
  // the fallback is batched for a moment so eight items become one message
  await new Promise((r) => setTimeout(r, 1800));
  check('customer is told we could not confirm in time', /could not confirm/i.test(lastOut(customer)));
  check('the question is still open for the helper', escalation.hasPending() === true);

  await customer.transport.injectIncoming({
    from: config.escalationNumber,
    chatId: 'sim-' + config.escalationNumber,
    isGroup: false,
    body: `E${lateId} 71811M74L00`,
    mediaType: 'chat',
  });
  check('the late answer is learned anyway', knowledge.lookupAlias('rear bumper bracket baleno') === '71811M74L00');


  // ---- 7h. the question the helper actually reads ----
  // One wording for every situation made the reader work out which situation
  // they were in before they could start. These are three different jobs.
  console.log('\n[7h] escalation message says WHO, WHAT and WHY');
  customer.transport.outbox.length = 0;
  await escalation.create(customer, {
    chatId: 'sim-919891989965', customerPhone: '919891989965',
    item: 'COIL ASSY IGNITION 33400 M 68K31', partNo: '33400M68K31',
    reason: 'NOT_IN_CATALOGUE', qty: 3, kind: 'order',
  });
  const askMsg = customer.transport.outbox.map((o) => o.text).join('\n');
  check('the customer number is on the question', /\+91 98919 89965/.test(askMsg));
  // The reader needs the number the bot extracted, not the raw OCR line it
  // came from — doing that extraction again is the bot's job, not theirs.
  check('the extracted part number is shown', /33400M68K31/.test(askMsg));
  check('the raw wording is shown too, for a misread digit', /COIL ASSY IGNITION/.test(askMsg));
  check('quantity is shown when it is not 1', /qty 3/.test(askMsg));
  check('it says the part is not in the catalogue', /not in the portal catalogue/.test(askMsg));

  customer.transport.outbox.length = 0;
  await escalation.create(customer, {
    chatId: 'sim-918770490145', customerPhone: '918770490145',
    item: 'front bumper bracket balini', reason: 'NO_PART_NUMBER', qty: 1, kind: 'order',
  });
  const nameAsk = customer.transport.outbox.map((o) => o.text).join('\n');
  check('a name-only request asks for the part number', /confirm part no/.test(nameAsk));
  check('the two situations do not read the same', !/not in the portal catalogue/.test(nameAsk));

  // ---- 7i. the helper hears back ----
  // Answering used to send a part number into silence: no way to know it had
  // landed, reached the right customer, or been remembered.
  console.log('\n[7i] the helper is told what their answer did');
  const openIds = [...customer.transport.outbox.map((o) => o.text).join('\n').matchAll(/\*#(\d+)\*/g)].map((x) => x[1]);
  const answerId = openIds[openIds.length - 1];
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber,
    isGroup: false, body: '#' + answerId + ' 22400M74L00', mediaType: 'chat',
  });
  const backToHelper = customer.transport.outbox.filter((o) => o.to === config.escalationNumber).map((o) => o.text).join('\n');
  check('the helper gets a confirmation', /done/.test(backToHelper));
  check('it names the customer the answer went to', /\+91 87704 90145/.test(backToHelper));
  check('it names the part that was sent on', /22400M74L00/.test(backToHelper));

  // "pending" must answer even when nothing is open — silence reads as broken.
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber,
    isGroup: false, body: 'pending', mediaType: 'chat',
  });
  const pendingReply = customer.transport.outbox.filter((o) => o.to === config.escalationNumber).map((o) => o.text).join('\n');
  check('"pending" is always answered', pendingReply.length > 0);


  // ---- 7j. the customer's own language ----
  // "the customer who speaks in Hindi, send message in Hindi; and tomorrow
  // speaks in English, English." The hard part is that MOST messages carry no
  // signal at all — a bare part number is neither — so the language is sticky
  // and only a message that actually says something can change it.
  console.log('\n[7j] the reply follows the customer, not the bot');
  const lang = require('../src/core/lang');
  check('Hinglish is recognised', lang.detect('rate bhej dijiye') === 'hi');
  check('Devanagari is recognised', lang.detect('कीमत भेजिए') === 'hi');
  check('English is recognised', lang.detect('please share the price') === 'en');
  check('a bare part number says nothing', lang.detect('16510M65L10 10') === null);
  check('a part number with qty says nothing', lang.detect('43401M68P01 2') === null);
  check('an unmarked English sentence still reads as English', lang.detect('bumper bracket front left') === 'en');

  const LANGCUST = '919898001122';
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LANGCUST, chatId: 'sim-' + LANGCUST, isGroup: false,
    body: 'bhai 16510M65L10 ka rate bhej dijiye', mediaType: 'chat',
  });
  check('a Hindi customer is answered in Hindi', /bhej|kar|hai|dijiye/i.test(sent(customer)));

  // A bare part number must NOT flip them back to English.
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LANGCUST, chatId: 'sim-' + LANGCUST, isGroup: false,
    body: 'list', mediaType: 'chat',
  });
  check('language survives a message with no signal', lang.of('sim-' + LANGCUST) === 'hi');

  // ...but an English sentence does.
  await customer.transport.injectIncoming({
    from: LANGCUST, chatId: 'sim-' + LANGCUST, isGroup: false,
    body: 'please send the price for this part', mediaType: 'chat',
  });
  check('switching to English switches the replies', lang.of('sim-' + LANGCUST) === 'en');

  // A customer who has said nothing either way is answered in HINGLISH: on
  // this line that is the likelier guess, and the first English word they
  // write still flips the whole chat over (the check above proves it).
  check('Hinglish is the default', lang.of('sim-919000000001') === 'hi');


  // ---- 7k. a part number with no quantity is a QUESTION ----
  // Founder: "customer bina qty ke sirf part number bhejta hai to quantity
  // poochh lo." Before this the bot invented qty 1, put it in the cart and
  // printed "*YES* = confirm" under a message where the customer had only
  // asked whether we carry the part.
  console.log('\n[7k] no quantity -> ask, do not order');
  const askQty = require('../src/core/askQty');
  const QCUST = '919845007700';
  const QCHAT = 'sim-' + QCUST;

  // The parser has to keep the fact that the quantity was OURS, not theirs.
  const noQtyLines = ai.parseLinesBlock('58330M85L00 - \n59333M85L00 -');
  check('two bare part numbers are both read', noQtyLines.length === 2);
  check('a quantity we invented is marked', noQtyLines.every((l) => l.qtyMissing === true));
  const withQtyLines = ai.parseLinesBlock('58330M85L00 2\n59333M85L00 5');
  check('a quantity the customer gave is not marked', withQtyLines.every((l) => !l.qtyMissing));

  // A list of NAMES with no quantities used to lose every line but the last.
  const nameList = ai.parseLinesBlock('Oil filter\nAir filter\nAc filter\nCoolant\nSpark plug 4pcs');
  check('a name list keeps every line', nameList.length === 5);
  check('the one stated quantity survives', nameList[4].qty === 4 && !nameList[4].qtyMissing);
  check('the rest are marked as missing', nameList.slice(0, 4).every((l) => l.qtyMissing));

  // ...but a printed LABEL is not a list: one part, described over four lines.
  const labelBlock = ai.parseLinesBlock('43401 M 68R00\nF.FLOOR HUB ASSY,FRONT WHEEL\nQTY 1\nMRP 3380.00 (Incl. of all Taxes)');
  check('a label is still one part, not four', labelBlock.length === 1);

  // A quantity on its own line belongs to the part above it.
  const trailing = ai.parseLinesBlock('57300M55R03\n2pc');
  check('a quantity on the next line is picked up', trailing.length === 1 && trailing[0].qty === 2);

  portal.setMockStock([
    { part_no: '58330M85L00', name: 'EXTENSION, FENDER APRON RH', quantity: 40, price: 450, mrp: 600, vendor: 'N' },
    { part_no: '59333M85L00', name: 'EXTENSION, COWL UPPER RH', quantity: 30, price: 450, mrp: 600, vendor: 'N' },
  ]);

  customer.transport.outbox.length = 0;
  await dm(customer, QCUST, '58330M85L00 - \n59333M85L00 -');
  const asked = lastOut(customer);
  check('availability is still answered', /58330M85L00/.test(asked) && /59333M85L00/.test(asked));
  check('the bot asks how many', /how many|kitni quantity/i.test(asked));
  check('no confirm prompt under a question', !/confirm\?|Confirm sir/i.test(asked));
  check('nothing went into the cart', !orders.findDraft(QCHAT));

  // The answer is a bare number, which is not an order line and used to be
  // met with silence.
  customer.transport.outbox.length = 0;
  await dm(customer, QCUST, '2');
  const nowOrdered = orders.findDraft(QCHAT);
  check('the quantity answer creates the order', Boolean(nowOrdered) && nowOrdered.lines.length === 2);
  check('it applies to every item asked about', (nowOrdered.lines || []).every((l) => l.qty === 2));
  check('the quantity answer is acted on', /58330M85L00 x2/.test(lastOut(customer)));
  check('nothing is left waiting', askQty.get(QCHAT) === null);

  // "All one pcs each" — a real reply from the live chats.
  check('"All one pcs each" is read', String(askQty.readAnswer('All one pcs each', 3)) === '1,1,1');
  check('"2 pcs each" is read', String(askQty.readAnswer('2 pcs each', 2)) === '2,2');
  check('one number per item is read', String(askQty.readAnswer('2,3,1', 3)) === '2,3,1');
  check('a part number is not a quantity', askQty.readAnswer('16510M65L10', 2) === null);
  check('a sentence is not a quantity', askQty.readAnswer('kab tak milega', 2) === null);


  // ---- 7l. an unreadable photo goes to a PERSON, with the photo ----
  // Customers photograph the part itself, a blurry label, another dealer's
  // screen. Telling them to type a part number they do not have is how a live
  // sale ends. A person can read it in two seconds — so they get the picture.
  console.log('\n[7l] unreadable photo -> the helper, with the photo attached');
  const PCUST = '919845008800';
  const PCHAT = 'sim-' + PCUST;
  // 1x1 png. No OCR and no AI key in this suite, so this is unreadable by
  // definition — exactly the case being tested.
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ).toString('base64');
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: PCUST, chatId: PCHAT, isGroup: false, body: '3pise',
    mediaType: 'image', mediaMime: 'image/png', mediaBase64: tinyPng,
  });
  const toHelper = customer.transport.outbox.filter((o) => o.to === config.escalationNumber);
  check('the helper is asked about the photo', toHelper.length === 1);
  check('the PHOTO itself is sent, not just words', Boolean(toHelper[0] && toHelper[0].photo));
  check('the question says it is about a photo', /Could not read the part number from this photo/.test((toHelper[0] || {}).text || ''));
  check('the caption quantity is carried over', /qty 3/.test((toHelper[0] || {}).text || ''));
  check(
    'a bare quantity is not used as the part name',
    !/#\d+ 3pise/.test(toHelper.map((o) => o.text).join(''))
  );
  const toCust = customer.transport.outbox.filter((o) => o.to === PCHAT || o.chatId === PCHAT);
  check(
    'the customer is told we are checking, not told to retype',
    /check this photo|photo check/i.test(toCust.map((o) => o.text).join(' '))
  );
  check('an unreadable photo creates no order', !orders.findDraft(PCHAT));

  // A photo of a label carries no quantity — the same question follows.
  check(
    'a photo line with no quantity is marked, not assumed',
    ai._internals.isPartToken('58330M85L00') &&
      ai.parseLinesBlock('58330M85L00').every((l) => l.qtyMissing === true)
  );


  // ---- 7m. a photographed Maruti box label ----
  // Real case, from production: the founder photographed a Maruti box and the
  // bot answered "Which vehicle?" — about a part number printed on the label
  // it had just read correctly. Vision returns the number SPACED, the way the
  // label prints it ("33400 M 68K31 COIL ASSY, IGNITION"). Nothing joined it,
  // so it did not look like a part number, so it was searched as a NAME, which
  // matched every ignition coil in the catalogue.
  console.log('\n[7m] a photographed box label is a part number, not a name');
  const visionLine = ai._internals.sanitizeOrderLines(
    [{ item: '33400 M 68K31 COIL ASSY, IGNITION', qty: 1 }],
    null
  );
  check('a spaced label number is joined', visionLine[0].item.startsWith('33400M68K31'));
  check('the part number is found inside the label text', availability.extractPartNo(visionLine[0].item) === '33400M68K31');
  check('it is NOT searched as a name', availability.isNameQuery(visionLine[0].item) === false);
  check('the label quantity is kept', visionLine[0].qty === 1 && !visionLine[0].qtyMissing);
  // ...and a real name is still a name.
  check('a real part name is still searched by name', availability.isNameQuery('front bumper bracket baleno') === true);
  // The extractor must not fire on short codes inside a product name, or every
  // name would stop being searched as a name.
  check('a 4-character code is not read as a part number', availability.extractPartNo('ac gas r134') === null);
  check('a model year is not read as a part number', availability.extractPartNo('brake pad swift 2020') === null);
  check('an oil grade is not read as a part number', availability.extractPartNo('ecstar 0w20 engine oil') === null);


  // ---- 7n. conversation memory and the chat layer ----
  // The bot used to answer every message in isolation, which is what makes a
  // bot feel like a bot: "pakka?" arrives with no idea what it refers to. And
  // "pakka?" was worse than that — it matched the CONFIRM words and placed the
  // order.
  console.log('\n[7n] context, and what a question mark means');
  const conversation = require('../src/core/conversation');
  const smallTalk = require('../src/core/smallTalk');

  check('a question mark is not a confirmation', (await ai.parseCustomerMessage('pakka?', [])).intent !== 'confirm');
  check('"ok?" is not a confirmation', (await ai.parseCustomerMessage('ok?', [])).intent !== 'confirm');
  check('a plain yes still confirms', (await ai.parseCustomerMessage('yes', [])).intent === 'confirm');
  check('"cancel?" does not cancel', (await ai.parseCustomerMessage('cancel?', [])).intent !== 'cancel');
  check('"kitna time lagega" is a status question', (await ai.parseCustomerMessage('kitna time lagega', [])).intent === 'status');

  const CCHAT = 'sim-919845009900';
  conversation.clear(CCHAT);
  conversation.record(CCHAT, 'customer', '16510M65L10 2');
  conversation.record(CCHAT, 'us', '16510M65L10 x2 - 90 pcs available');
  conversation.record(CCHAT, 'customer', 'pakka?');
  const hist = conversation.recent(CCHAT);
  check('both sides of the thread are kept', /Customer: 16510M65L10 2/.test(hist) && /Us: 16510M65L10/.test(hist));
  check('the thread is in order', hist.indexOf('16510M65L10 2') < hist.indexOf('pakka?'));
  conversation.record(CCHAT, 'customer', 'x'.repeat(500));
  check('one message cannot flood the memory', conversation.turns(CCHAT).every((t) => t.text.length <= 300));
  for (let i = 0; i < 40; i++) conversation.record(CCHAT, 'customer', 'line ' + i);
  check('the memory is capped', conversation.turns(CCHAT).length <= conversation.MAX);

  check('a casual customer is read as casual', conversation.styleOf(CCHAT, 'bhai ye kya scene hai 😂').formality === 'casual');
  check('a formal customer is read as formal', conversation.styleOf(CCHAT, 'Sir please share the process').formality === 'formal');

  // The fences on the one place a model writes to a customer. They may only
  // ever REJECT — a tripped fence means silence, which is what the bot did
  // before the layer existed.
  const ctx = 'Customer: 16510M65L10 2\nUs: 16510M65L10 x2 - 90 pcs available';
  check('a plain reply passes', smallTalk.fenceFails('Haan sir, check karke batata hoon.', ctx) === null);
  check('a repeated part number passes', smallTalk.fenceFails('16510M65L10 ka bata deta hoon', ctx) === null);
  check('an INVENTED part number is refused', /invented/.test(smallTalk.fenceFails('43401M68P01 le lijiye', ctx) || ''));
  check('a price is refused', /money/.test(smallTalk.fenceFails('Rate 450 rupees hai', ctx) || ''));
  check('a stock claim is refused', /stock/.test(smallTalk.fenceFails('Ye item stock hai sir', ctx) || ''));
  check('an order promise is refused', /promises/.test(smallTalk.fenceFails('Your order is confirmed', ctx) || ''));
  check('a delivery promise is refused', /promises/.test(smallTalk.fenceFails('Kal bhej denge', ctx) || ''));
  check('assistant boilerplate is refused', /boilerplate/.test(smallTalk.fenceFails("Certainly! I'd be happy to help.", ctx) || ''));
  check('an essay is refused', /too long/.test(smallTalk.fenceFails('x'.repeat(240), ctx) || ''));
  check('three lines are refused', /two lines/.test(smallTalk.fenceFails('a\nb\nc', ctx) || ''));

  // With no API key in this suite the layer must simply do nothing.
  // A part number in the message means it is NOT conversation, whatever the
  // parser decided. Live case: "43430-0K021 another part no" was handed to a
  // person as "not a parts question", with the part number sitting in it.
  const notChat = await smallTalk.respond(CCHAT, '43430-0K021 another part no');
  check('a message with a part number never reaches the chat layer', notChat === null);
  const notChat2 = await smallTalk.respond(CCHAT, 'ye bhi chahiye 16510M65L10');
  check('...even when it reads conversational', notChat2 === null);

  const quiet = await smallTalk.respond(CCHAT, 'Please collect cheque tomorrow');
  check('no API key means no chat layer, not a crash', quiet === null);


  // ---- 7o. how the close reads, and who never gets a cart ----
  console.log('\n[7o] "Confirm sir?", no stock counts, inquiry-only numbers');

  // Every way a dealer says yes. "hn" and "ji" used to be met with silence.
  for (const yes of ['yes', 'ok', 'okay', 'haan', 'hn', 'ji', 'ji haan', 'theek hai', 'sahi hai', 'kar do', 'bhej do', 'bilkul', 'done']) {
    check('"' + yes + '" is a yes', (await ai.parseCustomerMessage(yes, [])).intent === 'confirm');
  }

  // The shelf figure is ours, not the customer's.
  const stocked = { item: "BP-1001", partNo: 'BP-1001', qty: 2, source: 'portal', available: 90, requested: 'BP-1001' };
  const oneLine = orders.lineText(stocked);
  check('the line says available', /available/i.test(oneLine));
  check('the line does NOT leak the stock count', !/90/.test(oneLine));

  // The close is a question a person would ask, not machine syntax.
  const ackText = orders.ack([stocked], { chatId: "sim-x", lines: [stocked] });
  check('the line is answered plainly', /BP-1001 x2/.test(ackText));
  check('no "*YES* = confirm" machine syntax', !/\*YES\* = confirm/.test(ackText));
  // Asking after every single part is what made it read like a machine. The
  // ask comes once, after the customer stops adding.
  check('no confirm prompt on every line', !/confirm/i.test(ackText));

  // Numbers that only ever ask: answered, but never given a cart.
  console.log('  (inquiry-only)');
  const ASKER = '919845112233';
  config.inquiryOnlyNumbers.push(ASKER);
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'N' }]);
  customer.transport.outbox.length = 0;
  await dm(customer, ASKER, 'BP-1001 5');
  const askerReply = lastOut(customer);
  check('an inquiry-only number still gets an answer', /BP-1001/.test(askerReply));
  check('...but is never asked to confirm', !/confirm/i.test(askerReply));
  check('...and no cart is built for them', !orders.findDraft('sim-' + ASKER));
  config.inquiryOnlyNumbers.pop();

  // A normal customer is unaffected.
  customer.transport.outbox.length = 0;
  await dm(customer, '919845112244', 'BP-1001 5');
  check('a normal customer still gets a cart', Boolean(orders.findDraft('sim-919845112244')));
  check('...and the line is answered', /BP-1001/.test(lastOut(customer)));


  // ---- 7p. PDFs, voice notes, and no more folded hands ----
  console.log('\n[7p] documents');
  const documents = require('../src/core/documents');

  // Our OWN paperwork comes back at us constantly — the sales order, the
  // invoice, the challan, the ledger. Read as an order list they are a
  // disaster: a GSTIN becomes a part number and its digits a quantity. Every
  // PDF in the Kalra export produced exactly that before this guard.
  check('a tax invoice is not an order', documents.isOurPaperwork('TAX INVOICE ... HSN ... CGST') === true);
  check('a sales order is not an order', documents.isOurPaperwork('SalesOrderDC-CT-2627 Authorised Signatory') === true);
  check('a ledger is not an order', documents.isOurPaperwork('Ledger for Kalra Motors') === true);
  check('a credit note is not an order', documents.isOurPaperwork('Credit Note CN-CT-26-27') === true);
  check('a plain parts list IS an order', documents.isOurPaperwork('KALRA MOTORS PARTS REQUIREMENT\n16510M65L10 10') === false);

  check(
    'a real invoice yields no order lines',
    documents.orderLinesFrom({ how: 'text', text: 'TAX INVOICE\nGST 06CIYPK2053H1ZZ\nHSN 8708\nCGST', tables: [] }).length === 0
  );
  const pdfOrder = documents.orderLinesFrom({
    how: 'text',
    text: 'PARTS REQUIREMENT\n16510M65L10 10\n55810M75J30 5\n13780M76SA0 20',
    tables: [],
  });
  check('a customer order PDF yields its lines', pdfOrder.length === 3);
  check('...with the right quantities', pdfOrder.map((l) => l.qty).join(',') === '10,5,20');

  // Both readers are optional. With Python missing they must return null and
  // leave the bot exactly as it was, not throw.
  check('PDF reading can be switched off', config.documents.pdf === true || config.documents.pdf === false);
  // Voice notes go to a person, always. Nothing transcribes them: measured at
  // 46s a clip on this box, returning Devanagari.
  check('there is no transcription path left', !fs.existsSync(__dirname + '/voice/transcribe.py'));

  // Read receipt + "typing...", the moment a message lands — before the portal
  // call or the photo read, which are what make the customer wait.
  customer.transport.typed = 0;
  await customer.transport.injectIncoming({
    from: '919845550011', chatId: 'sim-919845550011', isGroup: false,
    body: 'hello', mediaType: 'chat', id: 'wamid.SMOKE1',
  });
  check('the customer sees typing straight away', customer.transport.typed === 1);
  check('...against their own message', customer.transport.lastTypedFor === 'wamid.SMOKE1');
  customer.transport.typed = 0;
  await customer.transport.injectIncoming({
    from: '919845550011', chatId: 'sim-919845550011', isGroup: false,
    body: 'hello', mediaType: 'chat',
  });
  check('no message id means no typing call, not a crash', customer.transport.typed === 0);

  // The chat layer must have FACTS, not just prohibitions — with only rules
  // it deflected "order kr skta hoon?" to a person. These are the things it is
  // allowed to state, and they have to stay in the brief.
  const brief = smallTalk.SYSTEM;
  check('the brief names the business', /CARTRENDS/.test(brief));
  check('it knows orders can be placed here', /takes orders|can order here/i.test(brief));
  check('it knows who "our team" is', /sales team/i.test(brief));
  check('it still forbids quoting a rate', /[Nn]ever state a price/.test(brief));
  check('it still forbids claiming stock', /[Nn]ever say whether/.test(brief));
  check('it only hands over money and order problems', /MONEY or a specific existing order/.test(brief));

  // A greeting is the commonest opening message there is, and the bot answered
  // two of them on the live line with silence — the chat layer had read "hi"
  // as the same kind of nothing as "ok". It is deterministic now.
  // A greeting is answered with the SAME greeting — "hi ka hi, jai shree ram
  // ka jai shree ram". Not a sales pitch.
  const HIC = '919845330011';
  const mirrors = [
    ['hi', 'Hi'],
    ['hello', 'Hello'],
    ['namaste', 'Namaste'],
    ['Ram Ram', 'Ram Ram'],
    ['jai shree ram', 'Jai Shree Ram'],
    ['good morning', 'Good morning'],
    ['hello ji', 'Hello ji'],
    ['RADHE RADHE', 'Radhe Radhe'],
  ];
  for (const [said, back] of mirrors) {
    customer.transport.outbox.length = 0;
    await dm(customer, HIC, said);
    check('"' + said + '" is answered with "' + back + '"', lastOut(customer) === back);
  }
  check('the greeting is not a sales pitch', !/part number/i.test(lastOut(customer)));

  // ...and the offer to help follows ONLY if they then go quiet. Any message
  // from them cancels it, because whatever they said next IS the conversation.
  const QUIET = '919845330022';
  customer.transport.outbox.length = 0;
  await dm(customer, QUIET, 'hi');
  check('nothing but the greeting at first', customer.transport.outbox.length === 1);
  await new Promise((r) => setTimeout(r, 3400)); // GREETING_NUDGE_SEC=3 in this suite
  check(
    'a customer who goes quiet is offered help',
    customer.transport.outbox.map((o) => o.text).join(' ').includes('part number'),
  );

  const BUSY = '919845330033';
  customer.transport.outbox.length = 0;
  await dm(customer, BUSY, 'hi');
  await dm(customer, BUSY, 'kuch chahiye tha');
  await new Promise((r) => setTimeout(r, 3400));
  check(
    'a customer who keeps talking is NOT nudged',
    !customer.transport.outbox
      .filter((o) => o.to === 'sim-' + BUSY)
      .map((o) => o.text)
      .join(' ')
      .includes('part number and quantity'),
  );
  // A customer greeting in a group is answered too (founder, 13 Sep: every
  // change for everyone - team, admin, new numbers, groups). No nudge follows
  // in a group: the Cartrends people there carry the conversation on.
  customer.transport.outbox.length = 0;
  await group(customer, '919899000888', 'good morning');
  check('a customer greeting in a group is answered', customer.transport.outbox.length === 1);

  // A voice note or a bill must never TEACH the bot anything. Learning that
  // "voice note" means 55810M75J30 would resolve the next voice note from
  // anyone to that part, without a person ever seeing it.
  customer.transport.outbox.length = 0;
  const vId = await escalation.create(customer, {
    chatId: 'sim-919845220011', customerPhone: '919845220011',
    item: 'voice note', qty: 1, kind: 'order', reason: 'VOICE',
    audio: { base64: Buffer.from('x').toString('base64'), mime: 'audio/ogg' },
  });
  check('a voice note reaches the helper', Boolean(vId));
  await customer.transport.injectIncoming({
    from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber,
    isGroup: false, body: '#' + vId + ' 55810M75J30', mediaType: 'chat',
  });
  check('answering it does NOT teach "voice note"', knowledge.lookupAlias('voice note') === null);
  const dId = await escalation.create(customer, {
    chatId: 'sim-919845220012', customerPhone: '919845220012',
    item: 'a bill', qty: 1, kind: 'inquiry', reason: 'DOCUMENT', docName: 'a bill',
  });
  await customer.transport.injectIncoming({
    from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber,
    isGroup: false, body: '#' + dId + ' 55810M75J30', mediaType: 'chat',
  });
  check('answering a bill does NOT teach "a bill"', knowledge.lookupAlias('a bill') === null);

  // Nothing the customer reads carries folded hands any more.
  const botSrc = fs.readFileSync(__dirname + '/../src/bots/customerBot.js', 'utf8');
  const escSrc = fs.readFileSync(__dirname + '/../src/core/escalation.js', 'utf8');
  check('no folded-hands emoji in the customer messages', !botSrc.includes('\u{1F64F}'));
  check('none in the escalation messages either', !escSrc.includes('\u{1F64F}'));


  // ---- 7q. what people say in the MIDDLE of an order ----
  // A live conversation is not a sequence of part numbers. Every one of these
  // came out of the real Kalra chat or a replay of it, and each one used to go
  // wrong in a way that cost something.
  console.log('\n[7q] mid-order conversation');

  // "order laga do" means PLACE IT. It reached a person as a support ticket
  // because the model called it "other".
  for (const yes of ['order laga do', 'order kar do', 'laga do', 'punch kar do', 'order bana do']) {
    check('"' + yes + '" places the order', (await ai.parseCustomerMessage(yes, [])).intent === 'confirm');
  }

  // "rehne do" binned a two-item cart with no confirmation. It asks now.
  for (const soft of ['rehne do', 'abhi rehne do', 'nahi chahiye', 'chhod do']) {
    check('"' + soft + '" only ASKS about cancelling', (await ai.parseCustomerMessage(soft, [])).intent === 'maybe_cancel');
  }
  check('"cancel" still cancels outright', (await ai.parseCustomerMessage('cancel', [])).intent === 'cancel');

  // Hindi puts the verb last, and the verb-first pattern missed all of it.
  const rmTail = await ai.parseCustomerMessage('55810M75J30 hata do', []);
  check('"<part> hata do" is a removal', rmTail.intent === 'remove' && rmTail.item === '55810M75J30');
  check('"nikal do" too', (await ai.parseCustomerMessage('ye wala nikal do', [])).intent === 'remove');

  // Rates never go over WhatsApp, so say that instead of asking for a part.
  for (const r of ['rate kya hai', 'price batao', 'mrp kya hai', 'rate bhejo', 'kitne ka hai', 'kitni ki hai', 'how much', 'discount milega']) {
    check('"' + r + '" is a rate question', (await ai.parseCustomerMessage(r, [])).intent === 'rate');
  }

  // End to end: a soft cancel asks, and the yes that follows cancels rather
  // than placing the order.
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'N' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 9, price: 210, mrp: 280, vendor: 'M' },
  ]);
  const MID = '919845440011';
  const MIDCHAT = 'sim-' + MID;
  await dm(customer, MID, 'BP-1001 5');
  await dm(customer, MID, 'OF-2002 2');
  check('the cart has both items', (orders.findDraft(MIDCHAT) || { lines: [] }).lines.length === 2);

  customer.transport.outbox.length = 0;
  await dm(customer, MID, 'rehne do');
  check('a soft cancel asks first', /cancel/i.test(lastOut(customer)));
  check('...and the cart is still there', (orders.findDraft(MIDCHAT) || { lines: [] }).lines.length === 2);

  customer.transport.outbox.length = 0;
  await dm(customer, MID, 'haan');
  check('the yes cancels, it does not place the order', !orders.findDraft(MIDCHAT));
  check('...and says so', /cancel/i.test(lastOut(customer)));

  // Removing by part number finds the line even after the portal renamed it.
  const MID2 = '919845440022';
  await dm(customer, MID2, 'BP-1001 5');
  await dm(customer, MID2, 'OF-2002 2');
  customer.transport.outbox.length = 0;
  await dm(customer, MID2, 'OF-2002 hata do');
  check('removal by part number works', (orders.findDraft('sim-' + MID2) || { lines: [] }).lines.length === 1);
  check('...and it is the right one left', orders.findDraft('sim-' + MID2).lines[0].partNo === 'BP-1001');

  customer.transport.outbox.length = 0;
  await dm(customer, MID2, 'rate kya hai');
  check('a rate question names the part it will price', /BP-1001/i.test(lastOut(customer)));
  // Since 12 Sep the rate is ANSWERED, from the figures the portal
  // already gave when the list was priced (commercial-analyze).
  check('...and the rate itself comes back, not a promise to ask someone', /MRP|rate/i.test(lastOut(customer)));
  check('...without troubling a person', !customer.transport.outbox.some((o) => o.to === config.escalationNumber && /RATE/.test(o.text || '')));
  check('...and our purchase price is never in it', !/450/.test(lastOut(customer)));
  // ...and it must not ask for a part number the customer already gave.
  customer.transport.outbox.length = 0;
  await dm(customer, MID2, 'BP-1001 ka rate kya hai');
  check('it does not ask again for a part it was given', !/which part/i.test(lastOut(customer)));

  // The confirm ask comes ONCE, after they stop — not after every line.
  const PAUSE = '919845440033';
  customer.transport.outbox.length = 0;
  await dm(customer, PAUSE, 'BP-1001 5');
  check('an order line is answered without a confirm prompt', !/confirm/i.test(lastOut(customer)));
  await dm(customer, PAUSE, 'OF-2002 2');
  check('...and the second one too', !/confirm/i.test(lastOut(customer)));
  customer.transport.outbox.length = 0;
  await new Promise((r) => setTimeout(r, 5400)); // CONFIRM_NUDGE_SEC=5 in this suite
  check(
    'the ask arrives once they go quiet',
    customer.transport.outbox.map((o) => o.text).join(' ').match(/confirm/i) !== null,
  );
  check('...and never quotes a price', !/₹|\brs\.?\s*\d|\b\d+\.\d{2}\b/i.test(lastOut(customer)));

  // ---- 7bb. a retired cart is announced, not silently dropped ----
  console.log('\n[7bb] stale cart is closed WITH a word to the customer');
  // earlier sections emptied the shelf; put it back so both items resolve
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 30, price: 210, mrp: 280, vendor: 'Mohan' },
  ]);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Brake Pad - 3');
  const oldDraft = orders.findDraft('sim-' + CUST);
  const oldId = oldDraft.id;
  // age it past the cutoff on BOTH clocks
  const longAgo = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
  oldDraft.createdAt = longAgo;
  oldDraft.quotedAt = longAgo;
  store.save();
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Oil Filter - 2');
  const afterExpiry = lastOut(customer);
  check('customer is told the old order was closed', new RegExp(oldId).test(afterExpiry));
  check('the new order does not carry the old items', !/Brake Pad/i.test(afterExpiry));
  check('a fresh draft was started', orders.findDraft('sim-' + CUST).id !== oldId);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'AC Gas - 1');
  check('the notice is said once, not every message', !new RegExp(oldId).test(lastOut(customer)));

  // ---- 7c. narrowing a loose name, one question at a time ----
  console.log('\n[7c] follow-up questions, not a list dump');
  const clarify = require('../src/core/clarify');
  const many = [
    { partNo: 'A1', name: 'BRAKE PAD | ALTO K10 | FRONT' },
    { partNo: 'A2', name: 'BRAKE PAD | ALTO K10 | REAR' },
    { partNo: 'A3', name: 'BRAKE PAD | SWIFT | FRONT' },
    { partNo: 'A4', name: 'BRAKE PAD | SWIFT | REAR' },
    { partNo: 'A5', name: 'BRAKE PAD | INNOVA | FRONT' },
    { partNo: 'A6', name: 'BRAKE PAD | SCORPIO | FRONT' },
    { partNo: 'A7', name: 'BRAKE PAD | BOLERO | REAR' },
  ];
  // With a handful of cars it offers them by name; with hundreds it just asks
  // "kaunsi gaadi?". Either way it asks about the CAR and never dumps parts.
  const q1 = clarify.nextQuestion(many);
  check('asks about the car, does not list parts', Boolean(q1) && !/A[1-7]/.test(q1.text) && /gaadi|alto|swift/i.test(q1.text));

  const manyCars = Array.from({ length: 40 }, (_, i) => ({ partNo: 'C' + i, name: `BRAKE PAD | CAR${i} | FRONT` }));
  const q1b = clarify.nextQuestion(manyCars);
  check('asks an open question when there are too many cars to list', Boolean(q1b) && /which vehicle|kaunsi gaadi/i.test(q1b.text));

  const frontRear = many.filter((x) => /ALTO/.test(x.name));
  check('short list needs no question at all', clarify.nextQuestion(frontRear) === null);

  const positions = [
    { partNo: 'B1', name: 'BRAKE PAD | ALTO | FRONT' },
    { partNo: 'B2', name: 'BRAKE PAD | ALTO | REAR' },
    { partNo: 'B3', name: 'BRAKE PAD | ALTO | FRONT' },
    { partNo: 'B4', name: 'BRAKE PAD | ALTO | REAR' },
    { partNo: 'B5', name: 'BRAKE PAD | ALTO | FRONT' },
    { partNo: 'B6', name: 'BRAKE PAD | ALTO | REAR' },
    { partNo: 'B7', name: 'BRAKE PAD | ALTO | FRONT' },
  ];
  const q2 = clarify.nextQuestion(positions, [1]);
  check('asks front or rear when only that differs', Boolean(q2) && /front (or|ya) rear/i.test(q2.text));

  // The same question must never come round twice — that is what makes a bot
  // feel like a machine.
  clarify.ask('sim-c', { base: 'brake pad' }, { facet: 1, text: 'Kaunsi gaadi?' });
  const p1 = clarify.refine('sim-c', 'alto');
  clarify.ask('sim-c', p1, { facet: 2, text: 'Front ya Rear?' });
  check('answered facets are remembered', clarify.get('sim-c').asked.join(',') === '1,2');
  check('the answer is added to the question', clarify.get('sim-c').base === 'brake pad alto');
  check('a short reply counts as an answer', clarify.isAnswerTo('sim-c', 'front') === true);
  check('a part number is not treated as an answer', clarify.isAnswerTo('sim-c', '13780M68P01') === false);
  clarify.clear('sim-c');
  check('no pending question after clearing', clarify.get('sim-c') === null);

  check('options list is capped and asks, without rates', !/@|Rs\./.test(clarify.options(many)) && /Which one do you need|Kaunsa chahiye/.test(clarify.options(many)));

  // The CRM team never quotes a rate on WhatsApp; neither may the bot.
  check('no price anywhere in what the customer was sent', !/@\d|Rs\.\s*\d/.test(sent(customer)));

  // ---- 8. group safety ----
  console.log('\n[8] safety');
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: '919899000777',
    chatId: 'simgroup-random',
    chatName: 'Some Other Group',
    isGroup: true,
    body: 'Brake Pad - 5',
    hasMedia: false,
    mediaType: 'chat',
  });
  check('silent in non-whitelisted groups', customer.transport.outbox.length === 0);
  await group(customer, '919899000888', 'good morning');
  check('a greeting in a bot group is answered like a DM', customer.transport.outbox.length === 1);

  // ---- 9. admin ----
  console.log('\n[9] admin over WhatsApp');
  customer.transport.outbox.length = 0;
  await dm(customer, '919800000009', 'LOSS 1');
  check('sale-loss report available to admin', /Sale loss/i.test(lastOut(customer)));
  await dm(customer, '919800000009', 'LEARN ac gas r134 = ACG-R134');
  check('admin can teach a part', knowledge.lookupAlias('ac gas r134') === 'ACG-R134');

  // [9b] Maruti Genuine Parts labels. Customers photograph the box label and
  // put the quantity in the caption; the label prints the part number spaced.
  console.log('\n[9b] printed part labels');
  const label = ai.parseLinesBlock('43401 M 68R00\nF.FLOOR HUB ASSY,FRONT WHEEL\nQTY 1\nMRP 3380.00 (Incl. of all Taxes)');
  check('label: spaced part number is joined', label.length === 1 && label[0].item === '43401M68R00');
  check('label: leading digits are not read as a quantity', label.length === 1 && label[0].qty === 1);
  const label2 = ai.parseLinesBlock('17522 M 92TA0\nBELT,GENERATOR\nBATCH: AA');
  check('label: second label reads too', label2.length === 1 && label2[0].item === '17522M92TA0');
  const typedSpaced = ai.parseLinesBlock('43401 M 68R00 5');
  check('label: customer typing the spaced form works', typedSpaced.length === 1 && typedSpaced[0].qty === 5);

  // [10] Spreadsheet orders. Customers forward their own pending-list export,
  // so every one of these shapes is a real file layout, not a hypothetical.
  console.log('\n[10] spreadsheet order lists');
  const sheet = require('../src/core/sheet');
  const XLSX = require('xlsx');
  const asBuf = (rows) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };

  const plain = sheet.parseOrderSheet(
    asBuf([
      ['Part Number', 'Description', 'QTY'],
      ['13780M68P01', 'Air Filter', 5],
      ['16510M65L10', 'Oil Filter', 50],
    ])
  );
  check('sheet: reads part and quantity', plain.length === 2 && plain[0].qty === 5 && plain[1].qty === 50);

  // The header sits below the customer's letterhead, and column A opens with
  // "Order No:" — which used to win the quantity vote and blank out every qty.
  const meta = sheet.parseOrderSheet(
    asBuf([
      ['Customer: Metro Motors', '', ''],
      ['Order No: SO-2026-003', '', ''],
      ['Order Date: 10-Aug-2026', '', ''],
      ['SKU', 'Item Name', 'QTY'],
      ['13780M76SA0', 'Radiator Hose', 7],
    ])
  );
  check('sheet: header below letterhead still found', meta.length === 1 && meta[0].qty === 7);

  // A price column reads exactly like a quantity column.
  const priced = sheet.parseOrderSheet(
    asBuf([
      ['Part Number', 'Part Name', 'Price'],
      ['13780M81R10', 'Engine Mount', 4500],
    ])
  );
  check('sheet: price is never read as quantity', priced.length === 1 && priced[0].qty === 1 && priced[0].qtyMissing === true);

  const both = sheet.parseOrderSheet(
    asBuf([
      ['PartNo', 'Name', 'Amount', 'Price'],
      ['16510M65L10', 'Clutch Cable', 5, 250],
    ])
  );
  check('sheet: quantity wins over price when both present', both.length === 1 && both[0].qty === 5);

  // A pending list is several of the customer's own orders in one sheet. The
  // boundary is what their bills are cut on, so nothing may be added up and
  // nothing may be dropped — the file IS the order.
  const stacked = sheet.parseOrderSheet(
    asBuf([
      ['ORDER NO 179', '', ''],
      ['S.NO.', 'PART NO', 'QTY'],
      [1, 'XS6Z8100A', 300],
      [2, 'CYFS12N', 110],
      ['ORDER NO 260', '', ''],
      ['S.NO.', 'PART NO', 'QTY'],
      [1, 'XS6Z8100A', 333],
      [2, 'XS6Z8100A', 7],
    ])
  );
  check('sheet: every row survives, nothing merged', stacked.length === 4);
  check('sheet: customer order numbers are kept', stacked.map((l) => l.ref).join(',') === '179,179,260,260');
  check(
    'sheet: same part in two orders stays two lines',
    stacked.filter((l) => l.item === 'XS6Z8100A').map((l) => l.qty).join('+') === '300+333+7'
  );
  check('sheet: identical rows get distinct keys', new Set(stacked.map((l) => l.key)).size === 4);

  const replyBuf = sheet.buildReplySheet({
    lines: stacked.map((l) => ({ ...l, partNo: l.item, source: 'portal', available: l.qty, requested: l.item })),
  });
  const replyRows = XLSX.utils.sheet_to_json(XLSX.read(replyBuf, { type: 'buffer' }).Sheets.Availability, { header: 1 });
  check('sheet: reply file has a row per order line', replyRows.filter((r) => typeof r[0] === 'number').length === stacked.length);
  check('sheet: reply file is sectioned by order number', replyRows[0][0] === 'ORDER NO 179' && replyRows.some((r) => r[0] === 'ORDER NO 260'));

  check('sheet: xlsx recognised by filename', sheet.isSheet('', 'FORD PENDING LIST 1-09.xlsx'));
  check('sheet: a photo is not a spreadsheet', !sheet.isSheet('image/jpeg', 'indent.jpg'));
  // XLSX is lenient — it reads arbitrary bytes as a one-cell CSV rather than
  // throwing, so junk comes back as "no order in it", not as unreadable.
  check('sheet: junk file yields no order lines', (sheet.parseOrderSheet(Buffer.from('not a spreadsheet')) || []).length === 0);

  // ---- 11. Data Entry request mails -> portal accounts ----
  // Fields, username and password come from the real approved mail for
  // CUST-260905-150010-F6D, so this fails the day that template changes.
  console.log('\n[11] customer creation requests from email');
  const cr = require('../src/core/dataEntryRequests');
  const sampleMail = [
    '<table>',
    '<tr><td>Associate Sales Person</td><td>ashok KUMAR</td></tr>',
    '<tr><td>Customer / Firm Name</td><td>SUCHA SINGH AUTOMOBILES</td></tr>',
    '<tr><td>Business Type</td><td>Wholesaler / Distributor</td></tr>',
    '<tr><td>Customer Category</td><td>-</td></tr>',
    '<tr><td>GSTIN</td><td>07BRFPS1632H1ZS</td></tr>',
    '<tr><td>PAN</td><td>BRFPS1632H</td></tr>',
    '<tr><td>Contact Person</td><td>Baljinder Singh</td></tr>',
    '<tr><td>Mobile</td><td>9899197179</td></tr>',
    '<tr><td>Email</td><td>baljindersachdeva89@yahoo.com</td></tr>',
    '<tr><td>Address</td><td>202/36, Near Gurudwara, Sadar Bazar</td></tr>',
    '<tr><td>City</td><td>New Delhi</td></tr>',
    '<tr><td>State</td><td>Delhi</td></tr>',
    '<tr><td>PIN Code</td><td>110010</td></tr>',
    '<tr><td>Credit Period (Days)</td><td>30</td></tr>',
    '<tr><td>Credit Limit</td><td>100000</td></tr>',
    '<tr><td>Payment Terms</td><td>-</td></tr>',
    '</table>',
  ].join('');
  const req = cr.parseRequest('[Data Entry] Customer Creation Request - CUST-260905-150010-F6D', sampleMail);
  const acct = cr.buildAccount(req, 2026);

  check('request id is read from the subject', req.requestId === 'CUST-260905-150010-F6D');
  check('firm name is read', acct.name === 'SUCHA SINGH AUTOMOBILES');
  check('username is the firm name in small letters, spaces as underscores', acct.username === 'sucha_singh_automobiles');
  check('password is the contact first name in small letters + @123', acct.password === 'baljinder@123');

  // ---- 11b. the fields the MAIL never carries ----
  // The web form marks Home Branch Dealer and Role as required; the API does
  // not, so accounts the bot created had neither. Both are worked out here.
  console.log('\\n[11b] home branch, role, and the vendor tick');

  // Ids read from the live portal, not invented.
  check('Bijwasan is 23', cr.BRANCH_BIJWASAN === 23);

  // The out-of-stock line reads as a date, not a squiggle. Founder's wording:
  // "ETA = 7 days", never "~1 week".
  const etaLine = orders.lineText({ item: 'BP-1', partNo: 'BP-1', qty: 2, source: 'unavailable', requested: 'BP-1' });
  check('an out-of-stock line says ETA in days', /ETA = \d+ days/.test(etaLine));
  check('no tilde in the customer wording', !etaLine.includes('~'));
  check('the ETA is one configurable number', config.onOrderEtaDays === 7);
  const etaAvail = availability.describe({ source: 'unavailable', item: 'BP-1', requested: 'BP-1' });
  check('the inquiry line says it too', /ETA = \d+ days/.test(etaAvail) && !etaAvail.includes('~'));
  check('Mansarovar is 1078', cr.BRANCH_MANSAROVAR === 1078);

  // Rajasthan out of Mansarovar; everything else Bijwasan.
  check('Rajasthan by state', cr.branchFor({ state: 'Rajasthan', city: 'Jaipur' }) === cr.BRANCH_MANSAROVAR);
  check('Delhi by state', cr.branchFor({ state: 'Delhi', city: 'New Delhi' }) === cr.BRANCH_BIJWASAN);
  check('Haryana by state', cr.branchFor({ state: 'Haryana', city: 'Gurugram' }) === cr.BRANCH_BIJWASAN);
  // State is sometimes "-", so the city has to carry it.
  check('Rajasthan by city when the state is blank', cr.branchFor({ state: '-', city: 'Jodhpur' }) === cr.BRANCH_MANSAROVAR);
  // ...and when both are blank, the address usually still says it.
  check(
    'Rajasthan out of the address as a last resort',
    cr.branchFor({ address: '12, Mansarovar Flyover, Jaipur, Rajasthan, 302029' }) === cr.BRANCH_MANSAROVAR,
  );
  check('a Delhi address is not Rajasthan', cr.branchFor({ address: 'Karol Bagh, New Delhi 110005' }) === cr.BRANCH_BIJWASAN);
  check('nothing at all falls back to Bijwasan', cr.branchFor({}) === cr.BRANCH_BIJWASAN);

  // The API defaults BOTH to "dealer". A customer is not a dealer.
  check('a customer account is a dealer too (12 Sep)', cr.userTypeFor('customer') === 'dealer');
  check('a vendor account is a dealer', cr.userTypeFor('vendor') === 'dealer');

  // The vendor tick makes a duplicate account and a separate Odoo partner, so
  // it is never inferred — only when the mail says so.
  check('an ordinary customer is NOT also a vendor', cr.isBoth({ businessType: 'Wholesaler / Distributor' }) === false);
  check('"Customer and Vendor" is', cr.isBoth({ businessType: 'Customer and Vendor' }) === true);
  check('"Both Customer & Vendor" is', cr.isBoth({ businessType: 'Both Customer & Vendor' }) === true);
  check('a remark saying so is', cr.isBoth({ remarks: 'also a vendor' }) === true);
  check('a plain vendor is not both', cr.isBoth({ businessType: 'Vendor' }) === false);

  // End to end, on the real approved mail already parsed above.
  check('the sample Delhi customer gets Bijwasan', acct.branchId === cr.BRANCH_BIJWASAN);
  check('...with the dealer role', acct.userType === 'dealer');
  check('...and no vendor duplicate', acct.alsoVendor === false);

  const rajMail = sampleMail.replace('<td>Delhi</td>', '<td>Rajasthan</td>').replace('<td>New Delhi</td>', '<td>Jaipur</td>');
  const rajAcct = cr.buildAccount(cr.parseRequest('[Data Entry] Customer Creation Request - CUST-TEST-RAJ', rajMail), 2026);
  check('the same mail in Rajasthan gets Mansarovar', rajAcct.branchId === cr.BRANCH_MANSAROVAR);

  // A vendor has no home branch on the portal at all — the field does not
  // exist on that schema.
  const vendAcct = cr.buildAccount({ kind: 'vendor', name: 'Krishna Trading', contactPerson: 'Ram', state: 'Rajasthan' }, 2026);
  check('a vendor gets no home branch', vendAcct.branchId === null);
  check('...and the dealer role', vendAcct.userType === 'dealer');


  check('mobile is normalised', acct.phone === '9899197179');
  check('credit terms are numbers, not text', acct.creditDays === 30 && acct.creditLimit === 100000);
  check('city, state and PIN are folded into the address', /New Delhi, Delhi, 110010/.test(acct.address));
  check('a dash is treated as empty, not as a value', !acct.category && !acct.paymentTerms);
  check('nothing blocks this request', cr.validate(acct).length === 0);
  check('PAN is reported as unstorable', cr.droppedFields(acct).some((d) => /^pan=/.test(d)));

  const badMail = '<table><tr><td>Firm Name</td><td>Test</td></tr><tr><td>Mobile</td><td>123</td></tr><tr><td>GSTIN</td><td>NOTAGST</td></tr></table>';
  const badProblems = cr.validate(cr.buildAccount(cr.parseRequest('[Data Entry] Customer Creation Request - CUST-260905-153425-52B', badMail), 2026));
  check('a short mobile is refused', badProblems.some((p) => /mobile/i.test(p)));
  check('a malformed GSTIN is refused', badProblems.some((p) => /GSTIN/i.test(p)));
  check('a missing request id is refused', cr.validate(cr.buildAccount(cr.parseRequest('no id in this subject', badMail), 2026)).some((p) => /request id/i.test(p)));
  // A VEND- request must reach the vendor endpoint. Both kinds parse the same
  // and would have looked fine in a dry run, while the live call created the
  // wrong kind of account under the right name.
  const vendMail = '<table><tr><td>Firm Name</td><td>ABC AUTO PARTS</td></tr><tr><td>Contact Person</td><td>Ramesh Kumar</td></tr><tr><td>Mobile</td><td>9876543210</td></tr></table>';
  const vend = cr.buildAccount(cr.parseRequest('[Data Entry] Vendor Creation Request - VEND-260905-150010-A11', vendMail), 2026);
  check('a VEND- request is recognised as a vendor', vend.kind === 'vendor');
  check('a CUST- request is recognised as a customer', acct.kind === 'customer');
  check('vendor username follows the same rule', vend.username === 'abc_auto_parts');
  check('vendor password follows the same rule', vend.password === 'ramesh@123');
  // Inventory Creation. Fields come from the real approved mail for
  // REQ-260903-164617-616.
  const invMail = [
    '<table>',
    '<tr><td>Requested By</td><td>RAJKUMAR</td></tr>',
    '<tr><td>Part No</td><td>P001045</td></tr>',
    '<tr><td>Part Name</td><td>4100 ECOMILE 5W30 (4 X 3.5 LTR)#P001045</td></tr>',
    '<tr><td>Brand Name</td><td>motul</td></tr>',
    '<tr><td>MRP (Rs)</td><td>2221</td></tr>',
    '<tr><td>HSN Code</td><td>27101979</td></tr>',
    '<tr><td>Tax Rate</td><td>18%</td></tr>',
    '<tr><td>Bulk Rows Parsed</td><td>N/A</td></tr>',
    '</table>',
  ].join('');
  const inv = cr.buildAccount(cr.parseRequest('[Data Entry] Inventory Creation Request - REQ-260903-164617-616', invMail), 2026);
  check('a REQ- request is recognised as inventory', inv.kind === 'inventory');
  check('part number is read', inv.partNo === 'P001045');
  check('brand is read', inv.brand === 'motul');
  check('"18%" becomes the number 18', inv.gstPercent === 18);
  check('MRP becomes a number', inv.mrpValue === 2221);
  check('a part needs no login', !inv.username && !inv.password);
  check('nothing blocks this part', cr.validate(inv).length === 0);

  // A bulk request shows ONE row in the mail; creating just that row would
  // silently drop the rest of the spreadsheet.
  const bulk = cr.buildAccount(cr.parseRequest('[Data Entry] Inventory Creation Request - REQ-260903-164618-617', invMail.replace('N/A', '48')), 2026);
  check('a bulk inventory request is refused', cr.validate(bulk).some((p) => /bulk/i.test(p)));

  // MRP and discount changes have no API that can write them, so they must be
  // refused rather than guessed at — the mails say "Affects Active Orders: Yes".
  const mrpReq = cr.buildAccount(cr.parseRequest('[Data Entry] MRP Change Request - MRP-260821-150358-97C', '<table><tr><td>Part Number</td><td>SP36SILVER</td></tr><tr><td>New MRP</td><td>245</td></tr></table>'), 2026);
  check('an MRP change is recognised', mrpReq.kind === 'mrp');
  check('an MRP change is refused, not attempted', cr.validate(mrpReq).some((p) => /super admin/i.test(p)));
  // Four bugs the LIVE mailbox found that no invented sample would have.
  const vendorMail = [
    '<table>',
    '<tr><td>Vendor Name</td><td>Yadubashi Automobiles</td></tr>',
    '<tr><td>Contact Person</td><td>Akash</td></tr>',
    '<tr><td>Mobile</td><td>8745004004</td></tr>',
    '<tr><td>Bank Name</td><td>Bank of Baroda</td></tr>',
    '<tr><td>Account Number</td><td>30290500000011</td></tr>',
    '<tr><td>IFSC</td><td>BARB0DLFGUR</td></tr>',
    '</table>',
  ].join('');
  const realVendor = cr.buildAccount(cr.parseRequest('[Data Entry] Vendor Creation Request - VEND-260907-105557-6B9', vendorMail), 2026);
  // Vendor mails say "Vendor Name", not "Firm Name" — every vendor request
  // parsed with no name at all until this was added.
  check('a vendor mail\'s name label is read', realVendor.name === 'Yadubashi Automobiles');
  check('bank details are reported as unstorable', cr.droppedFields(realVendor).some((d) => /^ifsc=/.test(d)));

  // Requesters put the phone number in the Contact Person box, which produced
  // the password "9540979093@2026".
  const phoneAsContact = cr.buildAccount(
    cr.parseRequest('[Data Entry] Customer Creation Request - CUST-260907-183229-5F8',
      '<table><tr><td>Customer / Firm Name</td><td>Krishna Motors Faridabad</td></tr><tr><td>Contact Person</td><td>9540979093</td></tr><tr><td>Mobile</td><td>9540979093</td></tr></table>'), 2026);
  check('a numeric contact person falls back to the firm name', phoneAsContact.password === 'krishna@123');




  // ---- 12. Ordering by line number off a list we sent ----
  // Every string here is one Kalra Motor actually typed, spelling and all.
  console.log('\n[12] ordering by line number');
  const lists = require('../src/core/lists');
  const edit = (t) => JSON.stringify(lists.parseEdit(t));

  check('"Leave 9no. Item" drops line 9', edit('Leave 9no. Item') === '{"drop":[9],"setQty":{}}');
  check('"Leave 2nd no. Item" drops line 2', edit('Leave 2nd no. Item') === '{"drop":[2],"setQty":{}}');
  check('"4th. No. Item 3pc" sets line 4 to 3', edit('4th. No. Item 3pc') === '{"drop":[],"setQty":{"4":3}}');
  check('"8no. Item 2pc" sets line 8 to 2', edit('8no. Item 2pc') === '{"drop":[],"setQty":{"8":2}}');
  check('"Leave 5th no. Item also" drops line 5', edit('Leave 5th no. Item also') === '{"drop":[5],"setQty":{}}');
  // The trap: the "9 no." is a LINE, not a quantity of nine.
  check(
    '"LEAVE 6no. Item 9 no. 1pc" drops 6 and sets 9 to 1',
    edit('LEAVE 6no. Item 9 no. 1pc') === '{"drop":[6],"setQty":{"9":1}}',
  );
  check(
    'a dash-joined run removes every number in it',
    edit('2-9-14-16-21-24-25-43-44-46-74 ye no saman hata do') ===
      '{"drop":[2,9,14,16,21,24,25,43,44,46,74],"setQty":{}}',
  );
  // Typed "2ni-14-..." — a stray letter must not lose the whole line.
  check(
    'a typo in the run does not lose it',
    edit('2ni-14-16-25-44-46-47 Ye saman hata do') === '{"drop":[2,14,16,25,44,46,47],"setQty":{}}',
  );

  // The other half of the job: NOT firing. A real part number in the message
  // means it is an order, whatever else the sentence says.
  for (const safe of [
    '16510M65L10 5',
    '55810M75J30 hata do',
    '2pise',
    'Add 2pc',
    'rehne do',
    'hello',
    '6pc needed',
    '58330M85L00 - 59333M85L00',
  ]) {
    check(`"${safe}" is not read as a line-number edit`, lists.parseEdit(safe) === null);
  }

  // A quote-reply only counts against the list it quoted.
  lists.clear('sim-919000000012');
  lists.remember('sim-919000000012', 'wamid-A', [
    { item: 'PART-1', partNo: 'PART-1', qty: 1 },
    { item: 'PART-2', partNo: 'PART-2', qty: 1 },
  ]);
  check('a reply to our list finds it', !!lists.forReply('sim-919000000012', 'wamid-A'));
  check('a reply to some other message does not', lists.forReply('sim-919000000012', 'wamid-B') === null);
  check('no quote falls back to the last list', !!lists.forReply('sim-919000000012', null));
  check('a chat with no list has none', lists.forReply('sim-919000000099', null) === null);

  // End to end, against a real cart.
  portal.setMockStock([
    { part_no: 'LN-1', name: 'Line One', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
    { part_no: 'LN-2', name: 'Line Two', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
    { part_no: 'LN-3', name: 'Line Three', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
  ]);
  const LN = '919000000013';
  await dm(customer, LN, 'LN-1 1\nLN-2 1\nLN-3 1');
  customer.transport.outbox.length = 0;
  await dm(customer, LN, 'list');
  const listWamid = (customer.transport.outbox[customer.transport.outbox.length - 1] || {}).id;
  check('the LIST reply is remembered as a numbered list', !!lists.forReply('sim-' + LN, listWamid));

  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LN, chatId: 'sim-' + LN, isGroup: false, body: 'Leave 3no. Item', mediaType: 'chat', contextId: listWamid,
  });
  const cart = orders.findDraft('sim-' + LN);
  check('"Leave 3no. Item" removed the third line', cart.lines.length === 2 && !cart.lines.some((l) => (l.partNo || l.item) === 'LN-3'));
  check('and said so', /Removed|Hata diya/i.test(sent(customer)));

  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LN, chatId: 'sim-' + LN, isGroup: false, body: '2nd no. Item 4pc', mediaType: 'chat', contextId: listWamid,
  });
  check('"2nd no. Item 4pc" set the second line to 4', (orders.findDraft('sim-' + LN).lines.find((l) => (l.partNo || l.item) === 'LN-2') || {}).qty === 4);

  // Asking again for a line already taken out must say so, not "not found".
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LN, chatId: 'sim-' + LN, isGroup: false, body: 'Leave 3no. Item', mediaType: 'chat', contextId: listWamid,
  });
  check('a line already removed is named, not shrugged at', /not in the order any more|pehle hi hat chuka/i.test(sent(customer)));

  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LN, chatId: 'sim-' + LN, isGroup: false, body: 'Leave 9no. Item', mediaType: 'chat', contextId: listWamid,
  });
  check('a line the list never had is named too', /no item 9|item 9 tha hi nahi/i.test(sent(customer)));

  // A voice note recorded ON the list carries the list to the helper.
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LN, chatId: 'sim-' + LN, isGroup: false, body: '', mediaType: 'ptt',
    mediaBase64: 'AAAA', mediaMime: 'audio/ogg', contextId: listWamid,
  });
  check('a voice note on a list reaches the helper with the list', /reply to this list/i.test(sent(customer)));
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: LN, chatId: 'sim-' + LN, isGroup: false, body: '', mediaType: 'ptt',
    mediaBase64: 'AAAA', mediaMime: 'audio/ogg',
  });
  check('a voice note with no quote invents no list', !/reply to this list/i.test(sent(customer)));


  // ---- 13. Per-customer style, and the fence around it ----
  // A profile may change tone, length and what the bot leads with. It may
  // never change price, stock, ETA or the confirm flow. These checks are the
  // fence, not a description of it.
  console.log('\n[13] per-customer style');
  const profiles = require('../src/core/profiles');
  const KALRA = '919910561996';
  const STRANGER = '919812345678';

  check('a customer with no profile is left alone', profiles.forPhone(STRANGER) === profiles.DEFAULT);
  check('Kalra has one', profiles.has(KALRA) && profiles.forPhone(KALRA).terse === true);
  check('both Kalra numbers are the same firm', profiles.forPhone('919540354506').name === 'Kalra Motor');

  const quote = '16510M65L10 x2 pcs — on order, ETA = 7 days.\n\nConfirm sir? \u{1F64F}';
  const forStranger = profiles.polish(STRANGER, quote);
  const forKalra = profiles.polish(KALRA, quote);
  check('an unprofiled customer gets the message untouched', forStranger === quote);
  check('Kalra loses the honorific', !/\bsir\b/i.test(forKalra));
  check('Kalra loses the emoji', !/\u{1F64F}/u.test(forKalra));
  check('Kalra gets their own word for pieces', /2 pise/.test(forKalra));

  // THE POINT. Style changed; not one figure did.
  check('the part number is untouched', forKalra.includes('16510M65L10'));
  check('the ETA is untouched', /ETA = 7 days/.test(forKalra));
  check('the confirm is still asked', /Confirm\?/.test(forKalra));
  check('every number survives styling', profiles.facts(forKalra) === profiles.facts(quote));

  // The guard is real: change a figure and facts() must notice.
  check('facts() catches a changed ETA', profiles.facts('ETA = 7 days') !== profiles.facts('ETA = 5 days'));
  check('facts() catches a changed part no.', profiles.facts('16510M65L10') !== profiles.facts('16510M65L11'));
  check('facts() ignores mere wording', profiles.facts('Confirm sir?') === profiles.facts('Confirm?'));

  // Honorifics come in pairs and at the start of a line.
  check('"Ji sir, ready hai." keeps its sentence', profiles.polish(KALRA, 'Ji sir, ready hai.') === 'Ready hai.');
  check('"Sir ji, X available." keeps the part', profiles.polish(KALRA, 'Sir ji, 55810M75J30 available.') === '55810M75J30 available.');

  // A profile may not carry a figure — that is the only way a per-customer
  // ETA or discount could ever be substituted into a message.
  const refused = (k, v) => {
    try {
      profiles.auditValue('91test', k, v);
      return false;
    } catch {
      return true;
    }
  };
  check('a profile cannot carry a number', refused('terse', 5));
  check('a profile cannot carry an object', refused('note', { eta: 3 }));
  check('busyHours must be real hours', refused('busyHours', [99]));
  check('busyHours of 11 and 4 are fine', !refused('busyHours', [11, 16]));
  check('a sentence about them is fine', !refused('note', 'they never write sir'));

  // The brief the model gets says who they are and says it may not move a figure.
  const kalraBrief = profiles.briefFor(KALRA);
  check('the brief names them', /Kalra Motor/.test(kalraBrief));
  check('the brief forbids changing the terms', /same for every customer/i.test(kalraBrief));
  check('an unprofiled customer adds nothing to the brief', profiles.briefFor(STRANGER) === '');

  // ---- 14. Voice notes -> text for the helper ----
  console.log('\n[14] voice transcription');
  const speech = require('../src/integrations/speech');
  check('transcription is on exactly when a key is set', speech.enabled() === !!config.speech.apiKey);
  // No network call here: empty audio short-circuits before the API, and
  // that is the only branch safe to exercise once a real key is present.
  check('empty audio transcribes to nothing', (await speech.transcribe('', 'audio/ogg')) === null);
  // WhatsApp sends "audio/ogg; codecs=opus"; Gemini wants the bare type.
  check('the codec parameter is stripped', speech.mimeOf('audio/ogg; codecs=opus') === 'audio/ogg');
  check('a missing mime falls back to ogg', speech.mimeOf('') === 'audio/ogg');
  check('a non-audio mime is not passed through', speech.mimeOf('application/x-weird') === 'audio/ogg');
  // The transcript is for the reader, not the parser.
  check('the prompt asks for Roman letters, not Devanagari', /Hinglish/.test(speech.PROMPT));
  check('the prompt refuses to guess unclear words', /\[unclear\]/.test(speech.PROMPT));


  // ---- 15. Voice notes that become orders ----
  // A transcript is not a message: "16510M65L10" and "16510M65L70" sound the
  // same down a phone in a workshop. Nothing heard reaches the cart without
  // the customer reading it back and saying yes.
  console.log('\n[15] voice notes as orders');
  const voiceOrder = require('../src/core/voiceOrder');

  for (const yes of ['haan', 'yes', 'ok', 'hn', 'sahi hai', 'theek hai', 'correct', 'ji haan', 'Y']) {
    check(`"${yes}" is a yes`, voiceOrder.readAnswer(yes) === 'yes');
  }
  for (const no of ['nahi', 'no', 'galat', 'nhi', 'wrong']) {
    check(`"${no}" is a no`, voiceOrder.readAnswer(no) === 'no');
  }
  // "sahi hai?" is the customer asking US, not agreeing.
  check('a question mark is not agreement', voiceOrder.readAnswer('sahi hai?') === null);
  check('a part number is not an answer', voiceOrder.readAnswer('16510M65L10') === null);
  check('a sentence is not an answer', voiceOrder.readAnswer('kal bhej dena please') === null);

  voiceOrder.clear('sim-919000000021');
  voiceOrder.remember('sim-919000000021', [{ item: 'BP-1001', qty: 2 }], 'BP-1001 2 pise');
  check('what we heard is held, not ordered', (voiceOrder.get('sim-919000000021') || {}).lines.length === 1);
  check('taking it clears it', !!voiceOrder.take('sim-919000000021') && voiceOrder.get('sim-919000000021') === null);

  // Voice notes go to their own person; everything else is untouched.
  const esc = require('../src/core/escalation');
  check('a voice note goes to the voice helper', esc.helperFor({ reason: 'VOICE' }) === config.voiceEscalationNumber);
  for (const r of ['RATE', 'DOCUMENT', 'NOT_A_PART', 'NOT_IN_CATALOGUE', 'UNREADABLE']) {
    check(`a ${r} question still goes to the usual helper`, esc.helperFor({ reason: r }) === config.escalationNumber);
  }
  check('both helpers can answer', esc.helperNumbers().includes(config.escalationNumber) && esc.helperNumbers().includes(config.voiceEscalationNumber));

  // End to end, with transcription stubbed so the path below it runs for real.
  const speechMod = require('../src/integrations/speech');
  const realTranscribe = speechMod.transcribe;
  let heardNext = null;
  speechMod.transcribe = async () => heardNext;

  portal.setMockStock([
    { part_no: 'VN-1001', name: 'Voice Part', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
  ]);
  const VN = '919000000022';
  const vChat = 'sim-' + VN;
  const asVoice = async (transcript, extra) => {
    heardNext = transcript;
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming(
      Object.assign(
        { from: VN, chatId: vChat, isGroup: false, body: '', mediaType: 'ptt', mediaBase64: 'AAAA', mediaMime: 'audio/ogg' },
        extra,
      ),
    );
  };

  await asVoice('VN-1001 2 pise bhej do');
  check('a heard part is read back, not ordered', /VN-1001/.test(sent(customer)) && !orders.findDraft(vChat));
  check('and the customer is asked', /^(?:right|sahi hai)\?$/im.test(sent(customer)));

  customer.transport.outbox.length = 0;
  await dm(customer, VN, 'haan');
  check('a yes turns it into a real order', !!orders.findDraft(vChat) && orders.findDraft(vChat).lines.length === 1);

  // A part the catalogue has never heard of is what a mis-heard digit
  // produces. It must reach a person, never be read back as though it were real.
  await asVoice('99999X99X99 2 pise');
  check('an unknown part is not read back', !/^(?:right|sahi hai)\?$/im.test(sent(customer)));
  // It reaches a person NAMING the part number, with the recording under it,
  // because the number is a machine's guess.
  check('an unknown part reaches a person', /Question \*#[\s\S]*99999X99X99/.test(sent(customer)));
  check('...and the recording goes with it', customer.transport.outbox.some((o) => o.audio));

  // A no is the case a person most needs to see.
  await asVoice('VN-1001 5 pise');
  check('a second voice note is read back too', /^(?:right|sahi hai)\?$/im.test(sent(customer)));
  customer.transport.outbox.length = 0;
  await dm(customer, VN, 'nahi');
  check('a no goes to a person with what we thought we heard', /VN-1001 5 pise/.test(sent(customer)));
  check('and the customer is told', /(heard that wrong|galat samjha)/i.test(sent(customer)));
  check('a rejected voice note adds nothing', orders.findDraft(vChat).lines.length === 1);

  // ANYTHING ELSE THEY SAID is a message they spoke instead of typing. 21 Sep,
  // live: "Maruti Suzuki Swift Dzire ka bumper price" was transcribed word for
  // word and still went to a person, because the only two things a transcript
  // could do was edit a list or carry a part number. Typed, that sentence gets
  // an answer; spoken, it must get the same one.
  customer.transport.outbox.length = 0;
  await asVoice('mera order ka kya hua');
  check('a spoken question is answered, not handed over', /(item|confirm)/i.test(sent(customer)));
  check('...and nobody was asked about it', !/Question \*#/.test(sent(customer)));

  // Only a note we could NOT read goes straight to a person, with the audio.
  customer.transport.outbox.length = 0;
  await asVoice(null);
  check('an unreadable voice note still reaches a person', /voice note/i.test(sent(customer)));
  check('and the customer is told someone is listening', /(listening|sun kar)/i.test(sent(customer)));

  // A transcript we DID read still reaches the helper above the recording
  // whenever the text path ends up asking them.
  customer.transport.outbox.length = 0;
  await asVoice('zzz omega bracket - 2');
  check('with the transcript above it', /Heard in their voice note:/.test(sent(customer)));
  check('...and the recording goes with it', customer.transport.outbox.some((o) => o.audio));

  // A PART NAMED IN WORDS, spoken. 21 Sep, live: "Maruti Suzuki Swift Dzire ka
  // bumper price" was transcribed word for word, and the customer was told
  // "check karke batata hoon" — no part number, no stock, and nobody checking.
  // The portal's analyze only understands part NUMBERS, so an inquiry by name
  // has to go through the catalogue search first, exactly as an order line
  // does. The mock portal does not search, so it is stubbed here.
  const realSearch = portal.searchByName;
  portal.searchByName = async (q) => {
    const rows = [
      { partNo: '71711M74L00', name: 'BUMPER FRONT | MARUTI SWIFT', available: 4, price: 3150, dealers: [] },
      { partNo: '71811M74L00', name: 'BUMPER REAR | MARUTI SWIFT', available: 2, price: 2990, dealers: [] },
    ].filter((r) => {
      const words = String(q).toLowerCase().split(/\s+/).filter((w) => /^(front|rear)$/.test(w));
      return words.every((w) => r.name.toLowerCase().includes(w));
    });
    return { total: rows.length, top: rows };
  };

  const VNAME = '919000000023';
  const nChat = 'sim-' + VNAME;
  customer.transport.outbox.length = 0;
  heardNext = 'Maruti Suzuki Swift ka bumper chahiye';
  await customer.transport.injectIncoming({
    from: VNAME, chatId: nChat, isGroup: false, body: '',
    mediaType: 'ptt', mediaBase64: 'AAAA', mediaMime: 'audio/ogg',
  });
  check('a part named in a voice note is searched in the catalogue', /71711M74L00/.test(sent(customer)));
  check('...and nobody is asked about it', !/Question \*#/.test(sent(customer)));

  // The list ends in "Kaunsa chahiye?" — so the answer to it has to work.
  // Showing options used to keep no state, and "front" came back as "no order
  // pending", which ends the sale on the message after the bot got it right.
  customer.transport.outbox.length = 0;
  await dm(customer, VNAME, 'front');
  check('and their answer to it picks the part', /71711M74L00/.test(sent(customer)));
  check('...not the other one', !/71811M74L00/.test(sent(customer)));
  portal.searchByName = realSearch;

  // The catalogue is searched on the PART words, with the car words used to
  // narrow — part names read "BUMPER FRONT | MARUTI SWIFT". Searching on the
  // leading words assumed the part comes first, which is how people type and
  // not how they speak ("Maruti Suzuki ka bumper chahiye").
  const partish = require('../src/core/partish');
  check('a maker is a car word', partish.isCarWord('maruti') && partish.isCarWord('suzuki'));
  check('...so is a model', partish.isCarWord('swift') && partish.isCarWord('baleno'));
  check('...and a part is not', !partish.isCarWord('bumper') && !partish.isCarWord('brake'));

  speechMod.transcribe = realTranscribe;


  // ---- 16. Sales team: numbers that ask, never order ----
  // Nine salespeople ask the bot on a customer's behalf. They must get the
  // answer and nothing else: no cart, no "confirm?", and no "how many do you
  // need?" — they are not buying. The number is pushed into config here
  // rather than read from .env, so this test does not depend on who is on
  // the team this month.
  console.log('');
  console.log('[16] sales team — inquiry-only numbers');
  const SALES16 = '919000000031';
  config.inquiryOnlyNumbers.push(SALES16);
  // Real hyphenated formats (Hyundai, Toyota), not made-up ones. "SL-1001"
  // reads as the name SL with a quantity of 1001 -- the same rule that makes
  // "Brake Pad - 5" work -- and no real catalogue number has only digits
  // after its hyphen.
  portal.setMockStock([
    { part_no: '58101-1RA00', name: 'Sales Part', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
    { part_no: '04465-0K290', name: 'Gone Part', quantity: 0, price: 1, mrp: 1, vendor: 'K' },
  ]);
  const said16 = [];
  const ask16 = async (body, extra) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming(
      Object.assign({ from: SALES16, chatId: 'sim-' + SALES16, isGroup: false, body, mediaType: 'chat' }, extra || {}),
    );
    const out = sent(customer);
    said16.push(out);
    return out;
  };

  const withQty = await ask16('58101-1RA00 2');
  check('sales team: a part with a quantity is answered', /58101-1RA00/.test(withQty));
  check('sales team: the answer carries no order quantity', !/58101-1RA00 x2/.test(withQty));

  const bare = await ask16('58101-1RA00');
  check('sales team: a bare part number is answered', /58101-1RA00/.test(bare));
  check('sales team: never asked "how many do you need"', !/how many|kitni quantity/i.test(bare));

  const gone = await ask16('04465-0K290 1');
  check('sales team: out of stock still gets the ETA line', /ETA = [0-9]+ days/.test(gone));

  // Voice goes through read-back and "haan" — the one path that ends in
  // processOrderLines from a stored confirmation rather than a typed message.
  const speech16 = require('../src/integrations/speech');
  const realT16 = speech16.transcribe;
  speech16.transcribe = async () => '58101-1RA00 3 pise';
  await ask16('', { mediaType: 'ptt', mediaBase64: 'AAAA', mediaMime: 'audio/ogg' });
  await ask16('haan');
  speech16.transcribe = realT16;

  check('sales team: no draft, on any kind of message', !orders.findDraft('sim-' + SALES16));
  check(
    'sales team: never shown a confirm prompt',
    !said16.some((t) => /(confirm sir[?]|confirm karun|confirm[?])/i.test(t)),
  );
  config.inquiryOnlyNumbers.splice(config.inquiryOnlyNumbers.indexOf(SALES16), 1);


  // ---- 17. What a helper's answer turns into ----
  // Every helper reply in this suite used to be a part number, which is why
  // this stayed hidden: a WORDED reply to a voice note went into the
  // customer's cart as an order line, and the sales team got a cart and a
  // "Reply YES" whenever a helper answered them.
  console.log('');
  console.log('[17] helper replies: words, parts, and the sales team');
  const speech17 = require('../src/integrations/speech');
  const realT17 = speech17.transcribe;
  speech17.transcribe = async () => null;
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
  ]);
  const HELP17 = config.voiceEscalationNumber;
  const voiceThenReply17 = async (phone, helperWrites) => {
    const chat = 'sim-' + phone;
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({
      from: phone, chatId: chat, isGroup: false, body: '', mediaType: 'ptt', mediaBase64: 'AAAA', mediaMime: 'audio/ogg',
    });
    const q = customer.transport.outbox.find((o) => (o.text || '').includes('Question *#'));
    if (!q) return { raised: false, said: '', cart: [] };
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({
      from: HELP17, chatId: 'sim-' + HELP17, isGroup: false, body: helperWrites, contextId: q.id, mediaType: 'chat',
    });
    const said = customer.transport.outbox
      .filter((o) => !o.to || String(o.to).includes(phone) || o.chatId === chat)
      .map((o) => o.text || '')
      .join(' | ');
    const d = orders.findDraft(chat);
    return { raised: true, said, cart: d && d.lines ? d.lines.map((l) => l.requested || l.item) : [] };
  };

  const w17 = await voiceThenReply17('919800000171', 'Sir kal tak aa jayega');
  check('voice, helper replies in words: the customer is sent the words', w17.raised && /kal tak aa jayega/i.test(w17.said));
  check('voice, helper replies in words: the words are NOT a cart line', !w17.cart.some((c) => /kal tak/i.test(c)));
  check('voice, helper replies in words: no "Reply YES"', !/reply [*]?yes/i.test(w17.said));

  const n17 = await voiceThenReply17('919800000172', 'nahi hai abhi, kal aayega');
  check(
    'voice, "nahi..." is relayed, not "voice note is not available"',
    /kal aayega/i.test(n17.said) && !/voice note.{0,5} is not available/i.test(n17.said),
  );

  const p17 = await voiceThenReply17('919800000173', '16510M65L10');
  check('voice, a part-number reply is still looked up', /16510M65L10/.test(p17.said));
  check('voice, a part-number reply lands in the cart', p17.cart.length === 1);
  check('no "Reply YES" under a helper answer any more', !/reply [*]?yes/i.test(p17.said));

  // The sales team, through the same doors.
  const SALES17 = '919000000174';
  config.inquiryOnlyNumbers.push(SALES17);
  const s17 = await voiceThenReply17(SALES17, '16510M65L10');
  check('sales team, voice answered with a part: they are told', /16510M65L10/.test(s17.said));
  check('sales team, voice answered with a part: no cart', s17.cart.length === 0);

  const askPart17 = async (phone, body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ from: phone, chatId: 'sim-' + phone, isGroup: false, body, mediaType: 'chat' });
    return customer.transport.outbox.find((o) => (o.text || '').includes('Question *#'));
  };
  const helperWrites17 = async (q, body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({
      from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber, isGroup: false, body, contextId: q.id, mediaType: 'chat',
    });
    return customer.transport.outbox
      .filter((o) => String(o.to || '') !== config.escalationNumber)
      .map((o) => o.text || '')
      .join(' | ');
  };

  const qS17 = await askPart17(SALES17, '71717K71K71 2');
  const aS17 = qS17 ? await helperWrites17(qS17, '16510M65L10') : '';
  check('sales team, unknown part answered by the helper: no cart', !!qS17 && !orders.findDraft('sim-' + SALES17));
  check('sales team: never told to reply YES or place the order', !/reply [*]?yes|place the order/i.test(aS17));

  // Now learned. The next ask is answered from memory, with no helper — the
  // path that used to build a cart without anyone noticing.
  await dm(customer, SALES17, '71717K71K71 1');
  check('sales team, a part answered from memory: still no cart', !orders.findDraft('sim-' + SALES17));

  const qC17 = await askPart17(SALES17, '72727K72K72 1');
  const aC17 = qC17 ? await helperWrites17(qC17, 'correct') : '';
  check('sales team, helper says "correct": told it is on order', !!qC17 && /on order/i.test(aC17));
  check('sales team, helper says "correct": no "confirm and reserve"', !/reserve|confirm/i.test(aC17));

  config.inquiryOnlyNumbers.splice(config.inquiryOnlyNumbers.indexOf(SALES17), 1);
  speech17.transcribe = realT17;


  // ---- 18. The Maan Motors case, as it happened on 11 Sep ----
  // A customer asked for the selling price and the MRP of a coolant. The
  // helper answered both correctly, in words. The bot put the first answer in
  // the customer cart as an order line, LEARNED it as the coolant part number,
  // and turned the second into a stock check of a sentence. Section 17 covers
  // voice notes; these are the part and rate questions that actually broke.
  console.log('');
  console.log('[18] the Maan Motors case: worded answers to part and rate questions');
  const HELP18 = config.escalationNumber;
  const ITEM18 = 'Car Trends Antifreeze Radiator Coolant 1L';
  const ask18 = async (phone, reason, kind) => {
    customer.transport.outbox.length = 0;
    await escalation.create(customer, { chatId: 'sim-' + phone, customerPhone: phone, item: ITEM18, qty: 1, kind, reason });
    return customer.transport.outbox.find((o) => (o.text || '').includes('Question *#'));
  };
  const answer18 = async (q, words, phone) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({
      from: HELP18, chatId: 'sim-' + HELP18, isGroup: false, body: words, contextId: q.id, mediaType: 'chat',
    });
    return customer.transport.outbox
      .filter((o) => !o.to || String(o.to).indexOf(phone) !== -1)
      .map((o) => o.text || '')
      .join(' | ');
  };

  const q18a = await ask18('919000000181', 'NOT_IN_CATALOGUE', 'order');
  const a18a = q18a ? await answer18(q18a, 'Its a Cartrends Coolant Green Color, Selling Price to Retailers is Rs 88', '919000000181') : '';
  check('part question, worded answer: the customer gets the words', a18a.indexOf('Selling Price to Retailers is Rs 88') !== -1);
  check('part question, worded answer: not dressed up as a confirmed order', a18a.indexOf('Confirm') === -1);
  check('part question, worded answer: nothing in the cart', !orders.findDraft('sim-919000000181'));
  check('part question, worded answer: the sentence is NOT learned as a part number', !knowledge.lookupAlias(ITEM18));

  const q18b = await ask18('919000000182', 'RATE', 'inquiry');
  const a18b = q18b ? await answer18(q18b, 'The MRP of this Product is Rs 320', '919000000182') : '';
  check('rate question, worded answer: the customer gets the words', a18b.indexOf('The MRP of this Product is Rs 320') !== -1);
  check('rate question, worded answer: no stock check of a sentence', a18b.indexOf('Stock check') === -1);

  // ---- 19. What es ki, iska, ye point at ----
  // M/S Maan Motors, 11 Sep: asked about a coolant, then wrote "Es ki MRP
  // kya h" and got "Kis part ka?" back. A pointer means the part we just
  // discussed; with nothing discussed the bot still asks rather than guess.
  console.log('');
  console.log('[19] follow-ups that point back at the part we just discussed');
  const focus19 = require('../src/core/focus');
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
    { part_no: '13780M68P01', name: 'Air Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
  ]);
  const said19 = async (phone, body) => {
    customer.transport.outbox.length = 0;
    await dm(customer, phone, body);
    const toThem = customer.transport.outbox
      .filter((o) => !o.to || String(o.to).indexOf(phone) !== -1)
      .map((o) => o.text || '')
      .join(' | ');
    const q = customer.transport.outbox.find((o) => o.to === config.escalationNumber && (o.text || '').includes('Question *#'));
    return { said: toThem, q: q ? q.text : '' };
  };
  const F1 = '919000000191';
  await said19(F1, '99999X99X99 1');
  const f1 = await said19(F1, 'Es ki MRP kya h');
  check('"Es ki MRP kya h" is not answered with "Kis part ka?"', !/kis part ka|which part/i.test(f1.said));
  check('...and the rate question names the part we were discussing', f1.q.indexOf('99999X99X99') !== -1);
  const F2 = '919000000192';
  await said19(F2, '16510M65L10 2');
  const f2 = await said19(F2, 'iska stock hai?');
  check('"iska stock hai?" is answered about the part just discussed', f2.said.indexOf('16510M65L10') !== -1);
  check('...and "iska" is never looked up as a part', !/iska/i.test(f2.said) && !/iska/i.test(f2.q));
  const f3 = await said19(F2, '13780M68P01 ka rate kya hai');
  check('a part named in the message beats the one discussed', f3.said.indexOf('13780M68P01') !== -1 && f3.said.indexOf('16510M65L10') === -1);
  const F3 = '919000000193';
  const f4 = await said19(F3, 'Es ki MRP kya h');
  check('with nothing discussed, it still asks which part and asks no one', /kis part ka|which part/i.test(f4.said) && !f4.q);
  check('pointer words are recognised', focus19.pointsBack('Es ki MRP kya h') && focus19.pointsBack('iska rate') && focus19.pointsBack('ye kitna hai'));
  check('an ordinary English "is" is not a pointer', !focus19.pointsBack('Is the shop open today?'));
  check('"iska" and "Eski saleing" are not part names', focus19.isOnlyPointer('iska') && focus19.isOnlyPointer('Eski saleing'));
  check('a real part number is not a pointer', !focus19.isOnlyPointer('16510M65L10'));

  // ---- 20. Rate questions the parser used to read as orders ----
  // "13780M68P01 ka rate" had the rate word LAST, which RATE_RE never looked
  // for, so the part number made it an order and the customer asking a price
  // was asked how many. "oil filter ka rate" named the part by what it is and
  // got "Kis part ka?". The other half is as important: orders stay orders.
  console.log('');
  console.log('[20] rate questions: part number first, and part names');
  for (const r of ['13780M68P01 ka rate', '13780M68P01 rate', 'oil filter ki MRP', 'brake pad ke daam']) {
    check(r + ' is a rate question', (await ai.parseCustomerMessage(r, [])).intent === 'rate');
  }
  for (const r of ['16510M65L10 2', '16510M65L10 5 pise', '13780M68P01', 'same rate pe 5 bhej do']) {
    check(r + ' is still not a rate question', (await ai.parseCustomerMessage(r, [])).intent !== 'rate');
  }
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
    { part_no: '13780M68P01', name: 'Air Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
  ]);
  // The mock portal has no name search; the live one does (11 Sep: 294 matches
  // for oil filter). Stand in for it, and put the real one back afterwards.
  const realSearch20 = portal.searchByName;
  portal.searchByName = async (q) => {
    const rows = [['16510M65L10', 'Oil Filter'], ['13780M68P01', 'Air Filter']].filter(
      ([, n]) => n.toLowerCase().indexOf(String(q).toLowerCase()) !== -1,
    );
    return { total: rows.length, top: rows.map(([partNo, name]) => ({ partNo, name })) };
  };
  const rate20 = async (phone, body) => {
    customer.transport.outbox.length = 0;
    await dm(customer, phone, body);
    const q = customer.transport.outbox.find((o) => o.to === config.escalationNumber && (o.text || '').includes('Question *#'));
    return { said: sent(customer), q: q ? q.text : '' };
  };
  const r20a = await rate20('919000000201', '13780M68P01 ka rate');
  check('13780M68P01 ka rate is not asked how many', !/how many|kitni quantity/i.test(r20a.said));
  check('...its answer names the part', r20a.said.indexOf('13780M68P01') !== -1);
  check('...and nothing went into the cart', !orders.findDraft('sim-919000000201'));
  const r20b = await rate20('919000000202', 'oil filter ka rate kya hai');
  check('oil filter ka rate kya hai finds the part by its name', r20b.said.indexOf('16510M65L10') !== -1);
  const r20c = await rate20('919000000203', 'aaj ka rate kya hai');
  check('aaj ka rate kya hai still asks which part, and asks no one', /kis part ka|which part/i.test(r20c.said) && !r20c.q);

  // 22 Sep, live: a voice note transcribed as "Maruti Suzuki Swift Dzire ka
  // front bumper kitne ka hai?" went to a person as "our team will send it".
  // The catalogue had the part and the portal had its price.
  portal.setMockStock([
    { part_no: '71711M79M00', name: 'BUMPER FRONT | MARUTI SWIFT DZIRE', quantity: 4, price: 2100, mrp: 2500, vendor: 'K' },
    { part_no: '71811M79M00', name: 'BUMPER REAR | MARUTI SWIFT DZIRE', quantity: 2, price: 2300, mrp: 2700, vendor: 'K' },
  ]);
  const bumpers20 = [['71711M79M00', 'BUMPER FRONT | MARUTI SWIFT DZIRE'], ['71811M79M00', 'BUMPER REAR | MARUTI SWIFT DZIRE']];
  portal.searchByName = async (q) => {
    const s = String(q).toLowerCase();
    if (!/bumper/.test(s)) return { total: 0, top: [] };
    const rows = bumpers20.filter(([, n]) => !/front|rear/.test(s) || n.toLowerCase().includes(s.match(/front|rear/)[0]));
    return { total: rows.length, top: rows.map(([partNo, name]) => ({ partNo, name, available: 3 })) };
  };
  const r20d = await rate20('919000000204', 'Maruti Suzuki Swift Dzire ka front bumper kitne ka hai?');
  check('a spoken part name with its price asked finds the part', r20d.said.includes('71711M79M00'));
  check('...gives its price', /₹/.test(r20d.said));
  check('...asks how many, to take the order', /how many|kitne piece/i.test(r20d.said));
  check('...and asks no one', !r20d.q && !/team/i.test(r20d.said));
  check('...nothing went into the cart', !orders.findDraft('sim-919000000204'));
  const r20e = await rate20('919000000205', 'Swift Dzire ka bumper kitne ka hai');
  check('a name that fits two parts asks which', /front|rear|kaunsa|which/i.test(r20e.said) && !r20e.q);
  const r20f = await rate20('919000000205', 'front');
  check('...and the pick is answered with its price', r20f.said.includes('71711M79M00') && /₹/.test(r20f.said));
  check('...not put in the cart', !orders.findDraft('sim-919000000205'));
  const r20g = await rate20('919000000206', 'Swift Dzire ka bumper kitne ka hai');
  check('the list is numbered and priced', /1\. 71711M79M00/.test(r20g.said) && /2\. 71811M79M00/.test(r20g.said) && /MRP ₹/.test(r20g.said));
  const r20h = await rate20('919000000206', '2');
  check('"2" picks the second part and prices it', r20h.said.includes('71811M79M00') && /kitne piece|how many/i.test(r20h.said));
  check('...not as a quantity', !orders.findDraft('sim-919000000206'));

  // 22 Sep, live, one chat: the car named once is the car for the next
  // question; "price kitna hai" and "account bna do" are not answers to
  // "Kaunsi gaadi?"; and "Create a customer" crashed on a stray variable.
  const seen20 = [];
  const searchWas20 = portal.searchByName;
  portal.searchByName = async (q) => { seen20.push(String(q)); return searchWas20(q); };
  await rate20('919000000207', 'Swift Dzire bumper price');
  const r20i = await rate20('919000000207', 'mera gaadi ka rear bumper kitne ka hai');
  check('the car named before is searched with the next part', seen20.some((q) => /rear bumper/i.test(q) && /dzire/i.test(q)));
  check('...and answers with that car\'s part', r20i.said.includes('71811M79M00'));
  portal.searchByName = searchWas20;
  const clar20 = require('../src/core/clarify');
  clar20.ask('sim-919000000208', { base: 'bumper', qty: 1 }, { facet: 1, text: 'Kaunsi gaadi?' });
  const r20j = await rate20('919000000208', 'Price kitna hai');
  check('"Price kitna hai" is not taken as the car', !clar20.get('sim-919000000208') && !/kaunsi gaadi/i.test(r20j.said));
  check('"Account bna do mera" opens an account', require('../src/core/customerCreate').wantsToStart('Account bna do mera'));
  const cust20 = require('../src/core/customers');
  const resolveWas20 = cust20.resolve;
  cust20.resolve = async (p) => (String(p).includes('919000000209') ? { found: false } : resolveWas20(p));
  const r20k = await rate20('919000000209', 'Create a customer');
  cust20.resolve = resolveWas20;
  check('"Create a customer" from a new number answers, and does not crash', /GST/i.test(r20k.said));
  require('../src/core/customerCreate').cancel('sim-919000000209');
  check('a model year is never a part word', require('../src/core/partish').isYear('2018') && !require('../src/core/partish').isYear('16510'));

  // 22 Sep, live: eighteen part numbers the portal did not know went to a
  // person and came back as eighteen "abhi confirm nahi ho paya" - while the
  // portal had sixteen of them as <number>5PK. Offer the close match, one at a
  // time, Haan / Nahi, then the whole order priced.
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 100, mrp: 120, vendor: 'K' },
    { part_no: '71761M67LA05PK', name: 'Bumper| Front Side | WagonR', quantity: 30, price: 50, mrp: 60, vendor: 'K' },
    { part_no: '71791M85S005PK', name: 'BUMPER | ERTIGA/SWIFT | FRONT LOWER', quantity: 26, price: 500, mrp: 560, vendor: 'K' },
  ]);
  const cat20 = [['71761M67LA05PK', 'Bumper| Front Side | WagonR', 30], ['71791M85S005PK', 'BUMPER | ERTIGA/SWIFT | FRONT LOWER', 26]];
  portal.searchByName = async (q) => {
    const w = String(q).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const rows = cat20.filter(([p]) => p.startsWith(w));
    return { total: rows.length, top: rows.map(([partNo, name, available]) => ({ partNo, name, available })) };
  };
  const near20 = await rate20('919000000210', '16510M65L10 2 pcs\n71761m67LA0 4 pcs\n71791m85S00 4 pcs\n71799Z99Z99 2 pcs');
  const asks20 = customer.transport.outbox.filter((o) => o.to === config.escalationNumber && /Question \*#/.test(o.text || ''));
  const asked20 = asks20.map((o) => o.text).join('\n');
  check('close matches are offered, not sent to a person', asks20.length === 1 && /71761M67LA05PK/.test(near20.said) && /\(1\/2\)/.test(near20.said));
  // A number with NO match goes to a person - with who is asking and the
  // whole list it came in - and the customer hears it is being checked.
  check('...a number with no match goes to a person', /71799Z99Z99/.test(asked20) && /Checking 71799Z99Z99|71799Z99Z99 check kar raha/i.test(near20.said));
  check('...who sees the customer\'s name and the whole list', /Mock Customer/.test(asked20) && /_Their message:_[\s\S]*71761m67LA0 4 pcs/.test(asked20));
  check('...and the part that WAS found is already in the order', (orders.findDraft('sim-919000000210') || { lines: [] }).lines.length === 1);
  const near20b = await rate20('919000000210', 'haan');
  check('"haan" adds the close match with the quantity asked', (orders.findDraft('sim-919000000210').lines.find((l) => /71761M67LA05PK/.test(l.partNo || l.item)) || {}).qty === 4);
  check('...and the next one is asked', /\(2\/2\)/.test(near20b.said) && /71791M85S005PK/.test(near20b.said));
  const near20c = await rate20('919000000210', 'nahi');
  check('"nahi" says sorry, not available', /Sorry, 71791m85S00 available nahi hai/i.test(near20c.said));
  check('...and the last answer brings the whole order priced, with pieces', /16510M65L10 x2/.test(near20c.said) && /71761M67LA05PK x4/.test(near20c.said) && /total/i.test(near20c.said) && /confirm/i.test(near20c.said));
  check('...with the refused part left out', !orders.findDraft('sim-919000000210').lines.some((l) => /71791M85S0/.test(l.partNo || l.item)));
  check('a pack part says so in the question', /71761M67LA05PK\* \(5 ka pack\)|71761M67LA05PK\* \(pack of 5\)/.test(near20.said) && /4 pcs/.test(near20.said));
  orders.clearDraft && orders.clearDraft('sim-919000000210');

  // The founder's example, 22 Sep: "cartrend wiper blade 16 number 10 pcs"
  // is not on the portal. It goes to the helper with who is asking and what
  // they sent; the helper's words go to the customer AND are kept, so the next
  // customer asking the same thing gets them without anyone being asked.
  {
    const k20 = require('../src/core/knowledge');
    customer.transport.outbox.length = 0;
    await dm(customer, '919000000292', 'cartrend wiper blade 16 number 10 pcs');
    const wq = customer.transport.outbox.find((o) => o.to === config.escalationNumber && /Question \*#/.test(o.text || '') && /wiper/i.test(o.text || ''));
    check('a part the portal does not have goes to the helper, with who is asking', Boolean(wq) && /Mock Customer/.test(wq.text));
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({
      from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber, isGroup: false,
      body: 'Cartrend wiper 16 inch abhi stock mein nahi hai, 2 din mein aayega', contextId: wq && wq.id, mediaType: 'chat',
    });
    check('...the helper\'s words reach the customer', customer.transport.outbox.some((o) => String(o.to).indexOf('919000000292') >= 0 && /2 din mein aayega/.test(o.text || '')));
    check('...and are learned', Boolean(k20.findNote('cartrend wiper blade 16 number')));
    customer.transport.outbox.length = 0;
    await dm(customer, '919000000293', 'Cartrend wiper blade 16 number 5 pcs');
    check('the next customer asking the same gets that answer', customer.transport.outbox.some((o) => String(o.to).indexOf('919000000293') >= 0 && /2 din mein aayega/.test(o.text || '')));
    check('...and nobody is asked again', !customer.transport.outbox.some((o) => o.to === config.escalationNumber && /Question \*#/.test(o.text || '')));
    check('a learned answer is not given to a different question', !k20.findNote('wiper') && !k20.findNote('cartrend wiper blade 18 number'));
  }

  // "2 box" is two boxes, whatever each holds; "4 pcs" is four pieces.
  const box20 = await rate20('919000000291', '71791m85S00 2 box');
  check('"2 box" is asked about as 2 box', /Yahi chahiye, 2 box\?|2 box of this one\?/.test(box20.said) && /\(5 ka pack\)|\(pack of 5\)/.test(box20.said));
  const box20b = await rate20('919000000291', 'haan');
  check('...ordered as 2 box', (orders.findDraft('sim-919000000291').lines[0] || {}).unit === 'box' && orders.findDraft('sim-919000000291').lines[0].qty === 2);
  check('...and the priced list says box, not pcs', /71791M85S005PK x2 box/.test(box20b.said) && /Total[^\n]*2 box/.test(box20b.said) && !/2 pcs/.test(box20b.said));
  orders.clearDraft && orders.clearDraft('sim-919000000291');
  portal.searchByName = realSearch20;

  // ---- 21. A salesman ordering FOR a customer ----
  // Sir, 11 Sep: "Kalra Motors ka SO bana do" -> which customer -> parts ->
  // draft SO -> haan -> punch -> Confirm SO. The mock portal calls EVERY
  // number "Mock Customer" (buyer 1) - the same trap as Agent Hajra being
  // saved as M/S Maan Motors - so the buyer must be the customer PICKED.
  console.log('');
  console.log('[21] a salesman ordering for a customer');
  const salesOrder21 = require('../src/core/salesOrder');
  const SALES21 = '919000000211';
  config.salesTeamNumbers.push(SALES21);
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
    { part_no: '13780M68P01', name: 'Air Filter', quantity: 50, price: 1, mrp: 1, vendor: 'K' },
  ]);
  portal.setMockCustomers([
    { id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Karol Bagh, Delhi (IN)', group_name: 'Agent Seema- 9289015775' },
    { id: 7059, name: 'anuj', home_branch_dealer: 23, address: 'Gurugram, Haryana (IN)', group_name: '' },
    { id: 8191, name: 'Anuj', home_branch_dealer: 1078, address: 'Jaipur, Rajasthan (IN)', group_name: '' },
    { id: 5623, name: 'Tanuj R', home_branch_dealer: 23, address: '', group_name: '' },
    { id: 345, name: 'M/S Maan Motors', home_branch_dealer: 23, address: 'Babarpur, Haryana (IN)', group_name: 'Agent Seema- 9289015775' },
  ]);
  salesOrder21._resetDirectory();
  // Smoke runs with punching ON (line 19). The first flow below is the
  // punching-OFF one, so switch it off here and put back what it was after.
  const wasOn21 = config.dealerPortal.confirmEnabled;
  config.dealerPortal.confirmEnabled = false;

  check('Kalra Motors ka SO bana do names the customer', salesOrder21.parseOrderFor('Kalra Motors ka SO bana do').customer === 'Kalra Motors');
  check('Kalra ka order kab aayega is a status question', salesOrder21.parseOrderFor('Kalra ka order kab aayega') === null);
  check('a part number is never read as a customer', salesOrder21.parseOrderFor('16510M65L10 ka order') === null);
  const anuj21 = await salesOrder21.findCustomers('Anuj');
  check('Anuj finds anuj and Anuj', anuj21.top.map((r) => r.id).sort().join(',') === '7059,8191');
  check('Anuj never finds Tanuj', !anuj21.top.some((r) => r.id === 5623));

  const say21 = async (phone, body) => {
    customer.transport.outbox.length = 0;
    await dm(customer, phone, body);
    return sent(customer);
  };
  const maan21a = await say21(SALES21, 'Maan Motors ka SO bana do');
  check('the salesman is asked whether it is this customer, by name', /Maan Motors/.test(maan21a) && /this one|yahi wale/i.test(maan21a));
  await say21(SALES21, 'haan');
  await say21(SALES21, '16510M65L10 2');
  const draft21a = orders.findDraft('sim-' + SALES21);
  check('the draft is for the customer picked (buyer 345), not the salesman number', !!draft21a && !!draft21a.portalCustomer && draft21a.portalCustomer.buyerId === 345);
  markAsked('sim-' + SALES21);
  const maan21b = await say21(SALES21, 'haan');
  check('with punching off, the salesman is told the SO was not punched', /haven.t punched|punch nahi kiya/i.test(maan21b));

  const anuj21a = await say21(SALES21, 'Anuj ka SO: 13780M68P01 5');
  check('two Anujs are listed, and Tanuj is not', /1\. anuj/.test(anuj21a) && /2\. Anuj/.test(anuj21a) && !/Tanuj/.test(anuj21a));
  const anuj21b = await say21(SALES21, 'haan');
  check('a bare haan with two candidates asks which one', /1 or 2|1 ya 2/.test(anuj21b));
  await say21(SALES21, '2');
  const draft21b = orders.findDraft('sim-' + SALES21);
  check('picking 2 orders for Anuj (buyer 8191), with the parts sent earlier', !!draft21b && draft21b.portalCustomer.buyerId === 8191 && draft21b.lines.length === 1);

  const cust21 = await say21('919000000212', 'Kalra Motors ka order');
  check('a customer writing X ka order gets no customer picker', !/this one\?|yahi wale\?|Which one\?|Kaunsa wala\?/i.test(cust21));

  config.dealerPortal.confirmEnabled = true;
  await say21(SALES21, 'Kalra Motors ka SO bana do' + String.fromCharCode(10) + '16510M65L10 1');
  await say21(SALES21, 'haan');
  markAsked('sim-' + SALES21);
  // Sir sees the draft SO document first and the confirmed one after
  // Confirm SO (founder, 12 Sep: "pehle draft ka fir confirm ke baad
  // confirm vala") - the file the team used to download by hand.
  const docs21 = [];
  const hadDoc21 = customer.transport.sendDocument;
  customer.transport.sendDocument = async (chatId, buf, name, mime) => { docs21.push({ name, mime, head: buf.slice(0, 5).toString('latin1') }); };
  const punch21a = await say21(SALES21, 'haan');
  check('punching on: the SO is punched for the customer picked', /punch/i.test(punch21a) && /Kalra Motors/.test(punch21a));
  check('...in the salesman message, not the customer one with its cross-sell', !/Ye bhi lag sakta|You may also need/i.test(punch21a));
  check('...and the DRAFT SO document goes out to be checked', docs21.length === 1 && /^Draft SO /.test(docs21[0].name) && /Kalra Motors/.test(docs21[0].name));
  check('...followed by one plain question, nothing more', /sahi hai|all good/i.test(punch21a));
  const punch21b = await say21(SALES21, 'haan');
  check('the haan on the draft confirms the SO', /confirm ho gaya|confirmed/i.test(punch21b));
  check('...and the CONFIRMED SO document follows it', docs21.length === 2 && docs21[1].mime === 'application/pdf' && docs21[1].head === '%PDF-' && /^SO /.test(docs21[1].name) && /Kalra Motors/.test(docs21[1].name));
  const realPdf21 = portal.soPdf;
  portal.soPdf = async () => null;
  await say21(SALES21, 'Kalra Motors ka SO bana do' + String.fromCharCode(10) + '13780M68P01 1');
  await say21(SALES21, 'haan');
  markAsked('sim-' + SALES21);
  const nodraft21 = await say21(SALES21, 'haan');
  check('no Odoo SO yet: the draft comes as a list, and no file', docs21.length === 2 && /draft so/i.test(nodraft21));
  const nopdf21 = await say21(SALES21, 'haan');
  check('...and it still confirms', docs21.length === 2 && /confirm ho gaya|confirmed/i.test(nopdf21));
  portal.soPdf = realPdf21;
  customer.transport.sendDocument = hadDoc21;
  // The name search gives no home branch. The portal record by phone is used
  // only if it is the SAME account (the mock says every phone is buyer 1 -
  // the Hajra case - so here it is not), else the company rule.
  config.dealerPortal.confirmEnabled = false;
  portal.setMockCustomers([
    { id: 2046, name: 'Bp Motors', address: 'Sanganer, Jaipur, Rajasthan (IN)', state_name: 'Rajasthan (IN)', mobile: '+91 90000 00828' },
    { id: 532, name: 'Samrat Motors', address: 'Sector 5, Gurugram, Haryana (IN)', state_name: 'Haryana (IN)' },
  ]);
  await say21(SALES21, 'Bp Motors ka SO: 16510M65L10 1');
  await say21(SALES21, 'haan');
  const bp21 = orders.findDraft('sim-' + SALES21);
  check('a Rajasthan customer with no branch on record is served from Mansarovar (1078)', !!bp21 && bp21.portalCustomer.branchId === 1078);
  check('...by the rule, because the phone belongs to another account', !!bp21 && bp21.portalCustomer.branchFrom === 'rule' && bp21.portalCustomer.buyerId === 2046);
  await say21(SALES21, 'Samrat Motors ka SO: 16510M65L10 1');
  await say21(SALES21, 'haan');
  const sm21 = orders.findDraft('sim-' + SALES21);
  check('a Haryana customer with no branch on record is served from Bijwasan (23)', !!sm21 && sm21.portalCustomer.branchId === 23 && sm21.portalCustomer.buyerId === 532);
  // Parts from a salesman who has NOT said who they are for: a stock answer,
  // never a cart - their SIM may be saved on some customer's account.
  salesOrder21.clear('sim-' + SALES21);
  const open21 = orders.findDraft('sim-' + SALES21);
  if (open21) orders.cancel(open21);
  const bare21 = await say21(SALES21, '13780M68P01 3');
  check('a salesman with no customer picked still gets the stock answer', /13780M68P01/.test(bare21));
  check('...and no cart is built for whoever owns the SIM', !orders.findDraft('sim-' + SALES21));
  config.dealerPortal.confirmEnabled = wasOn21;
  config.salesTeamNumbers.splice(config.salesTeamNumbers.indexOf(SALES21), 1);

  // ---- 22. Catalogue names for new inventory ----
  // 11 Sep: two Skoda parts reached the portal named just "windshield". Every
  // part is named "Part | Position | Car | Variant | #PartNo", and that one
  // string goes into part_name AND attribute_desc, with quantity 1 / India.
  console.log('');
  console.log('[22] catalogue names for new inventory');
  const naming22 = require('../src/core/partNaming');
  const listed22 = await naming22.nameFor({ partNo: '41800M79G00', partName: 'shocker', brand: 'MARUTI' });
  check('a part in the reference list keeps its list name verbatim', listed22.source === 'list' && listed22.name === 'Shocker| Rear | Maruti Alto (old, 2000-2012) | All Variants | #41800M79G00');
  const sib22 = await naming22.nameFor({ partNo: '41800m79g99', partName: 'shock absorber', brand: 'maruti' }, { useModel: false });
  check('a new Alto rear shocker is named exactly like its siblings, part no in capitals', sib22.source === 'learned' && sib22.name === 'Shocker| Rear | Maruti Alto (old, 2000-2012) | All Variants | #41800M79G99');
  const side22 = await naming22.nameFor({ partNo: '41602M51U09', partName: 'shocker', brand: 'maruti' }, { useModel: false });
  check('...and a side shocker in its own family format', side22.name === 'Shocker | Left Side | Maruti XL6 | All Variants | #41602M51U09');
  const af22 = await naming22.nameFor({ partNo: '13780M62B07', partName: 'air filter', brand: 'maruti' }, { useModel: false });
  check('a new air filter keeps the blank position section', af22.name === 'Air Filter|  | Maruti S-Presso | Petrol | #13780M62B07');
  check('list names, and sibling names in a family the list proves, are created', naming22.safeToCreate(listed22) && naming22.safeToCreate(sib22) && naming22.safeToCreate(side22));
  // Air filters (8 of 17) and front-right shockers (110 of 117) do not come out
  // exactly when hidden from the list, so their siblings' name is only a suggestion.
  const fr22 = await naming22.nameFor({ partNo: '41601M51U09', partName: 'shocker', brand: 'maruti' }, { useModel: false });
  check('...but an air filter or front-right shocker named from siblings is held', !naming22.safeToCreate(af22) && !naming22.safeToCreate(fr22));
  const trusted22 = naming22._internals.book().trusted;
  check('the list proves rear and left-side shockers only', trusted22.has('41800') && trusted22.has('41602') && !trusted22.has('41601') && !trusted22.has('13780'));
  // M792 is an Omni filter in 13780M79250 and an 800/Alto one in 13780M79201.
  const split22 = await naming22.nameFor({ partNo: '13780M79299', partName: 'air filter', brand: 'maruti' }, { useModel: false });
  check('siblings that disagree on the car teach nothing, and the part is held', split22.source !== 'learned' && !naming22.safeToCreate(split22));
  const sk22 = await naming22.nameFor({ partNo: '3V5845049RNVB', partName: 'windshield', brand: 'skoda' }, { useModel: false });
  check('an unknown part gets the basic shape and is held for a person', sk22.source === 'basic' && sk22.check && !naming22.safeToCreate(sk22) && sk22.name === 'Windshield |  | Skoda |  | #3V5845049RNVB');
  const body22 = portal._partBody({ partNo: '3v5845049rnvb', partName: 'windshield', brand: 'skoda', standardName: sk22.name });
  check('create-part gets the same name in part_name and attribute_desc', body22.part_name === sk22.name && body22.attribute_desc === sk22.name);
  check('...with quantity 1, country India and the part no in capitals', body22.attribute_quantity === '1' && body22.attribute_country_origin === 'India' && body22.part_no === '3V5845049RNVB');
  check('a request with no worked-out name still sends the mail name', portal._partBody({ partNo: 'X1', partName: 'bolt', brand: 'b' }).part_name === 'bolt');

  // ---- 23. "Naam ye rakhun?" — the data-entry desk's OK on WhatsApp ----
  // A name the list cannot confirm is asked first. OK creates the part with
  // it; otherwise the bot asks for the right name, creates the part with that,
  // and remembers it for the next time.
  console.log('');
  console.log('[23] a part name confirmed or corrected on WhatsApp');
  const approvals23 = require('../src/core/partApprovals');
  const fs23 = require('fs');
  const path23 = require('path');
  const wasShared23 = config.sharedDir;
  config.sharedDir = path23.join(config.dataDir, 'shared-smoke-23');
  fs23.rmSync(config.sharedDir, { recursive: true, force: true });
  naming22._internals.useExamples(null);
  const DESK23 = '919000000231';
  config.dataEntryAlertNumbers.push(DESK23);
  const made23 = [];
  const realCreate23 = portal.createPart;
  portal.createPart = async (f) => {
    made23.push(f);
    return { partNo: String(f.partNo).toUpperCase() };
  };
  const ask23 = {
    requestId: 'REQ-TEST-231',
    fields: { partNo: '3V5845049RNVB', partName: 'windshield', brand: 'skoda', hsnCode: '70071100' },
    hsnFound: true,
    suggested: 'Windshield | Front | Skoda Superb 3rd Gen | All Variants | #3V5845049RNVB',
  };
  const q23 = approvals23.askText(ask23);
  check('the question names the part, the mail word and the suggestion', /3V5845049RNVB/.test(q23) && /windshield/.test(q23) && /Naam ye rakhun\?/.test(q23) && q23.includes(ask23.suggested));
  approvals23.add(ask23);
  customer.transport.outbox.length = 0;
  await dm(customer, DESK23, 'haan');
  check('OK creates the part with the suggested name', made23.length === 1 && made23[0].standardName === ask23.suggested);
  check('...tells the desk it is done', /Bana diya/.test(sent(customer)));
  check('...and closes the question', approvals23.all().length === 0);
  const again23 = await naming22.nameFor({ partNo: '3V5845049RNVB', partName: 'windshield', brand: 'skoda' }, { useModel: false });
  check('the OK name is remembered and used next time without asking', again23.source === 'confirmed' && again23.name === ask23.suggested && naming22.safeToCreate(again23));

  approvals23.add({ requestId: 'REQ-TEST-232', fields: { partNo: '3V0845011AHNVB', partName: 'windshield', brand: 'skoda' }, suggested: 'Windshield |  | Skoda |  | #3V0845011AHNVB' });
  customer.transport.outbox.length = 0;
  await dm(customer, DESK23, 'nahi');
  check('not OK asks for the right name and creates nothing', /sahi naam/i.test(sent(customer)) && made23.length === 1);
  customer.transport.outbox.length = 0;
  await dm(customer, DESK23, 'Windshield | Rear | Skoda Octavia 3rd Gen | All Variants');
  check('the typed name creates the part, with the part number added', made23.length === 2 && made23[1].standardName === 'Windshield | Rear | Skoda Octavia 3rd Gen | All Variants | #3V0845011AHNVB');
  check('...and is remembered for next time', (await naming22.nameFor({ partNo: '3V0845011AHNVB' }, { useModel: false })).source === 'confirmed');
  const idle23 = await approvals23.handle(customer, { from: DESK23, chatId: 'sim-' + DESK23, isGroup: false }, 'haan', async () => true);
  check('with no question open, the desk chats like anyone else', idle23 === false);

  portal.createPart = realCreate23;
  config.dataEntryAlertNumbers.splice(config.dataEntryAlertNumbers.indexOf(DESK23), 1);
  fs23.rmSync(config.sharedDir, { recursive: true, force: true });
  config.sharedDir = wasShared23;
  naming22._internals.useExamples(null);

  // ---- 24. Asking ABOUT a customer: orders, ledger, credit notes ----
  // Sir, 11 Sep: "Kalra ka order kab aayega" used to be answered with the
  // SALESMAN own draft. It must answer with that customer real orders.
  console.log('');
  console.log('[24] a salesman asking about a customer');
  const lookup24 = require('../src/core/customerLookup');
  const odoo24 = require('../src/integrations/odoo');
  const SALES24 = SALES21;
  config.salesTeamNumbers.push(SALES24);
  portal.setMockCustomers([
    { id: 265, name: 'Kalra Motors', address: 'Karol Bagh, Delhi (IN)', balance: '76931.84', pdc_amount: '56385.00', credit_limit: '100000.00', credit_days: 1, odoo_partner_id: 1734 },
    { id: 264, name: 'Kalra Car Decor', address: 'Rohini, Delhi (IN)', balance: '0.00', odoo_partner_id: 1735 },
  ]);
  const realOdoo24 = { enabled: odoo24.enabled, ledger: odoo24.ledger, creditNotes: odoo24.creditNotes };
  odoo24.enabled = () => true;
  odoo24.ledger = async () => ({
    name: 'Kalra Motors',
    due: 76931.84,
    overdue: 0,
    documents: [
      { kind: 'invoice', name: 'CT-DL-26-27/3202', date: '2026-09-11', total: 13920, pending: 13920, paid: false },
      { kind: 'invoice', name: 'CT-DL-26-27/3168', date: '2026-09-09', total: 3491.68, pending: 0, paid: true },
    ],
  });
  odoo24.creditNotes = async () => [{ name: 'CN-CT-26-27/704', date: '2026-09-04', total: 1047.2, pending: 1047.2, used: false }];

  check('a status question is not read as an order', lookup24.parse('Kalra ka order kab aayega').intent === 'status' && salesOrder21.parseOrderFor('Kalra ka order kab aayega') === null);
  check('...and "X ka SO bana do" is still an order, not a question', lookup24.parse('Kalra Motors ka SO bana do') === null);

  const st24 = await say21(SALES24, 'Kalra Motors ka order kab aayega');
  check('the salesman gets that customer real orders', /512/.test(st24) && /235866/.test(st24) && /Kalra Motors/.test(st24));
  check('...not his own draft', !/ORD-/.test(st24));
  check('...with how far each order has come', /allocate|allocated|dispatch|confirm/i.test(st24));

  const led24 = await say21(SALES24, 'Kalra Motors ka ledger');
  check('the ledger shows the balance, PDC and limit', /76,932/.test(led24) && /56,385/.test(led24) && /1,00,000/.test(led24));
  check('...and the bills behind it', led24.indexOf('CT-DL-26-27/3202') >= 0 && /13,920/.test(led24));

  const cn24 = await say21(SALES24, 'Kalra Motors ke credit note');
  check('credit notes are listed with what is left on them', cn24.indexOf('CN-CT-26-27/704') >= 0 && /1,047/.test(cn24));

  const amb24 = await say21(SALES24, 'Kalra ka ledger');
  check('two Kalras: it asks which one, the same way as for an order', /Kaunsa wala|Which one/i.test(amb24) && amb24.indexOf('1. Kalra') >= 0);
  const pick24 = await say21(SALES24, '1');
  check('...and the answer follows the pick', /76,932/.test(pick24));
  check('...the picker is closed afterwards', !salesOrder21.activeCustomer('sim-' + SALES24));

  odoo24.enabled = realOdoo24.enabled;
  odoo24.ledger = realOdoo24.ledger;
  odoo24.creditNotes = realOdoo24.creditNotes;
  config.salesTeamNumbers.splice(config.salesTeamNumbers.indexOf(SALES24), 1);

  // ---- 25. The bill for one order, as the portal PDF ----
  // 12 Sep: /warehouse/orders/{id}/confirmed-invoice returns the real bill
  // (order 486: 97 KB). Odoo own ledger PDF is not reachable with the API
  // key, so only this one is sent as a file.
  console.log('');
  console.log('[25] the bill for an order');
  config.salesTeamNumbers.push(SALES21);
  const bills25 = [];
  const hadDoc25 = customer.transport.sendDocument;
  customer.transport.sendDocument = async (chatId, buf, name, mime, caption) => {
    bills25.push({ name, mime, caption, head: buf.slice(0, 5).toString('latin1') });
  };
  await say21(SALES21, '486 ka bill');
  check('the bill comes back as a PDF file', bills25.length === 1 && bills25[0].mime === 'application/pdf' && bills25[0].head === '%PDF-');
  check('...named by the bill number and the customer', bills25[0].name.indexOf('CT-TEST-1') >= 0 && bills25[0].name.indexOf('Mock Customer') >= 0);
  const nobill25 = await say21(SALES21, '999 ka bill');
  check('an order with no bill says so, and sends no file', bills25.length === 1 && /bill abhi nahi bana|has no bill yet/i.test(nobill25));
  check('a part number is never read as a bill request', require('../src/core/customerLookup').parseBill('16510M65L10 ka order') === null);
  customer.transport.sendDocument = hadDoc25;
  config.salesTeamNumbers.splice(config.salesTeamNumbers.indexOf(SALES21), 1);

  // ---- 26. The inbox behind the console ----
  // Every message in and out is recorded (core/chatLog), so the founder can
  // see who wrote to the line and what the bot answered.
  console.log('');
  console.log('[26] every message lands in the inbox');
  const chatLog26 = require('../src/core/chatLog');
  const INBOX26 = '919000000261';
  await dm(customer, INBOX26, 'hello');
  const mine26 = chatLog26.chats({ limit: 80 }).find((c) => c.phone === INBOX26);
  check('the message that came in is in the inbox', !!mine26 && mine26.inCount >= 1);
  const msgs26 = chatLog26.messages(INBOX26, { limit: 30 });
  check('...with the text exactly as it arrived', msgs26.some((m) => m.dir === 'in' && m.text === 'hello'));
  check('...and what the bot answered', msgs26.some((m) => m.dir === 'out' && m.text));
  check('...newest conversation first', chatLog26.chats({ limit: 5 })[0].at >= mine26.at);

  // ---- 27. what the Kalra Motor replay found (12 Sep) ----
  // Three weeks of a real customer, fed back at the bot one message at a time.
  // Every check here is a thing that went wrong on that run.
  console.log('\n[27] the Kalra Motor replay');
  const ai27 = require('../src/core/ai');

  // "No" is how this customer writes "number". The token came out as
  // "No81830m73rb3", the portal knew nothing by that name, and the bot said
  // NOTHING - five times in three weeks.
  check('a part number does not carry "No" on its front', ai27.partNumberIn('2pise No81830m73rb3') === '81830m73rb3');
  check('...nor "no." with a dot', ai27.partNumberIn('1pise no.72390m68p00') === '72390m68p00');
  check('...and a real part number is untouched', ai27.partNumberIn('11610M55RA1 MOUNTING COMP ENG RH') === '11610M55RA1');
  check('..."Nozzle 16510M68K00" is not mistaken for a prefix', ai27.partNumberIn('Nozzle 16510M68K00') === '16510M68K00');

  // "Dedo ji" is this customer saying yes. It sat unanswered while the desk
  // replied "ok sir".
  const say27 = async (text) => (await ai27.parseCustomerMessage(text, [])).intent;
  check('"Dedo ji" is a yes', (await say27('Dedo ji')) === 'confirm');
  check('"de do" is a yes', (await say27('de do')) === 'confirm');
  check('"send it" is a yes', (await say27('send it')) === 'confirm');
  check('...but a question is still not', (await say27('de dun?')) !== 'confirm');

  // A customer asking about their OWN account. Until now every one of these
  // went to a person while the desk answered with a ledger and a figure.
  const lookup27 = require('../src/core/customerLookup');
  check('"8502 OUTSTANDING AMOUNT" asks for their ledger', (lookup27.parseOwn('8502 OUTSTANDING AMOUNT') || {}).intent === 'ledger');
  check('"Billed or not?" asks what is billed', (lookup27.parseOwn('Billed or not?') || {}).intent === 'billed');
  check('"Send credit of returned items" asks for credit notes', (lookup27.parseOwn('Send credit of returned items') || {}).intent === 'credit');
  check('"credit limit" is not a credit note', (lookup27.parseOwn('mera credit limit kya hai') || {}).intent === 'ledger');
  check('"Baki bill kardo" is an instruction, not a balance question', lookup27.parseOwn('Baki bill kardo') === null);
  check('"Kalra ka ledger" still belongs to the salesman flow', lookup27.parseOwn('Kalra ka ledger') === null);

  // A rate comes from the DEALER PORTAL and nowhere else. Odoo's list_price
  // used to be the fallback and the two disagree (23820M79J20 is 3,599 on
  // the portal, 3,489 in Odoo), so an Odoo figure is a price the customer
  // will not be charged — the order is punched against the portal. The
  // portal's `price` is our PURCHASE price and is never quoted either.
  const rates27 = require('../src/core/rates');
  const cfg27 = require('../src/config').dealerPortal;
  const hadListAcct27 = cfg27.listPriceAccountId;
  // Pinned here rather than inherited from whichever section ran last: the
  // mock portal prices from this table, so the rate tests own it.
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter', quantity: 12, price: 105, mrp: 130, vendor: 'Northend' }]);

  // A customer the portal knows: their own account's MRP, discount and net.
  const known27 = await rates27.quote(
    ['16510M65L10'],
    { name: 'Mock Customer', ctx: { accountId: 1, branchId: 23 }, lines: [] },
    (en) => en,
  );
  check('a registered customer gets the portal MRP', /16510M65L10 - MRP ₹130/.test(known27) && /GST/.test(known27));
  check('...with their own discount and net rate', /₹114.4/.test(known27) && /12% off/.test(known27));
  check('...and our purchase price is nowhere in it', !/105/.test(known27));

  // Nobody the portal knows, and no house account configured: no price at
  // all rather than a guess — the question goes to a person.
  cfg27.listPriceAccountId = null;
  check('an unregistered customer with no house account is not quoted', (await rates27.quote(['16510M65L10'], null, (en) => en)) === null);

  // House account configured: the portal MRP, and ONLY the MRP. That
  // account's discount is ours, not theirs, and must never be quoted as
  // their rate.
  cfg27.listPriceAccountId = 1;
  const houseOnly27 = await rates27.quote(['16510M65L10'], null, (en) => en);
  check('an unregistered customer gets the portal MRP', /16510M65L10 - MRP ₹130/.test(houseOnly27));
  check('...but never the house account discount as their rate', !/114.4/.test(houseOnly27) && !/12% off/.test(houseOnly27));

  // Lower case: the portal catalogue is case-sensitive and the quote
  // upper-cases before asking. 13 Sep this cost a rate.
  check('a part typed in lowercase is still priced', /MRP ₹130/.test(await rates27.quote(['16510m65l10'], null, (en) => en)));

  check('a part the portal cannot price is not quoted at all', (await rates27.quote(['ZZZZ9999'], null, (en) => en)) === null);
  cfg27.listPriceAccountId = hadListAcct27;


  // ---- 28. the same thing happening twice ----
  // A webhook Meta believes was not acknowledged is sent again; a customer
  // double-taps; two events arrive in the same tick. Measured 12 Sep: two
  // "yes" together punched the order TWICE.
  console.log('\n[28] a message that arrives twice');
  const seen28 = require('../src/core/seen');
  check('the first time a message id is seen, it is new', seen28.firstTime('customer', 'wamid.TEST28') === true);
  check('...the second time it is not', seen28.firstTime('customer', 'wamid.TEST28') === false);
  check('...a different bot has its own record of it', seen28.firstTime('dataentry', 'wamid.TEST28') === true);
  check('...and a message with no id is never dropped', seen28.firstTime('customer', null) === true && seen28.firstTime('customer', null) === true);
  check('...the record survives in state.json, not only in memory', Boolean(store.load().seenMessages['customer:wamid.TEST28']));

  // Two "yes" in the same tick: one punch, and the second is told to wait.
  const DUP28 = '919000000928';
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'N' }]);
  await dm(customer, DUP28, 'Brake Pad - 5');
  markAsked('sim-' + DUP28);
  let punches28 = 0;
  const realConfirm28 = portal.confirm;
  portal.confirm = async (...a) => {
    punches28++;
    await new Promise((r) => setTimeout(r, 40)); // the portal takes a moment
    return realConfirm28.apply(portal, a);
  };
  customer.transport.outbox.length = 0;
  await Promise.all([dm(customer, DUP28, 'yes'), dm(customer, DUP28, 'yes')]);
  portal.confirm = realConfirm28;
  check('two yes in the same tick punch the order ONCE', punches28 === 1);
  check('...and the second one is answered, not ignored', /ek minute|one moment|draft so/i.test(sent(customer)));

  // The webhook signature. Meta signs the raw bytes with the app secret.
  const sig28 = require('../src/wa/signature');
  const crypto28 = require('crypto');
  const body28 = '{"object":"whatsapp_business_account","entry":[]}';
  const good28 = 'sha256=' + crypto28.createHmac('sha256', 'top-secret').update(body28).digest('hex');
  check('a correctly signed body passes', sig28.valid(body28, good28, 'top-secret') === true);
  check('a forged body does not', sig28.valid('{"object":"forged"}', good28, 'top-secret') === false);
  check('a missing signature does not', sig28.valid(body28, '', 'top-secret') === false);
  check('a signature of the wrong shape does not', sig28.valid(body28, 'sha1=deadbeef', 'top-secret') === false);
  check('with no secret configured, nothing is rejected', sig28.valid(body28, '', '') === true);


  // ---- 29. a caption over a photo that already has quantities ----
  // "quantity 1" and "no quantity at all" are different things. Reading
  // qty===1 as missing let a caption meant for the unpriced lines overwrite a
  // line the photo really did say "x1" about.
  console.log('\n[29] the caption fills only what the photo left blank');
  const ai29 = require('../src/core/ai');
  const PHOTO29 = '919000000929';
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'N' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 40, price: 210, mrp: 280, vendor: 'M' },
  ]);
  const realImage29 = ai29.parseOrderImage;
  // The photo: one line with a real quantity, one the reader could not place.
  ai29.parseOrderImage = async () => [
    { item: 'BP-1001', qty: 1, price: null },
    { item: 'OF-2002', qty: 1, price: null, qtyMissing: true },
  ];
  await customer.transport.injectIncoming({
    from: PHOTO29,
    chatId: 'sim-' + PHOTO29,
    chatName: '',
    isGroup: false,
    body: '10 pcs',
    hasMedia: true,
    mediaType: 'image',
    mediaMime: 'image/jpeg',
    mediaBase64: Buffer.from('not really a photo').toString('base64'),
  });
  const cart29 = orders.findDraft('sim-' + PHOTO29);
  const qty29 = (p) => ((cart29.lines.find((l) => (l.partNo || l.item) === p) || {}).qty);
  check('the line the photo priced keeps its own quantity', qty29('BP-1001') === 1);
  check('...and the caption fills the line that had none', qty29('OF-2002') === 10);
  ai29.parseOrderImage = realImage29;

  // The voice helper is staff. The console role list knew it; the bot did not,
  // so in a group their reply was read as a customer's.
  check('the voice helper counts as staff', customer.isStaff(config.voiceEscalationNumber) === true);
  check('...and an ordinary number still does not', customer.isStaff('919899555001') === false);


  // ---- 30. the commercial answer, and keeping it ----
  // Anik, 12 Sep: "Do not drop other information". `PUSH_ORDER/analyze` says
  // only whether an order can be punched; `PUSH_ORDER/commercial-analyze`
  // returns MRP, this customer's discount, tax, the net rate and the TAT -
  // and it was never called. Live for Kalra (account 265): 16510M65L10 ->
  // mrp 105, discount 12%, tax 18%, price 92.4.
  console.log('\n[30] stock AND what it costs, in one answer');
  const CA30 = '919000000930';
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 4, price: 450, mrp: 600, vendor: 'N' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 0, price: 210, mrp: 280, vendor: 'M' },
  ]);
  const priced30 = await availability.resolve(
    [
      { item: 'BP-1001', qty: 2 },
      { item: 'BP-1001', qty: 99 }, // the same part again, asked bigger
      { item: 'OF-2002', qty: 1 },  // known, no stock
      { item: 'ZZZZ9999', qty: 1 }, // not a part at all
    ],
    { found: true, buyerId: 265, branchId: 23, name: 'Mock Customer' },
  );
  const p30 = (i) => priced30[i];
  check('the rate for this customer comes back with the stock', p30(0).rate === 528 && p30(0).mrp === 600);
  check('...with the discount and the tax that made it', p30(0).discountPercent === 12 && p30(0).taxPercent === 18);
  check('...and how long it takes', p30(0).tatDays === 1);
  check('the same part asked twice gets its OWN answer', p30(0).available === 2 && p30(1).available === 4);
  check('...the bigger ask is marked short, not available', p30(1).portalStatus === 'Partially Available' && p30(1).shortfall === 95);
  check('a part with no stock still carries a rate', p30(2).source === 'unavailable' && p30(2).rate === 246.4);
  check('a part number that is not a part is still unidentified', p30(3).source === 'unidentified');
  check('our purchase cost never lands on a line', !Object.keys(p30(0)).some((k) => /base_?price|cost/i.test(k)));

  // The next question is answered from what we already have, with no new call.
  const rates30 = require('../src/core/rates');
  const realCA30 = portal.commercialAnalyze;
  let calls30 = 0;
  portal.commercialAnalyze = async (...a) => { calls30++; return realCA30.apply(portal, a); };
  const fromContext30 = await rates30.quote(['BP-1001'], { lines: priced30 }, (en) => en);
  check('a rate question is answered from the list already on screen', /MRP ₹600/.test(fromContext30) && /528/.test(fromContext30));
  check('...and the portal is not asked again for it', calls30 === 0);
  check('...GST is stated once, not twice', (fromContext30.match(/GST/g) || []).length === 1);
  const fromPortal30 = await rates30.quote(['OF-2002'], { ctx: { buyerId: 265, branchId: 23 } }, (en) => en);
  check('a part nobody has priced yet is fetched for that customer', /246.4/.test(fromPortal30) && calls30 === 1);
  portal.commercialAnalyze = realCA30;


  // ---- 31. is this a PART at all? ----
  // The same wrong answer kept coming back in different clothes: a question,
  // a car or a spaced label turned into a part number and went to the portal.
  // One rule now decides it (core/partish), and this is that rule.
  console.log('\n[31] a question is not a part, and neither is a car');
  const partish31 = require('../src/core/partish');
  const say31 = (s) => partish31.classify(s);

  // part numbers, in every shape a customer actually sends
  check('a bare part number is a number', say31('16510M65L10') === 'number');
  check('a spaced Maruti label is joined and read whole', partish31.partNumber('33400 M 68K31') === '33400M68K31');
  check('a hyphenated number is a number', say31('41341-M68P00') === 'number');
  check('"No" stuck to the front does not hide it', partish31.partNumber('2pise No81830m73rb3') === '81830m73rb3');
  check('a number inside a label line is found', partish31.partNumber('11610M55RA1 MOUNTING COMP ENG RH') === '11610M55RA1');

  // questions - the live failure: "GST kitna lagega" came back as 633100B210B0
  check('"GST kitna lagega" is a question', say31('GST kitna lagega') === 'question');
  check('"rate kya hai" is a question', say31('rate kya hai') === 'question');
  check('"kab aayega" is a question', say31('kab aayega') === 'question');
  check('"available hai kya" is a question', say31('available hai kya') === 'question');
  check('...and none of them carries a part number', !partish31.partNumber('GST kitna lagega') && !partish31.partNumber('kab aayega'));

  // cars - a year is not a quantity and a model is not a part
  check('"2025 Swift" is a vehicle', say31('2025 Swift') === 'vehicle');
  check('"Swift 2020" is a vehicle', say31('Swift 2020') === 'vehicle');
  check('"Creta 2019" is a vehicle', say31('Creta 2019') === 'vehicle');
  check('"i20 1.2" is a vehicle', say31('i20 1.2') === 'vehicle');
  check('"alto 800" is a vehicle', say31('alto 800') === 'vehicle');
  check('"wagonr vxi" is a vehicle', say31('wagonr vxi') === 'vehicle');
  check('...and a car never becomes a part number', !partish31.isPartNumber('2025 Swift') && !partish31.isPartNumber('alto 800'));

  // names still work - a component named with its car is a catalogue search
  check('"brake pad" is a name to search', say31('brake pad') === 'name');
  check('"clutch plate swift" is a name, not a car', say31('clutch plate swift') === 'name');
  check('a part number with a car beside it is still the number', partish31.partNumber('clutch plate swift 22400M83K02') === '22400M83K02');

  // and the doors that used to let these through
  check('availability agrees: a car is not a part number', availability.looksLikePartNumber('2025 Swift') === false);
  check('...nor is "wiper blade 18 inch"', availability.looksLikePartNumber('wiper blade 18 inch') === false);
  check('...and a question is never searched by name', availability.isNameQuery('GST kitna lagega') === false);
  const searched31 = await availability.byName('GST kitna lagega');
  check('...so the catalogue is not asked about it at all', searched31.total === 0 && searched31.top.length === 0);


  // ---- 32. whose sale is it? ----
  // Anik, 12 Sep: "jab sales order jo agent apne number se bhejega, toh usi
  // agent ke naam pe sale hogi na?" Every bot order carried only the bot's own
  // portal user, so all of them looked like one person's work. The portal has
  // `actor_user_id` for this, and it knows the mobile→user mapping itself.
  console.log('\n[32] the order carries the salesman who punched it');
  const ACTOR32 = '919217030418';
  portal._setMockUser(ACTOR32, { userId: 1208, username: 'amit_kumar', dealerId: null, dealerName: null });
  const who32 = await portal.userForMobile(ACTOR32);
  check('a mobile resolves to the portal user behind it', who32 && who32.userId === 1208 && who32.username === 'amit_kumar');
  check('a mobile nobody has mapped resolves to nothing', (await portal.userForMobile('919999000111')) === null);
  check('rubbish is never looked up', (await portal.userForMobile('12')) === null);

  const body32 = portal._confirmBody({
    id: 'ORD-TEST32',
    actorUserId: 1208,
    portalCustomer: { buyerId: 265, branchId: 23 },
    lines: [{ partNo: 'BP-1001', item: 'Brake Pad', qty: 2, source: 'portal', available: 2, vendors: [{ name: 'N', dealerId: 23, qty: 2 }] }],
  });
  check('the punch says who did it', body32.actor_user_id === 1208);
  check('...and still says who it is FOR', body32.selected_buyer_id === 265);
  check('...and marks itself as the bot, so portal-typed orders stay separate', body32.client_source === 'whatsapp-bot');

  const body32b = portal._confirmBody({
    id: 'ORD-TEST32B',
    portalCustomer: { buyerId: 265, branchId: 23 },
    lines: [{ partNo: 'BP-1001', item: 'Brake Pad', qty: 1, source: 'portal', available: 1, vendors: [{ name: 'N', dealerId: 23, qty: 1 }] }],
  });
  check('with no known user, no actor is invented', body32b.actor_user_id === undefined);


  // ---- 33. the 13 Sep conversation, as the founder typed it ----
  console.log('\n[33] a helper message is not an answer unless it is one');
  const esc33 = require('../src/core/escalation');
  const HELPER33 = config.escalationNumber;
  const VOICEHELPER33 = '919800000333';
  const hadVoice33 = config.voiceEscalationNumber;
  config.voiceEscalationNumber = VOICEHELPER33;
  const CUST33 = '919000000933';
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'N' }]);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST33, 'zzz sigma bracket - 2');
  const q33 = customer.transport.outbox.find((o) => o.to === HELPER33 && (o.text || '').includes('Question *#'));
  check('an unknown part opens a question for the helper', Boolean(q33) && esc33.hasPending());

  // The live leak: a sentence from the OTHER helper's number, no reply-to.
  customer.transport.outbox.length = 0;
  await dm(customer, VOICEHELPER33, 'Kalara mortor discount');
  check('a sentence from a helper it was NOT sent to never reaches the customer', !customer.transport.outbox.some((o) => o.to === CUST33 || o.to === 'sim-' + CUST33));
  // ...and not from the right helper either, without a swipe-reply
  customer.transport.outbox.length = 0;
  await dm(customer, HELPER33, 'ye wala party ka discount check karo');
  check('a bare sentence from the right helper is not relayed either', !customer.transport.outbox.some((o) => String(o.to).indexOf(CUST33) >= 0));
  check('...and the question is still open', esc33.hasPending());
  // a swipe-reply with words IS the answer
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: HELPER33, chatId: 'sim-' + HELPER33, isGroup: false, body: 'ye part discontinued hai', contextId: q33.id, mediaType: 'chat',
  });
  check('a swipe-reply in words is relayed to the customer', customer.transport.outbox.some((o) => String(o.to).indexOf(CUST33) >= 0 && /discontinued/.test(o.text || '')));
  config.voiceEscalationNumber = hadVoice33;

  console.log('\n[33b] a typo someone once corrected does not rewrite a right number');
  knowledge.learnAlias('26510m65l10', '16510M65L10', 'helper');
  check('the typo itself still finds the right part', knowledge.lookupAlias('26510m65l10') === '16510M65L10');
  check('the RIGHT number is not claimed by the typo', knowledge.lookupAlias('16510M65L10') === null);
  check('...nor a sentence carrying it', knowledge.lookupAlias('16510M65L10 analyze for kalra motors') === null);
  check('the typo is never offered to the parser as a known item', !availability.catalogNames().includes('26510m65l10'));
  check('names still match inside a longer sentence, on whole words', knowledge.lookupAlias('clutch set dzire petrol please') === '22400M74L00');

  console.log('\n[33c] "Mrp of this? And gst ?" is about the part just discussed');
  const partish33 = require('../src/core/partish');
  check('"and gst" is a question, not a part name', partish33.classify('and gst') === 'question');
  check('"give me pending" is a question', partish33.classify('give me pending') === 'question');

  console.log('\n[33d] a salesman asking about a named customer, in English');
  const sales33 = require('../src/core/salesOrder');
  const pa = (x) => sales33.parseAbout(x);
  check('"kalra motor give me pending" asks for Kalra\'s ledger', pa('kalra motor give me pending').customer === 'kalra motor' && pa('kalra motor give me pending').intent === 'ledger');
  check('"Kalara mortor discount" asks for a discount', pa('Kalara mortor discount').intent === 'discount' && pa('Kalara mortor discount').customer === 'Kalara mortor');
  const an33 = pa('16510M65L10   10 pcs kalara motors give me detailed analysis');
  check('a part, a quantity and a name make an analysis for that customer', an33.intent === 'analysis' && an33.part === '16510M65L10' && an33.qty === 10 && an33.customer === 'kalara motors');
  check('"16510M65L10 analyze for kalra motors" names the customer', pa('16510M65L10 analyze for kalra motors').customer === 'kalra motors');
  check('a plain part order from a salesman is not a question about anyone', pa('16510M65L10 5') === null);
  check('"swift ka rate" is a car, not a customer', pa('BP-1001 swift') === null);

  const SALES33 = '919000000334';
  config.salesTeamNumbers.push(SALES33);
  portal.setMockCustomers([
    { id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' },
    { id: 264, name: 'Kalra Car Decor', home_branch_dealer: 23, address: 'Kota, Rajasthan (IN)', group_name: '' },
  ]);
  sales33._resetDirectory();
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 70, mrp: 105, vendor: 'N' }]);
  customer.transport.outbox.length = 0;
  await dm(customer, SALES33, '16510M65L10 10 pcs kalra motors give me detailed analysis');
  const det33 = sent(customer);
  check('the analysis is for Kalra Motors, not the salesman', /Kalra Motors - 16510M65L10 x10/.test(det33));
  check('...with stock, MRP, the discount, the rate and GST', /Stock: 10 available/.test(det33) && /MRP ₹105/.test(det33) && /12% off/.test(det33) && /92\.4/.test(det33) && /18% GST/.test(det33));
  check('...and the total for the quantity asked', /Total ₹924/.test(det33));
  check('...and our purchase price is nowhere in it', !/\b70\b/.test(det33));
  customer.transport.outbox.length = 0;
  await dm(customer, SALES33, 'Mrp of this? And gst ?');
  const follow33 = sent(customer);
  check('the follow-up is priced for the same customer, named', /Kalra Motors:/.test(follow33) && /16510M65L10/.test(follow33) && /MRP ₹105/.test(follow33));
  check('...and nobody is asked for the rate of "and gst"', !/and gst/i.test(follow33));


  // ---- 34. nothing lost on the way in (Phase 0, 13 Sep) ----
  console.log('\n[34a] a message is recorded as seen only after it was handled');
  const seen34 = require('../src/core/seen');
  check('the first copy is ours to handle', seen34.begin('customer', 'wamid.P0-1') === true);
  check('a copy arriving WHILE it is handled is stopped', seen34.begin('customer', 'wamid.P0-1') === false);
  check('...and it is not yet on disk, so a restart now would not lose it', !store.load().seenMessages['customer:wamid.P0-1']);
  seen34.done('customer', 'wamid.P0-1');
  check('once handled it is on disk', Boolean(store.load().seenMessages['customer:wamid.P0-1']));
  check('...and a later copy is dropped', seen34.begin('customer', 'wamid.P0-1') === false);

  console.log('\n[34b] the relay lends messages until they are acknowledged');
  process.env.RELAY_LEASE_MS = '60';
  process.env.RELAY_SECRET = 'relay-test-secret';
  delete require.cache[require.resolve('../relay/server.js')];
  const relay34 = require('../relay/server.js');
  await new Promise((r) => relay34.server.listen(0, r));
  const base34 = 'http://127.0.0.1:' + relay34.server.address().port;
  const auth34 = { Authorization: 'Bearer relay-test-secret' };
  const post34 = (body) => fetch(base34 + '/webhook/wa', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const pull34 = async (lease) => (await fetch(base34 + '/pull' + (lease ? '?lease=1' : ''), { headers: auth34 })).json();
  await post34({ object: 'whatsapp_business_account', entry: [{ n: 1 }] });
  const first34 = await pull34(true);
  check('a leased pull hands the message over with an id and its raw bytes', first34.length === 1 && first34[0].id > 0 && typeof first34[0].raw === 'string');
  check('...and keeps it: a second pull straight away does not see it again', (await pull34(true)).length === 0);
  await new Promise((r) => setTimeout(r, 90));
  const again34 = await pull34(true);
  check('never acknowledged, it is offered again after the lease', again34.length === 1 && again34[0].id === first34[0].id);
  const ack34 = await (await fetch(base34 + '/ack', { method: 'POST', headers: { ...auth34, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [first34[0].id] }) })).json();
  await new Promise((r) => setTimeout(r, 90));
  check('acknowledged, it is gone for good', ack34.acked === 1 && (await pull34(true)).length === 0);
  await post34({ object: 'whatsapp_business_account', entry: [{ n: 2 }] });
  check('an old poller (no lease) still gets the old behaviour', (await pull34(false)).length === 1 && (await pull34(false)).length === 0);
  check('the wrong secret is refused', (await fetch(base34 + '/pull?lease=1', { headers: { Authorization: 'Bearer nope' } })).status === 403);
  await new Promise((r) => relay34.server.close(r));

  console.log('\n[34c] the bot checks the signature on the relay path too');
  const poller34 = require('../src/wa/relayPoller');
  const hadSecret34 = config.cloud.appSecret;
  const raw34 = '{"object":"whatsapp_business_account","entry":[]}';
  const sig34 = 'sha256=' + require('crypto').createHmac('sha256', 'app-secret-34').update(raw34).digest('hex');
  config.cloud.appSecret = '';
  check('with no secret set, nothing is rejected', poller34._verify({ raw: raw34, sig: 'sha256=forged' }) === true);
  config.cloud.appSecret = 'app-secret-34';
  check('a genuine event passes', poller34._verify({ raw: raw34, sig: sig34 }) === true);
  check('a forged one does not', poller34._verify({ raw: raw34.replace('entry', 'entri'), sig: sig34 }) === false);
  check('an old relay that sends no raw body cannot be checked, and says so', poller34._verify({ body: {}, sig: sig34 }) === null);
  config.cloud.appSecret = hadSecret34;

  console.log('\n[34d] an open helper question survives a restart');
  const esc34 = require('../src/core/escalation');
  const CUST34 = '919000000934';
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'N' }]);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST34, 'zzz rho bracket - 3');
  const q34 = customer.transport.outbox.find((o) => o.to === config.escalationNumber && (o.text || '').includes('Question *#'));
  const idMatch34 = q34 && /Question \*#(\d+)\*/.exec(q34.text);
  const qid34 = idMatch34 ? Number(idMatch34[1]) : 0;
  const snap34 = store.load().escalationsOpen && store.load().escalationsOpen[qid34];
  check('the question is written to disk with who it went to and the message id', Boolean(snap34) && snap34.sentTo === config.escalationNumber && snap34.wamid === q34.id);
  check('...and without the photo or the recording', snap34 && snap34.photo === undefined && snap34.audio === undefined);
  esc34._forgetInMemory();
  check('a restart forgets memory...', !esc34.hasPending());
  esc34._rehydrate({ customer });
  check('...and the question comes back from disk', esc34.hasPending());
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: config.escalationNumber, chatId: 'sim-' + config.escalationNumber, isGroup: false, body: 'BP-1001', contextId: q34.id, mediaType: 'chat',
  });
  check('the helper\'s swipe-reply after the restart still answers the customer', customer.transport.outbox.some((o) => String(o.to).indexOf(CUST34) >= 0));
  await dm(customer, '919000000935', 'zzz tau bracket - 1');
  const next34 = customer.transport.outbox.find((o) => o.to === config.escalationNumber && /Question \*#(\d+)\*/.test(o.text || '') && (o.text || '').indexOf('zzz tau bracket') >= 0);
  const nextId34 = next34 ? Number(/Question \*#(\d+)\*/.exec(next34.text)[1]) : 0;
  check('...and numbering carries on instead of starting again at #1', nextId34 > qid34);


  // ---- 35. a restart in the middle of a conversation loses nothing ----
  // Phase 1 (13 Sep): the per-chat memory that decides what "haan", "2" or
  // "iska rate" mean moved from in-process Maps onto core/chatState. Each check
  // writes something, simulates a restart (flush to disk, drop the in-memory
  // copy, read the file back), and reads it through the module itself.
  console.log('\n[35] a restart mid-conversation loses nothing');
  const chat35 = require('../src/core/chatState');
  const restart35 = () => {
    store._flushNow();
    store._reload();
  };
  const C35 = 'sim-919000000935';

  const focus35 = require('../src/core/focus');
  focus35.remember(C35, [{ item: 'oil filter', partNo: '16510M65L10' }]);
  const voice35 = require('../src/core/voiceOrder');
  voice35.remember(C35, [{ item: '16510M65L10', qty: 2 }], 'solah paanch sau das');
  const clarify35 = require('../src/core/clarify');
  clarify35.ask(C35, { base: 'brake pad', qty: 3 }, { text: 'Kaunsi gaadi?', facet: 'vehicle' });
  const sales35 = require('../src/core/salesOrder');
  chat35.slot('sales.session').set(C35, { stage: 'active', customer: { found: true, buyerId: 265, name: 'Kalra Motors' }, at: Date.now() });
  chat35.slot('sales.discussing').set(C35, { ctx: { found: true, buyerId: 265, name: 'Kalra Motors' }, at: Date.now() });
  chat35.slot('cancelAsk').set(C35, Date.now());

  restart35();

  check('what we were just discussing is still known', (focus35.names(C35) || []).includes('16510M65L10'));
  check('the voice note we read back is still waiting for its yes', Boolean(voice35.get(C35)) && voice35.get(C35).lines[0].qty === 2);
  check('"Kaunsi gaadi?" is still the open question', Boolean(clarify35.get(C35)) && clarify35.get(C35).base === 'brake pad');
  check('the customer a salesman picked is still picked', (sales35.activeCustomer(C35) || {}).name === 'Kalra Motors');
  check('...and the one he was asking about', (sales35.discussing(C35) || {}).name === 'Kalra Motors');
  check('"cancel the whole order?" is still asked', chat35.slot('cancelAsk').has(C35));

  // In-place changes are written too.
  clarify35.refine(C35, 'alto', { facet: 'vehicle' });
  restart35();
  check('an answer added to the open question survives', clarify35.get(C35).base === 'brake pad alto');

  // Ages still apply after a restart, exactly as before.
  chat35.slot('focus').set('sim-919000000936', { at: Date.now() - 31 * 60 * 1000, items: [{ item: 'x', partNo: 'OLD1234567' }] });
  restart35();
  check('a discussion older than its window is not brought back', focus35.names('sim-919000000936').length === 0);

  // Nothing that cannot be written can poison the file.
  const circular35 = { at: Date.now() };
  circular35.self = circular35;
  chat35.slot('test35').set('c', circular35);
  check('a value that is not plain data is kept in memory, not written', chat35.slot('test35').get('c') === circular35 && !store.load().chatState.test35.c);
  chat35.slot('test35').set('ok', { at: Date.now(), v: 1 });
  restart35();
  check('...and everything else still saves', store.load().chatState.test35.ok.v === 1);

  // The janitor retires chats that never came back.
  chat35.slot('test35b').set('gone', { at: Date.now() - 25 * 60 * 60 * 1000 });
  chat35.slot('test35b').set('kept', { at: Date.now() });
  restart35();
  const janitor35 = require('../src/core/chatState').slot('test35b');
  check('a chat untouched for over a day is dropped', !janitor35.has('gone') && janitor35.has('kept'));

  console.log('\n[36] the shadow model watches, and never answers anyone');
  const shadow36 = require('../src/pipeline/shadow');
  const understand36 = require('../src/pipeline/understand');
  const conv36 = require('../src/core/conversation');
  const ai36 = require('../src/core/ai');
  const sharedWas36 = config.sharedDir;
  config.sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoflow-shadow-'));
  const rows36 = () => {
    try {
      return fs.readFileSync(shadow36._file(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) {
      return [];
    }
  };
  const C36 = 'sim-919899555036';
  const m36 = { id: 'wamid.s36', from: '919899555001', chatId: C36, isGroup: false, body: '16510M65L10 pakka?' };

  check('off unless AI_SHADOW is set: the handler just runs', (await shadow36.around(null, m36, async () => 'plain')) === 'plain' && rows36().length === 0);

  config.ai.shadow = true;
  let seen36 = '';
  understand36._setModel(async (system, user) => {
    seen36 = user;
    return { intent: 'confirm', lines: [{ item: '16510M65L10', qty: 2 }, { item: '99999M99X99', qty: 1 }], confidence: 0.9 };
  });
  require('../src/core/chatState').slot('askQty.pending').set(C36, { items: [{ item: 'oil filter', partNo: '16510M65L10' }], at: Date.now() });
  conv36.record(C36, 'us', 'Kitne chahiye 16510M65L10?');
  const got36 = await shadow36.around(null, m36, async () => {
    await ai36.parseCustomerMessage(m36.body, []);
    conv36.record(C36, 'us', 'Haan, stock hai.');
    return true;
  });
  await shadow36._flush();
  const row36 = rows36().pop() || {};
  check('the handler result comes back untouched', got36 === true);
  check('one line per message in shadow.jsonl', rows36().length === 1);
  check('what the gates decided is logged', (row36.gate || {}).intents.length === 1);
  check('...and what they actually said', (row36.gate.replies || []).includes('Haan, stock hai.'));
  check('the model sees the open question and the chat', seen36.includes('we asked how many of: 16510M65L10') && seen36.includes('Kitne chahiye'));
  check('a question is never a confirm, whatever the model says', row36.model.intent === 'chat' && row36.model.guards.some((g) => /question/.test(g)));
  check('a part number the model made up is dropped', !row36.model.lines.some((l) => l.item === '99999M99X99') && row36.model.lines.some((l) => l.item === '16510M65L10'));

  understand36._setModel(async () => {
    throw new Error('model down');
  });
  const down36 = await shadow36.around(null, { ...m36, id: 'wamid.s36b', body: 'brake pad 2' }, async () => 'still answered');
  await shadow36._flush();
  check('a failed model call changes nothing for the customer', down36 === 'still answered' && /model down/.test(rows36().pop().model.error));

  let threw36 = null;
  try {
    await shadow36.around(null, { ...m36, id: 'wamid.s36c' }, async () => {
      throw new Error('handler broke');
    });
  } catch (e) {
    threw36 = e;
  }
  await shadow36._flush();
  check('a handler error still reaches the caller as it did', threw36 && threw36.message === 'handler broke');

  const before36 = rows36().length;
  // A group the bot did not create: never its conversation, whatever the DM setting.
  await shadow36.around(null, { ...m36, id: 'wamid.s36d', from: '919812340000', chatId: '120363000000000036@g.us', isGroup: true }, async () => false);
  await shadow36._flush();
  check('a chat the bot does not listen to is not sent to the model', rows36().length === before36);

  config.ai.shadow = false;
  understand36._setModel(null);
  require('../src/core/chatState').slot('askQty.pending').delete(C36);
  try {
    fs.rmSync(config.sharedDir, { recursive: true, force: true });
  } catch {}
  config.sharedDir = sharedWas36;

  // 13 Sep, live, 919310664076. The shadow model understood all three; the
  // bot got one wrong and went silent on two. These replay what the live
  // model did, with the model stubbed.
  console.log('\n[37] "16510m65l10 -5", "5 p", "Kya hua" - understood in the bot itself');
  const ai37 = require('../src/core/ai');
  const chatState37 = require('../src/core/chatState');
  const conv37 = require('../src/core/conversation');
  const C37 = 'sim-' + CUST;
  const P37 = '22400M74L00';
  // Earlier sections replace the mock catalogue; put the parts these use back.
  portal.setMockStock([
    { part_no: '22400M74L00', name: 'Clutch Plate Swift', quantity: 12, price: 1850, mrp: 2400, vendor: 'Northend' },
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
  ]);
  const reset37 = () => {
    for (const o of store.orders()) if (o.chatId === C37 && o.status === 'draft') o.status = 'cancelled';
    for (const s of ['askQty.pending', 'askQty.recent', 'clarify.pending', 'clarify.lastAsked', 'focus', 'voiceOrder', 'cancelAsk', 'sales.session', 'sales.discussing']) {
      chatState37.slot(s).delete(C37);
    }
    const st37 = store.load();
    if (st37.soReview) delete st37.soReview[C37];
    conv37.clear(C37);
    store.save();
    customer.transport.outbox.length = 0;
  };
  const qtyOf37 = (partNo, chatId = C37) => {
    const d = orders.findDraft(chatId);
    const l = d && d.lines.find((x) => String(x.partNo || x.item).toUpperCase() === partNo);
    return l ? l.qty : 0;
  };
  const discuss37 = (items, chatId = C37) => chatState37.slot('focus').set(chatId, { at: Date.now(), items });

  // The live model, as it behaved: every call goes through ai._claude.
  const keyWas37 = config.ai.apiKey;
  config.ai.apiKey = 'test-key';
  const live37 = { parse: null, chat: null, understand: null };
  ai37._setClaude(async (system, user) => {
    if (/^You parse WhatsApp messages/.test(system)) return live37.parse ? live37.parse(user) : { intent: 'other' };
    if (/^You answer WhatsApp messages for CARTRENDS/.test(system)) return live37.chat ? live37.chat(user) : { action: 'silent' };
    if (/^You are the counter person/.test(system)) return live37.understand ? live37.understand(user) : { intent: 'chat' };
    return {};
  });

  // 1. A part number and its quantity, whatever the model thinks.
  live37.parse = () => ({ intent: 'inquiry', items: ['22400m74l00 -5'] });
  for (const msg of ['22400m74l00 -5', '22400M74L00 - 5', '22400M74L00 x5', '22400m74l00 -5pcs']) {
    reset37();
    await dm(customer, CUST, msg);
    check(`"${msg}" puts ${P37} x5 in the order`, qtyOf37(P37) === 5);
    check(`...and does not ask for a quantity it was given ("${msg}")`, !/quantity ke saath|kitni quantity|how many/i.test(sent(customer)));
  }
  reset37();
  await dm(customer, CUST, '43430-0K021');
  check('a hyphenated part number on its own is not read as a quantity', !orders.findDraft(C37) || !orders.findDraft(C37).lines.some((l) => l.qty === 21 || l.qty === 1021));

  // 2. "5 p" after we answered about one part.
  reset37();
  live37.parse = () => ({ intent: 'inquiry', items: [P37] });
  await dm(customer, CUST, P37 + ' stock hai');
  check('the stock answer leaves the part in focus', (chatState37.slot('focus').get(C37) || { items: [] }).items.some((i) => i.partNo === P37));
  customer.transport.outbox.length = 0;
  live37.parse = () => ({ intent: 'other' });
  await dm(customer, CUST, '5 p');
  check('"5 p" orders 5 of the part just discussed', qtyOf37(P37) === 5);
  check('...and the customer hears about it', customer.transport.outbox.length > 0 && new RegExp(P37.slice(0, 5) + '|Clutch', 'i').test(sent(customer)));

  // Two parts in the discussion: never guess.
  reset37();
  discuss37([{ item: P37, partNo: P37 }, { item: 'BP-1001', partNo: 'BP-1001' }]);
  await dm(customer, CUST, '5 p');
  check('two parts discussed: "5 p" orders nothing', !orders.findDraft(C37));
  check('...and asks which one, naming both', new RegExp(P37).test(lastOut(customer)) && /BP-1001/.test(lastOut(customer)));

  // A name, not a part number: never guess either.
  reset37();
  discuss37([{ item: 'brake pad', partNo: 'brake pad' }]);
  await dm(customer, CUST, '5 p');
  check('only a name discussed: "5 p" orders nothing', !orders.findDraft(C37));
  check('...and asks for the part number', /part number/i.test(lastOut(customer)));

  // 3. "Kya hua" - never silence, never a made-up order.
  live37.chat = () => ({ action: 'reply', text: 'Order note ho gaya sir, quantity 5. Rate aur billing ke liye team call karegi.' });
  reset37();
  discuss37([{ item: P37, partNo: P37 }]);
  await dm(customer, CUST, 'Kya hua');
  check('"Kya hua" gets an answer', customer.transport.outbox.length === 1);
  check('...that does not claim an order exists', !/note ho gaya|order (ho|ban) gaya|placed|confirmed/i.test(lastOut(customer)) && !orders.findDraft(C37));
  check('...and moves it on: how many of the part we discussed', new RegExp(P37).test(lastOut(customer)) && /kitne|kitni|how many/i.test(lastOut(customer)));
  await dm(customer, CUST, '4');
  check('...and the next "4" is that quantity', qtyOf37(P37) === 4);

  reset37();
  await dm(customer, CUST, P37 + ' 2');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'kya hua');
  check('"kya hua" with an open order shows it and asks to confirm', /22400M74L00|clutch/i.test(lastOut(customer)) && /confirm/i.test(lastOut(customer)));

  reset37();
  await dm(customer, CUST, 'kya hua');
  check('"kya hua" with nothing going on still gets a useful line', customer.transport.outbox.length === 1 && /part number/i.test(lastOut(customer)));

  // A chat reply the fences refuse is replaced, not dropped.
  reset37();
  live37.chat = () => ({ action: 'reply', text: 'Rate 450 hai sir' });
  await dm(customer, CUST, 'acha bhai sunno');
  check('a refused chat reply still leaves the customer with an answer', customer.transport.outbox.length === 1 && !/450/.test(lastOut(customer)));
  live37.chat = () => ({ action: 'silent' });

  // The model's understanding, used - behind a read-back.
  reset37();
  discuss37([{ item: P37, partNo: P37 }]);
  live37.understand = () => ({ intent: 'order', lines: [{ item: P37, qty: 3 }], confidence: 0.8 });
  await dm(customer, CUST, 'same wala 3 aur bhej do');
  check('an order only the model understood is read back first', !orders.findDraft(C37) && new RegExp(P37 + ' x3').test(lastOut(customer)));
  await dm(customer, CUST, 'haan');
  check('...and placed after the yes', qtyOf37(P37) === 3);

  reset37();
  discuss37([{ item: P37, partNo: P37 }]);
  live37.understand = () => ({ intent: 'order', lines: [{ item: '99999M99X99', qty: 3 }], confidence: 0.9 });
  await dm(customer, CUST, 'wo dusra wala 3 bhej do');
  check('a part number the model made up is never read back or ordered', !orders.findDraft(C37) && !/99999M99X99/.test(sent(customer)));
  check('...and the customer still gets an answer', customer.transport.outbox.length >= 1);

  reset37();
  discuss37([{ item: P37, partNo: P37 }]);
  live37.understand = () => ({ intent: 'order', lines: [{ item: P37, qty: 3 }] });
  await dm(customer, CUST, 'same wala 3 aur bhej do');
  await dm(customer, CUST, 'nahi');
  check('a "nahi" to a typed read-back adds nothing and says so', !orders.findDraft(C37) && /nahi joda|not added/i.test(lastOut(customer)));
  live37.understand = null;

  // Groups are left exactly as they were.
  const G37 = 'simgroup-delhi dealers';
  const groupQtyBefore37 = qtyOf37(P37, G37);
  discuss37([{ item: P37, partNo: P37 }], G37);
  await group(customer, '919899000888', '5 p');
  check('in a group "5 p" orders the part just discussed too', qtyOf37(P37, G37) === groupQtyBefore37 + 5);
  chatState37.slot('focus').delete(G37);

  ai37._setClaude(null);
  config.ai.apiKey = keyWas37;
  reset37();

  // 13 Sep, live, after the fix: "Thik hai.. mt kro" was taken as a yes, "Ok
  // order bna do" was answered in English, and the same not-registered
  // paragraph went out three times. And the founder: every change for
  // everyone - team, admin, new numbers, groups.
  console.log('\n[38] a yes that says no, the language, no repeats, and groups get the same bot');
  const C38 = 'sim-' + CUST;

  const INTENTS38 = [
    ['Thik hai.. mt kro', 'maybe_cancel'],
    ['ok rehne do', 'maybe_cancel'],
    ['haan mat karo', 'maybe_cancel'],
    ['nahi rehne do', 'maybe_cancel'],
    ['mt kro', 'maybe_cancel'],
    ['ok wait', 'other'],
    ['thik hai ruko', 'other'],
    ['Ok order bna do', 'confirm'],
    ['haan', 'confirm'],
    ['Hn', 'confirm'],
    ['ok nahi chahiye', 'maybe_cancel'],
    ['nahi chahiye', 'maybe_cancel'],
  ];
  // Real messages carrying "nahi" that are about stock, never a no to an order.
  for (const msg of ['Ye vala hai ki  nhi', 'Avl nhi hai sir', 'dono available nahi hai.', 'Available hai ki nhi ye batao', 'koi baat nahi']) {
    const r = await ai37.parseCustomerMessage(msg, []);
    check(`"${msg}" is not read as a no to the order`, r.intent !== 'maybe_cancel' && r.intent !== 'cancel');
  }
  for (const [msg, want] of INTENTS38) {
    const r = await ai37.parseCustomerMessage(msg, []);
    check(`"${msg}" reads as ${want}`, r.intent === want);
  }
  // ...and the model cannot turn them back into a yes.
  config.ai.apiKey = 'test-key';
  ai37._setClaude(async () => ({ intent: 'confirm' }));
  for (const [msg, want] of INTENTS38.filter(([, w]) => w !== 'confirm')) {
    const r = await ai37.parseCustomerMessage(msg, []);
    check(`with the model saying yes, "${msg}" still reads as ${want}`, r.intent === want);
  }
  ai37._setClaude(null);
  config.ai.apiKey = keyWas37;

  reset37();
  await dm(customer, CUST, P37 + ' 2');
  markAsked(C38);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Thik hai.. mt kro');
  check('"Thik hai.. mt kro" on an open order asks, and punches nothing', /cancel/i.test(lastOut(customer)) && !/draft so|sales order/i.test(sent(customer)) && Boolean(orders.findDraft(C38)));

  reset37();
  require('../src/core/lang').set(C38, 'en');
  await dm(customer, CUST, 'Ok order bna do');
  check('"Ok order bna do" is Hinglish', require('../src/core/lang').of(C38) === 'hi');

  reset37();
  const cust38 = require('../src/core/customers');
  const resolveWas38 = cust38.resolve;
  cust38.resolve = async () => ({ found: false });
  try {
    await dm(customer, CUST, P37 + ' 2');
    markAsked(C38);
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'haan');
    const first38 = lastOut(customer);
    // Waiting for a call-back is how an order dies, so the account is opened
    // here instead: the paper form, asked one question at a time.
    check('a number not on the portal is told why the order cannot go', /regist/i.test(first38));
    // The form now opens on the GSTIN, which answers five of its own questions.
    check('...and the form starts there and then', /GST/i.test(first38));
    check('...with a form actually open for that chat', Boolean(require('../src/core/customerCreate').pending(C38)));

    // Every message now belongs to the form, so there has to be a way out.
    await dm(customer, CUST, 'rehne do');
    check('...that the customer can back out of', require('../src/core/customerCreate').pending(C38) === null);
    check('...and backing out does not touch their list', (orders.findDraft(C38) || { lines: [] }).lines.length > 0);

    // 22 Sep, live: the portal answered HTTP 500 (its connection pool was
    // exhausted) and EVERY number looked unregistered. Asking a customer who
    // already has an account for twelve answers - and then failing to create
    // it, because the same portal is down - is the worst of both.
    cust38.resolve = async () => ({ found: null });
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'create customer');
    check('the portal being down is not treated as "no account"', /respond nahi kar raha|isn.t responding/i.test(lastOut(customer)));
    check('...so no form is opened we could not finish', require('../src/core/customerCreate').pending(C38) === null);
  } finally {
    cust38.resolve = resolveWas38;
    require('../src/core/customerCreate').cancel(C38);
  }

  // A customer in a group: the same bot as in a DM.
  const G38 = 'simgroup-delhi dealers';
  const GC38 = '919899000888';
  const resetG38 = () => {
    for (const o of store.orders()) if (o.chatId === G38 && o.status === 'draft') o.status = 'cancelled';
    for (const s of ['askQty.pending', 'askQty.recent', 'focus', 'voiceOrder', 'clarify.pending', 'cancelAsk']) chatState37.slot(s).delete(G38);
    conv37.clear(G38);
    store.save();
    customer.transport.outbox.length = 0;
  };
  resetG38();
  discuss37([{ item: P37, partNo: P37 }], G38);
  await group(customer, GC38, '5 p');
  check('group customer: "5 p" orders the part just discussed', qtyOf37(P37, G38) === 5);

  resetG38();
  discuss37([{ item: P37, partNo: P37 }], G38);
  await group(customer, GC38, 'kya hua');
  check('group customer: "kya hua" is answered', customer.transport.outbox.length === 1 && /kitne|how many/i.test(lastOut(customer)));

  resetG38();
  await group(customer, GC38, P37);
  check('group customer: a part number with no quantity gets an answer that asks for one', customer.transport.outbox.length === 1 && /quantit|kitni|how many/i.test(lastOut(customer)));

  resetG38();
  config.ai.apiKey = 'test-key';
  ai37._setClaude(async (system) => (/^You answer WhatsApp messages for CARTRENDS/.test(system) ? { action: 'reply', text: 'Rate 450 hai sir' } : { intent: 'other' }));
  await group(customer, GC38, 'acha bhai sunno');
  check('group customer: a refused chat reply is not silence', customer.transport.outbox.length === 1 && !/450/.test(lastOut(customer)));
  ai37._setClaude(null);
  config.ai.apiKey = keyWas37;

  // Unchanged until the founder decides: a Cartrends person in a group is a
  // person talking to the customer, not the customer.
  resetG38();
  discuss37([{ item: P37, partNo: P37 }], G38);
  await group(customer, '919800000777', '5 p');
  check('a Cartrends staff "5 p" in a group is still not an order', customer.transport.outbox.length === 0 && qtyOf37(P37, G38) === 0);
  resetG38();

  // 13 Sep, founder, with screenshots of a chat on top of the portal API:
  // "kalra motor give me pending" -> "16510M65L10 analyze for kalra motors" ->
  // "give me discount as well for this part. all details." -> "16510M65L10 10
  // pcs kalara motors give me detailed analysis" -> "punch this order for kalra
  // motors and give me order id". "commands exact same nhi but output aisa aana
  // chahiye ... admin, salesman koi bhi pooche to milna chahiye". A sandbox run
  // on the live portal answered the first, second and fourth, lost the
  // customer on the third, and went silent on the fifth.
  console.log('\n[39] what the desk asks about a customer, answered in full');
  const S39 = '919000000339';
  config.salesTeamNumbers.push(S39);
  const C39 = 'sim-' + S39;
  portal.setMockCustomers([
    { id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' },
    { id: 264, name: 'Kalra Car Decor', home_branch_dealer: 23, address: 'Kota, Rajasthan (IN)', group_name: '' },
  ]);
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter - Maruti Suzuki Alto', quantity: 50, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' }]);
  sales33._resetDirectory();
  for (const o of store.orders()) if (o.chatId === C39 && o.status === 'draft') o.status = 'cancelled';
  store.save();

  customer.transport.outbox.length = 0;
  await dm(customer, S39, '16510m65l10 10 pcs kalara motors give me detailed analysis');
  const det39 = sent(customer);
  check('a lowercase part number and a misspelt name are analysed for Kalra', /Kalra Motors - 16510M65L10 x10/.test(det39));
  check('...naming the part', /Oil Filter - Maruti Suzuki Alto/.test(det39));
  check('...the warehouse it comes from', /BIJWASAN WAREHOUSE/.test(det39));
  check('...how many were allocated and how many are short', /allocated 10/i.test(det39) && /short(fall)? 0/i.test(det39));
  // The rate ALREADY includes GST: Odoo bill CT-DL-26-27/3227 for this very
  // line is 10 x 105 at 12% = ₹924 total (untaxed 783.05, tax 140.95, tax
  // "price_include"). Until 13 Sep the bot said "₹924 + GST ₹166.32 =
  // ₹1,090.32" - 18% more than the bill.
  check('...the total is the bill total, GST included, with the taxable value and the GST inside it', /Total ₹924\b/.test(det39) && /taxable ₹783\.05/i.test(det39) && /GST ₹140\.95/.test(det39));
  check('...and GST is never added on top', !/1,090/.test(det39) && !/\+ 18% GST/.test(det39) && !/\+ GST/.test(det39));
  check('...and still never our purchase price', !/\b70\b/.test(det39));

  customer.transport.outbox.length = 0;
  await dm(customer, S39, 'give me discount as well for this part. all details.');
  const fol39 = sent(customer);
  check('"give me discount as well for this part" needs no customer name again', /Kalra Motors/.test(fol39) && !/No customer called/i.test(fol39));
  check('...and gives the discount with every other detail, for the same quantity', /12% off/.test(fol39) && /16510M65L10 x10/.test(fol39) && /Total ₹924\b/.test(fol39) && !/1,090|\+ 18% GST/.test(fol39));
  // Live 13 Sep: the reply was the analysis again, word for word. The thing
  // asked for comes first.
  check('...and the discount is the first thing said', /^(Discount 12%|Kalra Motors ka discount 12%)/.test(lastOut(customer)));

  customer.transport.outbox.length = 0;
  await dm(customer, S39, 'punch this order for kalra motors and give me order id');
  const pun39 = sent(customer);
  check('"punch this order for kalra motors" is an order for Kalra', /Kalra Motors/.test(pun39));
  check('...made of the part and quantity just analysed', qtyOf37('16510M65L10', C39) === 10);
  check('...with one check before punching: warehouse, rate, total with GST, and the question', /BIJWASAN WAREHOUSE/.test(pun39) && /₹92\.4\/pc incl\. 18% GST/.test(pun39) && /Total ₹924\b/.test(pun39) && !/1,090|\+ 18% GST/.test(pun39) && /(punch kar dun|shall i punch it)\?/i.test(pun39));
  check('...and nothing is punched before the yes', !/SO-\d+|draft so/i.test(pun39));
  // Live 13 Sep it came as two messages, the first ("16510M65L10 x10 -
  // available") saying half of the second.
  check('...in one message', customer.transport.outbox.length === 1);
  customer.transport.outbox.length = 0;
  await dm(customer, S39, 'haan');
  check('the yes punches it and gives the SO number back', /SO-\d+/.test(sent(customer)));

  // 13 Sep, live, Lagan Motors: "punch this order" with no name went to the
  // chat model, which made up "We're still testing, so I haven't punched
  // Lagan Motors's SO"; "Send draft so" got another made-up line.
  sales33._resetDirectory();
  for (const o of store.orders()) if (o.chatId === C39 && o.status === 'draft') o.status = 'cancelled';
  require('../src/core/soReview').clear(C39);
  store.save();
  await dm(customer, S39, '16510M65L10 analyze for kalra motors');
  customer.transport.outbox.length = 0;
  await dm(customer, S39, 'punch this order');
  const noName39 = sent(customer);
  check('"punch this order" with no name is for the customer just analysed', /Kalra Motors/.test(noName39) && qtyOf37('16510M65L10', C39) === 1);
  check('...with the same one-message check before punching', customer.transport.outbox.length === 1 && /(shall i punch it|punch kar dun)\?/i.test(noName39));
  customer.transport.outbox.length = 0;
  await dm(customer, S39, 'Send draft so');
  check('"Send draft so" before a punch shows that same check - not a guess', customer.transport.outbox.length === 1 && /16510M65L10 x1/.test(lastOut(customer)) && /(shall i punch it|punch kar dun)\?/i.test(lastOut(customer)));

  const EMPTY39 = '919000000399';
  config.salesTeamNumbers.push(EMPTY39);
  customer.transport.outbox.length = 0;
  await dm(customer, EMPTY39, 'Send draft so');
  check('"Send draft so" with nothing going on says there is no draft yet', customer.transport.outbox.length === 1 && /no draft|koi draft nahi/i.test(lastOut(customer)));
  customer.transport.outbox.length = 0;
  await dm(customer, EMPTY39, 'punch this order');
  check('"punch this order" with nothing analysed asks which customer, and is not silent', customer.transport.outbox.length === 1 && /customer/i.test(lastOut(customer)));

  // The punching-off line reads like a person wrote it.
  const blocked39 = sales33.whenBlocked(C39, orders.findDraft(C39), (en) => en) || '';
  check('the punching-off line names the customer without "Motors\'s"', /Kalra Motors/.test(blocked39) && !/Motors's/.test(blocked39) && /haven.t punched/i.test(blocked39));

  // The live portal's own name for the part, as it came back on 13 Sep.
  check('the portal\'s "OIL FILTER | MARUTI SUZUKI ALTO | #16510M65L10" reads as "Oil Filter - Maruti Suzuki Alto"', sales33.prettyPartName('OIL FILTER | MARUTI SUZUKI ALTO | #16510M65L10') === 'Oil Filter - Maruti Suzuki Alto');

  // 13 Sep, live: "Give me pending of anuj" -> a list of five -> "1." answered
  // for Anuj; then "2", a swiped "3." and "4." became 16510M65L10 x2/x3/x4 in
  // an open cart (the list was forgotten after the first pick, and a bare
  // number on the part last discussed is a quantity). "Pending for anuj
  // (Haryana)" and "Pending of Anuj Kumar Ph-3 (HARYANA, Haryana)" - the
  // bot's own labels typed back - found nobody.
  console.log('\n[40] picking from a customer list, more than once');
  const S40 = '919000000340';
  config.salesTeamNumbers.push(S40);
  const C40 = 'sim-' + S40;
  portal.setMockCustomers([
    { id: 501, name: 'Anuj', address: 'Cartrends', group_name: '' },
    { id: 502, name: 'anuj', address: 'Haryana (IN)', group_name: '' },
    { id: 503, name: 'ANUJ GOSAIN', address: 'HOUSE NO - 311, SECTOR - 15 VASUNDHRA, Uttar Pradesh (IN)', group_name: '' },
    { id: 504, name: 'Anuj Kumar Ph-3', address: 'HARYANA, Haryana (IN)', group_name: '' },
  ]);
  sales33._resetDirectory();
  discuss37([{ item: '16510M65L10', partNo: '16510M65L10' }], C40);
  const said40 = async (body, extra = {}) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ from: S40, chatId: C40, chatName: '', isGroup: false, body, hasMedia: false, mediaType: 'chat', ...extra });
    return sent(customer);
  };
  const list40 = await said40('Give me pending of anuj');
  check('"pending of anuj" lists the four', /Which one\?|Kaunsa wala\?/.test(list40) && /Anuj Kumar Ph-3/.test(list40));
  check('"1." answers for the first', /^Anuj - /m.test(await said40('1.')));
  const two40 = await said40('2');
  check('"2" right after is the second customer on the same list', /^anuj - /m.test(two40));
  check('...and never a quantity of the part discussed earlier', qtyOf37('16510M65L10', C40) === 0 && !/16510M65L10 x2/.test(two40));
  check('a swiped "3." is the third', /^ANUJ GOSAIN - /m.test(await said40('3.', { contextId: 'wamid.list40' })));
  check('"Pending for anuj (Haryana)" - the list\'s own label - is that customer', /^anuj - /m.test(await said40('Pending for anuj (Haryana)')));
  check('"Pending of Anuj Kumar Ph-3 (HARYANA, Haryana)" is that customer', /^Anuj Kumar Ph-3 - /m.test(await said40('Pending of Anuj Kumar Ph-3 (HARYANA, Haryana)')));
  check('...and nothing went into a cart along the way', qtyOf37('16510M65L10', C40) === 0);
  sales33._resetDirectory();
  const fresh40 = await said40('Pending of Anuj Kumar Ph-3 (HARYANA, Haryana)');
  check('with no list open, a name with a number and a place in brackets is still found', /^Anuj Kumar Ph-3 - /m.test(fresh40) && !/No customer called/.test(fresh40));

  // 13 Sep, live, admin chat 10:40-10:47 UTC (chats.jsonl):
  //   "26300-02752 40 pcs" -> "checking" and later "exact part number bhejiye";
  //     the portal has it as 2630002752 (checked read-only), and the repair
  //     only ever tried hyphen->M, and only for tokens with a letter in them.
  //   "Nhi" -> "Poora order cancel kar dun?" -> "Poora" showed the cart,
  //     "Poora kr do cancel" got "Thoda aur detail bata dijiye?".
  //   A swiped "3." on an old list became 16510M65L10 x3.
  //   "Hai kya?" swiped on their own list of parts -> "Samajh nahi paya".
  console.log('\n[41] a hyphen the portal does not print, cancelling, old swipes, quoted lists');

  // Hyphen: the live portal is strict, the mock is not - so the portal calls
  // are stubbed to behave like the live one did.
  const avail41 = require('../src/core/availability');
  const was41 = { analyze: portal.analyze, commercialAnalyze: portal.commercialAnalyze, searchByName: portal.searchByName };
  const strict41 = (lines, withRate) =>
    lines.map((l) => {
      const p = String(l.partNo || l.item).toUpperCase();
      return p === '2630002752'
        ? { item: p, partNo: p, qty: l.qty, source: 'unavailable', available: 0, vendors: [], ...(withRate ? { rate: 103.04, mrp: 112, taxPercent: 18 } : {}) }
        : { item: l.item, partNo: l.partNo || l.item, qty: l.qty, source: 'unidentified', available: 0, vendors: [] };
    });
  portal.analyze = async (lines) => strict41(lines, false);
  portal.commercialAnalyze = async (lines) => strict41(lines, true);
  portal.searchByName = async (q) => (String(q).toUpperCase() === '2630002752' ? { total: 1, top: [{ partNo: '2630002752', name: 'FILTER ASSY-ENGINE OIL | HYUNDAI' }] } : { total: 0, top: [] });
  try {
    const h41 = (await avail41.resolve([{ item: '26300-02752', qty: 40 }], null))[0] || {};
    check('"26300-02752" is found as the portal\'s 2630002752', String(h41.partNo).toUpperCase() === '2630002752' && h41.source !== 'unidentified');
    const hc41 = (await avail41.resolve([{ item: '26300-02752', qty: 40 }], { found: true, accountId: 265, branchId: 23, name: 'Kalra Motors' }))[0] || {};
    check('...and for a known customer the retry still brings their rate', hc41.rate === 103.04);
    const still41 = (await avail41.resolve([{ item: '99999-99999', qty: 1 }], null))[0] || {};
    check('a hyphenated number the catalogue does not have stays unknown', still41.source === 'unidentified');
  } finally {
    Object.assign(portal, was41);
  }

  // Cancelling the whole order after "Poora order cancel kar dun?".
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' }]);
  for (const [answer, whole] of [['Poora', true], ['Poora kr do cancel', true], ['haan', true], ['sab cancel', true], ['nahi', false], ['bas ek part hatana hai', false]]) {
    reset37();
    await dm(customer, CUST, '16510M65L10 5');
    await dm(customer, CUST, 'nahi chahiye');
    const asked41 = /Poora order cancel|Cancel the whole order/i.test(lastOut(customer));
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, answer);
    const open41 = orders.findDraft(C37);
    if (whole) {
      check(`"${answer}" to "cancel the whole order?" cancels it`, asked41 && !open41 && /cancel/i.test(lastOut(customer)));
    } else {
      check(`"${answer}" to "cancel the whole order?" keeps the order and says so`, asked41 && Boolean(open41) && customer.transport.outbox.length === 1 && !/Order ORD-\d+:/.test(lastOut(customer)));
    }
  }
  reset37();
  await dm(customer, CUST, '16510M65L10 5');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'poora order cancel kar do');
  check('"poora order cancel kar do" cancels without being asked first', !orders.findDraft(C37) && /cancel/i.test(lastOut(customer)));

  // A number swiped onto an OLD message is not a quantity for today's part.
  reset37();
  discuss37([{ item: '16510M65L10', partNo: '16510M65L10' }]);
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({ from: CUST, chatId: C37, chatName: '', isGroup: false, body: '3.', hasMedia: false, mediaType: 'chat', contextId: 'wamid.an-old-customer-list' });
  check('a "3." swiped onto an old message is not ordered as a quantity', qtyOf37('16510M65L10') === 0);
  check('...and it is still answered', customer.transport.outbox.length >= 1);

  // "Hai kya?" swiped onto the customer's own list of parts.
  reset37();
  // With a hyphenated number in it: live, the answer named the other parts and
  // left 26300-02752 out, because the quoted text was read for letter+digit
  // tokens only.
  await customer.transport.injectIncoming({ id: 'wamid.own-list-41', from: CUST, chatId: C37, chatName: '', isGroup: false, body: '26300-02752 40 pcs\n16510M65L10 100 pcs', hasMedia: false, mediaType: 'chat' });
  // The cart and the conversation go; only the quoted message is left to
  // say which parts "Hai kya?" is about.
  reset37();
  await customer.transport.injectIncoming({ id: 'wamid.q41', from: CUST, chatId: C37, chatName: '', isGroup: false, body: 'Hai kya?', hasMedia: false, mediaType: 'chat', contextId: 'wamid.own-list-41' });
  const q41 = sent(customer);
  check('"Hai kya?" swiped onto their own list answers for the parts in it', /16510M65L10/.test(q41) && !/Samajh nahi|didn't get that/i.test(q41));
  check('...including the hyphenated one', /26300-02752|2630002752/.test(q41));

  // 13 Sep, founder: "Kai parts ek saath chahiye ... bna do" - the portal chat
  // answered a list of parts for one customer in one table; the bot did one
  // part per message. And "daam mein shaamil -> yahan included bolega na".
  console.log('\n[42] several parts analysed for one customer at once');
  const S42 = '919000000342';
  config.salesTeamNumbers.push(S42);
  const C42 = 'sim-' + S42;
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  portal.setMockStock([
    { part_no: '2630002752', name: 'FILTER ASSY-ENGINE OIL | HYUNDAI', quantity: 0, price: 80, mrp: 112, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '16510M65L10', name: 'OIL FILTER | MARUTI SUZUKI ALTO | #16510M65L10', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '13780M76SA0', name: 'ELEMENT, AIR CLEANER', quantity: 10, price: 150, mrp: 300, vendor: 'BIJWASAN WAREHOUSE' },
  ]);
  sales33._resetDirectory();
  for (const o of store.orders()) if (o.chatId === C42 && o.status === 'draft') o.status = 'cancelled';
  store.save();

  customer.transport.outbox.length = 0;
  await dm(customer, S42, '26300-02752 40 pcs\n16510m65L10 100 pcs\n13780m76SA0 25 pcs\nkalra motors analysis');
  const m42 = sent(customer);
  check('three parts and a customer name come back as ONE analysis', customer.transport.outbox.length === 1 && /Kalra Motors - 3 parts/.test(m42));
  check('...with every part and its own quantity', /16510M65L10 x100/.test(m42) && /13780M76SA0 x25/.test(m42) && /2630002752.*x40|x40/.test(m42));
  check('...each at its rate, GST included', /₹92\.4\/pc incl\. 18% GST/.test(m42));
  check('...allocated and short per part', /Allocated 10 · shortfall 15/.test(m42) && /Allocated 100 · shortfall 0/.test(m42));
  check('...the part names', /Oil Filter - Maruti Suzuki Alto/.test(m42));
  check('...one total with the taxable value and GST inside it', /Total ₹[\d,.]+ \(taxable ₹[\d,.]+, GST ₹[\d,.]+\)/.test(m42) && !/\+ 18% GST|\+ GST/.test(m42));
  check('...how many are fully in stock', /1 of 3 fully in stock|3 mein se 1 poore stock mein/.test(m42));
  check('...and never our purchase price', !/₹70\b|₹150\b|₹80\b/.test(m42));

  customer.transport.outbox.length = 0;
  await dm(customer, S42, '16510M65L10 10\n13780M76SA0 5\nkalra motors detail');
  const one42 = sent(customer);
  check('"detail" asks for the analysis as well as "analysis" does', /Kalra Motors - 2 parts/.test(one42) && /16510M65L10 x10/.test(one42) && /13780M76SA0 x5/.test(one42));

  customer.transport.outbox.length = 0;
  await dm(customer, S42, 'punch this order');
  const p42 = sent(customer);
  check('"punch this order" after it takes every part just analysed', qtyOf37('16510M65L10', C42) === 10 && qtyOf37('13780M76SA0', C42) === 5 && /(shall i punch it|punch kar dun)\?/i.test(p42));

  // No customer named: what it always was - availability only.
  const fresh42 = () => {
    for (const o of store.orders()) if (o.chatId === C42 && o.status === 'draft') o.status = 'cancelled';
    sales33._resetDirectory();
    store.save();
    customer.transport.outbox.length = 0;
  };
  fresh42();
  await dm(customer, S42, '16510m65L10 100 pcs\n13780m76SA0 25 pcs');
  check('the same parts with no customer named get availability only', /16510M65L10/.test(sent(customer)) && !/Kalra Motors|taxable|incl\. 18% GST/.test(sent(customer)));

  // Founder, 13 Sep: the full analysis only when asked for - "analyse",
  // "analysis" or "detail" - and several parts only one per LINE, not by comma.
  fresh42();
  await dm(customer, S42, '16510M65L10 10 kalra motors');
  check('a part and a customer name without "analysis" get availability only', /16510M65L10/.test(sent(customer)) && !/Kalra Motors -|taxable|incl\. 18% GST/.test(sent(customer)));
  fresh42();
  await dm(customer, S42, '16510M65L10 10\n13780M76SA0 5\nkalra motors');
  check('several lines and a name without "analysis" get availability only', /16510M65L10/.test(sent(customer)) && !/Kalra Motors -|taxable|incl\. 18% GST/.test(sent(customer)));
  fresh42();
  await dm(customer, S42, '16510M65L10 10, 13780M76SA0 5 kalra motors analysis');
  check('parts separated by commas are not a several-part analysis', !/Kalra Motors - 2 parts/.test(sent(customer)));

  // "GST shaamil hai" -> "GST included", in Hinglish as well.
  reset37();
  await dm(customer, CUST, '16510M65L10 5');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'GST kitna lagega');
  check('the GST answer says "GST included", never "shaamil"', /GST included/.test(lastOut(customer)) && !/shaamil/i.test(lastOut(customer)));

  // 13 Sep, live, admin chat 11:11-11:13 UTC:
  //   "16510m65L10 100 pcs / 13780m76SA0 25 pcs" -> availability, then
  //   "Detail analysis for kalra motors" -> handed to the helper as "not a
  //   parts question" (E3), because it carried no part number itself.
  //   A swiped "1." onto the older Anuj list -> "Which one? All Variants /
  //   With Yellow" - a "Kaunsi gaadi?" left open since 10:41, kept alive by
  //   "Poora kr do cancel" and "1." being read as answers to it.
  console.log('\n[43] an analysis asked for after the parts, old lists swiped, a stale "kaunsi gaadi"');
  const S43 = '919000000343';
  config.salesTeamNumbers.push(S43);
  const C43 = 'sim-' + S43;
  portal.setMockCustomers([
    { id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' },
    { id: 501, name: 'Anuj', address: 'Cartrends', group_name: '' },
    { id: 502, name: 'anuj', address: 'Haryana (IN)', group_name: '' },
    { id: 503, name: 'ANUJ GOSAIN', address: 'SECTOR - 15 VASUNDHRA, Uttar Pradesh (IN)', group_name: '' },
  ]);
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'OIL FILTER | MARUTI SUZUKI ALTO', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '13780M76SA0', name: 'ELEMENT, AIR CLEANER', quantity: 10, price: 150, mrp: 300, vendor: 'BIJWASAN WAREHOUSE' },
  ]);
  sales33._resetDirectory();
  let n43 = 0;
  const said43 = async (from, body, extra = {}) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s43-' + ++n43, from, chatId: 'sim-' + from, chatName: '', isGroup: false, body, hasMedia: false, mediaType: 'chat', ...extra });
    return sent(customer);
  };
  const toHelper43 = () => customer.transport.outbox.some((o) => o.to === config.escalationNumber);

  await said43(S43, '16510m65L10 100 pcs\n13780m76SA0 25 pcs');
  const a43 = await said43(S43, 'Detail analysis for kalra motors');
  check('"Detail analysis for kalra motors" analyses the parts just sent, for Kalra', /Kalra Motors - 2 parts/.test(a43) && /16510M65L10 x100/.test(a43) && /13780M76SA0 x25/.test(a43));
  check('...and nothing is handed to the helper', !toHelper43() && !/Passing this to our team/i.test(a43));
  await said43(S43, '16510M65L10 10');
  check('one part just sent: "analysis for kalra motors" is that part', /Kalra Motors - 16510M65L10 x10/.test(await said43(S43, 'analysis for kalra motors')));

  const S43B = '919000000344';
  config.salesTeamNumbers.push(S43B);
  const none43 = await said43(S43B, 'detail analysis for kalra motors');
  check('with no parts sent yet it asks for them, and passes nothing to the helper', customer.transport.outbox.length === 1 && /part/i.test(none43) && !toHelper43());

  // An older customer list, swiped after other messages came in between.
  sales33._resetDirectory();
  await said43(S43, 'Give me pending of anuj');
  const list43 = customer.transport.outbox.find((o) => /Which one\?|Kaunsa wala\?/.test(o.text || ''));
  await said43(S43, '1.');
  await said43(S43, '16510M65L10 5');
  const re43 = await said43(S43, '3.', { contextId: list43 && list43.id });
  check('a "3." swiped onto that older list picks the third customer on it', Boolean(list43) && /^ANUJ GOSAIN - /m.test(re43));

  // "Kaunsi gaadi?" is answered by a car, not by "1." or a cancel.
  const clarify43 = require('../src/core/clarify');
  reset37();
  clarify43.ask(C37, { base: 'brake pad', qty: 1 }, { text: 'Kaunsi gaadi?', facet: 'vehicle' });
  await dm(customer, CUST, 'Poora kr do cancel');
  await dm(customer, CUST, '1.');
  const cl43 = clarify43.get(C37);
  check('"Poora kr do cancel" and "1." are not answers to "Kaunsi gaadi?"', !cl43 || cl43.base === 'brake pad');
  check('...and no "Which one?" is made out of them', !/Which one\? All|Kaunsa\? All/.test(sent(customer)));
  chatState37.slot('clarify.pending').set(C37, { base: 'brake pad', qty: 1, asked: ['vehicle'], at: Date.now() - 25 * 60 * 1000 });
  clarify43.refine(C37, 'alto');
  const aged43 = clarify43.get(C37);
  check('an answer does not restart the clock on the question', Boolean(aged43) && Date.now() - aged43.at >= 25 * 60 * 1000);
  reset37();

  // 13 Sep, live, admin chat 16:49-16:56: "Inka mrp batana" got a catalogue
  // search for the word "inka" (PV A30 480 YELLOW tape...); "Mrp kya hai inka"
  // swiped onto the cart list went to the helper as a part called "inka";
  // "Mrp of these parts" showed no MRP when the discount was 0 and was headed
  // with a customer name that did not say what it was for; "Analysis this"
  // swiped onto the list got "Sorry, didn't get that".
  console.log('\n[44] "inka", MRP always shown, and "Analysis this" on a list');
  const rates44 = require('../src/core/rates');
  const S44 = '919000000345';
  config.salesTeamNumbers.push(S44);
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'OIL FILTER | MARUTI SUZUKI ALTO', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '13780M76SA0', name: 'ELEMENT, AIR CLEANER', quantity: 10, price: 150, mrp: 300, vendor: 'BIJWASAN WAREHOUSE' },
  ]);

  reset37();
  await dm(customer, CUST, '16510M65L10 5\n13780M76SA0 2');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Inka mrp batana');
  const inka44 = sent(customer);
  check('"Inka mrp batana" prices the parts just discussed', /16510M65L10/.test(inka44) && /13780M76SA0/.test(inka44) && /MRP ₹105/.test(inka44));
  check('...and "inka" is never searched or asked about as a part', !/Question \*#/.test(inka44) && !customer.transport.outbox.some((o) => o.to === config.escalationNumber) && !/"inka"/i.test(inka44));

  reset37();
  await dm(customer, CUST, '16510M65L10 5');
  const ack44 = customer.transport.outbox[customer.transport.outbox.length - 1];
  discuss37([{ item: 'BP-1001', partNo: 'BP-1001' }]); // something else discussed since
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({ id: 'wamid.inka44', from: CUST, chatId: C37, chatName: '', isGroup: false, body: 'Mrp kya hai inka', hasMedia: false, mediaType: 'chat', contextId: ack44 && ack44.id });
  const sw44 = sent(customer);
  check('"Mrp kya hai inka" swiped onto a message prices the parts in THAT message', /16510M65L10/.test(sw44) && /MRP ₹105/.test(sw44) && !customer.transport.outbox.some((o) => o.to === config.escalationNumber));

  const zero44 = await rates44.quote(['71731M69R00'], { name: null, ctx: null, lines: [{ partNo: '71731M69R00', rate: 64, mrp: 64, discountPercent: 0, taxPercent: 18 }] }, (en) => en);
  check('with no discount the MRP is still said', /MRP ₹64/.test(zero44 || ''));
  const label44 = await rates44.quote(['16510M65L10'], { name: 'Kalra Motors', ctx: null, label: 'Kalra Motors', lines: [{ partNo: '16510M65L10', rate: 92.4, mrp: 105, discountPercent: 12, taxPercent: 18 }] }, (en) => en);
  check('a rate for a customer says who it is for', /^For Kalra Motors:/.test(label44 || ''));

  // "Analysis this", swiped onto a list of parts.
  const said44 = async (body, extra = {}) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s44-' + Math.random(), from: S44, chatId: 'sim-' + S44, chatName: '', isGroup: false, body, hasMedia: false, mediaType: 'chat', ...extra });
    return sent(customer);
  };
  sales33._resetDirectory();
  await said44('16510M65L10 100 pcs\n13780M76SA0 25 pcs');
  const avail44 = customer.transport.outbox[customer.transport.outbox.length - 1];
  const who44 = await said44('Analysis this', { contextId: avail44 && avail44.id });
  check('"Analysis this" with no customer named or discussed asks which customer', /customer/i.test(who44) && !/didn't get that|Samajh nahi/i.test(who44));
  const kal44 = await said44('Analysis this for kalra motors', { contextId: avail44 && avail44.id });
  check('"Analysis this for kalra motors" swiped onto the list analyses those parts for Kalra', /Kalra Motors - 2 parts/.test(kal44) && /16510M65L10 x100/.test(kal44) && /13780M76SA0 x25/.test(kal44));
  const again44 = await said44('Analysis this', { contextId: avail44 && avail44.id });
  check('...and once Kalra is being discussed, "Analysis this" is for Kalra', /Kalra Motors - 2 parts/.test(again44));
  sales33._resetDirectory();
  const num44 = await said44('1. 16510M65L10 x1\n2. 13780M76SA0 x5\nAnalysis this for kalra motors');
  check('a copied numbered list with "analysis for kalra motors" is analysed as those parts', /Kalra Motors - 2 parts/.test(num44) && /16510M65L10 x1\b/.test(num44) && /13780M76SA0 x5/.test(num44));
  reset37();

  // 13 Sep, founder: "part no. only numerical bhi ho skte hai". Hyundai and
  // Toyota numbers are digits only (2630002752, 9091510003), and every part
  // rule needed a letter: "2630002752 40 pcs" was read as nothing, and in a
  // list with a Maruti number the digits-only line simply vanished. The shape
  // of the message decides that it MAY be a part; the portal decides that it
  // IS one. Phone numbers, bill numbers and amounts stay what they are.
  console.log('\n[45] part numbers that are digits only');
  portal.setMockStock([
    { part_no: '2630002752', name: 'FILTER ASSY-ENGINE OIL | HYUNDAI', quantity: 50, price: 80, mrp: 112, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '9091510003', name: 'FILTER, OIL | TOYOTA', quantity: 30, price: 200, mrp: 420, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '16510M65L10', name: 'OIL FILTER | MARUTI SUZUKI ALTO', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
  ]);
  const helper45 = () => customer.transport.outbox.some((o) => o.to === config.escalationNumber);

  reset37();
  await dm(customer, CUST, '2630002752 40 pcs');
  check('"2630002752 40 pcs" is an order for 40', qtyOf37('2630002752') === 40);
  reset37();
  await dm(customer, CUST, '9091510003 2');
  check('"9091510003 2" is an order for 2', qtyOf37('9091510003') === 2);
  reset37();
  await dm(customer, CUST, '2630002752 4 pcs\n16510M65L10 2');
  check('a digits-only line in a list is kept next to a Maruti number', qtyOf37('2630002752') === 4 && qtyOf37('16510M65L10') === 2);
  reset37();
  await dm(customer, CUST, '2630002752 hai kya?');
  check('"2630002752 hai kya?" is answered about that part', /2630002752/.test(lastOut(customer)));

  reset37();
  await dm(customer, CUST, '1234567890 5 pcs');
  check('digits the portal does not know are not ordered', !orders.findDraft(C37));
  check('...not asked of the helper as a part', !helper45());
  check('...and the customer is told it was not found', /nahi mila|not found|not on the portal/i.test(sent(customer)));

  for (const notPart of ['9876543210', 'call me 9876543210', 'Bill no 2565', 'payment 25000 done']) {
    reset37();
    await dm(customer, CUST, notPart);
    check(`"${notPart}" is not a part`, !orders.findDraft(C37) && !helper45() && !/1234567890|9876543210 x|x25000/.test(sent(customer)));
  }

  const S45 = '919000000346';
  config.salesTeamNumbers.push(S45);
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  sales33._resetDirectory();
  customer.transport.outbox.length = 0;
  await dm(customer, S45, '2630002752 10\n16510M65L10 5\nkalra motors analysis');
  const an45 = sent(customer);
  check('a digits-only part is analysed for a customer next to a Maruti one', /Kalra Motors - 2 parts/.test(an45) && /2630002752 x10/.test(an45) && /16510M65L10 x5/.test(an45));

  reset37();
  await customer.transport.injectIncoming({ id: 'wamid.own45', from: CUST, chatId: C37, chatName: '', isGroup: false, body: '2630002752 40 pcs\n16510M65L10 2', hasMedia: false, mediaType: 'chat' });
  reset37();
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({ id: 'wamid.q45', from: CUST, chatId: C37, chatName: '', isGroup: false, body: 'Hai kya?', hasMedia: false, mediaType: 'chat', contextId: 'wamid.own45' });
  check('"Hai kya?" swiped onto a list with a digits-only part answers for it too', /2630002752/.test(sent(customer)) && /16510M65L10/.test(sent(customer)));
  reset37();

  // "Aapne 16510m65l10 chhote akshar mein likha tha, isliye Odoo mein nahi
  // mila" -> "to isko shi kro auto capital".
  const cfg39 = require('../src/config').dealerPortal;
  const listAcctWas39 = cfg39.listPriceAccountId;
  cfg39.listPriceAccountId = 1; // a house account, so an unregistered number still gets MRP
  portal.setMockStock([{ part_no: '16510M65L10', name: 'Oil Filter', quantity: 50, price: 70, mrp: 105, vendor: 'N' }]);
  try {
    const q39 = await require('../src/core/rates').quote(['16510m65l10'], { name: null, ctx: null, lines: [] }, (en) => en);
    check('a part typed in lowercase still finds its MRP on the portal', /MRP ₹105/.test(q39 || ''));
    // MRP is the price with GST in it; "GST extra" told the customer to add 18% to it.
    check('an MRP quote says GST is included, never extra', /incl\. GST/i.test(q39 || '') && !/GST extra|GST alag/i.test(q39 || ''));
    const priced39 = await require('../src/core/rates').quote(['16510M65L10'], { name: null, ctx: null, lines: [{ partNo: '16510M65L10', rate: 92.4, mrp: 105, discountPercent: 12, taxPercent: 18 }] }, (en) => en);
    check('a customer rate is quoted with GST inside it', /₹92\.4/.test(priced39 || '') && /incl\. 18% GST/.test(priced39 || '') && !/\+ 18% GST|GST extra/.test(priced39 || ''));
  } finally {
    cfg39.listPriceAccountId = listAcctWas39;
  }

  // 13 Sep, founder, after marking the replay: where the gates would hand a
  // message to a person and the Understand model says it is conversation, the
  // model is followed (31 right, 2 wrong); where the gates drop an order the
  // model read, it is read back and added only after a yes (10 right, 0
  // wrong). "aur silent kbhi na ho bot."
  console.log('\n[46] the model decides chat vs a person, and catches the orders the gates drop');
  const ai46 = require('../src/core/ai');
  const shadow46 = require('../src/pipeline/shadow');
  portal.setMockStock([
    { part_no: '22400M74L00', name: 'Clutch Plate Swift', quantity: 12, price: 1850, mrp: 2400, vendor: 'Northend' },
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
  ]);
  const keyWas46 = config.ai.apiKey;
  config.ai.apiKey = 'test-key';
  const live46 = { parse: null, chat: null, understand: null, calls: 0 };
  ai46._setClaude(async (system, user) => {
    if (/^You parse WhatsApp messages/.test(system)) return live46.parse ? live46.parse(user) : { intent: 'other' };
    if (/^You answer WhatsApp messages for CARTRENDS/.test(system)) return live46.chat ? live46.chat(system, user) : { action: 'silent' };
    if (/^You are the counter person/.test(system)) {
      live46.calls++;
      if (live46.understand === 'down') throw new Error('model down');
      return live46.understand ? live46.understand(user) : { intent: 'chat' };
    }
    return {};
  });
  const team46 = () => customer.transport.outbox.some((o) => o.to === config.escalationNumber);
  const said46 = (chatId = C37) => customer.transport.outbox.filter((o) => o.to === chatId);
  // The chat model hands money talk to a person unless it is told nobody is being asked.
  const handsOver46 = (system) => (/NOT going to a person/.test(system) ? { action: 'reply', text: 'Theek hai sir.' } : { action: 'human' });

  // 1. The chat layer wants a person, the model says it is conversation.
  // In a group, where Cartrends people read every message (the replay's Kalra group).
  resetG38();
  live46.chat = handsOver46;
  live46.understand = () => ({ intent: 'chat', why: 'payment remark' });
  await group(customer, GC38, 'Please collect cheque tomorrow');
  check('group, model says chat: "Please collect cheque tomorrow" is not handed to a person', !team46());
  check('...and the customer gets a reply in words', said46(G38).length === 1 && /Theek hai sir/.test(lastOut(customer)));
  check('...never "passing this to our team" when nobody was told', !/team ko bata diya|passing this to our team/i.test(sent(customer)));

  resetG38();
  for (const promise of ['Sir, sales team hi arrange karti hai, wahi contact karenge aapse.', 'Sir, is baare mein aapko hamari sales team call karke confirm kar degi.', 'Billing wo dekh lenge sir.']) {
    resetG38();
    live46.chat = (system) => (/NOT going to a person/.test(system) ? { action: 'reply', text: promise } : { action: 'human' });
    await group(customer, GC38, 'Please collect cheque tomorrow');
    check(`a promise nobody was asked to keep is not sent ("${promise.slice(0, 40)}")`, said46(G38).length === 1 && lastOut(customer) !== promise && /Theek hai sir|Okay sir/.test(lastOut(customer)) && !team46());
  }
  live46.chat = handsOver46;

  // Group, "Baki bill kardo": 13 Sep sandbox, nothing at all was sent.
  resetG38();
  live46.parse = null;
  live46.understand = () => ({ intent: 'chat' });
  live46.chat = (system) => (/NOT going to a person/.test(system) ? { action: 'reply', text: 'Theek hai sir.' } : { action: 'human' });
  await group(customer, GC38, 'Baki bill kardo');
  check('group: "Baki bill kardo" is never met with silence', said46(G38).length === 1);
  live46.chat = handsOver46;

  // In a DM nobody else reads it.
  reset37();
  await dm(customer, CUST, 'Please collect cheque tomorrow');
  check('DM: money talk still reaches a person, even when the model calls it chat', team46());

  reset37();
  live46.understand = () => ({ intent: 'handoff', handoffReason: 'NOT_A_PART' });
  await dm(customer, CUST, 'Please collect cheque tomorrow');
  check('model says handoff: it still goes to a person, as before', team46() && /team ko bata diya|passing this to our team/i.test(sent(customer)));

  reset37();
  live46.understand = 'down';
  await dm(customer, CUST, 'Please collect cheque tomorrow');
  check('model down: the old way stands - a person is asked', team46());

  // Same in a group, for a customer.
  resetG38();
  live46.understand = () => ({ intent: 'chat' });
  live46.chat = (system) => (/NOT going to a person/.test(system) ? { action: 'silent' } : { action: 'human' });
  await group(customer, GC38, '@Ronak ?');
  check('group customer: "@Ronak ?" the model calls chat is not handed over', !team46());
  check('...and is not met with silence', said46(G38).length === 1);

  // 2. A stock question with no part in it, which the model calls chat: no
  // catalogue list, no "which vehicle", no person.
  reset37();
  live46.parse = () => ({ intent: 'inquiry', items: ['rane'] });
  live46.chat = (system) => (/NOT going to a person/.test(system) ? { action: 'reply', text: 'Haan sir, Rane bhi rakhte hain. Part number bhej dijiye.' } : { action: 'human' });
  live46.understand = () => ({ intent: 'chat' });
  await dm(customer, CUST, 'You deal in rane also?');
  check('"You deal in rane also?" the model calls chat is answered in words', said46().length === 1 && /Rane bhi/.test(lastOut(customer)) && !team46());

  reset37();
  live46.understand = () => ({ intent: 'inquiry', lines: [{ item: 'rane', qtyMissing: true }] });
  await dm(customer, CUST, 'You deal in rane also?');
  check('...and when the model reads a stock question, the gates answer as before', !/Rane bhi/.test(sent(customer)) && said46().length >= 1);

  // 3. A quantity with no part to put it on.
  reset37();
  live46.parse = () => ({ intent: 'set_qty', item: 'pc', qty: 2 });
  live46.chat = () => ({ action: 'silent' });
  live46.understand = () => ({ intent: 'chat', why: 'no item to attach 2pc to' });
  await dm(customer, CUST, '2pc');
  check('"2pc" with nothing to put it on is not "checking this part"', !/checking this part|check kar raha hoon/i.test(sent(customer)));
  check('...nobody is asked about a part called "pc"', !team46());
  check('...and the customer is told what is missing', said46().length === 1 && /part number/i.test(lastOut(customer)));

  // 4. The order the gates dropped: "Need 5pc" after one part was discussed.
  // As in the replay: nothing held in focus, the part only in what was said.
  reset37();
  conv37.record(C37, 'us', P37 + ' - available. Kitne chahiye?');
  live46.parse = () => ({ intent: 'order', lines: [{ item: 'Need', qty: 5 }] });
  live46.understand = () => ({ intent: 'order', lines: [{ item: P37, qty: 5 }] });
  await dm(customer, CUST, 'Need 5pc');
  check('"Need 5pc" the model reads as an order is read back first', !orders.findDraft(C37) && new RegExp(P37 + ' x5').test(lastOut(customer)) && !team46());
  await dm(customer, CUST, 'haan');
  check('...and added only after the yes', qtyOf37(P37) === 5);

  reset37();
  discuss37([{ item: P37, partNo: P37 }]);
  live46.parse = () => ({ intent: 'order', lines: [{ item: 'Brake pad', qty: 5 }] });
  live46.understand = () => ({ intent: 'order', lines: [{ item: 'Brake pad', qty: 5 }] });
  await dm(customer, CUST, 'Brake pad 5');
  check('a name the model cannot pin to a part number still goes the old way (catalogue)', /BP-1001|brake pad/i.test(sent(customer)) && !/order mein daal doon/.test(sent(customer)));

  // 5. A part number with no quantity that only the model placed: ask how many.
  reset37();
  discuss37([{ item: P37, partNo: P37 }]);
  live46.parse = () => ({ intent: 'other' });
  live46.understand = () => ({ intent: 'order', lines: [{ item: P37, qty: null, qtyMissing: true }] });
  await dm(customer, CUST, 'ye bhi chahiye wo wala');
  check('an order with no quantity is asked "how many", not "didn\'t get that"', !/didn't get that|Samajh nahi/i.test(sent(customer)) && /kitni|kitne|how many/i.test(sent(customer)) && !orders.findDraft(C37));

  // 6. Never silent: "??" the chat model chose to leave unanswered.
  reset37();
  live46.understand = () => ({ intent: 'chat' });
  live46.chat = () => ({ action: 'silent' });
  await dm(customer, CUST, '??');
  check('"??" is answered', said46().length === 1);
  reset37();
  await dm(customer, CUST, 'achha');
  check('...a plain "achha" still needs nothing', said46().length === 0);

  reset37();
  require('../src/core/clarify').ask(C37, { base: 'brake pad', qty: 1 }, { text: 'Kaunsi gaadi?', facet: 'vehicle' });
  await dm(customer, CUST, '1.');
  check('with "Kaunsi gaadi?" open, "1." asks it again - not "nothing pending"', said46().length === 1 && /Kaunsi gaadi\?/.test(lastOut(customer)) && !/pending nahi|Nothing pending/i.test(lastOut(customer)));
  reset37();

  customer.transport.outbox.length = 0;
  await dm(customer, config.escalationNumber, 'ye wala party ka discount check karo');
  check('a stray line from the helper is not answered with "send the part number"', !customer.transport.outbox.some((o) => o.to === 'sim-' + config.escalationNumber && /pending nahi|Nothing pending/i.test(o.text)));

  // One model call per message, shared by the bot and the shadow log.
  const sharedWas46 = config.sharedDir;
  config.sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoflow-shadow46-'));
  config.ai.shadow = true;
  reset37();
  live46.chat = handsOver46;
  live46.understand = () => ({ intent: 'chat' });
  live46.calls = 0;
  await dm(customer, CUST, 'MAKING CHEQUE');
  await shadow46._flush();
  check('the bot and the shadow log share one model call', live46.calls === 1);
  config.ai.shadow = false;
  try {
    fs.rmSync(config.sharedDir, { recursive: true, force: true });
  } catch {}
  config.sharedDir = sharedWas46;

  ai46._setClaude(null);
  config.ai.apiKey = keyWas46;
  reset37();
  resetG38();

  // 13 Sep, founder, before confirm goes to the model: tell it which confirm
  // step the chat is on (the same steps for everyone); "order status check
  // krke ans dena"; and an admin or salesman asking money things is answered,
  // not sent to the team.
  console.log('\n[47] confirm steps for the model, order status from the portal, own team not escalated');
  const shadow47 = require('../src/pipeline/shadow');
  const understand47 = require('../src/pipeline/understand');
  check('the model has an orderStatus intent', understand47.INTENTS.includes('orderStatus'));

  reset37();
  await dm(customer, CUST, P37 + ' 2');
  markAsked(C37);
  const snap47 = shadow47._snapshot({ chatId: C37, from: CUST, body: 'ok', isGroup: false });
  check('the model is told we showed the list and asked to confirm', snap47.open.some((o) => o.kind === 'confirmAsk' && /Confirm karun/.test(o.about)));
  reset37();
  store.load().soReview = store.load().soReview || {};
  store.load().soReview[C37] = { at: new Date().toISOString(), orderIds: ['633'], customerName: 'Kalra Motors', lines: [] };
  store.save();
  const snap47b = shadow47._snapshot({ chatId: C37, from: CUST, body: 'ok', isGroup: false });
  check('...and when a draft SO went out with "Sahi hai?"', snap47b.open.some((o) => o.kind === 'soReview' && /draft SO 633/.test(o.about) && /Sahi hai/.test(o.about)));
  check('...and the prompt carries both steps', /soReview/.test(understand47._prompt(snap47b)));

  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'order kahan hai');
  check('with a draft SO waiting, "order kahan hai" says it is waiting for their check', /633/.test(sent(customer)));
  reset37();

  // The real status, from the portal.
  portal.setMockCustomers([{ id: 1, name: 'Mock Customer', home_branch_dealer: 23 }]);
  portal._setMockOrderHistory([
    { order_id: 701, order_date: '2026-09-13T10:00:00', customer_name: 'Mock Customer', status: 'confirmed', do_status: 'confirmed', invoice_no: 'CT-DL-26-27/3301', dispatched_at: '2026-09-13T12:00:00', lines: [{ part_no: P37 }] },
    { order_id: 702, order_date: '2026-09-13T11:00:00', customer_name: 'Mock Customer', status: 'Unallocated', do_status: 'pending', lines: [{ part_no: 'BP-1001' }] },
  ]);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'order kahan hai');
  const st47 = sent(customer);
  check('"order kahan hai" is answered from the portal', /701/.test(st47) && /dispatch/i.test(st47) && /702/.test(st47) && /allocate/i.test(st47));

  const keyWas47 = config.ai.apiKey;
  config.ai.apiKey = 'test-key';
  const ai47 = require('../src/core/ai');
  const live47 = {
    understand: () => ({ intent: 'orderStatus' }),
    chat: (system) => (/NOT going to a person/.test(system) ? { action: 'reply', text: 'Theek hai sir.' } : { action: 'human' }),
  };
  ai47._setClaude(async (system, user) => {
    if (/^You parse WhatsApp messages/.test(system)) return { intent: 'other' };
    if (/^You answer WhatsApp messages for CARTRENDS/.test(system)) return live47.chat(system, user);
    if (/^You are the counter person/.test(system)) return live47.understand(user);
    return {};
  });
  reset37();
  await dm(customer, CUST, 'So bn gya?');
  check('"So bn gya?" the model reads as a status question gets the real status, not a person', /701/.test(sent(customer)) && !team46());

  // Admins and the sales team are the team.
  live47.understand = () => ({ intent: 'chat' });
  const S47 = '919000000347';
  config.salesTeamNumbers.push(S47);
  customer.transport.outbox.length = 0;
  await dm(customer, S47, 'Please collect cheque tomorrow');
  check('salesman: money talk is answered, not handed to a person', !team46() && customer.transport.outbox.some((o) => o.to === 'sim-' + S47));
  const A47 = '919000000348';
  config.adminNumbers.push(A47);
  customer.transport.outbox.length = 0;
  await dm(customer, A47, 'Please collect cheque tomorrow');
  check('admin: money talk is answered, not handed to a person', !team46() && customer.transport.outbox.some((o) => o.to === 'sim-' + A47));
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Please collect cheque tomorrow');
  check('...a customer DM still reaches a person', team46());

  ai47._setClaude(null);
  config.ai.apiKey = keyWas47;
  portal._setMockOrderHistory(null);
  reset37();

  // 13 Sep, 21:27, live, the founder: a photo of a 30-part list captioned
  // "analyze this order for kalra motors. I need all details." came back as
  // "📷 Your order from the photo" - a stock check and a cart on his own
  // account, and a confirm nudge after it. "analysis vala saara kaam achhe se
  // hona chahiye... admin and salesman. kuch bhi wrong ya escalate nhi".
  console.log('\n[48] a photo, PDF or sheet with "analyse for <customer>" from the desk');
  const ai48 = require('../src/core/ai');
  const S48 = '919000000349';
  const C48 = 'sim-' + S48;
  config.salesTeamNumbers.push(S48);
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'OIL FILTER | MARUTI SUZUKI ALTO', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '13780M76SA0', name: 'ELEMENT, AIR CLEANER', quantity: 10, price: 150, mrp: 300, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '71751M69R005PK', name: 'CLIP', quantity: 2, price: 5, mrp: 12, vendor: 'BIJWASAN WAREHOUSE' },
  ]);
  const readWas48 = ai48.parseOrderImage;
  ai48.parseOrderImage = async () => [
    { item: '16510M65L10', qty: 203 },
    { item: '13780M76SA0', qty: 50 },
    { item: '71751M69R005PK', qty: 5 },
  ];
  const photo48 = async (caption, from = S48) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({
      id: 'wamid.p48-' + Math.random(), from, chatId: 'sim-' + from, isGroup: false,
      body: caption, hasMedia: true, mediaType: 'image', mediaBase64: 'iVBORw0KGgo=', mediaMime: 'image/png',
    });
    return sent(customer);
  };
  try {
    sales33._resetDirectory();
    const an48 = await photo48('analyze this order for kalra motors. I need all details.');
    check('a photo captioned "analyze this order for kalra motors" is analysed for Kalra', /Kalra Motors - 3 parts/.test(an48));
    check('...every part, with its quantity from the photo', /16510M65L10 x203/.test(an48) && /13780M76SA0 x50/.test(an48) && /71751M69R005PK x5/.test(an48));
    check('...with the money in it', /MRP ₹/.test(an48) && /Total ₹/.test(an48));
    check('...and not a stock check, a cart, or a question to a person', !/Your order from the photo|Photo se aapka order/.test(an48) && !orders.findDraft(C48) && !team46());

    sales33._resetDirectory();
    const short48 = await photo48('analyze for kalra motors');
    check('"analyze for kalra motors" under a photo works the same', /Kalra Motors - 3 parts/.test(short48));

    sales33._resetDirectory();
    const who48 = await photo48('analysis');
    check('a photo captioned only "analysis" asks which customer', /kis customer|which customer/i.test(who48) && !team46() && !orders.findDraft(C48));
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.p48b', from: S48, chatId: C48, isGroup: false, body: 'Analysis this for kalra motors', hasMedia: false, mediaType: 'chat' });
    check('...and "Analysis this for kalra motors" next analyses the parts from that photo', /Kalra Motors - 3 parts/.test(sent(customer)));

    // A customer's photo is still their order.
    const cust48 = await photo48('analysis', '919899555048');
    check('a customer photo with "analysis" is still read as their order', /Your order from the photo|Photo se aapka order/.test(cust48));
  } finally {
    ai48.parseOrderImage = readWas48;
  }

  // WhatsApp takes 4096 characters; a long analysis goes as several messages.
  const pieces48 = require('../src/wa/cloudTransport')._pieces;
  const long48 = Array.from({ length: 400 }, (_, i) => (i + 1) + '. 16510M65L10 x10 · Allocated 10 · shortfall 0').join('\n');
  const cut48 = pieces48(long48);
  check('a long message is cut into pieces WhatsApp accepts', cut48.length > 1 && cut48.every((p) => p.length <= 4096));
  check('...between lines, with nothing lost', cut48.join('\n') === long48);
  check('a short message is one piece', pieces48('hello').length === 1);
  reset37();

  // 13 Sep, founder, on what "inquiry-only" would have meant for admins:
  // "punch hona chahiye..hn bolne se..agr customer ka naam le kr bole tb bhi
  // aur agr na bole to jo no. hai admin ke naam se". An admin orders - for a
  // named customer, or else on his own number's account - and is never sent
  // to the helper.
  console.log('\n[49] admins order: for a named customer, or on their own account');
  const A49 = '919000000350';
  const C49 = 'sim-' + A49;
  config.adminNumbers.push(A49);
  const said49 = [];
  const ask49 = async (body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.a49-' + Math.random(), from: A49, chatId: C49, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    const out = sent(customer);
    said49.push(out);
    return out;
  };
  await ask49('16510M65L10 2');
  check('admin: parts with no customer named go into a cart on their own account', qtyOf37('16510M65L10', C49) === 2);
  markAsked(C49);
  const punchWas49 = portal.confirm;
  let punched49 = false;
  portal.confirm = async () => {
    punched49 = true;
    return { soNumber: '9049' };
  };
  try {
    const haan49 = await ask49('haan');
    check('admin: "haan" on it goes to the punch', punched49 || /note kar liya|noted your order|testing|draft so/i.test(haan49));
  } finally {
    portal.confirm = punchWas49;
  }
  { const d = orders.findDraft(C49); if (d) orders.cancel(d); }

  // For a named customer.
  sales33._resetDirectory();
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  await ask49('Kalra Motors ka SO bana do');
  await ask49('haan'); // "Kalra Motors (Gurgaon, Haryana) - yahi wale?"
  await ask49('16510M65L10 2');
  const d49 = orders.findDraft(C49);
  check('admin: after picking Kalra Motors, parts go into Kalra\'s order', Boolean(d49 && d49.portalCustomer && /Kalra/i.test(d49.portalCustomer.name || '') && d49.lines.some((l) => String(l.partNo || l.item).toUpperCase() === '16510M65L10')));
  if (d49) orders.cancel(d49);
  require('../src/core/salesOrder').clear(C49);

  // A part the portal does not have: told, with the closest numbers - never a helper question.
  customer.transport.outbox.length = 0;
  portal.setMockStock([{ part_no: '71751M69R005PK', name: 'FOG LAMP COVER', quantity: 4, price: 30, mrp: 42, vendor: 'BIJWASAN WAREHOUSE' }]);
  // The mock portal has no catalogue search; the live one answered this search with that part.
  const searchWas49 = portal.searchByName;
  portal.searchByName = async (q) => (/71751M69R00/i.test(q) ? { total: 1, top: [{ partNo: '71751M69R005PK', name: 'FOG LAMP COVER' }] } : { total: 0, top: [] });
  const unk49 = await ask49('71751M69R00 5').finally(() => {
    portal.searchByName = searchWas49;
  });
  check('admin: an unknown part is not sent to the helper', !team46());
  check('admin: ...the reply says it is not on the portal and offers the closest part', /nahi mila|not on the portal/i.test(unk49) && /71751M69R005PK/.test(unk49));
  check('admin: ...with the closest part\'s stock for the quantity asked (5 asked, 4 there)', /71751M69R005PK \((only|sirf) 4 available\)/.test(unk49));
  { const d = orders.findDraft(C49); if (d) orders.cancel(d); }
  config.adminNumbers.splice(config.adminNumbers.indexOf(A49), 1);
  reset37();

  // 13 Sep, 21:49, live. A photo with "analyze this order for lagan motors":
  // the customer search failed (401 SESSION_INACTIVE) and the founder was told
  // "No customer called lagan motors found ... the 22 parts are kept"; his
  // "lagan motors" next got "part number bhej dijiye". And a 22-part photo
  // with no caption repeated its whole list 40 s later.
  console.log('\n[50] file analysis: a failed search, the name sent on its own, one ask per photo');
  const S50 = '919000000351';
  const C50 = 'sim-' + S50;
  config.salesTeamNumbers.push(S50);
  const ai50 = require('../src/core/ai');
  const readWas50 = ai50.parseOrderImage;
  portal.setMockStock([
    { part_no: '16510M65L10', name: 'OIL FILTER | MARUTI SUZUKI ALTO', quantity: 500, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '13780M76SA0', name: 'ELEMENT, AIR CLEANER', quantity: 10, price: 150, mrp: 300, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
  ]);
  ai50.parseOrderImage = async () => [{ item: '16510M65L10', qty: 10 }, { item: '13780M76SA0', qty: 2 }, { item: 'BP-1001', qty: 4 }];
  const photo50 = async (caption, from = S50) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.p50-' + Math.random(), from, chatId: 'sim-' + from, isGroup: false, body: caption, hasMedia: true, mediaType: 'image', mediaBase64: 'iVBORw0KGgo=', mediaMime: 'image/png' });
    return sent(customer);
  };
  const say50 = async (body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s50-' + Math.random(), from: S50, chatId: C50, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    return sent(customer);
  };
  const searchWas50 = portal.searchAccounts;
  try {
    sales33._resetDirectory();
    portal.searchAccounts = async () => {
      throw Object.assign(new Error('Dealer Portal GET /accounts/search -> HTTP 401 SESSION_INACTIVE'), { status: 401 });
    };
    const fail50 = await photo50('analyze this order for kalra motors');
    check('a failed customer search is not told as "no such customer"', !/naam ka customer nahi mila|No customer called/i.test(fail50) && /khul nahi|can't open/i.test(fail50));
    portal.searchAccounts = searchWas50;
    sales33._resetDirectory();
    const name50 = await say50('kalra motors');
    check('...and the name sent again on its own analyses the kept parts', /Kalra Motors - 3 parts/.test(name50));

    sales33._resetDirectory();
    const who50 = await photo50('analysis');
    check('"analysis" alone under a photo asks for the customer', /kis customer|which customer/i.test(who50));
    const name50b = await say50('Kalra Motors');
    check('...and a bare "Kalra Motors" next is that customer', /Kalra Motors - 3 parts/.test(name50b));
  } finally {
    portal.searchAccounts = searchWas50;
  }

  // A part on the list the portal does not have: the analysis names the closest.
  sales33._resetDirectory();
  ai50.parseOrderImage = async () => [{ item: '71751M69R00', qty: 5 }, { item: '16510M65L10', qty: 2 }];
  const searchNameWas50 = portal.searchByName;
  portal.searchByName = async (q) => (/71751M69R00/i.test(q) ? { total: 1, top: [{ partNo: '71751M69R005PK', name: 'FOG LAMP COVER' }] } : { total: 0, top: [] });
  try {
    const near50 = await photo50('analyze for kalra motors');
    check('an analysis names the closest catalogue part for one it does not have', /71751M69R00 x5 - (not in the catalogue; closest|catalogue mein nahi mila; milta-julta): 71751M69R005PK/.test(near50) && !team46());
  } finally {
    portal.searchByName = searchNameWas50;
    ai50.parseOrderImage = async () => [{ item: '16510M65L10', qty: 10 }, { item: '13780M76SA0', qty: 2 }, { item: 'BP-1001', qty: 4 }];
  }

  // One ask per photo: the list with "Confirm sir?" is the ask.
  const PC50 = '919899555050';
  const pc50 = await photo50('', PC50);
  const draft50 = orders.findDraft('sim-' + PC50);
  check('a customer photo of 3+ parts shows the list and asks once', /Confirm/i.test(pc50) && Boolean(draft50 && draft50.confirmAskedAt));
  if (draft50) orders.cancel(draft50);
  ai50.parseOrderImage = readWas50;
  reset37();

  // 13 Sep, founder, a coil box: printed "33400 M", "68P10" written after it by
  // hand. Vision read "33400M" twice and it went to a person. "ye handwritten
  // photo kyon nhi pd rha..claude api lagaya hi isliye hai".
  console.log('\n[51] a label finished by hand: "33400 M" + "68P10"');
  const ai51 = require('../src/core/ai');
  const keyWas51 = config.ai.apiKey;
  const ocrWas51 = config.ai.ocr;
  config.ai.apiKey = 'test-key';
  config.ai.ocr = false;
  const calls51 = [];
  ai51._setClaude(async (system, user) => {
    if (!Array.isArray(user)) return { intent: 'other' };
    const text = (user.find((u) => u.type === 'text') || {}).text || '';
    calls51.push({ system, text });
    return /incomplete/.test(text) ? { doc: 'part', lines: [{ item: '33400M68P10' }] } : { doc: 'part', lines: [{ item: '33400M COIL ASSY IGNITION' }] };
  });
  try {
    const got51 = await ai51.parseOrderImage('iVBORw0KGgo=', 'image/jpeg');
    const sys51 = (calls51[0] || {}).system || '';
    check('the photo prompt says handwriting finishes a printed number', /HANDWRITING COUNTS/.test(sys51) && /33400M68P10/.test(sys51) && /1364/.test(sys51));
    check('a photo that gives only "33400M" is looked at once more', calls51.filter((c) => /incomplete/.test(c.text)).length === 1);
    check('...and the whole number is used', (got51 || []).some((l) => /33400M68P10/.test(String(l.item || l.partNo || ''))));

    calls51.length = 0;
    ai51._setClaude(async (system, user) => (Array.isArray(user) ? (calls51.push(1), { doc: 'order', lines: [{ item: '16510M65L10', qty: 5 }] }) : { intent: 'other' }));
    await ai51.parseOrderImage('iVBORw0KGgo=', 'image/jpeg');
    check('a whole number is not looked at twice', calls51.length === 1);
  } finally {
    ai51._setClaude(null);
    config.ai.apiKey = keyWas51;
    config.ai.ocr = ocrWas51;
  }

  // 13 Sep, 22:26-22:30, live, the founder testing as admin:
  //   * "pending of Libra Motors\npending of Bhagwati Motors" got Kalra
  //     Motors' order list (the customer discussed earlier)
  //   * "bhagwati motors discount" -> "send me a part number"; then a bare
  //     "83401M82P11" got nothing at all
  //   * "No discount set for Bhagwati Motors on 83401M82P11." and no price
  console.log('\n[52] several questions in one message, the part asked for, no discount still priced');
  const S52 = '919000000352';
  const C52 = 'sim-' + S52;
  config.salesTeamNumbers.push(S52);
  portal.setMockCustomers([
    { id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '', balance: 5000 },
    { id: 301, name: 'Libra Motors', home_branch_dealer: 23, address: 'Delhi (IN)', group_name: '', balance: 75243 },
    { id: 302, name: 'Bhagwati Motors', home_branch_dealer: 23, address: 'Delhi (IN)', group_name: '', balance: 0 },
  ]);
  portal.setMockStock([{ part_no: '83401M82P11', name: 'REGULATOR ASSY, FRONT WINDOW RH', quantity: 0, price: 400, mrp: 585, vendor: 'BIJWASAN WAREHOUSE' }]);
  const say52 = async (body, from = S52) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s52-' + Math.random(), from, chatId: 'sim-' + from, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    return sent(customer);
  };
  sales33._resetDirectory();
  await say52('Kalra Motors ka order kab aayega'); // Kalra is now being discussed
  const two52 = await say52('pending of Libra Motors\npending of Bhagwati Motors');
  check('two "pending of X" lines are both answered, each for its customer', /Libra Motors/.test(two52) && /Bhagwati Motors/.test(two52) && !/Kalra Motors/.test(two52));

  sales33._resetDirectory();
  portal._setMockOrderHistory([]);
  const ask52 = await say52('bhagwati motors discount');
  check('"bhagwati motors discount" with no part asks for one', /part number/i.test(ask52));
  const disc52 = await say52('83401M82P11');
  check('...and the bare part number next is answered for Bhagwati', /Bhagwati Motors/.test(disc52) && /83401M82P11/.test(disc52));
  check('...and no discount still says the price', /MRP ₹585/.test(disc52));
  portal._setMockOrderHistory(null);

  // An admin who is also the voice helper still gets answers.
  const voiceWas52 = config.voiceEscalationNumber;
  const A52 = '919000000353';
  config.adminNumbers.push(A52);
  config.voiceEscalationNumber = A52;
  try {
    const bare52 = await say52('83401M82P11', A52);
    check('an admin who is also a helper is answered, not left in silence', customer.transport.outbox.some((o) => o.to === 'sim-' + A52));
  } finally {
    config.voiceEscalationNumber = voiceWas52;
    config.adminNumbers.splice(config.adminNumbers.indexOf(A52), 1);
    { const d = orders.findDraft('sim-' + A52); if (d) orders.cancel(d); }
  }

  // A photo read as "83401M82P11 REGULATOR ASSY, FRONT WINDOW RH" is analysed as the part number.
  const ai52 = require('../src/core/ai');
  const readWas52 = ai52.parseOrderImage;
  ai52.parseOrderImage = async () => [{ item: '83401M82P11 REGULATOR ASSY, FRONT WINDOW RH' }];
  try {
    sales33._resetDirectory();
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.p52', from: S52, chatId: C52, isGroup: false, body: 'analyze for libra motors', hasMedia: true, mediaType: 'image', mediaBase64: 'iVBORw0KGgo=', mediaMime: 'image/png' });
    check('the analysis of a photo shows the part number once, not the whole label in brackets', /Libra Motors - 1 parts/.test(sent(customer)) && !/\(83401M82P11 REGULATOR/.test(sent(customer)));
  } finally {
    ai52.parseOrderImage = readWas52;
  }
  reset37();

  // 13 Sep, 22:42, live: "cancel orde" and "cancel order" from the founder,
  // with ORD-1040 already cancelled and Kalra Motors picked for an order -
  // silence, twice.
  console.log('\n[53] cancel, remove and yes with nothing open are still answered');
  const A53 = '919000000354';
  const C53 = 'sim-' + A53;
  config.adminNumbers.push(A53);
  const say53 = async (body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s53-' + Math.random(), from: A53, chatId: C53, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    return customer.transport.outbox.filter((o) => o.to === C53).map((o) => o.text).join('\n');
  };
  sales33._resetDirectory();
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  await say53('Kalra Motors ka SO bana do');
  await say53('haan');
  check('(Kalra Motors is picked)', Boolean(require('../src/core/salesOrder').activeCustomer(C53)));
  const close53 = await say53('cancel order');
  check('"cancel order" with a customer picked and no parts closes that order, and says so', /Kalra Motors/.test(close53) && !require('../src/core/salesOrder').activeCustomer(C53));
  const none53 = await say53('cancel order');
  check('"cancel order" with nothing open says there is nothing to cancel', /no open order|koi open order nahi/i.test(none53));
  const rem53 = await say53('remove 16510M65L10');
  check('"remove X" with nothing open is answered', rem53.length > 0);
  const yes53 = await say53('yes');
  check('a bare "yes" with nothing open is answered', yes53.length > 0);

  // 13 Sep, 22:51, live: "ORD-1036 aur ORD-1037 bhi cancel kar do" from the
  // founder - carts on other chats - got "Abhi koi open order nahi hai".
  console.log('\n[54] cancelling orders by their number');
  const other54a = orders.getOrCreateDraft('sim-919000000355', '919000000355');
  orders.addLines(other54a, [{ item: 'BP-1001', partNo: 'BP-1001', qty: 2, source: 'portal', available: 2 }]);
  const other54b = orders.getOrCreateDraft('sim-919000000356', '919000000356');
  orders.addLines(other54b, [{ item: 'BP-1001', partNo: 'BP-1001', qty: 1, source: 'portal', available: 1 }]);
  store.save();
  const byNo54 = await say53(`${other54a.id} aur ${other54b.id} bhi cancel kar do`);
  check('an admin cancels open carts on other chats by their numbers', other54a.status === 'cancelled' && other54b.status === 'cancelled');
  check('...and is told, for each', new RegExp(other54a.id).test(byNo54) && new RegExp(other54b.id).test(byNo54) && /cancel kar diya|cancelled/i.test(byNo54));
  const again54 = await say53(`${other54a.id} cancel`);
  check('an order already cancelled is said to be so', /pehle se cancelled|already cancelled/i.test(again54));
  check('an order number that does not exist is said to be not found', /nahi mila|not found/i.test(await say53('ORD-99999 cancel kar do')));
  config.adminNumbers.splice(config.adminNumbers.indexOf(A53), 1);

  // Not an admin: only their own chat's cart.
  const other54c = orders.getOrCreateDraft('sim-919000000357', '919000000357');
  orders.addLines(other54c, [{ item: 'BP-1001', partNo: 'BP-1001', qty: 1, source: 'portal', available: 1 }]);
  store.save();
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({ id: 'wamid.s54c', from: CUST, chatId: C37, isGroup: false, body: `${other54c.id} cancel kar do`, hasMedia: false, mediaType: 'chat' });
  check('a customer cannot cancel a cart on someone else\'s chat', other54c.status === 'draft' && /is chat ka order nahi|not an order on this chat/i.test(sent(customer)));
  orders.cancel(other54c);
  reset37();

  // 14 Sep, 14:05, live, punching ON: "yes only 6" on a six-line list punched
  // all six as SO 686; and "detail of order 686" got Bhagwati Motors' analysis.
  console.log('\n[55] "yes only 6", and an order looked up by its number');
  portal.setMockStock([
    { part_no: '22400M74L00', name: 'Clutch Plate Swift', quantity: 12, price: 1850, mrp: 2400, vendor: 'Northend' },
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
  ]);
  reset37();
  await dm(customer, CUST, P37 + ' 2\nBP-1001 3');
  markAsked(C37);
  const punchWas55 = portal.confirm;
  let punched55 = 0;
  portal.confirm = async () => {
    punched55++;
    return { soNumber: '9055' };
  };
  try {
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'yes only 2');
    const d55 = orders.findDraft(C37);
    check('"yes only 2" punches nothing', punched55 === 0);
    check('...keeps only line 2 in the order', Boolean(d55) && d55.lines.length === 1 && String(d55.lines[0].partNo || d55.lines[0].item).toUpperCase() === 'BP-1001');
    check('...and shows it and asks again', /BP-1001/.test(lastOut(customer)) && /punch kar dun|place this order/i.test(lastOut(customer)) && !new RegExp(P37).test(lastOut(customer)));
    await dm(customer, CUST, 'haan');
    check('...the next yes places just that line', punched55 === 1);
  } finally {
    portal.confirm = punchWas55;
  }
  reset37();

  const S55 = '919000000358';
  config.salesTeamNumbers.push(S55);
  sales33._resetDirectory();
  const say55 = async (body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s55-' + Math.random(), from: S55, chatId: 'sim-' + S55, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    return sent(customer);
  };
  await say55('bhagwati motors discount'); // someone else is being discussed
  const det55 = await say55('detail of order 512');
  check('"detail of order 512" answers with that portal order, not an analysis', /Order 512/.test(det55) && /BP-1001 x1/.test(det55) && !/parts:/.test(det55));
  const orderWas55 = portal.order;
  portal.order = async () => {
    throw Object.assign(new Error('Dealer Portal GET /orders/686 -> HTTP 404 {"detail":"Order not found"}'), { status: 404 });
  };
  try {
    const gone55 = await say55('detail of order 686');
    check('an order the portal no longer has is said to be cancelled or a wrong number', /nahi mila|not on the portal/i.test(gone55) && /686/.test(gone55));
  } finally {
    portal.order = orderWas55;
  }
  check('"486 ka bill" is still the bill, not the order detail', require('../src/core/customerLookup').parseOrderDetail('486 ka bill') === null);
  check('"Kalra ka order kab aayega" is still a status question', require('../src/core/customerLookup').parseOrderDetail('Kalra ka order kab aayega') === null);
  reset37();

  // 14 Sep, 14:09-14:23, live, punching ON: the list was asked; "only 10" (no
  // yes) was looked up as a part; "what happen" got a chat promise; then "ok"
  // - answering those - punched all ten lines as SO 687.
  console.log('\n[56] "only N" on its own, "what happen", and a yes after the ask was overtaken');
  const punchWas56 = portal.confirm;
  let punched56 = 0;
  portal.confirm = async () => {
    punched56++;
    return { soNumber: '9056' };
  };
  try {
    reset37();
    await dm(customer, CUST, P37 + ' 2\nBP-1001 3');
    markAsked(C37);
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'only 2');
    const d56 = orders.findDraft(C37);
    check('"only 2" on its own keeps line 2 and asks again', Boolean(d56) && d56.lines.length === 1 && /BP-1001/.test(lastOut(customer)) && /punch kar dun|place this order/i.test(lastOut(customer)));
    check('...and is never looked up as a part called "only"', !team46() && !/checking this part/i.test(sent(customer)) && punched56 === 0);

    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'what happen');
    check('"what happen" says where things stand, from the order', /BP-1001/.test(sent(customer)) && !/process ho raha/i.test(sent(customer)) && punched56 === 0);

    // The ask, then something else from the bot, then "ok".
    reset37();
    await dm(customer, CUST, P37 + ' 2\nBP-1001 3');
    markAsked(C37);
    await new Promise((r) => setTimeout(r, 5200));
    await dm(customer, CUST, 'BP-1001 hai kya?'); // the bot answers something else
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'ok');
    check('an "ok" after the bot said other things since the ask punches nothing', punched56 === 0);
    check('...it shows the list and asks again', new RegExp(P37).test(lastOut(customer)) && /punch kar dun|place this order/i.test(lastOut(customer)));
    await dm(customer, CUST, 'haan');
    check('...and the yes to THAT ask places it', punched56 === 1);
  } finally {
    portal.confirm = punchWas56;
  }
  reset37();

  // 14 Sep, 14:28, live: "71771M76T10\n71721M74T00" (no quantity) got "Stock
  // check: ... confirming the exact part, will get back to you" - a promise
  // nobody keeps - while the same parts from a photo had the closest numbers.
  console.log('\n[57] a stock question about parts the portal does not have: closest parts, with stock');
  portal.setMockStock([{ part_no: '71771M76T10ZSC', name: 'GARNISH', quantity: 7, price: 100, mrp: 150, vendor: 'BIJWASAN WAREHOUSE' }]);
  const searchWas57 = portal.searchByName;
  portal.searchByName = async (q) =>
    /71771M76T10/i.test(q) ? { total: 1, top: [{ partNo: '71771M76T10ZSC', name: 'GARNISH' }] } : { total: 0, top: [] };
  try {
    const inq57 = await customer.answerInquiry(['71771M76T10', '71721M74T00'], { chatId: 'sim-919000000359', from: '919000000359' });
    check('no "will get back to you" for a part nobody is asked about', !/get back to you|confirm karke batata/i.test(inq57));
    check('the unknown part names the closest one, with its stock', /71771M76T10 - (not on the portal; closest|portal pe nahi mila; milta-julta): 71771M76T10ZSC \((available|only \d+ available|sirf \d+ available)\)/.test(inq57));
    check('an unknown part with nothing close goes to the team', /71721M74T00 - (checking with the team|team se check karke batata hoon)/.test(inq57));
  } finally {
    portal.searchByName = searchWas57;
  }
  reset37();

  // 14 Sep, 14:37, live: "ORD-1043" and "details of ORD-1043" (cancelled at
  // 14:34) were both answered with the draft SO waiting on the chat.
  console.log('\n[58] a bot order looked up by its ORD number');
  portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' }]);
  reset37();
  await dm(customer, CUST, 'BP-1001 3');
  const ord58 = orders.findDraft(C37);
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, ord58.id);
  check('"ORD-NNNN" on its own shows that order, open, with its lines', new RegExp(ord58.id).test(lastOut(customer)) && /khula|open/i.test(lastOut(customer)) && /BP-1001/.test(lastOut(customer)));
  orders.cancel(ord58);
  store.load().soReview = store.load().soReview || {};
  store.load().soReview[C37] = { at: new Date().toISOString(), orderIds: ['687'], lines: [] };
  store.save();
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'details of ' + ord58.id);
  check('"details of ORD-NNNN" says it was cancelled - not the draft SO waiting on the chat', /cancelled/i.test(lastOut(customer)) && !/Draft SO 687/.test(lastOut(customer)));
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'ORD-99998');
  check('an ORD number that does not exist is said to be not found', /nahi mila|not found/i.test(lastOut(customer)));
  reset37();

  // 14 Sep, live, SO 687: ten lines punched, the portal kept 4 pieces of one
  // part. Nine on-order lines went as {"allocations":[]} with no part number,
  // include_unallocated was never sent, and the customer was told all of them
  // were "reserved, coming on order".
  console.log('\n[59] on-order lines are sent whole, and only what the portal took is called ordered');
  const body59 = portal._confirmBody({
    id: 'ORD-T59',
    portalCustomer: { buyerId: 265, branchId: 23 },
    lines: [
      { item: '71821M55T00', partNo: '71821M55T00', qty: 10, source: 'unavailable', _raw: { allocations: [] } },
      { item: '71732M55T00', partNo: '71732M55T00', qty: 10, source: 'portal', _raw: { part_no: '71732M55T00', requested_qty: 10, status: 'Partially Available', shortfall: 6, allocations: [{ dealer_id: 23, qty: 4, tat_days: 1 }] } },
    ],
  });
  check('the punch never asks the portal for an unallocated order', !('include_unallocated' in body59) && !('allow_empty_dealers' in body59));
  check('every line carries its part number and the quantity being punched', body59.lines.every((l) => l.part_no && l.requested_qty) && body59.lines[0].part_no === '71821M55T00' && body59.lines[0].requested_qty === 10);
  check('...and the allocations the analysis gave, as dealers', Array.isArray(body59.lines[1].dealers) && body59.lines[1].dealers[0].qty === 4);

  const read59 = portal._readConfirmResponse({
    primary_order: { order_id: 687, lines: [{ part_no: '71732M55T00', quantity: 4 }] },
    unallocated_order: { order_id: 688, lines: [{ part_no: '71821M55T00', quantity: 10 }, { part_no: '71732M55T00', quantity: 6 }] },
  });
  check('the confirm response says what each order took', String(read59.unallocatedOrderId) === '688' && read59.portalLines.length === 3 && read59.portalLines.filter((l) => l.onOrder).length === 2);

  // The reply: a part the portal did not take is said to be NOT ordered.
  portal.setMockStock([
    { part_no: '22400M74L00', name: 'Clutch Plate Swift', quantity: 12, price: 1850, mrp: 2400, vendor: 'Northend' },
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 0, price: 450, mrp: 600, vendor: 'Northend' },
  ]);
  reset37();
  await dm(customer, CUST, P37 + ' 2\nBP-1001 3');
  markAsked(C37);
  const punchWas59 = portal.confirm;
  let sent59 = null;
  let took59 = null;
  portal.confirm = async (o) => {
    sent59 = o.lines.map((l) => String(l.partNo || l.item).toUpperCase() + ' x' + l.qty);
    return { soNumber: '9059', portalLines: took59 };
  };
  try {
    // A part with no stock stays out of the SO.
    took59 = [{ partNo: P37, qty: 2, onOrder: false }];
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'haan');
    const punched59 = sent(customer);
    check('only the part in stock is sent to the portal', Array.isArray(sent59) && sent59.length === 1 && sent59[0] === P37 + ' x2');
    check('...and the message says nothing about what stayed out, reserved or on order', !/reserve hai|Reserved for you|coming on order|stock mein nahi|not in stock|jitna stock/i.test(punched59));

    // Some in stock: punched for what is there.
    portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 1, price: 450, mrp: 600, vendor: 'Northend' }]);
    reset37();
    await dm(customer, CUST, 'BP-1001 3');
    markAsked(C37);
    took59 = [{ partNo: 'BP-1001', qty: 1, onOrder: false }];
    sent59 = null;
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'haan');
    check('a part with 1 of 3 in stock is punched for 1', Array.isArray(sent59) && sent59[0] === 'BP-1001 x1');
    check('...and the message does not spell out "3 mein se 1"', !/3 mein se 1|1 of 3|jitna stock/i.test(sent(customer)));

    // The portal took less than was sent: said plainly.
    reset37();
    await dm(customer, CUST, 'BP-1001 1');
    markAsked(C37);
    took59 = [];
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'haan');
    check('a part the portal did not take is told as NOT ordered', /BP-1001 - (order NAHI hua|NOT ordered)/.test(sent(customer)));

    // Nothing in stock: no SO.
    portal.setMockStock([{ part_no: 'BP-1001', name: 'Brake Pad', quantity: 0, price: 450, mrp: 600, vendor: 'Northend' }]);
    reset37();
    await dm(customer, CUST, 'BP-1001 2');
    markAsked(C37);
    sent59 = null;
    customer.transport.outbox.length = 0;
    await dm(customer, CUST, 'haan');
    check('with nothing in stock no SO is punched, and the customer is told', sent59 === null && /SO nahi banaya|no SO was made/i.test(sent(customer)));
  } finally {
    portal.confirm = punchWas59;
  }
  reset37();

  // 14 Sep, 15:03-15:05, live, the founder as admin ordering for Kalra Motors:
  //   "71732M55T00 x4" (no stock), "71732M55U00" (a stock question), then "2"
  //   changed T00 to x2 instead of U00; "1 kr do" got "Ye part check kar raha
  //   hoon"; and "so bna do" said "1 item poora stock mein nahi".
  console.log('\n[60] a quantity for the part just asked about, "1 kr do", and a plain pre-check');
  const A60 = '919000000360';
  const C60 = 'sim-' + A60;
  config.adminNumbers.push(A60);
  const say60 = async (body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s60-' + Math.random(), from: A60, chatId: C60, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    return customer.transport.outbox.filter((o) => o.to === C60).map((o) => o.text).join('\n---\n');
  };
  const qty60 = (p) => {
    const d = orders.findDraft(C60);
    const l = d && d.lines.find((x) => String(x.partNo || x.item).toUpperCase() === p);
    return l ? l.qty : 0;
  };
  portal.setMockCustomers([{ id: 265, name: 'Kalra Motors', home_branch_dealer: 23, address: 'Gurgaon, Haryana (IN)', group_name: '' }]);
  portal.setMockStock([
    { part_no: '71732M55T00', name: 'HOLDER BUMPER LH', quantity: 0, price: 40, mrp: 59, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '71732M55U00', name: 'HOLDER BUMPER', quantity: 5, price: 40, mrp: 60, vendor: 'BIJWASAN WAREHOUSE' },
  ]);
  sales33._resetDirectory();
  await say60('kalra motors ka so bna do\n71732M55T00 x4');
  await say60('yes');
  check('(Kalra picked, 71732M55T00 x4 in the order)', qty60('71732M55T00') === 4);
  // Live, this was answered as a stock question ("Stock check: ... hai"), which asks no quantity.
  await say60('71732M55U00 hai kya?');
  const two60 = await say60('2');
  check('"2" after asking about 71732M55U00 is for 71732M55U00, not the part before it', qty60('71732M55T00') === 4 && qty60('71732M55U00') === 2);
  const one60 = await say60('1 kr do');
  check('"1 kr do" is never "Ye part check kar raha hoon"', !/check kar raha hoon|checking this part/i.test(one60));
  check('...it makes the part just discussed 1', qty60('71732M55U00') === 1);
  const pre60 = await say60('so bna do');
  check('the pre-check says nothing like "1 item poora stock mein nahi"', !/poora stock mein nahi|not fully in stock/i.test(pre60));
  check('...and lists only what will be punched (the part with no stock is not in it)', /71732M55U00/.test(pre60) && !/71732M55T00/.test(pre60));
  { const d = orders.findDraft(C60); if (d) orders.cancel(d); }
  require('../src/core/salesOrder').clear(C60);
  config.adminNumbers.splice(config.adminNumbers.indexOf(A60), 1);
  reset37();

  // 14 Sep, founder: "ye bhi kr do" - the desk asks on WhatsApp what it would
  // otherwise open the portal for: where an order is, its challan, bill made or
  // not, the shortage list, one part's history, goods coming in.
  console.log('\n[61] desk lookups: track, challan, bill made, shortage, part status, incoming');
  const lookup61 = require('../src/core/customerLookup');
  portal._setMockLookups({
    track: { '639': { input_order_id: 639, delivery_mode: 'Rider', transporter: 'Rahul Thakur', orders: [{ order_id: 639, status: 'confirmed', tracker_status: 'dispatched', payment_status: 'Pending', customer_name: 'Kalra Motors', line_count: 2, total_qty: 5, total_amount: 5406.6 }], lines: [] } },
    dispatches: [{ order_id: 639, transporter: 'Rahul Thakur', status: 'confirmed', tracker_status: 'dispatched', dispatched_at: '2026-09-14T07:09:51', updated_at: '2026-09-14T15:14:11', invoice_no: 'CT-DL-26-27/3225', pod_id: null, pod_outcome_type: null }],
    invoiceStatus: {
      '639': { success: true, order_id: 639, invoice_status: 'confirmed', invoiced: true, invoice_no: 'CT-DL-26-27/3225', odoo_invoice_state: 'posted' },
      '640': { success: true, order_id: 640, invoice_status: 'pending', invoiced: false, invoice_no: null },
    },
    challans: { '639': true },
    shortages: [
      { customer_name: 'Kalra Motors', part_no: '71821M55T00', requested_qty: 10, available_qty: 0, shortfall: 10, created_at: '2026-09-14T09:00:00' },
      { customer_name: 'Libra Motors', part_no: 'BP-1001', requested_qty: 4, available_qty: 1, shortfall: 3, created_at: '2026-09-13T09:00:00' },
      { customer_name: 'Kalra Motors', part_no: '95850M68P00', requested_qty: 1, available_qty: 1, shortfall: 0, created_at: '2026-09-14T10:00:00' },
    ],
    partStatus: { '16510M65L10': { part_no: '16510M65L10', purchase_orders: [{ po_date: '2026-09-01T01:00:00', po_qty: 100 }], sales_orders: [{ so_date: '2026-09-02T01:00:00', so_qty: 60 }], stock: { in_qty: 0, out_qty: 0, bal_qty: 908 } } },
    incoming: [{ po_id: 'PO-GRP-2026-376', po_no: 'PO-GRP-2026-376', supplier: 'M/S Kashliwal Auto Pvt. ', eta: null, item_count: 891, status: 'in-transit' }],
  });
  const S61 = '919000000361';
  config.salesTeamNumbers.push(S61);
  const docs61 = [];
  const sendDocWas61 = customer.transport.sendDocument;
  customer.transport.sendDocument = async (chatId, buffer, filename) => {
    docs61.push({ chatId, filename, size: buffer.length });
    return 'sim-doc';
  };
  const say61 = async (body) => {
    customer.transport.outbox.length = 0;
    await customer.transport.injectIncoming({ id: 'wamid.s61-' + Math.random(), from: S61, chatId: 'sim-' + S61, isGroup: false, body, hasMedia: false, mediaType: 'chat' });
    return sent(customer);
  };
  try {
    sales33._resetDirectory();
    const tr61 = await say61('639 kahan hai');
    check('"639 kahan hai" tells where the order is: dispatched, by whom, the bill, POD', /dispatch/i.test(tr61) && /Rahul Thakur/.test(tr61) && /CT-DL-26-27\/3225/.test(tr61) && /POD/.test(tr61));
    check('"track 639" is the same question', /Rahul Thakur/.test(await say61('track 639')));
    await say61('639 ka challan');
    check('"639 ka challan" sends the challan PDF', docs61.some((d) => /Challan 639\.pdf/.test(d.filename)));
    check('an order with no challan is said so', /challan abhi nahi|No delivery challan/i.test(await say61('640 ka challan')));
    const bill61 = await say61('639 ka bill bana?');
    check('"639 ka bill bana?" answers billed or not, with the bill number', /bill ban gaya|is billed/i.test(bill61) && /CT-DL-26-27\/3225/.test(bill61));
    check('...and "640 ka bill bana?" says not yet', /abhi nahi bana|not billed yet/i.test(await say61('640 ka bill bana?')));
    const all61 = await say61('shortage list');
    check('"shortage list" lists the latest shortages', /71821M55T00/.test(all61) && /BP-1001/.test(all61));
    const kalra61 = await say61('Kalra ki shortage');
    check('"Kalra ki shortage" lists only Kalra\'s', /71821M55T00/.test(kalra61) && !/BP-1001/.test(kalra61));
    check('...and not a line that was filled in full (shortfall 0)', !/95850M68P00/.test(kalra61) && !/95850M68P00/.test(all61));
    const ps61 = await say61('16510M65L10 ka status');
    check('"16510M65L10 ka status" gives stock, purchases and sales', /908/.test(ps61) && /PO/.test(ps61) && /SO/.test(ps61));
    const inc61 = await say61('aane wala maal');
    check('"aane wala maal" lists incoming shipments', /PO-GRP-2026-376/.test(inc61) && /891/.test(inc61));
    check('"486 ka bill" is still the bill PDF, not a lookup', lookup61.parseDesk('486 ka bill') === null);
    check('"Kalra ka order kab aayega" is still the customer status question', lookup61.parseDesk('Kalra ka order kab aayega') === null);

    // The founder's "nahi chalega" phrasings (14 Sep) now match without the model.
    const kinds61 = [
      ['639 wala order kidhar gaya', 'track'],
      ['639 ki delivery slip', 'challan'],
      ['bill hua kya 639', 'billStatus'],
      ['kya kya kam pada', 'shortage'],
      ['16510M65L10 kitna bika', 'partStatus'],
      ['kya stock aa raha hai', 'incoming'],
    ];
    for (const [msg, kind] of kinds61) check(`"${msg}" is read as ${kind}`, (lookup61.parseDesk(msg) || {}).kind === kind);

    // Anything else that sounds like a desk question goes to the model - and a
    // number the model names must really be in the message.
    const keyWas61 = config.ai.apiKey;
    config.ai.apiKey = 'test-key';
    const ai61 = require('../src/core/ai');
    let answer61 = null;
    ai61._setClaude(async (system) => (/^You sort one WhatsApp message from the Cartrends sales desk/.test(system) ? answer61 : { intent: 'other' }));
    try {
      answer61 = { kind: 'track', orderId: '639' };
      const byModel61 = await say61('order number 639 ka delivery ka kya scene hai');
      check('a desk question no pattern knows is sorted by the model and answered', /Rahul Thakur/.test(byModel61));
      answer61 = { kind: 'track', orderId: '999' };
      check('...but an order number the model made up is never looked up', (await lookup61.classifyDesk('kal wala order kidhar hai bhai')) === null);
      answer61 = { kind: 'track', orderId: '639' };
      check('...and a message with no desk word never reaches the model', (await lookup61.classifyDesk('16510M65L10 50 pcs')) === null);
    } finally {
      ai61._setClaude(null);
      config.ai.apiKey = keyWas61;
    }
  } finally {
    customer.transport.sendDocument = sendDocWas61;
    portal._setMockLookups({});
  }
  reset37();

  // 14 Sep, founder, a salesman's list as it was typed in a customer group:
  // "26300_02752 40 pcs" and "16510m68k10.48 pcs". "order aise bhi bhej skte
  // hai... 1:1 mai thik kr do" - and the same in a group.
  console.log('\n[62] "26300_02752 40 pcs" and "16510m68k10.48 pcs", in a DM and in a group');
  const ai62 = require('../src/core/ai');
  check('an underscore between two digit groups joins them', ai62.normalizeOrderText('26300_02752 40 pcs') === '2630002752 40 pcs');
  check('an underscore in a part with letters reads as its hyphen', ai62.normalizeOrderText('43430_0K021 2') === '43430-0K021 2');
  check('a full stop between a part and its quantity reads as a space', ai62.normalizeOrderText('16510m68k10.48 pcs') === '16510m68k10 48 pcs');
  check('amounts and bill numbers are left alone', ai62.normalizeOrderText('₹52.8 and 1100.10 and Bill no 2565') === '₹52.8 and 1100.10 and Bill no 2565');
  portal.setMockStock([
    { part_no: '2630002752', name: 'FILTER ASSY-ENGINE OIL | HYUNDAI', quantity: 50, price: 80, mrp: 112, vendor: 'BIJWASAN WAREHOUSE' },
    { part_no: '16510M68K10', name: 'OIL FILTER', quantity: 60, price: 70, mrp: 105, vendor: 'BIJWASAN WAREHOUSE' },
  ]);
  reset37();
  await dm(customer, CUST, '16510m68k10.48 pcs');
  check('DM: "16510m68k10.48 pcs" is 48 of 16510M68K10', qtyOf37('16510M68K10') === 48);
  await dm(customer, CUST, '26300_02752 40 pcs');
  check('DM: "26300_02752 40 pcs" is 40 of 2630002752', qtyOf37('2630002752') === 40);
  reset37();
  resetG38();
  await group(customer, GC38, '16510m68k10.48 pcs');
  await group(customer, GC38, '26300_02752 40 pcs');
  check('group: the same two lines are 48 and 40', qtyOf37('16510M68K10', G38) === 48 && qtyOf37('2630002752', G38) === 40);
  resetG38();
  reset37();


  // ---- 63. a number plate is a CAR, not a part ----
  // "DL7CW1692" satisfies every test for a part number — letters, digits,
  // nine characters — so before integrations/vahan existed it went to the
  // portal, found nothing, and reached a person as an unknown part.
  console.log('\n[63] a number plate names the car, and the car narrows the search');
  const vahan63 = require('../src/integrations/vahan');
  const vehicle63 = require('../src/core/vehicle');
  const partish63 = require('../src/core/partish');
  vahan63.setMockVehicles({
    DL7CW1692: { maker: 'MARUTI SUZUKI INDIA LTD', model: 'INVICTO ZETA PLUS 7S', fuel: 'PETROL/HYBRID', year: '2024' },
    HR26DQ5551: { maker: 'MARUTI SUZUKI INDIA LTD', model: 'SWIFT VXI', fuel: 'PETROL', year: '2018' },
  });

  check('a plate is read however it is typed',
    vahan63.plateIn('DL7CW1692') === 'DL7CW1692' &&
    vahan63.plateIn('DL 7 CW 1692') === 'DL7CW1692' &&
    vahan63.plateIn('dl-7-cw-1692') === 'DL7CW1692' &&
    vahan63.plateIn('22BH1234AA') === '22BH1234AA');
  check('...and found inside a sentence', vahan63.plateIn('is gaadi ka bumper chahiye DL7CW1692') === 'DL7CW1692');
  check('...but only the bare plate counts as "this is my car"',
    vahan63.isOnlyPlate('DL7CW1692') === true && vahan63.isOnlyPlate('is gaadi ka bumper DL7CW1692') === false);

  // THE REGRESSION THIS EXISTS FOR, both ways round.
  check('a part number is never read as a plate',
    ['23820M79J20', '16510M65L10', '92402C4000', '72421M68P01', 'BP-1001', 'ACG-R134']
      .every((p) => vahan63.plateIn(p) === null));
  check('a plate is never read as a part number',
    ['DL7CW1692', 'HR26DQ5551', 'MH12AB1234'].every((p) => partish63.isPartNumber(p) === false));
  check('...and real part numbers still are',
    ['23820M79J20', '16510M65L10', '41800M79G00'].every((p) => partish63.isPartNumber(p) === true));

  const car63 = await vahan63.lookup('DL 7 CW 1692');
  check('the plate resolves to a car', Boolean(car63) && /INVICTO/i.test(car63.model) && car63.plate === 'DL7CW1692');
  check('...described for a human, not shouted from the registry', vahan63.describe(car63) === 'Maruti Suzuki Invicto Zeta Plus 7S (2024, Petrol/Hybrid)');
  check('an unknown plate is not invented', (await vahan63.lookup('MH12AB1234')) === null);

  vehicle63.remember('sim-car63', car63);
  check('the car is remembered for the chat', (vehicle63.get('sim-car63') || {}).model === 'INVICTO ZETA PLUS 7S');
  // Brand and nameplate only: part names carry "MARUTI ... INVICTO", never
  // "ZETA PLUS 7S", and the portal search requires EVERY extra word.
  check('the search is narrowed to the brand and nameplate', vehicle63.narrow('sim-car63', 'bumper') === 'bumper MARUTI INVICTO');
  check('...the car is not named twice', vehicle63.narrow('sim-car63', 'invicto bumper') === 'invicto bumper MARUTI');
  check('...and another chat gets nothing added', vehicle63.narrow('sim-car63-other', 'bumper') === 'bumper');
  // Only the car is kept. An RC record carries the owner's name and address
  // and none of it belongs in state.json.
  check('no owner details are stored', Object.keys(vehicle63.get('sim-car63')).sort().join(',') === 'fuel,maker,model,plate,variant,year');
  vehicle63.clear('sim-car63');


  // ---- 64. opening an account, one question at a time ----
  // The paper form says "filled by the sales person, goes to Sales Head for
  // approval". This is that form asked in chat — and the approval stays,
  // because the fields it gates are credit and discount.
  console.log('\n[64] a new customer, asked for one question at a time');
  const cc64 = require('../src/core/customerCreate');
  const cfg64 = require('../src/config').creation;
  const hadAppr64 = cfg64.approvers;
  cfg64.approvers = { 919999492550: 'Prateek Sir' };
  const t64 = (en, hi) => hi || en;
  const CH64 = 'sim-create64';

  // Asking for it in words. "Create coustomer" was searched in the
  // catalogue and answered with sixty headlight restorers, because nothing
  // knew the phrase meant anything. Spellings are loose because that is how
  // it arrives.
  check('the form can be asked for, however it is spelt',
    ['Create coustomer', 'create customer', 'account bana do', 'naya account chahiye', 'customer banana hai', 'khata khol do']
      .every((s) => cc64.wantsToStart(s)));
  check('...but a question ABOUT an account does not open one',
    ['account balance kitna hai', 'mera khata dekho', 'account statement bhejo', 'customer ka bakaya']
      .every((s) => cc64.wantsToStart(s) === false));
  check('...and a part is never mistaken for it',
    ['16510M65L10', 'headlight restorer', 'bumper chahiye', '2 pcs brake pad'].every((s) => cc64.wantsToStart(s) === false));

  // The register is STUBBED for the whole section: a live lookup is metered
  // and gstinapi.in being reachable must never decide whether the suite
  // passes.
  const gst64 = require('../src/integrations/gst');
  const lookupWas64 = gst64.lookup;
  const enabledWas64 = gst64.enabled;
  const FIRM64 = {
    gstin: '33AAACC1206D1ZN', name: 'CENTRAL WAREHOUSING CORPORATION', legalName: 'CENTRAL WAREHOUSING CORPORATION',
    status: 'Active', address: 'No.4, North Avenue, Saidapet', city: 'Chennai', state: 'Tamil Nadu', pin: '600015',
    businessType: 'Government Department',
  };
  let a64;
  try {
    gst64.enabled = () => true;
    gst64.lookup = async (g) => (cc64._internals.GSTIN_RE.test(String(g)) ? FIRM64 : { error: 'shape' });

    cc64.cancel(CH64);
    const open64 = cc64.start(CH64, '917355374975', t64);
    // GSTIN FIRST, and it is now the CONDITION for opening an account here,
    // not a shortcut: it is the only field that proves the firm exists.
    check('the form opens on the GST number', /GST/i.test(open64) && Boolean(cc64.pending(CH64)));

    const say64 = (txt, extra) => cc64.answer(CH64, extra || {}, txt, t64);
    check('a verified GSTIN is taken', /CENTRAL WAREHOUSING/.test((await say64('33AAACC1206D1ZN')).reply));

    const pre64 = cc64.pending(CH64).answers;
    check('...and the firm, address, city, state and PIN come from the register',
      pre64.name === FIRM64.name && pre64.city === 'Chennai' && pre64.state === 'Tamil Nadu'
      && pre64.pin === '600015' && /Saidapet/.test(pre64.address));
    // Characters 3-12 of a GSTIN ARE the PAN. Reading it is not a guess.
    check('...the PAN is read off the GSTIN, never asked', pre64.panNo === 'AAACC1206D');
    check('...and it is marked verified', pre64.gstVerified === true);
    // "Government Department" is a legal constitution, NOT the
    // retailer/wholesaler/garage/fleet the sales desk means. Filling the
    // trade channel with it would put a wrong word on every account.
    check('...but the GST constitution is never used as the business type',
      pre64.businessType === undefined && pre64.constitution === 'Government Department');

    check('the first question asked is the one GST cannot answer', /Business type/i.test(cc64.FIELDS[cc64.pending(CH64).idx].ask[1]));
    await say64('retailer');
    check('the contact person is followed by their phone', /phone number/i.test((await say64('Rakesh Sharma')).reply));
    check('...which must be a real mobile', /mobile number nahi/i.test((await say64('12').reply || '')) || /mobile number nahi/i.test((await say64('12')).reply));
    // "same" is the common case: the owner is the contact.
    check('..."same" means the number they are writing from', /[Ee]mail/.test((await say64('same')).reply)
      && cc64.pending(CH64).answers.contactPhone === '917355374975');
    // The email is NOT optional any more: every invoice goes to it.
    check('the email cannot be skipped', /Email/i.test((await say64('skip')).reply));
    check('...and must look like one', /theek nahi/i.test((await say64('rakesh at gmail')).reply));
    check('...and is lower-cased', /[Pp]hoto/.test((await say64('Rakesh@Sharma.COM')).reply)
      && cc64.pending(CH64).answers.email === 'rakesh@sharma.com');

    // THE PHOTO IS ASKED BEFORE THE PIN, because it may answer it.
    check('a photo is required, words will not do', /Photo bhejiye/i.test((await say64('koi photo nahi hai')).reply));
    check('...and a plain photo still leaves the pin to ask for',
      /location bhej/i.test((await say64('', { mediaBase64: 'QUJD', mediaMime: 'image/jpeg' })).reply));
    // Typed coordinates are how a shop ends up in the sea.
    check('typed coordinates are refused, the pin is asked for', /Location attach/i.test((await say64('28.6139, 77.2090')).reply));

    const done64 = await say64('', { location: { lat: 28.61, lng: 77.2 } });
    const final64 = done64.done ? done64 : await say64('skip');
    check('the form completes', final64.done === true);
    // Six fields the customer never typed: firm, address, city, state, PIN
    // and PAN were all answered by the GSTIN.
    check('...and the customer was never asked what the register knows',
      final64.form.fromGst.length === 6);

    a64 = final64.form.answers;
    check('the commercial terms are NOT asked of the customer', a64.creditDays === cfg64.defaultCreditDays && a64.creditLimit === cfg64.defaultCreditLimit);
    check('...and the mobile is the number they wrote from', a64.phone === '917355374975');
    const sum64 = cc64.summary(final64.form, t64);
    check('the approver sees the whole form', /CENTRAL WAREHOUSING/.test(sum64) && /33AAACC1206D1ZN \(verified\)/.test(sum64) && /28\.61/.test(sum64));
    check('...and is not shown a contact phone that is just the same number', /Contact phone/.test(sum64) === false);
    check('...and is told how to answer', /OK WA-/.test(sum64));

    // Only a Sales Head may say yes.
    check('an approver is recognised', cc64.isApprover('919999492550') === true);
    check('...and anyone else is not', cc64.isApprover('919888888888') === false);
    const dec64 = cc64.readDecision('OK ' + a64.requestId);
    check('a decision is read', Boolean(dec64) && dec64.yes === true && dec64.requestId === a64.requestId);
    check('...and a rejection too', cc64.readDecision('NO ' + a64.requestId).yes === false);
    check('...while a bare part number is not a decision', cc64.readDecision('16510M65L10') === null);

    cc64.park(final64.form);
    check('a parked request can be found by its id', Boolean(cc64.parked(a64.requestId)));
    check('...and is no longer an open form', cc64.pending(CH64) === null);

    const acct64 = require('../src/core/dataEntryRequests').buildAccount({ ...a64, kind: 'customer' });
    check('the username follows the house rule', acct64.username === 'central_warehousing_corporation');
    check('...and the password does too', acct64.password === 'rakesh@123');

    // ---- a GSTIN that will not verify ----
    // The account is NOT opened and the customer is NOT left on the form.
    // It goes to the Sales Heads, who decide whether a person opens it.
    gst64.lookup = async () => ({ error: 'notfound' });
    const CHBAD = 'sim-create64-bad';
    cc64.cancel(CHBAD);
    cc64.start(CHBAD, '917355374975', t64);
    const bad1 = await cc64.answer(CHBAD, {}, '07AABCU9603R1ZM', t64);
    check('a GSTIN not on the register is refused', /nahi mila/i.test(bad1.reply) && bad1.review !== true);
    check('...and the customer is told how many tries are left', /2 koshish/i.test(bad1.reply));
    check('...and the bad number is not kept', cc64.pending(CHBAD).answers.gstNo === undefined);
    await cc64.answer(CHBAD, {}, '07AABCU9603R1ZM', t64);
    const bad3 = await cc64.answer(CHBAD, {}, '07AABCU9603R1ZM', t64);
    check('the third failure stops the form', bad3.review === true && cc64.pending(CHBAD) === null);
    check('...and nothing is created', bad3.form.answers.kind === 'gst-review');
    const rev64 = cc64.summary(bad3.form, t64);
    check('the Sales Heads are told what went wrong', /GST not verified/.test(rev64) && /not on the GST database/.test(rev64));
    check('...and which numbers were tried', /07AABCU9603R1ZM/.test(rev64));
    check('...and how to answer', /OK WA-/.test(rev64) && /NO WA-/.test(rev64));

    // A wrong SHAPE never reaches the register, so it never costs a credit.
    gst64.lookup = lookupWas64;
    const CHSHAPE = 'sim-create64-shape';
    cc64.cancel(CHSHAPE);
    cc64.start(CHSHAPE, '917355374975', t64);
    const shape64 = await cc64.answer(CHSHAPE, {}, '12345', t64);
    check('a malformed GSTIN is refused without a lookup', /15 character/i.test(shape64.reply));

    // A cancelled registration is not a typo. There is nothing to try
    // again, so it goes to a person at once.
    gst64.lookup = async () => ({ ...FIRM64, status: 'Cancelled' });
    const CHDEAD = 'sim-create64-dead';
    cc64.cancel(CHDEAD);
    cc64.start(CHDEAD, '917355374975', t64);
    const dead64 = await cc64.answer(CHDEAD, {}, '33AAACC1206D1ZN', t64);
    check('a cancelled GSTIN stops the form on the first try', dead64.review === true);
    check('...and says so to the approver', /Cancelled/.test(cc64.summary(dead64.form, t64)));
    check('...and the dead number is never stored', dead64.form.answers.gstNo === undefined);

    // "I have no GST." Not an argument to have with a customer.
    const CHNONE = 'sim-create64-none';
    cc64.cancel(CHNONE);
    cc64.start(CHNONE, '917355374975', t64);
    const none64 = await cc64.answer(CHNONE, {}, 'skip', t64);
    check('a customer with no GST is handed to a person, not refused', none64.review === true && none64.form.answers.gstProblem === 'no-gst');

    // The register being down is OUR problem. The account still cannot be
    // opened unverified, but the customer does not argue with a form.
    gst64.lookup = async () => null;
    const CHDOWN = 'sim-create64-down';
    cc64.cancel(CHDOWN);
    cc64.start(CHDOWN, '917355374975', t64);
    const down64 = await cc64.answer(CHDOWN, {}, '33AAACC1206D1ZN', t64);
    check('the register being unreachable goes straight to a person', down64.review === true && down64.form.answers.gstProblem === 'unavailable');

    // ---- the Sales Head waives it ----
    cc64.park(down64.form);
    const waived64 = cc64.resumeWithoutGst(cc64.parked(down64.form.answers.requestId), t64);
    check('a waiver reopens the form in the customer chat', Boolean(cc64.pending(CHDOWN)));
    check('...at the firm name, since GST answered nothing', /naam/i.test(waived64));
    check('...and the account is marked NOT verified', cc64.pending(CHDOWN).answers.gstVerified === false);
    check('...with the waiver it was opened under', cc64.pending(CHDOWN).answers.gstWaiver === down64.form.answers.requestId);
    cc64.unpark(down64.form.answers.requestId);

    [CHBAD, CHSHAPE, CHDEAD, CHNONE, CHDOWN].forEach((c) => cc64.cancel(c));
  } finally {
    gst64.lookup = lookupWas64;
    gst64.enabled = enabledWas64;
  }
  // ---- the Sales Head swipes "already created" onto the summary ----
  // 22 Sep, live: "Ye toh already created hai" was neither OK nor NO, got
  // "koi order pending nahi hai", and the customer never heard a word.
  {
    const RID = 'WA-SMOKE64X';
    cc64.park({ chatId: 'sim-create64-dup', answers: { requestId: RID, phone: '917355374975', name: 'KALRA MOTORS' } });
    cc64.noteSummary('wamid.smoke64dup', RID);
    const sentDup = [];
    const botDup = Object.create(customer);
    botDup.transport = { sendText: async (to, text) => { sentDup.push({ to, text }); return 'wamid.x'; } };
    const replyDup = async (text) => { sentDup.push({ to: 'approver', text }); return true; };
    const tDup = (en, hi) => hi;
    const mDup = { chatId: '919999492550@c.us', from: '919999492550', contextId: 'wamid.smoke64dup', body: 'Ye toh already created hai' };
    const rid = cc64.requestForMessage(mDup.contextId);
    check('a swipe onto the summary finds its request', rid === RID);
    await botDup.noteOnNewCustomer(mDup, rid, mDup.body, replyDup, tDup);
    check('..."already created" closes it', cc64.parked(RID) === null);
    check('...the customer is told they already have an account', sentDup.some((x) => x.to === '917355374975' && /pehle se/.test(x.text)));
    check('...and the approver is told it was done', sentDup.some((x) => x.to === 'approver' && /band kar diya/.test(x.text)));

    cc64.park({ chatId: 'sim-create64-dup', answers: { requestId: RID, phone: '917355374975', name: 'KALRA MOTORS' } });
    sentDup.length = 0;
    await botDup.noteOnNewCustomer(mDup, RID, 'ek baar call karke dekho', replyDup, tDup);
    check('any other note leaves the request waiting', Boolean(cc64.parked(RID)));
    check('...is not passed to the customer', sentDup.every((x) => x.to === 'approver'));
    check('...and asks the approver for OK / NO', sentDup.some((x) => /OK WA-SMOKE64X/.test(x.text)));
    check('an id typed in the text is found too', cc64.requestIdIn('wa-smoke64x pehle se hai') === RID);
    cc64.unpark(RID);
  }
  cc64.unpark(a64.requestId);
  cfg64.approvers = hadAppr64;


  // ---- 65. a photo of the CAR, not of a part ----
  // 21 Sep, live: a customer photographed their car. Vision found no part
  // number, so the picture went to the helper as "could not read the part
  // number" — a person was sent a photo of a car and asked to find a part
  // nobody had named. The registration plate in it is the answer.
  console.log('\n[65] a photo with a number plate is a car, not an unreadable part');
  const media65 = require('../src/pipeline/media');
  const ai65 = require('../src/core/ai');
  const vahan65 = require('../src/integrations/vahan');
  const vehicle65 = require('../src/core/vehicle');
  vahan65.setMockVehicles({ DL7CW1692: { maker: 'MARUTI SUZUKI INDIA LTD', model: 'INVICTO ZETA PLUS 7S', fuel: 'PETROL', year: '2024' } });

  const parseWas65 = ai65.parseOrderImage;
  const CH65 = 'sim-919000006500';
  const sent65 = [];
  const bot65 = {
    key: 'customer',
    transport: { sendText: async (to, text) => sent65.push({ to, text }) },
    processOrderLines: async () => true,
  };
  const reply65 = async (text) => { sent65.push({ to: CH65, text }); return true; };
  const m65 = { chatId: CH65, from: '919000006500', body: '', mediaType: 'image', mediaBase64: 'QUJD', mediaMime: 'image/jpeg' };

  try {
    // Vision reads no part, but does read the plate off the car.
    const withPlate = [];
    withPlate.plate = 'DL7CW1692';
    ai65.parseOrderImage = async () => withPlate;
    sent65.length = 0;
    await media65.handleMedia(bot65, m65, reply65, (en) => en);
    check('the car is named back to the customer', /INVICTO/i.test(sent65.map((x) => x.text).join(' ')));
    check('...nothing is sent to the helper', sent65.every((x) => x.to === CH65));
    check('...and the car is remembered for the next question', (vehicle65.get(CH65) || {}).model === 'INVICTO ZETA PLUS 7S');
    check('...so "bumper" searches that car', vehicle65.narrow(CH65, 'bumper') === 'bumper MARUTI INVICTO');

    // A plate we cannot resolve is still not a question for a person.
    vehicle65.clear(CH65);
    const unknownPlate = [];
    unknownPlate.plate = 'HR26DQ5551';
    ai65.parseOrderImage = async () => unknownPlate;
    sent65.length = 0;
    await media65.handleMedia(bot65, m65, reply65, (en) => en);
    check('an unresolvable plate is read back, not escalated',
      /HR26DQ5551/.test(sent65.map((x) => x.text).join(' ')) && sent65.every((x) => x.to === CH65));
  } finally {
    ai65.parseOrderImage = parseWas65;
    vehicle65.clear(CH65);
  }



  // ---- 66. what the form must not let through ----
  // Everything in this section was asked for on 22 Sep after the first
  // real accounts were opened: a duplicate is refused by the portal at the
  // create, which is far too late; a photo of a car is not a shop; and the
  // person typing is not always the person being registered.
  console.log('\n[66] duplicates, the camera, and opening an account for somebody else');
  const cc66 = require('../src/core/customerCreate');
  const gst66 = require('../src/integrations/gst');
  const portal66 = require('../src/integrations/dealerPortal');
  const ai66 = require('../src/core/ai');
  const cfg66 = require('../src/config').creation;
  const t66 = (en, hi) => hi || en;
  const FIRM66 = {
    gstin: '33AAACC1206D1ZN', name: 'CENTRAL WAREHOUSING CORPORATION', legalName: 'CENTRAL WAREHOUSING CORPORATION',
    status: 'Active', address: 'No.4, North Avenue, Saidapet', city: 'Chennai', state: 'Tamil Nadu', pin: '600015',
  };
  const gstWas66 = gst66.lookup;
  const enabledWas66 = gst66.enabled;
  const shopWas66 = ai66.readShopPhoto;
  const teamWas66 = cfg66.team;
  try {
    gst66.enabled = () => true;
    gst66.lookup = async () => FIRM66;
    ai66.readShopPhoto = async () => null; // no vision model: nobody looked

    // ---- a GSTIN the portal already holds ----
    // The portal refuses a duplicate at the create - after the customer has
    // answered everything and a Sales Head has approved it. Asking here
    // turns a dead end into "send a different one".
    portal66._setMockDuplicates([{ gstNo: '33AAACC1206D1ZN', name: 'Existing Traders' }]);
    const CHD = 'sim-create66-dup';
    cc66.cancel(CHD);
    cc66.start(CHD, '917355374975', t66);
    let paid66 = 0;
    const countWas66 = gst66.lookup;
    gst66.lookup = async (g) => { paid66++; return countWas66(g); };
    const dup66 = await cc66.answer(CHD, {}, '33AAACC1206D1ZN', t66);
    gst66.lookup = countWas66;
    check('a GSTIN already on the portal costs no paid GST lookup', paid66 === 0);
    // A CUSTOMER is told the account exists - never whose it is - and sent
    // on to ordering. A GSTIN on the portal is an account; there is nothing
    // "different" to send.
    check('a GSTIN already on the portal tells the customer the account exists', /account pehle se bana hua hai/i.test(dup66.reply));
    check('...without saying whose it is', !/Existing Traders/.test(dup66.reply));
    check('...and the form is closed', !cc66.pending(CHD));

    // A SALES AGENT is told whose it is, so they take the order there.
    cfg66.team = { ...(teamWas66 || {}), 919811100066: 'Shubham' };
    const CHDA = 'sim-create66-dup-agent';
    cc66.cancel(CHDA);
    cc66.start(CHDA, '919811100066', t66, { forSomeoneElse: false });
    const dupA66 = await cc66.answer(CHDA, {}, '33AAACC1206D1ZN', t66);
    check('an agent entering a registered GSTIN is told whose it is', /Existing Traders ke naam se/.test(dupA66.reply));
    check('...and no new account is opened', /Naya account nahi banega/.test(dupA66.reply) && !cc66.pending(CHDA));
    cfg66.team = teamWas66;

    // 22 Sep, live: with the form open, a photo of two parts, "Ye dono part
    // kitne ka hai" and "Cancel customer creation..." were all read as GST
    // numbers - and the third "try" sent a review to both Sales Heads.
    const CHX = 'sim-create66-aside';
    cc66.cancel(CHX);
    cc66.start(CHX, '917355374975', t66);
    check('a part photo is not a GST number', (await cc66.answer(CHX, { mediaType: 'image', mediaBase64: 'QUJD', mediaMime: 'image/jpeg' }, '', t66)) === null);
    check('"Ye dono part kitne ka hai" is not a GST number', (await cc66.answer(CHX, {}, 'Ye dono part kitne ka hai', t66)) === null);
    check('...and neither costs a try: the form still waits', Boolean(cc66.pending(CHX)) && !cc66.pending(CHX).answers.gstNo);
    const quit66 = await cc66.answer(CHX, {}, 'Cancel kardo customer creation', t66);
    check('"Cancel kardo customer creation" closes the form', quit66 && quit66.quit === true && !cc66.pending(CHX));
    cc66.start(CHX, '917355374975', t66);
    const quit66b = await cc66.answer(CHX, {}, 'Cancel customer creation. Now tell about the parts price', t66);
    check('...and so does it said in a sentence', quit66b && quit66b.quit === true && !cc66.pending(CHX));

    // Every GST lookup is a paid credit. The same GSTIN asked twice in a day
    // is answered from the first lookup.
    {
      const gcfg = require('../src/config').gst;
      const keyWas = gcfg.apiKey;
      const fetchWas = global.fetch;
      let calls = 0;
      gcfg.apiKey = 'smoke';
      global.fetch = async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ success: true, data: { gstin: '27AAPFU0939F1ZV', trade_name: 'CACHE TEST MOTORS', status: 'Active' } }) };
      };
      try {
        const a = await gstWas66('27AAPFU0939F1ZV');
        const b = await gstWas66('27AAPFU0939F1ZV');
        check('a GSTIN looked up twice is paid for once', calls === 1 && a && b && b.name === 'CACHE TEST MOTORS');
      } finally {
        gcfg.apiKey = keyWas;
        global.fetch = fetchWas;
      }
    }

    // ---- email: mandatory, and unverifiable ----
    // There is no route on the portal that takes an email and no email in
    // the customer list, so it CANNOT be checked. That is recorded rather
    // than passed off as clear.
    portal66._setMockDuplicates([]);
    const CHE = 'sim-create66-email';
    cc66.cancel(CHE);
    cc66.start(CHE, '917355374975', t66);
    await cc66.answer(CHE, {}, '33AAACC1206D1ZN', t66);
    await cc66.answer(CHE, {}, 'retailer', t66);
    await cc66.answer(CHE, {}, 'Rakesh Sharma', t66);
    await cc66.answer(CHE, {}, 'same', t66);
    const skipped66 = await cc66.answer(CHE, {}, 'skip', t66);
    check('the email cannot be skipped', /Email/i.test(skipped66.reply) && cc66.pending(CHE).answers.email === undefined);
    await cc66.answer(CHE, {}, 'shop@example.com', t66);
    check('...and the approver is told it could not be checked',
      (cc66.pending(CHE).notChecked || []).includes('email'));

    // ---- a contact number that is not theirs ----
    const CHC = 'sim-create66-contact';
    cc66.cancel(CHC);
    cc66.start(CHC, '917355374975', t66);
    await cc66.answer(CHC, {}, '33AAACC1206D1ZN', t66);
    await cc66.answer(CHC, {}, 'retailer', t66);
    await cc66.answer(CHC, {}, 'Rakesh Sharma', t66);
    portal66._setMockDuplicates([{ phone: '919876543210', name: 'Someone Else' }]);
    const cdup66 = await cc66.answer(CHC, {}, '9876543210', t66);
    check('a contact number already on the portal is refused', /pehle se hamare paas registered/i.test(cdup66.reply));
    portal66._setMockDuplicates([]);
    await cc66.answer(CHC, {}, '9811122233', t66);
    check('...and a free one is taken, with the 91 put on', cc66.pending(CHC).answers.contactPhone === '919811122233');

    // ---- the photograph ----
    // A selfie is not a shop and a shop with no board cannot be tied to the
    // name on the GST certificate. Asked once more, then accepted anyway:
    // an account must not die on a camera angle.
    const CHP = 'sim-create66-photo';
    const toPhoto = async (ch) => {
      cc66.cancel(ch);
      cc66.start(ch, '917355374975', t66);
      await cc66.answer(ch, {}, '33AAACC1206D1ZN', t66);
      await cc66.answer(ch, {}, 'retailer', t66);
      await cc66.answer(ch, {}, 'Rakesh Sharma', t66);
      await cc66.answer(ch, {}, 'same', t66);
      await cc66.answer(ch, {}, 'shop@example.com', t66);
    };
    ai66.readShopPhoto = async () => ({ isShop: false, hasBanner: false, bannerText: null, why: 'a person indoors' });
    await toPhoto(CHP);
    const notShop = await cc66.answer(CHP, { mediaBase64: 'QUJD', mediaMime: 'image/jpeg' }, '', t66);
    check('a photo that is not a shop is sent back', /shop ki photo nahi/i.test(notShop.reply));
    const notShop2 = await cc66.answer(CHP, { mediaBase64: 'QUJD', mediaMime: 'image/jpeg' }, '', t66);
    check('...but asking twice is enough', /location bhej/i.test(notShop2.reply));
    check('...and the approver is told what the picture looked like',
      cc66.pending(CHP).answers.photoNote === 'does not look like a shop');

    ai66.readShopPhoto = async () => ({ isShop: true, hasBanner: false, bannerText: null, why: 'no board' });
    await toPhoto(CHP);
    check('a shop with no visible board is sent back',
      /[Bb]oard nahi dikh raha/.test((await cc66.answer(CHP, { mediaBase64: 'QUJD', mediaMime: 'image/jpeg' }, '', t66)).reply));

    ai66.readShopPhoto = async () => ({ isShop: true, hasBanner: true, bannerText: 'SHARMA AUTO PARTS', why: 'board reads' });
    await toPhoto(CHP);
    const good66 = await cc66.answer(CHP, { mediaBase64: 'QUJD', mediaMime: 'image/jpeg' }, '', t66);
    check('a shop with its board is taken', /location bhej/i.test(good66.reply));
    check('...and what the board says is kept for the approver',
      cc66.pending(CHP).answers.bannerText === 'SHARMA AUTO PARTS');

    // ---- the camera answering the question after it ----
    // A photo taken at the shop often carries the camera's GPS fix. When it
    // does, asking for a pin as well is asking for something we hold.
    // (Usually it does NOT: WhatsApp strips EXIF from anything sent as a
    // photo. It survives when the picture is sent as a document.)
    const gpsJpeg = makeGpsJpeg(28.6139, 77.209, 'N', 'E').toString('base64');
    await toPhoto(CHP);
    const fromExif = await cc66.answer(CHP, { mediaBase64: gpsJpeg, mediaMime: 'image/jpeg' }, '', t66);
    check('a GPS-tagged photo answers the location too', /[Pp]hoto se hi location/.test(fromExif.reply));
    const exifAns = (cc66.pending(CHP) || { answers: fromExif.form.answers }).answers;
    check('...with the fix off the camera', Math.abs(exifAns.lat - 28.6139) < 0.001 && Math.abs(exifAns.lng - 77.209) < 0.001);
    check('...noted as coming from the photo, not a dropped pin', exifAns.locationFrom === 'photo');
    check('...and the pin is never asked for', /location bhej/i.test(fromExif.reply) === false);

    // ---- an account for somebody else ----
    cfg66.team = { 919873261929: 'Shubham' };
    check('the button and the words both open it',
      cc66.wantsSomeoneElse('CREATE_FOR_OTHER') && cc66.wantsSomeoneElse('kisi aur ka'));
    check('...and a part number does not', cc66.wantsSomeoneElse('16510M65L10') === false);
    check('a colleague on the creation team is known by name', cc66.agentName('919873261929') === 'Shubham');
    check('...and a customer is not', cc66.agentName('917355374975') === null);

    const CHO = 'sim-create66-other';
    cc66.cancel(CHO);
    const openOther = cc66.start(CHO, '919873261929', t66, { forSomeoneElse: true });
    check('opening one for someone else asks whose it is first', /[Kk]iska account/.test(openOther));
    portal66._setMockDuplicates([{ phone: '919999888777', name: 'Already Here' }]);
    check('...and a number already on the portal is refused there too',
      /pehle se hamare paas registered/i.test((await cc66.answer(CHO, {}, '9999888777', t66)).reply));
    portal66._setMockDuplicates([]);
    const afterNum = await cc66.answer(CHO, {}, '9812345678', t66);
    check('...then it carries on to the GST number', /GST number/i.test(afterNum.reply));
    const oAns = cc66.pending(CHO).answers;
    check('...the account belongs to THAT number, not the agent', oAns.phone === '919812345678');
    check('...and the portal is told which agent opened it', oAns.createdByName === 'Shubham');

    // A customer registering themselves has no agent, and their own name
    // must not be written into the portal's sales-representative field.
    const CHS = 'sim-create66-self';
    cc66.cancel(CHS);
    cc66.start(CHS, '917355374975', t66);
    check('a customer registering themselves has no agent on the account',
      cc66.pending(CHS).answers.createdByName === undefined);

    [CHD, CHE, CHC, CHP, CHO, CHS].forEach((c) => cc66.cancel(c));
  } finally {
    gst66.lookup = gstWas66;
    gst66.enabled = enabledWas66;
    ai66.readShopPhoto = shopWas66;
    cfg66.team = teamWas66;
    portal66._setMockDuplicates([]);
  }


  console.log(
    failures === 0
      ? '\n✅ ALL CHECKS PASSED\n'
      : `\n❌ ${failures} CHECK(S) FAILED\n`
  );
  try {
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});

// A JPEG carrying nothing but an EXIF GPS fix, built rather than checked
// in, so the EXIF reader is tested against real bytes.
function rational(n, d) { const b = Buffer.alloc(8); b.writeUInt32BE(n, 0); b.writeUInt32BE(d, 4); return b; }
function toDms(v) {
  const d = Math.floor(v), mF = (v - d) * 60, m = Math.floor(mF), s = Math.round((mF - m) * 60 * 100);
  return Buffer.concat([rational(d, 1), rational(m, 1), rational(s, 100)]);
}
function makeGpsJpeg(lat, lng, latRef, lonRef) {
  const gpsEntries = [
    [1, 2, 2, Buffer.from(latRef + '\0', 'latin1')],
    [2, 5, 3, toDms(lat)],
    [3, 2, 2, Buffer.from(lonRef + '\0', 'latin1')],
    [4, 5, 3, toDms(lng)],
  ];
  const ifd0Off = 8, ifd0Len = 2 + 12 + 4, gpsOff = ifd0Off + ifd0Len;
  const gpsLen = 2 + gpsEntries.length * 12 + 4;
  let dataOff = gpsOff + gpsLen; const datas = []; const bufs = [];
  for (const [tag, type, count, val] of gpsEntries) {
    const e = Buffer.alloc(12); e.writeUInt16BE(tag, 0); e.writeUInt16BE(type, 2); e.writeUInt32BE(count, 4);
    if (val.length <= 4) val.copy(e, 8); else { e.writeUInt32BE(dataOff, 8); datas.push(val); dataOff += val.length; }
    bufs.push(e);
  }
  const ifd0 = Buffer.alloc(ifd0Len); ifd0.writeUInt16BE(1, 0);
  ifd0.writeUInt16BE(0x8825, 2); ifd0.writeUInt16BE(4, 4); ifd0.writeUInt32BE(1, 6); ifd0.writeUInt32BE(gpsOff, 10);
  const gpsHead = Buffer.alloc(2); gpsHead.writeUInt16BE(gpsEntries.length, 0);
  const head = Buffer.alloc(8); head.write('MM', 0, 'latin1'); head.writeUInt16BE(42, 2); head.writeUInt32BE(ifd0Off, 4);
  const tiff = Buffer.concat([head, ifd0, gpsHead, ...bufs, Buffer.alloc(4), ...datas]);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xFF; seg[1] = 0xE1; seg.writeUInt16BE(app1.length + 2, 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), seg, app1, Buffer.from([0xFF, 0xD9])]);
}
