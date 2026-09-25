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
// RATE belongs here too. The follow-up asks for "the exact part number", which
// is the wrong question entirely when the customer already named the part and
// asked what it costs - on 23 Sep a rate question came back as
// 'We could not confirm "WB17, WB18" yet. Please share the exact part number'.
const NO_FALLBACK_REASONS = ['NOT_A_PART', 'DOCUMENT', 'VOICE', 'RATE'];

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
    customerMessageId: e.customerMessageId || null,
    // Other customers who asked the same thing while this was open. They get
    // the same answer, so they have to survive a restart with it.
    waiters: e.waiters || [],
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

// Is this the question we are already waiting on an answer for? Compared on
// words rather than characters, so "Cartend wiper blade 16 number" and
// "cartend wiper blade 16 no." are recognised as one question.
function sameQuestion(a, b) {
  const words = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => w && !/^(ka|ki|ke|ko|hai|h|chahiye|chaiye|number|no|nos|pcs|pc|piece|pieces|qty|the|a|of|for)$/.test(w));
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  if (x.length !== y.length) return false;
  const sx = [...x].sort().join(' ');
  const sy = [...y].sort().join(' ');
  return sx === sy;
}

// LAST CHANCE AT THE PORTAL, before a person is asked.
//
// Founder, 23 Sep: message Prateek sir only when we cannot get the data from
// the dealer portal. Every caller here already reaches this point BECAUSE the
// portal could not identify the line — but "could not identify" and "is not
// there" are different things: the portal's analyze route matches on part
// number, and a customer who typed a NAME ("clutch plate swift") comes back
// unidentified while the catalogue search finds it immediately.
//
// So the catalogue is searched by name once more here. A single confident hit
// is the answer, and nobody is asked. Anything else — several matches, none,
// or a portal that will not answer — is the case the founder means by
// "unable to fetch", and the question goes to a person as before.
//
// Never throws: a portal that is down must not stop a question reaching a
// human, which is the whole point of the escalation.
async function portalCanAnswer(item, reason) {
  if (!['NOT_IN_CATALOGUE', 'NO_PART_NUMBER'].includes(reason)) return null;
  const asked = String(item || '').trim();
  if (asked.length < 4) return null;

  // A QUESTION IS NOT A PART, AND MUST NOT BE SEARCHED AS ONE.
  //
  // The catalogue search drops words until something matches, so a question
  // reaches it as a bag of words and can come back with exactly one row.
  // "kya tum log sunday ko khule ho" matched B102AKYAA01 — one row, therefore
  // "confident" — and because the caller LEARNS what this returns, the phrase
  // was aliased to that part for good. Every customer asking about Sunday
  // opening would then have been quoted a part number.
  //
  // availability.byName has always refused questions and vehicles. This path
  // went to the portal directly and so never got that refusal; now it does.
  const partish = require('./partish');
  if (partish.isQuestion(asked) || partish.isVehicle(asked)) {
    store.log('escalate', `"${asked.slice(0, 40)}" is a ${partish.classify(asked)}, not a part — not searched, going to a person`);
    return null;
  }

  try {
    const portal = require('../integrations/dealerPortal');
    const rows = ((await portal.searchByName(asked, 5)) || {}).top || [];
    if (rows.length !== 1) return null; // ambiguous or nothing — ask a person
    const hit = rows[0];
    if (!hit || !hit.partNo) return null;

    // ONE ROW IS NOT THE SAME AS THE RIGHT ROW. The single hit still has to
    // agree with what the customer actually said — the same rule the keyword
    // and vector paths already apply, and the one that keeps a Fortuner blade
    // from answering a Cartrends question.
    if (!require('./availability').matchTrustworthy(asked, hit)) {
      store.log('escalate', `"${asked.slice(0, 40)}" -> ${hit.partNo} contradicts the question — asking a person instead`);
      return null;
    }
    return hit;
  } catch (err) {
    store.log('escalate', 'portal could not be reached before escalating: ' + String((err && err.message) || err).slice(0, 80));
    return null;
  }
}

