'use strict';
// Human-confirm escalation, with PERMANENT learning.
//
// Bot cannot identify a part -> DM the helper (ESCALATION_NUMBER)
//   -> helper answers within ESCALATION_TIMEOUT_MIN -> customer gets it
//   -> AND the answer is written into core/knowledge.js forever, so the
// same question is never escalated to a human a second time.
//
// Founder: "hamesha ke liye vo knowledge mein store ho jana chahiye, taki
// agli baar usse koi same sawal poochhe to vapas mujhse na poochhe."
//
// Helper reply format (in the bot's DM):
// E3 2               -> escalation #3, pick option 2
// E3 55810M75J30     -> escalation #3, this is the right part
// E3 no              -> escalation #3, not available
//   (with only one escalation pending, the "E3" prefix is optional)
const config = require('../config');
const store = require('../store');
const knowledge = require('./knowledge');
const lang = require('./lang');

let seq = 0;
const pending = new Map();

// Track when each helper last sent us a message, so we know whether the 24h
// Cloud API messaging window is open. WhatsApp's sendText does NOT throw when
// the window is closed — it returns a message id and silently fails to deliver
// (error 131047 arrives asynchronously via webhook). The only reliable fix is
// to send an approved template first to re-open the window.
const helperLastInbound = new Map();

// Part questions get a "could not confirm" follow-up when the helper is slow;
// these reasons never do (see create()).
const NO_FALLBACK_REASONS = ['NOT_A_PART', 'DOCUMENT', 'VOICE'];

// What survives a restart: everything needed to recognise and answer the
// question. Not the photo or the recording (the helper already has them in
// the chat), not the timer, not the live bot object.
function snapshot(e) {
  return {
    id: e.id,
    botKey: (e.customerBot && e.customerBot.key) || null,
    chatId: e.chatId,
    item: e.item,
    partNo: e.partNo || null,
    reason: e.reason,
    customerPhone: e.customerPhone,
    docName: e.docName || null,
    about: e.about || null,
    transcript: e.transcript || null,
    qty: e.qty,
    kind: e.kind,
    candidates: e.candidates || [],
    askedAt: e.askedAt,
    wamid: e.wamid || null,
    sentTo: e.sentTo || null,
    timedOut: Boolean(e.timedOut),
  };
}

function persist() {
  const st = store.load();
  const open = {};
  for (const [id, e] of pending) open[id] = snapshot(e);
  st.escalationsOpen = open;
  st.escalationSeq = seq;
  store.save();
}

function hasPending() {
  return pending.size > 0;
}

// Which person this question goes to. Only voice notes were split out —
// somebody has to put headphones on, and that is a different job from
// answering a part number. Everything else is untouched.
function helperFor(e) {
  return e && e.reason === 'VOICE' ? config.voiceEscalationNumber : config.escalationNumber;
}

// Every number that answers questions, so a reply from either is recognised.
function helperNumbers() {
  return [config.escalationNumber, config.voiceEscalationNumber].filter(Boolean);
}

// A transport that can actually DM the helper: a CONNECTED line that is not
// the helper's own number (a self-DM never comes back).
function pickSender(customerBot) {
  const bots = customerBot._allBots || {};
  for (const b of Object.values(bots)) {
    const t = b.transport;
    if (!t || !t.number || helperNumbers().includes(t.number)) continue;
    // Cloud API can SEND from the moment it holds a token. Its `state` tracks
    // the INBOUND webhook, which has nothing to do with our ability to send —
    // requiring state==='connected' here meant the helper was never reached on
    // the production transport, so nothing was ever learned.
    if (t.mode === 'CLOUD') return t;
    if (t.mode === 'LIVE' && t.state === 'connected') return t;
  }
  if (customerBot.transport.mode === 'SIMULATION') return customerBot.transport; // tests
  return null;
}

