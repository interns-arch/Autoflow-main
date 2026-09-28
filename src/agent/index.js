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
const { createAgent, createMiddleware, toolCallLimitMiddleware } = require('langchain');
const { z } = require('zod');
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
const workflows = require('./tools/workflows');
const advance = require('./tools/advance');

const TOOLS = [
  parts.lookupKnownPart,
  parts.searchCatalogueIndex,
  parts.searchPortalCatalogue,
  web.searchTheWeb,
  commerce.checkStockAndPrice,
  commerce.myDiscounts,
  cart.showCart,
  cart.addToOrder,
  cart.changeQuantity,
  cart.removeFromOrder,
  cart.confirmOrder,
  cart.paymentDone,
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
  workflows.resolveOrderList,
  workflows.accountForm,
  workflows.lookupVehicle,
  workflows.myAccount,
  advance.etaOffer,
];

// EVERY TOOL, ONE LINE EACH, in the prompt (founder, 26 Sep: "agent should be
// aware of all the tools"). Built from TOOLS itself, so the list the model
// reads is always the list it can call: a tool added above is in it, a tool
// taken out is gone. The first sentence of each tool's own description.
function toolIndex(tools) {
  const first = (d) => {
    // "e.g." and "i.e." are not the end of a sentence.
    const s = String(d || '').replace(/\s+/g, ' ').trim().replace(/\b(e\.g|i\.e)\./gi, (x) => x.replace(/\./g, '․'));
    const cut = s.search(/[.!?](\s|$)/);
    return (cut > 0 ? s.slice(0, cut + 1) : s).slice(0, 220).replace(/․/g, '.');
  };
  return (
    'YOUR TOOLS — all of them. Reach for the one that fits; never say you cannot do something one of these does:\n' +
    tools.map((t) => '- ' + t.name + ': ' + first(t.description)).join('\n')
  );
}

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

// NO ALLOW-LIST. There used to be one (AGENT_ALLOW_FROM) while the agent was
// trialled beside the template path. The template path is gone for customers
// — the agent writes every reply — so a list would only decide who gets no
// answer at all. Every customer reaches the agent; staff keep their commands
// (bots/customerBot, isOperator).

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
    systemPrompt: SYSTEM + '\n\n' + toolIndex(TOOLS),
    // The conversation, keyed on chat id. Durable, because a paused question
    // has to survive a deploy — see memory.js.
    checkpointer: builtWith,
    middleware: [
      // A loop that will not settle costs money and leaves the customer
      // waiting. Normal is two to four calls.
      toolCallLimitMiddleware({ runLimit: config.agent.maxToolCalls }),
      // WHAT THE MODEL SEES besides the prompt: the live cart (re-read from
      // core/orders every turn), notes on who the customer is, a running
      // summary of everything older, and the last 20 messages word for word.
      // The checkpoint keeps every message; this only shapes what is SENT, so
      // a question paused this morning still resumes with its history.
      memory.contextMiddleware({ createMiddleware, z }),
    ],
  });
  return agent;
}

