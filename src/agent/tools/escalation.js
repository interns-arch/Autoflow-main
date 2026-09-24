'use strict';
// WHEN TO ASK A HUMAN — and the pause while he answers.
//
// The rule the founder set: a person is asked only when the dealer portal
// could not answer. Everything upstream of this tool — the learned aliases,
// the catalogue index, the portal search, the web search, the approved
// knowledge — exists so that this tool is reached as rarely as possible.
//
// THIS TOOL DOES NOT RETURN. It calls LangGraph's interrupt(), which stops
// the graph mid-turn and checkpoints it. The customer is told a specialist is
// looking. When the specialist answers, the thread is resumed from exactly
// this point with his words, the model reads them like any other tool result,
// and writes the reply itself — so he is understood, not forwarded.
//
// core/escalation owns everything on the human side: the dedupe, the
// timeout, the waiters who asked the same thing, and the learning that stops
// the same question being asked twice. None of it is re-implemented here.
const { tool } = require('langchain');
const { interrupt } = require('@langchain/langgraph');
const { z } = require('zod');

const escalation = require('../../core/escalation');
const store = require('../../store');
const { contextFrom } = require('../context');

// ALREADY ASKED, ON THIS THREAD, FOR THIS THING.
//
// LangGraph re-runs the WHOLE node when a thread resumes — everything before
// interrupt() happens a second time. That is documented behaviour, and here
// it bit hard: on resume, escalation.create ran again, found the alias it had
// itself just taught the bot a moment earlier, answered "already learned, no
// human needed", and the tool returned that instead of ever reaching the
// specialist's words. The customer was left with nothing.
//
// So the question is remembered while it is in flight, and a re-entry goes
// straight to the interrupt to collect the answer.
//
// After a restart this map is empty and create() runs again — where it
// answers from what was learned, so the customer is still answered. Losing
// the polish is a fair price; losing the customer is not.
const inFlight = new Set();
const flightKey = (chatId, item) => String(chatId) + '|' + String(item).toLowerCase().trim();

// THE PAUSE ITSELF.
//
// interrupt() throws a signal LangGraph catches: the graph stops here, the
// state is checkpointed, and invoke() returns an __interrupt__ instead of a
// reply. The caller tells the customer a specialist is looking.
//
// When the thread is resumed with the specialist's words, execution re-enters
// and interrupt() RETURNS them. Nothing below this line runs until then —
// which may be hours, and may be on the other side of a deploy.
function waitForSpecialist(key, escalationId, what) {
  const fromSpecialist = interrupt({
    kind: 'ask_a_person',
    escalationId,
    item: what,
    // The customer is told this by the caller, not by the model — the model
    // is not running while this is paused.
    holding: true,
  });

  inFlight.delete(key);

  const answer =
    typeof fromSpecialist === 'string' ? fromSpecialist : (fromSpecialist && fromSpecialist.answer) || '';
  if (!answer) {
    return JSON.stringify({
      answered: false,
      why: 'nothing came back from the specialist',
      note: 'apologise briefly and say the team will follow up',
    });
  }

  return JSON.stringify({
    answered: true,
    // HIS WORDS, NOT A REPLY. They are for you to understand, not to forward
    // — he writes to a colleague, not to a customer, and often answers with a
    // bare part number or "haan hai, 2 din".
    specialistSaid: answer,
    note:
      'Turn this into a proper reply to the customer, in THEIR language. ' +
      'If it names a part number, call check_stock_and_price on it before quoting anything — his answer tells you WHICH part, the portal tells you the price and stock. ' +
      'Never repeat a price he typed; never repeat his message word for word.',
  });
}

