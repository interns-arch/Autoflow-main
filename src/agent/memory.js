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

const orders = require('../core/orders');
const availability = require('../core/availability');

// One process, one store. A restart forgets every open conversation, which
// matters less than it sounds: the customer's next message re-establishes
// everything the tools need, and the cart survives in core/orders regardless.
const checkpointer = new MemorySaver();

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

module.exports = { checkpointer, trimmed, cartNote, KEEP_TURNS };
