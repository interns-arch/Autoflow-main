'use strict';
// WHAT THIS BUSINESS HAS ALREADY ANSWERED.
//
// Policy questions — returns, delivery time, GST, payment terms, timings —
// are answered from approved knowledge or not at all. The retrieval threshold
// and the relevance check live in core/kb; what comes back here is already
// phrased and has already been checked for invented figures.
//
// A miss is NOT a licence to answer from general knowledge. The bot does not
// know this dealership's return policy, and a plausible guess about one is
// worse than a short wait for a person.
const { tool } = require('langchain');
const { z } = require('zod');

const kb = require('../../core/kb');
const history = require('../../core/history');
const smallTalk = require('../../core/smallTalk');
const { contextFrom } = require('../context');

const answerBusinessQuestion = tool(
  async ({ question }, config) => {
    const ctx = contextFrom(config);
    if (!kb.enabled()) return JSON.stringify({ answered: false, why: 'the knowledge base is not available', askAPerson: true });

    const res = await kb.answer(String(question || '').trim(), {
      chatId: ctx.chatId,
      customerId: (ctx.customer && (ctx.customer.buyerId || ctx.customer.accountId)) || null,
      // The approved words as a person wrote them, not a rewrite: the agent
      // writes the customer's reply itself, and a second model rephrasing it
      // first would only be one more place for a condition to go missing.
      raw: true,
    });
    if (!res.answered) {
      return JSON.stringify({
        answered: false,
        why: 'nothing approved covers this question',
        askAPerson: true,
      });
    }
    return JSON.stringify({
      answered: true,
      approvedAnswer: res.text,
      note: 'This is what a person approved. Say it in your own words, in the customer\'s language, keeping every number, condition and exception exactly — add nothing, soften nothing.',
    });
  },
  {
    name: 'answer_business_question',
    description:
      'Answer a question about how this dealership works — returns, warranty, delivery time, GST, payment terms, minimum order, opening hours, discounts. ' +
      'Use it for ANY such question, even one you think you know the answer to: the reply it gives is this dealership\'s approved wording, and a general answer would be wrong here. ' +
      'If it comes back answered:false, you do not know the answer — call ask_a_person. NEVER make up a policy, a figure, a timeframe or a condition.',
    schema: z.object({ question: z.string().describe('the customer\'s question, in their own words') }),
  },
);

const findSimilarPastQuestion = tool(
  async ({ question }) => {
    if (!history.enabled()) return JSON.stringify({ found: false, why: 'past chats are not indexed' });
    let rows = [];
    try {
      rows = await history.similar(String(question || '').trim(), { limit: 3 });
    } catch (e) {
      return JSON.stringify({ found: false, why: 'past chats could not be searched' });
    }
    if (!rows.length) return JSON.stringify({ found: false, why: 'nothing like this has been asked before' });
    return JSON.stringify({
      found: true,
      // The PATTERN, never the original reply: the original may quote a stock
      // figure from June. Part numbers carry over; prices never do.
      pastExamples: rows.map((r) => ({
        theyAsked: r.question,
        whatWasDone: r.action || r.intent,
        howItWasAnswered: r.pattern,
        partNo: r.partNo || null,
      })),
      caution: 'this is how it was answered in the past. A part number here is a good lead — check it with check_stock_and_price. Never repeat a price or stock figure from it.',
    });
  },
  {
    name: 'find_similar_past_question',
    description:
      'Look through years of past WhatsApp chats for a question like this one and see how the shop handled it. ' +
      'Useful when a customer uses unfamiliar wording for a part, or asks something no approved answer covers, and you want a lead before escalating to a person. ' +
      'What it returns is HISTORY, not fact: a part number from it still has to go through check_stock_and_price, and a price or stock figure from it must never be repeated.',
    schema: z.object({ question: z.string().describe('what the customer asked, in their own words') }),
  },
);

// EVERYTHING ELSE A DEALER SAYS.
//
// Not every message is a part or a policy. "Kaise ho bhai", "aap log Sunday
// khulte ho?", "delivery karte ho?" — the bot has always had an answer for
// these, written by core/smallTalk against a brief that has been tuned on the
// live line for months.
//
// It nearly got thrown away. With the agent answering every message, that
// module sat below the agent and was never reached, so questions the bot used
// to handle in one second went to the specialist instead — and with no
// approved knowledge yet, that is every single one of them. Wrapping it keeps
// the behaviour and keeps the guardrails, which are the important part: the
// brief forbids stating a price, a stock figure or a delivery date, and
// fenceFails throws the answer away if it does.
const answerGeneralChat = tool(
  async ({ message }, config) => {
    const ctx = contextFrom(config);
    let out = null;
    try {
      out = await smallTalk.respond(ctx.chatId, String(message || '').trim(), ctx.phone, { noHuman: true });
    } catch (e) {
      return JSON.stringify({ answered: false, why: 'could not be answered conversationally' });
    }
    // null means "not conversation" — a part number was in it, or there is no
    // model. silent means the message needs no reply at all.
    if (!out) return JSON.stringify({ answered: false, why: 'this is not general conversation — treat it as a part or a policy question' });
    if (out.action === 'silent' || !out.text) {
      return JSON.stringify({ answered: true, gist: null, note: 'nothing needs saying to this — reply with (no reply)' });
    }
    return JSON.stringify({
      answered: true,
      // The substance, not the words to send: the agent writes the reply.
      gist: out.text,
      note: 'This is WHAT to say, not the words to send. Write the reply yourself, in your own voice and the customer\'s language. Keep what it says; add no price, stock figure or delivery date.',
    });
  },
  {
    name: 'answer_general_chat',
    description:
      'Answer ordinary conversation and general questions about the shop that are not covered by approved knowledge — greetings, "kaise ho", "aap log Sunday khulte ho", "delivery karte ho", small complaints, thanks. ' +
      'Use it AFTER answer_business_question comes back with nothing, and BEFORE ask_a_person: most of these never needed a colleague, and escalating them all would bury him. ' +
      'It will not state a price, a stock figure or a delivery date, and neither may you. If it says this is not general conversation, treat the message as a part question instead.',
    schema: z.object({ message: z.string().describe('the customer\'s message, exactly as they wrote it') }),
  },
);

module.exports = { answerBusinessQuestion, findSimilarPastQuestion, answerGeneralChat };
