'use strict';
// THE STAFF AGENT (founder, 28 Sep: "reply must be agentic not deterministic").
//
// Sales team, agents and admins write to the bot the way they talk: "order
// karna hai 8800556388", "iska ledger bhejo", "Ford pe 5% discount laga do
// Customer Testing ko". The desk underneath (core/salesOrder and the staff
// half of bots/customerBot) already does every one of those things, and does
// them right: who may see which ledger, orders through the Sales Head,
// discounts to the Dealer Portal, the account form's checks. None of that
// moves here.
//
// What moves here is the UNDERSTANDING and the WORDS. The model reads the
// message, tells the desk plainly what to do through ONE tool (`desk`), reads
// back what the desk said, and writes the reply itself. The desk's replies are
// captured, not sent (customerBot.handleMessage with m._capture).
//
// Left out on purpose - the desk answers these directly, exactly as before:
// Sales Head approvals ("OK ORD-…", a bare "ok"), the helper answering an
// escalated question, button taps, and photos / files / voice notes. They are
// exact commands or media, and rewording them could only lose something.
const { createAgent, createMiddleware, toolCallLimitMiddleware, tool } = require('langchain');
const { z } = require('zod');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

const config = require('../config');
const store = require('../store');
const memory = require('./memory');

const STAFF_SYSTEM = `You are the Cartrends sales desk assistant on WhatsApp. The person writing is one of OUR OWN staff — a salesman, a sales agent or an admin — not a customer. They use you to work for their customers: take an order for a customer, send a ledger or an invoice, show a customer's details and balance, set up or change a discount, open a new customer account, check stock and price.

HOW YOU WORK
You do nothing yourself. The DESK does the work, through the tool desk. You give it one plain instruction, it answers with what it did and what it says; you then write the reply to the staff member from that.
- Understand what they want and WHO it is for. A 10-digit mobile number or a GST number in their message is the customer. "iska", "isi ka", "same customer", "is customer ka" means the customer you were just working on (the desk remembers who that is — you do not need to repeat the number).
- Tell the desk in these words (Hinglish is fine, keep the customer's number and the part numbers exactly as written):
  • an order:            "order karna hai <number> <part number> <qty> …" (parts optional)
  • parts for the order being taken: "<part number> <qty>" one per line
  • customer details:    "check customer <number>"
  • ledger:              "<number> ka ledger"   (or "ledger" for the customer already in hand)
  • invoice:             "<number> ka invoice"  (or "invoice")
  • discount:            "discount create karna hai <number>"
  • new customer account: "customer bana do <number>"
  • order status:        "<number> ka order kahan hai" or the order number
- WHEN THE DESK HAS ASKED THEM SOMETHING (a list to pick from, "haan / nahi", a question of the account form or of the discount setup, a quantity), their message is the answer: pass it to desk EXACTLY as they wrote it, word for word. Never reword an answer, never answer for them.
- "iska", "isi ka", "same customer", "is customer ka", or no customer named while you are already working on one: DO NOT repeat the number — say only "ledger", "invoice", "discount create karna hai", "check customer" or the parts. The desk knows the exact ACCOUNT it is on; a number can belong to several accounts and would bring back a "which one?" list for nothing.
- Call desk once per thing they asked. Two things in one message ("ledger bhejo aur order bhi lagana hai") = two calls, in order. Never send the desk the same words twice in one turn: if it said nothing, tell the staff member what you tried.

WHAT YOU SAY
- The desk's words are FACTS for you, not your reply. Say it in your own words, short, in the staff member's language (Hinglish to Hinglish, English to English). Keep every number exactly as the desk gave it: order numbers, amounts, part numbers, quantities, dates, GST numbers, rule numbers. Never make up a figure, a status or an order number; never say something was done that the desk did not do.
- If the desk asked a question, ask it — clearly, one question — and nothing else.
- A file (a ledger or invoice PDF) has gone to them ONLY when desk returns it in filesSent. "Sending the ledger…" in deskSaid is not a file sent: if filesSent is empty, no file went — give what the desk said instead (the balance, the reason), and never say "bhej diya".
- A price on a part line ("16510M65L10 x2 — Rs.106 (MRP Rs.120 - 12% discount)") is PER PIECE. Never call it a total and never add, multiply or total anything yourself.
- Respectful and warm, like a helpful colleague: "ji", "sir" where natural; never curt. No filler, no sign-off.
- If the desk could not do it, say what went wrong and what they can do, in one or two lines.`;

