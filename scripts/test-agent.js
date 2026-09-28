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

  // WHO REACHES THE MODEL: every customer — and no member of staff.
  //
  // The template path is gone for customers, so there is nothing else to
  // answer them. Staff keep their command tooling (approvals, SO punching,
  // ledgers) — powers the customer's agent must never be handed.
  const cfg2 = require('../src/config');
  const { prototype: botProto } = require('../src/bots/customerBot');
  const isOp = (from) => botProto.isOperator.call({}, { from });
  ok('the agent is on unless switched off', cfg2.agent.enabled === (String(process.env.AGENT_ENABLED || 'true').toLowerCase() !== 'false'));
  ok('there is no allow-list any more', !('allowFrom' in cfg2.agent) && typeof require('../src/agent').allowed === 'undefined');
  ok('a customer is not staff — the agent answers them', !isOp('917355374975'));
  if (cfg2.escalationNumber) ok('the helper is staff — his messages never reach the customer agent', isOp(cfg2.escalationNumber));
  const admin = (cfg2.adminNumbers || [])[0];
  if (admin) ok('an admin is staff', isOp(admin));
  const salesman = (cfg2.salesTeamNumbers || [])[0];
  if (salesman) ok('the sales team is staff', isOp(salesman));

  // ---------------------------------------- tools hand over FACTS, not words
  //
  // The agent writes every word the customer reads. A tool that returns a
  // finished sentence gets forwarded instead of understood, so none may.
  console.log('\nTOOLS RETURN FACTS — THE AGENT WRITES THE WORDS (offline)\n');
  const av = require('../src/core/availability');
  const resolveWas = av.resolve;
  av.resolve = async () => [
    { item: 'X1', partNo: 'X1', source: 'available', mrp: 310, pricedForCustomer: false },
    { item: 'X2', partNo: 'X2', source: 'unavailable', mrp: 599, pricedForCustomer: false },
  ];
  let stock;
  try {
    stock = await call(commerce.checkStockAndPrice, { partNumbers: ['X1', 'X2'] }, { configurable: { chatId: 'facts@c.us' } });
  } finally {
    av.resolve = resolveWas;
  }
  const [s1, s2] = (stock && stock.parts) || [];
  ok('a stock check returns no ready-made sentence', stock && stock.parts.every((p) => !('line' in p)), JSON.stringify(stock));
  ok('...but the facts: status, price, and when an on-order part arrives', s1 && s1.status === 'in_stock' && /310/.test(s1.price) && s2.status === 'on_order' && s2.etaDays > 0, JSON.stringify(stock));
  ok('"unavailable" is never handed over as a word the model could repeat', !/unavailable|not available/i.test(JSON.stringify(stock)));

  const lookup = require('../src/core/customerLookup');
  const trackWas = lookup.trackFacts;
  lookup.trackFacts = async (id) => ({ orderId: id, found: true, stage: 'dispatched', dispatchedOn: '23 Sep', invoiceNo: 'INV-9' });
  const fulfilment = require('../src/agent/tools/fulfilment');
  let track;
  try {
    track = JSON.parse(await fulfilment.orderStatus.invoke({ orderId: '486' }, { configurable: { chatId: 'facts@c.us' } }));
  } finally {
    lookup.trackFacts = trackWas;
  }
  ok('order status returns the portal\'s facts, not a finished message', track && !('reply' in track) && track.stage === 'dispatched' && track.invoiceNo === 'INV-9', JSON.stringify(track));

  // OUR STOCK IS INTERNAL. Asked "are 20 there?", the answer is yes or no for
  // 20 — never how many we have. The portal is asked for THEIR quantity.
  let askedQty = null;
  av.resolve = async (lines) => {
    askedQty = lines.map((l) => l.qty);
    return [{ item: lines[0].item, partNo: lines[0].item, source: 'partial', available: 5, mrp: 310 }];
  };
  let ps;
  let st20;
  try {
    ps = JSON.parse(await fulfilment.partStatus.invoke({ partNumber: 'X1', qty: 20 }, { configurable: { chatId: 'facts@c.us' } }));
    st20 = await call(commerce.checkStockAndPrice, { partNumbers: ['X1'], quantities: [20] }, { configurable: { chatId: 'facts@c.us' } });
  } finally {
    av.resolve = resolveWas;
  }
  ok('the portal is asked about the quantity they need', askedQty && askedQty[0] === 20, JSON.stringify(askedQty));
  ok('part status says yes or no for their quantity', ps && ps.needed === 20 && ps.available === false && ps.etaDays > 0, JSON.stringify(ps));
  ok('...and never how many we have (5 on the shelf appears nowhere)', !/"available":\s*5|\b5\b/.test(JSON.stringify(ps)) && !/stock|purchase|sales/i.test(JSON.stringify(ps)), JSON.stringify(ps));
  ok('the stock check answers for their quantity too, without a count', st20 && st20.parts[0].status === 'part_in_stock_rest_on_order' && !/\b5\b/.test(JSON.stringify(st20)), JSON.stringify(st20));

  // ------------------------------------------- the work the templates did
  console.log('\nTHE TEMPLATES\' WORK, AS TOOLS (offline)\n');
  const workflows = require('../src/agent/tools/workflows');
  // An order list: matched, on order, and a close match for a number the
  // portal does not know — the "(1/6) did not match exactly" of old.
  av.resolve = async (lines) =>
    lines.map((l) =>
      l.item === 'GONEX'
        ? { item: l.item, source: 'unidentified' }
        : { item: l.item, partNo: l.item, source: l.item === 'ONORD' ? 'unavailable' : 'available', mrp: 47, pricedForCustomer: false },
    );
  const fakeBot = { closestMatches: async (names) => new Map(names.map((n) => [n, { partNo: n + '5PK', name: 'Instrument Panel Garnish' }])) };
  let ol;
  try {
    ol = JSON.parse(await workflows.resolveOrderList.invoke({ items: [{ part: 'X1', qty: 20 }, { part: 'ONORD', qty: 5 }, { part: 'GONEX', qty: 20 }] }, { configurable: { chatId: 'facts@c.us', bot: fakeBot } }));
  } finally {
    av.resolve = resolveWas;
  }
  const [o1, o2, o3] = (ol && ol.lines) || [];
  ok('an order list is checked in one call, each line with its quantity', o1 && o1.status === 'in_stock' && o1.qty === 20 && o2.status === 'on_order' && o2.etaDays > 0, JSON.stringify(ol));
  ok('...and a number the portal does not know comes back with its close match', o3 && o3.status === 'close_match_only' && o3.closeMatch.partNo === 'GONEX5PK' && o3.closeMatch.packOf === 5, JSON.stringify(o3));
  ok('...as facts: no sentence, no stock count', !/found and added|did not match|\bavailable\b/i.test(JSON.stringify(ol)));

  // The account form, driven by the agent: a registered customer is asked
  // whether it is for someone else; then the form's questions come back as
  // facts for the agent to ask in its own words.
  const cust = require('../src/core/customers');
  const cc = require('../src/core/customerCreate');
  const resolveCustWas = cust.resolve;
  cust.resolve = async () => ({ found: true, name: 'Miya Ji Motors' });
  const formCfg = { configurable: { chatId: 'form-test@c.us', phone: '919000000990', bot: { finishNewCustomer: async () => true, reviewNewCustomer: async () => true } } };
  cc.cancel('form-test@c.us');
  let f1;
  let f2;
  let f3;
  try {
    f1 = JSON.parse(await workflows.accountForm.invoke({ action: 'start' }, formCfg));
    f2 = JSON.parse(await workflows.accountForm.invoke({ action: 'start', forSomeoneElse: true }, formCfg));
    f3 = JSON.parse(await workflows.accountForm.invoke({ action: 'answer', answer: '9812345678' }, formCfg));
  } finally {
    cust.resolve = resolveCustWas;
    cc.cancel('form-test@c.us');
  }
  ok('a registered customer asking for an account is found to have one already', f1 && f1.alreadyRegistered === true && f1.name === 'Miya Ji Motors', JSON.stringify(f1));
  ok('...and "for someone else" opens the form, with its first question as a fact', f2 && f2.started === true && /number|WhatsApp/i.test(f2.nextQuestion), JSON.stringify(f2));
  ok('...and an answer moves the form on', f3 && f3.inProgress === true && typeof f3.formSays === 'string', JSON.stringify(f3));

  // A number plate, looked up.
  const vahan = require('../src/integrations/vahan');
  const vEnabledWas = vahan.enabled;
  const vLookupWas = vahan.lookup;
  vahan.enabled = () => true;
  vahan.lookup = async () => ({ maker: 'MARUTI SUZUKI', model: 'SWIFT DZIRE', variant: 'VXI', fuel: 'PETROL', year: '2019' });
  let car;
  try {
    car = JSON.parse(await workflows.lookupVehicle.invoke({ plate: 'DL7CW1692' }, { configurable: {} }));
  } finally {
    vahan.enabled = vEnabledWas;
    vahan.lookup = vLookupWas;
  }
  ok('a number plate becomes a car the agent can use', car && car.found && car.model === 'SWIFT DZIRE' && car.year === '2019', JSON.stringify(car));

  // THE GUARD THAT MAKES THAT SAFE: a figure no tool gave is never sent.
  const guard = require('../src/agent')._inventedMoney;
  const priced = [{ getType: () => 'tool', content: JSON.stringify({ parts: [{ partNo: '13780M68P01', price: 'MRP Rs.310' }] }) }];
  ok('a price the tool gave may be written in any form', guard('MRP ₹310 hai, kitne chahiye?', priced, '').length === 0 && guard('310/- ka hai', priced, '').length === 0);
  ok('a price no tool gave is caught', guard('₹299 mein de denge', priced, '').join() === '299');
  ok('a total the model multiplied out is caught', guard('5 piece ka ₹1,550 hoga', priced, '').join() === '1550');
  ok('quantities are not money', guard('Kitne chahiye? 5 ya 10?', priced, '').length === 0);

  // -------------------------------------------- the context: summary + last 20
  //
  // A dealer's chat runs for months and the checkpointer keeps all of it. The
  // MODEL sees a running summary of the old part and the last K messages word
  // for word. Where the cut lands, and what may never go into the summary, are
  // what make that safe rather than merely cheap.
  console.log('\nCONTEXT: summary + last K (offline — no model)\n');
  const agentMemory = require('../src/agent/memory');
  const K = agentMemory.KEEP;

  const human = (t) => ({ getType: () => 'human', content: t });
  const ai = (t, calls) => ({ getType: () => 'ai', content: t, tool_calls: calls || [] });
  const toolMsg = (t) => ({ getType: () => 'tool', content: t, name: 'check_stock_and_price' });
  // One customer question as it really arrives: four messages, not one.
  const turn = (n) => [
    human('question ' + n),
    ai('', [{ name: 'check_stock_and_price', args: { partNumbers: ['P' + n] } }]),
    toolMsg('{"parts":[{"partNo":"P' + n + '","price":"MRP ₹450"}]}'),
    ai('answer ' + n),
  ];
  const thread = (n) => {
    const out = [];
    for (let i = 1; i <= n; i++) out.push(...turn(i));
    return out;
  };

  const short = thread(2);
  ok('a short conversation is sent whole', agentMemory.windowed(short, 0).length === short.length);

  const long = thread(30); // 120 messages
  const p0 = agentMemory.plan(long, 0);
  ok('a long one with no summary yet asks for one', Boolean(p0.fold) && p0.fold[0] === 0 && p0.fold[1] === p0.start);
  const win = agentMemory.windowed(long, p0.start);
  ok(`once summarised, the window holds at least K=${K} messages`, win.length >= K && win.length < long.length, win.length + ' sent');
  ok('...and not many more than K (whole turns only)', win.length < K + 4, win.length + ' sent');
  ok('it opens on a customer message, never on a tool result', win[0].getType() === 'human');
  ok('every tool result still follows the message that asked for it', win.every((m, i) => m.getType() !== 'tool' || (win[i - 1] && win[i - 1].getType() === 'ai')));
  ok('the newest message is in the window', win[win.length - 1] === long[long.length - 1]);

  // THE GAP. Messages that have left the window but are not yet worth a
  // summarising call must stay in view — not fall between the two.
  const done = p0.start;
  const grown = long.concat(turn(31)); // four more messages: fewer than a batch
  const p1 = agentMemory.plan(grown, done);
  ok('a few new messages do not cost a summarising call', p1.fold === null, JSON.stringify(p1));
  ok('...and the ones that left the window stay in view until they are summarised', p1.start === done);
  const grown2 = grown.concat(turn(32), turn(33));
  const p2 = agentMemory.plan(grown2, done);
  ok('a batch later, the summary is brought up to date', Boolean(p2.fold) && p2.fold[0] === done);

  // THE SUMMARY, with a stand-in for the model.
  let seenByModel = '';
  agentMemory._setSummarizer(async (system, user) => {
    seenByModel = user;
    return JSON.stringify({
      summary: 'Asked for P1 x5, rate ₹450, MRP 599, then Rs. 1,050 for P2. Wants 12% off.',
      notes: 'Sharma Auto, Karol Bagh. Buys Cartrends. MRP 120 on filters.',
    });
  });
  const sum = await agentMemory.summarize({ summary: '', notes: '', messages: long.slice(0, 8) });
  ok('the summariser is given the messages that left the view', /Customer: question 1/.test(seenByModel) && /we looked up: check_stock_and_price/.test(seenByModel));
  ok('no price survives into the summary, however it was written', sum && !/₹|\b450\b|\b599\b|1,050|12%/.test(sum.summary), sum && sum.summary);
  ok('...nor into the notes about the customer', sum && !/\b120\b/.test(sum.notes) && /Sharma Auto/.test(sum.notes), sum && sum.notes);
  ok('part numbers and quantities are left alone', sum && /P1 x5/.test(sum.summary));
  agentMemory._setSummarizer(async () => {
    throw new Error('model down');
  });
  ok('a summary that cannot be written is not a crash — the old one stays', (await agentMemory.summarize({ summary: 'old', notes: '', messages: long.slice(0, 8) })) === null);
  agentMemory._setSummarizer(async () => 'not json at all');
  ok('...nor is a summary that comes back garbled', (await agentMemory.summarize({ summary: 'old', notes: '', messages: long.slice(0, 8) })) === null);

  // THE MIDDLEWARE, driven the way the agent drives it.
  const { createMiddleware } = require('langchain');
  const { SystemMessage } = require('@langchain/core/messages');
  const { z } = require('zod');
  const { SYSTEM } = require('../src/agent/prompt');
  const mw = agentMemory.contextMiddleware({ createMiddleware, z });
  agentMemory._setSummarizer(async () => JSON.stringify({ summary: 'Earlier: asked for P1 x5 for a Swift.', notes: 'Name: Sharma. Buys Cartrends.' }));
  const update = await mw.beforeModel({ messages: long, summary: '', notes: '', summarizedThrough: 0 }, {});
  ok('before the model runs, the summary is written into the conversation state', update && /P1 x5/.test(update.summary) && update.summarizedThrough === p0.start, JSON.stringify(update));
  let sent = null;
  await mw.wrapModelCall(
    {
      messages: long,
      state: { messages: long, ...update },
      systemMessage: new SystemMessage(SYSTEM),
      runtime: { configurable: { chatId: 'nobody@c.us', customer: { name: 'SHARMA AUTO' } } },
    },
    async (req) => {
      sent = req;
      return ai('ok');
    },
  );
  const sys = sent && String(sent.systemMessage.content);
  ok('the model is sent the window, not the whole thread', sent && sent.messages.length === win.length);
  ok('...with the summary', /EARLIER IN THIS CONVERSATION[\s\S]*P1 x5/.test(sys));
  ok('...and the notes on who the customer is', /WHAT WE KNOW ABOUT THIS CUSTOMER[\s\S]*SHARMA AUTO[\s\S]*Buys Cartrends/.test(sys));
  ok('...and the live cart', /CART: empty|CART \(live/.test(sys));
  const marker = SYSTEM.slice(0, 60);
  ok('the system prompt goes ONCE — it used to be sent twice on every call', sys.split(marker).length - 1 === 1, 'found ' + (sys.split(marker).length - 1) + ' copies');
  agentMemory._setSummarizer(null);

  const before = long.length;
  agentMemory.windowed(long, 0);
  ok('it never edits the thread it was handed', long.length === before);
  ok('an empty thread is not a crash', agentMemory.windowed([]).length === 0 && agentMemory.windowed(null).length === 0);

  // ------------------------------------ WhatsApp, as Meta's webhook sends it
  console.log('\nWHATSAPP FEATURES (offline — payloads shaped as Meta documents them)\n');
  const { CloudTransport } = require('../src/wa/cloudTransport');
  const got = [];
  const tr = new CloudTransport('customer', 'test');
  tr.onMessage(async (m) => {
    got.push(m);
    return true;
  });
  const hook = (msg) => tr.handleWebhook({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '919000000777', timestamp: '1', ...msg, id: 'wamid.T' + Math.random() }] } }] }] });
  await hook({ type: 'reaction', reaction: { message_id: 'wamid.OURS', emoji: '👍' } });
  await hook({ type: 'edit', edit: { original_message_id: 'wamid.OLD', message: { type: 'text', text: { body: '13780M68P01 25 pcs' } } } });
  await hook({ type: 'revoke', revoke: { original_message_id: 'wamid.OLD' } });
  await hook({ type: 'text', text: { body: 'ye list dekho' }, context: { forwarded: true } });
  await hook({ type: 'video', video: { caption: 'ye wala part', id: 'v1' } });
  await hook({ type: 'text', text: { body: '2' }, context: { from: '919289015775', id: 'wamid.OURS' } });
  const [rx, ed, rv, fw, vd, sw] = got;
  ok('a reaction arrives as a reaction, with the message it is on', rx && rx.reaction && rx.reaction.emoji === '👍' && rx.reaction.messageId === 'wamid.OURS');
  ok('an EDIT arrives with its new words — and an empty body, so it is never read as a fresh order', ed && ed.edit && /25 pcs/.test(ed.edit.text) && !ed.body);
  ok('a deletion arrives as a deletion', rv && rv.revoke && rv.revoke.originalId === 'wamid.OLD' && !rv.body);
  ok('a forwarded message says it was forwarded', fw && fw.forwarded === 'forwarded' && fw.body === 'ye list dekho');
  ok('the words under a video are kept, and known to be a caption', vd && vd.body === 'ye wala part' && vd.caption === 'ye wala part');
  ok('a swipe-reply carries the message it answers', sw && sw.contextId === 'wamid.OURS');

  // ---------------------------------------- what the agent is actually shown
  console.log('\nWHAT THE AGENT READS (offline)\n');
  const incoming = require('../src/agent/incoming');
  const quoted = (id) => ({ 'wamid.OURS': { dir: 'us', text: 'CTWBSI26P-16 Inch — MRP ₹599, stock hai. Kitne chahiye?' }, 'wamid.OLD': { dir: 'customer', text: '13780M68P01 20 pcs' } })[id] || null;
  const e1 = incoming.envelope(sw, { text: '2', quoted });
  ok('a swipe-reply shows the message it answers', /Swipe-reply to OUR earlier message: "CTWBSI26P-16 Inch/.test(e1) && /\n2$/.test(e1), e1);
  ok('...and says so plainly when that message is gone', /no longer have on record/.test(incoming.envelope({ contextId: 'wamid.GONE' }, { text: 'haan', quoted })));
  ok('a reaction names the emoji and the message', /Reacted 👍 to OUR message "CTWBSI26P-16/.test(incoming.envelope(rx, { quoted })));
  const e4 = incoming.envelope(ed, { quoted });
  ok('an edit shows the old words and the new', /EDITED their earlier message "13780M68P01 20 pcs"/.test(e4) && /25 pcs$/.test(e4), e4);
  ok('a deletion is marked as taken back', /DELETED their earlier message "13780M68P01 20 pcs"/.test(incoming.envelope(rv, { quoted })));
  ok('a forward is marked as someone else\'s words', /Forwarded — someone else wrote this/.test(incoming.envelope(fw, { text: fw.body, quoted })));
  ok('a caption is marked as a caption', /video \(we cannot watch videos\); the words below were written UNDER it/.test(incoming.envelope(vd, { text: vd.body, quoted })));
  ok('a plain message goes through untouched', incoming.envelope({ body: 'hello' }, { text: 'hello', quoted }) === 'hello');
  ok('the chat log says what it was, not just the words', incoming.forLog({ mediaType: 'image', body: '3pise' }) === '(photo) 3pise' && /reacted 👍/.test(incoming.forLog(rx)));

  // THE CATCH-UP: what happened in the chat while the agent was not the one
  // answering — a photo read by the order desk — is put in front of the next
  // message it does see, once.
  const conversation = require('../src/core/conversation');
  const CU = 'catchup-test@c.us';
  conversation.clear(CU);
  conversation.record(CU, 'customer', '(photo) 3pise');
  conversation.record(CU, 'us', '11 part mil gaye, order mein daal diye.');
  await new Promise((r) => setTimeout(r, 5));
  const nowAt = Date.now();
  conversation.record(CU, 'customer', 'iska rate kya hai');
  const cu = incoming.forAgent({ chatId: CU }, { text: 'iska rate kya hai', before: nowAt });
  ok('what the order desk handled reaches the agent', /order desk[\s\S]*Customer: \(photo\) 3pise[\s\S]*Us: 11 part mil gaye/.test(cu), cu);
  ok('...without the message being answered right now in it twice', (cu.match(/iska rate kya hai/g) || []).length === 1);
  incoming.markSeen(CU);
  ok('once the agent has spoken, it is not told the same thing again', incoming.forAgent({ chatId: CU }, { text: 'ok', before: Date.now() }) === 'ok');
  conversation.clear(CU);
  require('../src/core/chatState').slot('agentSeen').delete(CU);

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
  // THE AGENT WRITES THE WORDS: a price reply is its own sentence built from
  // the tool's figure — not the old template line passed through.
  {
    name: 'a price reply is written by the agent, not a template passed through',
    say: '13780M68P01 ka rate kya hai',
    check: (reply, tools) =>
      tools.includes('check_stock_and_price') && !/ - (hai|available) — /i.test(reply) && reply.length > 0,
    why: 'forwarded a template line instead of writing the reply',
  },
  // THE TEMPLATES' WORK, NOW THE AGENT'S: a photo of an order list, an
  // account, a number plate — each reached through its tool.
  {
    name: 'an order list read off a photo is checked with resolve_order_list',
    say: '[Sent a PHOTO. It reads as 3 order line(s):\n1. 13780M68P01 x 5\n2. 16510M65L10 x 10\n3. 72371M56R00 x 20]',
    check: (reply, tools) => tools.includes('resolve_order_list') && !/found and added|did not match exactly/i.test(reply),
    why: 'did not check the list with resolve_order_list, or wrote the old template',
  },
  {
    name: 'opening an account goes through account_form',
    say: 'mujhe naya account khulwana hai',
    check: (_reply, tools) => tools.includes('account_form'),
    why: 'did not use account_form',
  },
  {
    name: 'a number plate is looked up, not guessed at',
    say: 'DL7CW1692 ka front bumper chahiye',
    check: (_reply, tools) => tools.includes('lookup_vehicle'),
    why: 'did not look the plate up',
  },
  // WHATSAPP FEATURES: the notes agent/incoming puts in front of a message,
  // exactly as the bot builds them.
  {
    name: 'a swipe-reply is answered against the message it quotes',
    say: '[Swipe-reply to OUR earlier message: "CTWBSI26P-16 Inch — MRP ₹599, stock hai. Kitne chahiye?"]\n2',
    check: (reply, tools) =>
      (tools.includes('add_to_order') || /CTWBSI26P-16/i.test(reply)) && !/which part|kaun sa part|konsa part/i.test(reply),
    why: 'read "2" as a message on its own instead of the quantity for the quoted part',
  },
  {
    name: 'a 👍 on a price is not an order',
    say: '[Reacted 👍 to OUR message "13780M68P01 — MRP ₹310, stock hai. Kitne chahiye?"]',
    check: (_reply, tools) => !tools.includes('confirm_order') && !tools.includes('add_to_order'),
    why: 'treated a reaction as an order',
  },
  {
    name: 'a deleted message is not acted on',
    say: '[DELETED their earlier message "16510M65L10 10 pcs" — they took it back]',
    check: (_reply, tools) => !tools.includes('add_to_order') && !tools.includes('check_stock_and_price') && !tools.includes('confirm_order'),
    why: 'acted on a message the customer deleted',
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

// ------------------------------------------------ the ETA offer, as a tool
// 26 Sep: the parts of a placed order that were not in stock are offered to
// the customer with an ETA; their answer is the AGENT's to act on, through
// eta_offer - and the agent is told every tool it has.
async function etaChecks() {
  console.log('\nTHE ETA OFFER AND THE TOOL LIST (offline)\n');
  const agentMod = require('../src/agent');
  const { etaOffer } = require('../src/agent/tools/advance');
  const adv = require('../src/core/advanceOrders');
  const portal = require('../src/integrations/dealerPortal');
  const CustomerBot = require('../src/bots/customerBot');

  const index = agentMod._toolIndex(agentMod.TOOLS);
  ok('the prompt lists every tool the agent can call', agentMod.TOOLS.every((t) => index.includes('- ' + t.name + ':')), index);
  ok('...eta_offer among them', /- eta_offer:/.test(index));

  // A bot that only sends: the real etaOfferAnswered on a fake transport.
  const sent = [];
  const bot = {
    key: 'customer',
    transport: {
      sendToChat: async (to, text) => {
        sent.push({ to, text });
        return 'wamid.' + sent.length;
      },
      sendText: async (to, text) => {
        sent.push({ to, text });
        return 'wamid.' + sent.length;
      },
    },
    recordOutgoing() {},
    toApprovers: async (text) => {
      sent.push({ to: 'approvers', text });
      return 1;
    },
  };
  bot.etaOfferAnswered = CustomerBot.prototype.etaOfferAnswered.bind(bot);
  const CHAT = '919000000891@cloud';
  const order = { id: 'ORD-ETA1', portalCustomer: { buyerId: 345, name: 'Eta Motors' }, lines: [] };
  await adv.offer(bot, { order, res: { skipped: [{ partNo: 'Q1', item: 'Q1', qty: 3 }], short: [] }, soNumber: 'SO-1', to: CHAT, customerName: 'Eta Motors', agentChat: 'agentchat@cloud', agentName: 'Shubham' });
  const cfg = { configurable: { chatId: CHAT, bot } };

  const shown = JSON.parse(await etaOffer.invoke({ action: 'show' }, cfg));
  ok('"show" gives the parts, the ETA date and what ETA means', shown.open && shown.parts[0].partNo === 'Q1' && shown.parts[0].qty === 3 && /estimated time of arrival/.test(shown.whatEtaMeans), JSON.stringify(shown));

  // The context the model is sent names the open offer.
  const { createMiddleware } = require('langchain');
  const { SystemMessage } = require('@langchain/core/messages');
  const { z } = require('zod');
  const mw = require('../src/agent/memory').contextMiddleware({ createMiddleware, z });
  let sys = '';
  await mw.wrapModelCall({ messages: [], state: {}, systemMessage: new SystemMessage('X'), runtime: { configurable: { chatId: CHAT } } }, async (req) => {
    sys = String(req.systemMessage.content);
    return null;
  });
  ok('the model is told an ETA offer is open, and which tool answers it', /ETA OFFER OPEN[\s\S]*Q1 x3[\s\S]*eta_offer/.test(sys), sys.slice(-400));

  const before = (portal._mockAdvance() || []).length;
  const booked = JSON.parse(await etaOffer.invoke({ action: 'accept' }, cfg));
  ok('"accept" books the advance order and returns its number', booked.booked && /^ADV-/.test(booked.advanceOrderNo) && portal._mockAdvance().length === before + 1, JSON.stringify(booked));
  ok('...the salesman who punched it is told', sent.some((s) => s.to === 'agentchat@cloud' && /advance order/i.test(s.text)));
  ok('...and the Sales Heads', sent.some((s) => s.to === 'approvers' && /Advance order/.test(s.text)));
  const again = JSON.parse(await etaOffer.invoke({ action: 'accept' }, cfg));
  ok('a second "accept" books nothing more', again.open === false && portal._mockAdvance().length === before + 1, JSON.stringify(again));

  await adv.offer(bot, { order: { ...order, id: 'ORD-ETA2' }, res: { skipped: [{ partNo: 'Q2', item: 'Q2', qty: 1 }], short: [] }, soNumber: 'SO-2', to: CHAT, customerName: 'Eta Motors' });
  const no = JSON.parse(await etaOffer.invoke({ action: 'decline' }, cfg));
  ok('"decline" books nothing', no.declined && portal._mockAdvance().length === before + 1, JSON.stringify(no));
  const none = JSON.parse(await etaOffer.invoke({ action: 'show' }, { configurable: { chatId: 'nobody@cloud', bot } }));
  ok('with no offer open, the tool says so', none.open === false);
}

(async () => {
  await toolChecks();
  await etaChecks();
  await agentChecks();
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : '') + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