// Open the 24h Cloud API messaging window if it looks closed. The template is
// a one-line overhead and the only way to guarantee delivery — sendText alone
// returns a message id but silently drops it when the window is expired.
//
// Uses the approved 'order_update' template: "Update on your order {{1}} :{{2}}"
// with a short heads-up so the helper knows a question is coming.
const WINDOW_MS = 22 * 60 * 60 * 1000; // 22h with 2h safety margin
const TEMPLATE_NAME = (process.env.ESCALATION_TEMPLATE || 'order_update').trim();
async function ensureWindow(sender, helperPhone) {
  if (!sender.sendTemplate) return; // not Cloud API
  const norm = store.normPhone(helperPhone);
  const last = helperLastInbound.get(norm) || 0;
  if (Date.now() - last < WINDOW_MS) return; // window still open
  try {
    // 'order_update' is POSITIONAL with 2 body params: {{1}}=order ref, {{2}}=details.
    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Helper' },
          { type: 'text', text: 'New customer question incoming — details follow' },
        ],
      },
    ];
    await sender.sendTemplate(helperPhone, TEMPLATE_NAME, 'en', components);
    store.log('escalate', `sent ${TEMPLATE_NAME} template to ${norm} to open 24h window`);
    // Small delay to let WhatsApp process the template before the follow-up.
    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    store.log('escalate', `template send to ${norm} failed: ${String(err.message || err).slice(0, 100)}`);
  }
}

// ---------------------------------------------------------------- the ask
//
// The person answering these is doing it between customers, on a phone. Every
// question they get has to say four things without being read twice: WHO is
// waiting, WHAT is stuck, WHY the bot could not do it itself, and exactly what
// reply ends it.
//
// The reasons are genuinely different jobs, and one wording cannot serve them:
//
// NOT_IN_CATALOGUE we HAVE a part number, the portal has never heard of it.
// Nothing to identify — the question is whether we can
// supply it at all.
// NO_PART_NUMBER the customer described a part in words. The job is to
// name it.
// UNREADABLE a photo we could not read. The job is to read it.
//
// Sending "Confirm chahiye" for all three made the reader work out which
// situation they were in before they could start.

// Send something back to the person answering. Never throws: a confirmation
// that fails must not undo an answer that already reached the customer.
async function ack(e, text) {
  try {
    const sender = pickSender(e.customerBot);
    if (sender) await sender.sendText(config.escalationNumber, text);
  } catch (err) {
    store.log('escalate', 'ack failed: ' + String((err && err.message) || err).slice(0, 100));
  }
}

// How many are still open. Appended to a confirmation so the reader knows
// whether they are done or there is more — the single most useful thing to
// know right after answering one.
function waitingLine() {
  const n = pending.size;
  if (!n) return '\n\n_Nothing else pending._';
  const ids = [...pending.values()].map((p) => `#${p.id} ${p.partNo || p.item}`).slice(0, 5);
  return `\n\n_${n} still pending:_\n${ids.join('\n')}`;
}

function prettyPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return d ? '+' + d : 'customer';
}