// FILES THE DESK SENT (a ledger PDF, an invoice), per chat, so the reply says
// a file went only when one did. 28 Sep, test: with no PDF (Odoo off) the desk
// still wrote "Sending the ledger…", and the model told the salesman it had
// been sent.
function tapFiles(bot) {
  const tr = bot && bot.transport;
  if (!tr || tr._staffFileTap || typeof tr.sendDocument !== 'function') return;
  const orig = tr.sendDocument.bind(tr);
  tr.sendDocument = async (chatId, buffer, filename, ...rest) => {
    const r = await orig(chatId, buffer, filename, ...rest);
    bot._filesSent = bot._filesSent || new Map();
    const list = bot._filesSent.get(chatId) || [];
    list.push(String(filename || 'file'));
    bot._filesSent.set(chatId, list.slice(-20));
    return r;
  };
  tr._staffFileTap = true;
}
const filesSoFar = (bot, chatId) => ((bot._filesSent && bot._filesSent.get(chatId)) || []).length;
const filesSince = (bot, chatId, n) => ((bot._filesSent && bot._filesSent.get(chatId)) || []).slice(n);

// ---------------------------------------------------------------- the tool
const desk = tool(
  async ({ say }, cfg) => {
    const c = (cfg && cfg.configurable) || {};
    const bot = c.bot;
    const m = c.message;
    if (!bot || !m) return JSON.stringify({ error: 'the desk cannot be reached from here' });
    const text = String(say || '').trim();
    if (!text) return JSON.stringify({ error: 'nothing to tell the desk' });
    const said = [];
    const run = c.run || (c.run = { calls: 0, said: [] });
    run.calls += 1;
    tapFiles(bot);
    const filesBefore = filesSoFar(bot, m.chatId);
    let handled = false;
    try {
      handled = await bot.handleMessage({
        ...m,
        id: (m.id || 'staff') + ':desk' + run.calls,
        body: text,
        buttonId: null,
        contextId: run.calls === 1 ? m.contextId || null : null,
        _desk: true,
        _capture: (x) => said.push(String(x || '')),
      });
    } catch (e) {
      store.log('staff-agent', 'desk failed: ' + String((e && e.message) || e).slice(0, 120));
      return JSON.stringify({ done: false, error: 'the desk hit an error: ' + String((e && e.message) || e).slice(0, 120) });
    }
    run.said.push(...said);
    store.log('staff-agent', `${m.from}: desk <- "${text.slice(0, 60)}" -> ${said.length} message(s)`);
    const files = filesSince(bot, m.chatId, filesBefore);
    return JSON.stringify({
      handled: Boolean(handled) || said.length > 0,
      deskSaid: said.length ? said : ['(the desk said nothing — it did not recognise this as a desk request)'],
      // What actually went to them as a file, just now. Empty = no file was sent.
      filesSent: files,
    });
  },
  {
    name: 'desk',
    description:
      'Tell the sales desk what to do, in one plain instruction ("order karna hai 9811122233 16510M65L10 2", "9811122233 ka ledger", "discount create karna hai 9811122233", "customer bana do 9811122233", "check customer 9811122233") — or, when the desk has asked the staff member something, pass their answer EXACTLY as they wrote it. Returns what the desk did and said, as facts for your reply.',
    schema: z.object({ say: z.string().describe('the instruction for the desk, or the staff member\'s answer word for word') }),
  },
);

// ---------------------------------------------------------------- the agent
let agent = null;
let builtWith = null;
function enabled() {
  return Boolean(config.agent.staffEnabled && config.agent.enabled && config.gemini && config.gemini.apiKey);
}
function build() {
  if (agent && builtWith === memory.currentCheckpointer()) return agent;
  builtWith = memory.currentCheckpointer();
  agent = createAgent({
    model: new ChatGoogleGenerativeAI({ model: config.agent.model, apiKey: config.gemini.apiKey, temperature: 0.2 }),
    tools: [desk],
    systemPrompt: STAFF_SYSTEM,
    checkpointer: builtWith,
    middleware: [toolCallLimitMiddleware({ runLimit: 6 }), memory.contextMiddleware({ createMiddleware, z })],
  });
  return agent;
}