// WHAT A PERSON ALREADY TOLD US, FOUND BY MEANING.
//
// Never throws: a database that cannot be reached costs this question its
// recall and nothing else — it goes to a person, which is what used to happen
// every time.
async function recallLearnedPhrase(item) {
  try {
    const parts = require('./parts');
    if (!parts.enabled()) return null;
    return await parts.recall(item);
  } catch (err) {
    store.log('escalate', 'could not recall a learned phrase: ' + String((err && err.message) || err).slice(0, 80));
    return null;
  }
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
async function ensureWindow(sender, helperPhone, headsUp = 'New customer question incoming — details follow') {
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
          { type: 'text', text: headsUp },
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

// Every question reads the same whether it was typed or spoken. When it was
// spoken, the reader is told so — the words above are Google's best guess and
// the recording is right underneath them. VOICE says this in its own words,
// because there the recording is the whole question.
function composeAsk(e) {
  const text = composeAskBody(e);
  if (e.reason === 'VOICE' || !e.audio || !e.transcript) return text;
  const note =
    `\n\n_Heard in their voice note:_ "${e.transcript}"` +
    `\n_(machine transcript — the recording follows)_`;
  return text.includes('*Reply:*')
    ? text.replace('\n\n*Reply:*', note + '\n\n*Reply:*')
    : text + note;
}

function composeAskBody(e) {
  const qty = e.qty && e.qty > 1 ? `  (qty ${e.qty})` : '';
  // WHO is asking, and the whole message it came from. A part a helper has to
  // identify is identified from its neighbours - the other lines of the list
  // say which car, which brand - and a name says whether this is a regular.
  const who = e.customerName ? `${e.customerName} (${prettyPhone(e.customerPhone)})` : prettyPhone(e.customerPhone);
  const whole = e.context && String(e.context).trim() && String(e.context).trim() !== String(e.item || '').trim()
    ? `\n\n_Their message:_\n${String(e.context).trim().slice(0, 700)}`
    : '';
  const head = `Question *#${e.id}* — ${who}\n_customer's inquiry_${whole}`;

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
  { chatId, item, qty, kind, partNo, reason, customerPhone, photo, audio, docName, about, transcript, customerName, context, customerMessageId, agentThread },
) {
  // The gate chain handed this to a person - noted for the shadow log only.
  require('../pipeline/shadow').noteHandoff(reason);

  // The customer SPOKE this message and the text path could not finish it.
  // The words the helper is about to read are a machine's best guess, so the
  // recording goes with them — "16510M65L10" against "16510M65L70" is settled
  // by playing the clip, never by reading it. core/voiceNote holds the clip
  // for the message being handled and nothing else.
  if (!audio) {
    const clip = require('./voiceNote').forChat(chatId);
    if (clip) {
      audio = { base64: clip.base64, mime: clip.mime };
      if (!transcript) transcript = clip.transcript;
    }
  }
  // Learning only applies to questions about a PART. "voice note", "a bill",
  // "Please collect cheque tomorrow" are not phrases that map to a part
  // number, and teaching the bot that "voice note" MEANS 55810M75J30 would
  // make the next voice note from anyone resolve to that part without a
  // person ever seeing it.
  const teachable = !['VOICE', 'DOCUMENT', 'NOT_A_PART', 'RATE'].includes(reason);

  // WHEN THE AGENT IS DRIVING, THIS FUNCTION NEVER TALKS TO THE CUSTOMER.
  //
  // Every early exit below used to answer the customer itself, which is right
  // for the deterministic bot and wrong for the agent: the agent is mid-
  // conversation and about to answer too, so the customer got the same thing
  // said twice, in two different voices.
  //
  // Measured, 23 Sep: a specialist's part number came back and the customer
  // received the identical "abhi confirm nahi ho paya" line twice — once from
  // here, once from the fallback. With the agent driving, what would have
  // been sent is RETURNED instead, and the agent says it once, properly.
  const forAgent = Boolean(agentThread);

  // Already learned? Then never ask a human again — this is the whole point.
  const learned = teachable ? knowledge.lookupAlias(item) : null;
  if (learned) {
    knowledge.noteAliasHit(item);
    store.log('escalate', `"${item}" already learned -> ${learned}; no human needed`);
    if (forAgent) return { knownAlready: true, partNo: learned };
    await resolveWithAnswer(
      { customerBot, chatId, customerPhone, item, qty: qty || 1, kind: kind || 'order' },
      learned,
      'memory',
    );
    return null;
  }

  // Answered before in WORDS ("ye brand hum nahi rakhte", "16 inch wala
  // kal aayega"): the customer gets the same answer, and nobody is asked.
  const taught = teachable ? knowledge.findNote(item) : null;
  if (taught) {
    store.log('escalate', `"${item}" answered before (${taught.id}) - sent that, no human needed`);
    if (forAgent) return { fromNote: true, note: taught, answerText: taught.answer };
    try {
      await customerBot.transport.sendToChat(chatId, `${item}: ${taught.answer}`);
    } catch (err) {
      store.log('escalate', 'could not send the learned answer: ' + String((err && err.message) || err).slice(0, 80));
    }
    return { fromNote: true, note: taught };
  }

  // Told recently that we do not carry this. The customer gets the same answer
  // they would have got after waiting for a person, immediately, and nobody is
  // asked a question already answered. Goes stale on its own (see
  // knowledge.notCarried) so a newly stocked part is not refused forever.
  const refused = teachable ? knowledge.notCarried(partNo || item) : null;
  if (refused) {
    store.log('escalate', `"${item}" was answered "not available" on ${String(refused.at).slice(0, 10)} - said so again, nobody asked`);
    try {
      const tt = lang.for(chatId);
      await customerBot.transport.sendToChat(
        chatId,
        tt(
          `"${item}" is not available. You can share an alternate part number if you have one.`,
          `"${item}" abhi available nahi hai. Aapke paas alternate part number ho to bhej dijiye.`,
        ),
      );
    } catch (err) {
      store.log('escalate', 'could not repeat the not-available answer: ' + String((err && err.message) || err).slice(0, 80));
    }
    return { notCarried: true, since: refused.at };
  }

  // Questions now outlive their timeout so a late answer is still learned, so
  // something has to retire them eventually. A day is far longer than any
  // helper takes, and keeps the map from growing for the life of the process.
  const DAY = 24 * 60 * 60 * 1000;
  for (const [pid, pe] of pending) {
    if (pe.askedAt && Date.now() - pe.askedAt > DAY) pending.delete(pid);
  }
  persist();

  // ALREADY ASKED. The same question was being sent again every time anyone
  // asked it, so one wiper size appeared four times in a queue that reached
  // 67 — and the more a queue repeats itself, the less any message in it
  // means.
  //
  // Only where `item` IS the question. For a voice note or a document it is
  // the label "voice note", identical for every recording anybody sends, and
  // deduplicating on that drops real questions on the floor.
  //
  // The second customer is NOT forgotten: they are recorded as waiting on the
  // same answer and are sent it the moment it arrives. Suppressing the ask
  // without that would leave them waiting forever, which is worse than asking
  // twice. The caller still tells them a person is on it — one is.
  // PART questions only. Those are the ones that actually repeat — 63 of the
  // 67 in the queue, the same wiper sizes over and over. A business question
  // ("Please collect cheque tomorrow") is rare, and two of them that read
  // alike are usually not the same request at all, so those still go through
  // every time.
  // RATE repeats more than anything else: a customer types "Price" twice in a
  // minute and he was sent questions #30, #31 and #32 about the same parts.
  const DEDUPE_REASONS = ['NOT_IN_CATALOGUE', 'NO_PART_NUMBER', 'RATE'];
  const already = DEDUPE_REASONS.includes(reason || '')
    ? [...pending.values()].find((pe) => pe.reason === reason && sameQuestion(pe.item, item) && !pe.timedOut)
    : null;
  if (already) {
    const phone = customerPhone || String(chatId || '').replace(/@.*$/, '');
    if (!already.waiters) already.waiters = [];
    if (already.chatId !== chatId && !already.waiters.some((w) => w.chatId === chatId)) {
      already.waiters.push({ chatId, customerPhone: phone, qty: qty || 1, kind: kind || 'order' });
      persist();
    }
    store.log(
      'escalate',
      `"${item}" is already open as #${already.id} - not asking again` +
        (already.waiters.length ? ` (${already.waiters.length} also waiting)` : ''),
    );
    return { alreadyOpen: already.id };
  }

  // ASKED BEFORE IN OTHER WORDS.
  //
  // The alias map above is a string key, and it only answers the wording it was
  // taught. Two customers never write the same sentence, so a part Prateek sir
  // had already named came back to him under a new phrasing — the one thing the
  // knowledge shift was supposed to make impossible:
  //
  //   "swift ka clutch plate chahiye"       he answered this
  //   "clutch plate for swift dzire 2 pcs"  and was asked it again
  //
  // core/parts/aliases holds the same lesson embedded, so the question only has
  // to MEAN the same thing. It refuses on its own terms — a near-tie between
  // two remembered parts, or a phrase that contradicts what was actually said,
  // comes back without a part number and a person is asked, as before.
  const recalled = teachable ? await recallLearnedPhrase(item) : null;
  if (recalled && recalled.partNo) {
    store.log(
      'escalate',
      `"${item}" means ${recalled.partNo} — learned from "${String(recalled.phrase || '').slice(0, 40)}"` +
        (recalled.exact ? '' : ` (${Number(recalled.similarity).toFixed(2)})`) +
        '; no human needed',
    );
    // Taught under this wording too, so the next one is the free string-key
    // hit above rather than another embedding call.
    knowledge.learnAlias(item, recalled.partNo, 'memory', { partName: recalled.name });
    if (forAgent) return { knownAlready: true, partNo: recalled.partNo };
    try {
      await resolveWithAnswer(
        { customerBot, chatId, customerPhone, item, qty: qty || 1, kind: kind || 'order' },
        recalled.partNo,
        'memory',
      );
      return null;
    } catch (err) {
      // Answering failed for some other reason — fall through and ask, rather
      // than leave the customer with nothing.
      store.log('escalate', 'recalled answer could not be delivered: ' + String((err && err.message) || err).slice(0, 80));
    }
  }

  // The portal, one last time, by NAME. If it holds this part there is no
  // question to ask anybody — the customer is answered from the catalogue and
  // the phrase is learned so the next one never gets this far.
  const onPortal = await portalCanAnswer(item, reason);
  if (onPortal) {
    store.log('escalate', `"${item}" found on the portal as ${onPortal.partNo} - answered from there, nobody asked`);
    if (teachable) knowledge.learnAlias(item, onPortal.partNo, 'portal');
    if (forAgent) return { fromPortal: true, partNo: onPortal.partNo, knownAlready: true };
    try {
      await resolveWithAnswer(
        { customerBot, chatId, item, qty, kind, customerPhone, reason, candidates: [] },
        onPortal.partNo,
        'memory',
      );
      return { fromPortal: true, partNo: onPortal.partNo };
    } catch (err) {
      // Answering failed for some other reason — fall through and ask, rather
      // than leave the customer with nothing.
      store.log('escalate', 'portal answer could not be delivered: ' + String((err && err.message) || err).slice(0, 80));
    }
  }

  const id = ++seq;
  const candidates = candidatesFor(item);
  const e = {
    id,
    customerBot,
    chatId,
    item,
    // The part number the bot managed to extract, when it got one. Showing the
    // raw line off the photo ("COIL ASSY IGNITION 33400 M 68K31") instead made the reader
    // do the extraction the bot had already done.
    partNo: partNo || null,
    // Why this could not be answered — decides which of the three questions
    // gets asked. Defaults to the commonest case.
    reason: reason || (partNo ? 'NOT_IN_CATALOGUE' : 'NO_PART_NUMBER'),
    customerPhone: customerPhone || String(chatId || '').replace(/@.*$/, ''),
    customerName: customerName || null,
    // The id of the CUSTOMER message that raised this, for the learning
    // record. Not the id of what we send the helper.
    customerMessageId: customerMessageId || null,
    context: context || null,
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
    // THE AGENT'S PAUSED CONVERSATION, when the agent raised this.
    //
    // The agent stops mid-turn waiting for the answer, so when it lands it
    // must go back to that conversation and be turned into a reply there —
    // not sent to the customer from here. Without this the customer gets
    // answered twice: once by resolveWithAnswer, once by the agent resuming.
    agentThread: agentThread || null,
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

    // The learning record. Deliberately not awaited and never able to throw:
    // the customer's question has already gone to a person, and a database
    // that is down must not change that. See core/kb/db.js.
    require('./kb')
      .recordEscalation({
        local_ref: String(id),
        customer_id: store.normPhone(e.customerPhone),
        conversation_id: e.chatId,
        // The customer's OWN message, not e.wamid — that is the id of the
        // message we just sent to the helper, and storing it here made the
        // column say the opposite of its name.
        customer_message_id: e.customerMessageId || null,
        question: item,
        reason: e.reason,
        assigned_to: to,
      })
      .catch(() => {});
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
  // AND NEVER WHEN THE AGENT IS DRIVING.
  //
  // The agent has already told this customer that a specialist is reviewing
  // it, and it owns the next thing they hear. A timeout message from here is
  // a second voice arriving five minutes later — live, that was an English
  // "do you deliver to Gurgaon?" answered with "Exact part number bhej
  // dijiye". The specialist is still being waited on either way; the customer
  // simply is not nagged while it happens.
  if (!NO_FALLBACK.includes(e.reason) && !e.agentThread) {
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
  // The agent's own question: the agent tells the customer, in its words.
  if (await timeoutToAgent(e)) {
    store.log('escalate', `E${id} timed out — the agent told the customer; still waiting on the helper`);
    return;
  }
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

// Hand an answered question to the knowledge base. Never throws and never
// changes what the customer was told — by the time this runs they already have
// their answer, so the worst case is that we failed to learn something.
async function learnForNextTime(e, words) {
  try {
    const kb = require('./kb');
    if (!kb.enabled()) return null;
    return await kb.learnFromHelper({
      question: e.item,
      answer: words,
      sourceMessageId: e.wamid || null,
      ctx: {
        localRef: String(e.id),
        chatId: e.chatId,
        // Who this was agreed WITH. It is what stops one dealer's terms being
        // read out to another (core/kb/learner.js, scopeFor).
        customerId: store.normPhone(e.customerPhone),
        answeredBy: config.escalationNumber,
      },
      // The person answering IS the approver: Prateek sir replying on his own
      // number is the approval. Anything the learner finds commercially
      // sensitive still goes to pending_review — see scopeFor().
      autoApprove: true,
    });
  } catch (err) {
    store.log('escalate', 'could not learn from that answer: ' + String((err && err.message) || err).slice(0, 80));
    return null;
  }
}

// What to tell the person who answered, so they can see it was kept.
function learnedLine(learned) {
  if (!learned || !learned.entry) return '';
  const e = learned.entry;
  if (learned.action === 'unchanged') return '\n_Already in the knowledge base._';
  if (learned.action === 'corrected') return `\n📚 _Updated the saved answer (#${e.id}); the old one is archived._`;
  if (e.status === 'pending_review') return `\n📚 _Saved as #${e.id} — needs approval before the bot uses it._`;
  return `\n📚 _Learned (#${e.id}, ${e.scope}). The next customer who asks gets this without anyone being asked._`;
}

// THE HELPER'S WORDS ARE AN INSTRUCTION TO THE BOT (founder, 22 Sep), never
// a message to forward. Read them for part numbers - one, or a whole range
// ("12 inch: CTWBSI26P-12INCH, 14 inch: ...") - learn them, find each on the
// portal, and answer the customer from the portal. Words with no part number
// in them become a short reply for the customer, never the instruction itself.
async function teachFromWords(e, id, words, { learn }) {
  const teachings = require('./teachings');
  const t = lang.for(e.chatId);
  const send = (text) => e.customerBot.transport.sendToChat(e.chatId, text);
  const r = await teachings.read(words, e.item);
  const onPortal = await teachings.onPortal(r.partNos || []);
  const spelled = (p) => (onPortal.get(teachings.normPn(p)) || {}).partNo || p;
  const missing = (r.partNos || []).filter((p) => !onPortal.has(teachings.normPn(p)));
  // A portal spelling with a space in it ("CTWBSI26P-16 Inch") is cut at the
  // space by the part-number reader and never found. Learned as itself - and
  // under the helper's spelling - it goes to the portal exactly as written.
  for (const p of r.partNos || []) {
    const exact = (onPortal.get(teachings.normPn(p)) || {}).partNo;
    if (exact && /\s/.test(exact)) {
      knowledge.learnAlias(exact, exact, 'portal');
      knowledge.learnAlias(p, exact, 'portal');
    }
  }

  // A RANGE: learned whole, in the portal's spelling.
  let family = null;
  if (learn && r.subject && r.variants.length >= 2) {
    family = knowledge.learnFamily(r.subject, r.variants.map((v) => ({ ...v, partNo: spelled(v.partNo) })), 'helper');
  }

  const alsoClosed = family ? await closeSiblings(family) : [];
  const alsoLine = alsoClosed.length ? '\n\n_Also answered from the same instruction:_\n' + alsoClosed.join('\n') : '';

  // Which one THIS customer asked for.
  let pick = null;
  if (r.variants.length >= 2) {
    const fam = learn ? knowledge.familyFor(e.item) : null;
    const nums = new Set((String(e.item).match(/\b\d{1,3}\b/g) || []).map((n) => String(Number(n))));
    const v = (fam && fam.variant) || r.variants.find((x) => nums.has(String(Number(x.key))));
    if (v) pick = spelled(v.partNo);
  } else if (r.partNo) {
    pick = spelled(r.partNo);
  }
  const taughtWhat = family
    ? `learned "${family.subject}" - ${family.variants.length} sizes`
    : pick ? `learned "${e.item}" = ${pick}` : '';
  const notOnPortal = missing.length ? `\n⚠️ Not found on the portal: ${missing.slice(0, 5).join(', ')}` : '';

  if (pick) {
    store.log('escalate', `#${id} helper's words read: "${e.item}" -> ${pick}${family ? ' (range of ' + family.variants.length + ')' : ''}`);
    await resolveWithAnswer(e, pick, learn ? 'helper' : 'memory');
    await ack(e, `✅ *#${id} done* — ${taughtWhat}. ${prettyPhone(e.customerPhone)} got the portal's answer for ${pick}.` + notOnPortal + alsoLine + waitingLine());
    return true;
  }

  // A range, but the customer named no size: show them the range, priced.
  if (r.variants.length >= 2 && typeof e.customerBot.offerPriced === 'function') {
    const rows = r.variants.map((v) => {
      const hit = onPortal.get(teachings.normPn(v.partNo));
      return { partNo: spelled(v.partNo), name: (hit && hit.name) || `${r.subject || e.item} ${v.label}`, available: hit ? hit.available : 0, key: String(Number(v.key)) };
    });
    const phone = e.customerPhone || String(e.chatId || '').replace(/@.*$/, '');
    await e.customerBot.offerPriced({ chatId: e.chatId, from: phone }, { base: e.item, qty: e.qty || 1, rate: true }, rows, rows.length, send, t, rows.length);
    await ack(e, `✅ *#${id} done* — ${taughtWhat}. ${prettyPhone(e.customerPhone)} was shown the sizes to pick from.` + notOnPortal + alsoLine + waitingLine());
    return true;
  }

  // No part number anywhere: something to TELL the customer, in our words -
  // written by the model from the instruction. With no model to write it,
  // a plain "not available" is said for them; anything else they wrote still
  // reaches the customer rather than nothing, which is the one thing worse.
  const partQuestion = ['NOT_IN_CATALOGUE', 'NO_PART_NUMBER'].includes(e.reason);
  const say = r.customerReply || (partQuestion && teachings.plainCustomerReply(words, e.item, e.chatId)) || words;
  if (say) {
    // THE AGENT ASKED THIS, and is still paused mid-conversation. His words
    // go back there rather than to the customer from here — the model puts
    // them in the customer's own language and, if they name a part, prices it
    // from the portal instead of repeating a figure he typed.
    //
    // `words` and not `say`: the original carries the conditions, and the
    // agent needs all of them. Everyone ELSE waiting on this question still
    // gets the short `say` directly below, because their conversations were
    // never paused.
    const agentTook = await handBackToAgent(e, words);
    if (!agentTook) await send(say);

    // ...and anyone else who asked the same thing while this was open.
    for (const w of e.waiters || []) {
      try {
        await e.customerBot.transport.sendToChat(w.chatId, say);
        store.log('escalate', `#${id} same answer also sent to ${prettyPhone(w.customerPhone)}`);
      } catch (err) {
        store.log('escalate', `#${id} could not answer a waiting customer: ` + String((err && err.message) || err).slice(0, 80));
      }
    }
    if (learn && partQuestion && e.item) knowledge.addNote(e.item, say, 'helper');

    // KEEP IT FOR THE NEXT CUSTOMER. Until now a question that was not about a
    // part — returns, warranty, GST, payment terms — was answered once and
    // forgotten, so the same question came back to a person every time it was
    // asked. The helper's ORIGINAL words are what gets learned, not the short
    // `say`: the full reply carries the conditions, and dropping a condition
    // is how a policy turns into a promise.
    const learned = await learnForNextTime(e, words);

    store.log('escalate', `#${id} helper's words turned into a reply for the customer`);
    await ack(
      e,
      `✅ *#${id} done* — sent to ${prettyPhone(e.customerPhone)}: "${say}"` + learnedLine(learned) + waitingLine(),
    );
    return true;
  }

  // Nothing the bot can act on. The question stays open, and the helper is
  // told what would work - rather than their note reaching the customer.
  pending.set(id, e);
  persist();
  store.log('escalate', `#${id} helper's words had no part number and no reply in them - kept open`);
  await ack(
    e,
    `⚠️ *#${id}* — I could not turn that into an answer for ${prettyPhone(e.customerPhone)}. Reply with the part number, or "no" if it is not available.` + waitingLine(),
  );
  return true;
}

// The helper's own words, to the customer, exactly as written.
async function relayWords(e, id, words) {
  await e.customerBot.transport.sendToChat(e.chatId, words);
  store.log('escalate', '#' + id + ' helper wrote back in words (' + e.reason + ') - relayed as written');
  // And KEPT, when it was about a part: the next customer asking the same
  // thing gets the same answer without anyone being asked (founder, 22 Sep:
  // "what prateek sir reply is learn by bot for future").
  if (['NOT_IN_CATALOGUE', 'NO_PART_NUMBER'].includes(e.reason) && e.item) {
    knowledge.addNote(e.item, words, 'helper');
  }
  await ack(e, '✅ *#' + id + ' sent* to ' + prettyPhone(e.customerPhone) + ' as written.' + waitingLine());
}

// Apply a resolved part number for an escalation and answer the customer.
// THE SPECIALIST HAS ANSWERED A QUESTION THE AGENT ASKED.
//
// The agent stopped mid-conversation waiting for this. His words go back to
// that paused thread, where the model reads them the way it reads any other
// tool result and writes the customer a proper reply — in their language,
// with the price fetched fresh from the portal rather than copied out of his
// message.
//
// -> true when the agent took it, false when it could not, in which case the
// caller answers the customer the old way. Never throws: a broken agent must
// not swallow an answer a person took the trouble to give.
async function handBackToAgent(e, specialistSaid) {
  if (!e || !e.agentThread) return false;
  let agent = null;
  try {
    agent = require('../agent');
  } catch (err) {
    return false;
  }
  if (!agent.enabled || !agent.enabled()) return false;

  try {
    const done = await agent.resume({
      bot: e.customerBot,
      chatId: e.agentThread,
      phone: e.customerPhone,
      answer: String(specialistSaid || '').trim(),
    });
    if (done) {
      store.log('escalate', `#${e.id} answer handed back to the agent for ${e.agentThread}`);
      return true;
    }
    // NOT WAITING ANY MORE — the wait ran out and the agent already told the
    // customer, or a restart lost the pause. His answer is still the agent's
    // to give, not a template's: it goes in as a fresh turn, and the agent
    // writes the reply from it.
    const followed = await agent.followUp({
      bot: e.customerBot,
      chatId: e.agentThread,
      phone: e.customerPhone,
      note:
        `[Note from the shop, not from the customer: our specialist has now answered the question you asked him about "${e.item}". ` +
        `He said: "${String(specialistSaid || '').trim().slice(0, 600)}". Tell the customer — in their language, and if he named a part number, check it with check_stock_and_price before quoting anything.]`,
    });
    if (followed) {
      store.log('escalate', `#${e.id} answer given to the agent as a follow-up for ${e.agentThread}`);
      return true;
    }
  } catch (err) {
    store.log('escalate', `#${e.id} agent could not take the answer: ` + String((err && err.message) || err).slice(0, 90));
  }
  return false;
}

// THE WAIT RAN OUT on a question the AGENT asked. The customer hears it from
// the agent — which knows what they asked and in what language — instead of
// the fixed "could not confirm, send the exact part number" line. The question
// stays open: when he does answer, handBackToAgent gives it to the agent as a
// follow-up.
async function timeoutToAgent(e) {
  if (!e || !e.agentThread) return false;
  try {
    const agent = require('../agent');
    if (!agent.enabled || !agent.enabled()) return false;
    return await agent.resume({ bot: e.customerBot, chatId: e.agentThread, phone: e.customerPhone, answer: '', timedOut: true });
  } catch (err) {
    store.log('escalate', `#${e.id} timeout could not be handed to the agent: ` + String((err && err.message) || err).slice(0, 90));
    return false;
  }
}

async function resolveWithAnswer(e, chosen, source) {
  const orders = require('./orders');
  const availability = require('./availability');
  const reply = (text) => e.customerBot.transport.sendToChat(e.chatId, text);
  const t = lang.for(e.chatId);

  // Everyone else who asked this same thing while it was open. Answered the
  // same way, in their own chat — the alternative is that suppressing a
  // duplicate ask silently strands them. Done first so one failure at the end
  // cannot skip them, and each is isolated so one bad chat id does not cost
  // the others their answer.
  const waiters = e.waiters || [];
  if (waiters.length) {
    e.waiters = []; // no re-entry: the clones below must not fan out again
    for (const w of waiters) {
      try {
        await resolveWithAnswer({ ...e, chatId: w.chatId, customerPhone: w.customerPhone, qty: w.qty, kind: w.kind, waiters: [], agentThread: null }, chosen, 'memory');
        store.log('escalate', `#${e.id} same answer also sent to ${prettyPhone(w.customerPhone)}`);
      } catch (err) {
        store.log('escalate', `#${e.id} could not answer a waiting customer: ` + String((err && err.message) || err).slice(0, 80));
      }
    }
  }

  // LEARN IT — the next customer asking this never reaches a human.
  // Same rule on the way out: only a question that was about a part teaches
  // the bot anything.
  const teachable = !['VOICE', 'DOCUMENT', 'NOT_A_PART', 'RATE'].includes(e.reason);
  if (source !== 'memory' && teachable) knowledge.learnAlias(e.item, chosen, source || 'helper');

  // The AGENT asked this one, and is still waiting mid-conversation. Its
  // thread gets the part number and writes the reply itself; answering from
  // here as well would be the second of two answers to the same person.
  //
  // The waiters above are deliberately handled first and never come through
  // here with an agentThread — they are different chats, and the clone that
  // serves them has it cleared.
  if (await handBackToAgent(e, chosen)) return true;

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
  // WHAT THE PORTAL CALLS IT, kept against both the part and the phrase. The
  // part number was worked out the expensive way — a person was asked — and the
  // catalogue index is how the NEXT customer finds it without a search, while
  // the name on the phrase row is what the brand check reads when it decides
  // whether a near-enough question may be answered from it.
  //
  // Price and stock are not stored. Only which part it is.
  if (teachable && line.partNo) {
    // The portal's own spelling when it gave one; never the customer's words,
    // which are already the phrase and would teach the brand check nothing.
    const portalName = line.name || line.partName || null;
    const parts = require('./parts');
    parts.remember({ partNo: line.partNo, name: portalName || line.partNo }).catch(() => {});
    parts
      .rememberPhrase({ phrase: e.item, partNo: line.partNo, partName: portalName, source: source || 'helper' })
      .catch(() => {});
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

// Talk, not an answer. The helper says "ok", "dekh lunga", "call me" — and
// none of that is meant for a customer. Whatever is caught here still reaches
// the customer if it is sent as a swipe-reply, which is the deliberate way to
// say "yes, send exactly this".
const CHATTER =
  /^(ok(ay)?|thik|theek|haan|han|ji|hmm+|kk|done|sure|yes sir|got it|noted|dekh(ta|ke)?\s*(hu|hoon|lunga)?|batata\s*hoon|baad\s*me(in)?|call\s*me|ring\s*me|busy|abhi\s*nahi|kal\s*batata)\b/i;
function chatter(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  // Short and conversational. A real answer to a business question is longer
  // than four words: "Yes, if unused and within 7 days" is seven.
  if (t.split(/\s+/).length <= 4 && CHATTER.test(t)) return true;
  return false;
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

// WHICH QUESTION IS THIS THE ANSWER TO, when nobody swiped and nobody typed
// a number? The helper names the part instead, as a heading: "Cartend wiper
// blade 18 number: Whenever any customer ask for Wiper Blade for Cartrends
// then it has sizes. 12 INCHES PART NUMBER: ...". That shape matched none of
// the ways a reply was recognised, so four wiper-blade questions sat open
// while the answer to all of them had already been sent.
//
// Only an instruction carrying a PART NUMBER may claim a question this way.
// A bare sentence still needs a swipe-reply - that is what keeps "isko bolo
// kal aayega" from being sent to a customer as if it were an answer.
function claimedByInstruction(text, mine) {
  const teachings = require('./teachings');
  const r = teachings.readPlain(text);
  if (!(r.partNos || []).length) return [];
  // What the instruction is about: the family it teaches, and the heading
  // written before the colon.
  const head = String(text).split(/[:\n]/)[0];
  const names = [r.subject, head && head.trim().split(/\s+/).length <= 8 ? head : null].filter(Boolean);
  const out = [];
  for (const [pid, pe] of mine) {
    if (RELAY_REASONS.includes(pe.reason)) continue; // not a question about a part
    const item = new Set(knowledge.familyWords(pe.item || ''));
    if (!item.size) continue;
    // Two naming words at least: "blade" alone would claim every question
    // that mentions one.
    const named = names.some((n) => {
      const w = knowledge.familyWords(n);
      return w.length >= 2 && knowledge.coversWords(w, item);
    });
    if (named) out.push(pid);
  }
  return out;
}

// ONE instruction, EVERY question it answers. "16 number" and "17 number"
// were each asked twice while this range went unanswered; closing only the
// question that was replied to leaves the rest open for a person who has
// already told us the answer.
async function closeSiblings(family) {
  const done = [];
  for (const [pid, pe] of [...pending]) {
    if (RELAY_REASONS.includes(pe.reason)) continue;
    let v = null;
    try {
      const f = knowledge.familyFor(pe.item || '');
      if (f && f.family && f.family.id === family.id) v = f.variant;
    } catch (_) {}
    if (!v) continue;
    clearTimeout(pe.timer);
    pending.delete(pid);
    try {
      await resolveWithAnswer(pe, v.partNo, 'helper');
      done.push('#' + pid + '  ' + (v.label || v.key) + ' -> ' + prettyPhone(pe.customerPhone));
      store.log('escalate', '#' + pid + ' answered by the same instruction -> ' + v.partNo);
    } catch (err) {
      // Put it back rather than lose it: unanswered is recoverable, silently
      // dropped is not.
      pending.set(pid, pe);
      store.log('escalate', '#' + pid + ' could not be answered from the range: ' + String((err && err.message) || err).slice(0, 80));
    }
  }
  persist();
  return done;
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
    // Stripped of WhatsApp markup first. The bot writes the question as
    // "*#12*", and a person answering by copying what they were shown sends
    // the asterisks back — see core/waText, and the nine minutes it cost on
    // 24 Sep when the same habit blocked a customer's approval.
    const mm = require('./waText').unformat(text).match(/^[#E]?(\d+)[\s.:)-]+([\s\S]+)$/i);
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
      // Named, not numbered: "Cartend wiper blade 18 number: ...".
      const claimed = claimedByInstruction(text, mine);
      if (claimed.length) {
        id = claimed[0];
        answer = text;
        explicit = true; // an instruction with a part number in it is for the bot
      } else {
        // A business answer — "Yes, if unused and within 7 days" — carries no
        // part number to recognise it by, and the only-one-open shortcut never
        // fires while dozens of PART questions are queued behind it. So the
        // part questions are set aside and the question is asked again of what
        // is left: exactly one business question open for this person means
        // this is the answer to it.
        //
        // Still only ONE. Two open and it is ambiguous, and a wrong guess here
        // sends one customer another customer's answer — so it goes back to
        // needing a swipe-reply.
        const theirs = mine.filter(([, pe]) => RELAY_REASONS.includes(pe.reason));
        if (theirs.length !== 1 || chatter(text)) return false;
        id = theirs[0][0];
        answer = text;
        explicit = true;
        store.log('escalate', `#${id} matched as the only open non-part question for this helper`);
      }
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
    return teachFromWords(e, id, answer, { learn: false });
  }

  if (/^(no|nahi|nhi|not available|na)\b/i.test(answer)) {
    await e.customerBot.transport.sendToChat(
      e.chatId,
      lang.for(e.chatId)(
        `"${e.item}" is not available. You can share an alternate part number if you have one.`,
        `"${e.item}" abhi available nahi hai. Aapke paas alternate part number ho to bhej dijiye.`,
      ),
    );
    // KEEP IT. Before this, "no" was the one answer that taught the bot
    // nothing: he said it, the customer was told, and the next person asking
    // the same thing sent him the identical question again. Remembered for a
    // window rather than forever — a catalogue changes.
    if (!RELAY_REASONS.includes(e.reason)) knowledge.markNotCarried(e.partNo || e.item, 'helper');
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
    return teachFromWords(e, id, answer, { learn: true });
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

// Anyone who writes to us opens their own 24h window — a Sales Head
// approving an account as much as the helper answering a question — so every
// inbound message is noted, and ensureWindow can be used for any staff number.
function noteInbound(phone) {
  const norm = store.normPhone(phone);
  if (norm) helperLastInbound.set(norm, Date.now());
}

module.exports = {
  helperFor,
  noteInbound,
  ensureWindow,
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
