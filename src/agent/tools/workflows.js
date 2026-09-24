'use strict';
// THE WORK THE TEMPLATES USED TO DO — as tools that return FACTS.
//
// A customer's message is answered by the agent and only by the agent, which
// writes every word itself. What the template path did for them is still
// needed — an order list read off a photo, an account opened, a number plate
// looked up, their own balance — so each is a tool here. Each one does the
// same work with the same code, keeps every side effect (the account request
// still reaches the Sales Head, the portal is still asked), and hands the
// agent what happened as facts to write from.
//
// Where the existing workflow speaks in sentences — the account form's
// questions, the account summary — the sentence comes back as a FACT ("what
// the form needs next") in English, and the agent says it in the customer's
// language and its own voice. A capturing `reply` stands in for the one that
// used to send it, so nothing here reaches the customer directly.
const { tool } = require('langchain');
const { z } = require('zod');

const availability = require('../../core/availability');
const customerCreate = require('../../core/customerCreate');
const customers = require('../../core/customers');
const lookup = require('../../core/customerLookup');
const vahan = require('../../integrations/vahan');
const store = require('../../store');
// Named apart from the tools' own `config` argument (LangChain's run config).
const appConfig = require('../../config');
const { contextFrom } = require('../context');

// English, whichever language the customer writes: these are facts for the
// model, which writes the reply in theirs.
const facts = (en) => en;

// Stands in for the bot's `reply`: collects what the workflow would have sent,
// sends nothing.
function capture() {
  const said = [];
  const fn = async (text) => {
    if (text) said.push(String(text));
    return true;
  };
  fn.said = said;
  return fn;
}

const botOf = (config) => (config && config.configurable && config.configurable.bot) || null;
const messageOf = (config) => (config && config.configurable && config.configurable.message) || null;

const packOf = (partNo) => {
  const m = /(\d{1,2})PK$/i.exec(String(partNo || ''));
  return m ? Number(m[1]) : null;
};

// Status names for what they mean to the customer, as check_stock_and_price
// gives them.
function statusOf(src) {
  return src === 'available'
    ? 'in_stock'
    : src === 'partial'
      ? 'part_in_stock_rest_on_order'
      : src === 'unavailable'
        ? 'on_order'
        : src === 'unidentified'
          ? 'not_recognised_by_portal'
          : 'not_confirmed_yet';
}