// WHICH STAFF MESSAGES the agent takes. -> true when this one is for it.
const APPROVAL_WORDS = /^\s*(ok+|okay|okk+|haan|ha+n?|yes|yess|y|no|nahi|nhi|approve[d]?|reject(ed)?|done|theek|thik)\b[\s\S]{0,40}$/i;
function takes(bot, m) {
  if (!enabled() || m._desk) return false;
  // A typed message is "text" from the Cloud API and "chat" from the linked
  // transport and the simulator. 29 Sep, live: only "chat" was let through,
  // so no real WhatsApp message ever reached this agent - Nirmal's "Costamber
  // creat karni h" went to the desk's small talk ("…Mahesh ji…").
  if (m.buttonId || m.hasMedia || (m.mediaType && !['chat', 'text'].includes(String(m.mediaType)))) return false;
  const body = String(m.body || '').trim();
  if (!body) return false;
  const p = store.normPhone(m.from);
  // The helper answering escalated questions: exact codes, matched by core/escalation.
  if ([config.escalationNumber, config.voiceEscalationNumber].map(store.normPhone).includes(p)) return false;
  // An approval, or a command naming a request: the desk decides it at once.
  if (/\b(ORD|DSC|WA|SO)-[A-Z0-9]{3,}\b/i.test(body)) return false;
  const cc = require('../core/customerCreate');
  if (cc.isApprover(p) && APPROVAL_WORDS.test(body)) return false;
  return true;
}

// -> { handled, reply, deskCalls, deskSaid }
async function handle(bot, m) {
  const c = {
    thread_id: 'staff:' + m.chatId,
    chatId: m.chatId,
    phone: m.from,
    customer: null,
    bot,
    message: m,
    run: { calls: 0, said: [] },
  };
  const started = Date.now();
  tapFiles(bot);
  const filesAtStart = filesSoFar(bot, m.chatId);
  let out;
  try {
    out = await build().invoke({ messages: [{ role: 'user', content: String(m.body || '').trim() }] }, { configurable: c, recursionLimit: 16 });
  } catch (e) {
    store.log('staff-agent', `${m.from} failed after ${c.run.calls} desk call(s): ` + String((e && e.message) || e).slice(0, 140));
    return { handled: false, reply: null, deskCalls: c.run.calls, deskSaid: c.run.said };
  }
  const msgs = (out && out.messages) || [];
  let reply = '';
  for (let i = msgs.length - 1; i >= 0 && !reply; i--) {
    const x = msgs[i];
    if ((x.getType ? x.getType() : '') !== 'ai') continue;
    const ct = x.content;
    reply = typeof ct === 'string' ? ct : Array.isArray(ct) ? ct.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('') : '';
    reply = reply.trim();
  }
  store.log('staff-agent', `${m.from} ${Date.now() - started}ms, ${c.run.calls} desk call(s)`);
  // "Ledger bhej diya" with no file sent this turn is a thing that did not
  // happen: not said. The desk's own words go instead.
  if (reply && claimsFileSent(reply) && filesSince(bot, m.chatId, filesAtStart).length === 0) {
    store.log('staff-agent', `${m.from}: reply NOT sent — it says a file was sent, and none was: "${reply.slice(0, 100)}"`);
    return { handled: false, reply: null, deskCalls: c.run.calls, deskSaid: c.run.said };
  }
  // A figure in the reply that the desk never said is one the model made up.
  if (reply && inventedFigure(reply, c.run.said, m.body)) {
    store.log('staff-agent', `${m.from}: reply NOT sent — it has a number the desk never gave: "${reply.slice(0, 100)}"`);
    return { handled: false, reply: null, deskCalls: c.run.calls, deskSaid: c.run.said };
  }
  return { handled: Boolean(reply), reply: reply || null, deskCalls: c.run.calls, deskSaid: c.run.said };
}

// "ledger bhej diya", "PDF sent", "invoice bhej di hai", "attached".
function claimsFileSent(reply) {
  const s = String(reply || '');
  return /\b(ledger|invoice|pdf|statement|challan|bill|file)\b[^.\n]{0,40}\b(bhej\s*(diya|di|dia|diye|rahe|raha)|bheja|bhejdi|sent|attached|share\s*kar\s*(diya|di))\b/i.test(s) || /\b(sent|attached)\b[^.\n]{0,25}\b(ledger|invoice|pdf|statement)\b/i.test(s);
}

// Every order number, amount and part number in the reply must be in what the
// desk said or in what the staff member wrote. Small counts (1-12) are free:
// "2 accounts", "1 PDF".
function inventedFigure(reply, deskSaid, asked) {
  const seen = (String(asked || '') + '\n' + (deskSaid || []).join('\n')).toUpperCase().replace(/[,\s]/g, '');
  const tokens = String(reply).toUpperCase().match(/[A-Z0-9-]*\d[A-Z0-9.,-]*/g) || [];
  for (const raw of tokens) {
    const tok = raw.replace(/[,]/g, '').replace(/[.-]+$/, '');
    if (!tok) continue;
    if (/^\d+$/.test(tok) && Number(tok) <= 12) continue;
    if (!seen.includes(tok.replace(/\s/g, ''))) return tok;
  }
  return null;
}

module.exports = { enabled, takes, handle, STAFF_SYSTEM, _desk: desk, _inventedFigure: inventedFigure, _claimsFileSent: claimsFileSent };