function composeAsk(e) {
  const qty = e.qty && e.qty > 1 ? `  (qty ${e.qty})` : '';
  const head = `Question *#${e.id}* — ${prettyPhone(e.customerPhone)}\n_customer's inquiry_`;

  // Show the customer's own words ONLY when they differ from what the bot
  // extracted. Repeating an identical line twice reads as a mistake, and the
  // reader stops trusting the second line anywhere it appears.
  const raw = e.item && e.item !== e.partNo ? `\n_"${e.item}"_` : '';

  if (e.reason === 'NOT_IN_CATALOGUE') {
    return (
      `${head}\n\n${e.partNo}${qty}${raw}\n\n` +
      `This part number is not in the portal catalogue.\n\n` +
      `*Reply:*\n` +
      `• write the correct part no.\n` +
      // The helper confirming the number is right is a real answer, not a
      // failure: the part exists, we simply do not stock it. The customer then
      // hears the founder's line — on order, ETA = 7 days — rather than "no".
      `• *correct* — this part no. is correct`
    );
  }

  // A DOCUMENT is not a failed part lookup. The reader can see what it is;
  // what they cannot see is what the customer wants done about it.
  if (e.reason === 'DOCUMENT') {
    return (
      `${head}

Sent ${e.docName || 'a document'}.${raw}

` +
      `Not an order — needs a person.

` +
      `*Reply:* what should go back to them`
    );
  }

  // A rate request. We never quote one, so this is purely "who calls them
  // back, and with what number".
  if (e.reason === 'RATE') {
    return (
      `${head}\n\nAsking for the RATE on:\n${e.item}\n\n` +
      `*Reply:* the rate, or what to tell them`
    );
  }

  if (e.reason === 'VOICE') {
    return (
      `${head}\n\nSent a voice note — the recording follows.\n\n` +
      (e.transcript ? `_Heard:_ "${e.transcript}"\n_(machine transcript — play the audio if it looks wrong)_\n\n` : '') +
      (e.about ? `It is a reply to this list we sent:\n${e.about}\n\n` : '') +
      `*Reply:* the part no., or what to tell them`
    );
  }

  // Not a part at all — money, billing, a return, a complaint. The reader
  // needs the customer's own words, not a lookup.
  if (e.reason === 'NOT_A_PART') {
    return (
      `${head}

_"${e.item}"_

` +
      `Not a parts question — needs a person.

` +
      `*Reply:* what should go back to them`
    );
  }

  if (e.reason === 'UNREADABLE') {
    // With the photo attached the question needs no placeholder name — the
    // reader is looking at the thing. Without it, fall back to whatever we
    // managed to extract.
    const what = e.photo ? '' : `\n\n${e.partNo || e.item}${qty}${e.partNo ? raw : ''}`;
    const many = e.qty && e.qty > 1 ? ` (qty ${e.qty})` : '';
    return (
      `${head}${what}\n\n` +
      `Could not read the part number from this photo.${e.photo ? many : ''}\n\n` +
      `*Reply:* write the correct part no.`
    );
  }

  // NO_PART_NUMBER — the customer described the part instead of naming it.
  const cands = e.candidates || [];
  const near = cands.length
    ? `\nSimilar, learned earlier:\n${cands.map((c, i) => `${i + 1}) ${c}`).join('\n')}\n`
    : '';
  // Offer only the numbers that are actually on the list. "1 / 2 / 3" under a
  // two-line list invites an answer that does not exist.
  const pick = cands.length ? ` (or ${cands.map((_, i) => i + 1).join(' / ')} above)` : '';
  return (
    `${head}\n\n"${e.item}"${qty}\n\n` +
    `Part name not found in the catalogue.\n${near}\n` +
    `*Reply:*\n` +
    `• confirm part no.${pick}\n` +
    `• *no* — not available`
  );
}

// Suggest previously learned phrases that look related.
function candidatesFor(item) {
  const tokens = String(item)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  if (!tokens.length) return [];
  const hits = [];
  for (const name of knowledge.aliasNames()) {
    if (tokens.some((t) => name.includes(t))) hits.push(name);
    if (hits.length >= 3) break;
  }
  return hits;
}

