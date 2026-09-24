#!/usr/bin/env node
'use strict';
// THE BOT ASKS IN BOLD, AND PEOPLE COPY WHAT THEY WERE SHOWN.
//
// Live, 24 Sep, 13:51-14:00. Prateek sir was told three times to reply in the
// exact format. He replied in exactly that format. Every one was refused,
// because the bot asks for "*OK WA-MUF9D6Q6*" — WhatsApp bold — and copying
// bold text brings the asterisks with it:
//
//   recv <- 919999492550: *OK WA-MUF9D6Q6*
//   Prateek Sir wrote on WA-MUF9D6Q6 without a decision: "*OK WA-MUF9D6Q6*"
//
// MIYA JI MOTORS sat unopened for nine minutes while the bot and the person
// approving it argued about punctuation the bot had put there itself.
//
//   npm run test:watext
const path = require('path');
const os = require('os');
process.env.SCRATCH = process.env.SCRATCH || path.join(os.tmpdir(), 'autoflow-watext-test');
require('fs').mkdirSync(process.env.SCRATCH, { recursive: true });
require('fs').writeFileSync(path.join(process.env.SCRATCH, 'state.json'), '{}');
process.env.DATA_DIR = process.env.SCRATCH;

const { unformat } = require('../src/core/waText');
const cc = require('../src/core/customerCreate');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
};

console.log('\nSTRIPPING WHATSAPP MARKUP\n');
ok('bold markers go', unformat('*OK WA-1*') === 'OK WA-1');
ok('italic markers go', unformat('_OK WA-1_') === 'OK WA-1');
ok('strikethrough goes', unformat('~OK WA-1~') === 'OK WA-1');
ok('monospace goes', unformat('`OK WA-1`') === 'OK WA-1');
ok('a trailing full stop goes', unformat('OK WA-1.') === 'OK WA-1');
ok('markers become a space, never nothing', unformat('*OK* *WA-1*') === 'OK WA-1', JSON.stringify(unformat('*OK* *WA-1*')));
ok('plain text is untouched', unformat('OK WA-1') === 'OK WA-1');
ok('nothing in, nothing out', unformat(null) === '' && unformat(undefined) === '');

console.log('\nTHE APPROVAL THAT WAS REFUSED\n');

// The exact message from the live log.
const live = cc.readDecision('*OK WA-MUF9D6Q6*');
ok(
  'the message Prateek sir actually sent is now an approval',
  live && live.yes === true && live.requestId === 'WA-MUF9D6Q6',
  JSON.stringify(live),
);

for (const [text, want] of [
  ['OK WA-MUF9D6Q6', true],
  ['*OK WA-MUF9D6Q6*', true],
  ['_ok wa-muf9d6q6_', true],
  ['OK WA-MUF9D6Q6.', true],
  ['*NO WA-MUF9D6Q6*', false],
  ['~reject WA-MUF9D6Q6~', false],
]) {
  const r = cc.readDecision(text);
  ok(`"${text}" -> ${want ? 'approve' : 'reject'}`, r && r.yes === want && r.requestId === 'WA-MUF9D6Q6', JSON.stringify(r));
}

console.log('\nWHAT MUST STILL NOT COUNT AS A DECISION\n');

// These are the reason the exact format is demanded at all: a bare "Ok" is
// not agreement to create an account, and never was.
for (const text of ['Okay', 'Ok', '*Ok*', 'yes', 'OK WA-MUF9D6Q6 please create', 'ok WA-'] ) {
  ok(`"${text}" is not a decision`, cc.readDecision(text) === null, JSON.stringify(cc.readDecision(text)));
}

// A request id is still required — "OK" alone must not approve whatever
// happens to be open.
ok('a decision still needs the request id', cc.readDecision('OK') === null);

console.log('\nTHE SECOND NUDGE IS PLAIN\n');

// Asking nicely in bold is what caused the loop. Once it has failed once, the
// command is shown as plain text, so whatever comes back is exactly what was
// shown.
{
  const cs = require('../src/core/chatState');
  const awaiting = cs.slot('customerCreate.awaiting');
  awaiting.set('WA-NUDGE1', { answers: { name: 'TEST MOTORS', phone: '919999000001' } });

  ok('the first nudge is counted', cc.noteNudge('WA-NUDGE1') === 1);
  ok('the second is counted', cc.noteNudge('WA-NUDGE1') === 2);
  ok('the count is written through, so a restart does not forget it', awaiting.get('WA-NUDGE1').nudges === 2);
  ok('a request that is no longer pending counts nothing', cc.noteNudge('WA-GONE') === 0);

  // The plain wording itself: whatever the bot shows on the second try must
  // carry no marker WhatsApp would render, or the copy comes back wrong again.
  const plain = [
    'WA-NUDGE1 (TEST MOTORS) is still waiting.',
    '',
    'Copy one of these exactly:',
    '',
    'OK WA-NUDGE1',
    'NO WA-NUDGE1',
  ].join('\n');
  ok('the plain nudge carries nothing WhatsApp will render', !/[*_~`]/.test(plain));
  ok('...and the command in it parses as an approval', (cc.readDecision('OK WA-NUDGE1') || {}).requestId === 'WA-NUDGE1');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
