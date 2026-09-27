'use strict';
// WHAT IT COSTS AND WHETHER WE HAVE IT — from the portal, every time.
//
// This is the only tool that may talk about money, and it is written so that
// the model cannot see a number it must not repeat. The portal prices against
// an ACCOUNT; when it does not know the customer it prices against ours, and
// on 23 Sep that meant a Rs.187 rate against a Rs.799 MRP — a 76% discount
// belonging to account 3822 and to nobody who was asking.
//
// So priceOf() runs in here and only its OUTPUT is returned. The raw rate
// never enters the conversation.
const { tool } = require('langchain');
const { z } = require('zod');

// Named apart from the tools' own `config` argument (LangChain's run config).
const appConfig = require('../../config');
const availability = require('../../core/availability');
const store = require('../../store');
const { contextFrom } = require('../context');
const portal = require('../../integrations/dealerPortal');
const { partFacts } = require('./partFacts');

// The customer's discounts that apply today — so the reply can say "aapka
// MARUTI par 10% discount laga hai" under the list. Empty for a number the
// portal does not know: nobody else's discount is ever shown.
async function discountsOf(customer) {
  if (!customer || !customer.buyerId) return [];
  return portal.activeDiscounts(customer.buyerId).catch(() => []);
}

// What each status means, and how the reply is built. Shared with
// resolve_order_list (agent/tools/workflows), which answers a whole list.
const STATUS_HELP =
  'Each part: "in_stock" — their quantity is there; "short" — we can send canSupplyNow of the qtyAsked now and the rest (restOnOrder) comes in about etaDays days: SAY BOTH NUMBERS; "out_of_stock" — none today, it comes in about etaDays days (say that, never "not available"); "not_recognised_by_portal" — never say it does not exist, call ask_a_person; "not_confirmed_yet" — say you are confirming it. ' +
  'When they sent a part number or a list, answer with ONE short list, a line per part: the part, whether it is in stock / how many now and when the rest / out of stock and when, and its price. ' +
  'Where a part has "discount", its line says so: MRP, their discount % and the price after it (GST included) — e.g. "35121M55RB0 — MRP Rs.21310, 10% discount → Rs.19179 (GST incl.)". If yourDiscounts is not empty, end with one line naming them (e.g. "Aapka MARUTI parts par 10% discount laga hai, 26 Sep tak"). ' +
  'The price field is already right for THIS customer — quote it exactly; never calculate, discount, total or convert a price yourself. Never tell them how many we have in stock; the only count you may say is canSupplyNow when we are short. If qtyAsked is null they did not say how many: ask.';

const checkStockAndPrice = tool(
  async ({ partNumbers, quantities }, config) => {
    const ctx = contextFrom(config);
    const wanted = (partNumbers || []).map((p) => String(p || '').trim()).filter(Boolean);
    if (!wanted.length) return JSON.stringify({ error: 'no part numbers were given' });

    let lines = [];
    try {
      // AGAINST THE QUANTITY THEY NEED. Asked for one piece, "in stock" is true
      // with five on the shelf and twenty wanted — and the customer is told
      // yes. With their quantity, the portal answers for their order.
      const qtyOf = (i) => Math.max(1, Math.floor(Number((quantities || [])[i])) || 1);
      lines = await availability.resolve(wanted.map((p, i) => ({ item: p, qty: qtyOf(i) })), ctx.customer);
    } catch (e) {
      store.log('agent', 'stock check failed: ' + String((e && e.message) || e).slice(0, 90));
      return JSON.stringify({ error: 'the dealer portal did not answer', askAPerson: true });
    }

    // FACTS, NOT A SENTENCE. This used to hand back a finished line ("… - hai
    // — MRP Rs.310") and the model forwarded it; now the model writes the
    // reply itself. The facts are the ones that line was built from, with the
    // statuses named for what they MEAN to the customer — "unavailable" read
    // as "not available", which is the one thing the founder said never to
    // say: we can get it, and the answer is when.
    const qtyAt = (i) => Math.max(1, Math.floor(Number((quantities || [])[i])) || 1);
    const given = (i) => Number((quantities || [])[i]) > 0;
    return JSON.stringify({
      parts: lines.map((l, i) => partFacts(l, { asked: wanted[i], qty: qtyAt(i), qtyGiven: given(i) })),
      yourDiscounts: await discountsOf(ctx.customer),
    });
  },
  {
    name: 'check_stock_and_price',
    description:
      'Ask the dealer portal whether we have these parts and what they cost. ALWAYS call this once you have a part number — the customer should get the price without having to ask for it. ' +
      'Takes exact part numbers only, never a description; get the number from lookup_known_part, search_catalogue_index or search_portal_catalogue first. Several numbers in one call is cheaper than one call each. ' +
      'Returns FACTS per part; you write the reply. The "price" field is already correct for THIS customer and is the only money you may state — quote it exactly as given. If it is null, say nothing about price. Never calculate, discount, total or convert a price yourself. ' +
      STATUS_HELP,
    schema: z.object({
      partNumbers: z.array(z.string()).describe('exact dealer part numbers, e.g. ["CTWBSI26P-16 Inch", "13780M68P01"]'),
      quantities: z
        .array(z.number())
        .optional()
        .describe('how many pieces they need of each part, in the same order as partNumbers — give it whenever they have said, so "in_stock" means THEIR quantity is there'),
    }),
  },
);

// "Mera discount kitna hai", "kis par discount hai" — the customer's own
// rules that apply today. 25 Sep, live: that question went to a person.
const myDiscounts = tool(
  async (_input, config) => {
    const ctx = contextFrom(config);
    if (!ctx.customer || !ctx.customer.buyerId) return JSON.stringify({ registered: false, note: 'this number has no account, so no discount — prices are MRP' });
    const list = await discountsOf(ctx.customer);
    return JSON.stringify(
      list.length
        ? { discounts: list, note: 'these are already in every price check_stock_and_price gives them. Discounts are set up only by our sales team: if they want a new one or a change, say their sales representative will take it up, and call ask_a_person with what they asked.' }
        : { discounts: [], note: 'no discount on this account today — prices are MRP. Discounts are set up only by our sales team: if they want one, say their sales representative will take it up, and call ask_a_person with what they asked.' },
    );
  },
  {
    name: 'my_discounts',
    description:
      "The customer's own discounts that apply today: on which brand or part, how much %, from what quantity, and until when. Use when they ask what discount they get, or which parts have one. Reads only.",
    schema: z.object({}),
  },
);

module.exports = { checkStockAndPrice, myDiscounts, STATUS_HELP, discountsOf };
