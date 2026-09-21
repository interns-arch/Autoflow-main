'use strict';
// Customer Sales Bot — the replacement for the person currently answering
// customer WhatsApp groups by hand.
//
// listens in whitelisted groups + DMs
//   -> reads orders as text, photo or spreadsheet
//   -> asks the DEALER PORTAL what is available (no local stock at all)
//   -> holds a draft order, lets the customer modify it in chat
//   -> final YES punches the sales order into the Dealer Portal
//
// Anything it cannot resolve goes to a human once, and the answer is learned
// permanently (core/knowledge.js) so the same question is never asked twice.
// Every requested line is logged for sale-loss reporting (core/inquiries.js).
const config = require('../config');
const store = require('../store');
const ai = require('../core/ai');
const sheet = require('../core/sheet');
const availability = require('../core/availability');
const orders = require('../core/orders');
const knowledge = require('../core/knowledge');
const inquiries = require('../core/inquiries');
const customers = require('../core/customers');
const portal = require('../integrations/dealerPortal');
const escalation = require('../core/escalation');
const clarify = require('../core/clarify');
const lang = require('../core/lang');
const askQty = require('../core/askQty');
const conversation = require('../core/conversation');
const smallTalk = require('../core/smallTalk');
const documents = require('../core/documents');
const lists = require('../core/lists');
const speech = require('../integrations/speech');
const profiles = require('../core/profiles');
const voiceOrder = require('../core/voiceOrder');
const focus = require('../core/focus');
const vehicle = require('../core/vehicle');
const vahan = require('../integrations/vahan');
const salesOrder = require('../core/salesOrder');
const partApprovals = require('../core/partApprovals');
const soReview = require('../core/soReview');
const lookup = require('../core/customerLookup');
const rates = require('../core/rates');
const punchRefused = require('../core/punchRefused');
const partish = require('../core/partish');
const { createTransport } = require('../wa/transport');
const route = require('../pipeline/route');
const { handleMedia, NOT_MEDIA } = require('../pipeline/media');

// How this trade says hello. Kept here rather than in the chat layer because
// it is the single most common opening message and must never depend on a
// model call, a network hop, or an API key being present.
// Answer a greeting with the SAME greeting. "hi" gets "Hi", "jai shree ram"
// gets "Jai Shree Ram" — which is what a person does, and what the founder
// asked for. Their own spelling is kept; only the capitals are tidied, and
// "ji" stays lowercase because nobody writes "Hello Ji".
function mirrorGreeting(text) {
  return String(text)
    .trim()
    .replace(/[!.?]+$/, '')
    .replace(/\s+/g, ' ')
    .split(' ')
    // "Jai Shree Ram" and "Radhe Radhe" take capitals; "Good morning" does not,
    // and nobody writes "Hello Ji".
    .map((w, i) =>
      /^(ji|morning|afternoon|evening|mrng)$/i.test(w) && i > 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(' ');
}

// After a greeting, wait. If the customer says nothing more, THEN offer to
// help — a person would not follow "hi" straight into "send me part numbers".
// Any message from them cancels it.
const NUDGE_MS = Math.max(3, parseInt(process.env.GREETING_NUDGE_SEC || '75', 10)) * 1000;
const nudges = new Map();

// Chats where we have asked "cancel the whole order?" and are waiting for the
// answer. Short-lived on purpose: a yes ten minutes later is about something
// else entirely.
// On disk (core/chatState): a restart between the question and the yes must
// not turn that yes into an order.
const pendingCancel = require('../core/chatState').slot('cancelAsk');

// Every message of a chat by its WhatsApp id, for a while - the last 40 each
// way. WhatsApp tells us WHICH message a swipe-reply quotes, never what it
// said. 13 Sep, live: "Hai kya?" swiped onto the customer's own list of parts
// got "Samajh nahi paya", and a "3." swiped onto an old list became a
// quantity of the part discussed since.
const quotable = require('../core/chatState').slot('quotable'); // chatId -> { at, items: [{ id, dir, text }] }
function rememberMsg(chatId, id, dir, text) {
  if (!chatId || !id || typeof id !== 'string') return;
  const row = quotable.get(chatId) || { at: 0, items: [] };
  row.items.push({ id, dir, text: String(text || '').slice(0, 1500), at: Date.now() });
  if (row.items.length > 40) row.items.splice(0, row.items.length - 40);
  row.at = Date.now();
  quotable.set(chatId, row);
}
function quotedMsg(chatId, id) {
  const row = quotable.get(chatId);
  return row && id ? row.items.find((x) => x.id === id) || null : null;
}
// The part numbers in a message, one per line where a line starts with one -
// the hyphenated kind too ("26300-02752 40 pcs"), which has no letter in it
// and was left out of the answer to a swiped "Hai kya?" (13 Sep, live).
function partsIn(text) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    const k = String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k.length >= 5 && !seen.has(k)) {
      seen.add(k);
      out.push(String(p).trim());
    }
  };
  for (const raw of String(text || '').split('\n')) {
    const head = raw.trim().split(/\s+/)[0] || '';
    // Digits only (2630002752) when a quantity follows it on the line.
    const digitsWithQty = /^\d{7,13}\s+(?:[-x×*:=]\s*)?\d{1,4}\s*(?:pcs?|pieces?|nos?|pise|p|qty)?\b/i.test(raw.trim());
    if (partish.isPartNumber(head) || availability.groupedPart(head) || digitsWithQty) add(head);
    else add(ai.partNumberIn(raw));
  }
  return out;
}

function lastBotMsgId(chatId) {
  const row = quotable.get(chatId);
  const ours = row ? row.items.filter((x) => x.dir === 'us') : [];
  return ours.length ? ours[ours.length - 1].id : null;
}

// "Send draft so", "draft dikhao", "draft bhejo".
const DRAFT_ASK =
  /\b(?:send|bhej\w*|dikha\w*|show|give|share)\b[^\n]{0,20}\bdraft\b|\bdraft\b[^\n]{0,20}\b(?:send|bhej\w*|dikha\w*|show|give|share|de\s*do|do)\b/i;

// "Kya hua", "koi update", "reply karo" - the customer is waiting on us.
const WHAT_HAPPENED =
  /^(?:(?:kya|kia|kyaa)\s*(?:hua|huwa|hoa|howa)|kuch\s*(?:hua|huwa|update)|koi\s*update|any\s*updates?|updates?|wh?at\s*happen(?:ed|d)?|reply\s*(?:karo|kro|do|dijiye)?|jawab\s*(?:do|dijiye)?)(?:\s*(?:ji|sir|bhai|bhaiya))?[\s?.!]*$/i;

// A bare acknowledgement: the only kind of message the bot may leave
// unanswered ("aur silent kbhi na ho bot" - founder, 13 Sep).
const JUST_ACK =
  /^\s*(?:ok+|okay|k+|achh?a+|accha+|thi?e?k(?:\s*hai)?|ji|haan\s*ji|hm+|done|noted|thanks?|thank\s*you|thanku|ty|welcome|\u{1F44D}|\u{1F64F}|\u{1F44C})(?:\s*(?:ji|sir|bhai|bhaiya))?[\s.!\u{1F44D}\u{1F64F}\u{1F44C}]*$/iu;

// "only", "sirf", "bas": a yes to part of the list.
const ONLY_WORD = /\b(only|sirf|srf|bas|just|keval|kewal)\b/i;

// A real part number somewhere in it - letters and digits, or a digits-only
// Hyundai/Toyota number.
const hasPartNumber = (s) => Boolean(ai.partNumberIn(String(s || ''))) || /\b\d{7,13}\b/.test(String(s || ''));

// "Confirm sir?" after EVERY part is not how anyone talks — a customer
// sending eight part numbers was asked eight times. The counter man answers
// each part as it comes and asks once, when you stop. So the ask waits for a
// pause, and any further message cancels it.
const CONFIRM_NUDGE_MS = Math.max(5, parseInt(process.env.CONFIRM_NUDGE_SEC || '40', 10)) * 1000;
const confirmNudges = new Map();

function cancelConfirmNudge(chatId) {
  const timer = confirmNudges.get(chatId);
  if (timer) {
    clearTimeout(timer);
    confirmNudges.delete(chatId);
  }
}
const CANCEL_ASK_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [chatId, at] of pendingCancel) if (now - at > CANCEL_ASK_MS) pendingCancel.delete(chatId);
}, 60 * 1000).unref();

function cancelNudge(chatId) {
  const t = nudges.get(chatId);
  if (t) {
    clearTimeout(t);
    nudges.delete(chatId);
  }
}

// Strip the question itself, so what is left is the part they asked about:
// "16510M65L10 ka rate kya hai" -> "16510M65L10".
const RATE_STRIP =
  /\b(rate|rates|price|prices|cost|mrp|kimat|keemat|daam|kya|kitna|kitni|hai|ka|ki|ke|batao|bataiye|bhejo|bhej do|send|share|do|what|is|the|of|for)\b/gi;

const GREETING =
  /^\s*(hi+|hey+|hello+|helo|hlo|namaste|namaskar|namashkar|ram ram|jai shree ?ram|jai sree ?ram|jai shri ?ram|radhe radhe|salaam|salam|assalam[ou] ?alaikum|gd (mrng|morning|evening)|good (morning|afternoon|evening)|shubh prabhat|sir ?ji|bhai ?ji|hello ?ji|hi ?ji)\s*[!.?]*\s*$/i;

class CustomerBot {
  constructor() {
    this.key = 'customer';
    this.transport = createTransport(this.key);
  }

  async start() {
    // pipeline/shadow watches beside the handler when AI_SHADOW=true, and
    // otherwise just calls it. It never changes what the handler returns.
    this.transport.onMessage((m) => require('../pipeline/shadow').around(this, m, () => this.handleMessage(m)));
    await this.transport.start();
  }

  // Who the sender is lives in pipeline/route. These stay on the bot because
  // escalation (inquiryOnly) and the tests (isStaff) ask the bot directly.
  listensTo(m) {
    return route.listensTo(m);
  }

  inquiryOnly(phone, chatId) {
    return route.inquiryOnly(phone, chatId);
  }

  isStaff(phone) {
    return route.isStaff(phone);
  }

