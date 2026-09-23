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