// ----------------------------------------------------------- order lists
const resolveOrderList = tool(
  async ({ items }, config) => {
    const ctx = contextFrom(config);
    const want = (items || [])
      .map((i) => ({ part: String((i && i.part) || '').trim(), qty: Math.max(1, Math.floor(Number(i && i.qty)) || 1), qtyGiven: Number(i && i.qty) > 0 }))
      .filter((i) => i.part);
    if (!want.length) return JSON.stringify({ error: 'no parts were given' });

    let lines = [];
    try {
      lines = await availability.resolve(want.map((w) => ({ item: w.part, qty: w.qty })), ctx.customer);
    } catch (e) {
      return JSON.stringify({ error: 'the dealer portal did not answer', askAPerson: true });
    }

    // THE CLOSE MATCHES the template used to walk through one by one: a
    // number the portal does not know, where a catalogue part starts the
    // same way ("72371M56R00" -> "72371M56R005PK", the pack of five).
    const unknown = lines.map((l, i) => ({ l, i })).filter(({ l }) => (l.source || 'unknown') === 'unidentified');
    let close = new Map();
    const bot = botOf(config);
    if (unknown.length && bot && typeof bot.closestMatches === 'function') {
      try {
        close = await bot.closestMatches(unknown.map(({ i }) => want[i].part));
      } catch (e) {
        store.log('agent', 'closest-match search failed: ' + String((e && e.message) || e).slice(0, 80));
      }
    }

    const eta = appConfig.onOrderEtaDays;
    return JSON.stringify({
      lines: lines.map((l, i) => {
        const w = want[i] || {};
        const src = l.source || 'unknown';
        const base = { asked: w.part, qty: w.qty, qtyGiven: Boolean(w.qtyGiven) };
        if (src === 'unidentified') {
          const c = close.get(w.part);
          return c
            ? { ...base, status: 'close_match_only', closeMatch: { partNo: c.partNo, name: c.name || null, packOf: packOf(c.partNo) } }
            : { ...base, status: 'not_recognised_by_portal' };
        }
        return {
          ...base,
          partNo: l.partNo || w.part,
          name: availability.displayName(l),
          status: statusOf(src),
          price: availability.priceOf(l).replace(/^\s*—\s*/, '') || null,
          etaDays: src === 'unavailable' || src === 'partial' ? eta : null,
          packOf: packOf(l.partNo),
        };
      }),
    });
  },
  {
    name: 'resolve_order_list',
    description:
      'Check a whole ORDER LIST in one call — several part numbers with quantities, typed or read off a photo or a document. Faster than one check_stock_and_price per part, and it also finds the CLOSE MATCH for a number the portal does not know (a catalogue part that starts the same way, often the pack version). ' +
      'Returns facts per line: status, price (already right for this customer — quote it exactly), etaDays, and for "close_match_only" the suggested part. It adds nothing to the cart: when they are ordering, add the matched lines with add_to_order, then ask about each close match (a short numbered list is fine). Never tell the customer a stock count.',
    schema: z.object({
      items: z
        .array(z.object({ part: z.string().describe('the part number as written'), qty: z.number().optional().describe('how many they want, if they said') }))
        .describe('every line of the list'),
    }),
  },
);

// ----------------------------------------------------------- the account form
const accountForm = tool(
  async ({ action, forSomeoneElse, answer }, config) => {
    const ctx = contextFrom(config);
    const bot = botOf(config);
    const chatId = ctx.chatId;
    if (!chatId || !bot) return JSON.stringify({ error: 'no conversation to open an account in' });

    if (action === 'cancel') {
      customerCreate.cancel(chatId);
      return JSON.stringify({ cancelled: true });
    }

    const open = customerCreate.pending(chatId);

    if (action === 'start') {
      if (open) return JSON.stringify({ alreadyInProgress: true, note: 'a form is already open — use action "answer" with what they say' });
      if (!forSomeoneElse) {
        // A registered customer asking for "an account" is, almost always,
        // opening one for somebody else — a friend's garage, a second shop.
        const already = await customers.resolve(ctx.phone).catch(() => ({ found: null }));
        if (already && already.found === null) return JSON.stringify({ error: 'the portal is not answering, so we cannot tell whether they already have an account — ask them to try again in a few minutes' });
        if (already && already.found) {
          return JSON.stringify({
            alreadyRegistered: true,
            name: already.name || null,
            note: 'they already have an account. Ask whether this one is for someone else; if yes, call again with forSomeoneElse: true',
          });
        }
      }
      const first = customerCreate.start(chatId, ctx.phone, facts, { forSomeoneElse: Boolean(forSomeoneElse) });
      return JSON.stringify({ started: true, forSomeoneElse: Boolean(forSomeoneElse), nextQuestion: first });
    }

    if (action === 'answer') {
      if (!open) return JSON.stringify({ inProgress: false, note: 'no account form is open' });
      // The message itself, so a shop photo or a dropped pin reaches the form.
      const m = { ...(messageOf(config) || { chatId, from: ctx.phone }), chatId, from: ctx.phone };
      const said = String(answer != null ? answer : m.body || '').trim();
      const step = await customerCreate.answer(chatId, m, said, facts);
      if (!step) return JSON.stringify({ inProgress: false });
      const reply = capture();
      if (step.done) {
        await bot.finishNewCustomer(m, step.form, reply, facts);
        return JSON.stringify({ done: true, requestId: (step.form && step.form.answers && step.form.answers.requestId) || null, whatHappened: reply.said });
      }
      if (step.review) {
        await bot.reviewNewCustomer(m, step, reply, facts);
        return JSON.stringify({ done: 'sent_for_review', whatHappened: reply.said });
      }
      // The next question, or what was wrong with the answer — as a fact.
      return JSON.stringify({ inProgress: Boolean(customerCreate.pending(chatId)), formSays: step.reply || null });
    }

    // status
    return JSON.stringify(open ? { inProgress: true, forSomeoneElse: Boolean(open.forSomeoneElse) } : { inProgress: false });
  },
  {
    name: 'account_form',
    description:
      'Open a customer account on the portal, one question at a time: GST number, shop name, a photo of the shop, a location pin and so on. The request then goes to the Sales Head for approval. ' +
      'action "start" when they ask to open an account (forSomeoneElse: true when it is for someone else); "answer" with what they said whenever a form is open — a photo or a location they send is passed on automatically; "cancel" if they drop it; "status" to check. ' +
      'It returns what the form needs next ("nextQuestion" / "formSays") as a fact: ask it in your own words and the customer\'s language, one question at a time.',
    schema: z.object({
      action: z.enum(['start', 'answer', 'cancel', 'status']),
      forSomeoneElse: z.boolean().optional().describe('the account is for another person or shop, not this number'),
      answer: z.string().optional().describe('the customer\'s answer, exactly as they wrote it'),
    }),
  },
);

