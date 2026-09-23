'use strict';
// WHEN TO ASK A HUMAN.
//
// The rule the founder set: a person is asked only when the dealer portal
// could not answer. Everything upstream of this tool — the learned aliases,
// the catalogue index, the portal search, the approved knowledge — exists so
// that this tool is reached as rarely as possible.
//
// core/escalation owns what happens next: the dedupe, the five-minute
// timeout, the waiters who asked the same thing, and the learning that stops
// the same question being asked twice. None of that is re-implemented here.
const { tool } = require('langchain');
const { z } = require('zod');

const escalation = require('../../core/escalation');
const store = require('../../store');
const { contextFrom } = require('../context');

const askAPerson = tool(
  async ({ item, qty, reason }, config) => {
    const ctx = contextFrom(config);
    const bot = (config && config.configurable && config.configurable.bot) || null;
    if (!bot) return JSON.stringify({ asked: false, why: 'no way to reach a person from here' });

    const what = String(item || '').trim();
    if (!what) return JSON.stringify({ asked: false, why: 'nothing to ask about' });

    try {
      const res = await escalation.create(bot, {
        chatId: ctx.chatId,
        customerPhone: ctx.phone,
        customerName: (ctx.customer && ctx.customer.name) || null,
        item: what,
        qty: Number(qty) || 1,
        kind: 'order',
        reason: reason === 'no_part_number' ? 'NO_PART_NUMBER' : 'NOT_IN_CATALOGUE',
      });
      // create() answers from memory when it can, and says so. Either way the
      // customer has been dealt with; the agent must not add to it.
      if (res && res.fromNote) return JSON.stringify({ asked: false, alreadyAnswered: true, note: 'the customer has already been sent the answer — say nothing more' });
      if (res && res.alreadyOpen) return JSON.stringify({ asked: true, note: 'someone is already being asked this — tell the customer you are checking and will confirm shortly' });
      if (res === null) return JSON.stringify({ asked: false, alreadyAnswered: true, note: 'this was already known and the customer has been answered — say nothing more' });
    } catch (e) {
      store.log('agent', 'escalation failed: ' + String((e && e.message) || e).slice(0, 90));
      return JSON.stringify({ asked: false, why: 'could not reach a person' });
    }
    return JSON.stringify({
      asked: true,
      note: 'tell the customer you are checking and will confirm shortly. Do not guess the part, the price or the stock.',
    });
  },
  {
    name: 'ask_a_person',
    description:
      'Hand this question to a colleague at the shop, and tell the customer you are checking. ' +
      'This is the LAST resort. Use it only after the part tools and the portal have all come back with nothing, or when check_stock_and_price returned status "unidentified", or when answer_business_question found nothing approved. ' +
      'NEVER use it just because a question is hard to word. A colleague answering costs them real time, so do not send anything you could have found yourself. ' +
      'After calling this, tell the customer you are checking — do not guess at an answer alongside it.',
    schema: z.object({
      item: z.string().describe('what the customer asked for, in their own words — this is what the colleague will read'),
      qty: z.number().int().optional().describe('how many they want, if they said'),
      reason: z
        .enum(['not_in_catalogue', 'no_part_number'])
        .describe('"not_in_catalogue" when nothing matched anywhere; "no_part_number" when you know the part but not its number'),
    }),
  },
);

module.exports = { askAPerson };
