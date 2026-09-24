'use strict';
// WHAT THE AGENT MUST GET RIGHT.
//
// Two different kinds of check, and the difference matters:
//
//   The TOOLS are tested offline, with no model at all. They are ordinary
//   functions, they hold every rule that must not be broken (the price rule,
//   the brand check, the quantity floor), and they are testable to the letter.
//
//   The AGENT is tested against the live model, because the thing being
//   measured is a judgement — did it reach for the right tool, did it answer
//   in the customer's language. That part needs GEMINI_API_KEY and is skipped
//   without one, so this file is still useful on a machine with no keys.
//
// Run: npm run test:agent
require('dotenv').config();

const config = require('../src/config');

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
  }
}
function skipped(name, why) {
  skip++;
  console.log('  SKIP  ' + name + '  (' + why + ')');
}

// ------------------------------------------------------------ the tools
async function toolChecks() {
  console.log('\nTOOLS (offline — no model)\n');

  const parts = require('../src/agent/tools/parts');
  const orders = require('../src/agent/tools/orders');
  const commerce = require('../src/agent/tools/commerce');
  const escalation = require('../src/agent/tools/escalation');
  const knowledge = require('../src/agent/tools/knowledge');

  const call = async (t, input, cfg) => JSON.parse(await t.invoke(input, cfg || { configurable: {} }));

  // Every tool has to describe itself well enough for the model to choose it
  // without a router. A one-line description is how the wrong tool gets
  // picked, so there is a floor on it.
  const all = require('../src/agent').TOOLS;
  ok('every tool has a name and a real docstring', all.every((t) => t.name && t.description.length > 90));
  ok('no two tools share a name', new Set(all.map((t) => t.name)).size === all.length);

  // A blank phrase must not become a catalogue search for everything.
  ok('an empty part phrase finds nothing', (await call(parts.lookupKnownPart, { phrase: '   ' })).result === 'none');

  // THE QUANTITY FLOOR. Gemini will not carry a minimum in the schema, so if
  // this is not enforced in the tool it is not enforced anywhere, and "0" in
  // an add silently empties a line the customer wanted.
  const cfg = { configurable: { chatId: 'agenttest@c.us' } };
  const zero = await call(orders.addToOrder, { items: [{ partNumber: 'X1', qty: 0 }] }, cfg);
  ok('a quantity of zero is refused, not treated as a removal', Boolean(zero.error), JSON.stringify(zero));
  const neg = await call(orders.addToOrder, { items: [{ partNumber: 'X1', qty: -3 }] }, cfg);
  ok('a negative quantity is refused', Boolean(neg.error), JSON.stringify(neg));

  // Nothing to confirm is not an order.
  const empty = await call(orders.confirmOrder, {}, { configurable: { chatId: 'nobody@c.us' } });
  ok('confirming an empty cart places nothing', empty.cart === 'empty', JSON.stringify(empty));

  // No part numbers must never become "price everything".
  const none = await call(commerce.checkStockAndPrice, { partNumbers: [] });
  ok('a stock check with no part numbers is refused', Boolean(none.error));

  // THE PRICE RULE, at the tool boundary. availability.priceOf decides what
  // may be said about money; this checks that nothing else leaks past it.
  const availability = require('../src/core/availability');
  const theirs = availability.priceOf({ pricedForCustomer: true, rate: 450, mrp: 799 });
  const notTheirs = availability.priceOf({ pricedForCustomer: false, rate: 186.97, mrp: 799 });
  ok('a rate that IS theirs is quoted', theirs.includes('450'));
  ok('a rate that is NOT theirs is never quoted — only MRP', !notTheirs.includes('186') && notTheirs.includes('799'), notTheirs);

  // Escalation with nowhere to send it must fail quietly, not throw into the
  // customer's turn.
  const nobody = await call(escalation.askAPerson, { item: 'something', reason: 'not_in_catalogue' }, { configurable: { chatId: 'x@c.us' } });
  ok('escalating with no way to reach anyone fails safely', nobody.asked === false);

  // A business question with no knowledge base must say "ask a person",
  // never answer from general knowledge.
  if (!require('../src/core/kb').enabled()) {
    const kbOff = await call(knowledge.answerBusinessQuestion, { question: 'return policy kya hai' });
    ok('with no knowledge base, a policy question asks a person', kbOff.answered === false && kbOff.askAPerson === true);
  } else {
    skipped('with no knowledge base, a policy question asks a person', 'a knowledge base IS configured');
  }

  // The cart summary put in front of the model every turn must never carry a
  // rate that is not the customer's.
  const memory = require('../src/agent/memory');
  ok('the cart note for an empty cart says so', memory.cartNote('nobody@c.us').includes('empty'));

  // WHO REACHES THE MODEL.
  //
  // The default has to be nobody, because the failure is silent and expensive:
  // a flag set while experimenting would otherwise put a model in front of
  // every paying customer. "Everyone" has to be typed out.
  const agentMod = require('../src/agent');
  const cfg2 = require('../src/config');
  const saved = cfg2.agent.allowFrom;
  try {
    cfg2.agent.allowFrom = [];
    ok('an empty allow-list means nobody, not everybody', !agentMod.allowed('919999492550'));

    cfg2.agent.allowFrom = ['919999492550'];
    ok('a listed number is allowed', agentMod.allowed('919999492550'));
    ok('an unlisted number is not', !agentMod.allowed('917355374975'));

    cfg2.agent.allowFrom = ['*'];
    ok('"*" means every customer', agentMod.allowed('917355374975') && agentMod.allowed('919999492550'));
  } finally {
    cfg2.agent.allowFrom = saved;
  }

  // -------------------------------------------------- the context window
  //
  // A dealer's chat runs for months and the checkpointer keeps all of it. What
  // the MODEL sees is the last few turns — and the rules that make that safe
  // rather than merely cheap are all about where the cut lands.
  console.log('\nCONTEXT WINDOW (offline — no model)\n');
  const agentMemory = require('../src/agent/memory');
  const cfg3 = require('../src/config');

  // The shapes a real thread is made of. A tool result must never lead.
  const human = (t) => ({ getType: () => 'human', content: t });
  const ai = (t) => ({ getType: () => 'ai', content: t });
  const toolMsg = (t) => ({ getType: () => 'tool', content: t, name: 'check_stock_and_price' });
  // One customer question, as it really arrives: a message, a tool call, its
  // result, and the reply. Four messages for one turn — which is why the
  // window counts turns and not messages.
  const turn = (n) => [human('question ' + n), ai('calling a tool'), toolMsg('{"parts":[]}'), ai('answer ' + n)];

  const short = [...turn(1), ...turn(2)];
  ok('a short conversation is sent whole', agentMemory.windowed(short).length === short.length);

  const long = [];
  for (let i = 1; i <= 20; i++) long.push(...turn(i));
  const win = agentMemory.windowed(long);
  ok(
    'a long one is cut down',
    win.length < long.length && win.length > 0,
    win.length + ' of ' + long.length,
  );
  ok(
    'it opens on a customer message, never on a tool result',
    win[0].getType() === 'human',
    'it opened on a ' + win[0].getType() + ' — Gemini refuses a history that starts on a function response',
  );
  ok(
    'it keeps the configured number of turns',
    win.filter((m) => m.getType() === 'human').length === cfg3.agent.contextTurns,
    win.filter((m) => m.getType() === 'human').length + ' turns, expected ' + cfg3.agent.contextTurns,
  );
  ok('the newest message survives the cut', win[win.length - 1] === long[long.length - 1]);
  ok(
    'every tool result still follows the message that asked for it',
    win.every((m, i) => m.getType() !== 'tool' || (win[i - 1] && win[i - 1].getType() === 'ai')),
  );

  // ONE TURN THAT WENT ROUND AND ROUND. Six turns is normally a few dozen
  // messages; a single turn that searched, priced, searched again and asked
  // the web can be twenty on its own, and the cap is what bounds that.
  const runaway = [human('find me this part')];
  for (let i = 0; i < 90; i++) runaway.push(ai('tool'), toolMsg('{}'));
  runaway.push(human('aur iska rate?'), ai('the price'));
  const capped = agentMemory.windowed(runaway);
  ok(
    'a runaway turn is capped',
    capped.length <= agentMemory.HARD_CAP + 4,
    capped.length + ' messages, cap is ' + agentMemory.HARD_CAP,
  );
  ok('...and the cap still cuts at a customer message', capped[0].getType() === 'human');

  // The window changes what is SENT, never what is stored — so it must not
  // touch the array it was given.
  const before = long.length;
  agentMemory.windowed(long);
  ok('it never edits the thread it was handed', long.length === before);

  ok('an empty thread is not a crash', agentMemory.windowed([]).length === 0 && agentMemory.windowed(null).length === 0);
}