async function create(
  customerBot,
  { chatId, item, qty, kind, partNo, reason, customerPhone, photo, audio, docName, about, transcript },
) {
  // The gate chain handed this to a person - noted for the shadow log only.
  require('../pipeline/shadow').noteHandoff(reason);
  // Learning only applies to questions about a PART. "voice note", "a bill",
  // "Please collect cheque tomorrow" are not phrases that map to a part
  // number, and teaching the bot that "voice note" MEANS 55810M75J30 would
  // make the next voice note from anyone resolve to that part without a
  // person ever seeing it.
  const teachable = !['VOICE', 'DOCUMENT', 'NOT_A_PART', 'RATE'].includes(reason);

  // Already learned? Then never ask a human again — this is the whole point.
  const learned = teachable ? knowledge.lookupAlias(item) : null;
  if (learned) {
    knowledge.noteAliasHit(item);
    store.log('escalate', `"${item}" already learned -> ${learned}; no human needed`);
    await resolveWithAnswer(
      { customerBot, chatId, customerPhone, item, qty: qty || 1, kind: kind || 'order' },
      learned,
      'memory',
    );
    return null;
  }

  // Questions now outlive their timeout so a late answer is still learned, so
  // something has to retire them eventually. A day is far longer than any
  // helper takes, and keeps the map from growing for the life of the process.
  const DAY = 24 * 60 * 60 * 1000;
  for (const [pid, pe] of pending) {
    if (pe.askedAt && Date.now() - pe.askedAt > DAY) pending.delete(pid);
  }
  persist();

  const id = ++seq;
  const candidates = candidatesFor(item);
  const e = {
    id,
    customerBot,
    chatId,
    item,
    // The part number the bot managed to extract, when it got one. Showing the
    // raw OCR line ("COIL ASSY IGNITION 33400 M 68K31") instead made the reader
    // do the extraction the bot had already done.
    partNo: partNo || null,
    // Why this could not be answered — decides which of the three questions
    // gets asked. Defaults to the commonest case.
    reason: reason || (partNo ? 'NOT_IN_CATALOGUE' : 'NO_PART_NUMBER'),
    customerPhone: customerPhone || String(chatId || '').replace(/@.*$/, ''),
    // The customer's own photo, when the question IS the photo. Nobody can
    // name a part from the words "label photo".
    photo: photo || null,
    // The recording, when the question is a voice note nothing here can hear.
    audio: audio || null,
    // "a bill", "a gate pass" — what the photo turned out to be.
    docName: docName || null,
    // The numbered list this message was a swipe-reply to. Kalra records a
    // voice note ON one of our availability lists — without knowing which
    // list, "leave the ninth one" means nothing to the person listening.
    about: about || null,
    // What Google heard in the recording. Shown ABOVE the audio so the reader
    // can usually answer without playing it — and the audio is still there
    // when the transcript is wrong.
    transcript: transcript || null,
    qty: qty || 1,
    kind: kind || 'order',
    candidates,
    timer: null,
    askedAt: Date.now(),
  };
  pending.set(id, e);
  persist();

  const msg = composeAsk(e);

  const sender = pickSender(customerBot);
  if (!sender) {
    pending.delete(id);
    persist();
    store.log('escalate', `E${id}: no connected line to reach the helper — direct fallback reply`);
    await fallbackReply(e);
    return null;
  }
  const to = helperFor(e);
  // Who was asked. Only that person's reply may answer it (see handleReply).
  e.sentTo = store.normPhone(to);

  // Open the 24h messaging window if it looks closed. Without this, sendText
  // silently succeeds but the message never reaches the helper (131047).
  await ensureWindow(sender, to);

  try {
    // Keep the id of the question we asked. The helper answers by REPLYING to
    // it with a bare part number — no "E7" prefix — and with several questions
    // open that reply is otherwise impossible to place.
    //
    // When the question is about a PHOTO, send the photo itself with the
    // question as its caption. A person can read a box label in a second; the
    // words "label photo" tell them nothing at all, and the whole point of
    // asking a human is that they can see what the machine could not.
    if (e.photo && e.photo.base64 && sender.sendImage) {
      try {
        e.wamid = await sender.sendImage(
          to,
          Buffer.from(e.photo.base64, 'base64'),
          e.photo.mime || 'image/jpeg',
          msg,
        );
        store.log('escalate', `E${id} sent to helper WITH the photo (${e.kind})`);
      } catch (perr) {
        // A failed upload must not lose the question — fall back to text.
        store.log(
          'escalate',
          `E${id}: photo send failed (${String(perr.message || perr).slice(0, 80)}), sending text`,
        );
        e.wamid = await sender.sendText(to, msg);
      }
    } else if (e.audio && e.audio.base64 && sender.sendAudio) {
      // WhatsApp allows no caption on audio, so the question goes first and
      // the recording follows it.
      e.wamid = await sender.sendText(to, msg);
      try {
        await sender.sendAudio(to, Buffer.from(e.audio.base64, 'base64'), e.audio.mime);
      } catch (aerr) {
        store.log('escalate', `E${id}: voice send failed (${String(aerr.message || aerr).slice(0, 80)})`);
      }
    } else {
      e.wamid = await sender.sendText(to, msg);
    }
    store.log('escalate', `E${id} sent to ${to} for "${item}" (${e.kind})`);
    persist(); // now with the message id a swipe-reply will quote
  } catch (err) {
    pending.delete(id);
    persist();
    store.log('escalate', `E${id}: helper send failed (${String(err.message || err).slice(0, 80)})`);
    await fallbackReply(e);
    return null;
  }

  // The timeout tells the customer we could not confirm a PART in time and
  // asks for the exact number. That is nonsense for the questions that were
  // never about a part: a bill, a voice note, "please collect cheque
  // tomorrow". Those customers have already been told a person is on it, and a
  // second message five minutes later asking for a part number reads as the
  // bot losing the thread — which is exactly what it looked like on the live
  // line today.
  const NO_FALLBACK = ['NOT_A_PART', 'DOCUMENT', 'VOICE'];
  if (!NO_FALLBACK.includes(e.reason)) {
    // last line of defence: a rejected promise inside a timer is unhandled and
    // would crash the process minutes after the message that started it
    e.timer = setTimeout(() => {
      onTimeout(id).catch((err) =>
        store.log('escalate', 'timeout handler error: ' + String((err && err.message) || err).slice(0, 120)),
      );
    }, config.escalationTimeoutMs);
  }
  return id;
}

