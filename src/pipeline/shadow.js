'use strict';
// Phase 3 of the pipeline review (13 Sep): the Understand model runs BESIDE
// the bot on live traffic, and speaks to nobody.
//
// For every message the bot is meant to handle:
//   1. before the bot touches it, a snapshot of what the chat looks like - the
//      open question, the cart, what was just discussed, the last turns
//   2. the bot handles it exactly as before (the gate chain decides, replies)
//   3. afterwards, off the reply path, one model call on the snapshot
//   4. one line in /shared/shadow.jsonl: the message, what the gates decided
//      and said, what the model decided. That file is what gets read by hand
//      before Phase 4 lets the model route anything.
//
// It cannot change a reply: the snapshot only reads state, the model call
// starts after the handler has finished, its result goes only to the file,
// and every failure in here is swallowed. Off unless AI_SHADOW=true.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');
const store = require('../store');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_IN_FLIGHT = 3; // a burst of messages must not become a burst of model calls
const OPEN_WINDOW_MS = 60 * 60 * 1000;

const trace = new AsyncLocalStorage();
const pending = new Set();

function enabled() {
  return Boolean(config.ai.shadow && (config.ai.apiKey || require('./understand')._stubbed()));
}

function file() {
  return path.join(config.sharedDir, 'shadow.jsonl');
}

function write(entry) {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
    if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, path.join(path.dirname(f), 'shadow.1.jsonl'));
  } catch (e) {
    // the bot never stops because a log line could not be written
  }
}

// What the gate chain decided, noted from inside the handler. Return the value
// unchanged: these sit on the real path.
function noteGate(parsed) {
  const t = trace.getStore();
  if (t && parsed && parsed.intent) t.intents.push(parsed.intent);
  return parsed;
}

function noteHandoff(reason) {
  const t = trace.getStore();
  if (t) t.handoffs.push(reason || 'unknown');
}

// Phase 4 (13 Sep): the bot now asks the model too, where the gates would hand
// a message to a person or drop an order. Asked ONCE per message: the bot and
// the shadow log share the answer, read from the chat as it was before the bot
// touched it when shadow took that snapshot.
const decisions = new WeakMap();
function decide(m) {
  let p = decisions.get(m);
  if (!p) {
    const t = trace.getStore();
    p = require('./understand').understand((t && t.snap) || snapshot(m));
    p.catch(() => {});
    decisions.set(m, p);
  }
  return p;
}

function roleOf(m) {
  const route = require('./route');
  const p = store.normPhone(m.from);
  if (config.adminNumbers.includes(p)) return 'admin';
  if (require('../core/salesOrder').isSalesPerson(m.from)) return 'salesman';
  if (require('../core/partApprovals').isApprover(m.from)) return 'approver';
  if (route.isStaff(m.from)) return 'staff';
  if (route.inquiryOnly(m.from, m.chatId)) return 'inquiryOnly';
  return 'customer';
}

const short = (v, n = 240) => {
  try {
    return JSON.stringify(v).slice(0, n);
  } catch (e) {
    return '';
  }
};

// Read-only. Slots are read directly rather than through each module's get(),
// because those sweep and expire - the bot does that itself a moment later.
function snapshot(m) {
  const chatState = require('../core/chatState');
  const partish = require('../core/partish');
  const conversation = require('../core/conversation');
  const chatLog = require('../core/chatLog');
  const chatId = m.chatId;
  const now = Date.now();
  const text = String(m.body || '').trim();
  const slot = (name) => chatState.slot(name).get(chatId) || null;
  const ageOf = (v) => (typeof v === 'number' ? v : v && typeof v.at === 'number' ? v.at : v && v.at ? Date.parse(v.at) : null);

  const open = [];
  const add = (kind, value, about) => {
    const at = ageOf(value);
    if (!value || (at && now - at > OPEN_WINDOW_MS)) return;
    open.push({ kind, minutesAgo: at ? Math.round((now - at) / 60000) : null, about });
  };
  // The confirm steps, the same for everyone (founder, 13 Sep): list + "Confirm
  // karun?" -> yes punches a draft SO, sent with "Sahi hai?" -> only a yes to
  // that confirms. The model is told which step this chat is on.
  const draftRow = store.orders().find((o) => o.chatId === chatId && o.status === 'draft') || null;
  if (draftRow && draftRow.confirmAskedAt && (draftRow.lines || []).length) {
    add(
      'confirmAsk',
      { at: draftRow.confirmAskedAt },
      'we showed the cart list (' + draftRow.lines.length + ' item) and asked "Confirm karun? / punch kar dun?" - a yes now punches it as a draft SO',
    );
  }
  const so = (store.load().soReview || {})[chatId];
  add(
    'soReview',
    so,
    so
      ? 'we punched draft SO ' + (so.orderIds || []).join(', ') + (so.customerName ? ' for ' + so.customerName : '') +
          ' and asked "Sahi hai?" - a yes now CONFIRMS it (allocation starts); "2 hata do" removes a line; cancel deletes it'
      : '',
  );
  const voice = slot('voiceOrder');
  add('voiceYes', voice, voice ? 'we read back a voice note (' + voice.transcript + ') as ' + (voice.lines || []).map((l) => l.item + ' x' + l.qty).join(', ') + ' and wait for a yes' : '');
  const qty = slot('askQty.pending');
  add('qty', qty, qty ? 'we asked how many of: ' + (qty.items || []).map((i) => i.partNo || i.item).join(', ') : '');
  const cl = slot('clarify.pending');
  const clAsked = slot('clarify.lastAsked');
  add('clarify', cl, cl ? 'we asked which "' + cl.base + '" they mean' + (clAsked && clAsked.text ? ': ' + clAsked.text : '') : '');
  add('cancel', slot('cancelAsk'), 'we asked whether to cancel the whole order');
  const sess = slot('sales.session');
  if (sess && sess.stage && sess.stage !== 'active') add('pickCustomer', sess, 'salesman is choosing a customer: ' + short(sess.candidates, 200));

  const focusRow = slot('focus');
  const onBehalf = require('./route').onBehalfOf(m);

  return {
    at: new Date(now).toISOString(),
    chatId,
    phone: String(m.from || '').replace(/[^0-9]/g, ''),
    role: roleOf(m),
    onBehalf: onBehalf ? onBehalf.name || null : null,
    kind: chatLog._kindOf ? chatLog._kindOf(m) : m.mediaType || 'text',
    text: text.slice(0, 1000),
    quoted: Boolean(m.contextId),
    open,
    draft: draftRow
      ? {
          id: draftRow.id,
          lines: (draftRow.lines || []).slice(0, 40).map((l) => ({
            item: l.requested || l.item,
            partNo: l.partNo || null,
            qty: l.qty || null,
            status: l.status || null,
            rate: l.rate || null,
          })),
        }
      : null,
    focus:
      focusRow && now - (focusRow.at || 0) <= OPEN_WINDOW_MS
        ? (focusRow.items || []).map((i) => ({ item: i.item, partNo: i.partNo || null }))
        : [],
    turns: conversation.recent(chatId, 12),
    hints: [partish.partNumber(text)].filter(Boolean),
    shape: partish.classify(text),
  };
}