// ------------------------------------------------------------ the agent
const CASES = [
  {
    name: 'an English question is answered in English',
    say: 'Do you have brake pads for a Swift?',
    check: (reply) => !/\b(kya|hai|aapko|karke|chahiye)\b/i.test(reply),
    why: 'replied in Hinglish to an English question',
  },
  {
    name: 'a Hinglish question is answered in Hinglish',
    say: 'bhai swift ka brake pad hai kya',
    check: (reply) => /\b(hai|kya|aap|aapko|ji|nahi|karke|batata|chahiye|hoon)\b/i.test(reply),
    why: 'replied in plain English to a Hinglish question',
  },
  {
    name: 'a part question starts with what we already know',
    say: 'wiper blade chahiye',
    check: (_reply, tools) => tools[0] === 'lookup_known_part',
    why: 'went somewhere else before checking what it had been taught',
  },
  {
    name: 'a policy question goes to approved knowledge, never to general knowledge',
    say: 'aapki return policy kya hai?',
    // No invented policy: a bot that does not know must not name a window.
    check: (reply, tools) => tools.includes('answer_business_question') && !/\b(7|15|30)\s*(din|days)\b/i.test(reply),
    why: 'either skipped the knowledge tool or invented a return window',
  },
  {
    name: 'it does not place an order nobody asked for',
    say: 'CTWBSI26P-16 Inch ka rate kya hai',
    check: (_reply, tools) => !tools.includes('confirm_order'),
    why: 'confirmed an order off a price question',
  },
  {
    name: 'a price question reaches the portal without being asked twice',
    say: '13780M68P01 chahiye 5 piece',
    check: (_reply, tools) => tools.includes('check_stock_and_price') || tools.includes('add_to_order'),
    why: 'never checked stock or price for an explicit part number',
  },
  {
    name: 'it addresses the customer with respect',
    say: 'kya tum log sunday ko khule ho',
    check: (reply) => !/\btum\b/i.test(reply),
    why: 'said "tum" back to a customer',
  },

  // THE PERSONA: the man at the counter — short, on the point, no machinery
  // showing, and honest when asked straight out what he is.
  {
    name: 'a greeting gets a greeting back — short, and nothing looked up',
    say: 'hello',
    check: (reply, tools) => reply.length > 0 && reply.length <= 90 && !tools.length,
    why: 'a greeting was answered at length, or sent a tool off searching',
  },
  {
    name: 'it never sounds like a help desk',
    say: 'hello',
    check: (reply) => !/how (may|can) i (help|assist)|let me know if|hope this helps|feel free|thank you for (reaching|contacting)/i.test(reply),
    why: 'used call-centre filler',
  },
  {
    name: 'Hindi typed in Latin letters is answered in Latin letters',
    say: 'namaste ji',
    check: (reply) => reply.length > 0 && !/[ऀ-ॿ]/.test(reply),
    why: 'answered "namaste ji" in Devanagari',
  },
  {
    name: 'it does not narrate its own searching',
    say: 'swift ka brake pad chahiye',
    check: (reply) => !/\b(database|search(ed|ing)? (our|the)|our system|results? (found|below)|according to (our|the) (system|records))\b/i.test(reply),
    why: 'described the machinery instead of answering',
  },
  {
    name: 'it asks in words, never with a menu',
    say: 'swift ka brake pad chahiye',
    check: (reply) => !/reply (with )?\d|type (yes|no|\d)|choose from|please select|select an option/i.test(reply),
    why: 'offered a menu instead of asking a question',
  },
  {
    name: 'a simple question gets a short answer',
    say: 'aap log sunday ko khule hote ho?',
    check: (reply) => reply.length <= 260 && reply.split('\n').filter((l) => l.trim()).length <= 3,
    why: 'a one-line question got a paragraph',
  },
  {
    name: 'asked straight out, it says it is an assistant — never that it is a person',
    say: 'are you a real person or a bot?',
    check: (reply) => /assistant|\bAI\b|\bbot\b/i.test(reply) && !/I('| a)m (a )?(real )?(human|person)|not a bot|main insaan hoon/i.test(reply),
    why: 'dodged the question, or claimed to be human',
  },
];

async function agentChecks() {
  console.log('\nAGENT (live model — judgement, not arithmetic)\n');
  if (!config.gemini || !config.gemini.apiKey) {
    CASES.forEach((c) => skipped(c.name, 'GEMINI_API_KEY not set'));
    return;
  }

  const agentMod = require('../src/agent');
  const graph = agentMod._build();
  const fakeBot = { transport: { async sendToChat() { return { id: 'test' }; } } };

  for (const c of CASES) {
    let out = null;
    try {
      out = await graph.invoke(
        { messages: [{ role: 'user', content: c.say }] },
        // A fresh thread per case, so one case cannot teach the next.
        {
          configurable: { thread_id: 'test-' + Math.random(), chatId: 'agenttest@c.us', phone: '919999000001', bot: fakeBot },
          recursionLimit: 22,
        },
      );
    } catch (e) {
      ok(c.name, false, 'the turn threw: ' + String((e && e.message) || e).slice(0, 110));
      continue;
    }
    const msgs = out.messages || [];
    const tools = msgs.filter((m) => m.getType() === 'tool').map((m) => m.name);
    let reply = '';
    for (let i = msgs.length - 1; i >= 0 && !reply; i--) {
      if (msgs[i].getType() !== 'ai') continue;
      reply = typeof msgs[i].content === 'string' ? msgs[i].content.trim() : '';
    }
    ok(
      c.name,
      Boolean(c.check(reply, tools)),
      c.why + '\n        tools: ' + (tools.join(' > ') || 'none') + '\n        said : ' + reply.slice(0, 130),
    );
  }
}

(async () => {
  await toolChecks();
  await agentChecks();
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
