#!/usr/bin/env node
'use strict';
// ASKING FOR A DISCOUNT HAS TO START THE SETUP.
//
// Live, 24 Sep: "mera discount setup kardo" did not match, so it fell through
// to small talk and was answered "seniors se confirm karke bataunga" — a
// sentence promising a callback nobody had been asked to make. Nothing was
// filed, no approver was told, and the customer believed it was in hand.
//
// The hole was "\bset\b", which does not match "setup": \b needs a non-word
// character after "set", and "u" is one.
//
// The opposite mistake matters just as much. "discount kitna hai" is a
// QUESTION. Starting a nine-question setup on it would answer nothing they
// asked and take over the conversation — and "chahiye" being a trigger makes
// that easy to trip.
//
//   npm run test:discount
const path = require('path');
const os = require('os');
process.env.SCRATCH = process.env.SCRATCH || path.join(os.tmpdir(), 'autoflow-discount-test');
require('fs').mkdirSync(process.env.SCRATCH, { recursive: true });
require('fs').writeFileSync(path.join(process.env.SCRATCH, 'state.json'), '{}');
process.env.DATA_DIR = process.env.SCRATCH;
// The MOCK portal, always: .env names the live one, and dotenv never
// overrides a variable already set. Without this the punch test below read
// the live discount rules and accounts.
process.env.DEALER_PORTAL_BASE_URL = '';

const d = require('../src/core/discountSetup');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''));
  }
};

console.log('\nASKING FOR ONE STARTS THE SETUP\n');
for (const say of [
  'mera discount setup kardo', // the live miss
  'Create discount setup', // live, 25 Sep — went to the agent and got "our specialist will confirm"
  'create discount',
  'make a discount for me',
  'discount rule add karna hai',
  'discount shuru karo',
  'mera discount set up kar do',
  'discount setup karo',
  'discount setup',
  'mujhe discount chahiye',
  'mera discount banao',
  'discount bana do',
  'discount laga do',
  'discount lagwana hai',
  'mera discount change karo',
  'discount badha do',
  'can you increase my discount',
  'brand wise discount update karna hai',
  'Kalra ka discount revise karo',
]) {
  ok(`"${say}"`, d.wantsSetup(say) === true);
}

console.log('\nASKING WHAT IT IS DOES NOT\n');
for (const say of [
  'discount kitna hai',
  'mera discount kitna hai',
  'discount kitna milega',
  'aapka discount policy kya hai',
  'discount kitne percent hota hai',
  'what is my discount',
  'how much discount',
]) {
  ok(`"${say}" is a question, not a request`, d.wantsSetup(say) === false, JSON.stringify(say));
}

console.log('\nORDINARY MESSAGES ARE LEFT ALONE\n');
for (const say of [
  'brake pad chahiye swift ka',
  '16510M65L10 ka rate kya hai',
  '5 piece bhej do',
  'thanks bhai',
  'order kab aayega',
]) {
  ok(`"${say}" does not start a discount setup`, d.wantsSetup(say) === false);
}

console.log('\nNOTHING REACHES THE PORTAL BEFORE APPROVAL\n');

// The order the founder asked for: collect the rule, file it, send it for
// approval — and only create it on the portal once a Sales Head says OK.
// toPortal is the ONLY thing that builds a portal payload, and it is called
// from createDiscountFor, which runs on approval. Here we assert the shape it
// would produce, without sending anything.
{
  const body = d.toPortal(
    { kind: 'brand', target: 'CARTRENDS', value: 12, minQty: 5, days: 90, requestId: 'DSC-TEST', setBy: 'test' },
    1234,
    'MIYA JI MOTORS',
    new Date('2026-09-24T00:00:00Z'),
  );
  ok('the rule is built for the right dealer', body.dealer_id === 1234);
  ok('a brand rule is a BRAND rule', body.rule_type === 'BRAND' && body.brand === 'CARTRENDS' && body.part_no === null);
  ok('the percentage is carried as given', body.discount_mode === 'PERCENT' && body.discount_value === 12);
  ok('the quantity floor is carried', body.min_qty === 5);
  ok('an end date is set when a duration was given', Boolean(body.valid_to));
  ok('the rule is named after the customer the portal knows', /MIYA JI MOTORS/.test(body.rule_name), body.rule_name);
  ok('it is tagged as the bot\'s, with the request it came from', body.rule_metadata.source === 'whatsapp-bot' && body.rule_metadata.requestId === 'DSC-TEST');

  // A rule with no end date must not invent one.
  const forever = d.toPortal({ kind: 'part', target: '16510M65L10', value: 8, days: null }, 1, 'X');
  ok('"hamesha" means no end date, not a guessed one', forever.valid_to === null);
  ok('a part rule is an ITEM rule', forever.rule_type === 'ITEM' && forever.part_no === '16510M65L10' && forever.brand === null);
}

