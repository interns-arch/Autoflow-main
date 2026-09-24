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

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