// The gates' intent names, in the Decision's words, for a first-glance
// agree/disagree. The hand review reads the replies, not this.
const GATE_AS = { set_qty: 'setQty', maybe_cancel: 'cancel', status: 'ownAccount', other: 'chat' };

function finish(bot, m, snap, t, t0, handled, threw) {
  const conversation = require('../core/conversation');
  const replies = conversation
    .turns(m.chatId)
    .filter((x) => x.role === 'us' && x.at >= t0)
    .map((x) => x.text.slice(0, 300));
  const gate = {
    intents: t.intents,
    handoffs: t.handoffs,
    handled: handled === true || handled === false ? handled : handled == null ? null : String(handled).slice(0, 40),
    replies,
    ms: Date.now() - t0,
    error: threw ? String(threw.message || threw).slice(0, 200) : undefined,
  };
  const base = { ...snap, bot: (bot && bot.key) || null, gate };

  // The bot already asked the model about this message: log that answer.
  const asked = decisions.get(m);
  if (!asked && pending.size >= MAX_IN_FLIGHT) {
    write({ ...base, model: { skipped: 'too many model calls in flight' } });
    return;
  }
  const p = (asked || require('./understand').understand(snap))
    .then(
      (r) => ({ ...r.decision, guards: r.guards, ms: r.ms }),
      (e) => ({ error: String((e && e.message) || e).slice(0, 200) }),
    )
    .then((model) => {
      const g = gate.handoffs.length ? 'handoff' : gate.intents.length ? GATE_AS[gate.intents[0]] || gate.intents[0] : null;
      write({ ...base, model, agree: g && model.intent ? g === model.intent : null });
      if (model.error) store.log('shadow', 'model failed: ' + model.error);
    })
    .catch(() => {})
    .finally(() => pending.delete(p));
  pending.add(p);
}

// Wraps the bot's handler. Returns exactly what the handler returns, throws
// exactly what it throws.
async function around(bot, m, handler) {
  if (!enabled()) return handler();
  let snap = null;
  try {
    // Every message in a chat the bot serves - Cartrends staff talking in a
    // group included, so the log reads as the whole conversation. Only the
    // bot's own numbers are left out.
    const own = Object.values(config.bots)
      .map((b) => b.number)
      .filter(Boolean);
    if (require('./route').listensTo(m) && !own.includes(m.from)) snap = snapshot(m);
  } catch (e) {
    store.log('shadow', 'snapshot failed: ' + String((e && e.message) || e).slice(0, 120));
  }
  if (!snap) return handler();

  const t = { intents: [], handoffs: [], snap };
  const t0 = Date.now();
  let handled;
  let threw = null;
  try {
    handled = await trace.run(t, handler);
    return handled;
  } catch (e) {
    threw = e;
    throw e;
  } finally {
    try {
      finish(bot, m, snap, t, t0, handled, threw);
    } catch (e) {
      store.log('shadow', 'could not start the model call: ' + String((e && e.message) || e).slice(0, 120));
    }
  }
}

module.exports = {
  around,
  noteGate,
  noteHandoff,
  decide,
  enabled,
  _file: file,
  _snapshot: snapshot,
  _flush: () => Promise.all([...pending]),
};
