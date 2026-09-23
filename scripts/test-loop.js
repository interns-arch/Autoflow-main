#!/usr/bin/env node
'use strict';
// THE KNOWLEDGE LOOP, END TO END.
//
//   customer asks something nobody knows
//     -> our sources fail
//     -> the web is tried
//     -> the specialist is asked, and the conversation PAUSES
//     -> the customer is told a specialist is reviewing it
//     -> he answers, hours later, in his own shorthand
//     -> the paused conversation RESUMES and writes a proper reply
//     -> what was learned is kept, so the next customer never gets this far
//
// The pause is the part that is easy to break and impossible to notice: it
// only shows up when a real customer is left waiting forever. So it is tested
// here without a model where it can be tested exactly, and with one where the
// thing being measured is judgement.
//
//   npm run test:loop
const path = require('path');
const os = require('os');
process.env.SCRATCH = process.env.SCRATCH || path.join(os.tmpdir(), 'autoflow-loop-test');
require('fs').mkdirSync(process.env.SCRATCH, { recursive: true });
require('fs').writeFileSync(path.join(process.env.SCRATCH, 'state.json'), '{}');
process.env.DATA_DIR = process.env.SCRATCH;
process.env.ESCALATION_NUMBER = '919999492550';
require('dotenv').config();

const config = require('../src/config');

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
};
const skipped = (name, why) => {
  skip++;
  console.log('  SKIP  ' + name + '  (' + why + ')');
};

// ------------------------------------------------- the web guard, offline
function webGuards() {
  console.log('\nTHE WEB IS A LEAD, NEVER AN ANSWER (offline)\n');
  const w = require('../src/agent/tools/web')._internals;

  // The bug that made this rule real: the money stripper ate the part number
  // it was meant to protect.
  const s = w.stripFigures('Price is Rs.450 for part 13780M68P01');
  ok('a price is removed but the part number survives it', !s.includes('450') && s.includes('13780M68P01'), s);

  ok(
    'a size and a year are NOT treated as money',
    w.stripFigures('Wiper blade 16 inch for 2018 Swift') === 'Wiper blade 16 inch for 2018 Swift',
  );

  ok('a price written in words is removed too', !w.stripFigures('It costs 1,299 rupees').includes('1,299'));
  ok('a price reached by a few words is still removed', !w.stripFigures('the price of this filter is 350').includes('350'));

  // Many part numbers in one page must all come back intact — the masking
  // index runs past nine and into two letters there.
  const many = 'A 13780M68P01 B 13780M55R50 C 17920M75F00 D 38402M72R00 E 55810M75J30 F 82802M81A60 G 16510M65L10 H 12345A I 67890B J 11111C K 22222D';
  ok('eleven part numbers in one page all survive', w.stripFigures(many) === many);

  const nums = w.partNumbersIn('Use 13780M68P01 (petrol) or 13780M55R50 (diesel)');
  ok('part numbers are picked out of a sentence', nums.length === 2 && nums[0] === '13780M68P01', JSON.stringify(nums));
  ok('a sentence with no part number yields none', w.partNumbersIn('sorry, NOT FOUND').length === 0);

  ok('it asks the web three different ways', w.queriesFor('cabin filter', 'Brezza 2019').length === 3);
}