function configFor({ chatId, phone, customer, bot, message }) {
  return {
    configurable: {
      // The message being answered, for the tools that need more than its
      // words — a shop photo or a dropped pin for the account form.
      message: message || null,
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
//                  turn threw), or wrote a price no tool gave it. There is
//                  no template path behind it any more: the caller says one
//                  plain line and hands the message to a person.
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
async function handle({ bot, chatId, phone, customer, text, message }) {
  const said = String(text || '').trim();
  if (!said) return { handled: false, reply: null };
  return await run({ bot, chatId, phone, customer, message }, { messages: [{ role: 'user', content: said }] }, 'turn');
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
async function resume({ bot, chatId, phone, answer, timedOut }) {
  if (!enabled() || !chatId) return false;
  const said = String(answer || '').trim();
  // No words is only a resume when the wait itself has run out: the tool
  // then tells the model nothing came back, and the model writes what the
  // customer hears — instead of the old fixed "could not confirm" line.
  if (!said && !timedOut) return false;

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
    const id = await bot.transport.sendToChat(chatId, res.reply);
    // In the chat's own history like any other reply: the template path can
    // see it, a swipe-reply onto it can be read, and the next catch-up does
    // not repeat it back to the agent as news.
    if (typeof bot.recordOutgoing === 'function') bot.recordOutgoing(chatId, id, res.reply);
    require('./incoming').markSeen(chatId);
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

// A TURN THE CUSTOMER DID NOT START — the specialist answering after the
// conversation had already stopped waiting for him (the wait ran out, or a
// restart lost the pause). The news goes in as a note, the model writes the
// customer's reply, and it is delivered and recorded like any other.
//
// -> true when the customer was answered.
async function followUp({ bot, chatId, phone, note }) {
  if (!enabled() || !chatId || !note) return false;
  const res = await run({ bot, chatId, phone, customer: null }, { messages: [{ role: 'user', content: String(note) }] }, 'follow-up');
  if (!res.handled || !res.reply) return false;
  try {
    const id = await bot.transport.sendToChat(chatId, res.reply);
    if (typeof bot.recordOutgoing === 'function') bot.recordOutgoing(chatId, id, res.reply);
    require('./incoming').markSeen(chatId);
    return true;
  } catch (e) {
    store.log('agent', 'could not deliver the follow-up: ' + String((e && e.message) || e).slice(0, 80));
    return false;
  }
}

// The last time the model could not run, and why (null once it runs again).
let lastFailure = null;

async function run(who, input, what) {
  const started = Date.now();
  let out = null;
  try {
    out = await build().invoke(input, configFor({ ...who }));
  } catch (e) {
    const msg = String((e && e.message) || e);
    store.log('agent', what + ' failed: ' + msg.slice(0, 140));
    // Why, kept: "the model could not run at all" (credits, quota, key) is a
    // different thing from one bad turn — customerBot tells the admins once
    // and answers greetings itself instead of sending each to a person.
    lastFailure = {
      at: Date.now(),
      message: msg.slice(0, 300),
      down: /\b(402|429|401|403)\b|credits? (are )?depleted|RESOURCE_EXHAUSTED|quota|billing|API key/i.test(msg),
    };
    return { handled: false, reply: null, paused: false };
  }
  lastFailure = null;

  const messages = (out && out.messages) || [];
  const calls = messages.filter((m) => (m.getType ? m.getType() : '') === 'tool').map((m) => m.name);

  const stop = pausedAt(out);
  if (stop) {
    store.log(
      'agent',
      `${who.chatId} ${Date.now() - started}ms, PAUSED for the specialist (#${stop.escalationId || '?'}), tools: ${calls.join(' > ') || 'none'}`,
    );
    // The holding line the MODEL wrote when it called ask_a_person. The
    // caller sends it; the model is not running any more to send it itself.
    return {
      handled: true,
      reply: null,
      paused: true,
      escalationId: stop.escalationId || null,
      holding: stop.tellCustomer || null,
    };
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
  // EVERY PRICE IN THE REPLY CAME FROM A TOOL.
  //
  // The model writes every word now — tools hand it facts, not sentences — so
  // it also writes the price. That is only safe if the price it writes is one
  // the portal gave it. A figure found nowhere in what the tools returned (or
  // in the live cart) is one it made up, rounded or multiplied: "5 x ₹310 =
  // ₹1,550" is exactly the total the prompt forbids. Such a reply is not
  // sent; the caller answers the old way instead, whose prices come straight
  // from the portal. A guard like this can only lose a reply, never produce a
  // wrong one.
  const invented = inventedMoney(reply, messages, memory.cartNote(who.chatId));
  if (invented.length) {
    store.log('agent', `${who.chatId} reply NOT sent — it states ${invented.join(', ')}, which no tool gave it: "${reply.slice(0, 100)}"`);
    return { handled: false, reply: null, paused: false };
  }

  // NOTHING IS "SENT FOR APPROVAL" UNLESS IT WAS. 25 Sep, live: the account
  // form was still waiting for a shop photo when the reply said "request
  // Sales Head (Jain sir) ke paas approval ke liye chali gayi hai" — no
  // request existed, no approver had it, and the customer believed it was in
  // hand. A reply that says so needs a tool, THIS turn, that returned a
  // request: account_form done with a requestId, or an order sentForApproval.
  if (claimsSentForApproval(reply) && !approvalThisTurn(messages)) {
    store.log('agent', `${who.chatId} reply NOT sent — it says something went for approval, and no tool sent anything: "${reply.slice(0, 100)}"`);
    return { handled: false, reply: null, paused: false };
  }

  // "(no reply)": the model decided there is nothing to say — a reaction taken
  // back, a sticker after the deal. Handled, and nothing is sent.
  if (/^\(?\s*no reply\s*\)?\.?$/i.test(reply)) return { handled: true, reply: null, paused: false };
  return { handled: true, reply: reply || null, paused: false };
}

// "approval ke liye bhej diya", "request Sales Head ke paas chali gayi",
// "sent for approval", "forwarded to the Sales Head for approval".
const APPROVAL_SENT =
  /(approv\w*|sales\s*head|jain\s*sir|prateek|arun\s*sir).{0,60}(bhej\s*di|bhej\s*diya|bhej\s*dia|chali\s*gayi|chala\s*gaya|chali\s*gai|pahunch|sent|forwarded|submitted)|(bhej\s*di|bhej\s*diya|sent|forwarded|submitted).{0,40}(for\s+approval|approval\s+ke\s+liye|sales\s*head)/i;
function claimsSentForApproval(reply) {
  return APPROVAL_SENT.test(String(reply || ''));
}
// A tool in the CURRENT turn — after the last thing the customer said — that
// actually filed a request.
function approvalThisTurn(messages) {
  const list = messages || [];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i].getType ? list[i].getType() : '') === 'human') {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < list.length; i++) {
    const m = list[i];
    if ((m.getType ? m.getType() : '') !== 'tool') continue;
    const text = textOf(m);
    if (/"sentForApproval"\s*:\s*true|"sentToAccountant"\s*:\s*true|"paymentDue"\s*:\s*true|"requestId"\s*:\s*"(WA|ORD|DSC|PAY)-|"done"\s*:\s*"sent_for_review"/.test(text)) return true;
  }
  return false;
}

// Gemini returns content as parts when it feels like it.
// Money in a reply: "₹450", "Rs 1,050", "Rs.310", "MRP 599", "450 rupees",
// "INR 99". The numbers, with separators removed.
const MONEY = /(?:₹|\brs\.?|\binr\b|\bmrp\b(?:\s*(?:₹|rs\.?))?)\s*:?\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:\/-|rupees?\b|rs\b)/gi;
const norm = (n) => String(Number(String(n).replace(/,/g, '')));

// Every money figure in `reply` that appears in none of the tool results in
// this conversation, nor in the live cart. [] when the reply is clean.
function inventedMoney(reply, messages, cart) {
  const said = [];
  for (const m of String(reply || '').matchAll(MONEY)) said.push(norm(m[1] || m[2]));
  if (!said.length) return [];
  const known = new Set();
  const collect = (text) => {
    for (const n of String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || []) known.add(norm(n));
  };
  for (const msg of messages || []) {
    if ((msg.getType ? msg.getType() : '') === 'tool') collect(textOf(msg));
  }
  collect(cart);
  return [...new Set(said.filter((n) => !known.has(n)))];
}

function textOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('').trim();
  return '';
}

module.exports = { handle, resume, followUp, warmUp, enabled, lastFailure: () => lastFailure, TOOLS, _toolIndex: toolIndex, _build: build, _inventedMoney: inventedMoney, _claimsSentForApproval: claimsSentForApproval, _approvalThisTurn: approvalThisTurn };
