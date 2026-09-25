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

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