// ----------------------------------------------------------- vehicles
const lookupVehicle = tool(
  async ({ plate }) => {
    if (!vahan.enabled()) return JSON.stringify({ found: false, why: 'vehicle lookup is not available — ask them for the make, model and year' });
    const p = vahan.plateIn(plate) || String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!p) return JSON.stringify({ found: false, why: 'that is not a number plate' });
    let car = null;
    try {
      car = await vahan.lookup(p);
    } catch (e) {
      return JSON.stringify({ found: false, why: 'the vehicle registry did not answer — ask for the make, model and year' });
    }
    if (!car) return JSON.stringify({ found: false, plate: p, why: 'no record for this plate' });
    return JSON.stringify({ found: true, plate: p, maker: car.maker || null, model: car.model || null, variant: car.variant || null, fuel: car.fuel || null, year: car.year || null });
  },
  {
    name: 'lookup_vehicle',
    description:
      'Look up a car from its NUMBER PLATE (e.g. "DL7CW1692"): maker, model, variant, fuel and year from the national registry. Use it when they send a plate instead of naming the car, then find the part for that car. Confirm the car with them in a few words before you rely on it.',
    schema: z.object({ plate: z.string().describe('the number plate as they wrote it') }),
  },
);

// ----------------------------------------------------------- their own account
const myAccount = tool(
  async ({ about }, config) => {
    const ctx = contextFrom(config);
    const intent = about === 'credit_notes' ? 'credit' : about === 'billed' ? 'billed' : about === 'orders' ? 'status' : 'ledger';
    let said = null;
    try {
      said = await lookup.answerOwn(ctx.phone, intent, facts);
    } catch (e) {
      return JSON.stringify({ error: 'the account could not be opened right now' });
    }
    if (!said) return JSON.stringify({ found: false, why: 'no account for this number, or nothing on it' });
    // The account system's own summary, as facts: their balance and bills are
    // theirs to see. Say it plainly in your words; every figure exactly as it is.
    return JSON.stringify({ found: true, account: said });
  },
  {
    name: 'my_account',
    description:
      'THIS customer\'s own account: "balance" (what they owe, credit limit, recent bills), "credit_notes", "billed" (whether recent orders were billed) or "orders". Only ever their own — never another customer\'s. Returns the account system\'s summary as facts; tell them in your own words, every figure exactly as given.',
    schema: z.object({ about: z.enum(['balance', 'credit_notes', 'billed', 'orders']) }),
  },
);

module.exports = { resolveOrderList, accountForm, lookupVehicle, myAccount };