// Never throws. This runs from a setTimeout five minutes after the fact, where
// an exception has no caller to catch it — an unhandled rejection there takes
// the whole bot down long after the message that caused it.
// One photo of eight unidentified parts used to produce EIGHT identical
// messages in the same second — a wall of text no person would ever send. The
// items are collected per chat for a moment and go out as a single line.
const pendingFallback = new Map(); // chatId -> { items:[], timer }
const FALLBACK_BATCH_MS = 1500;

async function fallbackReply(e) {
  const chatId = e.chatId;
  const batch = pendingFallback.get(chatId) || { items: [], bot: e.customerBot, timer: null };
  batch.items.push(e.item);
  batch.bot = e.customerBot;
  pendingFallback.set(chatId, batch);

  if (batch.timer) return; // one is already on its way for this chat
  batch.timer = setTimeout(() => {
    pendingFallback.delete(chatId);
    const items = batch.items;
    const list = items.length === 1 ? `"${items[0]}"` : items.map((i) => `• ${i}`).join('\n');
    const t = lang.for(chatId);
    const text =
      items.length === 1
        ? t(
            `We could not confirm ${list} yet. Please share the exact part number and I will check right away`,
            `${list} abhi confirm nahi ho paya. Exact part number bhej dijiye, turant check kar dunga`,
          )
        : t(
            `We could not confirm these ${items.length} items:\n${list}\n\nPlease share their part numbers and I will check right away`,
            `Ye ${items.length} item confirm nahi ho paye:\n${list}\n\nInke part number bhej dijiye, turant check kar dunga`,
          );
    batch.bot.transport
      .sendToChat(chatId, text)
      .catch((err) =>
        store.log('escalate', `fallback reply failed: ${String((err && err.message) || err).slice(0, 120)}`),
      );
  }, FALLBACK_BATCH_MS);
}

// The customer cannot wait, but the ANSWER is still worth having: learning it
// is the whole point, and a helper who replies twenty minutes later has taught
// us something permanent. So the timeout tells the customer we could not
// confirm in time and leaves the question open — a late reply still lands, is
// still learned, and simply does not interrupt that customer again.
async function onTimeout(id) {
  const e = pending.get(id);
  if (!e || e.timedOut) return;
  e.timedOut = true;
  persist();
  store.log('escalate', `E${id} timed out — customer told; still waiting on the helper`);
  await fallbackReply(e);
}

// Questions whose answer is a SENTENCE for the customer, not a part number.
// Each one tells the helper so: "what should go back to them", "the rate, or
// what to tell them", "the part no., or what to tell them".
const RELAY_REASONS = ['VOICE', 'DOCUMENT', 'RATE', 'NOT_A_PART'];

// One token holding a letter AND a digit, five characters or more — the same
// rule the order parser uses for a part number. Written with [0-9] rather
// than a backslash class: backslashes have gone missing on the way into this
// file before.
const PART_SHAPE = /^(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9][A-Za-z0-9-]{4,}$/;

// "16510M65L10" or "16510M65L10 2" -> { item, qty }. A sentence -> null.
function partAnswer(answer) {
  let lines = [];
  try {
    lines = require('./ai').parseLinesBlock(String(answer || '')) || [];
  } catch (_) {
    return null;
  }
  if (lines.length !== 1) return null;
  const item = String(lines[0].item || '').trim();
  if (!PART_SHAPE.test(item)) return null;
  return { item, qty: lines[0].qtyMissing ? null : lines[0].qty };
}

// The sales team asks on a customer's behalf and never orders, so a number on
// the inquiry-only list must never get a cart — whichever path answered it.
// Five call sites raise these questions as kind 'order'; fixing each one is
// how the sixth gets missed. So it is decided here, once.
function asksOnlyFor(e) {
  const bot = e && e.customerBot;
  const phone = (e && e.customerPhone) || String((e && e.chatId) || '').replace(/^sim-/, '');
  return Boolean(bot && typeof bot.inquiryOnly === 'function' && bot.inquiryOnly(phone, e && e.chatId));
}

