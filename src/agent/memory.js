'use strict';
// WHAT THE AGENT REMEMBERS.
//
// Two different things, kept apart on purpose:
//
//   The conversation — held by LangGraph's checkpointer, keyed on thread_id,
//   which is the chat id. Every message and every tool result from this chat
//   comes back on the next turn without being re-fetched.
//
//   The cart — NOT held in the conversation. It lives in core/orders, it is
//   changed by tools, and it is re-read and injected fresh on every turn.
//   A cart quoted from six messages ago is a cart that may have been
//   confirmed, cancelled or re-priced since, and a model reading its own
//   stale summary will happily confirm an order that no longer exists.
//
// So: history is remembered, state is re-read.
const { MemorySaver } = require('@langchain/langgraph');

const config = require('../config');
const store = require('../store');
const orders = require('../core/orders');
const availability = require('../core/availability');

// THE CHECKPOINTER HAS TO SURVIVE A RESTART.
//
// This is not a nicety. When the agent asks Prateek sir something, the
// conversation PAUSES mid-turn and waits for him — and he answers when he
// answers, which may be after lunch. Every deploy restarts this container. An
// in-memory checkpointer would drop every paused conversation on the floor:
// the customer was told "our specialist is looking at this", the specialist
// answers an hour later, and there is nothing left to resume. They are never
// told anything again.
//
// So the thread goes in Postgres, which is already here for the knowledge
// base. MemorySaver is kept only for the case where there is no database at
// all — tests, and a machine with no DATABASE_URL — where nothing is paused
// anyway because escalation needs the same database to remember its own
// questions.
let checkpointer = new MemorySaver();
let durable = false;

async function setupCheckpointer() {
  if (durable) return checkpointer;
  if (!config.kb || !config.kb.databaseUrl) {
    store.log('agent', 'no DATABASE_URL — conversations are held in memory and will not survive a restart');
    return checkpointer;
  }
  try {
    const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres');
    const saver = PostgresSaver.fromConnString(config.kb.databaseUrl);
    // Creates its own tables if they are not there. Safe to call every boot.
    await saver.setup();
    checkpointer = saver;
    durable = true;
    store.log('agent', 'conversations are checkpointed to Postgres — paused questions survive a restart');
  } catch (e) {
    store.log(
      'agent',
      'could not reach Postgres for checkpoints, falling back to memory: ' + String((e && e.message) || e).slice(0, 90),
    );
  }
  return checkpointer;
}

// The live object, whichever it currently is. Read through a function rather
// than exported directly, because setup() swaps it.
const currentCheckpointer = () => checkpointer;
const isDurable = () => durable;

// TRIMMING.
//
// A dealer's chat runs for months. Sending all of it every turn is slow and
// expensive, and the model only ever needs the recent run-up. Tool messages
// must stay attached to the AI message that called them, so the window is cut
// at a clean boundary rather than at a fixed count.
const KEEP_TURNS = 12;

function trimmed(messages) {
  const list = messages || [];
  if (list.length <= KEEP_TURNS) return list;
  // Walk back to the most recent human message at or before the window, so
  // the slice never starts on an orphaned tool result.
  let cut = list.length - KEEP_TURNS;
  while (cut > 0 && (list[cut].getType ? list[cut].getType() : list[cut]._getType()) !== 'human') cut--;
  return list.slice(cut);
}

// The cart, as one line in front of the model on every turn.
//
// Without this the agent calls show_cart at the start of nearly every turn
// just to find out whether there is one — a round trip to learn "no". With
// it, the common case (empty cart) costs nothing.
function cartNote(chatId) {
  const order = chatId ? orders.findDraft(chatId) : null;
  if (!order || !order.lines.length) return 'CART: empty.';
  const lines = order.lines
    .map((l) => `${availability.displayName(l)} x ${l.qty}${availability.priceOf(l)}`)
    .join('; ');
  return (
    'CART (live, right now): ' +
    lines +
    '. This is current — do not quote a cart from earlier in the conversation. Use show_cart before confirming.'
  );
}

module.exports = { setupCheckpointer, currentCheckpointer, isDurable, trimmed, cartNote, KEEP_TURNS };