console.log('\nTHE APPROVAL MESSAGE\n');
{
  const text = d.approvalText({
    id: 'DSC-TEST',
    customer: 'MIYA JI MOTORS',
    by: 'Sales agent',
    rule: { kind: 'brand', target: 'CARTRENDS', value: 12, mrp: 799, minQty: 5, durationLabel: '3 months' },
  });
  ok('it names the request so it can be approved', /DSC-TEST/.test(text));
  ok('it shows what the customer will actually pay', /703/.test(text), text.slice(0, 120));
  ok('it asks for a decision', /OK DSC-TEST/.test(text) && /NO DSC-TEST/.test(text));
}

console.log('\nTHE RULE THAT PRICES A LINE\n');
{
  const now = new Date('2026-09-25T12:00:00Z');
  const base = { dealer_id: 8328, discount_mode: 'PERCENT', is_active: true, min_qty: 1 };
  const rules = [
    { ...base, rule_id: 1, rule_type: 'BRAND', brand: 'MARUTI', discount_value: 10, approval_status: 'PENDING', rule_metadata: { source: 'whatsapp-bot' } },
    { ...base, rule_id: 2, rule_type: 'ITEM', part_no: '35121M55RB0', discount_value: 15, approval_status: 'APPROVED' },
    { ...base, rule_id: 3, rule_type: 'BRAND', brand: 'BOSCH', discount_value: 20, approval_status: 'PENDING' }, // typed on the portal, nobody approved it
    { ...base, rule_id: 4, rule_type: 'BRAND', brand: 'MINDA', discount_value: 9, approval_status: 'APPROVED', valid_to: '2026-09-01T00:00:00' },
    { ...base, rule_id: 5, dealer_id: 1002, rule_type: 'BRAND', brand: 'MARUTI', discount_value: 12, approval_status: 'APPROVED' },
    { ...base, rule_id: 6, rule_type: 'BRAND', brand: 'LUMAX', discount_value: 7, approval_status: 'APPROVED', min_qty: 5 },
  ];
  const pick = (o) => (d.ruleFor(rules, { dealerId: 8328, now, ...o }) || {}).rule_id || null;
  ok('a MARUTI part gets the MARUTI rule the Sales Head approved on WhatsApp', pick({ partNo: '01104M12556', brand: 'MARUTI' }) === 1);
  ok('a rule for the part itself beats the brand rule', pick({ partNo: '35121M55RB0', brand: 'MARUTI' }) === 2);
  ok('a PENDING rule nobody approved does not count', pick({ partNo: 'X', brand: 'BOSCH' }) === null);
  ok('an expired rule does not count', pick({ partNo: 'X', brand: 'MINDA' }) === null);
  ok("another customer's rule does not count", d.ruleFor(rules, { dealerId: 9999, partNo: 'X', brand: 'MARUTI', now }) === null);
  ok('below the minimum quantity it does not apply', pick({ partNo: 'X', brand: 'LUMAX', qty: 2 }) === null);
  ok('at the minimum quantity it does', pick({ partNo: 'X', brand: 'LUMAX', qty: 5 }) === 6);
  // 28 Sep, live: rule #2872 said MARUTI, the brand list said MARUTI SUZUKI.
  ok('a MARUTI rule prices a MARUTI SUZUKI part', pick({ partNo: 'X', brand: 'MARUTI SUZUKI' }) === 1);
  ok('...and a Maruti-Suzuki one, however it is spelt', pick({ partNo: 'X', brand: 'Maruti-Suzuki' }) === 1);
  const suzukiRule = [{ ...base, rule_id: 7, rule_type: 'BRAND', brand: 'MARUTI SUZUKI', discount_value: 12, approval_status: 'APPROVED' }];
  ok('a MARUTI SUZUKI rule prices a MARUTI part', (d.ruleFor(suzukiRule, { dealerId: 8328, partNo: 'X', brand: 'MARUTI', now }) || {}).rule_id === 7);
  const tataRule = [{ ...base, rule_id: 8, rule_type: 'BRAND', brand: 'TATA', discount_value: 12, approval_status: 'APPROVED' }];
  ok('a TATA rule does not price a TATA AUTOCOMP part (two companies)', d.ruleFor(tataRule, { dealerId: 8328, partNo: 'X', brand: 'TATA AUTOCOMP', now }) === null);
}

