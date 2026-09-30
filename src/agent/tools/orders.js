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
  const order = create ? orders.getOrCreateDraft(ctx.chatId, ctx.customer) : orders.findDraft(ctx.chatId);
  // THE CUSTOMER THE PORTAL PRICES AND BILLS. core/orders reads
  // order.portalCustomer — for the rate (their discount) and for
  // selected_buyer_id on confirm. The agent's carts only ever set
  // order.customer, so 25 Sep, live, portal order 1214 went in with no buyer:
  // no customer on the order, no Odoo SO, and Disc 0% on the line.
  if (order && ctx.customer && ctx.customer.buyerId && !(order.portalCustomer && order.portalCustomer.buyerId)) {
    order.portalCustomer = ctx.customer;
    store.save();
  }
  return order;
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

    // NO ACCOUNT, NO CART (founder, 28 Sep): a number with no account on the
    // portal can search parts and hear prices, but nothing goes into a cart
    // until the account exists - there is nobody to bill it to. Said at once,
    // at the moment they want to add it, not after a cart has been built.
    if (!(ctx.customer && (ctx.customer.buyerId || ctx.customer.accountId))) {
      store.log('agent', `${ctx.phone}: wanted ${wanted.map((i) => i.partNumber + ' x' + i.qty).join(', ')} in the cart — no account yet, nothing added`);
      return JSON.stringify({
        added: false,
        noAccount: true,
        wanted: wanted.map((i) => ({ partNumber: i.partNumber, qty: Number(i.qty) })),
        tellCustomer:
          'Nothing was added: this number has no account with us yet, and an order needs one. Tell them warmly and respectfully, in their language, that their account has to be created first and that you will add these parts to the cart as soon as it is; offer to create it now (account_form "start"). Do not say anything was added or reserved.',
      });
    }

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

    // PAYMENT FIRST (founder, 25 Sep). A customer who still owes Rs 1 or
    // more gets no new order until it is settled: the order is held, the
    // amount and a payment QR go to them, and the accountant confirms it
    // (core/payments). The held order goes on by itself once it is settled.
    const bot = config && config.configurable && config.configurable.bot;
    const ctxNow = contextFrom(config);
    if (bot && bot.holdForPayment && ctxNow.customer && ctxNow.customer.buyerId) {
      const hold = await bot.holdForPayment(order, ctxNow.customer).catch((e) => {
        store.log('agent', 'due check failed: ' + String((e && e.message) || e).slice(0, 90));
        return null;
      });
      // A cheque is in but does not cover it all (founder, 29 Sep): the
      // total, the cheque and what is still to pay, all three said.
      if (hold && hold.chequeAmount > 0) {
        return JSON.stringify({
          placed: false,
          paymentDue: true,
          totalDue: 'Rs.' + hold.owed,
          chequeReceived: 'Rs.' + hold.chequeAmount,
          cheques: hold.cheques.map((c) => ({ number: c.number, amount: 'Rs.' + c.amount, date: c.date, status: c.status })),
          stillToPay: 'Rs.' + hold.due,
          paymentRequest: hold.req.id,
          qrSent: hold.qrSent,
          why:
            'Their cheque has been received and counted, but it does not cover everything they owe. Tell them, in their language, all three: the total due (' + ('Rs.' + hold.owed) + '), the cheque received (' + ('Rs.' + hold.chequeAmount) + ', with its number and date), and the amount still to pay (' + ('Rs.' + hold.due) + '). The new order is kept and goes ahead once that remaining amount is paid and confirmed' +
            (hold.qrSent ? '; a payment QR for the remaining amount has been sent to them just now' : '; our team will share how to pay') +
            '. When they say they have paid, call payment_done. It is NOT placed and NOT sent for approval yet.',
        });
      }
      if (hold) {
        return JSON.stringify({
          placed: false,
          paymentDue: true,
          amountDue: 'Rs.' + hold.due,
          paymentRequest: hold.req.id,
          qrSent: hold.qrSent,
          why:
            'Their previous balance is not settled. Give them a GENTLE, warm reminder in their language - thank them for the order first, then say politely that ' + ('Rs.' + hold.due) + ' from earlier is still pending on their account, and that the new order is kept ready and goes ahead the moment the payment is received' +
            (hold.qrSent ? '; the payment QR has been sent to them just now' : '; our team will share how to pay') +
            '. Never sound like a demand or a refusal. When they say they have paid, call payment_done. It is NOT placed yet.',
        });
      }
    }

    let res;
    try {
      res = await orders.confirm(order);
    } catch (e) {
      store.log('agent', 'confirm failed: ' + String((e && e.message) || e).slice(0, 90));
      return JSON.stringify({ placed: false, error: 'the order could not be placed', askAPerson: true });
    }

    if (res && res.busy) return JSON.stringify({ placed: false, why: 'this order is already being placed — say nothing further about it' });
    // A number the portal has no account for: there is nobody to bill.
    if (res && res.noCustomer) {
      return JSON.stringify({ placed: false, why: 'this number has no account on our system, so the order cannot be placed - not on any other account either, whatever GST number or shop name they gave. Tell them in a line, and offer to open THEIR OWN account (account_form "start").' });
    }
    // Placing is switched off: the order goes to the Sales Head, and his
    // "OK ORD-…" places it on the portal (customerBot.decideOrder). 25 Sep,
    // live: this used to be handed to a person as a question, he answered
    // "Allow", nothing was placed, and the customer was told it had been.
    if (res && res.blocked) {
      const bot = config && config.configurable && config.configurable.bot;
      const sent = bot && bot.requestOrderApproval ? await bot.requestOrderApproval(order).catch(() => 0) : 0;
      if (!sent) return JSON.stringify({ placed: false, why: 'the order could not be sent for approval', askAPerson: true });
      return JSON.stringify({
        placed: false,
        sentForApproval: true,
        requestId: order.id,
        ...chequeFacts(order),
        why: 'orders are placed once the Sales Head approves them. It has gone to him; the customer will get the portal order number when he does. Say exactly that — it is NOT placed yet.',
      });
    }
    // LOSS BILLING (founder, 30 Sep): below our cost, so it waits for Prateek
    // Sir's OK before it is punched. Cost, margin and loss are ours alone.
    if (res && res.loss) {
      const sent = bot && bot.requestOrderApproval ? await bot.requestOrderApproval(order, { loss: res.loss }).catch(() => 0) : 0;
      if (!sent) return JSON.stringify({ placed: false, why: 'the order could not be sent for its final check', askAPerson: true });
      return JSON.stringify({
        placed: false,
        pendingFinalCheck: true,
        requestId: order.id,
        why: 'the order is received and goes through one final check by our team before it is placed; the customer gets the order number as soon as it is placed. Thank them warmly and say exactly that. NEVER mention cost, margin, loss or approval of pricing - that is internal. It is NOT placed yet.',
      });
    }
    // Nothing in the cart is in stock, and only stock is punched (founder,
    // 14 Sep). No order exists: never let this read as placed.
    if (res && res.nothingInStock) {
      return JSON.stringify({
        placed: false,
        why: 'nothing in the cart is in stock, so no order was placed on the portal. They are on order; say when they can come, and ask_a_person if they want them ordered anyway',
      });
    }
    // Quantities moved between the quote and the yes. NOTHING was ordered.
    if (res && res.stale) {
      return JSON.stringify({
        placed: false,
        why: 'stock changed since you quoted — show these new figures and ask them to confirm again',
        cart: JSON.parse(cartState(order)),
      });
    }
    return JSON.stringify({ placed: true, orderNumber: res && res.soNumber, backordered: (res && res.backordered) || null, ...chequeFacts(order) });
  },
  {
    name: 'confirm_order',
    description:
      'Place the order that is in the cart. THIS CANNOT BE UNDONE. Call it only after the customer has clearly said yes to the cart you showed them — not on "ok", not on a part number, and never on your own initiative. ' +
      'If it comes back placed:false with "stale", the stock moved and nothing was ordered: show the new figures and wait for a fresh yes.',
    schema: z.object({}),
  },
);

