'use strict';
// THE AGENT.
//
// One agent. Every tool. The model decides which to reach for, from the
// docstrings on the tools themselves — there is no router, no supervisor and
// no sub-agent, because a routing layer only moves the same decision
// somewhere harder to test.
//
// What is NOT here, and stays in front of this on purpose:
//   the echo guard          (our own message coming back to us)
//   voice and photo         (transcribed before the agent sees words)
//   route.forBot            (is this message ours to answer at all)
// Those are cheap, deterministic and have been right in production for
// months. Handing them to a model would be paying tokens to get worse.
const { createAgent, dynamicSystemPromptMiddleware, toolCallLimitMiddleware } = require('langchain');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const config = require('../config');
const store = require('../store');
const { SYSTEM } = require('./prompt');
const { checkpointer, cartNote } = require('./memory');

const parts = require('./tools/parts');
const commerce = require('./tools/commerce');
const cart = require('./tools/orders');
const knowledge = require('./tools/knowledge');
const fulfilment = require('./tools/fulfilment');
const escalation = require('./tools/escalation');

const TOOLS = [
  parts.lookupKnownPart,
  parts.searchCatalogueIndex,
  parts.searchPortalCatalogue,
  commerce.checkStockAndPrice,
  cart.showCart,
  cart.addToOrder,
  cart.changeQuantity,
  cart.removeFromOrder,
  cart.confirmOrder,
  cart.cancelOrder,
  knowledge.answerBusinessQuestion,
  knowledge.findSimilarPastQuestion,
  fulfilment.lookupCustomer,
  fulfilment.orderStatus,
  fulfilment.invoiceStatus,
  fulfilment.reportShortShipment,
  fulfilment.partStatus,
  escalation.askAPerson,
];

let agent = null;

function enabled() {
  return Boolean(config.agent.enabled && config.gemini && config.gemini.apiKey);
}

// Only these numbers reach the agent while it is being trialled, whatever
// AGENT_ENABLED says. An empty list means nobody — the deliberate default, so
// that turning the flag on by accident cannot put a model in front of a
// paying customer.
function allowed(phone) {
  const p = store.normPhone(phone || '');
  return Boolean(p && config.agent.allowFrom.includes(p));
}

function build() {
  if (agent) return agent;
  agent = createAgent({
    model: new ChatGoogleGenerativeAI({
      model: config.agent.model,
      apiKey: config.gemini.apiKey,
      // Near-zero. This is a salesman reading a catalogue, not a copywriter;
      // the variation we want is in WHICH tool it picks, not in how creatively
      // it words a part number.
      temperature: 0.2,
    }),
    tools: TOOLS,
    systemPrompt: SYSTEM,
    // The conversation, keyed on chat id. See memory.js for why the cart is
    // deliberately not in here.
    checkpointer,
    middleware: [
      // The cart, re-read from core/orders on every single turn.
      dynamicSystemPromptMiddleware((state, runtime) => {
        const chatId = threadOf(runtime);
        return SYSTEM + '\n\n' + cartNote(chatId);
      }),
      // A loop that will not settle costs money and leaves the customer
      // waiting. Normal is two to four calls.
      toolCallLimitMiddleware({ runLimit: config.agent.maxToolCalls }),
    ],
  });
  return agent;
}

// The chat id, wherever this version of LangGraph happens to put it.
function threadOf(runtime) {
  const c = (runtime && (runtime.configurable || (runtime.config && runtime.config.configurable))) || {};
  return c.chatId || c.thread_id || null;
}

// ONE CUSTOMER MESSAGE IN, ONE REPLY OUT.
//
// -> { handled, reply }
//
//   handled false  the agent could not run at all (the model was down, the
//                  turn threw). The caller falls back to the deterministic
//                  path, which is still the whole bot and still works.
//
//   handled true, reply null  the agent ran and deliberately has nothing to
//                  add — almost always because a tool has ALREADY messaged
//                  the customer (escalation does this when it answers from
//                  memory). Sending anything here would be the second half of
//                  a double reply, so the caller must send nothing.
//
// Collapsing those two into a bare null is how a customer ends up answered
// twice, so they are kept apart.
async function handle({ bot, chatId, phone, customer, text }) {
  const message = String(text || '').trim();
  if (!message) return { handled: false, reply: null };

  const started = Date.now();
  let out = null;
  try {
    out = await build().invoke(
      { messages: [{ role: 'user', content: message }] },
      {
        configurable: {
          // The memory key AND the identity, in one object. Nothing here is
          // ever shown to the model: the tools read it, the prompt does not.
          thread_id: chatId,
          chatId,
          phone,
          customer: customer || null,
          bot,
        },
        recursionLimit: Math.max(8, config.agent.maxToolCalls * 2 + 2),
      },
    );
  } catch (e) {
    store.log('agent', 'turn failed: ' + String((e && e.message) || e).slice(0, 140));
    return { handled: false, reply: null };
  }

  const messages = (out && out.messages) || [];
  // The LAST message is usually the reply, but not always: when the final
  // tool call is the whole answer the model sometimes adds nothing after it.
  // So walk back to the last AI message that actually carries words, rather
  // than reading messages[length-1] and getting an empty string.
  let reply = '';
  for (let i = messages.length - 1; i >= 0 && !reply; i--) {
    const m = messages[i];
    if ((m.getType ? m.getType() : '') !== 'ai') continue;
    reply = textOf(m);
  }

  const calls = messages.filter((m) => (m.getType ? m.getType() : '') === 'tool').map((m) => m.name);
  store.log(
    'agent',
    `${chatId} ${Date.now() - started}ms, tools: ${calls.length ? calls.join(' > ') : 'none'}`,
  );

  return { handled: true, reply: reply || null };
}

// Gemini returns content as parts when it feels like it.
function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('').trim();
  return '';
}

module.exports = { handle, enabled, allowed, TOOLS, _build: build };