console.log('\nA CHANGE, AS THE SALES HEAD READS IT\n');
{
  const text = d.approvalText({
    id: 'DSC-CHG1',
    type: 'change',
    customer: 'MIYA JI MOTORS',
    customerPhone: '917355374975',
    ruleId: 2862,
    oldName: 'MIYA JI MOTORS MARUTI 10%',
    oldValue: 10,
    oldRule: { minQty: 1, validTo: '2026-09-26T23:59:59' },
    by: 'customer (917355374975)',
    rule: { kind: 'brand', target: 'MARUTI', value: 12 },
  });
  ok('it says who is asking, with their number', /MIYA JI MOTORS \(\+917355374975\)/.test(text), text);
  ok('it says which rule', /MIYA JI MOTORS MARUTI 10%/.test(text) && /#2862/.test(text));
  ok('it says the discount now', /Current discount: \*10%\*/.test(text));
  ok('it says what they want now', /Customer wants: \*12%\* \(\+2%\)/.test(text));
  ok('it says OK only changes the %', /only the % on this rule/.test(text));
  ok('it asks for a decision', /OK DSC-CHG1/.test(text) && /NO DSC-CHG1/.test(text));
}

console.log('\nWHAT A CUSTOMER IS TOLD ABOUT STOCK\n');
{
  const { stockOf } = require('../src/agent/tools/partFacts');
  const s1 = stockOf({ source: 'available', available: 50 }, 10);
  ok('enough for their quantity is "in_stock", with no count', s1.status === 'in_stock' && s1.canSupplyNow === undefined);
  const s2 = stockOf({ source: 'available', available: 6 }, 10);
  ok('short: how many of THEIR pieces go now, and the rest', s2.status === 'short' && s2.canSupplyNow === 6 && s2.restOnOrder === 4 && s2.etaDays > 0);
  const s3 = stockOf({ source: 'unavailable', available: 0 }, 3);
  ok('none: out of stock, with when', s3.status === 'out_of_stock' && s3.etaDays > 0);
  ok('an unknown number is not called out of stock', stockOf({ source: 'unidentified' }, 1).status === 'not_recognised_by_portal');
}

console.log('\nTHEIR DISCOUNTS TODAY\n');
{
  const now = new Date('2026-09-25T12:00:00Z');
  const rules = [
    { dealer_id: 8328, rule_type: 'BRAND', brand: 'MARUTI', discount_value: 10, is_active: true, approval_status: 'PENDING', rule_metadata: { source: 'whatsapp-bot' }, valid_to: '2026-09-26T23:59:59' },
    { dealer_id: 8328, rule_type: 'ITEM', part_no: '35121M55RB0', discount_value: 15, is_active: true, approval_status: 'APPROVED', min_qty: 2 },
    { dealer_id: 8328, rule_type: 'BRAND', brand: 'BOSCH', discount_value: 20, is_active: true, approval_status: 'PENDING' },
    { dealer_id: 1002, rule_type: 'BRAND', brand: 'MARUTI', discount_value: 12, is_active: true, approval_status: 'APPROVED' },
  ];
  const mine = d.activeRules(rules, 8328, now);
  ok('both of their rules that count are listed', mine.length === 2, JSON.stringify(mine));
  ok('with what, how much and until when', mine[0].on === 'all MARUTI parts' && mine[0].percent === 10 && mine[0].validTill === '2026-09-26');
  ok('a part rule names the part and its minimum', mine[1].on === 'part 35121M55RB0' && mine[1].minQty === 2);
  ok('after it ends it is not listed', d.activeRules(rules, 8328, new Date('2026-10-01')).length === 1);
}

console.log('\nTHE PUNCHED ORDER CARRIES THE DISCOUNT\n');
{
  const portal = require('../src/integrations/dealerPortal');
  // A commercial-analyze row after withDiscountRules: MARUTI 12% on MRP 1000.
  const raw = {
    part_no: '16510M68K10', mrp: 1000, discount_percent: 12, price: 880, discount_rule: { id: 2872, name: 'MIYA JI MOTORS MARUTI 12%' },
    allocations: [{ dealer_id: 23, qty: 2, mrp: 1000, discount_percent: 12, price: 880 }],
  };
  const body = portal._confirmBody({ id: 'ORD-T1', lines: [{ partNo: '16510M68K10', qty: 2, source: 'portal', _raw: raw }], portalCustomer: { buyerId: 265 } });
  const line = body.lines[0];
  ok('the line says the discount the way an order line keeps it', line.item_discount_per === 12 && line.discounted_unit_price === 880, JSON.stringify(line));
  ok('...names the rule it came from', line.discount_rule_id === 2872);
  ok('...and every allocation carries it too', line.dealers.every((a) => a.item_discount_per === 12 && a.discounted_unit_price === 880));
  const plain = portal._confirmBody({ id: 'ORD-T2', lines: [{ partNo: 'X1', qty: 1, source: 'portal', _raw: { part_no: 'X1', mrp: 500, discount_percent: 0, price: 500, allocations: [] } }] });
  ok('a line with no discount gets no discount fields', plain.lines[0].item_discount_per === undefined && plain.lines[0].discounted_unit_price === undefined);
}

console.log('\nAT PUNCH, THE DISCOUNT COMES FROM THE ADMIN RULES\n');
(async () => {
  const portal = require('../src/integrations/dealerPortal');
  portal._setMockDealerFor(265, { dealerId: 8858, accountId: 265, odooPartnerId: 1 });
  portal._setMockDiscountRules([
    { rule_id: 2872, dealer_id: 8858, rule_type: 'BRAND', brand: 'MARUTI', discount_mode: 'PERCENT', discount_value: 12, is_active: true, approval_status: 'APPROVED', min_qty: 1 },
  ]);
  // Quoted by the plain analyze: no money, no discount on the row.
  const order = {
    id: 'ORD-T3',
    portalCustomer: { buyerId: 265 },
    lines: [
      { partNo: '16510M68K10', qty: 2, mrp: 1000, brand: 'MARUTI SUZUKI', source: 'portal', _raw: { part_no: '16510M68K10', dealers: [{ dealer_id: 23, qty: 2 }] } },
      { partNo: 'BOSCH1', qty: 1, mrp: 400, brand: 'BOSCH', source: 'portal', _raw: { part_no: 'BOSCH1', dealers: [] } },
    ],
  };
  const priced = await portal._discountForPunch(order);
  const body = portal._confirmBody(priced);
  ok('a line quoted with no discount is punched with the rule from the admin panel', body.lines[0].item_discount_per === 12 && body.lines[0].discounted_unit_price === 880, JSON.stringify(body.lines[0]));
  ok('...its allocation too', body.lines[0].dealers[0].item_discount_per === 12);
  ok('a part no rule covers goes at its price, no discount', body.lines[1].item_discount_per === undefined);
  ok('the order itself is not changed', order.lines[0]._raw.discount_percent === undefined);
  const noCustomer = await portal._discountForPunch({ id: 'ORD-T4', lines: order.lines });
  ok('an order with no customer account goes as it was', noCustomer.lines === order.lines);
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
