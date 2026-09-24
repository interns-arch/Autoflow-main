'use strict';
// THE CART.
//
// Everything here goes through core/orders, which owns the draft, the
// quantity rules, the staleness re-check and the one-punch-per-order lock.
// These tools add no logic of their own; they exist so the agent can reach
// that module without being given the chat id.
//
// confirm_order is the only tool in the whole set with a side effect the
// customer cannot undo, and the ORDER_CONFIRM_ENABLED gate sits inside
// core/orders.confirm, below this, where no prompt can reach it.
const { tool } = require('langchain');
const { z } = require('zod');

const orders = require('../../core/orders');
const availability = require('../../core/availability');
const store = require('../../store');
const { contextFrom } = require('../context');

const NO_CART = JSON.stringify({ cart: 'empty', note: 'nothing has been added yet' });

function draftFor(ctx, create) {
  if (!ctx.chatId) return null;
  return create ? orders.getOrCreateDraft(ctx.chatId, ctx.customer) : orders.findDraft(ctx.chatId);
}

function cartState(order) {
  if (!order || !order.lines.length) return NO_CART;
  return JSON.stringify({
    cart: order.lines.map((l) => ({
      partNo: l.partNo || l.item,
      name: availability.displayName(l),
      qty: l.qty,
      status: l.source || 'unknown',
      price: availability.priceOf(l).replace(/^\s*—\s*/, '') || null,
    })),
    // No ready-made summary: the agent lists the cart itself, from these
    // lines, numbered the way the customer expects. It adds no total — a sum
    // it worked out is a figure no tool gave it.
  });
}

const showCart = tool(
  async (_input, config) => cartState(draftFor(contextFrom(config), false)),
  {
    name: 'show_cart',
    description:
      'Show what is currently in this customer\'s cart, with quantities and prices. Use when they ask what they have ordered, before confirming, or whenever you need to know what is already there before adding to it. Reads only — changes nothing.',
    schema: z.object({}),
  },
);

const addToOrder = tool(
  async ({ items }, config) => {
    const ctx = contextFrom(config);
    const wanted = (items || []).filter((i) => i && String(i.partNumber || '').trim());
    if (!wanted.length) return JSON.stringify({ error: 'no part numbers were given' });
    // Gemini will not carry a minimum in the schema, so the floor lives here
    // — where the other guards live anyway. A zero or a minus quantity is a
    // misread, not an instruction to remove the line.
    const bad = wanted.find((i) => !Number.isInteger(Number(i.qty)) || Number(i.qty) < 1);
    if (bad) return JSON.stringify({ error: 'quantity for ' + bad.partNumber + ' must be a whole number of at least 1 — ask the customer how many they want' });

    let resolved = [];
    try {
      resolved = await availability.resolve(
        wanted.map((i) => ({ item: String(i.partNumber).trim(), qty: Number(i.qty) || 1 })),
        ctx.customer,
      );
    } catch (e) {
      store.log('agent', 'add to cart failed at the portal: ' + String((e && e.message) || e).slice(0, 80));
      return JSON.stringify({ error: 'the dealer portal did not answer, nothing was added', askAPerson: true });
    }

    const order = draftFor(ctx, true);
    if (!order) return JSON.stringify({ error: 'no conversation to attach a cart to' });
    orders.addLines(order, resolved);
    return cartState(order);
  },
  {
    name: 'add_to_order',
    description:
      'Add parts to the cart. Takes exact part numbers with quantities — never a description. ' +
      'Only call this when the customer has actually asked for the part, not merely asked its price. If they did not say how many, ask them first rather than assuming one. ' +
      'Prices and stock are re-checked as part of adding, so the cart it returns is current. Returns the updated cart.',
    schema: z.object({
      items: z
        .array(z.object({ partNumber: z.string(), qty: z.number().int() }))
        .describe('the parts to add, e.g. [{"partNumber":"CTWBSI26P-16 Inch","qty":10}]'),
    }),
  },
);

const changeQuantity = tool(
  async ({ partNumber, qty }, config) => {
    const order = draftFor(contextFrom(config), false);
    if (!order) return NO_CART;
    await orders.setQty(order, String(partNumber || '').trim(), Number(qty));
    return cartState(order);
  },
  {
    name: 'change_quantity',
    description:
      'Change how many of one part is in the cart. Use for "make it 5 instead", "2 hi chahiye". Setting it to zero removes the line. Returns the updated cart.',
    schema: z.object({
      partNumber: z.string().describe('the part number as it appears in the cart'),
      qty: z.number().int().describe('the new quantity; 0 removes it'),
    }),
  },
);

const removeFromOrder = tool(
  async ({ partNumber }, config) => {
    const order = draftFor(contextFrom(config), false);
    if (!order) return NO_CART;
    orders.removeItem(order, String(partNumber || '').trim());
    return cartState(order);
  },
  {
    name: 'remove_from_order',
    description: 'Take one part out of the cart entirely. Use for "ye hata do", "cancel the brake pads". Returns the updated cart.',
    schema: z.object({ partNumber: z.string().describe('the part number as it appears in the cart') }),
  },
);

const confirmOrder = tool(
  async (_input, config) => {
    const order = draftFor(contextFrom(config), false);
    if (!order || !order.lines.length) return NO_CART;

    let res;
    try {
      res = await orders.confirm(order);
    } catch (e) {
      store.log('agent', 'confirm failed: ' + String((e && e.message) || e).slice(0, 90));
      return JSON.stringify({ placed: false, error: 'the order could not be placed', askAPerson: true });
    }

    if (res && res.busy) return JSON.stringify({ placed: false, why: 'this order is already being placed — say nothing further about it' });
    if (res && res.blocked) return JSON.stringify({ placed: false, why: 'order placing is switched off right now', askAPerson: true });
    // Quantities moved between the quote and the yes. NOTHING was ordered.
    if (res && res.stale) {
      return JSON.stringify({
        placed: false,
        why: 'stock changed since you quoted — show these new figures and ask them to confirm again',
        cart: JSON.parse(cartState(order)),
      });
    }
    return JSON.stringify({ placed: true, orderNumber: res && res.soNumber, backordered: (res && res.backordered) || null });
  },
  {
    name: 'confirm_order',
    description:
      'Place the order that is in the cart. THIS CANNOT BE UNDONE. Call it only after the customer has clearly said yes to the cart you showed them — not on "ok", not on a part number, and never on your own initiative. ' +
      'If it comes back placed:false with "stale", the stock moved and nothing was ordered: show the new figures and wait for a fresh yes.',
    schema: z.object({}),
  },
);

const cancelOrder = tool(
  async (_input, config) => {
    const order = draftFor(contextFrom(config), false);
    if (!order) return NO_CART;
    orders.cancel(order);
    return JSON.stringify({ cancelled: true, cart: 'empty' });
  },
  {
    name: 'cancel_order',
    description: 'Throw away the whole cart without ordering anything. Use for "rehne do", "cancel everything". Does not touch orders that were already placed.',
    schema: z.object({}),
  },
);

module.exports = { showCart, addToOrder, changeQuantity, removeFromOrder, confirmOrder, cancelOrder };
