'use strict';
// AFTER THE ORDER: where is it, what was billed, what is short.
//
// Every one of these is a read against the dealer portal, and each returns
// text that core/customerLookup has already built and already phrased in the
// customer's language. Pass it through; do not rebuild it, and do not add a
// date or a status of your own to it.
const { tool } = require('langchain');
const { z } = require('zod');

const customerLookup = require('../../core/customerLookup');
const customers = require('../../core/customers');
const { contextFrom, translatorFor } = require('../context');

const lookupCustomer = tool(
  async (_input, config) => {
    const ctx = contextFrom(config);
    if (!ctx.phone) return JSON.stringify({ known: false });
    let who = null;
    try {
      who = await customers.resolve(ctx.phone);
    } catch (e) {
      return JSON.stringify({ known: false, why: 'the portal did not answer' });
    }
    if (!who || !who.found) {
      return JSON.stringify({
        known: false,
        note: 'this number is not registered with us. They can still be quoted MRP and can still order, but they will not get their own rate. Do not mention accounts unless they ask.',
      });
    }
    // The account id itself is deliberately NOT returned: pricing already
    // happens against it inside the other tools, and a number in the
    // conversation is a number that can end up in a reply.
    return JSON.stringify({ known: true, name: who.name || null });
  },
  {
    name: 'lookup_customer',
    description:
      'Find out whether this number is a registered customer and what their name is. Useful for greeting them properly, and for knowing whether they get their own rate or only MRP. Reads only. You do not need to call this before quoting a price — pricing already uses their account automatically.',
    schema: z.object({}),
  },
);

const orderStatus = tool(
  async ({ orderId }, config) => {
    const ctx = contextFrom(config);
    const t = translatorFor(ctx.chatId);
    const id = String(orderId || '').trim();
    try {
      if (id) return JSON.stringify({ reply: await customerLookup.trackText(id, t) });
      // No order named: show them their recent ones so they can pick.
      const who = await customers.resolve(ctx.phone);
      if (!who || !who.found) return JSON.stringify({ reply: null, why: 'this number has no account, so there are no orders to show' });
      return JSON.stringify({ reply: await customerLookup.ordersFor(who, t) });
    } catch (e) {
      return JSON.stringify({ reply: null, why: 'the portal did not answer', askAPerson: true });
    }
  },
  {
    name: 'order_status',
    description:
      'Where an order has got to — dispatched, billed, pending. Give the order number when the customer names one; leave it out to list their recent orders so they can say which one they mean. ' +
      'The "reply" it returns is ready to send as it stands. Never invent a delivery date.',
    schema: z.object({ orderId: z.string().optional().describe('the order number the customer named, if any') }),
  },
);

const invoiceStatus = tool(
  async ({ orderId }, config) => {
    const ctx = contextFrom(config);
    try {
      return JSON.stringify({ reply: await customerLookup.invoiceStatusText(String(orderId).trim(), translatorFor(ctx.chatId)) });
    } catch (e) {
      return JSON.stringify({ reply: null, why: 'the portal did not answer', askAPerson: true });
    }
  },
  {
    name: 'invoice_status',
    description: 'Whether an order has been invoiced, and its bill details. Needs the order number. Use for "bill bheja?", "invoice number kya hai". The reply is ready to send.',
    schema: z.object({ orderId: z.string().describe('the order number') }),
  },
);

const reportShortShipment = tool(
  async (_input, config) => {
    const ctx = contextFrom(config);
    const t = translatorFor(ctx.chatId);
    try {
      const who = await customers.resolve(ctx.phone);
      if (!who || !who.found) return JSON.stringify({ reply: null, why: 'this number has no account', askAPerson: true });
      return JSON.stringify({ reply: await customerLookup.shortageText(who.name, t) });
    } catch (e) {
      return JSON.stringify({ reply: null, why: 'the portal did not answer', askAPerson: true });
    }
  },
  {
    name: 'check_shortages',
    description:
      'What was ordered but not supplied in full — the open shortage list for this customer. Use for "maal kam aaya", "2 pieces missing", "short supply". ' +
      'If it comes back with nothing and the customer insists something is missing, call ask_a_person rather than arguing with them.',
    schema: z.object({}),
  },
);

const partStatus = tool(
  async ({ partNumber }, config) => {
    const ctx = contextFrom(config);
    try {
      return JSON.stringify({ reply: await customerLookup.partStatusText(String(partNumber).trim(), translatorFor(ctx.chatId)) });
    } catch (e) {
      return JSON.stringify({ reply: null, why: 'the portal did not answer', askAPerson: true });
    }
  },
  {
    name: 'part_status',
    description:
      'Where one PART has got to across this customer\'s open orders — ordered, allocated, billed. Different from check_stock_and_price, which is about buying it now. Use for "wo part kab aayega jo maine order kiya tha".',
    schema: z.object({ partNumber: z.string().describe('the part number they are asking about') }),
  },
);

module.exports = { lookupCustomer, orderStatus, invoiceStatus, reportShortShipment, partStatus };
