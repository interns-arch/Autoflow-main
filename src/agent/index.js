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
//
// THE KNOWLEDGE LOOP runs through here:
//
//   ask -> our sources -> the web -> PAUSE, ask the specialist
//       -> he answers -> resume -> the model writes the reply
//       -> what was learned goes to the knowledge base
//       -> the next customer to ask never gets this far
//
// The pause is a real LangGraph interrupt: the graph stops inside
// ask_a_person, the state is checkpointed to Postgres, and resume() puts his
// words back into the same conversation hours later.
const { createAgent, createMiddleware, dynamicSystemPromptMiddleware, toolCallLimitMiddleware } = require('langchain');
const { Command } = require('@langchain/langgraph');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const config = require('../config');
const store = require('../store');
const { SYSTEM } = require('./prompt');
const memory = require('./memory');

const parts = require('./tools/parts');
const commerce = require('./tools/commerce');
const cart = require('./tools/orders');
const knowledge = require('./tools/knowledge');
const fulfilment = require('./tools/fulfilment');
const escalation = require('./tools/escalation');
const web = require('./tools/web');

const TOOLS = [
  parts.lookupKnownPart,
  parts.searchCatalogueIndex,
  parts.searchPortalCatalogue,
  web.searchTheWeb,
  commerce.checkStockAndPrice,
  cart.showCart,
  cart.addToOrder,
  cart.changeQuantity,
  cart.removeFromOrder,
  cart.confirmOrder,
  cart.cancelOrder,
  knowledge.answerBusinessQuestion,
  knowledge.answerGeneralChat,
  knowledge.findSimilarPastQuestion,
  fulfilment.lookupCustomer,
  fulfilment.orderStatus,
  fulfilment.invoiceStatus,
  fulfilment.reportShortShipment,
  fulfilment.partStatus,
  escalation.askAPerson,
];

let agent = null;
// WHICH checkpointer the cached agent holds.
//
// setupCheckpointer swaps a MemorySaver for the Postgres one at boot, and
// build() caches the agent for the life of the process. A customer message
// landing in the seconds BEFORE that swap — warmUp is fire-and-forget, and the
// relay starts polling immediately — built an agent around the in-memory saver
// and kept it for ever, while the boot log said "checkpointed to Postgres".
// Every question paused for the specialist would then be lost on the next
// deploy, silently, which is the one failure this design exists to rule out.
let builtWith = null;

function enabled() {
  return Boolean(config.agent.enabled && config.gemini && config.gemini.apiKey);
}

// Only these numbers reach the agent while it is being trialled, whatever
// AGENT_ENABLED says. An empty list means nobody — the deliberate default, so
// that turning the flag on by accident cannot put a model in front of a
// paying customer.
function allowed(phone) {
  const list = config.agent.allowFrom;
  if (!list.length) return false; // the default: nobody, even when enabled

  // EVERYONE. AGENT_ALLOW_FROM=* means every customer's message is written by
  // the model rather than by a template.
  //
  // It is spelled as a deliberate, ugly wildcard rather than "empty means all"
  // because the two mistakes are not equally bad: an empty list that meant
  // everyone would put a model in front of every paying customer the first
  // time somebody set AGENT_ENABLED while experimenting. An empty list means
  // nobody, and turning it on for the whole shop has to be typed out.
  if (list.includes('*')) return true;

  const p = store.normPhone(phone || '');
  return Boolean(p && list.includes(p));
}

// Called once at boot, so the Postgres checkpointer is ready before the first
// customer message rather than being set up inside someone's turn.
async function warmUp() {
  if (!enabled()) return false;
  await memory.setupCheckpointer();
  build();
  return true;
}

function build() {
  if (agent && builtWith === memory.currentCheckpointer()) return agent;
  builtWith = memory.currentCheckpointer();
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
    // The conversation, keyed on chat id. Durable, because a paused question
    // has to survive a deploy — see memory.js.
    checkpointer: builtWith,
    middleware: [
      // The cart, re-read from core/orders on every single turn.
      dynamicSystemPromptMiddleware((state, runtime) => SYSTEM + '\n\n' + memory.cartNote(threadOf(runtime))),
      // A loop that will not settle costs money and leaves the customer
      // waiting. Normal is two to four calls.
      toolCallLimitMiddleware({ runLimit: config.agent.maxToolCalls }),
      // THE CONTEXT WINDOW. The thread keeps every message ever sent; the model
      // is shown the last few turns of it. Done in wrapModelCall — which
      // changes the REQUEST and never the state — so the checkpoint stays whole
      // and a question paused this morning still resumes with its history.
      contextWindow,
    ],
  });
  return agent;
}

// THE LAST FEW TURNS, NOT THE LAST FEW MONTHS. See memory.windowed().
const contextWindow = createMiddleware({
  name: 'ContextWindow',
  wrapModelCall: (request, handler) => {
    const all = (request && request.messages) || [];
    const few = memory.windowed(all);
    if (few.length !== all.length) {
      store.log('agent', `context window: ${few.length} of ${all.length} message(s) sent to the model`);
    }
    return handler({ ...request, messages: few });
  },
});

