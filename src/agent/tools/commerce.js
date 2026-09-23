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

    return JSON.stringify({
      parts: lines.map((l) => ({
        partNo: l.partNo || l.item,
        name: availability.displayName(l),
        // 'available' | 'partial' | 'unavailable' (we can get it) |
        // 'unidentified' (the portal does not know this number) | 'unknown'
        status: l.source || 'unknown',
        // Already-formatted and already-censored. Repeat it as it stands;
        // never invent a figure, and never convert or discount it.
        price: availability.priceOf(l) || null,
        // A finished line in the customer's own language, safe to send.
        line: availability.describe(l, ctx.chatId),
      })),
    });
  },
  {
    name: 'check_stock_and_price',
    description:
      'Ask the dealer portal whether we have these parts and what they cost. ALWAYS call this once you have a part number — the customer should get the price without having to ask for it. ' +
      'Takes exact part numbers only, never a description; get the number from lookup_known_part, search_catalogue_index or search_portal_catalogue first. Several numbers in one call is cheaper than one call each. ' +
      'The "price" field is already correct for THIS customer and is the only money you may state. If it is null, say nothing about price. Never calculate, discount or convert a price yourself. ' +
      'Status "unidentified" means the portal does not recognise the number — do not tell the customer it does not exist; ask a person with ask_a_person.',
    schema: z.object({
      partNumbers: z.array(z.string()).describe('exact dealer part numbers, e.g. ["CTWBSI26P-16 Inch", "13780M68P01"]'),
    }),
  },
);

module.exports = { checkStockAndPrice };