const askAPerson = tool(
  async ({ item, qty, reason, whatYouTried, webCandidates }, config) => {
    const ctx = contextFrom(config);
    const bot = (config && config.configurable && config.configurable.bot) || null;
    if (!bot) return JSON.stringify({ asked: false, why: 'no way to reach a person from here' });

    const what = String(item || '').trim();
    if (!what) return JSON.stringify({ asked: false, why: 'nothing to ask about' });

    const key = flightKey(ctx.chatId, what);
    // A re-run of this node. The specialist has already been asked; all that
    // is wanted now is his answer.
    if (inFlight.has(key)) return waitForSpecialist(key, null, what);

    // WHAT HE NEEDS TO SEE.
    //
    // A bare "customer wants a cabin filter" makes him do the work the bot
    // already did. Telling him where it has been — that the catalogue has
    // nothing, that the web suggests two numbers the portal does not carry —
    // turns a question into a confirmation, which is seconds instead of
    // minutes.
    const tried = String(whatYouTried || '').trim();
    const leads = (webCandidates || []).filter(Boolean).slice(0, 4);
    const context =
      [
        tried ? 'Already tried: ' + tried : '',
        leads.length ? 'Web suggests (unconfirmed, portal does not carry them): ' + leads.join(', ') : '',
      ]
        .filter(Boolean)
        .join('\n') || null;

    let created = null;
    try {
      created = await escalation.create(bot, {
        chatId: ctx.chatId,
        customerPhone: ctx.phone,
        customerName: (ctx.customer && ctx.customer.name) || null,
        item: what,
        qty: Number(qty) || 1,
        kind: 'order',
        // WHAT KIND OF QUESTION THIS IS decides what the customer hears if
        // the specialist is slow. A part question that times out asks them
        // for the exact part number, which is helpful. The same line after
        // "do you deliver to Gurgaon?" is the bot losing the thread — seen
        // exactly that, live: an English delivery question answered five
        // minutes later with "Exact part number bhej dijiye".
        //
        // NOT_A_PART is on escalation's no-fallback list, so a business
        // question waits quietly instead.
        reason:
          reason === 'business_question'
            ? 'NOT_A_PART'
            : reason === 'no_part_number'
              ? 'NO_PART_NUMBER'
              : 'NOT_IN_CATALOGUE',
        context,
        // Marks this as the agent's question, so that when the answer lands
        // core/escalation hands it back to THIS paused conversation instead
        // of replying to the customer itself. Without it the customer would
        // get two answers: escalation's, and then the agent's.
        agentThread: ctx.chatId,
      });
    } catch (e) {
      store.log('agent', 'escalation failed: ' + String((e && e.message) || e).slice(0, 90));
      return JSON.stringify({ asked: false, why: 'could not reach a person' });
    }

    // NOBODY NEEDED TO BE DISTURBED.
    //
    // create() checks what has been learned before it asks anyone, and when
    // it already knows the answer it hands it back rather than sending it —
    // this conversation belongs to the agent, and two voices answering the
    // same customer is the thing the whole handover exists to prevent.
    //
    // So these are not "already answered"; they are the answer, and the model
    // still has to write the reply.
    if (created && created.knownAlready && created.partNo) {
      return JSON.stringify({
        asked: false,
        answered: true,
        partNo: created.partNo,
        note:
          'Nobody had to be asked — we already knew this part. Call check_stock_and_price on it and answer the customer normally.',
      });
    }
    if (created && created.fromNote) {
      return JSON.stringify({
        asked: false,
        answered: true,
        // What a person said about this before, approved and reusable.
        weSaidBefore: created.answerText || (created.note && created.note.answer) || '',
        note: 'This was answered before. Say the same thing, in the customer\'s language. Do not add to it.',
      });
    }
    // A send that failed outright: create() has already told the customer
    // something itself, and there is nothing to wait for.
    if (created === null) {
      return JSON.stringify({
        asked: false,
        alreadyAnswered: true,
        note: 'the customer has already been dealt with — say nothing more',
      });
    }

    // create() returns the id as a bare NUMBER when it opened a new question,
    // and { alreadyOpen } when it folded into one already open. Reading `.id`
    // off the number gave undefined, so every paused question logged "#?" and
    // could not be tied to the escalation it was waiting on.
    const escalationId = typeof created === 'number' ? created : created.alreadyOpen || null;
    inFlight.add(key);
    return waitForSpecialist(key, escalationId, what);
  },
  {
    name: 'ask_a_person',
    description:
      'Hand this question to the specialist at the shop and WAIT for his answer. The customer is told a specialist is reviewing it, and this conversation pauses — possibly for hours — until he replies. ' +
      'This is the LAST resort. Use it only after lookup_known_part, search_catalogue_index, search_portal_catalogue AND search_the_web have all come back with nothing, or when check_stock_and_price returned status "unidentified", or when answer_business_question found nothing approved. ' +
      'Tell it what you already tried, so he is confirming rather than starting from scratch. ' +
      'You do not need to write a holding message yourself — the customer is told automatically. Say nothing else alongside it, and never guess at the answer.',
    schema: z.object({
      item: z.string().describe('what the customer asked for, in their own words — this is what the specialist will read'),
      qty: z.number().int().optional().describe('how many they want, if they said'),
      reason: z
        .enum(['not_in_catalogue', 'no_part_number', 'business_question'])
        .describe(
          '"not_in_catalogue" when nothing matched anywhere; "no_part_number" when you know the part but not its number; ' +
            '"business_question" when it is not about a part at all — delivery, payment, timings, returns, GST',
        ),
      whatYouTried: z
        .string()
        .optional()
        .describe('one short line on where you have already looked, e.g. "not in our catalogue, portal search found only Fortuner blades"'),
      webCandidates: z
        .array(z.string())
        .optional()
        .describe('part numbers the web suggested that the portal did not recognise — worth him seeing'),
    }),
  },
);

module.exports = { askAPerson };