// The chat id, wherever this version of LangGraph happens to put it.
function threadOf(runtime) {
  const c = (runtime && (runtime.configurable || (runtime.config && runtime.config.configurable))) || {};
  return c.chatId || c.thread_id || null;
}

function configFor({ chatId, phone, customer, bot }) {
  return {
    configurable: {
      // The memory key AND the identity, in one object. Nothing here is ever
      // shown to the model: the tools read it, the prompt does not.
      thread_id: chatId,
      chatId,
      phone,
      customer: customer || null,
      bot,
    },
    recursionLimit: Math.max(8, config.agent.maxToolCalls * 2 + 2),
  };
}

// Did this run stop at an interrupt rather than finish?
function pausedAt(out) {
  const int = out && out.__interrupt__;
  if (!int || !int.length) return null;
  const value = int[0] && int[0].value;
  return value || {};
}

// ONE CUSTOMER MESSAGE IN, ONE REPLY OUT.
//
// -> { handled, reply, paused }
//
//   handled false  the agent could not run at all (the model was down, the
//                  turn threw). The caller falls back to the deterministic
//                  path, which is still the whole bot and still works.
//
//   paused true    the agent asked the specialist and is now waiting. The
//                  caller tells the customer someone is reviewing it, and
//                  says nothing further until resume() fires.
//
//   handled true, reply null  the agent ran and deliberately has nothing to
//                  add — almost always because a tool has ALREADY messaged
//                  the customer (escalation does this when it answers from
//                  memory). Sending anything here would be the second half of
//                  a double reply, so the caller must send nothing.
//
// Collapsing those into a bare null is how a customer ends up answered twice,
// so they are kept apart.
async function handle({ bot, chatId, phone, customer, text }) {
  const message = String(text || '').trim();
  if (!message) return { handled: false, reply: null };
  return await run({ bot, chatId, phone, customer }, { messages: [{ role: 'user', content: message }] }, 'turn');
}

// THE SPECIALIST HAS ANSWERED.
//
// Puts his words back into the paused conversation, exactly where it stopped,
// and lets the model write the customer's reply from them. Called by
// core/escalation when a reply lands on a question the agent raised.
//
// -> true when the customer was answered, false when this thread could not be
// resumed — in which case escalation answers the old way and the customer is
// not left with nothing.
async function resume({ bot, chatId, phone, answer }) {
  if (!enabled() || !chatId) return false;
  const said = String(answer || '').trim();
  if (!said) return false;

  const res = await run({ bot, chatId, phone, customer: null }, new Command({ resume: { answer: said } }), 'resume');
  if (!res.handled) return false;

  // NO REPLY IS A FAILURE HERE, not a deliberate silence.
  //
  // On an ordinary turn "nothing to add" is often right, because a tool has
  // already messaged the customer. Not on a resume: this customer was told a
  // specialist was looking, and they are owed an answer. Returning true with
  // nothing to send would make core/escalation skip its own reply too, and
  // the customer would wait for ever. So this hands the answer back and lets
  // escalation deliver it the old way.
  if (!res.reply) {
    store.log('agent', chatId + ' resumed but produced no reply — escalation will answer instead');
    return false;
  }

  try {
    await bot.transport.sendToChat(chatId, res.reply);
  } catch (e) {
    store.log('agent', 'could not deliver the resumed reply: ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
  // WHAT WAS JUST LEARNED, KEPT.
  //
  // core/escalation already files the specialist's answer with the knowledge
  // base, which decides for itself whether it is general or belongs to this
  // customer alone. Nothing is duplicated here; this only notes that the loop
  // closed, so the log reads as one story.
  store.log('agent', `${chatId} answered from the specialist's reply`);
  return true;
}

async function run(who, input, what) {
  const started = Date.now();
  let out = null;
  try {
    out = await build().invoke(input, configFor({ ...who }));
  } catch (e) {
    store.log('agent', what + ' failed: ' + String((e && e.message) || e).slice(0, 140));
    return { handled: false, reply: null, paused: false };
  }

  const messages = (out && out.messages) || [];
  const calls = messages.filter((m) => (m.getType ? m.getType() : '') === 'tool').map((m) => m.name);

  const stop = pausedAt(out);
  if (stop) {
    store.log(
      'agent',
      `${who.chatId} ${Date.now() - started}ms, PAUSED for the specialist (#${stop.escalationId || '?'}), tools: ${calls.join(' > ') || 'none'}`,
    );
    return { handled: true, reply: null, paused: true, escalationId: stop.escalationId || null };
  }

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

  store.log('agent', `${who.chatId} ${Date.now() - started}ms, tools: ${calls.length ? calls.join(' > ') : 'none'}`);
  return { handled: true, reply: reply || null, paused: false };
}

// Gemini returns content as parts when it feels like it.
function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('').trim();
  return '';
}

module.exports = { handle, resume, warmUp, enabled, allowed, TOOLS, _build: build };
