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

const checkStockAndPrice = tool(
  async ({ partNumbers }, config) => {
    const ctx = contextFrom(config);
    const wanted = (partNumbers || []).map((p) => String(p || '').trim()).filter(Boolean);
    if (!wanted.length) return JSON.stringify({ error: 'no part numbers were given' });

    let lines = [];
    try {
      lines = await availability.resolve(wanted.map((p) => ({ item: p, qty: 1 })), ctx.customer);
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
    const eta = appConfig.onOrderEtaDays;
    return JSON.stringify({
      parts: lines.map((l) => {
        const src = l.source || 'unknown';
        return {
          partNo: l.partNo || l.item,
          name: availability.displayName(l),
          status:
            src === 'available'
              ? 'in_stock'
              : src === 'partial'
                ? 'part_in_stock_rest_on_order'
                : src === 'unavailable'
                  ? 'on_order'
                  : src === 'unidentified'
                    ? 'not_recognised_by_portal'
                    : 'not_confirmed_yet',
          // Already correct for THIS customer and already censored: the only
          // money that may be stated. Quote it exactly; never convert,
          // discount or multiply it.
          price: availability.priceOf(l).replace(/^\s*—\s*/, '') || null,
          etaDays: src === 'unavailable' || src === 'partial' ? eta : null,
        };
      }),
    });
  },
  {
    name: 'check_stock_and_price',
    description:
      'Ask the dealer portal whether we have these parts and what they cost. ALWAYS call this once you have a part number — the customer should get the price without having to ask for it. ' +
      'Takes exact part numbers only, never a description; get the number from lookup_known_part, search_catalogue_index or search_portal_catalogue first. Several numbers in one call is cheaper than one call each. ' +
      'Returns FACTS per part; you write the reply. The "price" field is already correct for THIS customer and is the only money you may state — quote it exactly as given. If it is null, say nothing about price. Never calculate, discount, total or convert a price yourself. ' +
      'Status: "in_stock"; "part_in_stock_rest_on_order" (some now, the rest in etaDays days); "on_order" — we do not have it today but can get it, so say it arrives in about etaDays days, NEVER that it is not available; "not_recognised_by_portal" — do not tell the customer it does not exist, call ask_a_person; "not_confirmed_yet" — say you are confirming it.',
    schema: z.object({
      partNumbers: z.array(z.string()).describe('exact dealer part numbers, e.g. ["CTWBSI26P-16 Inch", "13780M68P01"]'),
    }),
  },
);

module.exports = { checkStockAndPrice };
