'use strict';
// PARTS ON ORDER, OFFERED WITH AN ETA (founder, 26 Sep): once an order is
// placed, whatever could not be punched is offered to the customer with its
// ETA (core/advanceOrders), and booked on the portal as an ADVANCE ORDER only
// when they say yes. The offer goes out as a message; their answer comes to
// the agent, which acts on it with this tool.
//
// Returns FACTS, never sentences: the agent words the reply. The booking
// itself, and telling the salesman and the Sales Heads, happen inside
// customerBot.etaOfferAnswered - the same code the no-agent path uses.
const { tool } = require('langchain');
const { z } = require('zod');

const advanceOrders = require('../../core/advanceOrders');
const { contextFrom } = require('../context');

const ETA_MEANS =
  'ETA = "estimated time of arrival": the date we expect these parts to reach our warehouse from the supplier. It is an estimate and can move by a day or two. Booked in advance, the parts are reserved in their name and sent as soon as they arrive — no need to order again — and nothing is billed until dispatch.';

function offerFacts(o) {
  return {
    order: o.orderId,
    placedOrderNo: o.soNumber || null,
    etaDate: o.etaDate,
    etaDateWords: advanceOrders.pretty(o.etaDate),
    parts: o.lines.map((l) => ({ partNo: l.partNo, name: l.item && l.item !== l.partNo ? String(l.item).split('|')[0].trim() : null, qty: l.qty, eta: advanceOrders.pretty(l.etaDate) })),
    whatEtaMeans: ETA_MEANS,
  };
}

const etaOffer = tool(
  async ({ action }, config) => {
    const ctx = contextFrom(config);
    const bot = config && config.configurable && config.configurable.bot;
    const o = ctx.chatId ? advanceOrders.pending(ctx.chatId) : null;
    if (!o) return JSON.stringify({ open: false, note: 'no ETA offer is waiting for this customer — nothing to accept or decline' });
    if (action === 'show') {
      return JSON.stringify({
        open: true,
        ...offerFacts(o),
        note: 'Answer their question from these facts. To book, they have to say yes; then call eta_offer with action "accept".',
      });
    }
    if (!bot || !bot.etaOfferAnswered) return JSON.stringify({ error: 'booking is not available here', askAPerson: true });
    const r = await bot.etaOfferAnswered(ctx.chatId, action === 'accept').catch((e) => ({ error: String((e && e.message) || e).slice(0, 120) }));
    if (r.none) return JSON.stringify({ open: false, note: 'the offer had already been answered or has expired' });
    if (r.declined) {
      return JSON.stringify({ declined: true, note: 'Nothing was booked. Tell them that is fine, and they can message us whenever they need these parts.' });
    }
    if (r.booked) {
      return JSON.stringify({
        booked: true,
        advanceOrderNo: r.orderNo,
        ...offerFacts(r.offer),
        note: 'Booked on our system as an advance order. Tell them the order number, the parts, and the expected date; they will be sent as soon as they arrive. Say the date as etaDateWords.',
      });
    }
    return JSON.stringify({
      bookingPending: true,
      note: 'The system could not book it just now and our team has been told to book it by hand. Thank them and say the team is booking it and will confirm shortly. Do NOT say it is booked.',
    });
  },
  {
    name: 'eta_offer',
    description:
      'The parts from their placed order that were NOT in stock, offered to them with an ETA as an ADVANCE ORDER. "show": the parts, the ETA date and what ETA means — for questions like "kab tak aayega?", "ETA kya hai?". "accept": they said yes/haan/ok/book kar do to the offer — books the advance order and returns its number. "decline": they said no/nahi chahiye — books nothing. Only when an ETA OFFER is open (it says so in your instructions). Never accept on their behalf without a clear yes.',
    schema: z.object({ action: z.enum(['show', 'accept', 'decline']) }),
  },
);

module.exports = { etaOffer, ETA_MEANS };
