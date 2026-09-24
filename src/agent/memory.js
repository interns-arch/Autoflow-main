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

// THE CONTEXT WINDOW.
//
// A dealer's chat runs for months. LangGraph's checkpointer keeps every
// message and every tool result of it for ever, and hands the whole thing to
// the model on every single turn — so the fiftieth message of the day carries
// the other forty-nine with it, and the bill and the latency grow all
// afternoon while the model reads a part number it settled at breakfast.
//
// So the model is shown a WINDOW, and the thread keeps everything. This runs
// in wrapModelCall (see index.js), which changes what is SENT and never what
// is stored: the checkpoint still holds the whole conversation, so a paused
// question resumes with its full history and nothing a customer said is
// thrown away.
//
// COUNTED IN TURNS, NOT MESSAGES. One customer turn is rarely one message:
// "cartend ka horan 5 set" becomes a human message, an AI message asking for
// a tool, four tool results and a reply — seven. A window of twelve MESSAGES,
// which is what this file used to say, is therefore a window of one and a half
// questions, and the customer who asks "aur iska rate?" is answered by a model
// that can no longer see what "iska" was.
//
// A tool result must stay with the AI message that asked for it — Gemini
// rejects a history that opens on a function response — so the cut is always
// made at a customer message, never at a fixed offset.
const KEEP_TURNS = config.agent.contextTurns;
const HARD_CAP = config.agent.contextMaxMessages;

function typeOf(m) {
  if (!m) return '';
  if (typeof m.getType === 'function') return m.getType();
  if (typeof m._getType === 'function') return m._getType();
  return String(m.type || m.role || '');
}

// Where the window starts: the index of the KEEP_TURNS-th customer message
// counting back from the end, or 0 when the conversation is shorter than that.
function startOfWindow(list, keepTurns) {
  let seen = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (typeOf(list[i]) !== 'human') continue;
    if (++seen >= keepTurns) return i;
  }
  return 0;
}

function windowed(messages) {
  const list = messages || [];
  if (list.length <= 2) return list;

  let cut = startOfWindow(list, KEEP_TURNS);

  // A RUNAWAY SINGLE TURN. Six turns is normally a few dozen messages, but a
  // loop that searched, priced, searched again and asked the web can put
  // twenty in one turn on its own. The cap is the backstop, and it is applied
  // the same way — forward to the next customer message, never mid-turn.
  if (list.length - cut > HARD_CAP) {
    const floor = list.length - HARD_CAP;
    for (let i = floor; i < list.length; i++) {
      if (typeOf(list[i]) === 'human') {
        cut = i;
        break;
      }
    }
  }

  // Nothing to cut, or nothing safe to cut to: send it as it is. A window that
  // opens on a tool result is refused by the model, and a refused turn is
  // worse than an expensive one.
  if (cut <= 0 || typeOf(list[cut]) !== 'human') return list;
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

module.exports = { setupCheckpointer, currentCheckpointer, isDurable, windowed, cartNote, KEEP_TURNS, HARD_CAP };