// The helper's own words, to the customer, exactly as written.
async function relayWords(e, id, words) {
  await e.customerBot.transport.sendToChat(e.chatId, words);
  store.log('escalate', '#' + id + ' helper wrote back in words (' + e.reason + ') - relayed as written');
  await ack(e, '✅ *#' + id + ' sent* to ' + prettyPhone(e.customerPhone) + ' as written.' + waitingLine());
}

// Apply a resolved part number for an escalation and answer the customer.
async function resolveWithAnswer(e, chosen, source) {
  const orders = require('./orders');
  const availability = require('./availability');
  const reply = (text) => e.customerBot.transport.sendToChat(e.chatId, text);
  const t = lang.for(e.chatId);

  // LEARN IT — the next customer asking this never reaches a human.
  // Same rule on the way out: only a question that was about a part teaches
  // the bot anything.
  const teachable = !['VOICE', 'DOCUMENT', 'NOT_A_PART', 'RATE'].includes(e.reason);
  if (source !== 'memory' && teachable) knowledge.learnAlias(e.item, chosen, source || 'helper');

  const asksOnly = asksOnlyFor(e);
  if (e.kind === 'inquiry' && !asksOnly) {
    return reply(await e.customerBot.answerInquiry([chosen], null));
  }

  const resolved = await availability.resolve([{ item: chosen, qty: e.qty }]);
  const line = resolved[0];
  // A line the resolver does not recognise comes back 'unidentified', not
  // 'unknown'. Only 'unknown' was stopped here, so anything the helper typed
  // that is not in the catalogue went into the customer's cart as an order
  // line: "1. Sir kal tak aa jayega x 1 - checking".
  if (!line || line.source === 'unknown' || line.source === 'unidentified') {
    return reply(
      t(
        `We could not confirm "${chosen}". Our team will contact you shortly.`,
        `"${chosen}" abhi confirm nahi ho paya. Team aapse jald sampark karegi.`,
      ),
    );
  }
  // The sales team: the answer and nothing else. Not answerInquiry either —
  // that ends "Send items with quantities to place an order", an order
  // prompt to someone who never orders.
  if (asksOnly) {
    return reply(availability.describe(line, e.chatId));
  }

  const phone = e.customerPhone || String(e.chatId || '').replace(/^sim-/, '');
  const order = orders.getOrCreateDraft(e.chatId, phone);
  orders.addLines(order, [line]);
  // Confirm is asked ONCE, at the end, as everywhere else — not "Reply *YES*"
  // under a reprinted cart. That wording was taken out of every other message
  // and had survived only here.
  if (typeof e.customerBot.askToConfirmLater === 'function') {
    e.customerBot.askToConfirmLater({ chatId: e.chatId, from: phone, isGroup: false }, t);
  }
  return reply('✅ ' + orders.ack([line], order, []));
}

// Does a bare message look like an ANSWER to a part question? A part number
// ("16510M65L10", "16510M65L10 2"), an option number, or the yes/no words
// the helper is told to use. Anything else is a sentence, and a sentence
// without a swipe-reply is not assumed to be meant for a customer.
function answerShaped(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\d$/.test(t)) return true;
  if (/^(no|nahi|nhi|not available|na|correct|sahi|right|ok|valid|yes)\b/i.test(t) && t.split(/\s+/).length <= 4) return true;
  return Boolean(partAnswer(t));
}

// Taken off the queue by mistake: put it back, untouched, and let the
// message be handled as an ordinary one.
function backOut(e, id) {
  pending.set(id, e);
  persist();
  store.log('escalate', '#' + id + ' kept open - a bare sentence is not relayed without a reply to the question');
  return false;
}