// A due that Odoo still shows but their cheque covers (customerBot
// holdForPayment sets it): said with the news, so they know it was counted.
function chequeFacts(order) {
  const c = order && order.chequeCovered;
  if (!c) return {};
  return {
    dueCoveredByCheque: { totalDue: 'Rs.' + c.owed, chequeReceived: 'Rs.' + c.chequeAmount, stillToPay: 'Rs.0' },
    chequeNote: 'Their cheque covers what they owed, so the order went ahead: mention it in a line (total due, cheque received, nothing left to pay).',
  };
}

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

// "Payment kar diya", "paid", "transfer done", a payment screenshot: the
// accountant is asked to check it (core/payments, customerBot.paymentClaimed).
const paymentDone = tool(
  async ({ whatTheySaid }, config) => {
    const ctx = contextFrom(config);
    const bot = config && config.configurable && config.configurable.bot;
    if (!bot || !bot.paymentClaimed) return JSON.stringify({ error: 'payments are not available here', askAPerson: true });
    if (!ctx.customer || !ctx.customer.buyerId) return JSON.stringify({ error: 'this number has no account, so there is no balance to settle', askAPerson: true });
    const r = await bot.paymentClaimed(ctx.chatId, ctx.phone, ctx.customer, whatTheySaid || null).catch(() => ({ unknown: true }));
    if (r.nothingDue) return JSON.stringify({ nothingDue: true, note: 'their account shows nothing due — tell them their balance is already settled' });
    if (r.unknown) return JSON.stringify({ error: 'the balance could not be read right now', askAPerson: true });
    if (!r.sent) return JSON.stringify({ error: 'the accountant could not be reached', askAPerson: true });
    return JSON.stringify({
      sentToAccountant: true,
      paymentRequest: r.req.id,
      note: 'Tell them: thank you, our accounts team is checking the payment; they will hear as soon as it is confirmed' + (r.req.orderId ? ', and then their order goes for approval' : '') + '. Do NOT say it is confirmed or settled.',
    });
  },
  {
    name: 'payment_done',
    description:
      'The customer says they have paid what they owed ("payment kar diya", "paid", "transfer ho gaya", or sends a payment screenshot). Sends it to our accountant to check. Call it once per claim; the customer is told the result when the accountant confirms.',
    schema: z.object({ whatTheySaid: z.string().optional().describe('their words about the payment, e.g. "22000 bhej diya UPI se"') }),
  },
);

module.exports = { showCart, addToOrder, changeQuantity, removeFromOrder, confirmOrder, cancelOrder, paymentDone };