  async handleMessage(m) {
    // For the bot at all? A chat it listens to, not one of our own numbers,
    // not a Cartrends person talking in a group (pipeline/route).
    if (!route.forBot(m)) return false;

    // Blue-tick their message and show "typing..." straight away, before the
    // portal call, the vision read or anything else that takes a second. The
    // customer sees the same thing they would from a person at the counter:
    // read, and someone is writing. Never awaited — a failed indicator must
    // not delay the actual reply.
    if (this.transport.sendTyping && m.id) {
      Promise.resolve(this.transport.sendTyping(m.id)).catch(() => {});
    }

    // Which language does THIS customer write in? Read from the message they
    // just sent (a caption counts), remembered per chat, and used by every
    // reply below. A bare "16510M65L10 10" says nothing either way, so the
    // language they last showed us stands.
    lang.note(m.chatId, m.body || '');
    const t = lang.for(m.chatId);

    // Both sides of the thread are remembered, so "pakka?" and "This also"
    // mean something on the next message instead of arriving out of nowhere.
    conversation.record(m.chatId, 'customer', m.body || `(${m.mediaType || 'media'})`);
    rememberMsg(m.chatId, m.id, 'customer', m.body || '');

    // They carried on talking, so the "send me a part number" nudge is no
    // longer wanted — whatever they said next IS the conversation.
    cancelNudge(m.chatId);
    cancelConfirmNudge(m.chatId);

    // Style for THIS customer — length, honorifics, emoji, their word for
    // "pcs". Never the facts: polish() throws its own work away if a digit or
    // a part number moved. See core/profiles.js.
    const say = (text) => profiles.polish(m.from, text);

    const reply = async (text) => {
      const out = say(text);
      const sentId = await this.transport.sendToChat(m.chatId, out);
      conversation.record(m.chatId, 'us', out);
      rememberMsg(m.chatId, sentId, 'us', out);
      return true;
    };

    // Voice, PDF, spreadsheet, photo (pipeline/media). A message that is none
    // of those comes back as NOT_MEDIA and carries on below as text.
    const media = await handleMedia(this, m, reply, t);
    if (media !== NOT_MEDIA) return media;

    // "26300_02752 40 pcs", "16510m68k10.48 pcs" - straightened out once, here,
    // so every reader below (DM, group, sales desk) sees the same order line.
    if (m.body) m.body = ai.normalizeOrderText(m.body);
    const text = (m.body || '').trim();
    if (!text) return false;

    // A NUMBER PLATE. "DL7CW1692" is a car, not a part — and before this it
    // satisfied every test for a part number, went to the portal, found
    // nothing and reached a person as an unknown part. Looked up once, the
    // car is remembered for the day, and "is gaadi ka bumper" after it
    // searches the catalogue for THAT car instead of every bumper we sell.
    if (vahan.isOnlyPlate(text)) {
      const car = await vahan.lookup(text);
      if (car) {
        vehicle.remember(m.chatId, car);
        store.log(this.key, `plate ${car.plate} -> ${vahan.describe(car)}`);
        return reply(
          t(
            `${vahan.describe(car)}. Which part do you need?`,
            `${vahan.describe(car)}. Kaunsa part chahiye?`,
          ),
        );
      }
      // The registry did not answer — a wrong plate, or the lookup is down.
      // Neither is the customer's problem, and neither is worth a person:
      // ask for the car the way the desk always has.
      store.log(this.key, `plate "${text}" not resolved`);
      return reply(
        t(
          "I could not pull that number up. Which car is it - make and model?",
          'Wo number nahi mila. Gaadi kaunsi hai - company aur model bata dijiye?',
        ),
      );
    }

    // A greeting is answered, always. Left to the chat layer, a model reads
    // "hi" as the same kind of nothing as "ok" and stays quiet — which is how a
    // customer said hello twice on the live line and got silence both times.
    // A supplier answers the door.
    if (GREETING.test(text)) {
      store.log(this.key, `greeting: "${text}"`);
      // Kalra wrote "sir" zero times in eighteen days. Mirroring a greeting at
      // someone whose median message is ten characters is friction, so for a
      // profile that does not greet we skip straight to the useful line.
      if (profiles.forPhone(m.from).greet === false) {
        return reply(
          t(
            "Send me the part number and quantity - I'll check right away.",
            'Part number aur quantity bhej dijiye, main abhi check karta hoon.',
          ),
        );
      }
      let greetingReply = mirrorGreeting(text);
      const cHit = store.customers().find((c) => store.normPhone(c.phone) === store.normPhone(m.from));
      if (cHit && cHit.name) {
        greetingReply += ' ' + cHit.name;
      }
      await reply(greetingReply);
      // In a group the Cartrends people carry it on from here: no nudge.
      if (m.isGroup) return true;
      // ...and only if they leave it there, offer to help.
      const chatId = m.chatId;
      const nudge = setTimeout(() => {
        nudges.delete(chatId);
        const open = orders.findDraft(chatId);
        this.transport
          .sendToChat(
            chatId,
            open && open.lines.length
              ? t(
                  'Anything else to add to the order?',
                  'Order mein aur kuch add karna hai?',
                )
              : t(
                  "Send me the part number and quantity - I'll check right away.",
                  'Part number aur quantity bhej dijiye, main abhi check karta hoon.',
                ),
          )
          .catch((e) => store.log(this.key, 'nudge failed: ' + String((e && e.message) || e).slice(0, 90)));
      }, NUDGE_MS);
      // Never let a stray timer hold the process open.
      if (nudge.unref) nudge.unref();
      nudges.set(chatId, nudge);
      return true;
    }

    // Since a normal reply only acknowledges the items just sent, the customer
    // needs a way to see the whole cart. Checked before parsing, because "list"
    // on its own carries no part number and would otherwise read as chit-chat.
    // The answer to "Poora order cancel kar dun? Ya bas koi ek part hatana
    // hai?". Checked before the cart request below, which also listens for
    // "poora": 13 Sep, live, "Poora" showed the cart, and "Poora kr do
    // cancel" got "Thoda aur detail bata dijiye?".
    if (pendingCancel.has(m.chatId) && Date.now() - pendingCancel.get(m.chatId) <= CANCEL_ASK_MS) {
      const said = voiceOrder.readAnswer(text);
      const onePart = /\b(ek|one|sirf|bas|only|koi)\b[^\n]*\b(part|item|line|cheez|saman|samaan)\b/i.test(text);
      const namesPart = Boolean(partish.partNumber(text));
      const whole = !onePart && !namesPart && (said === 'yes' || /\b(poora|pura|puraa|poura|sab|saara|sara|whole|all|full|entire|cancel)\b/i.test(text));
      if (whole) {
        pendingCancel.delete(m.chatId);
        const doomed = orders.findDraft(m.chatId);
        if (doomed) {
          orders.cancel(doomed);
          store.log(this.key, `"${text}" to the cancel question - ${doomed.id} cancelled`);
          return reply(
            t(
              `Order ${doomed.id} cancelled.`,
              `Order ${doomed.id} cancel kar diya.`,
            ),
          );
        }
      } else if (onePart && !namesPart) {
        pendingCancel.delete(m.chatId);
        return reply(t('Which part should come out? Send its number or name.', 'Kaunsa part hatana hai? Uska number ya naam bata dijiye.'));
      } else if (said === 'no') {
        pendingCancel.delete(m.chatId);
        return reply(t('OK, the order stays as it is.', 'Theek hai, order waisa hi rahega.'));
      }
    }

    if (/^(list|order|cart|poora|full)$/i.test(text)) {
      const d = orders.findDraft(m.chatId);
      if (!d || !d.lines.length)
        return reply(t('You have no open order right now.', 'Abhi koi order draft nahi hai.'));
      const listId = await this.transport.sendToChat(
        m.chatId,
        say(`Order ${d.id}:\n${orders.summary(d)}\n\n${t('Confirm sir?', 'Confirm karun sir?')}`),
      );
      lists.remember(m.chatId, listId, d.lines);
      return true;
    }

    // The sales desk and the data-entry approvers first (pipeline/route): "1"
    // and "haan" mean something exact while a customer is being picked or a
    // part name approved.
    if (await route.handleRoles(this, m, text, reply, t)) return true;

    // "only 10" / "sirf 2 aur 5" on its own, about the list we asked to confirm
    // (14 Sep, live: it was looked up as a part called "only").
    {
      const open = orders.findDraft(m.chatId);
      if (open && open.lines.length && open.confirmAskedAt && text.length <= 60 && /^\s*(only|sirf|srf|bas|just|keval|kewal)\b/i.test(text) && /\d/.test(text)) {
        return this.keepOnly(m, text, reply, t, open);
      }
    }

    // Orders named by their number: "ORD-1036 aur ORD-1037 bhi cancel kar do"
    // (founder, 13 Sep, live - it was answered "koi open order nahi hai",
    // because those carts sit on other chats). An admin may cancel any open
    // cart; anyone else only the ones on their own chat. These are the bot's
    // own carts - nothing here touches an order already punched on the portal.
    {
      const ids = [...new Set((text.match(/\bORD-?\s?\d{3,6}\b/gi) || []).map((x) => 'ORD-' + x.replace(/\D/g, '')))];
      if (ids.length && /\b(cancel+(ed)?|hata\w*|band|delete|nikal\w*)\b/i.test(text)) {
        const admin = config.adminNumbers.includes(store.normPhone(m.from));
        const said = [];
        for (const id of ids) {
          const o = store.orders().find((x) => x.id === id);
          if (!o) said.push(t(`${id} - not found`, `${id} - nahi mila`));
          else if (o.status !== 'draft') said.push(t(`${id} - already ${o.status}`, `${id} - pehle se ${o.status} hai`));
          else if (!admin && o.chatId !== m.chatId) said.push(t(`${id} - not an order on this chat`, `${id} - is chat ka order nahi hai`));
          else {
            orders.cancel(o);
            said.push(t(`${id} - cancelled`, `${id} - cancel kar diya`));
          }
        }
        store.log(this.key, `cancel by order number from ${m.from}: ${ids.join(', ')}`);
        return reply(said.join('\n'));
      }
      // "ORD-1043", "details of ORD-1043": that cart, as it stands. 14 Sep,
      // live: both were answered with the SO waiting for review on the chat.
      if (ids.length && text.replace(/\bORD-?\s?\d{3,6}\b/gi, '').replace(/\b(details?|of|status|show|kya|hai|ka|ki|batao|order|the|for|and|aur)\b/gi, '').replace(/[\s,.?!-]/g, '').length === 0) {
        const admin = config.adminNumbers.includes(store.normPhone(m.from)) || salesOrder.isSalesPerson(m.from);
        const said = [];
        for (const id of ids) {
          const o = store.orders().find((x) => x.id === id);
          if (!o || (!admin && o.chatId !== m.chatId)) {
            said.push(t(`${id} - not found`, `${id} - nahi mila`));
            continue;
          }
          const state =
            o.status === 'draft'
              ? t('open, not placed yet', 'khula hai, abhi lagaya nahi')
              : o.status === 'confirmed'
                ? t(`placed - SO ${o.soNumber}`, `lag gaya - SO ${o.soNumber}`)
                : o.status;
          const who = o.portalCustomer && o.portalCustomer.name ? ' · ' + o.portalCustomer.name : '';
          said.push(`${id}${who} - ${state}\n${orders.summary(o)}`);
        }
        store.log(this.key, `order details by number for ${m.from}: ${ids.join(', ')}`);
        return reply(said.join('\n\n'));
      }
    }

    // A customer asking about their OWN account - balance, ledger, credit
    // notes, "Billed or not?". Founder, 12 Sep: "SBKE LIYE KRO..BOT AUR
    // SALESMAN, ADMIN". On the Kalra replay every one of these went to a
    // person while the desk answered with a ledger PDF and a figure.
    // Answered only for the account the NUMBER belongs to - never anyone
    // else's - and it falls through to a person when the number is not on the
    // portal.
    {
      const own = lookup.parseOwn(text);
      if (own) {
        let said = null;
        try {
          said = await lookup.answerOwn(m.from, own.intent, t);
        } catch (e) {
          store.log(this.key, 'own-account answer failed: ' + String((e && e.message) || e).slice(0, 120));
        }
        if (said) {
          store.log(this.key, m.from + ' asked about their own account (' + own.intent + ')');
          return reply(said);
        }
      }
    }

    // A draft SO is waiting to be checked: "haan" confirms it, "2 hata do"
    // corrects it, "cancel" takes it back (core/soReview). Before the
    // normal parsing, because those words mean something exact here.
    if (await soReview.handle(this, m, text, reply, t)) return true;

    // "Send draft so" with no draft SO under review yet (soReview owns that
    // one, above). 13 Sep, live: this reached the chat model, which made an
    // answer up. The cart is the truth: show it with the question, or say
    // there is nothing yet.
    if (DRAFT_ASK.test(text)) {
      const open = orders.findDraft(m.chatId);
      const forCustomer = salesOrder.activeCustomer(m.chatId);
      if (open && open.lines.length) {
        if (forCustomer) {
          open.confirmAskedAt = new Date().toISOString();
          store.save();
          return reply(salesOrder.precheck(open, forCustomer, t));
        }
        if (await this.askToConfirmNow(m, t)) return true;
      }
      return reply(
        t(
          'No draft yet - once the order is made I will show it to you before punching.',
          'Abhi koi draft nahi hai - order banne par punch se pehle poora dikha dunga.',
        ),
      );
    }

    // Answering "is that right?" about something we heard in a voice note.
    // Checked before everything else: a bare "haan" is meaningless to the
    // order parser, and by this point it has a precise meaning.
    if (voiceOrder.get(m.chatId)) {
      const said = voiceOrder.readAnswer(text);
      if (said === 'yes') {
        const held = voiceOrder.take(m.chatId);
        store.log(this.key, `voice order confirmed: ${held.lines.map((l) => l.item).join(', ')}`);
        return this.processOrderLines(
          m,
          held.lines.map((l) => ({ item: l.item, qty: l.qty })),
          reply,
        );
      }
      if (said === 'no') {
        const held = voiceOrder.take(m.chatId);
        // A typed message we read back: there is no recording for a person to
        // hear. Nothing was added, so say exactly that.
        if (held && held.kind === 'text') {
          store.log(this.key, 'read-back of a typed message rejected - nothing added');
          return reply(
            t(
              'Okay, not added. Send the part number and quantity the way you want it.',
              'Theek hai, nahi joda. Jaisa chahiye waise part number aur quantity bhej dijiye.',
            ),
          );
        }
        store.log(this.key, 'voice order rejected by the customer — sending it to a person');
        // We heard it wrong and they said so. That is exactly the case a
        // person should see, with what we thought we heard.
        await escalation.create(this, {
          chatId: m.chatId,
          customerPhone: m.from,
          item: 'voice note',
          qty: 1,
          kind: 'order',
          reason: 'VOICE',
          transcript: held.transcript,
        });
        return reply(
          t(
            'Sorry — I heard that wrong. Someone will check the recording and reply.',
            'Maaf kijiye, main galat samjha. Koi abhi recording sun kar jawab dega.',
          ),
        );
      }
      // Anything else is a new message. Drop the held lines rather than let
      // them sit and get confirmed by an unrelated "ok" ten minutes later.
      voiceOrder.clear(m.chatId);
    }

    // "Leave 9no. Item", "4th. No. Item 3pc", "2-9-14-16 ye no saman hata do".
    // Kalra Motor did this seven times in eighteen days and the bot could not
    // read a word of it. Checked before anything else, because a line number is
    // not a part and must never reach the order parser.
    if (lists.looksLikeListEdit(text)) {
      const handled = await this.editListByNumber(m, text, reply, t);
      if (handled) return true;
    }

    // We asked how many, and this is the answer. Checked before parsing, since
    // a bare "2" or "1 each" is not an order line and would otherwise be read
    // as chit-chat and answered with silence.
    const waitingQty = askQty.get(m.chatId);
    if (waitingQty) {
      const qs = askQty.readAnswer(text, waitingQty.items.length);
      if (qs) {
        askQty.clear(m.chatId);
        store.log(this.key, `qty answer "${text}" -> ${qs.join('/')} for ${waitingQty.items.length} item(s)`);
        return this.processOrderLines(
          m,
          waitingQty.items.map((it, i) => ({ ...it, qty: qs[i] })),
          reply,
        );
      }
    }

    // Nobody asked, but the customer is still giving a quantity: they sent a
    // photo, we answered it, and now they say "Add 2pc". That is the quantity
    // for the part we just answered about — the single commonest thing this
    // bot used to ignore. Only counts when the message is NOTHING BUT a
    // quantity, so a fresh part number is never swallowed by it.
    // A swipe-reply onto one of OUR older messages is about that message, not
    // about what we just said - so a bare number in it is not a quantity for
    // the latest part.
    const oldSwipe = Boolean(m.contextId) && m.contextId !== lastBotMsgId(m.chatId);
    const justAnswered = askQty.lastAnswered(m.chatId);
    if (justAnswered && !oldSwipe) {
      const qs = askQty.readAnswer(text, justAnswered.items.length);
      if (qs) {
        askQty.forget(m.chatId);
        store.log(
          this.key,
          `late qty "${text}" -> ${qs.join('/')} on the last ${justAnswered.items.length} item(s)`,
        );
        return this.processOrderLines(
          m,
          justAnswered.items.map((it, i) => ({ ...it, qty: qs[i] })),
          reply,
          null,
          { fromPhoto: true }, // set the quantity, never add to it
        );
      }
    }

    // "alto" on its own means nothing — unless we just asked "kaunsi gaadi?".
    // Then it is the answer, and it belongs onto the question we already have
    // rather than being parsed as a fresh order.
    // Swiped onto an older message: about that message, not an answer to the
    // question we asked last.
    if (!oldSwipe && clarify.isAnswerTo(m.chatId, text)) {
      const p = clarify.refine(m.chatId, text);
      const hits = await availability.byName(p.base);
      if (hits.top.length === 1) {
        clarify.clear(m.chatId);
        store.log(this.key, `"${p.base}" -> ${hits.top[0].partNo} after clarifying`);
        return this.processOrderLines(
          m,
          [{ item: hits.top[0].partNo, qty: p.qty, ref: p.ref, key: p.key }],
          reply,
        );
      }
      if (hits.top.length > 1) {
        const q = clarify.nextQuestion(hits.top, p.asked, m.chatId);
        if (q) {
          clarify.ask(m.chatId, p, q);
          return reply(q.text);
        }
        clarify.clear(m.chatId);
        return reply(clarify.options(hits.top, m.chatId));
      }
      // narrowed to nothing — the extra word was wrong, back to the last list
      clarify.clear(m.chatId);
      return reply(
        t(
          `Couldn't find "${p.base}" - can you describe it another way, or share the part number?`,
          `"${p.base}" nahi mila - thoda alag tarike se bataiye, ya part number ho to bhej dijiye?`,
        ),
      );
    }

    // "5 p", "4", "2pc" with nothing asked - but a part was just discussed.
    // 13 Sep, live: "16510m65l10 -5" was answered with stock, then "5 p" got
    // silence. The counter reads that as five of the part just talked about.
    // Only when that is certain - one part in the discussion, and it is a real
    // part number. Two parts, or only a name, and the customer is asked.
    // A question swiped onto a message that carries part numbers - usually
    // the customer's own list ("26300-02752 40 pcs / 16510m65L10 100 pcs" ->
    // "Hai kya?"). The parts are in the quoted message; the question is about
    // them. A price question falls through with those parts in focus.
    const quoted = m.contextId ? quotedMsg(m.chatId, m.contextId) : null;
    if (quoted && text.length <= 60 && !partish.partNumber(text)) {
      const parts = partsIn(quoted.text);
      if (parts.length) {
        const aboutMoney = /\b(rate|price|mrp|kitne ka|kitne ki|discount|gst)\b/i.test(text);
        const aboutStock = /\b(hai kya|h kya|avl|available|availability|stock|milega|mil jayega|hai ki nahi|hai ki nhi|ye part)\b|\?\s*$/i.test(text);
        if (aboutStock && !aboutMoney) {
          store.log(this.key, `"${text}" swiped onto a message with ${parts.length} part(s) - answering for those`);
          return reply(await this.answerInquiry(parts, m));
        }
        focus.remember(m.chatId, parts.map((p) => ({ item: p, partNo: ai.partNumberIn(p) || null })));
      }
    }

    // A bare number swiped onto an older message: not a quantity for the part
    // in front of us, and not something to stay silent about either.
    if (oldSwipe && ai.bareQty(text)) {
      const n = ai.bareQty(text);
      store.log(this.key, `"${text}" swiped onto an older message - asking what it is for`);
      return reply(
        t(
          `${n} for which one? That was an older message - send it again with the part number or the customer's name.`,
          `${n} kiske liye? Wo purana message tha - part number ya customer ke naam ke saath dobara bhej dijiye.`,
        ),
      );
    }

    {
      const qty = ai.bareQty(text);
      const discussed = qty && !oldSwipe ? focus.get(m.chatId) : null;
      if (qty && discussed) {
        const numbered = discussed.filter((x) => x.partNo && (partish.isPartNumber(x.partNo) || /^\d{7,13}$/.test(x.partNo)));
        if (discussed.length === 1 && numbered.length === 1) {
          // Already in the order: the number is its new quantity, not more of
          // it ("1 kr do" after x2 means 1, not 3).
          const open = orders.findDraft(m.chatId);
          if (open && (await orders.setQty(open, numbered[0].partNo, qty))) {
            store.log(this.key, `bare qty "${text}" -> ${numbered[0].partNo} set to ${qty} (already in the order)`);
            this.askToConfirmLater(m, t);
            const changed = open.lines.filter((l) => availability.sameItem(l.partNo || l.item, numbered[0].partNo));
            return reply(orders.ack(changed, open));
          }
          store.log(this.key, `bare qty "${text}" -> ${numbered[0].partNo} x${qty} (the part just discussed)`);
          return this.processOrderLines(m, [{ item: numbered[0].partNo, qty }], reply);
        }
        store.log(this.key, `bare qty "${text}" with ${discussed.length} part(s) discussed - asking which`);
        if (discussed.length > 1) {
          const names = discussed.map((x) => x.partNo || x.item);
          return reply(
            t(
              `${qty} of which one - ${names.join(' or ')}? Send it with the part number, like ${names[0]} ${qty}.`,
              `${qty} piece kiske - ${names.join(' ya ')}? Part number ke saath bhej dijiye, jaise ${names[0]} ${qty}.`,
            ),
          );
        }
        return reply(
          t(
            `${qty} of ${discussed[0].item} - which exact part? Send its part number with the quantity, like 16510M65L10 ${qty}.`,
            `${discussed[0].item} ke ${qty} piece - exact part number bhej dijiye, jaise 16510M65L10 ${qty}.`,
          ),
        );
      }
    }

    // "Kya hua", "koi update", "reply karo" - the customer is waiting on us.
    // Silence here is the worst answer there is, and a chat model guessing
    // ("order note ho gaya") is the second worst. Say where things really
    // stand: the open order, the part we were discussing, or nothing.
    if (WHAT_HAPPENED.test(text)) {
      store.log(this.key, `"${text}" - telling them where things stand`);
      const draft = orders.findDraft(m.chatId);
      if (draft && draft.lines.length && !this.inquiryOnly(m.from, m.chatId) && (await this.askToConfirmNow(m, t))) {
        return true;
      }
      return reply(this.whereWeAre(m, t));
    }

    const parsed = await ai.parseCustomerMessage(text, availability.catalogNames());

    switch (parsed.intent) {
      // Rates are not quoted over WhatsApp — the founder's rule, and the
      // reason the bot never prints a price. Answering "which part do you
      // need?" to "rate kya hai" pretends we might.
      case 'rate': {
        // WHICH part are they asking about? The one in this message, or
        // failing that whatever is in their cart. Asking "send the part
        // number" to someone who just sent one is the thing that makes a
        // bot feel like a bot.
        const cart = orders.findDraft(m.chatId);
        const inMsg = (await ai.parseCustomerMessage(text.replace(RATE_STRIP, " "), availability.catalogNames()));
        // "Es ki MRP kya h" names nothing - it points at the part we were just
        // discussing. M/S Maan Motors asked exactly that about a coolant on
        // 11 Sep and was asked "Kis part ka?" back. So: what they named; else,
        // if the message points back ("es ki", "iska", "ye"), what we were just
        // discussing; else their cart, as it always was; else what we discussed.
        // A bare "rate kya hai" points nowhere, and after "OF-2002 hata do" the
        // cart is the right guess, not the part they just took out of it. A
        // "part" that is only a pointer ("iska", "Eski saleing") is not a part.
        const named = (inMsg.lines || []).map((l) => l.item).filter((x) => x && !focus.isOnlyPointer(x));
        const discussed = focus.names(m.chatId);
        const inCart = cart && cart.lines.length ? cart.lines.map((l) => l.requested || l.item) : [];
        // "oil filter ka rate kya hai" names the part by what it IS, not its
        // number, so the parser finds nothing to price and the customer got
        // "Kis part ka?". Ask the catalogue first: one match is that part;
        // several means the name is real and the person answering can say
        // which. No match falls through to the usual order below.
        let byName = [];
        const phrase = named.length ? '' : focus.stripPointers(text.replace(RATE_STRIP, ' '));
        if (phrase.length >= 3) {
          try {
            const hits = await availability.byName(phrase);
            const top = (hits && hits.top) || [];
            if (top.length === 1) byName = [top[0].partNo];
            else if (top.length > 1) byName = [phrase];
          } catch (e) {
            store.log(this.key, 'rate: catalogue lookup failed for "' + phrase + '": ' + String((e && e.message) || e).slice(0, 80));
          }
        }
        const known = named.length
          ? named
          : byName.length
            ? byName
            : focus.pointsBack(text) && discussed.length
              ? discussed
              : inCart.length
                ? inCart
                : discussed;

        if (!known.length) {
          return reply(
            t(
              "Which part? Share the number and I'll get you the rate.",
              'Kis part ka? Number bata dijiye, rate bhej deta hoon.',
            ),
          );
        }

        // The rate. Looked for in this order: the list already on screen (the
        // portal priced it when the order was quoted), then the portal itself
        // for a customer it knows, then Odoo's MRP. Our purchase cost is never
        // one of the answers.
        // A salesman asking on a customer's behalf gets THAT customer's rate:
        // on 13 Sep "Mrp of this?" after an analysis for Kalra Motors priced the
        // founder's own account instead.
        const onBehalf = route.onBehalfOf(m);
        const rateCtx = onBehalf || (await customers.resolve(m.from).catch(() => null));
        const acct = onBehalf ? { name: onBehalf.name } : await require('../core/customerLookup').ownRow(m.from).catch(() => null);
        const quoted = await rates
          .quote(known.map((k) => ai.partNumberIn(k) || k), {
            name: acct && acct.name,
            ctx: rateCtx && rateCtx.found ? rateCtx : null,
            lines: onBehalf ? [] : (cart && cart.lines) || [],
            label: onBehalf ? onBehalf.name : null,
          }, t)
          .catch((e) => {
            store.log(this.key, 'rate quote failed: ' + String((e && e.message) || e).slice(0, 110));
            return null;
          });
        if (quoted) {
          store.upsertCustomer(m.from);
          return reply(quoted);
        }

        // Rates come from a person who knows the account. Send it to the
        // same helper everything else goes to, with the parts attached.
        const raised = await escalation.create(this, {
          chatId: m.chatId,
          customerPhone: m.from,
          item: known.slice(0, 5).join(", "),
          qty: 1,
          kind: 'inquiry',
          reason: 'RATE',
        });
        store.log(this.key, `rate asked for ${known.length} part(s)`);
        return reply(
          raised
            ? t(
                `Rate for ${known.slice(0, 3).join(", ")} — our team will send it to you shortly.`,
                `${known.slice(0, 3).join(", ")} ka rate team abhi bhej degi.`,
              )
            : t(
                'Our team will send you the rate shortly.',
                'Rate team abhi bhej degi.',
              ),
        );
      }
      case 'status':
        return reply(await this.orderStatus(m));

      case 'inquiry': {
        // "iska stock hai?" came back as a part named "iska" and went to the
        // portal as one. A pointer is not a part: drop it, and if that leaves
        // nothing, answer about what we were just discussing.
        const items = (parsed.items || []).filter((x) => !focus.isOnlyPointer(x));
        if (!items.length && (parsed.items || []).length && focus.get(m.chatId)) {
          return reply(await this.answerInquiry(focus.names(m.chatId), m));
        }
        // "GST kitna lagega" - the tax came with the price when this list was
        // made (commercial-analyze), so it is already on the line. Answering
        // it from there is the whole point of keeping the portal's full reply.
        if (/\b(gst|tax)\b/i.test(text)) {
          const cart = orders.findDraft(m.chatId);
          const priced = ((cart && cart.lines) || []).filter((l) => l.taxPercent);
          if (priced.length) {
            const rates = [...new Set(priced.map((l) => l.taxPercent))];
            const one = priced[0];
            // The rate already has the GST in it - never "+ GST" (13 Sep, checked on an Odoo bill).
            const amount = one.rate ? ' ' + (one.partNo || one.item) + ' — ₹' + one.rate + t(' per pc, GST included.', ' per pc, GST included.') : '';
            store.log(this.key, 'GST answered from the priced list');
            return reply(
              rates.length === 1
                ? t(rates[0] + '% GST.' + amount, 'GST ' + rates[0] + '% lagta hai.' + amount)
                : t(
                    'GST: ' + priced.map((l) => (l.partNo || l.item) + ' ' + l.taxPercent + '%').join(', '),
                    'GST: ' + priced.map((l) => (l.partNo || l.item) + ' ' + l.taxPercent + '%').join(', '),
                  ),
            );
          }
        }

        // No part number anywhere in it ("You deal in rane also?", "Ye vala
        // hai ki nhi"): the gates would search the catalogue for the words or
        // ask a person. The model decides first - unless it points at the part
        // we were just discussing, or a person already taught the answer.
        if (
          !items.some(hasPartNumber) &&
          !hasPartNumber(text) &&
          !(focus.pointsBack(text) && focus.get(m.chatId)) &&
          !(!items.length && knowledge.findNote(text))
        ) {
          if (await this.followModel(m, text, reply, t)) return true;
        }

        if (!items.length) {
          // Did a human already answer this exact question once? Then answer
          // from memory instead of asking them again.
          const known = knowledge.findNote(text);
          if (known) return reply(known.answer);

          // The message carries no part number at all — it is conversation
          // ("Available hai ki nhi ye batao"). Asking a human about a phrase
          // like that wastes their time, and looking it up would put nonsense
          // in front of the portal. Ask for the part number instead.
          //
          // No items AND nothing that could be a part IS the no-part case. The
          // `noPart` flag alone is set on only one parser path, so "Please send
          // me correct information" and "Available?" fell through and were sent
          // to a human as if they were parts to identify.
          if (parsed.noPart) {
            // "ye kitna hai", "iska kya scene hai" - pointing at the part we were
            // just discussing, not starting a new conversation.
            if (focus.pointsBack(text) && focus.get(m.chatId)) {
              return reply(await this.answerInquiry(focus.names(m.chatId), m));
            }
            // No part to look up — so this is conversation wearing an inquiry's
            // clothes: "Can you arrange this?", "kitna time lagega". Answering
            // every one of them with "which part do you need?" is the robotic
            // habit this layer exists to remove. If it has nothing to say, the
            // old line still stands.
            if (await this.converse(m, text, reply)) return true;
            const draft = orders.findDraft(m.chatId);
            if (draft && draft.lines.length) {
              return reply(
                t(
                  `Your current list:\n${orders.summary(draft)}\n\nFor any other part, send its part number.`,
                  `Aapki current list:\n${orders.summary(draft)}\n\nKisi aur part ke liye uska number bhej dijiye.`,
                ),
              );
            }
            return reply(
              t(
                'Which part do you need? Part number and quantity is enough - like 43401M68P01 2',
                'Kaunsa part chahiye? Part number aur quantity bata dijiye - jaise 43401M68P01 2',
              ),
            );
          }

          // Before troubling a person: does the CATALOGUE recognise any of this?
          // A phrase our own parts list has never heard of ("Please send me
          // correct information", "When to expect?", "Wait") is conversation,
          // not a part. Escalating those buried the helper in questions that had
          // no answer — and a helper who is spammed stops replying at all.
          const phrase = text
            .replace(/[?.!,]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const hits = phrase.length >= 4 ? await availability.byName(vehicle.narrow(m.chatId, phrase)) : { total: 0, top: [] };

          if (hits.top.length === 1) {
            return this.processOrderLines(m, [{ item: hits.top[0].partNo, qty: 1 }], reply);
          }
          if (hits.top.length > 1) {
            const q = clarify.nextQuestion(hits.top, [], m.chatId);
            if (q) {
              clarify.ask(m.chatId, { base: phrase, qty: 1 }, q);
              return reply(q.text);
            }
            return reply(clarify.options(hits.top, m.chatId));
          }

          // Nothing in the catalogue. Only a phrase that still looks like a
          // part request is worth a human's time.
          if (availability.looksLikePartNumber(phrase)) {
            await escalation.create(this, {
              chatId: m.chatId,
              customerPhone: m.from,
              item: phrase,
              partNo: availability.extractPartNo(phrase),
              qty: 1,
              kind: 'inquiry',
            });
            return true;
          }
          if (focus.pointsBack(text) && focus.get(m.chatId)) {
            return reply(await this.answerInquiry(focus.names(m.chatId), m));
          }
          // Nothing here was a part after all — "order kr skta hoon?", "delivery
          // karte ho", "kya kya milta hai". Those are questions with answers,
          // and replying "send the part number" to all of them is the canned
          // dead end that made this feel like a machine. The line below stays
          // as the fallback for when there is genuinely nothing to say.
          if (await this.converse(m, text, reply)) return true;
          return reply(
            t(
              "Tell me the part number or name and the quantity - I'll check right away.",
              'Part number ya naam aur quantity bata dijiye, turant check kar deta hoon.',
            ),
          );
        }
        return reply(await this.answerInquiry(items, m));
      }

      case 'order':
        // No line carries a part number ("Need 5pc", "6pc needed"): the gates
        // would look up "Need" and ask a person. The model, with the chat in
        // view, decides first.
        if (!(parsed.lines || []).some((l) => hasPartNumber(l.item)) && !hasPartNumber(text)) {
          if (await this.followModel(m, text, reply, t)) return true;
        }
        return this.processOrderLines(m, parsed.lines || [], reply);

      case 'set_qty': {
        if (!hasPartNumber(parsed.item) && !hasPartNumber(text) && !orders.findDraft(m.chatId)) {
          if (await this.followModel(m, text, reply, t)) return true;
        }
        const order = orders.findDraft(m.chatId);
        if (order && (await orders.setQty(order, parsed.item, parsed.qty))) {
          const changed = order.lines.filter((l) => availability.sameItem(l.item, parsed.item));
          return reply(orders.ack(changed, order));
        }
        // Not a quantity change after all ("AC Gas to 4" with no such line in
        // the draft) — treat it as a new order line rather than rejecting the
        // customer with "couldn't find that".
        return this.processOrderLines(m, [{ item: parsed.item, qty: parsed.qty }], reply);
      }

      case 'remove': {
        const order = orders.findDraft(m.chatId);
        if (!order) return reply(t('There is no open order to remove anything from.', 'Abhi koi open order nahi hai jisme se hataun.'));
        // "ye wala rehne do" reaches here with nothing to remove, and answered
        // with the literal `"" aapke order mein nahi mila`.
        if (!String(parsed.item || '').trim()) {
          return reply(
            t(
              'Which part should I remove?',
              'Kaunsa part hatana hai?',
            ),
          );
        }
        if (orders.removeItem(order, parsed.item)) {
          // No count and no inline "confirm?" — that ask comes once, at the
          // end, from askToConfirmLater. An empty order is different: that IS
          // the news, and nothing else would say it.
          this.askToConfirmLater(m, t);
          return reply(
            order.lines.length
              ? t('Removed.', 'Hata diya.')
              : t('Removed. Your order is now empty.', 'Hata diya. Order ab khaali hai.'),
          );
        }
        return reply(
          t(`Couldn't find "${parsed.item}" in your order.`, `"${parsed.item}" aapke order mein nahi mila.`),
        );
      }

      case 'confirm': {
        // A yes to "cancel the whole order?" is a cancel, not an order.
        // The age is checked here too: the minute sweep has not run yet when a
        // restart brings back an old ask.
        if (pendingCancel.has(m.chatId) && Date.now() - pendingCancel.get(m.chatId) <= CANCEL_ASK_MS) {
          pendingCancel.delete(m.chatId);
          const doomed = orders.findDraft(m.chatId);
          if (doomed) {
            orders.cancel(doomed);
            return reply(
              t(
                `Order ${doomed.id} cancelled.`,
                `Order ${doomed.id} cancel kar diya.`,
              ),
            );
          }
        }

        // In a GROUP, "ok" / "ha" / "done" / "thik hai" are far more likely
        // a reply to a human than an order confirmation. Only an unmistakable
        // yes may place an order there — nothing is ordered on a filler word.
        if (
          m.isGroup &&
          !/^(yes+|confirm(ed)?|confirm karo|haan+|pakka|final|book it|place (the )?order)\b/i.test(text)
        ) {
          // Not a yes - but still a message. "Baki bill kardo" in a group got
          // nothing at all (sandbox, 13 Sep). A bare "ok" stays unanswered.
          return this.afterGates(m, text, reply, t);
        }
        // A number that only asks - the sales team, and admins since 13 Sep -
        // places nothing until a customer is picked. An old draft still sitting
        // on its chat (ORD-1040, 28 lines on the founder's "Anuj" account) must
        // not be punched by a "haan" meant for something else.
        if (this.inquiryOnly(m.from, m.chatId)) return this.afterGates(m, text, reply, t);
        const order = orders.findDraft(m.chatId);
        // A bare "yes" with no draft: still a message, answered (never silence).
        if (!order || !order.lines.length) return this.afterGates(m, text, reply, t);

        // "yes only 6", "sirf 2 aur 5", "only 72321M68P00": a yes to PART of
        // the list. 14 Sep, live: "yes only 6" punched all six lines as SO 686
        // (cancelled at once).
        if (ONLY_WORD.test(text)) return this.keepOnly(m, text, reply, t, order);

        // THE ASK WAS OVERTAKEN. 14 Sep, live: the list was asked at 14:09;
        // then "only 10" got "I am checking this part", "what happen" got a
        // chat line - and the "ok" at 14:23, answering THOSE, punched all ten
        // lines as SO 687. Once the bot has said anything else since asking, a
        // yes is answered by showing the list and asking again.
        if (order.confirmAskedAt) {
          const askedAt = Date.parse(order.confirmAskedAt);
          const since = conversation
            .turns(m.chatId)
            .filter((x) => x.role === 'us' && typeof x.at === 'number' && x.at > askedAt + 5000);
          if (since.length) {
            cancelConfirmNudge(m.chatId);
            order.confirmAskedAt = new Date().toISOString();
            store.save();
            store.log(this.key, `yes on ${order.id}, but ${since.length} other message(s) went out since the ask - asking again`);
            return reply(
              t(`${orders.summary(order)}\n\nShall I place this order?`, `${orders.summary(order)}\n\nYe order punch kar dun?`),
            );
          }
        }

        // NO ASK, NO ORDER. On 12 Sep the "Confirm karun?" lived only in a
        // setTimeout; a deploy restarted the bot, the question never went
        // out, and the customer's next "Ok" - meaning "ok, noted" - punched
        // SO 626. The ask is now recorded on the draft and saved, so the
        // first yes after a lost ask asks again instead of ordering.
        if (!order.confirmAskedAt) {
          order.confirmAskedAt = new Date().toISOString();
          store.save();
          cancelConfirmNudge(m.chatId);
          store.log(this.key, `yes on ${order.id} with no ask sent - asking first`);
          return reply(
            t(
              `${orders.summary(order)}\n\nShall I place this order?`,
              `${orders.summary(order)}\n\nYe order punch kar dun?`,
            ),
          );
        }

        // An order must be punched against a REAL buyer on the portal. If we
        // cannot name one, refuse — never invent a buyer, and never fall back
        // to the bot's own account, which would file the order against
        // Cartrends instead of the customer.
        const buyer = order.portalCustomer || (await customers.resolve(m.from));
        if (buyer.found === false) {
          // Said once. On 13 Sep, live, the same paragraph went out three
          // times in a row - to "Hn", "Ok" and "Thik hai.. mt kro".
          const toldAlready = conversation
            .turns(m.chatId)
            .filter((x) => x.role === 'us')
            .slice(-4)
            .some((x) => /register nahi hai|not registered/i.test(x.text));
          if (toldAlready) {
            return reply(
              t(
                'Noted - your list is saved, and the order goes in as soon as the account is set up.',
                'Theek hai sir - list save hai, account bante hi order lag jayega.',
              ),
            );
          }
          return reply(
            t(
              'Your account is not registered in our system yet, so I cannot place the order. ' +
                'Our team will contact you and set it up — your list is safe until then.',
              'Aapka account abhi hamare system mein register nahi hai, isliye order punch nahi kar paunga. ' +
                'Hamari team aapse sampark karke account bana degi — tab tak ye list safe hai.',
            ),
          );
        }
        if (buyer.found === null) {
          return reply(
            t(
              "Our system isn't responding right now - could you OK it again in a few minutes?",
              'System abhi respond nahi kar raha - thodi der mein ek baar phir OK kar dijiye?',
            ),
          );
        }
        if (buyer.canConfirm === false) {
          return reply(
            t(
              'Your account is not enabled for placing orders yet. Our team will contact you shortly.',
              'Aapke account se abhi order punch nahi ho sakta. Hamari team jald aapse sampark karegi.',
            ),
          );
        }
        order.portalCustomer = buyer;

        // WHO is punching it. The portal keeps "which agent sold what" in
        // actor_user_id, and it knows the mobile→user mapping itself. A number
        // it does not know simply carries no actor, exactly as before.
        try {
          const actor = await portal.userForMobile(m.from);
          if (actor && actor.userId) {
            order.actorUserId = actor.userId;
            order.actorName = actor.username || null;
            store.save();
          }
        } catch (e) {
          store.log(this.key, 'actor lookup failed: ' + String((e && e.message) || e).slice(0, 90));
        }

        try {
          const result = await orders.confirm(order);

          // Two "yes" in the same second - a duplicate webhook, or a double
          // tap. The first one is already at the portal; a second punch would
          // be a second sales order.
          if (result.busy) {
            return reply(t('One moment — I am placing it now.', 'Ek minute — laga raha hoon.'));
          }

          // Testing mode: the draft is kept exactly as it is, so the same YES
          // will place it the moment ORDER_CONFIRM_ENABLED is turned on.
          if (result.blocked) {
            const salesNote = salesOrder.whenBlocked(m.chatId, order, t);
            if (salesNote) return reply(salesNote);
            return reply(
              t(
                `I have noted your order (${result.lines} item). Our team will confirm and update you.`,
                `Aapka order note kar liya hai (${result.lines} item). Team confirm karke aapko update karegi.`,
              ),
            );
          }

          // Stock moved (or the quote aged out) — show the CURRENT figures and
          // wait for a fresh yes. Never place an order on the same message
          // that refreshed the numbers: the customer must agree to the figure
          // they were actually shown.
          if (result.stale) {
            if (result.expired) {
              return reply(
                t(
                  'That order has been open too long, so the quantities are no longer reliable. ' +
                    'Please send the items again and I will check fresh stock for you.',
                  'Ye order kaafi der se khula tha, isliye quantity ab pakki nahi hai. ' +
                    'Item dobara bhej dijiye, main fresh check kar deta hoon.',
                ),
              );
            }
            // Re-quoting IS the ask: it shows the new figures and asks
            // about them, so the next yes agrees to what was shown.
            order.confirmAskedAt = new Date().toISOString();
            store.save();
            return reply(
              t(
                `⚠️ Stock changed since I checked${result.ageMin ? ` (${result.ageMin} min ago)` : ''}. Here it is right now:\n` +
                  `${orders.summary(order)}\n\nShall I confirm with these quantities?`,
                `⚠️ Jab se check kiya tha, stock badal gaya hai${result.ageMin ? ` (${result.ageMin} min pehle)` : ''}. Abhi ye hai:\n` +
                  `${orders.summary(order)}\n\nIn quantity ke saath confirm kar dun?`,
              ),
            );
          }

          // Nothing in stock: no SO at all (founder, 14 Sep - only what is
          // there is punched). The list stays open.
          if (result.nothingInStock) {
            const names = (result.skipped || []).map((l) => l.requested || l.item).join(', ');
            return reply(
              t(
                `None of these is in stock right now, so no SO was made: ${names}.`,
                `Inme se koi part abhi stock mein nahi hai, isliye SO nahi banaya: ${names}.`,
              ),
            );
          }

          const { soNumber, placed } = result;
          // A pending list becomes one sales order per customer order number,
          // so the customer needs all of them back against their own numbers
          // — that is how they will match the bills.
          let msg =
            placed && placed.length > 1
              ? t(
                  `Draft SO ready — your ${placed.length} orders went in separately:\n`,
                  `Draft SO ban gaya — aapke ${placed.length} order alag-alag gaye hain:\n`,
                ) + placed.map((p) => `ORDER ${p.ref} → *${p.soNumber}* (${p.lines} item)`).join('\n')
              : t(
                  `Draft SO *${soNumber}* is ready.`,
                  `Draft SO *${soNumber}* taiyar hai.`,
                );
          // The SO holds only what is in stock (founder, 14 Sep), and the
          // message is just "Draft SO X taiyar hai" - the draft that follows
          // shows what is in it. No "reserved, coming on order", no "jitna
          // stock hai utna hi SO mein", no "stock mein nahi" ("ye sb mt likho").
          const { punchedLines = [] } = result;
          // And what the portal really took, against what was sent (SO 687:
          // the bot believed ten lines went in).
          const took = (placed || []).every((p) => Array.isArray(p.portalLines)) ? (placed || []).flatMap((p) => p.portalLines) : null;
          if (took) {
            const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            const notTaken = punchedLines
              .map((p) => ({ p, got: took.filter((x) => key(x.partNo) === key(p.partNo)).reduce((s, x) => s + (Number(x.qty) || 0), 0) }))
              .filter((x) => x.got < x.p.qty);
            if (notTaken.length) {
              const listed = notTaken
                .map((x) => `${x.p.partNo} - ${x.got ? t(`only ${x.got} of ${x.p.qty} ordered`, `${x.p.qty} mein se sirf ${x.got} order hue`) : t('NOT ordered', 'order NAHI hua')}`)
                .join('\n');
              msg += t(`\n\n⚠️ The portal did not take these:\n${listed}`, `\n\n⚠️ Ye portal pe order nahi hue:\n${listed}`);
              store.log(this.key, `SO ${soNumber}: portal did not take ${notTaken.map((x) => x.p.partNo + ' ' + x.got + '/' + x.p.qty).join(', ')}`);
            }
          }
          const also = this.crossSellFor(order.lines);
          if (also.length) {
            msg += t(
              `\n\n🛠 *You may also need:* ${also.join(', ')} — send quantities and we'll add them.`,
              `\n\n🛠 *Ye bhi lag sakta hai:* ${also.join(', ')} — quantity bhej dijiye, add kar dunga.`,
            );
          }
          // A salesman is told the SO is punched and for whom; a customer
          // gets their own message. Then both see the same thing.
          const forCustomer = salesOrder.activeCustomer(m.chatId);
          const soAsk = salesOrder.afterPunch(m.chatId, result, t);
          if (soAsk) {
            await reply(soAsk);
          } else {
            store.upsertCustomer(m.from);
            await reply(msg);
          }
          // Nothing is allocated yet: the order sits on the portal with
          // do_status "pending" while the draft SO is checked
          // (core/soReview). The next yes is what starts the packing, and
          // the confirmed SO comes back after it.
          await soReview.start(this, m, result, reply, t, {
            order,
            customerName: forCustomer ? forCustomer.name : null,
          });
          return true;
        } catch (e) {
          store.log(this.key, 'confirm failed: ' + e.message);
          // NEVER tell the customer an order exists when the portal refused,
          // and never say the team was told unless it was. A credit hold is
          // a decision somebody here can clear, so it is named and sent to
          // the people who can clear it (core/punchRefused).
          const blockedFor = salesOrder.activeCustomer(m.chatId);
          return reply(
            await punchRefused.handle(this, e, {
              phone: m.from,
              chatId: m.chatId,
              order,
              customerName: blockedFor ? blockedFor.name : (order.portalCustomer && order.portalCustomer.name) || null,
              t,
            }),
          );
        }
      }

      // "rehne do", "abhi rehne do", "nahi chahiye" — it might mean one item,
      // the whole order, or just this conversation. It binned a two-item cart
      // on the live line. Now it asks, and the next yes does it.
      case 'maybe_cancel': {
        const order = orders.findDraft(m.chatId);
        // Nothing to cancel: still a message, answered like any other.
        if (!order || !order.lines.length) return this.afterGates(m, text, reply, t);
        pendingCancel.set(m.chatId, Date.now());
        return reply(
          t(
            'Cancel the whole order? Or is it just one part you want out?',
            'Poora order cancel kar dun? Ya bas koi ek part hatana hai?',
          ),
        );
      }

      case 'cancel': {
        const order = orders.findDraft(m.chatId);
        // Nothing to cancel is still an answer (13 Sep, live: "cancel order"
        // twice, after ORD-1040 was already gone, got silence). A customer
        // picked for an order with nothing in it yet is what they mean.
        if (!order) {
          const picked = salesOrder.activeCustomer(m.chatId);
          if (picked) {
            salesOrder.clear(m.chatId);
            store.log(this.key, `cancel with no cart - closed the order for ${picked.name}`);
            return reply(
              t(
                `Closed the order for ${picked.name} - nothing had been added to it.`,
                `${picked.name} ka order band kar diya - usme koi part nahi joda tha.`,
              ),
            );
          }
          return reply(t('There is no open order to cancel.', 'Abhi koi open order nahi hai jise cancel karun.'));
        }
        pendingCancel.delete(m.chatId);
        orders.cancel(order);
        return reply(
          t(
            `Order ${order.id} cancelled.`,
            `Order ${order.id} cancel kar diya.`,
          ),
        );
      }

      default:
        // Nothing in the order pipeline matched. That used to end here in
        // silence, which on a live chat reads as broken — the counter man
        // answers "Wait" and "Can you arrange this?" in four words. Groups get
        // the same (founder, 13 Sep: every change for everyone); Cartrends
        // staff in a group never reach here - pipeline/route drops them.
        // What the Understand model makes of it, with the chat in view. An
        // order it understood is read back before anything is added; an order
        // it could not pin to a real part gets a clear line, not silence.
        return this.afterGates(m, text, reply, t);
    }
  }

  // A message no gate had an answer for: what the Understand model reads in
  // it, then the chat layer, then where things stand. Never silence.
  async afterGates(m, text, reply, t) {
    {
      const understood = await this.understood(m, text, reply, t);
      if (understood === true) return true;
      if (understood === 'unclear') return reply(this.whereWeAre(m, t, { unclear: true }));
    }
    if (await this.converse(m, text, reply)) return true;
    // "aur silent kbhi na ho bot" (founder, 13 Sep). "??" left unanswered
    // is a customer waiting; only a bare "ok" / "achha" needs nothing.
    if (JUST_ACK.test(text)) return false;
    // The helpers answer the bot's questions; a stray line from them is
    // not a customer waiting, and "send the part number" to them is noise.
    // Unless the helper is also an admin or on the sales team: then they are
    // asking, like anyone on the desk (13 Sep, live - the founder's number is a
    // helper too, and his bare "83401M82P11" got nothing).
    {
      const p = store.normPhone(m.from);
      if ((p === config.escalationNumber || p === config.voiceEscalationNumber) && !salesOrder.isSalesPerson(m.from)) return false;
    }
    store.log(this.key, `"${text.slice(0, 40)}" - nothing else to say, telling them where things stand`);
    return reply(this.whereWeAre(m, t));
  }

  // After the customer stops adding parts, ask once. Not after every line.
  // THE ask: the list, and then the question. On 12 Sep this asked
  // "11 items in the order. Confirm sir?" while four of those eleven were
  // left over from a list the customer had started 19 minutes earlier. They
  // said yes to a number and bought four parts they had forgotten about.
  // Whatever is about to be ordered is shown before it is ordered.
  async askToConfirmNow(m, t) {
    const chatId = m.chatId;
    const tt = t || lang.for(chatId);
    const open = orders.findDraft(chatId);
    if (!open || !open.lines.length) return false;
    const text =
      salesOrder.draftAsk(chatId, open, tt) ||
      tt(`${orders.summary(open)}\n\nConfirm sir?`, `${orders.summary(open)}\n\nConfirm karun sir?`);
    try {
      const askId = await this.transport.sendToChat(chatId, text);
      rememberMsg(chatId, askId, 'us', text);
      // Written down, and saved: a restart cannot lose the fact that the
      // customer was asked, and nothing is punched without it.
      open.confirmAskedAt = new Date().toISOString();
      store.save();
      return true;
    } catch (e) {
      store.log(this.key, 'confirm ask failed: ' + String((e && e.message) || e).slice(0, 90));
      return false;
    }
  }

  // Asked once, after the customer stops adding parts - not after each line.
  askToConfirmLater(m, t) {
    const chatId = m.chatId;
    if (this.inquiryOnly(m.from, m.chatId)) return;
    cancelConfirmNudge(chatId);
    const since = Date.now();
    const timer = setTimeout(() => {
      confirmNudges.delete(chatId);
      // Already asked in the meantime (a salesman's pre-check, "kya hua"):
      // the same question twice reads as nobody listening.
      const open = orders.findDraft(chatId);
      if (open && open.confirmAskedAt && Date.parse(open.confirmAskedAt) >= since) return;
      this.askToConfirmNow(m, t).catch(() => {});
    }, CONFIRM_NUDGE_MS);
    if (timer.unref) timer.unref();
    confirmNudges.set(chatId, timer);
  }

  // A part number the bot HEARD. It is read back and waits for a yes before
  // it becomes an order — see core/voiceOrder.js for why.
  //
  // Returns true if the customer has been asked; false to let the voice note
  // go to a person as it always did.
  async heardOrder(m, transcript, reply, t) {
    const parsed = ai.parseLinesBlock(transcript) || [];
    if (!parsed.length) return false;

    // Every part must be IN THE CATALOGUE. A mis-heard digit almost always
    // produces a number that is in no catalogue, so the common failure lands
    // on a person by itself rather than being read back as though it were
    // real. `partNo` alone is not the test — the resolver echoes back whatever
    // it was given for a part it does not recognise, with source
    // 'unidentified'. A catalogued part that is merely out of stock is fine:
    // that is an order with an ETA, not a wrong number.
    const KNOWN = new Set(['portal', 'unavailable', 'partial']);
    const confirmed = [];
    for (const line of parsed) {
      const hit = await availability.resolveOne(line.item, line.qty || 1);
      if (!hit || !hit.partNo || !KNOWN.has(hit.source)) {
        store.log(
          this.key,
          `heard "${line.item}" but the catalogue does not know it (${(hit && hit.source) || 'no hit'}) — to a person`,
        );
        return false;
      }
      confirmed.push({ item: hit.partNo, qty: line.qty || 1, qtyMissing: !!line.qtyMissing });
    }

    voiceOrder.remember(m.chatId, confirmed, transcript);
    const listed = confirmed
      .map((l) => `${l.item}${l.qtyMissing ? '' : ` x${l.qty}`}`)
      .join('\n');
    store.log(this.key, `heard an order in a voice note: ${listed.replace(/\n/g, ', ')}`);
    // Just the lines and one word. "From your voice note I understood" is the
    // bot explaining its own machinery; the customer only needs to check the
    // number against what they said.
    return reply(t(`${listed}\nright?`, `${listed}\nsahi hai?`));
  }

  // Apply "Leave 9no. Item" / "4th. No. Item 3pc" against the numbered list
  // the customer is replying to. WhatsApp tells us WHICH message they
  // quoted, so there is no guessing about which list "item 9" means; with no
  // quote we use the last list sent in that chat, within the hour.
  async editListByNumber(m, text, reply, t) {
    const edit = lists.parseEdit(text);
    if (!edit) return false;
    const remembered = lists.forReply(m.chatId, m.contextId);
    const order = orders.findDraft(m.chatId);

    // No list to count against. Say so rather than guess a line number —
    // silently removing the wrong part is the one unrecoverable mistake here.
    if (!remembered || !order || !order.lines.length) {
      store.log(this.key, `list edit "${text.slice(0, 40)}" but no list to apply it to`);
      return reply(
        t(
          'Which item? Tell me the part number or name.',
          'Kaunsa item sir? Part ka number ya naam bata dijiye.',
        ),
      );
    }

    const numbered = remembered.lines;
    const outOfRange = [...edit.drop, ...Object.keys(edit.setQty).map(Number)].filter(
      (n) => n < 1 || n > numbered.length,
    );
    const removed = [];
    const changed = [];

    // Highest line first, so removing line 4 does not renumber line 9 before
    // we get to it.
    for (const n of [...edit.drop].sort((a, b) => b - a)) {
      const line = numbered[n - 1];
      if (!line) continue;
      if (orders.removeItem(order, line.partNo || line.item)) removed.push(`${n}. ${line.item}`);
    }
    for (const [nStr, qty] of Object.entries(edit.setQty)) {
      const line = numbered[Number(nStr) - 1];
      if (!line) continue;
      if (await orders.setQty(order, line.partNo || line.item, qty)) changed.push(`${nStr}. ${line.item} x${qty}`);
    }

    // A line that is on the list but no longer in the order — they took it
    // out a message ago. Saying nothing about it looks like it worked.
    const gone = [
      ...edit.drop.filter((n) => numbered[n - 1] && !removed.some((r) => r.startsWith(`${n}. `))),
      ...Object.keys(edit.setQty)
        .map(Number)
        .filter((n) => numbered[n - 1] && !changed.some((c) => c.startsWith(`${n}. `))),
    ].filter((n) => !outOfRange.includes(n));

    if (!removed.length && !changed.length) {
      if (gone.length) {
        return reply(
          t(
            `Item ${gone.join(', ')} is not in the order any more.`,
            `Item ${gone.join(', ')} to pehle hi hat chuka hai.`,
          ),
        );
      }
      if (outOfRange.length) {
        return reply(
          t(
            `That list had ${numbered.length} items - there's no item ${outOfRange.join(', ')}.`,
            `Us list mein ${numbered.length} hi item the, item ${outOfRange.join(', ')} tha hi nahi.`,
          ),
        );
      }
      return reply(
        t(
          "Couldn't find those in the order - which ones did you mean?",
          'Wo item order mein nahi mile - kaunse wale the?',
        ),
      );
    }

    store.log(
      this.key,
      `list edit: removed ${removed.length}, changed ${changed.length}, from "${text.slice(0, 50)}"`,
    );
    const parts = [];
    if (removed.length) parts.push(t(`Removed:\n${removed.join("\n")}`, `Hata diya:\n${removed.join("\n")}`));
    if (changed.length) parts.push(t(`Changed:\n${changed.join("\n")}`, `Badal diya:\n${changed.join("\n")}`));
    if (gone.length) {
      parts.push(
        t(
          `Item ${gone.join(', ')} is not in the order any more.`,
          `Item ${gone.join(', ')} ab order mein hai hi nahi.`,
        ),
      );
    }
    if (outOfRange.length) {
      parts.push(
        t(
          `No item ${outOfRange.join(", ")} on that list (it had ${numbered.length}).`,
          `Us list mein item ${outOfRange.join(", ")} tha hi nahi (${numbered.length} the).`,
        ),
      );
    }
    // Only when the order is now empty. A running count after every edit is
    // the same mid-conversation noise the ack used to print.
    if (!order.lines.length) parts.push(t('The order is now empty.', 'Order ab khaali hai.'));
    this.askToConfirmLater(m, t);
    return reply(parts.join('\n\n'));
  }

  // The Understand model (pipeline/understand) for a message the gates could
  // not place, like "same wala 3 aur bhej do". It sees the chat, the cart and
  // what was just discussed. What it understood is READ BACK and waits for a
  // yes - the safety a heard voice note gets - so a wrong reading costs the
  // customer one "nahi", never a wrong order. A part number that did not come
  // from the chat is dropped inside understand before it reaches here.
  //
  // true = read back; 'unclear' = it is an order we cannot pin down; false =
  // not an order, let the chat layer answer.
  async understood(m, text, reply, t, given = null) {
    // Everyone, the sales team included: for a number that only asks, the
    // yes after the read-back goes through processOrderLines, which answers
    // availability and builds no cart.
    let d = given;
    if (!d) {
      // With no number in the message and nothing discussed or in the cart,
      // there is nothing for it to resolve - that is plain conversation.
      if (!/\d/.test(text) && !focus.get(m.chatId) && !orders.findDraft(m.chatId)) return false;
      d = await this.modelReading(m);
      if (!d) return false;
    }
    if (d.intent !== 'order') return false;
    const lines = d.lines.map((l) => ({ item: partish.partNumber(String(l.item || '')), qty: parseInt(l.qty, 10) }));
    // A part it placed but no quantity: that is a question, answered the way a
    // typed part number with no quantity is - what we have, then "how many?".
    // Nothing goes in the cart until they say.
    if (lines.length && lines.every((l) => l.item && !(l.qty > 0))) {
      store.log(this.key, `understood "${text.slice(0, 50)}" as ${lines.map((l) => l.item).join(', ')} with no quantity - asking how many`);
      await this.processOrderLines(m, lines.map((l) => ({ item: l.item, qty: 1, qtyMissing: true })), reply);
      return true;
    }
    if (!lines.length || lines.some((l) => !l.item || !(l.qty > 0 && l.qty <= 999))) {
      store.log(this.key, `understood "${text.slice(0, 50)}" as an order but not which part or how many (${String(d.why || 'no part number').slice(0, 80)})`);
      return 'unclear';
    }
    voiceOrder.remember(m.chatId, lines, text, 'text');
    const listed = lines.map((l) => `${l.item} x${l.qty}`).join('\n');
    store.log(this.key, `understood "${text.slice(0, 50)}" as ${listed.replace(/\n/g, ', ')} - reading it back`);
    return reply(t(`${listed}\nadd this to the order?`, `${listed}\norder mein daal doon?`));
  }

  // What the Understand model makes of this message - asked once, shared with
  // the shadow log. null when it is off or failed: the gates then do exactly
  // what they did before.
  async modelReading(m) {
    const understandMod = require('../pipeline/understand');
    if (!config.ai.apiKey && !understandMod._stubbed()) return null;
    try {
      const r = await require('../pipeline/shadow').decide(m);
      return r.decision;
    } catch (e) {
      store.log(this.key, 'understand failed: ' + String((e && e.message) || e).slice(0, 100));
      return null;
    }
  }

  // Phase 4, founder 13 Sep, from the replay verdicts. Where the gates were
  // about to hand a message to a person, or to drop an order, the model's
  // reading wins: conversation is answered in words (31 right, 2 wrong), an
  // order is read back and waits for a yes (10 right, 0 wrong). Anything else
  // - or no model - and the gates carry on as before.
  async followModel(m, text, reply, t) {
    const d = await this.modelReading(m);
    if (!d) return false;
    if (d.intent === 'chat' || d.intent === 'greet') {
      store.log(this.key, `model: "${text.slice(0, 50)}" is conversation (${String(d.why || '').slice(0, 60)}) - answering, nobody asked`);
      return this.chatAnswer(m, text, reply, t);
    }
    if (d.intent === 'order') return (await this.understood(m, text, reply, t, d)) === true;
    // "Is it done?" / "So bn gya?" - the real status, never a chat line or a person.
    if (d.intent === 'orderStatus') {
      store.log(this.key, `model: "${text.slice(0, 50)}" asks where an order stands`);
      return reply(await this.orderStatus(m));
    }
    return false;
  }

  // The portal part numbers that begin with what was written: a handwritten
  // "71751M69R00" is the catalogue's 71751M69R005PK (13 Sep, live). Offered,
  // never ordered - a 5PK is a pack of five, not the same line.
  // With the stock of each, for the quantity asked (founder, 14 Sep: "closest
  // mai bhi avl de do"): "71751M69R005PK (only 4 available)". Priced for the
  // customer in `ctx` when there is one.
  async nearParts(asked, { ctx = null, t = (en) => en, qtys = new Map() } = {}) {
    const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const found = new Map();
    for (const a of asked.slice(0, 15)) {
      const want = norm(a);
      if (want.length < 6) continue;
      try {
        const rows = ((await portal.searchByName(want)) || {}).top || [];
        const hits = [...new Set(rows.map((r) => r.partNo).filter((p) => p && (norm(p).startsWith(want) || want.startsWith(norm(p)))))];
        if (hits.length) found.set(a, hits.slice(0, 3));
      } catch (e) {
        store.log(this.key, 'closest part search failed for ' + a + ': ' + String((e && e.message) || e).slice(0, 80));
      }
    }
    // One stock call for all of them, each at the quantity that was asked for.
    const wanted = [];
    for (const [a, hits] of found) for (const p of hits) wanted.push({ asked: a, partNo: p, qty: parseInt(qtys.get(a), 10) > 0 ? parseInt(qtys.get(a), 10) : 1 });
    const stock = new Map();
    if (wanted.length) {
      try {
        const rows = await availability.resolve(wanted.map((w) => ({ item: w.partNo, qty: w.qty })), ctx);
        rows.forEach((r, i) => stock.set(wanted[i].asked + '|' + wanted[i].partNo, { r, need: wanted[i].qty }));
      } catch (e) {
        store.log(this.key, 'closest part stock check failed: ' + String((e && e.message) || e).slice(0, 80));
      }
    }
    const out = new Map();
    for (const [a, hits] of found) {
      out.set(
        a,
        hits.map((p) => {
          const s = stock.get(a + '|' + p);
          if (!s || !s.r || s.r.source === 'unidentified' || s.r.source === 'unknown') return p;
          const have = Number(s.r.available) || 0;
          if (s.r.source === 'unavailable' || have <= 0) return p + t(' (on order)', ' (on order)');
          return p + (have >= s.need ? t(' (available)', ' (available)') : t(` (only ${have} available)`, ` (sirf ${have} available)`));
        }),
      );
    }
    return out;
  }

  // Keep only the lines named - by list number or part number - show the list,
  // and ask again. Never punches on the message that changed the list.
  async keepOnly(m, text, reply, t, order) {
    const n = order.lines.length;
    const nums = [...new Set((text.match(/\b\d{1,2}\b/g) || []).map(Number).filter((x) => x >= 1 && x <= n))];
    const pn = ai.partNumberIn(text);
    const named = pn ? order.lines.filter((l) => String(l.partNo || l.item).toUpperCase() === String(pn).toUpperCase()) : [];
    const keep = named.length ? named : nums.map((x) => order.lines[x - 1]);
    if (!keep.length) {
      return reply(
        t(
          `Which ones? The list has ${n} items - send their numbers, like "only 2 and 5".`,
          `Kaunse wale? List mein ${n} item hain - number bhej dijiye, jaise "sirf 2 aur 5".`,
        ),
      );
    }
    for (const l of order.lines.filter((x) => !keep.includes(x))) orders.removeItem(order, l.partNo || l.item);
    cancelConfirmNudge(m.chatId);
    order.confirmAskedAt = new Date().toISOString();
    store.save();
    store.log(this.key, `"${text}" - kept ${keep.length} of ${n} line(s) on ${order.id}, asking again`);
    return reply(
      t(`Only these, then:\n${orders.summary(order)}\n\nShall I place this order?`, `Sirf ye rakhe:\n${orders.summary(order)}\n\nYe order punch kar dun?`),
    );
  }

  // Cartrends' own people: admins and the sales team.
  isOwnTeam(m) {
    return config.adminNumbers.includes(store.normPhone(m.from)) || salesOrder.isSalesPerson(m.from);
  }

  // Conversation the model said nobody needs to be asked about. Answered in
  // words when the chat layer has something safe to say; otherwise with where
  // things stand. Never silence, and never "team ko bata diya" - nobody was.
  async chatAnswer(m, text, reply, t) {
    const tt = t || lang.for(m.chatId);
    let out = null;
    try {
      out = await smallTalk.respond(m.chatId, text, m.from, { noHuman: true });
    } catch (e) {
      store.log(this.key, 'chat answer failed: ' + String((e && e.message) || e).slice(0, 100));
    }
    if (out && out.action === 'reply') {
      store.log(this.key, `chat reply: "${out.text.slice(0, 60)}"`);
      return reply(out.text);
    }
    if (JUST_ACK.test(text)) return true;
    // It wanted to promise something nobody was asked to do. In a group the
    // Cartrends people read the message themselves, so a plain acknowledgement
    // is the honest answer.
    if ((m.isGroup || this.isOwnTeam(m)) && out && (out.refused === 'promises something' || out.refused === 'wanted a person')) {
      return reply(tt('Okay sir.', 'Theek hai sir.'));
    }
    return reply(this.whereWeAre(m, tt, { unclear: Boolean(out && out.refused && out.refused !== 'wanted a person' && out.refused !== 'promises something') }));
  }

  // Where this chat stands, in one line: for "kya hua", and in place of a
  // silence. Never claims more than is true - no order is mentioned unless
  // there is one. With one part number just discussed it asks how many, and
  // that becomes the open question, so "4" next is the quantity.
  whereWeAre(m, t, { unclear = false } = {}) {
    const sorry = unclear ? t("Sorry, didn't get that. ", 'Samajh nahi paya sir. ') : '';
    // A question we asked and are still waiting on comes first: "1." after
    // "Kaunsi gaadi?" is answered by asking it again, not by "nothing pending".
    const cl = clarify.get(m.chatId);
    const clAsked = cl && require('../core/chatState').slot('clarify.lastAsked').get(m.chatId);
    if (cl && clAsked && clAsked.text) {
      return sorry + t(`${cl.base} - ${clAsked.text}`, `${cl.base} - ${clAsked.text}`);
    }
    // The sales desk - salesmen and admins - builds no cart until a customer
    // is picked, so "how many?" leads nowhere. Say what does.
    if (salesOrder.isSalesPerson(m.from) && this.inquiryOnly(m.from, m.chatId)) {
      return (
        sorry +
        t(
          'To place an order, pick the customer first - like: Kalra Motors ka SO bana do',
          'Order ke liye pehle customer chuniye - jaise: Kalra Motors ka SO bana do',
        )
      );
    }
    const waitingQty = askQty.get(m.chatId);
    if (waitingQty && waitingQty.items && waitingQty.items.length) {
      const names = waitingQty.items.map((i) => i.partNo || i.item).join(', ');
      return sorry + t(`How many do you need - ${names}?`, `${names} - kitni quantity chahiye?`);
    }
    const draft = orders.findDraft(m.chatId);
    if (draft && draft.lines.length) {
      return t(
        `${unclear ? "Sorry, didn't get that. " : ''}Your list has ${draft.lines.length} item - anything to add, or shall I confirm?`,
        `${unclear ? 'Samajh nahi paya sir. ' : ''}Aapki list mein ${draft.lines.length} item hain - kuch aur add karna hai, ya confirm karun?`,
      );
    }
    const discussed = focus.get(m.chatId) || [];
    const numbered = discussed.filter((x) => x.partNo && (partish.isPartNumber(x.partNo) || /^\d{7,13}$/.test(x.partNo)));
    if (discussed.length === 1 && numbered.length === 1) {
      askQty.ask(m.chatId, [{ item: numbered[0].partNo }]);
      return t(
        `${unclear ? "Sorry, didn't get that. " : ''}No order yet - how many ${numbered[0].partNo} do you need?`,
        `${unclear ? 'Samajh nahi paya sir. ' : ''}Abhi order nahi bana hai - ${numbered[0].partNo} ke kitne piece chahiye?`,
      );
    }
    return unclear
      ? t(
          "Sorry, I didn't get that - send the part number and quantity, like 16510M65L10 5.",
          'Samajh nahi paya sir - part number aur quantity bhej dijiye, jaise 16510M65L10 5.',
        )
      : t(
          "Nothing pending from my side - send the part number and quantity, like 16510M65L10 5, and I'll check right away.",
          'Abhi koi order pending nahi hai - part number aur quantity bhej dijiye, jaise 16510M65L10 5, turant check karta hoon.',
        );
  }

  // The ONLY place a model writes something a customer reads, and only for
  // messages the deterministic pipeline declined. The fences in
  // core/smallTalk.js can lose a reply; they can never invent one.
  async converse(m, text, reply) {
    let out = null;
    try {
      out = await smallTalk.respond(m.chatId, text, m.from);
    } catch (e) {
      store.log(this.key, 'converse failed: ' + String((e && e.message) || e).slice(0, 100));
    }
    if (!out) return false;
    if (out.action === 'silent') {
      // "ok", "achha", "??" - the model chose silence, and that is right.
      if (!out.refused) return false;
      // It had something to say and it was not safe to send. That is still a
      // customer waiting for an answer.
      store.log(this.key, `chat reply refused (${out.refused}) - answering with where things stand`);
      return reply(this.whereWeAre(m, lang.for(m.chatId), { unclear: true }));
    }

    if (out.action === 'human') {
      // The model reads the whole chat (Phase 4, founder 13 Sep). An order it
      // read is read back, for everyone. Conversation it says needs nobody is
      // answered in words in a GROUP, where Cartrends people read every
      // message anyway - that is where all the replay evidence came from. In
      // a DM nobody else sees "Please collect cheque tomorrow"; on 13 Sep the
      // sandbox answered it "wahi contact karenge" with no one told. So in a
      // DM money and complaints still reach a person.
      // Admins and the sales team ARE the team: "cheque le lena" from them is
      // answered, never turned into a helper question (founder, 13 Sep: admin
      // or salesman asking money things gets the answer, not the team).
      if (this.isOwnTeam(m)) {
        const d = await this.modelReading(m);
        if (d && d.intent === 'orderStatus') return reply(await this.orderStatus(m));
        store.log(this.key, `"${text.slice(0, 50)}" from our own team - answering, nobody asked`);
        return this.chatAnswer(m, text, reply, lang.for(m.chatId));
      }
      {
        const d = await this.modelReading(m);
        if (d && d.intent === 'orderStatus') return reply(await this.orderStatus(m));
        if (d && d.intent === 'order' && (await this.understood(m, text, reply, lang.for(m.chatId), d)) === true) return true;
        if (d && m.isGroup && (d.intent === 'chat' || d.intent === 'greet')) {
          store.log(this.key, `model: "${text.slice(0, 50)}" is conversation in a group - answering, nobody asked`);
          return this.chatAnswer(m, text, reply, lang.for(m.chatId));
        }
      }
      // Saying the identical sentence twice in a row is the most bot-like
      // thing there is — it happened on the live line, "Noted. Passing this to
      // our team" back to back. If we already said it, the customer is asking
      // about THAT, so let the model answer instead of repeating.
      const lastUs = [...conversation.turns(m.chatId)].reverse().find((x) => x.role === 'us');
      if (lastUs && /passing this to our team|team ko bata diya/i.test(lastUs.text)) {
        store.log(this.key, 'already handed over; not repeating it');
        return false;
      }

      // Money, billing, returns, complaints — real business the bot must not
      // answer for itself. Before this it vanished; now a person sees it.
      const asked = await escalation.create(this, {
        chatId: m.chatId,
        customerPhone: m.from,
        item: text.slice(0, 80),
        qty: 1,
        kind: 'inquiry',
        reason: 'NOT_A_PART',
      });
      if (!asked) return false;
      store.log(this.key, `passed to a person: "${text.slice(0, 60)}"`);
      const t = lang.for(m.chatId);
      return reply(
        t(
          'Noted. Passing this to our team — they will get back to you.',
          'Note kar liya. Team ko bata diya hai, wo jald jawab denge.',
        ),
      );
    }

    store.log(this.key, `chat reply: "${out.text.slice(0, 60)}"`);
    return reply(out.text);
  }

  // Requested lines -> portal availability -> draft order.
  async processOrderLines(m, requestedLines, reply, heading, opts = {}) {
    const t = lang.for(m.chatId);
    // WHO is this? The portal resolves the WhatsApp number to a real buyer,
    // so availability and the eventual order are scoped to THEM — not to the
    // bot's own account. It also tells us up front whether this customer may
    // order at all.
    const who = await customers.resolve(m.from);
    // A salesman ordering for a customer: the customer they PICKED, never the
    // account the portal has on file for the salesman's own number. Company
    // SIMs are saved as customer phones (9217030422 is Agent Hajra AND M/S
    // Maan Motors), so the sender would otherwise decide the buyer.
    const forCustomer = salesOrder.activeCustomer(m.chatId);
    if (!forCustomer && who.found === false) {
      // Not on the portal yet. Answer availability anyway (a question costs
      // nothing), but a human has to create the customer before an order.
      store.log(this.key, `order attempt from unregistered number ${m.from}`);
    } else if (!forCustomer && who.found && !who.canAnalyze) {
      return reply(
        t(
          'Your account is not enabled for online ordering yet. Our team will contact you shortly.',
          'Aapke account pe abhi online ordering chalu nahi hai. Hamari team jald aapse sampark karegi.',
        ),
      );
    }
    const ctx = forCustomer || (who.found ? who : null);

    // NAMES, before anything else. "Brake pad - 5" carries no part number, so
    // `analyze` can say nothing about it and the line used to vanish. The
    // portal's catalogue search understands names, so use it: one match is the
    // part; several mean the customer has to say which, exactly as they would
    // at a counter ("kaunsi gaadi?"). We never pick for them — the wrong brake
    // pad for the wrong car is a return, not a sale.
    const choices = [];
    const lines = [];
    for (const l of requestedLines) {
      // A line that already CARRIES a part number is a part number, even
      // when the label printed the name beside it. 12 Sep: a photo read as
      // "11610M55RA1 MOUNTING COMP ENG RH" went to the name search, came
      // back with 33 matches, and the customer was asked "Kaunsi gaadi?"
      // about a part the portal could answer for on the spot (on order,
      // ETA 7 days). The name is kept for the reply, not for the search.
      const tokenIn = ai.partNumberIn(l.item);
      if (tokenIn && tokenIn.toUpperCase() !== String(l.item).trim().toUpperCase()) {
        store.log(this.key, `"${l.item}" -> part number ${tokenIn}`);
        lines.push({ ...l, item: tokenIn, requested: l.requested || l.item });
        continue;
      }
      if (!availability.isNameQuery(l.item)) {
        lines.push(l);
        continue;
      }
      const hits = await availability.byName(vehicle.narrow(m.chatId, l.item));
      if (hits.top.length === 1) {
        store.log(this.key, `"${l.item}" -> ${hits.top[0].partNo} by name (only match)`);
        lines.push({ ...l, item: hits.top[0].partNo, requested: l.item });
      } else if (hits.top.length > 1) {
        choices.push({ asked: l.item, total: hits.total, top: hits.top, qty: l.qty, ref: l.ref, key: l.key });
      } else {
        lines.push(l); // nothing in the catalogue — falls through to a human
      }
    }

    const resolved = await availability.resolve(lines, ctx);
    // What this message was about, so "iska rate" in the next one does not
    // get "Kis part ka?". Unidentified lines too: the part a person is being
    // asked about is exactly the one the customer asks about next.
    focus.remember(m.chatId, resolved);
    // Not for a salesman's own number: it would be filed under the customer's name.
    if (!forCustomer) store.upsertCustomer(m.from, (ctx && ctx.name) || '');

    // Log EVERY line, whatever the outcome — this is the sale-loss data.
    inquiries.recordMany(resolved, { customer: m.from, chatId: m.chatId });

    // A part the PORTAL DOES NOT KNOW goes to a human once, and the answer
    // is learned forever. A part it knows but has no stock of is NOT a human
    // question — the customer simply hears "on order, ETA = 7 days".
    // Digits only (2630002752) is a part number only if the portal knows it.
    // One it does not know is most likely a mistyped number or not a part at
    // all - the customer is told, and nobody is asked to identify it.
    const digitsOnly = (l) => /^\d{7,13}$/.test(String(l.partNo || l.requested || l.item || '').replace(/[\s-]/g, ''));
    // The sales desk - salesmen and admins - is never sent to the helper about
    // a part (founder, 13 Sep: "kuch bhi wrong ya escalate nhi"). A handwritten
    // list from the founder put 13 questions in front of the other admin. The
    // desk is told what the portal has instead, with the closest part numbers.
    const desk = salesOrder.isSalesPerson(m.from);
    const notFound = resolved.filter((l) => l.source === 'unidentified' && (digitsOnly(l) || desk));
    const unknown = resolved.filter((l) => l.source === 'unidentified' && !digitsOnly(l) && !desk);
    for (const u of unknown) {
      await escalation.create(this, {
        chatId: m.chatId,
        customerPhone: m.from,
        item: u.requested || u.item,
        // What the bot actually extracted, which is what the reader needs to
        // see. Passing only the raw line meant a photo of a label arrived as
        // "COIL ASSY IGNITION 33400 M 68K31" and the reader had to pick the
        // part number out of it themselves.
        partNo: u.partNo || null,
        reason: u.partNo ? 'NOT_IN_CATALOGUE' : 'NO_PART_NUMBER',
        qty: u.qty,
        kind: 'order',
      });
    }

    // The customer named a part that matches many. Ask ONE short question
    // drawn from what our catalogue actually distinguishes — "kaunsi gaadi?",
    // "front ya rear?" — the way the sales desk does it. Dumping 592 parts, or
    // asking them to look up a part number, is not an answer.
    let askText = '';
    if (choices.length) {
      const c = choices[0]; // one question at a time; the rest keep until this is settled
      const q = clarify.nextQuestion(c.top, [], m.chatId);
      // Asking the identical question twice tells the customer nobody is
      // reading. If we have nothing new to ask, show what we have instead.
      if (q && !clarify.alreadyAsked(m.chatId, q.text)) {
        clarify.ask(m.chatId, { base: c.asked, qty: c.qty, ref: c.ref, key: c.key }, q);
        askText = q.text;
      } else {
        askText = clarify.options(c.top, m.chatId);
      }
    }

    if (notFound.length) {
      const nums = notFound.map((l) => l.requested || l.partNo || l.item);
      let nf;
      if (desk) {
        const near = await this.nearParts(nums, { ctx, t, qtys: new Map(notFound.map((l) => [l.requested || l.partNo || l.item, l.qty])) });
        nf = nums
          .map((n) =>
            near.get(n)
              ? t(`${n} - not on the portal; closest: ${near.get(n).join(', ')}`, `${n} - portal pe nahi mila; milta-julta: ${near.get(n).join(', ')}`)
              : t(`${n} - not on the portal`, `${n} - portal pe nahi mila`),
          )
          .join('\n');
      } else {
        nf = t(
          `${nums.join(', ')} - not found on the portal. Please check the part number.`,
          `${nums.join(', ')} - portal pe nahi mila. Part number check kar lijiye.`,
        );
      }
      askText = askText ? nf + '\n\n' + askText : nf;
    }

    // A line the portal could not price or place is not something the customer
    // can buy, so it does not belong in their cart. Keeping "checking" lines
    // there is how one chat ended up holding fourteen items across three hours
    // of unrelated questions, every one of them unorderable.
    const usable = resolved.filter((l) => l.source !== 'unidentified' && l.source !== 'unknown');

    // Some numbers only ever ask. They are answered properly and then left
    // alone: no cart is built, nothing is remembered to confirm, and they are
    // never asked "confirm?" about an order they were never going to place.
    if (this.inquiryOnly(m.from, m.chatId) && usable.length) {
      const shown = usable.map((l) => availability.describe(l, m.chatId)).join(String.fromCharCode(10));
      store.log(this.key, `inquiry-only number ${m.from}: answered ${usable.length} line(s), no draft`);
      const NL = String.fromCharCode(10, 10);
      return reply(askText ? shown + NL + askText : shown);
    }
    const checking = resolved.filter((l) => l.source === 'unknown');
    if (!usable.length) {
      // Never leave the customer with silence. Before this, a message whose
      // every line went to a human got no reply at all — they sat watching an
      // empty chat while the helper was being asked behind the scenes.
      if (askText) return reply(askText);
      if (checking.length) {
        const names = checking.map((l) => availability.displayName(l));
        return reply(
          checking.length === 1
            ? t(
                `I am checking ${names[0]} and will get back to you shortly`,
                `${names[0]} check kar raha hoon, thodi der mein batata hoon`,
              )
            : t(
                `I am checking these ${names.length} items and will get back to you shortly\n${names.map((n) => '• ' + n).join('\n')}`,
                `Ye ${names.length} item check kar raha hoon, thodi der mein batata hoon\n${names.map((n) => '• ' + n).join('\n')}`,
              ),
        );
      }
      return reply(
        t(
          'I am checking this part and will confirm shortly',
          'Ye part check kar raha hoon, thodi der mein confirm karke batata hoon',
        ),
      );
    }

    // A part number with no quantity is a question, not an order for one.
    // Answer what we have, then ask how many — and keep those items out of the
    // cart until the customer says. Before this, "58330M85L00 -" became a
    // draft line and the reply carried "*YES* = confirm" under it.
    const needQty = usable.filter((l) => l.qtyMissing);
    if (needQty.length) {
      askQty.ask(
        m.chatId,
        needQty.map((l) => ({ item: l.requested || l.item, ref: l.ref, key: l.key, desc: l.desc })),
      );
      const priced = usable.filter((l) => !l.qtyMissing);
      const shown = needQty.map((l) => availability.describe(l, m.chatId)).join('\n');
      const question =
        needQty.length === 1
          ? t('How many do you need?', 'Kitni quantity chahiye?')
          : t('How many of each do you need?', 'Har item ki kitni quantity chahiye?');
      // Anything they DID give a quantity for still goes into the cart, and is
      // acknowledged above the question so the two do not read as one thing.
      if (priced.length) {
        const order2 = orders.getOrCreateDraft(m.chatId, m.from);
        if (ctx) order2.portalCustomer = ctx;
        orders.addLines(order2, priced, { replace: opts.fromPhoto === true });
        return reply(`${orders.ack(priced, order2, unknown)}\n\n${shown}\n\n${question}`);
      }
      return reply(`${shown}\n\n${question}`);
    }

    const order = orders.getOrCreateDraft(m.chatId, m.from);
    // If that call retired a stale cart, say so — once. Silently dropping the
    // items they sent two days ago is how a customer ends up thinking we lost
    // their order.
    const expiredNote = orders.takeExpiredNotice(m.chatId);
    if (ctx) order.portalCustomer = ctx; // carried into analyze + confirm
    orders.addLines(order, usable, { replace: opts.fromPhoto === true });
    // So a bare "Add 2pc" in the next message knows what it is talking about.
    askQty.remember(
      m.chatId,
      usable.map((l) => ({ item: l.requested || l.item, ref: l.ref, key: l.key, desc: l.desc })),
    );

    // A customer who sent a spreadsheet gets a spreadsheet back. Seventy lines
    // in a chat bubble cannot be read, and cannot be checked against the file
    // they sent — which is the only copy they have. Only these customers; a
    // typed two-line order still gets a typed answer.
    if (opts.fromSheet && this.transport.sendDocument) {
      try {
        const buf = sheet.buildReplySheet(order);
        const name = (m.fileName || 'order').replace(/\.[^.]+$/, '') + ' - availability.xlsx';
        await this.transport.sendDocument(
          m.chatId,
          buf,
          name,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          `${expiredNote ? expiredNote + '\n' : ''}${heading || ''}\n${order.lines.length} item — ${t('confirm?', 'confirm karun?')}`.trim(),
        );
        return true;
      } catch (e) {
        // Fall through to the text reply rather than leaving them with nothing.
        store.log(
          this.key,
          'reply sheet failed, sending text: ' + String((e && e.message) || e).slice(0, 120),
        );
      }
    }

    // Printing the WHOLE cart is right for a photo holding 27 parts — the
    // customer has no idea what the bot read off it. It is wrong for the way
    // this trade actually sends photos: one box, held up to the camera, thirty
    // times a morning. In the Kalra Motor replay 72 of 86 photos showed a
    // single part, and each reply came back averaging 7.2 lines — one of them
    // 32 — because the cart is reprinted every time. The customer sends one
    // box and gets back everything they have sent since breakfast.
    //
    // So the test is what THIS photo produced, not that it was a photo.
    const wholeCartIsTheNews = opts.fromPhoto && requestedLines.length >= 3;
    const body = wholeCartIsTheNews
      ? `${heading || `Order ${order.id}:`}\n${orders.summary(order)}\n\n${t('Confirm sir?', 'Confirm karun sir?')}`
      : (heading && !opts.fromPhoto ? heading + '\n' : '') + orders.ack(usable, order, unknown);
    const msg = expiredNote ? `${expiredNote}\n\n${body}` : body;
    // Ask for the confirmation once they stop adding parts, not on every line.
    // A photo of several parts already asks, under the list: that IS the ask.
    // A second one 40 s later repeated all 30 lines (13 Sep, live).
    if (wholeCartIsTheNews && !opts.quiet) {
      cancelConfirmNudge(m.chatId);
      order.confirmAskedAt = new Date().toISOString();
      store.save();
    } else {
      this.askToConfirmLater(m, t);
    }
    // The caller sends its own fuller message (salesOrder's check before a
    // punch), so this one would only say half of it first.
    if (opts.quiet) return true;
    const outText = askText ? `${msg}\n\n${askText}` : msg;
    // Same styling as reply(), reached directly: this runs in its own method,
    // outside the handleMessage closure that defines say().
    const styled = profiles.polish(m.from, outText);
    const sentId = await this.transport.sendToChat(m.chatId, styled);
    conversation.record(m.chatId, 'us', styled);
    rememberMsg(m.chatId, sentId, 'us', styled);
    // Only a NUMBERED reply can be answered with "Leave 9no. Item", and the
    // cart summary is the only numbered thing the bot sends.
    if (wholeCartIsTheNews) lists.remember(m.chatId, sentId, order.lines);
    return true;
  }

  // Availability question, no quantities yet.
  async answerInquiry(items, m) {
    const t = lang.for(m && m.chatId);
    const resolved = await availability.resolve(items.map((i) => ({ item: i, qty: 1 })));
    if (m) {
      inquiries.recordMany(resolved, { customer: m.from, chatId: m.chatId });
      focus.remember(m.chatId, resolved);
    }
    // A part number the portal does not have. This used to say "confirming the
    // exact part, will get back to you" - and nobody was asked, so nobody came
    // back (14 Sep, live: "71771M76T10 / 71721M74T00", then "?" and "......??"
    // got the same line again). Say what the portal has instead, with the
    // closest part numbers and their stock, as the photo reply already did.
    const unknown = resolved.filter((l) => l.source === 'unidentified' && (ai.partNumberIn(String(l.requested || l.item || '')) || /^\d{7,13}$/.test(String(l.item || ''))));
    let near = new Map();
    if (unknown.length) {
      const ctx = m ? route.onBehalfOf(m) : null;
      near = await this.nearParts(unknown.map((l) => l.requested || l.item), { ctx: ctx || null, t });
    }
    const shown = resolved
      .map((l) => {
        if (!unknown.includes(l)) return availability.describe(l, m && m.chatId);
        const asked = l.requested || l.item;
        const close = near.get(asked);
        return close
          ? t(`${asked} - not on the portal; closest: ${close.join(', ')}`, `${asked} - portal pe nahi mila; milta-julta: ${close.join(', ')}`)
          : t(`${asked} - not on the portal. Please check the part number.`, `${asked} - portal pe nahi mila. Part number check kar lijiye.`);
      })
      .join('\n');
    return t(
      `Stock check:\n${shown}\n\nSend items with quantities to place an order.`,
      `Stock check:\n${shown}\n\nQuantity ke saath item bhej dijiye, order bana deta hoon.`,
    );
  }

  // Live status. FOUNDER'S RULE: only TWO statuses ever reach a customer —
  // "packed and ready for dispatch" and "delivered". More than that and
  // "customer ko pagal ho jayega".
  // "So bn gya?", "order kahan hai", "Billed or not?" - answered from the
  // PORTAL, where the order really is (founder, 13 Sep: "order status check
  // krke ans dena"). Before this it read state.json, where nothing ever marks
  // an order packed or delivered, so every placed order was "being processed"
  // forever. The list still being built and a draft SO waiting for "Sahi
  // hai?" exist only here, so those are said first.
  async orderStatus(m) {
    const t = lang.for(m.chatId);
    const draft = orders.findDraft(m.chatId);
    if (draft && draft.lines.length) {
      return t(
        `Your order is not placed yet - it is waiting for your OK:\n${orders.summary(draft)}`,
        `Order abhi lagaya nahi hai - bas aapke OK ka wait hai:\n${orders.summary(draft)}`,
      );
    }
    const review = soReview.get(m.chatId);
    if (review && (review.orderIds || []).length) {
      return t(
        `Draft SO ${review.orderIds.join(', ')} is punched and waiting for your check - all good?`,
        `Draft SO ${review.orderIds.join(', ')} punch ho gaya hai, aapke check ka wait hai - sahi hai?`,
      );
    }
    // Whose orders: the customer a salesman is speaking for, else the sender's
    // own account on the portal.
    const lookup = require('../core/customerLookup');
    const onBehalf = route.onBehalfOf(m);
    let row = null;
    try {
      row = onBehalf && onBehalf.name ? { name: onBehalf.name } : await lookup.ownRow(m.from);
    } catch (e) {
      store.log(this.key, 'order status: account lookup failed: ' + String((e && e.message) || e).slice(0, 90));
    }
    if (row && row.name) {
      store.log(this.key, `order status for ${row.name} - from the portal`);
      return lookup.ordersFor(row, t);
    }
    return this.localOrderStatus(m, t);
  }

  // No portal account to ask: what this chat itself placed.
  localOrderStatus(m, t) {
    const mine = store
      .orders()
      .filter((o) => o.chatId === m.chatId || store.normPhone(o.customer) === m.from);
    const order = [...mine].reverse().find((o) => o.status !== 'cancelled');
    if (!order)
      return t(
        'No recent order found for you. Send the items you need and I will get it started!',
        'Aapka koi recent order nahi mila. Jo item chahiye bhej dijiye, main shuru kar deta hoon!',
      );
    if (order.status === 'draft') {
      return t(
        `Your order ${order.id} is ready - just waiting for your OK:\n${orders.summary(order)}`,
        `Aapka order ${order.id} tayyar hai - bas aapke OK ka wait hai:\n${orders.summary(order)}`,
      );
    }
    if (order.status === 'delivered') {
      return t(
        `📦 Your order *${order.soNumber}* has been delivered. Thank you!`,
        `📦 Aapka order *${order.soNumber}* deliver ho gaya hai. Dhanyavad!`,
      );
    }
    if (order.status === 'packed') {
      return t(
        `📦 Your order *${order.soNumber}* is packed and ready for dispatch.`,
        `📦 Aapka order *${order.soNumber}* pack ho gaya hai, dispatch ke liye taiyar hai.`,
      );
    }
    return t(
      `Your order *${order.soNumber}* is being processed. I will update you as soon as it is packed and ready for dispatch.`,
      `Aapka order *${order.soNumber}* process ho raha hai. Pack hote hi aapko update kar dunga.`,
    );
  }

  // related items not already in the order (map editable in the console)
  crossSellFor(lines) {
    const map = store.load().crossSell || {};
    const suggestions = [];
    const has = (name) =>
      lines.some((l) => availability.sameItem(l.item, name)) ||
      suggestions.some((s) => availability.sameItem(s, name));
    for (const l of lines) {
      for (const [item, related] of Object.entries(map)) {
        if (!availability.sameItem(item, l.item)) continue;
        for (const r of related) if (!has(r)) suggestions.push(r);
      }
    }
    return suggestions.slice(0, 4);
  }

  // Credit Note issued for a customer -> share it on WhatsApp
  async shareCreditNote({ customerPhone, cnNumber, amount, reason }) {
    const cn = {
      id: 'CN-' + Date.now(),
      cnNumber: cnNumber || 'CN-' + store.nextSeq('order'),
      customerPhone: store.normPhone(customerPhone),
      amount,
      reason: reason || '',
      createdAt: new Date().toISOString(),
      sharedAt: null,
    };
    store.load().creditNotes.push(cn);
    await this.transport.sendText(
      cn.customerPhone,
      `📄 *Credit Note ${cn.cnNumber}* of Rs.${amount} has been issued to you` +
        (reason ? ` (${reason})` : '') +
        `. It has been adjusted in your ledger.`,
    );
    cn.sharedAt = new Date().toISOString();
    store.save();
    store.log(this.key, `credit note ${cn.cnNumber} (Rs.${amount}) shared with ${cn.customerPhone}`);
    return cn;
  }

  // marketing broadcast to every known customer
  async broadcastOffer(text) {
    const targets = store.customers().map((c) => c.phone);
    for (const phone of targets) await this.transport.sendText(phone, text);
    store.load().offers.push({
      id: 'OFF-' + Date.now(),
      text,
      sentTo: targets.length,
      createdAt: new Date().toISOString(),
    });
    store.save();
    store.log(this.key, `offer broadcast sent to ${targets.length} customer(s)`);
    return targets.length;
  }
}

module.exports = CustomerBot;