// Reply from the helper number (registered on every transport, claims first).
async function handleReply(m) {
  if (m.isGroup || !helperNumbers().includes(store.normPhone(m.from))) return false;

  // Record that this helper messaged us — the 24h Cloud API window is now open.
  helperLastInbound.set(store.normPhone(m.from), Date.now());

  const text = (m.body || '').trim();

  // "pending" / "?" — what is still open. Answered even when nothing is, so a
  // quiet day gives a clear answer instead of silence.
  if (/^(pending|waiting|list|\?)$/i.test(text)) {
    const n = pending.size;
    await ack(
      { customerBot: anyBot },
      n
        ? `*${n} pending:*\n` +
            [...pending.values()]
              .map((p) => `#${p.id}  ${p.partNo || p.item}  — ${prettyPhone(p.customerPhone)}`)
              .join('\n') +
            `\n\n_Reply to any of them, or write *#<no> <answer>*._`
        : `Nothing pending. 👍`,
    );
    return true;
  }

  if (!pending.size) return false;

  let id = null;
  let answer = '';

  // 1. Swipe-to-reply on our question. This is how a person actually answers,
  // and it carries the link explicitly — no prefix to remember, and it works
  // with any number of questions open at once.
  const from = store.normPhone(m.from);
  const askedThem = (pe) => !pe.sentTo || pe.sentTo === from;
  let explicit = false; // a swipe-reply or "#1 ...": words may be relayed

  if (m.contextId) {
    for (const [pid, pe] of pending) {
      if (pe.wamid && pe.wamid === m.contextId && askedThem(pe)) {
        explicit = true;
        id = pid;
        answer = text;
        break;
      }
    }
  }

  // 2. The typed form, "E7 55810M75J30".
  if (id === null) {
    // "#12 55810M75J30", "E12 55810M75J30" or "12 55810M75J30" — the message
    // says #12, older ones said E12, and people type neither about half the
    // time. All three are accepted.
    const mm = text.match(/^[#E]?(\d+)[\s.:)-]+([\s\S]+)$/i);
    const mine = [...pending.entries()].filter(([, pe]) => askedThem(pe));
    if (mm && pending.has(parseInt(mm[1], 10)) && askedThem(pending.get(parseInt(mm[1], 10)))) {
      id = parseInt(mm[1], 10);
      answer = mm[2].trim();
      explicit = true;
    } else if (mine.length === 1 && answerShaped(text)) {
      // 3. Only one question open FOR THIS PERSON, and the message is an
      // answer: a part number, "correct", "no". A sentence is not taken as
      // an answer without a swipe-reply - it went to a customer once.
      id = mine[0][0];
      answer = text;
    } else {
      return false; // not an answer to anything we asked them - an ordinary message
    }
  }

  const e = pending.get(id);
  clearTimeout(e.timer);
  pending.delete(id);
  persist();

  // VOICE, DOCUMENT, RATE and NOT_A_PART ask the helper "what should go back
  // to them". Every such answer was being run through the part lookup:
  // "Sir kal tak aa jayega" landed in the customer's cart as an order line,
  // and "nahi hai abhi, kal aayega" came out as '"voice note" is not
  // available'. Words are relayed as written — checked BEFORE the "no" and
  // "correct" keywords below, which only make sense for a question about a
  // part. A reply that IS a part number is still looked up: "16510M65L10" to
  // a voice note means that part.
  if (RELAY_REASONS.includes(e.reason) && !partAnswer(answer)) {
    if (!explicit) return backOut(e, id);
    await relayWords(e, id, answer);
    return true;
  }

  if (/^(no|nahi|nhi|not available|na)\b/i.test(answer)) {
    await e.customerBot.transport.sendToChat(
      e.chatId,
      lang.for(e.chatId)(
        `"${e.item}" is not available. You can share an alternate part number if you have one.`,
        `"${e.item}" abhi available nahi hai. Aapke paas alternate part number ho to bhej dijiye.`,
      ),
    );
    store.log('escalate', `#${id} helper said NOT available`);
    await ack(
      e,
      `✅ *#${id} closed* — told ${prettyPhone(e.customerPhone)} that "${e.partNo || e.item}" is not available.` +
        waitingLine(),
    );
    return true;
  }

  // "correct" — the part number the customer sent is right; we just do not
  // carry it. That is an ANSWER, not a dead end: the customer hears "on order,
  // about a week" instead of "not available", and the number is remembered so
  // nobody is asked about it twice.
  if (/^(correct|sahi|right|ok|valid|yes)\b/i.test(answer) && e.partNo) {
    knowledge.markOnOrder(e.partNo, 'helper');
    const tt = lang.for(e.chatId);
    const days = config.onOrderEtaDays;
    await e.customerBot.transport.sendToChat(
      e.chatId,
      // The sales team hears the fact without the founder's "confirm and I
      // will reserve it" — they are not the one ordering.
      asksOnlyFor(e)
        ? tt(e.partNo + ' - on order, ETA = ' + days + ' days.', e.partNo + ' - on order hai, ETA = ' + days + ' days.')
        : tt(
            e.partNo + ' - it is on order, ETA = ' + days + ' days. Confirm and I will reserve it for you.',
            e.partNo + ' - ye on order hai, ETA = ' + days + ' days. Confirm kar dijiye, main aapke liye reserve kar dunga.',
          ),
    );
    store.log('escalate', `#${id} helper confirmed ${e.partNo} is valid but not stocked`);
    await ack(
      e,
      `✅ *#${id} done* — ${e.partNo} sent to ${prettyPhone(e.customerPhone)} as on-order.` + waitingLine(),
    );
    return true;
  }

  // an option number, or the part number typed directly
  let chosen = answer;
  const opt = answer.match(/^(\d)$/);
  if (opt && e.candidates[parseInt(opt[1], 10) - 1]) chosen = e.candidates[parseInt(opt[1], 10) - 1];

  // Words to a question about a part — "ye discontinued hai" — are relayed as
  // written too. Looked up, a sentence came back 'We could not confirm "ye
  // discontinued hai"', which tells the customer nothing.
  const pa = chosen === answer ? partAnswer(answer) : null;
  if (chosen === answer && !pa) {
    if (!explicit) return backOut(e, id);
    await relayWords(e, id, answer);
    return true;
  }
  // "16510M65L10 2" - the part, and the quantity the helper gave with it.
  if (pa) {
    chosen = pa.item;
    if (pa.qty) e.qty = pa.qty;
  }
  await resolveWithAnswer(e, chosen, 'helper');
  store.log('escalate', `#${id} resolved by helper -> "${chosen}" (learned)`);

  // Tell the person who answered what their answer did. Before this they sent
  // a part number into silence and had no way to know it had landed, gone to
  // the right customer, or been remembered — so they had no reason to trust it
  // and no way to notice when it broke.
  await ack(e, `✅ *#${id} done* — ${chosen} sent to ${prettyPhone(e.customerPhone)}.` + waitingLine());
  return true;
}

// Kept so a reply can be answered even when no question is open — the pending
// command needs a way to send, and pickSender needs a bot to look through.
let anyBot = null;

// Put back the questions that were open when the process stopped. A part
// question still inside its time gets the rest of that time; one whose time
// ran out while we were down is marked timed-out WITHOUT messaging the
// customer now - that moment has passed - and still waits for the answer.
function rehydrate(bots) {
  const st = store.load();
  if (typeof st.escalationSeq === 'number' && st.escalationSeq > seq) seq = st.escalationSeq;
  const saved = st.escalationsOpen || {};
  const DAY = 24 * 60 * 60 * 1000;
  let restored = 0;
  for (const snap of Object.values(saved)) {
    if (!snap || !snap.id || pending.has(snap.id)) continue;
    if (!snap.askedAt || Date.now() - snap.askedAt > DAY) continue;
    const bot = (snap.botKey && bots[snap.botKey]) || Object.values(bots)[0] || null;
    const e = { ...snap, customerBot: bot, photo: null, audio: null, timer: null };
    pending.set(e.id, e);
    if (e.id > seq) seq = e.id;
    if (!e.timedOut && !NO_FALLBACK_REASONS.includes(e.reason)) {
      const left = config.escalationTimeoutMs - (Date.now() - e.askedAt);
      if (left > 0) {
        e.timer = setTimeout(() => {
          onTimeout(e.id).catch((err) =>
            store.log('escalate', 'timeout handler error: ' + String((err && err.message) || err).slice(0, 120)),
          );
        }, left);
      } else {
        e.timedOut = true;
      }
    }
    restored++;
  }
  if (restored) store.log('escalate', restored + ' open helper question(s) restored after restart');
  persist();
  return restored;
}

// Tests only: forget what is in memory, as a restart would.
function _forgetInMemory() {
  for (const e of pending.values()) clearTimeout(e.timer);
  pending.clear();
  seq = 0;
}

function attach(bots) {
  anyBot = Object.values(bots)[0] || null;
  rehydrate(bots);
  for (const t of new Set(Object.values(bots).map((b) => b.transport))) {
    t.onMessage((m) => handleReply(m));
  }
  for (const b of Object.values(bots)) b._allBots = bots; // for pickSender
}

module.exports = {
  helperFor,
  helperNumbers,
  attach,
  create,
  hasPending,
  handleReply,
  // exported so the timeout path can be exercised without waiting five minutes
  _testTimeout: onTimeout,
  _rehydrate: rehydrate,
  _forgetInMemory,
};