// ------------------------------------------------- the loop, with a model
async function loopTest() {
  console.log('\nTHE PAUSE AND THE RESUME (live model)\n');
  if (!config.gemini || !config.gemini.apiKey) {
    return skipped('the whole loop', 'GEMINI_API_KEY not set');
  }
  process.env.AGENT_ENABLED = 'true';
  config.agent.enabled = true;

  const agent = require('../src/agent');
  await require('../src/agent/memory').setupCheckpointer();

  // A bot that records instead of sending, so nothing reaches WhatsApp.
  const toCustomer = [];
  const toSpecialist = [];
  // _allBots is how escalation finds a line it can send the question on
  // (pickSender): the bot that talks to the customer is not necessarily the
  // one that reaches the specialist.
  const bot = {
    key: 'test',
    get _allBots() {
      return { customer: bot };
    },
    transport: {
      number: '919289015775',
      mode: 'CLOUD',
      state: 'connected',
      async sendToChat(chatId, body) {
        toCustomer.push({ chatId, body });
        return 'wamid-' + toCustomer.length;
      },
      async sendText(to, body) {
        toSpecialist.push({ to, body });
        return 'wamid-h' + toSpecialist.length;
      },
    },
  };

  const CHAT = '919999000042@c.us';
  const PHONE = '919999000042';

  // CHOOSING THIS PHRASE TOOK TWO GOES, and the first one taught something.
  //
  // "wo purana wala kabza jo humne pichli baar liya tha" made the agent ask
  // "kaunsi gaadi ka?" instead of escalating — which is RIGHT. An ambiguous
  // question should be clarified with the customer, not sent to a specialist
  // who would only ask the same thing. Testing the pause with an ambiguous
  // phrase tests the wrong thing.
  //
  // So this one is completely specified and still unanswerable: nothing to
  // clarify, nothing in the catalogue, and no Maruti part number on the web.
  // The only correct move left is to ask a person.
  const ASKED = 'Cartrends branded showroom display banner 6 feet, 2 piece chahiye';

  let turn = null;
  try {
    turn = await agent.handle({ bot, chatId: CHAT, phone: PHONE, customer: null, text: ASKED });
  } catch (e) {
    return ok('the first turn runs', false, String((e && e.message) || e).slice(0, 140));
  }

  ok('the conversation pauses instead of guessing', turn.paused === true, JSON.stringify(turn));
  if (!turn.paused) {
    console.log('        (the rest of the loop cannot be checked without a pause)');
    return;
  }
  ok('nothing was said to the customer by the model while paused', !turn.reply);
  ok('the specialist was actually sent the question', toSpecialist.length === 1, JSON.stringify(toSpecialist).slice(0, 200));
  ok(
    'he is told where the bot already looked, so he confirms rather than starts over',
    /tried|catalogue|portal|web/i.test((toSpecialist[0] || {}).body || ''),
    ((toSpecialist[0] || {}).body || '').slice(0, 200),
  );

  // HOURS LATER. He answers the way he actually answers — shorthand, to a
  // colleague, with no sentence in it.
  //
  // Sent through escalation.handleReply and NOT straight into agent.resume,
  // because the route his message takes is part of what is being tested: his
  // WhatsApp reply has to be matched to the right open question, routed to
  // the paused conversation rather than answered from escalation itself, and
  // learned on the way past. Calling resume() directly would skip all three
  // and pass while the real path was broken.
  const before = toCustomer.length;
  // attach() is skipped on purpose: it subscribes to the transport and would
  // need an onMessage. The question is already open from create(), which is
  // all handleReply needs to place his answer.
  const escalation = require('../src/core/escalation');
  let routed = false;
  try {
    routed = await escalation.handleReply({
      from: '919999492550',
      isGroup: false,
      body: 'bonnet hinge left 82802M81A60, hai stock me',
      // A swipe-reply onto our question, which is how a person actually answers.
      contextId: 'wamid-h1',
    });
  } catch (e) {
    return ok('the paused conversation resumes', false, String((e && e.message) || e).slice(0, 140));
  }

  ok('his reply is matched to the open question', routed === true);
  const sent = toCustomer.slice(before).map((x) => x.body).join('\n');
  ok('the customer finally gets a reply', sent.length > 0, JSON.stringify(sent).slice(0, 160));
  ok(
    'his shorthand is NOT forwarded word for word',
    sent.trim() !== 'bonnet hinge left 82802M81A60, hai stock me',
    JSON.stringify(sent).slice(0, 160),
  );
  ok(
    'the reply is in the customer\'s language, not English',
    /\b(hai|hain|aap|ji|nahi|kar|hoon|mil|stock)\b/i.test(sent),
    JSON.stringify(sent).slice(0, 160),
  );

  // ONE ANSWER, NOT TWO.
  //
  // There are two things that both want to answer this customer — the agent
  // resuming, and escalation's own resolveWithAnswer — and the whole
  // agentThread handover exists to make sure only one of them does. A second
  // message saying the same thing differently is how a bot stops sounding
  // like a person.
  ok(
    'the customer is answered ONCE, not twice',
    toCustomer.length - before === 1,
    toCustomer.length - before + ' messages: ' + JSON.stringify(toCustomer.slice(before).map((x) => x.body.slice(0, 70))),
  );

  // THE POINT OF THE WHOLE LOOP: it is not asked again.
  const knowledge = require('../src/core/knowledge');
  const learned = knowledge.lookupAlias(ASKED);
  ok('what he taught is remembered for the next customer', Boolean(learned), 'aliases: ' + JSON.stringify(Object.keys(knowledge.all().aliases || {})));
}

(async () => {
  webGuards();
  await loopTest();
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
