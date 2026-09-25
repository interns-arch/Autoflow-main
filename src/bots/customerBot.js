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
const agent = require('../agent');
const incoming = require('../agent/incoming');
const customerCreate = require('../core/customerCreate');
const portal = require('../integrations/dealerPortal');
const escalation = require('../core/escalation');
const parts = require('../core/parts');
const kb = require('../core/kb');
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
const voiceNote = require('../core/voiceNote');
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
const { handleMedia, readForAgent, NOT_MEDIA } = require('../pipeline/media');

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
// "You already have an account — is this one for someone else?", just asked.
//
// That question used to carry two buttons, and the button carried the meaning:
// a tap on "Nahi, rehne do" was the only "no" ever read as an answer to it,
// because a bare "nahi" typed into a chat is an answer to whatever ELSE is open
// — a cart, a closest-match part — and stealing it here would break those.
// There are no buttons any more; the customer just answers. So the question is
// remembered for a few minutes, and "haan" / "nahi" typed while it is the open
// question are read as the answer to it. Any other message means they have
// moved on, and the question is dropped.
const createAsk = require('../core/chatState').slot('createAsk');
const CREATE_ASK_MS = 10 * 60 * 1000;

// Every message of a chat by its WhatsApp id, for a while - the last 40 each
// way. WhatsApp tells us WHICH message a swipe-reply quotes, never what it
// said. 13 Sep, live: "Hai kya?" swiped onto the customer's own list of parts
// got "Samajh nahi paya", and a "3." swiped onto an old list became a
// quantity of the part discussed since.
const quotable = require('../core/chatState').slot('quotable');
// The priced short list a rate question was answered with, so "2" picks from
// it. chatId -> { base, parts: [{ partNo, name }], at }
const rateOptions = require('../core/chatState').slot('rateOptions');
const discountSetup = require('../core/discountSetup');
// The car a customer last NAMED in words, for the half hour after. "Swift
// Dzire bumper price", then "mera gaadi 2018 model hai, kaun sa rear bumper"
// - the second never says the car again, and searching "rear bumper" alone
// offered a Chevrolet Corsa (22 Sep, live). chatId -> { words, at }
const spokenCar = require('../core/chatState').slot('spokenCar');
// Part numbers the portal does not know, but has a CLOSE match for, being
// offered one at a time: "71761M67LA0 nahi mila - 71761M67LA05PK chahiye?"
// 22 Sep, live: eighteen such lines each went to a person and came back as
// eighteen "abhi confirm nahi ho paya" - while sixteen of them had an obvious
// match on the portal. chatId -> { at, queue, done, total, ctx }
const nearAsk = require('../core/chatState').slot('nearAsk');
const NEAR_MAX_MS = 3 * 60 * 60 * 1000;
// "5 pcs" is five pieces. "2 box" is two boxes, however many each holds - a
// box (pkt, packet, dabba) counts as one (founder, 22 Sep).
const BOX_RE = /\b(box|boxes|bx|pkt|pkts|packet|packets|pack|packs|dabba|dabbe|dibba|dibbe)\b/i;
function unitFor(text, asked) {
  const want = String(asked || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const line = String(text || '')
    .split(/\n/)
    .find((l) => l.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(want));
  return line && BOX_RE.test(line) ? 'box' : 'pcs';
}
// 71761M67LA05PK -> 5. A catalogue number ending in <n>PK is a pack of n.
function packOf(partNo) {
  const m = /(\d{1,2})PK$/i.exec(String(partNo || ''));
  return m ? Number(m[1]) : 0;
}
const NEAR_YES = /^(haan+|han+|ha+|hn|yes+|y|ok+|okay|ji|ji haan|sahi|sahi hai|theek|thik|theek hai|chalega|done|haan ji|yes please)\b.{0,15}$/i;
const NEAR_NO = /^(nahi+|nahin|nhi|nai|no+|n|na|mat|nahi chahiye|no thanks)\b.{0,15}$/i;
function withSpokenCar(chatId, item) {
  const words = String(item || '').replace(/[()[\]{},;:!?"]/g, ' ').split(/\s+/).filter(Boolean);
  const models = words.filter((w) => partish.isCarWord(w) && !partish.isMaker(w));
  if (models.length) {
    spokenCar.set(chatId, { words: models.join(' '), at: Date.now() });
    return item;
  }
  const had = spokenCar.get(chatId);
  if (!had || Date.now() - had.at > 30 * 60 * 1000) return item;
  return `${item} ${had.words}`;
}
// "Is part ka naam kya hai", "ye kaunsa part hai", "what is this part".
const PART_INFO_RE = /\b(naam|name)\b.*\b(kya|batao|bataiye|hai|is)\b|\bkaun\s*sa\s+part\b|\bkaunsa\s+part\b|\bwhat\s+(is\s+)?(this|the)\s+part\b/i;
// Words that make a short message its own question, never a pick.
const NOT_A_PICK_RE = /\b(price|rate|mrp|daam|kitne|kitna|kitni|naam|name|kya|kyu|kaise|kab|account|customer|order|cancel|status)\b|\?/i; // chatId -> { at, items: [{ id, dir, text }] }
// Is this inbound message one of OUR recent messages, sent back?
//
// Compared on the words, not the characters, because forwarding adds
// decoration and WhatsApp rewraps long lines. The test is containment in both
// directions: nearly all of our message is in theirs, and nearly all of
// theirs is in ours. A customer quoting one line of a sixty-item list fails
// the second half and is handled normally, which is what picking from a list
// looks like.
const ECHO_MIN_CHARS = 40; // shorter than this is a real reply, not a forward
const ECHO_OVERLAP = 0.85;

function echoWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function isOurOwnMessageBack(chatId, body) {
  const text = String(body || '').trim();
  if (text.length < ECHO_MIN_CHARS) return false;
  const theirs = echoWords(text);
  if (theirs.length < 8) return false;
  const theirSet = new Set(theirs);

  for (const turn of conversation.turns(chatId)) {
    if (turn.role !== 'us') continue;
    const ours = echoWords(turn.text);
    if (ours.length < 8) continue;
    const ourSet = new Set(ours);
    let shared = 0;
    for (const w of ourSet) if (theirSet.has(w)) shared++;
    // nearly all of ours inside theirs, AND nearly all of theirs inside ours
    const coversOurs = shared / ourSet.size;
    let back = 0;
    for (const w of theirSet) if (ourSet.has(w)) back++;
    const coversTheirs = back / theirSet.size;
    if (coversOurs >= ECHO_OVERLAP && coversTheirs >= ECHO_OVERLAP) return true;
  }
  return false;
}

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

  // WHAT THE HISTORY SUGGESTS THIS IS ABOUT — and nothing more.
  //
  // Years of exported chats tell us what a dealer calls a part ("barek oil
  // cap", "wiper bottel") and which part number our people gave them. They do
  // NOT tell us what is in stock today: an example saying "4 pcs hai" is from
  // June and its numbers are stripped before storage (core/history/extract,
  // responsePattern).
  //
  // So history is allowed to do exactly one thing here: name the part. The
  // portal then answers for it, through the same availability path as every
  // other line, and the customer hears today's answer.
  //
  // -> true when the customer has been answered, false to carry on to a person
  async historyPart(m, text, reply) {
    const history = require('../core/history');
    if (!history.enabled()) return null;
    let matches = [];
    try {
      matches = await history.similar(text, {
        customerId: store.normPhone(m.from),
        agentId: this.inquiryOnly(store.normPhone(m.from), m.chatId) ? store.normPhone(m.from) : null,
      });
    } catch (err) {
      store.log(this.key, 'history lookup failed: ' + String((err && err.message) || err).slice(0, 80));
      return null;
    }
    const withPart = matches.find((x) => x.partNo);
    if (!withPart) return null;

    const availability = require('../core/availability');
    let line = null;
    try {
      const resolved = await availability.resolve([{ item: withPart.partNo, qty: 1 }]);
      line = resolved && resolved[0];
    } catch (err) {
      store.log(this.key, 'history part could not be priced: ' + String((err && err.message) || err).slice(0, 80));
      return null;
    }
    // The portal does not recognise it either. History was a lead, not a fact,
    // and a lead that does not check out goes to a person like anything else.
    if (!line || line.source === 'unknown' || line.source === 'unidentified') return null;

    store.log(
      this.key,
      `history example #${withPart.id} (${withPart.similarity.toFixed(2)}) suggested ${withPart.partNo} - portal answered`,
    );
    // The phrase is now worth keeping in the bot's own store, so the next
    // customer does not need the history lookup at all.
    knowledge.learnAlias(text.slice(0, 80), line.partNo || withPart.partNo, 'historical_chat');
    await reply(availability.describe(line, m.chatId));
    return true;
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

    // They wrote, so their 24h window is open: an approval sent to them in
    // the next day goes as plain text, with no template in front of it.
    if (!m.isGroup) escalation.noteInbound(m.from);

    // Whatever recording the last message left behind is finished with. A
    // voice note's clip is held only for as long as its own words are being
    // handled (core/voiceNote), so a question raised two messages later never
    // arrives with somebody else's audio underneath it.
    voiceNote.clear(m.chatId);

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

    // OUR OWN WORDS, SENT BACK TO US.
    //
    // 23 Sep: the bot listed sixty wiper blades, the customer forwarded that
    // list straight back, and the bot read its own message as an order and
    // put two of them in the cart. Whatever they meant by forwarding it, they
    // did not type it, and it is not an instruction.
    //
    // Only a WHOLE message of ours counts. Quoting one line to choose it —
    // "1. CTWBSI26P-24INCH" — is how a customer picks from a list, and that
    // has to keep working.
    if (isOurOwnMessageBack(m.chatId, m.body)) {
      store.log(this.key, `ignored an echo of our own message from ${m.from}`);
      return true;
    }

    // Both sides of the thread are remembered, so "pakka?" and "This also"
    // mean something on the next message instead of arriving out of nowhere.
    // Said as what it was — "(photo) 3pise", "(reacted 👍)", "(edited a message)
    // 25 pcs" — not as bare words, so a caption is never mistaken for a typed
    // message later on. `receivedAt` marks where this message sits in that
    // record, so the agent's catch-up can leave it out (it is being answered).
    m.receivedAt = Date.now();
    conversation.record(m.chatId, 'customer', incoming.forLog(m));
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

    // CUSTOMERS TALK TO THE AGENT — AND ONLY TO THE AGENT.
    //
    // Every word a customer reads is written by the model, from what its tools
    // return. There is no template path for them any more: a photo, a voice
    // note, an order list, a number plate, an account form, a greeting — all
    // of it reaches the agent as facts, and the agent writes the reply. The
    // agent's words go out as it wrote them, without the style post-processing
    // (profiles.polish) the templates were run through.
    //
    // EVERYTHING BELOW THIS LINE IS STAFF TOOLING: admins, the helper, the
    // Sales Heads approving accounts, salesmen punching orders for a customer,
    // the sales team asking on a customer's behalf. Those are commands with
    // powers — ledgers, approvals, any customer's orders — that the customer's
    // agent must never have, and they stay exactly as they were.
    if (!this.isOperator(m)) {
      const asWritten = async (text) => {
        const sentId = await this.transport.sendToChat(m.chatId, text);
        conversation.record(m.chatId, 'us', text);
        rememberMsg(m.chatId, sentId, 'us', text);
        return true;
      };
      // A CUSTOMER SETTING UP THEIR OWN DISCOUNT. Anyone may ask for one, not
      // only an agent; the rule goes to the Sales Head ("OK DSC-…") before the
      // portal is touched, whoever asked. Its answers — "12", "3 mahine" — are
      // the setup's, so an open one is checked before the agent sees them. A
      // question asked in the middle (answerDiscount -> null) goes on to it.
      const said = String(m.body || '').trim();
      if (said && !['image', 'video', 'document', 'audio', 'ptt', 'sticker'].includes(m.mediaType)) {
        if (discountSetup.pending(m.chatId)) {
          const done = await this.answerDiscount(m, said, asWritten, t);
          if (done) return done;
        } else if (discountSetup.wantsSetup(said)) {
          store.log(this.key, `${m.from} asked to set up a discount: "${said.slice(0, 60)}"`);
          return this.startDiscountChange(m, said, asWritten, t);
        }
      }
      return this.answerCustomer(m, asWritten, t);
    }

    // A CUSTOMER FORM IN PROGRESS owns every message until it is finished,
    // and that has to be decided BEFORE anything else reads them. Two of its
    // answers are not text at all: the shop photograph would otherwise be
    // read as a photo of a part and sent to a person, and a dropped pin
    // carries no text so it would fall out of the handler entirely.
    if (customerCreate.pending(m.chatId)) {
      const said = String((m.body || '')).trim();
      const step = await customerCreate.answer(m.chatId, m, said, t);
      if (step && step.done) return this.finishNewCustomer(m, step.form, reply, t);
      // The GSTIN would not verify. The customer is off the form; the Sales
      // Heads get to decide whether this account is opened by hand.
      if (step && step.review) return this.reviewNewCustomer(m, step, reply, t);
      if (step) return reply(step.reply);
    }

    // THE AGENT SETTING UP THE NEW ACCOUNT'S DISCOUNT. Checked before media
    // and the order parser: "12" here is a percentage, not a quantity.
    if (discountSetup.pending(m.chatId)) {
      const said = String(m.body || '').trim();
      const done = await this.answerDiscount(m, said, reply, t);
      if (done) return done;
    }

    // Voice, PDF, spreadsheet, photo (pipeline/media). A message that is none
    // of those comes back as NOT_MEDIA and carries on below as text.
    const media = await handleMedia(this, m, reply, t);
    if (media !== NOT_MEDIA) return media;

    // "26300_02752 40 pcs", "16510m68k10.48 pcs" - straightened out once, here,
    // so every reader below (DM, group, sales desk) sees the same order line.
    if (m.body) m.body = ai.normalizeOrderText(m.body);
    const text = (m.body || '').trim();

    if (!text) return false;

    // AN APPROVER SAYING YES. "OK WA-ABC123" from a Sales Head is the only
    // thing that creates an account — checked before everything else, since
    // a request id is not a part number and must never be looked up as one.
    {
      const decision = customerCreate.readDecision(text);
      if (decision && customerCreate.isApprover(m.from)) {
        if (/^DSC-/.test(decision.requestId)) return this.decideDiscount(m, decision, reply, t);
        return this.decideNewCustomer(m, decision, reply, t);
      }
      if (decision) {
        store.log(this.key, `${m.from} tried to approve ${decision.requestId} but is not an approver`);
        return reply(t('Only the Sales Head can approve that.', 'Ye sirf Sales Head approve kar sakte hain.'));
      }
      // Anything else an approver says ABOUT a request - swiped onto its
      // summary, or naming its id. 22 Sep, live: "Ye toh already created
      // hai" swiped onto the summary was answered "koi order pending nahi
      // hai", and the customer was never told.
      if (customerCreate.isApprover(m.from)) {
        const rid = (m.contextId && customerCreate.requestForMessage(m.contextId)) || customerCreate.requestIdIn(text);
        if (rid) return this.noteOnNewCustomer(m, rid, text, reply, t);
      }
    }

    // The "someone else's account?" question, if it is the one open.
    const askedCreate = createAsk.get(m.chatId);
    let createAnswer = null;
    if (askedCreate) {
      if (Date.now() - (askedCreate.at || 0) > CREATE_ASK_MS) createAsk.delete(m.chatId);
      else if (customerCreate.wantsSomeoneElse(text) || NEAR_YES.test(text)) createAnswer = 'yes';
      else if (customerCreate.declinedCreate(text) || NEAR_NO.test(text)) createAnswer = 'no';
      // Anything else: they have moved on. A "haan" ten messages later is
      // about something else entirely.
      else createAsk.delete(m.chatId);
    }


    // "CREATE CUSTOMER". Asked for in words, rather than waiting for an
    // unregistered order to trigger it. 21 Sep, live: "Create coustomer"
    // was searched in the catalogue and answered with sixty headlight
    // restorers, because nothing above this line knew what it meant.
    // The other button on "you already have an account". Only meaningful
    // when we just asked - "nahi" on its own is an answer to whatever else
    // is open, and stealing it here would break every other question.
    if ((m.buttonId && customerCreate.declinedCreate(text)) || createAnswer === 'no') {
      createAsk.delete(m.chatId);
      return reply(t('No problem. Send me a part number whenever you need one.', 'Theek hai. Jab bhi koi part chahiye, bata dijiye.'));
    }

    if (createAnswer === 'yes' || customerCreate.wantsToStart(text) || customerCreate.wantsSomeoneElse(text)) {
      createAsk.delete(m.chatId);
      // A SALES AGENT is never told they already have an account: opening
      // one for a customer standing at their counter is their job, and the
      // account goes on the portal under their name.
      const agent = customerCreate.agentName(m.from);
      const forElse = createAnswer === 'yes' || customerCreate.wantsSomeoneElse(text);

      if (!agent && !forElse) {
        const already = await customers.resolve(m.from).catch(() => ({ found: null }));
        // The portal being down is NOT "no account". 22 Sep, live: the
        // portal answered HTTP 500 (its connection pool was exhausted) and
        // every number looked unregistered. Opening a form here would ask a
        // customer who ALREADY has an account for twelve answers, and the
        // creation at the end would fail anyway.
        if (already && already.found === null) {
          store.log(this.key, `${m.from} asked to open an account but the portal is not answering`);
          return reply(
            t(
              "Our system isn't responding right now — give me a few minutes and ask again.",
              'System abhi respond nahi kar raha — thodi der baad phir bolieye, turant bana denge.',
            ),
          );
        }
        if (already && already.found === true) {
          // They are already a customer, so this is almost always an
          // account for somebody else — a friend's garage, a second shop.
          // Saying only "you already have one" ends a conversation that
          // was about to open an account.
          store.log(this.key, `${m.from} asked to create an account but already has one (${already.name})`);
          // Asked as a question and answered in words: "haan" or "nahi" in the
          // next few minutes is read as the answer (see createAsk above).
          createAsk.set(m.chatId, { at: Date.now() });
          return reply(
            t(
              `You already have an account with us${already.name ? ' — ' + already.name : ''}. Is this one for someone else?`,
              `Aapka account pehle se hai${already.name ? ' — ' + already.name : ''}. Kisi aur ke liye banana hai?`,
            ),
          );
        }
      }
      store.log(this.key, `${m.from} asked to open an account${forElse ? ' for someone else' : ''}${agent ? ' (agent: ' + agent + ')' : ''}`);
      return reply(customerCreate.start(m.chatId, m.from, t, { forSomeoneElse: forElse }));
    }

    // AN EXISTING CUSTOMER'S DISCOUNT, CHANGED. Asked for in words; the
    // change goes to the Sales Head before the portal is touched.
    if (discountSetup.wantsSetup(text) && !discountSetup.pending(m.chatId)) {
      store.log(this.key, `${m.from} asked to change a discount: "${text.slice(0, 60)}"`);
      return this.startDiscountChange(m, text, reply, t);
    }

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
      // Staff by their own name. Prateek sir's number is also on a customer
      // account (Fixit Auto), and greeting a Sales Head as "Fixit Auto Private
      // Limited" is wrong. Only a customer is greeted by their account's name.
      const staffName = (customerCreate.isApprover(m.from) && customerCreate.approverName(m.from)) || customerCreate.agentName(m.from);
      if (staffName) {
        greetingReply += ' ' + staffName;
      } else if (!this.isOperator(m)) {
        const cHit = store.customers().find((c) => store.normPhone(c.phone) === store.normPhone(m.from));
        if (cHit && cHit.name) greetingReply += ' ' + cHit.name;
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
          customerMessageId: m.id || null,
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

    // "Is part ka naam kya hai" - swiped onto a reply, or about the part just
    // discussed. 22 Sep, live: it was glued onto an old "Kaunsi gaadi?" and
    // asked the same question back. The answer is the part: its name, price
    // and stock.
    if (PART_INFO_RE.test(text)) {
      const q = m.contextId ? quotedMsg(m.chatId, m.contextId) : null;
      const from = q ? partsIn(q.text) : focus.names(m.chatId);
      const nos = [...new Set(from.map((p) => ai.partNumberIn(p) || p).filter((p) => partish.isPartNumber(p)))].slice(0, 3);
      if (nos.length) {
        clarify.clear(m.chatId);
        store.log(this.key, `"${text}" -> about ${nos.join(', ')}`);
        return this.quoteForOrder(m, nos.map((p) => ({ partNo: p })), reply, t);
      }
    }
    // A question about "the part" while our priced list is the last thing
    // on screen: the list IS the answer - names and prices are in it.
    {
      const offered = rateOptions.get(m.chatId);
      if (offered && Date.now() - offered.at < 30 * 60 * 1000 && (PART_INFO_RE.test(text) || /^(price|rate|mrp|daam)\b.{0,20}$|^(kitne|kitna|kitni) ka\b/i.test(text))) {
        return reply(
          t(
            `Each part's price is in the list above - send its number (1-${offered.parts.length}) and I will give you the details.`,
            `Upar list mein har part ka naam aur price hai - number bhejiye (1-${offered.parts.length}), poori detail de deta hoon.`,
          ),
        );
      }
    }
    // "Is part ka naam kya hai" with no part anywhere is a question, never a
    // part name to search the catalogue for.
    if (PART_INFO_RE.test(text)) {
      return reply(
        t(
          'Which part? Send the part number, or swipe-reply on the message about it.',
          'Kaunsa part? Part number bhejiye, ya us message pe swipe karke puchiye.',
        ),
      );
    }

    // HAAN / NAHI to a closest-match part we are offering, one by one.
    {
      const near = nearAsk.get(m.chatId);
      if (near && Date.now() - near.at > NEAR_MAX_MS) nearAsk.delete(m.chatId);
      else if (near && near.queue.length) {
        const yes = m.buttonId === 'NEAR_YES' || (!m.buttonId && NEAR_YES.test(text));
        const no = m.buttonId === 'NEAR_NO' || (!m.buttonId && NEAR_NO.test(text));
        if (yes || no) return this.answerNear(m, yes, reply, t);
      }
    }

    // A pick from the priced list a rate question was answered with. Before
    // the quantity readers: the "2" is which part, not how many.
    {
      const offered = rateOptions.get(m.chatId);
      if (offered && Date.now() - offered.at > 30 * 60 * 1000) rateOptions.delete(m.chatId);
      else if (offered) {
        const n = /^(\d{1,3})\s*(?:[.)]|inch|inches|"|no|number)?\s*$/i.exec(text);
        const byNo = offered.parts.find((o) => rates.norm(o.partNo) === rates.norm(text));
        // A range is picked by its size ("16"), a list by its line ("2").
        const byKey = n ? offered.parts.find((o) => o.key && o.key === String(Number(n[1]))) : null;
        const pick = byNo || byKey || (n ? offered.parts[Number(n[1]) - 1] : null);
        if (pick) {
          rateOptions.delete(m.chatId);
          clarify.clear(m.chatId);
          store.log(this.key, `rate: picked ${pick.partNo} from the priced list`);
          return this.quoteForOrder(m, [{ partNo: pick.partNo, name: pick.name, requested: offered.base, price: pick.price }], reply, t);
        }
      }
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
    // Not an answer to "Kaunsi gaadi?": a question of its own ("price kitna
    // hai", "naam kya hai") or something else entirely ("account bna do").
    // 22 Sep, live: all three were added to "rear bumper" and searched.
    if (clarify.get(m.chatId) && (NOT_A_PICK_RE.test(text) || customerCreate.wantsToStart(text))) {
      store.log(this.key, `"${text}" is not an answer to the open question - moving on`);
      clarify.clear(m.chatId);
    }
    if (!oldSwipe && clarify.isAnswerTo(m.chatId, text)) {
      const p = clarify.refine(m.chatId, text);
      const hits = await availability.byName(p.base);
      if (hits.top.length === 1) {
        clarify.clear(m.chatId);
        store.log(this.key, `"${p.base}" -> ${hits.top[0].partNo} after clarifying`);
        // They asked what it costs. Answer that, and ask how many - putting
        // one in the cart would be an order nobody placed.
        if (p.rate) {
          return this.quoteForOrder(m, [{ partNo: hits.top[0].partNo, name: hits.top[0].name, requested: p.base }], reply, t);
        }
        return this.processOrderLines(
          m,
          [{ item: hits.top[0].partNo, qty: p.qty, ref: p.ref, key: p.key }],
          reply,
        );
      }
      if (hits.top.length > 1 && p.rate) {
        return this.offerPriced(m, p, hits.top, hits.total || hits.top.length, reply, t);
      }
      if (hits.top.length > 1) {
        const q = clarify.nextQuestion(hits.top, p.asked, m.chatId);
        if (q) {
          clarify.ask(m.chatId, p, q);
          return reply(q.text);
        }
        return reply(clarify.offer(m.chatId, p, hits.top));
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
        //
        // 22 Sep, live: a voice note, "Maruti Suzuki Swift Dzire ka front
        // bumper kitne ka hai?", transcribed word for word. The parser named
        // the part, so the catalogue was never asked; the rate lookup knows
        // only part numbers, and the customer was told "our team will send
        // it" for a part the portal had, with its price. A NAMED part is
        // looked up by name too, and a person is asked only if the catalogue
        // cannot say which part it is.
        const phrase = named.length ? '' : focus.stripPointers(text.replace(RATE_STRIP, ' '));
        const lookups = named.length ? named : phrase.length >= 3 ? [phrase] : [];
        const found = [];
        let unresolved = 0;
        for (const item of lookups) {
          const no = ai.partNumberIn(item);
          if (no || !availability.isNameQuery(item)) {
            if (no) found.push({ partNo: no });
            else unresolved++;
            continue;
          }
          let top = [];
          let hits = null;
          try {
            hits = await availability.byName(vehicle.narrow(m.chatId, withSpokenCar(m.chatId, item)));
            top = (hits && hits.top) || [];
          } catch (e) {
            store.log(this.key, 'rate: catalogue lookup failed for "' + item + '": ' + String((e && e.message) || e).slice(0, 80));
          }
          if (top.length === 1 && availability.matchTrustworthy(item, top[0])) {
            store.log(this.key, `rate: "${item}" -> ${top[0].partNo} by name (only match)`);
        // Keep what it cost us to find. The next customer asking this way
        // is a vector lookup, not another search (core/parts.remember).
        parts.remember({ partNo: top[0].partNo, name: top[0].name }).catch(() => {});
            found.push({ partNo: top[0].partNo, name: top[0].name, requested: item });
          } else if (top.length >= 1) {
            // Front or rear, which car: ask the way the counter would, and
            // remember it was a price they wanted.
            store.log(this.key, `rate: "${item}" -> ${top.length} catalogue matches; showing them priced`);
            return this.offerPriced(m, { base: item, qty: 1, rate: true }, top, (hits && hits.total) || top.length, reply, t);
          } else {
            unresolved++;
          }
        }
        if (found.length && !unresolved && found.some((f) => f.name)) {
          return this.quoteForOrder(m, found, reply, t);
        }
        const known = named.length
          ? named
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

        // The portal could not price it. Before a person is asked, check
        // whether one has already answered this — payment terms, a standing
        // discount, "what is the rate for X" answered last week. A rate
        // question was the one give-up path that never consulted what the bot
        // had been taught.
        if (kb.enabled()) {
          // Not `known` — that is the list of parts in this scope.
          const taught = await kb.answer(text, {
            chatId: m.chatId,
            customerId: store.normPhone(m.from),
            agentId: this.inquiryOnly(store.normPhone(m.from), m.chatId) ? store.normPhone(m.from) : null,
          });
          if (taught.answered) {
            store.log(this.key, `rate question answered from knowledge #${taught.entry.id}`);
            return reply(taught.text);
          }
        }

        // Rates come from a person who knows the account. Send it to the
        // same helper everything else goes to, with the parts attached.
        const raised = await escalation.create(this, {
          chatId: m.chatId,
          customerPhone: m.from,
          customerMessageId: m.id || null,
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
            return reply(clarify.offer(m.chatId, { base: phrase, qty: 1 }, hits.top));
          }

          // Nothing in the catalogue. Only a phrase that still looks like a
          // part request is worth a human's time.
          if (availability.looksLikePartNumber(phrase)) {
            await escalation.create(this, {
              chatId: m.chatId,
              customerPhone: m.from,
              customerMessageId: m.id || null,
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
          // Waiting for someone to ring them back is how an order dies. The
          // form the sales desk fills in on paper is asked here instead, one
          // question at a time — and it still ends at the Sales Head, who is
          // the only one who may set credit and discount.
          store.log(this.key, `unregistered ${m.from} confirmed an order — starting the customer form`);
          return reply(
            t(
              'Your account is not registered yet, so I cannot place the order — but I can open it now.\n\n',
              'Aapka account abhi register nahi hai, isliye order punch nahi kar paunga — par abhi bana dete hain.\n\n',
            ) + customerCreate.start(m.chatId, m.from, t),
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

  // The one catalogue part each written number most likely means: the same
  // number with a pack suffix ("71761M67LA0" -> "71761M67LA05PK"), or the
  // number with its last character dropped. Only a part that BEGINS with what
  // was written counts - never a guess from a similar-looking one.
  async closestMatches(asked) {
    const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const out = new Map();
    for (const a of asked.slice(0, 30)) {
      const want = norm(a);
      if (want.length < 6) continue;
      try {
        const rows = ((await portal.searchByName(want)) || {}).top || [];
        const hits = rows.filter((r) => r.partNo && (norm(r.partNo).startsWith(want) || want.startsWith(norm(r.partNo))));
        // In stock first: searchByName already sorts that way.
        if (hits.length) out.set(a, { partNo: hits[0].partNo, name: hits[0].name, available: hits[0].available });
      } catch (e) {
        store.log(this.key, 'closest match search failed for ' + a + ': ' + String((e && e.message) || e).slice(0, 80));
      }
    }
    return out;
  }

  // Offer the next closest match, with Haan / Nahi buttons where the line
  // has them. `lead` goes above it: what was found, or the answer to the last.
  async askNear(m, lead, reply, t) {
    const st = nearAsk.get(m.chatId);
    if (!st || !st.queue.length) return false;
    const q = st.queue[0];
    let price = '';
    try {
      const got = await rates.prices([q.partNo], { ctx: st.ctx });
      const p = got.get(rates.norm(q.partNo));
      if (p) price = rates.priceText(p, t);
    } catch (e) {
      /* the question still stands without a price */
    }
    const stock = Number(q.available) > 0 ? t('in stock', 'stock hai') : t('on order', 'order pe');
    const n = st.done + 1;
    const pack = packOf(q.partNo);
    const packNote = pack ? t(` (pack of ${pack})`, ` (${pack} ka pack)`) : '';
    const unit = q.unit === 'box' ? 'box' : 'pcs';
    const body =
      `(${n}/${st.total}) ${t(`${q.asked} did not match exactly. Closest part:`, `${q.asked} exact nahi mila. Milta-julta part:`)}\n` +
      `*${q.partNo}*${packNote}${q.name ? ' — ' + q.name : ''}\n` +
      `${price ? price + ' · ' : ''}${stock}\n\n` +
      t(`${q.qty} ${unit} of this one?`, `Yahi chahiye, ${q.qty} ${unit}?`);
    // It already ends in the question ("Yahi chahiye, 5 pcs?"), and a person
    // answers a question: no "Reply Yes or No" under it, and no buttons.
    return reply(lead ? lead + '\n\n' + body : body);
  }

  async answerNear(m, yes, reply, t) {
    const st = nearAsk.get(m.chatId);
    const q = st.queue.shift();
    st.done += 1;
    st.at = Date.now();
    let lead;
    if (yes) {
      const [line] = await availability.resolve([{ item: q.partNo, qty: q.qty, ref: q.ref, key: q.key }], st.ctx).catch(() => []);
      if (line && line.source !== 'unidentified' && line.source !== 'unknown') {
        const order = orders.getOrCreateDraft(m.chatId, m.from);
        if (st.ctx) order.portalCustomer = st.ctx;
        const unit = q.unit === 'box' ? 'box' : 'pcs';
        orders.addLines(order, [{ ...line, requested: q.asked, unit }]);
        lead = t(`Added ${q.partNo} x${q.qty} ${unit}.`, `${q.partNo} x${q.qty} ${unit} order mein daal diya.`);
      } else {
        lead = t(`Sorry, ${q.partNo} could not be added right now.`, `Sorry, ${q.partNo} abhi add nahi ho paya.`);
      }
    } else {
      lead = t(`Sorry, ${q.asked} is not available.`, `Sorry, ${q.asked} available nahi hai.`);
    }
    store.log(this.key, `closest match ${q.asked} -> ${q.partNo}: ${yes ? 'yes' : 'no'}`);
    cancelConfirmNudge(m.chatId);
    if (st.queue.length) {
      nearAsk.set(m.chatId, st);
      return this.askNear(m, lead, reply, t);
    }
    nearAsk.delete(m.chatId);
    return this.finishNear(m, st, lead, reply, t);
  }

  // Every question answered: the whole order, priced, with pieces, and the
  // one question that is left.
  async finishNear(m, st, lead, reply, t) {
    const order = orders.findDraft(m.chatId);
    if (!order || !order.lines.length) {
      return reply((lead ? lead + '\n\n' : '') + t('Nothing is in the order yet.', 'Order mein abhi koi part nahi hai.'));
    }
    const lines = order.lines.map((l) => ({ partNo: l.partNo || l.item, qty: l.qty, unit: l.unit, available: l.available, source: l.source }));
    const list = await rates.priceList(lines, { ctx: st.ctx }, t).catch(() => '');
    const text =
      (lead ? lead + '\n\n' : '') +
      t(`Your order (${order.lines.length} items):`, `Aapka order (${order.lines.length} item):`) +
      '\n' +
      (list || orders.summary(order)) +
      '\n\n' +
      t('Shall I place this order?', 'Ye order confirm karun sir?');
    order.confirmAskedAt = new Date().toISOString();
    store.save();
    return reply(text);
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
  // The form is full. It goes to the Sales Head — with the shop photo,
  // because that is the half of it a person actually checks — and nothing
  // is created until they answer.
  async finishNewCustomer(m, form, reply, t) {
    const approvers = Object.keys(config.creation.approvers);
    if (!approvers.length) {
      // Deliberate: without someone to say yes, the credit terms on this
      // account would be nobody's decision.
      store.log(this.key, `form ${form.answers.requestId} complete but NO approver is configured`);
      customerCreate.cancel(m.chatId);
      return reply(
        t(
          'Thank you — I have everything. Our team will set the account up.',
          'Shukriya — sab mil gaya. Hamari team account bana degi.',
        ),
      );
    }

    customerCreate.park(form);
    const text = customerCreate.summary(form, t);
    for (const phone of approvers) {
      try {
        // Outside the 24h window a plain text is silently dropped (escalation.ensureWindow).
        await escalation.ensureWindow(this.transport, phone, 'Account approval coming — details follow');
        const sentId =
          form._photo && this.transport.sendImage
            ? await this.transport.sendImage(phone, Buffer.from(form._photo, 'base64'), form.answers.shopPhoto.mime, text)
            : await this.transport.sendText(phone, text);
        customerCreate.noteSummary(sentId, form.answers.requestId);
      } catch (e) {
        store.log(this.key, `could not reach approver ${phone}: ${String((e && e.message) || e).slice(0, 90)}`);
      }
    }
    store.log(this.key, `${form.answers.requestId} sent to ${approvers.length} approver(s)`);
    await reply(
      t(
        `Thank you — sent for approval (${form.answers.requestId}). You will hear as soon as it is open.`,
        `Shukriya — approval ke liye bhej diya (${form.answers.requestId}). Account khulte hi bata dunga.`,
      ),
    );
    // The discount is set up now, while the approval runs — by whoever filled
    // the form, an agent or the customer registering themselves. Every rule
    // still goes to the Sales Head before the portal is touched.
    return this.startDiscountSetup(m, form, reply, t);
  }


  // A GSTIN that would not verify. Nothing is created and the customer is
  // not left arguing with a form — the Sales Heads are told what was tried
  // and decide whether this firm is opened by hand.
  async reviewNewCustomer(m, step, reply, t) {
    const form = step.form;
    const approvers = Object.keys(config.creation.approvers);
    if (!approvers.length) {
      store.log(this.key, `${form.answers.requestId} could not verify GST and NO approver is configured`);
      return reply(step.reply);
    }
    customerCreate.park(form);
    const text = customerCreate.summary(form, t);
    for (const phone of approvers) {
      try {
        // Outside the 24h window a plain text is silently dropped (escalation.ensureWindow).
        await escalation.ensureWindow(this.transport, phone, 'Account approval coming — details follow');
        customerCreate.noteSummary(await this.transport.sendText(phone, text), form.answers.requestId);
      } catch (e) {
        store.log(this.key, `could not reach approver ${phone}: ${String((e && e.message) || e).slice(0, 90)}`);
      }
    }
    store.log(this.key, `${form.answers.requestId} (GST review) sent to ${approvers.length} approver(s)`);
    return reply(step.reply);
  }

  // "OK WA-ABC123" from the Sales Head. The only path that creates an
  // account on the portal.
  async decideNewCustomer(m, decision, reply, t) {
    const req = customerCreate.parked(decision.requestId);
    if (!req) {
      return reply(t(`${decision.requestId} not found — it may already be done.`, `${decision.requestId} nahi mila — shayad pehle hi ho chuka hai.`));
    }
    const who = customerCreate.approverName(m.from);

    // A GST REVIEW, not a finished form. There is nothing to create yet:
    // yes means "let them fill the rest in without a verified GSTIN", and
    // the form reopens in the customer's chat where it stopped.
    if (req.answers.kind === 'gst-review') {
      customerCreate.unpark(decision.requestId);
      if (!decision.yes) {
        store.log(this.key, decision.requestId + ' (GST review) rejected by ' + who);
        await this.transport.sendText(
          req.answers.phone,
          t(
            'Our team needs to check a few things before opening the account — someone will call you.',
            'Account kholne se pehle team ko kuch check karna hai — aapko call aayega.',
          ),
        );
        return reply(t('Rejected. The customer was told we will call.', 'Reject kar diya. Customer ko bata diya ki call karenge.'));
      }
      store.log(this.key, decision.requestId + ' (GST review) waived by ' + who);
      const first = customerCreate.resumeWithoutGst(req, t);
      await this.transport.sendText(
        req.answers.phone,
        t('Thank you for waiting. Let us carry on — ', 'Intezaar ke liye shukriya. Aage badhte hain — ') + '\n' + '\n' + first,
      );
      return reply(t('Done — the form is open again without GST.', 'Ho gaya — bina GST ke form phir se khul gaya.'));
    }

    if (!decision.yes) {
      customerCreate.unpark(decision.requestId);
      for (const r of discountSetup.forAccount(decision.requestId)) discountSetup.drop(r.id);
      store.log(this.key, `${decision.requestId} rejected by ${who}`);
      await this.transport.sendText(
        req.answers.phone,
        t(
          'Our team needs a little more information before opening the account — someone will call you.',
          'Account ke liye thodi aur jaankari chahiye — team aapko call karegi.',
        ),
      );
      return reply(t(`Rejected. ${req.answers.name} was told.`, `Reject kar diya. ${req.answers.name} ko bata diya.`));
    }

    // The account itself. buildAccount works out the username, password,
    // branch and user type exactly as the email path does, so an account
    // opened from WhatsApp is indistinguishable from one opened from a form.
    const dataEntry = require('../core/dataEntryRequests');
    const account = dataEntry.buildAccount({ ...req.answers, kind: 'customer' });
    try {
      await portal.createCustomer(account);
      customerCreate.unpark(decision.requestId);
      customers.forget(req.answers.phone); // so the next order resolves the NEW account
      store.log(this.key, `${decision.requestId} approved by ${who} — created ${account.username}`);

      await this.transport.sendText(
        req.answers.phone,
        t(
          `Your account is open. Send the part number and quantity and I will place the order.`,
          `Aapka account khul gaya hai. Part number aur quantity bhejiye, order laga deta hoon.`,
        ),
      );
      // The agent's discount rules, now that there is an account to hang
      // them on: those already approved are created; the rest are created
      // when their own OK comes.
      const waiting = discountSetup.forAccount(decision.requestId);
      if (waiting.length) {
        const lines = [];
        for (const r of waiting) {
          if (r.status !== 'approved') {
            lines.push(`⏳ ${r.rule.ruleName} — ${t('waiting for its own approval', 'approval ka wait')} (${r.id})`);
            continue;
          }
          const made = await this.createDiscountFor(r);
          if (made.ok) discountSetup.drop(r.id);
          lines.push(made.ok ? '✅ ' + made.name : `⚠️ ${made.name} — ${made.why}`);
        }
        try {
          await this.transport.sendToChat(req.chatId, t(`${req.answers.name} is approved. Discount rules:\n${lines.join('\n')}`, `${req.answers.name} approve ho gaya. Discount rules:\n${lines.join('\n')}`));
        } catch (e) {
          /* the rules exist either way */
        }
      }
      for (const phone of Object.keys(config.creation.notify)) {
        if (store.normPhone(phone) === store.normPhone(m.from)) continue;
        try {
          await this.transport.sendText(phone, `${req.answers.name} ka account ban gaya (${account.username}) — ${who} ne approve kiya.`);
        } catch (e) {
          /* a notification nobody received must not fail the creation */
        }
      }
      return reply(t(`Done — ${req.answers.name} is open (${account.username}).`, `Ho gaya — ${req.answers.name} ka account khul gaya (${account.username}).`));
    } catch (e) {
      // The request STAYS parked: a failed create is worth another try, and
      // losing the form would mean asking the customer everything again.
      const why = String((e && e.message) || e).slice(0, 160);
      store.log(this.key, `${decision.requestId} create FAILED: ${why}`);
      return reply(t(`Could not create it: ${why}\nThe request is still here — try *OK ${decision.requestId}* again.`, `Nahi ban paya: ${why}\nRequest abhi bhi hai — dobara *OK ${decision.requestId}* bhejiye.`));
    }
  }

  // An approver's words on a request that are not OK or NO. "Already has an
  // account" closes it and tells the customer to carry on ordering; anything
  // else is NOT passed to the customer (it may be meant for the desk, not for
  // them) and the approver is asked for the answer that does something.
  async noteOnNewCustomer(m, requestId, text, reply, t) {
    const req = customerCreate.parked(requestId);
    if (!req) {
      return reply(t(`${requestId} is no longer pending — it may already be done.`, `${requestId} ab pending nahi hai — shayad pehle hi ho chuka hai.`));
    }
    const who = customerCreate.approverName(m.from);
    const firm = req.answers.name || req.answers.phone;

    if (customerCreate.saysAlreadyExists(text)) {
      customerCreate.unpark(requestId);
      customers.forget(req.answers.phone); // the next order looks the account up afresh
      store.log(this.key, `${requestId} closed by ${who}: account already exists ("${text.slice(0, 80)}")`);
      await this.transport.sendText(
        req.answers.phone,
        t(
          'Good news — you already have an account with us, so no new one is needed. Send the part number and quantity and I will place the order.',
          'Aapka account pehle se bana hua hai sir — naya banane ki zaroorat nahi. Part number aur quantity bhejiye, order laga deta hoon.',
        ),
      );
      for (const phone of Object.keys(config.creation.approvers)) {
        if (store.normPhone(phone) === store.normPhone(m.from)) continue;
        try {
          await this.transport.sendText(phone, `${requestId} (${firm}) band — ${who}: account pehle se hai.`);
        } catch (e) {
          /* the other approver missing this must not undo the close */
        }
      }
      return reply(
        t(
          `Closed ${requestId} — ${firm} was told they already have an account.`,
          `${requestId} band kar diya — ${firm} ko bata diya ki account pehle se hai.`,
        ),
      );
    }

    store.log(this.key, `${who} wrote on ${requestId} without a decision: "${text.slice(0, 80)}"`);

    // THE SECOND NUDGE DROPS THE BOLD.
    //
    // 24 Sep: the first nudge asked for "*OK WA-MUF9D6Q6*". He copied what he
    // was shown — which is what anybody does — and copying bold text brings
    // the asterisks with it. The reply was refused, so the same bolded nudge
    // went again, and he copied it again. Three rounds, nine minutes, a
    // customer's account unopened, over punctuation the bot had added itself.
    //
    // The parser now strips the markup (core/waText), so that loop cannot
    // recur. This is the other half: once asking nicely has failed once, show
    // the command as PLAIN TEXT, with nothing in it that can be copied wrong.
    //
    // The count lives on the parked request and is written through, so it
    // survives a restart — otherwise the third message after a deploy would
    // be the bolded one again.
    const nudges = customerCreate.noteNudge(requestId);

    if (nudges <= 1) {
      return reply(
        t(
          `${requestId} (${firm}) is still waiting. Reply *OK ${requestId}* to create, *NO ${requestId}* to reject, or "already hai" if they have an account.`,
          `${requestId} (${firm}) abhi pending hai. Banane ke liye *OK ${requestId}*, reject ke liye *NO ${requestId}*, ya account pehle se hai to "already hai" likhiye.`,
        ),
      );
    }

    // Plain. No asterisks, no underscores, nothing WhatsApp will render —
    // so whatever comes back is exactly what was shown.
    return reply(
      t(
        `${requestId} (${firm}) is still waiting.\n\nCopy one of these exactly:\n\nOK ${requestId}\nNO ${requestId}\n\nOr say "already hai" if they already have an account.`,
        `${requestId} (${firm}) abhi pending hai.\n\nInme se ek exactly copy kar dijiye:\n\nOK ${requestId}\nNO ${requestId}\n\nYa "already hai" likhiye agar account pehle se hai.`,
      ),
    );
  }

  // Several parts fit what they asked the price of: the Dzire has had four
  // front bumpers. Show the first few - in stock first - each with its price,
  // and let them pick by number, part number, or by saying which car ("2nd
  // gen", "2019"). A question with no prices ("Kaunsa? Front Side / Front")
  // answers nothing they asked.
  async offerPriced(m, state, top, total, reply, t, limit = 5) {
    const shown = top.slice(0, limit);
    const onBehalf = route.onBehalfOf(m);
    const rateCtx = onBehalf || (await customers.resolve(m.from).catch(() => null));
    const priced = await rates.prices(shown.map((x) => x.partNo), { ctx: rateCtx && rateCtx.found ? rateCtx : null });
    // The car and fitment, not the part name they already said: the name is
    // "Bumper| Front Side | Swift 2nd Gen / Dzire 2nd Gen | Petrol / Diesel".
    const fits = (name) => {
      const segs = String(name || '').split('|').map((s) => s.trim()).filter(Boolean);
      return (segs.length > 1 ? segs.slice(1) : segs).join(' · ');
    };
    const lines = shown.map((x, i) => {
      const p = priced.get(rates.norm(x.partNo));
      const stock = x.available > 0 ? t('in stock', 'stock hai') : t('on order', 'order pe');
      return `${i + 1}. ${x.partNo} — ${fits(x.name)}\n    ${p ? rates.priceText(p, t) + ' · ' : ''}${stock}`;
    });
    askQty.clear(m.chatId);
    askQty.forget(m.chatId);
    rateOptions.set(m.chatId, {
      base: state.base,
      parts: shown.map((x) => {
        const p = priced.get(rates.norm(x.partNo));
        return { partNo: x.partNo, name: x.name, price: p ? rates.priceText(p, t) : null, key: x.key || null };
      }),
      at: Date.now(),
    });
    // Kept too, so "2nd gen" narrows the same search instead of starting over.
    clarify.offer(m.chatId, state, top);
    const more = total > shown.length ? t(` (${total} fit - the first ${shown.length})`, ` (${total} milte hain - pehle ${shown.length})`) : '';
    return reply(
      `${state.base}${more}:\n\n${lines.join('\n')}\n\n` +
        t('Which one? Send the number - or the model / year of the car.', 'Kaunsa chahiye? Number bhejiye - ya gaadi ka model / saal bata dijiye.'),
    );
  }

  // A part they asked the price of, found by name: what it is, whether we
  // have it, their rate, and "how many?" - so the next message is the order.
  // A rate the portal and Odoo both lack still goes to a person.
  async quoteForOrder(m, found, reply, t) {
    rateOptions.delete(m.chatId);
    const partNos = [...new Set(found.map((f) => f.partNo))];
    const resolved = await availability.resolve(partNos.map((p) => ({ item: p, qty: 1 }))).catch(() => []);
    if (resolved.length) {
      inquiries.recordMany(resolved, { customer: m.from, chatId: m.chatId });
      focus.remember(m.chatId, resolved);
    }
    const onBehalf = route.onBehalfOf(m);
    const rateCtx = onBehalf || (await customers.resolve(m.from).catch(() => null));
    const acct = onBehalf ? { name: onBehalf.name } : await require('../core/customerLookup').ownRow(m.from).catch(() => null);
    const cart = orders.findDraft(m.chatId);
    const quoted = await rates
      .quote(partNos, {
        name: acct && acct.name,
        ctx: rateCtx && rateCtx.found ? rateCtx : null,
        lines: onBehalf ? [] : (cart && cart.lines) || [],
        label: onBehalf ? onBehalf.name : null,
      }, t)
      .catch((e) => {
        store.log(this.key, 'rate quote failed: ' + String((e && e.message) || e).slice(0, 110));
        return null;
      });

    for (const f of found) {
      if (f.name) continue;
      const r = await availability.byName(f.partNo).catch(() => null);
      const hit = ((r && r.top) || []).find((x) => rates.norm(x.partNo) === rates.norm(f.partNo));
      if (hit) f.name = hit.name;
    }
    const what = found.filter((f) => f.name).map((f) => `${f.partNo} — ${f.name}`).join('\n');
    const stock = resolved.map((l) => availability.describe(l, m.chatId)).join('\n');
    askQty.ask(m.chatId, partNos.map((p) => ({ item: p })));

    let price = quoted;
    // The price we showed in the list a minute ago still stands. 22 Sep: the
    // portal timed out once on the pick, and the customer who had just read
    // "MRP ₹2,650" was told the rate would follow.
    if (!quoted && found.every((f) => f.price)) {
      price = found.map((f) => `${f.partNo} - ${f.price}`).join('\n');
    } else if (!quoted) {
      await escalation.create(this, {
        chatId: m.chatId,
        customerPhone: m.from,
        customerMessageId: m.id || null,
        item: partNos.join(', '),
        qty: 1,
        kind: 'inquiry',
        reason: 'RATE',
      });
      price = t('Rate: confirming it, will send shortly.', 'Rate: confirm karke abhi bhejta hoon.');
    } else {
      store.upsertCustomer(m.from);
    }
    store.log(this.key, `rate: quoted ${partNos.join(', ')} by name${quoted ? '' : price !== quoted && found.every((f) => f.price) ? ' (price from the list)' : ' (no price found - asked a person)'}`);
    return reply(
      [what, price, stock ? 'Stock: ' + stock : null, t('How many do you need?', 'Kitne piece chahiye?')]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  // ---- discount rules (core/discountSetup) ----
  //
  // Set up by the agent for a new account, or changed for one that exists -
  // and in every case approved by the Sales Head ("OK DSC-…") before the
  // portal is touched (founder, 22 Sep). A part-wise rule is set by the
  // lowest price the part may be sold at: the portal's MRP is shown, the
  // price is asked, and the percentage is worked out from the two.
  // STAFF, NOT CUSTOMERS. Admins, the helper and the voice helper, the
  // Sales Heads who approve accounts, the account-opening team, salesmen, the
  // sales team who ask on a customer's behalf. Their messages are commands to
  // the staff tooling; everyone else is a customer, and talks to the agent.
  isOperator(m) {
    const p = store.normPhone(m.from);
    if (!p) return false;
    return Boolean(
      route.isStaff(p) ||
        (config.salesTeamNumbers || []).includes(p) ||
        (config.inquiryOnlyNumbers || []).includes(p) ||
        salesOrder.isSalesPerson(p) ||
        customerCreate.isApprover(p) ||
        customerCreate.agentName(p),
    );
  }

  // A CUSTOMER'S MESSAGE, start to finish. Read whatever came with it —
  // photo, document, voice note — into facts (pipeline/media.readForAgent,
  // which answers nothing), and give the whole thing to the agent.
  async answerCustomer(m, reply, t) {
    const read = await readForAgent(this, m);
    let text = String(read.text || '').trim();
    // "26300_02752 40 pcs", "16510m68k10.48 pcs" — straightened out the same
    // way it always was, so the part-number tools read the same thing.
    if (text) text = ai.normalizeOrderText(text);
    if (!text && !read.attachment && !incoming.isEvent(m)) return false;

    if (agent.enabled()) {
      const done = await this.askAgent(m, text, reply, t, read.attachment);
      if (done !== null) return done;
    }
    return this.agentUnavailable(m, text, reply, t, read.attachment);
  }

  // THE ONE FIXED LINE A CUSTOMER CAN STILL GET. The model could not run at
  // all — no key, Gemini down — or wrote a price no tool gave it. There is no
  // template path behind the agent any more, so a person is asked, with the
  // message (and its photo), and the customer is told so in one line. When he
  // answers, escalation gives his words to the customer.
  async agentUnavailable(m, text, reply, t, attachment) {
    const what = text || (attachment ? incoming.describeAttachment(attachment) : incoming.forLog(m));
    store.log(this.key, `agent could not answer ${m.from} — handed to a person: "${String(what).slice(0, 60)}"`);
    try {
      await escalation.create(this, {
        chatId: m.chatId,
        customerPhone: m.from,
        customerName: m.profileName || null,
        customerMessageId: m.id || null,
        item: String(what).slice(0, 300),
        qty: 1,
        kind: 'inquiry',
        reason: 'NOT_A_PART',
        photo: incoming.heldPhoto(m.chatId) || undefined,
      });
    } catch (e) {
      store.log(this.key, 'could not hand the message to a person: ' + String((e && e.message) || e).slice(0, 80));
    }
    return reply(t('One moment — let me get someone to check this for you.', 'Ek minute — main kisi se check karwa ke batata hoon.'));
  }

  // ONE MESSAGE TO THE AGENT, and whatever it says back.
  //
  // -> the reply's result when the agent answered (the caller returns it), or
  //    null when it could not run.
  async askAgent(m, text, reply, t, attachment) {
    const who = await customers.resolve(m.from).catch(() => null);
    const res = await agent.handle({
      bot: this,
      chatId: m.chatId,
      phone: m.from,
      customer: who && who.found ? who : null,
      // The words WITH what WhatsApp said about them — a swipe-reply and what
      // it quoted, a caption, a reaction, an edit — what an attachment
      // contained, and anything said in the chat since the agent last spoke
      // (agent/incoming).
      text: incoming.forAgent(m, { text, quoted: (id) => quotedMsg(m.chatId, id), before: m.receivedAt, attachment }),
      // The message itself, for the tools that need more than its words: the
      // account form takes a shop photo or a dropped pin straight from it.
      message: m,
    });
    if (!res.handled) return null;

    let out = true;
    // THE AGENT IS WAITING FOR THE SPECIALIST. The conversation is parked
    // mid-turn and checkpointed. The customer gets the line the MODEL wrote
    // when it asked — sent from here, because the model is not running any
    // more. The fixed line is only for a model that left it out. The answer
    // goes out when he replies (agent.resume).
    if (res.paused) {
      out = await reply(
        res.holding ||
          t(
            'Let me get this checked by our specialist — I will confirm shortly.',
            'Ye main apne specialist se check karwa leta hoon — thodi der mein confirm karta hoon.',
          ),
      );
    } else if (res.reply) {
      out = await reply(res.reply);
    }
    // Everything up to and including this reply is in the agent's own memory
    // now; the next catch-up starts after it.
    incoming.markSeen(m.chatId);
    return out;
  }

  // A message sent outside a customer's turn — the agent's answer once the
  // specialist has replied — recorded like every other reply, so it is in the
  // chat's history and a swipe-reply onto it can be read.
  recordOutgoing(chatId, id, text) {
    conversation.record(chatId, 'us', text);
    rememberMsg(chatId, id, 'us', text);
  }

  // Every question in this flow already asks itself in words — "Brand wise ya
  // Part wise?", "Ye rule approval ke liye bhejun?" — and every step reads a
  // typed answer. So the question goes out as it is: no buttons, and no menu
  // of bullet points under it. Callers still pass `buttons`; it is ignored
  // here, so the step logic, and a tap on an old button still sitting in
  // someone's chat, keep working.
  async askDiscount(m, text) {
    const id = await this.transport.sendToChat(m.chatId, text);
    conversation.record(m.chatId, 'us', text);
    rememberMsg(m.chatId, id, 'us', text);
    return true;
  }

  discountTypeButtons(t) {
    return [
      { id: 'DSC_BRAND', title: t('Brand wise', 'Brand wise') },
      { id: 'DSC_PART', title: t('Part wise', 'Part wise') },
      { id: 'DSC_LATER', title: t('Not now', 'Abhi nahi') },
    ];
  }

  async toApprovers(text) {
    let sent = 0;
    for (const phone of Object.keys(config.creation.approvers)) {
      try {
        // Outside the 24h window a plain text is silently dropped (escalation.ensureWindow).
        await escalation.ensureWindow(this.transport, phone, 'Discount approval coming — details follow');
        await this.transport.sendText(phone, text);
        sent++;
      } catch (e) {
        store.log(this.key, `could not reach approver ${phone}: ${String((e && e.message) || e).slice(0, 90)}`);
      }
    }
    return sent;
  }

  // A NEW ACCOUNT, just sent for approval: whoever filled the form sets the
  // discount now. Asked through `reply`, so on the agent's path the question
  // comes back to the agent as a fact and it asks it in its own words.
  async startDiscountSetup(m, form, reply, t) {
    const by = form.byName || `customer (${m.from})`;
    discountSetup.save(m.chatId, {
      mode: 'new',
      accountRequestId: form.answers.requestId,
      phone: form.answers.phone,
      customer: form.answers.name || form.answers.phone,
      setBy: by,
      step: 'type',
      draft: {},
      count: 0,
    });
    store.log(this.key, `${form.answers.requestId}: asking ${by} for the discount rule`);
    return reply(
      t(
        `Now the discount for ${form.answers.name || 'this customer'}. Brand-wise or part-wise? It is sent for approval, and starts the day it is approved.`,
        `Ab ${form.answers.name || 'is customer'} ka discount rule set kar lete hain. Brand wise ya Part wise? Approval ke baad lagu hoga.`,
      ),
    );
  }

  // AN EXISTING CUSTOMER'S DISCOUNT, changed. The customer asks for their own;
  // an agent or the desk says whose.
  async startDiscountChange(m, text, reply, t) {
    const agent = customerCreate.agentName(m.from);
    const staff = Boolean(agent) || salesOrder.isSalesPerson(m.from) || this.isOwnTeam(m);
    const st = { mode: 'change', step: 'customer', draft: {}, count: 0, setBy: staff ? agent || m.profileName || m.from : 'customer (' + m.from + ')' };
    if (!staff) {
      const me = await customers.resolve(m.from).catch(() => null);
      if (!me || !me.found) {
        return reply(t('Your number is not on our system yet, so there is no discount to change.', 'Aapka number abhi system mein nahi hai, isliye discount change nahi ho sakta.'));
      }
      st.dealerId = me.buyerId;
      st.customer = me.name;
      return this.showDiscountRules(m, st, reply, t);
    }
    const picked = salesOrder.activeCustomer(m.chatId);
    if (picked && picked.buyerId) {
      st.dealerId = picked.buyerId;
      st.customer = picked.name;
      return this.showDiscountRules(m, st, reply, t);
    }
    discountSetup.save(m.chatId, st);
    return reply(t('Whose discount? Send the customer name.', 'Kis customer ka discount? Customer ka naam bhejiye.'));
  }

  async showDiscountRules(m, st, reply, t) {
    let rules = [];
    try {
      rules = (await portal.listDiscountRules()).filter((r) => Number(r.dealer_id) === Number(st.dealerId) && r.is_active !== false);
    } catch (e) {
      store.log(this.key, 'discount rules could not be read: ' + String((e && e.message) || e).slice(0, 80));
    }
    st.rules = rules.slice(0, 9).map((r) => ({
      id: r.rule_id || r.id,
      name: r.rule_name,
      type: r.rule_type,
      brand: r.brand,
      partNo: r.part_no,
      value: Number(r.discount_value),
      mode: r.discount_mode,
    }));
    if (!st.rules.length) {
      st.step = 'type';
      discountSetup.save(m.chatId, st);
      return this.askDiscount(
        m,
        t(`${st.customer} has no discount rule yet. A new one — brand-wise or part-wise?`, `${st.customer} ka abhi koi discount rule nahi hai. Naya rule — Brand wise ya Part wise?`),
        this.discountTypeButtons(t),
        t,
      );
    }
    st.step = 'pickRule';
    discountSetup.save(m.chatId, st);
    const list = st.rules
      .map((r, i) => `${i + 1}. ${r.name || r.brand || r.partNo || 'All parts'} — ${r.value}${String(r.mode).toUpperCase() === 'FLAT' ? ' (flat ₹)' : '%'}`)
      .join('\n');
    return reply(
      t(
        `${st.customer}'s discount rules:\n${list}\n\nWhich one to change? Send its number — or "new" for a new rule.`,
        `${st.customer} ke discount rules:\n${list}\n\nKaunsa change karna hai? Number bhejiye — ya naye rule ke liye "naya".`,
      ),
    );
  }

  // The portal's MRP for a part, for the price question.
  async mrpOf(partNo, dealerId) {
    try {
      const got = await rates.prices([partNo], { ctx: dealerId ? { buyerId: dealerId } : null });
      const p = got.get(rates.norm(partNo));
      return p && p.mrp ? Number(p.mrp) : null;
    } catch (e) {
      return null;
    }
  }

  async answerDiscount(m, said, reply, t) {
    const st = discountSetup.get(m.chatId);
    const d = st.draft;
    const money = discountSetup.money;
    const next = (step, text, buttons) => {
      st.step = step;
      discountSetup.save(m.chatId, st);
      return this.askDiscount(m, text, buttons, t);
    };
    const skipHint = t(' ("skip" if none)', ' (nahi hai to "skip")');

    if (discountSetup.LATER.test(said) || m.buttonId === 'DSC_LATER') {
      discountSetup.cancel(m.chatId);
      store.log(this.key, `discount setup left (${st.count} rule(s) sent for approval)`);
      return reply(
        st.count
          ? t(`Done — ${st.count} discount rule(s) are with the Sales Head for approval.`, `Theek hai — ${st.count} discount rule approval ke liye bhej diye hain.`)
          : t('No discount rule, then. It can be set later.', 'Theek hai, koi discount rule nahi. Baad mein set ho sakta hai.'),
      );
    }
    // A price question or a part order in the middle is not an answer here.
    if (!m.buttonId && /\b(kitne|kitna|rate|stock|hai kya)\b|\?\s*$/i.test(said) && !['confirm', 'confirmChange'].includes(st.step)) return null;

    // The request, filed and sent to the Sales Head.
    const submit = async (type, extra) => {
      const req = discountSetup.file({
        type,
        rule: { ...d },
        customer: st.customer,
        dealerId: st.dealerId || null,
        accountRequestId: st.accountRequestId || null,
        phone: st.phone || null,
        by: st.setBy,
        chatId: m.chatId,
        ...extra,
      });
      await this.toApprovers(discountSetup.approvalText(req));
      store.log(this.key, `${req.id}: discount ${type} for ${st.customer} sent for approval (${d.target || ''} ${d.value}%)`);
      return req;
    };

    switch (st.step) {
      // ---- whose (agent or desk changing a customer's discount) ----
      case 'customer': {
        const n = /^(\d{1,2})[.)]?$/.exec(said);
        let row = n && st.candidates ? st.candidates[Number(n[1]) - 1] : null;
        if (!row) {
          const found = await salesOrder.findCustomers(said).catch(() => ({ top: [] }));
          const top = found.top || [];
          if (!top.length) return next('customer', t(`No customer called "${said}". Send the name again.`, `"${said}" naam ka customer nahi mila. Naam dobara bhejiye.`));
          if (top.length > 1) {
            st.candidates = top.slice(0, 6).map((r) => ({ id: r.id, name: r.name, label: salesOrder.label(r) }));
            return next('customer', t('Which one?', 'Kaunsa?') + '\n' + st.candidates.map((c, i) => `${i + 1}. ${c.label}`).join('\n'));
          }
          row = { id: top[0].id, name: top[0].name };
        }
        st.dealerId = row.id;
        st.customer = row.name;
        delete st.candidates;
        return this.showDiscountRules(m, st, reply, t);
      }
      // ---- which rule ----
      case 'pickRule': {
        if (/^(naya|new|nayi|add)\b/i.test(said)) {
          return next('type', t('A new rule — brand-wise or part-wise?', 'Naya rule — Brand wise ya Part wise?'), this.discountTypeButtons(t));
        }
        const n = discountSetup.readNumber(said);
        const rule = n ? st.rules[n - 1] : null;
        if (!rule) return next('pickRule', t(`Send a number from 1 to ${st.rules.length}, or "new".`, `1 se ${st.rules.length} tak number bhejiye, ya "naya".`));
        if (String(rule.mode).toUpperCase() === 'FLAT') {
          discountSetup.cancel(m.chatId);
          return reply(t('That is a flat-amount rule; please change it on the portal.', 'Ye flat amount wala rule hai — ise portal pe change kijiye.'));
        }
        st.rule = rule;
        d.kind = rule.type === 'ITEM' ? 'part' : rule.type === 'BRAND' ? 'brand' : 'dealer';
        d.target = rule.partNo || rule.brand || 'ALL PARTS';
        if (d.kind === 'part') {
          const mrp = await this.mrpOf(rule.partNo, st.dealerId);
          if (mrp) {
            d.mrp = mrp;
            return next(
              'changePrice',
              t(
                `${rule.partNo} — MRP ${money(mrp)}. Now ${rule.value}% off: sells at ${money(discountSetup.priceAt(mrp, rule.value))}.\nNew lowest sale price (₹)?`,
                `${rule.partNo} — MRP ${money(mrp)}. Abhi ${rule.value}% discount: ${money(discountSetup.priceAt(mrp, rule.value))} mein bikta hai.\nNaya minimum sale price (₹)?`,
              ),
            );
          }
        }
        return next('changeValue', t(`Now ${rule.value}%. New discount %?`, `Abhi ${rule.value}% hai. Naya discount %?`));
      }
      case 'changePrice': {
        const price = discountSetup.readNumber(said);
        const pct = discountSetup.pctFromPrice(d.mrp, price);
        if (pct === null) return next('changePrice', t(`A price below the MRP (${money(d.mrp)}), in ₹.`, `MRP (${money(d.mrp)}) se kam price, ₹ mein.`));
        d.value = pct;
        d.minPrice = price;
        return next(
          'confirmChange',
          t(
            `${st.rule.name || d.target}: ${st.rule.value}% → ${pct}% (sells at ${money(price)} against MRP ${money(d.mrp)}). Send for approval?`,
            `${st.rule.name || d.target}: ${st.rule.value}% → ${pct}% (${money(price)} mein, MRP ${money(d.mrp)}). Approval ke liye bhejun?`,
          ),
          [{ id: 'DSC_YES', title: t('Yes', 'Haan') }, { id: 'DSC_NO', title: t('No', 'Nahi') }],
        );
      }
      case 'changeValue': {
        const v = discountSetup.readNumber(said);
        if (v === null || v <= 0 || v >= 100) return next('changeValue', t('Send the discount as a percentage, like 12.', 'Discount % mein bhejiye, jaise 12.'));
        d.value = v;
        return next(
          'confirmChange',
          t(`${st.rule.name || d.target}: ${st.rule.value}% → ${v}%. Send for approval?`, `${st.rule.name || d.target}: ${st.rule.value}% → ${v}%. Approval ke liye bhejun?`),
          [{ id: 'DSC_YES', title: t('Yes', 'Haan') }, { id: 'DSC_NO', title: t('No', 'Nahi') }],
        );
      }
      case 'confirmChange': {
        discountSetup.cancel(m.chatId);
        if (!discountSetup.YES.test(said) && m.buttonId !== 'DSC_YES') {
          return reply(t('Not sent. Nothing was changed.', 'Theek hai, nahi bheja. Kuch change nahi hua.'));
        }
        const req = await submit('change', { ruleId: st.rule.id, oldValue: st.rule.value, oldName: st.rule.name });
        return reply(
          t(
            `Sent to the Sales Head for approval (${req.id}). The discount changes on the portal only once it is approved.`,
            `Approval ke liye bhej diya (${req.id}). Approve hote hi portal pe discount update ho jayega.`,
          ),
        );
      }

      // ---- a new rule ----
      case 'type': {
        const brand = m.buttonId === 'DSC_BRAND' || /^brand/i.test(said);
        const part = m.buttonId === 'DSC_PART' || /^part|^item/i.test(said);
        if (!brand && !part) return next('type', t('Brand-wise or part-wise?', 'Brand wise ya Part wise?'), this.discountTypeButtons(t));
        d.kind = brand ? 'brand' : 'part';
        return next('target', brand ? t('Which brand?', 'Kaunsa brand?') : t('Which part number?', 'Kaunsa part number?'));
      }
      case 'target': {
        if (!said) return next('target', d.kind === 'brand' ? t('Which brand?', 'Kaunsa brand?') : t('Which part number?', 'Kaunsa part number?'));
        if (d.kind === 'brand') {
          // As the portal writes it: "cartrend" is CARTRENDS there.
          let brands = [];
          try {
            brands = await portal.listBrands(said);
          } catch (e) {
            store.log(this.key, 'brand list failed: ' + String((e && e.message) || e).slice(0, 80));
          }
          const exact = brands.find((b) => b.toLowerCase() === said.toLowerCase());
          const pick = exact || (brands.length === 1 ? brands[0] : null);
          if (!pick && brands.length > 1) {
            return next('target', t(`Which of these? ${brands.slice(0, 8).join(' / ')}`, `Inme se kaunsa? ${brands.slice(0, 8).join(' / ')}`));
          }
          if (!pick) return next('target', t(`"${said}" is not a brand on the portal. Send the brand name again.`, `"${said}" portal pe brand nahi mila. Brand ka naam dobara bhejiye.`));
          d.target = pick;
          return next('value', t(`${d.target} — how much discount, in %?`, `${d.target} — kitna discount (%)?`));
        }
        const pn = ai.partNumberIn(said) || said.trim();
        const [line] = await availability.resolve([{ item: pn, qty: 1 }]).catch(() => []);
        if (!line || line.source === 'unidentified' || line.source === 'unknown') {
          return next('target', t(`${pn} is not on the portal. Send the part number again.`, `${pn} portal pe nahi mila. Part number dobara bhejiye.`));
        }
        d.target = line.partNo || pn;
        // The price it may be sold at, against the portal's own MRP.
        const mrp = await this.mrpOf(d.target, st.dealerId);
        if (mrp) {
          d.mrp = mrp;
          return next('price', t(`${d.target} — MRP ${money(mrp)}. Lowest price to sell it at (₹)?`, `${d.target} — MRP ${money(mrp)}. Minimum kitne mein bechna hai (₹)?`));
        }
        return next('value', t(`${d.target} — the portal has no MRP for it. How much discount, in %?`, `${d.target} — portal pe MRP nahi mila. Kitna discount (%)?`));
      }
      case 'price': {
        const price = discountSetup.readNumber(said);
        const pct = discountSetup.pctFromPrice(d.mrp, price);
        if (pct === null) return next('price', t(`A price below the MRP (${money(d.mrp)}), in ₹.`, `MRP (${money(d.mrp)}) se kam price, ₹ mein.`));
        d.value = pct;
        d.minPrice = price;
        return next(
          'minQty',
          t(`${money(price)} against MRP ${money(d.mrp)} is ${pct}% off.\nMinimum quantity? (default 1 — "skip")`, `${money(price)} / MRP ${money(d.mrp)} = ${pct}% discount.\nMinimum quantity? (default 1 — "skip" likh dijiye)`),
        );
      }
      case 'value': {
        const v = discountSetup.readNumber(said);
        if (v === null || v <= 0 || v >= 100) return next('value', t('Send the discount as a percentage, like 12.', 'Discount % mein bhejiye, jaise 12.'));
        d.value = v;
        return next('minQty', t('Minimum quantity? (default 1 — "skip")', 'Minimum quantity? (default 1 — "skip" likh dijiye)'));
      }
      case 'minQty': {
        const v = discountSetup.SKIP.test(said) ? 1 : discountSetup.readNumber(said);
        if (!v || v < 1) return next('minQty', t('Minimum quantity as a number, or "skip" for 1.', 'Minimum quantity number mein, ya 1 ke liye "skip".'));
        d.minQty = Math.round(v);
        return next('maxQty', t('Maximum quantity?', 'Maximum quantity?') + skipHint);
      }
      case 'maxQty': {
        const v = discountSetup.SKIP.test(said) ? null : discountSetup.readNumber(said);
        if (!discountSetup.SKIP.test(said) && (!v || v < d.minQty)) return next('maxQty', t(`A number of at least ${d.minQty}, or "skip".`, `Kam se kam ${d.minQty}, ya "skip".`));
        d.maxQty = v ? Math.round(v) : null;
        return next('minAmount', t('Minimum amount (₹)?', 'Minimum amount (₹)?') + skipHint);
      }
      case 'minAmount': {
        const v = discountSetup.SKIP.test(said) ? null : discountSetup.readNumber(said);
        if (!discountSetup.SKIP.test(said) && !v) return next('minAmount', t('An amount in ₹, or "skip".', 'Amount ₹ mein, ya "skip".'));
        d.minAmount = v || null;
        return next('maxAmount', t('Maximum amount (₹)?', 'Maximum amount (₹)?') + skipHint);
      }
      case 'maxAmount': {
        const v = discountSetup.SKIP.test(said) ? null : discountSetup.readNumber(said);
        if (!discountSetup.SKIP.test(said) && (!v || (d.minAmount && v < d.minAmount))) return next('maxAmount', t('An amount in ₹ above the minimum, or "skip".', 'Minimum se zyada amount ₹ mein, ya "skip".'));
        d.maxAmount = v || null;
        return next('duration', t('For how long? (e.g. 30 days, 3 months, 1 year, or "always")', 'Kitne time ke liye? (jaise 30 din, 3 mahine, 1 saal, ya "hamesha")'));
      }
      case 'duration': {
        const dur = discountSetup.readDuration(said);
        if (dur === undefined) return next('duration', t('Like 30 days, 3 months, 1 year — or "always".', 'Jaise 30 din, 3 mahine, 1 saal — ya "hamesha".'));
        d.days = dur.days;
        d.durationLabel = dur.label;
        d.ruleName = discountSetup.ruleName(st.customer, d.target, d.value);
        const priced = d.mrp ? `\nMRP ${money(d.mrp)} → ${money(discountSetup.priceAt(d.mrp, d.value))}` : '';
        return next('confirm', discountSetup.describe(d, t) + priced + '\n\n' + t('Send this rule for approval?', 'Ye rule approval ke liye bhejun?'), [
          { id: 'DSC_YES', title: t('Yes', 'Haan') },
          { id: 'DSC_NO', title: t('No, start again', 'Nahi, dobara') },
        ]);
      }
      case 'confirm': {
        if (discountSetup.NO.test(said) || m.buttonId === 'DSC_NO') {
          st.draft = {};
          return next('type', t('Again, then — brand-wise or part-wise?', 'Theek hai, dobara — Brand wise ya Part wise?'), this.discountTypeButtons(t));
        }
        if (!discountSetup.YES.test(said) && m.buttonId !== 'DSC_YES') {
          return next('confirm', t('Send this rule for approval? Yes or no.', 'Ye rule approval ke liye bhejun? Haan ya Nahi.'), [
            { id: 'DSC_YES', title: t('Yes', 'Haan') },
            { id: 'DSC_NO', title: t('No, start again', 'Nahi, dobara') },
          ]);
        }
        const req = await submit('new', {});
        st.count += 1;
        st.draft = {};
        return next('more', t(`Sent for approval (${req.id}): ${d.ruleName}. Another rule for this customer?`, `Approval ke liye bhej diya (${req.id}): ${d.ruleName}. Is customer ke liye aur rule?`), [
          { id: 'DSC_MORE_YES', title: t('Add another', 'Aur add karo') },
          { id: 'DSC_MORE_NO', title: t('Done', 'Bas itna') },
        ]);
      }
      case 'more': {
        // "done", "bas", "itna hi" mean STOP here, even though "done" is a yes
        // at the confirm step. With a button it never mattered which word was
        // typed; answered in words, "done" would have started another rule.
        const finished = /^(done|bas|bas itna|itna hi|that'?s all|no more|enough)\b/i.test(said) || m.buttonId === 'DSC_MORE_NO';
        if (!finished && (discountSetup.YES.test(said) || m.buttonId === 'DSC_MORE_YES')) {
          return next('type', t('Brand-wise or part-wise?', 'Brand wise ya Part wise?'), this.discountTypeButtons(t));
        }
        discountSetup.cancel(m.chatId);
        return reply(
          t(
            `Done — ${st.count} discount rule(s) sent to the Sales Head. Each is created on the portal once approved${st.accountRequestId ? ' and the account is open' : ''}.`,
            `Ho gaya — ${st.count} discount rule approval ke liye bhej diye. Approve hote hi${st.accountRequestId ? ' (aur account khulte hi)' : ''} portal pe ban jayenge.`,
          ),
        );
      }
      default:
        discountSetup.cancel(m.chatId);
        return null;
    }
  }

  // One approved rule, created on the portal against the customer as the
  // portal has them - looked up by phone for an account that was new.
  async createDiscountFor(req) {
    let dealerId = req.dealerId;
    let name = req.customer;
    if (!dealerId && req.phone) {
      try {
        const c = await portal.lookupCustomer(req.phone);
        if (c && c.found) {
          dealerId = c.buyerId;
          name = c.name || name;
        }
      } catch (e) {
        store.log(this.key, 'discount: customer lookup failed: ' + String((e && e.message) || e).slice(0, 80));
      }
    }
    if (!dealerId) return { ok: false, name: req.rule.ruleName, why: 'customer not found on the portal yet' };
    const body = discountSetup.toPortal({ ...req.rule, requestId: req.id, setBy: req.by }, dealerId, name);
    try {
      const made = await portal.createDiscountRule(body);
      // Approved here means approved there: a rule the portal parked as
      // PENDING is put through its own review, or it never applies.
      const id = made && (made.rule_id || made.id);
      if (id && made.approval_status && String(made.approval_status).toUpperCase() !== 'APPROVED') {
        await portal.reviewDiscountRule(id, 'approve').catch((e) => store.log(this.key, `rule ${id} created but left ${made.approval_status}: ${String((e && e.message) || e).slice(0, 80)}`));
      }
      return { ok: true, name: body.rule_name };
    } catch (e) {
      return { ok: false, name: body.rule_name, why: String((e && e.message) || e).slice(0, 100) };
    }
  }

  // "OK DSC-7F3K" / "NO DSC-7F3K" from the Sales Head.
  async decideDiscount(m, decision, reply, t) {
    const req = discountSetup.find(decision.requestId);
    if (!req) return reply(t(`${decision.requestId} not found — it may already be done.`, `${decision.requestId} nahi mila — shayad pehle hi ho chuka hai.`));
    const who = customerCreate.approverName(m.from);
    const what = req.type === 'change' ? `${req.customer}: ${req.oldValue}% → ${req.rule.value}%` : `${req.rule.ruleName || req.customer}`;
    const tell = async (text) => {
      if (!req.chatId) return;
      try {
        await this.transport.sendToChat(req.chatId, text);
      } catch (e) {
        /* the decision stands either way */
      }
    };

    if (!decision.yes) {
      discountSetup.drop(req.id);
      store.log(this.key, `${req.id} (discount) rejected by ${who}`);
      await tell(t(`Discount request ${req.id} (${what}) was not approved.`, `Discount request ${req.id} (${what}) approve nahi hua.`));
      return reply(t(`Rejected ${req.id}. ${req.by || 'They'} was told.`, `${req.id} reject kar diya. ${req.by || 'Unko'} bata diya.`));
    }

    if (req.type === 'change') {
      try {
        const updated = await portal.updateDiscountRule(req.ruleId, {
          discount_value: req.rule.value,
          rule_name: discountSetup.ruleName(req.customer, req.rule.target, req.rule.value),
        });
        if (updated && updated.approval_status && String(updated.approval_status).toUpperCase() !== 'APPROVED') {
          await portal.reviewDiscountRule(req.ruleId, 'approve').catch((e) => store.log(this.key, `rule ${req.ruleId} updated but left ${updated.approval_status}: ${String((e && e.message) || e).slice(0, 80)}`));
        }
      } catch (e) {
        const why = String((e && e.message) || e).slice(0, 120);
        store.log(this.key, `${req.id} discount update FAILED: ${why}`);
        return reply(t(`Could not update it: ${why}\nThe request is still here — try *OK ${req.id}* again.`, `Update nahi ho paya: ${why}\nRequest abhi bhi hai — dobara *OK ${req.id}* bhejiye.`));
      }
      discountSetup.drop(req.id);
      store.log(this.key, `${req.id} approved by ${who} — rule ${req.ruleId} now ${req.rule.value}%`);
      await tell(t(`✅ Approved: ${what}. Updated on the portal.`, `✅ Approve ho gaya: ${what}. Portal pe update kar diya.`));
      return reply(t(`Done — ${what}.`, `Ho gaya — ${what}.`));
    }

    // A new rule for an account that is itself still waiting: approved now,
    // created the moment the account is.
    if (req.accountRequestId && customerCreate.parked(req.accountRequestId)) {
      req.status = 'approved';
      discountSetup.requests.set(req.id, req);
      store.log(this.key, `${req.id} approved by ${who} — waits for account ${req.accountRequestId}`);
      return reply(t(`Approved. It is created as soon as ${req.accountRequestId} is approved.`, `Approve ho gaya. ${req.accountRequestId} approve hote hi portal pe ban jayega.`));
    }
    const made = await this.createDiscountFor(req);
    if (!made.ok) {
      store.log(this.key, `${req.id} discount create FAILED: ${made.why}`);
      return reply(t(`Could not create it: ${made.why}\nTry *OK ${req.id}* again.`, `Nahi ban paya: ${made.why}\nDobara *OK ${req.id}* bhejiye.`));
    }
    discountSetup.drop(req.id);
    store.log(this.key, `${req.id} approved by ${who} — created ${made.name}`);
    await tell(t(`✅ Discount rule approved and created: ${made.name}`, `✅ Discount rule approve ho gaya, portal pe ban gaya: ${made.name}`));
    return reply(t(`Done — ${made.name}.`, `Ho gaya — ${made.name}.`));
  }

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

      // Has a person already answered this, or one just like it? The whole
      // point of the knowledge base: the second customer to ask about returns
      // gets the answer Prateek sir gave the first one, and he is not asked
      // again (founder: "agli baar usse koi same sawal poochhe to vapas
      // mujhse na poochhe").
      //
      // A miss here is never a guess — it falls through to the same person it
      // always did.
      if (kb.enabled()) {
        const known = await kb.answer(text, {
          chatId: m.chatId,
          customerId: store.normPhone(m.from),
          // When the sales team asks on a customer's behalf, THEY are the
          // agent — so anything scoped to that salesman is in play too.
          agentId: this.inquiryOnly(store.normPhone(m.from), m.chatId) ? store.normPhone(m.from) : null,
        });
        if (known.answered) {
          store.log(this.key, `answered from knowledge #${known.entry.id}: "${text.slice(0, 50)}"`);
          return reply(known.text);
        }
      }

      // Nothing learned covers it. Has anyone been asked this BEFORE, in the
      // years of chat history we imported?
      //
      // What comes back is context, never an answer: which part the question
      // is probably about. The part is then priced and counted by the portal
      // exactly like any other, so a customer hears today's stock and never
      // the figure somebody typed last June. A history example that names no
      // part teaches us nothing we can act on here, so it is skipped rather
      // than paraphrased at the customer.
      if (await this.historyPart(m, text, reply)) return true;

      // Money, billing, returns, complaints — real business the bot must not
      // answer for itself. Before this it vanished; now a person sees it.
      const asked = await escalation.create(this, {
        chatId: m.chatId,
        customerPhone: m.from,
        customerMessageId: m.id || null,
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
      // THE CATALOGUE INDEX FIRST, when one has been imported.
      //
      // The portal search is a literal phrase match, which is how "Cartend
      // wiper blade 17 number" ended up quoting a Fortuner blade: the brand
      // was dropped and one row was taken as proof. The index matches on
      // meaning instead, so the customer's words reach the right part number.
      //
      // It answers WHICH PART and nothing else — price and stock are still
      // read from the portal below, every time.
      const indexed = await parts.find(l.item).catch(() => null);
      if (indexed && indexed.partNo) {
        store.log(this.key, `"${l.item}" -> ${indexed.partNo} from the catalogue index`);
        lines.push({ ...l, item: indexed.partNo, requested: l.item });
        continue;
      }

      const hits = await availability.byName(vehicle.narrow(m.chatId, l.item));
      // One row is only an answer when it does not contradict the question.
      // "Cartend wiper blade 17 number" matched a Fortuner blade and was
      // quoted, because the brand was dropped from the search and "only one
      // match" was doing all the work. Untrusted now means SHOWN, not
      // guessed: the customer picks instead of being told the wrong thing.
      const trusted = hits.top.length === 1 && availability.matchTrustworthy(l.item, hits.top[0]);
      if (trusted) {
        store.log(this.key, `"${l.item}" -> ${hits.top[0].partNo} by name (only match)`);
        // Keep what it cost us to find. The next customer asking this way
        // is a vector lookup, not another search (core/parts.remember).
        parts.remember({ partNo: hits.top[0].partNo, name: hits.top[0].name }).catch(() => {});
        lines.push({ ...l, item: hits.top[0].partNo, requested: l.item });
      } else if (hits.top.length >= 1) {
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
    let unknown = resolved.filter((l) => l.source === 'unidentified' && !digitsOnly(l) && !desk);

    // A CUSTOMER'S part number the portal does not know. First the close
    // match - usually the same number with "5PK" on the end - offered one
    // line at a time for a yes or a no. A number with NO match goes to a
    // person with the rest of the list, and their answer is learned
    // (founder, 22 Sep).
    const nearQueue = [];
    const noMatch = [];
    if (unknown.length && !this.inquiryOnly(m.from, m.chatId)) {
      // A real part number, not whatever was typed: resolve() copies the
      // words into partNo too ("clutch set dzire petrol").
      const isNumber = (u) => partish.isPartNumber(String(u.requested || u.item || '').trim()) || Boolean(ai.partNumberIn(String(u.requested || u.item || '')));
      const numbered = unknown.filter(isNumber);
      const close = await this.closestMatches(numbered.map((u) => u.requested || u.partNo || u.item));
      for (const u of numbered) {
        const asked = u.requested || u.partNo || u.item;
        const c = close.get(asked);
        if (c) nearQueue.push({ asked, qty: u.qtyMissing ? 1 : u.qty || 1, unit: unitFor(m.body, asked), ref: u.ref || null, key: u.key || null, partNo: c.partNo, name: c.name, available: c.available });
        else noMatch.push(asked);
      }
      unknown = unknown.filter((u) => !isNumber(u) || noMatch.includes(u.requested || u.partNo || u.item));
      noMatch.length = 0;
    }
    // Who is asking, and everything they sent, for the person being asked.
    const askWith = {
      customerName: (ctx && ctx.name) || m.profileName || m.chatName || null,
      context: m.body || null,
      ...(m.mediaBase64 && /^image\//.test(m.mediaMime || '') ? { photo: { base64: m.mediaBase64, mime: m.mediaMime } } : {}),
    };
    // Asked and answered before, in words: say that again, ask nobody.
    const taughtNow = [];
    unknown = unknown.filter((u) => {
      const n = knowledge.findNote(u.requested || u.item);
      if (n) taughtNow.push(`${u.requested || u.item}: ${n.answer}`);
      return !n;
    });
    if (taughtNow.length) {
      store.log(this.key, `${taughtNow.length} line(s) answered from what a person said before`);
      await reply(taughtNow.join('\n\n'));
    }
    for (const u of unknown) {
      await escalation.create(this, {
        chatId: m.chatId,
        customerPhone: m.from,
        customerMessageId: m.id || null,
        item: u.requested || u.item,
        // What the bot actually extracted, which is what the reader needs to
        // see. Passing only the raw line meant a photo of a label arrived as
        // "COIL ASSY IGNITION 33400 M 68K31" and the reader had to pick the
        // part number out of it themselves.
        partNo: u.partNo || null,
        reason: u.partNo ? 'NOT_IN_CATALOGUE' : 'NO_PART_NUMBER',
        qty: u.qty,
        kind: 'order',
        ...askWith,
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
        askText = clarify.offer(m.chatId, { base: c.asked, qty: c.qty, ref: c.ref, key: c.key }, c.top);
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

    // Closest matches to offer, or numbers with none: the parts that WERE
    // found go into the order now, and the questions start. The priced list
    // and "confirm?" come once the last one is answered.
    if (nearQueue.length || noMatch.length) {
      if (usable.length) {
        const order0 = orders.getOrCreateDraft(m.chatId, m.from);
        if (ctx) order0.portalCustomer = ctx;
        orders.addLines(order0, usable.map((l) => (l.qtyMissing ? { ...l, qty: 1, qtyMissing: false } : l)), { replace: opts.fromPhoto === true });
      }
      cancelConfirmNudge(m.chatId);
      const head = [];
      if (usable.length) head.push(t(`${usable.length} part(s) found and added.`, `${usable.length} part mil gaye, order mein daal diye.`));
      if (noMatch.length) {
        head.push(
          noMatch.length === 1
            ? t(`Sorry, ${noMatch[0]} is not available.`, `Sorry, ${noMatch[0]} available nahi hai.`)
            : t(`Sorry, these are not available: ${noMatch.join(', ')}`, `Sorry, ye part available nahi hain: ${noMatch.join(', ')}`),
        );
      }
      if (unknown.length) {
        const names = unknown.map((u) => u.requested || u.item);
        head.push(t(`Checking ${names.join(', ')} - will confirm shortly.`, `${names.join(', ')} check kar raha hoon, thodi der mein batata hoon.`));
      }
      if (!nearQueue.length) {
        store.log(this.key, `${noMatch.length} part number(s) with no match - told not available, nobody asked`);
        if (!usable.length) return reply(head.join('\n\n'));
        return this.finishNear(m, { ctx }, head.join('\n\n'), reply, t);
      }
      head.push(
        t(
          `${nearQueue.length} part number(s) did not match exactly, but a close one is available. Let us check them one by one.`,
          `${nearQueue.length} part number exact nahi mile, par milta-julta part hai. Ek ek karke confirm kar lete hain.`,
        ),
      );
      nearAsk.set(m.chatId, { at: Date.now(), queue: nearQueue, done: 0, total: nearQueue.length, ctx: ctx || null });
      store.log(this.key, `${nearQueue.length} closest match(es) to offer one by one, ${noMatch.length} not available, ${unknown.length} to a person`);
      return this.askNear(m, head.join('\n\n'), reply, t);
    }

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
    const chatId = (m && m.chatId) || null;

    // A part named in WORDS is not a part number. The portal's analyze only
    // understands numbers, so "Maruti Suzuki Swift ka bumper" came back
    // unidentified and the customer was told "check karke batata hoon" — no
    // price, no stock, and nobody actually checking. 21 Sep, live: three voice
    // notes about a Swift bumper in one chat, all answered that way.
    //
    // So look the name up in the catalogue first, exactly as an order line
    // already does (processOrderLines). An inquiry and an order ask the same
    // question about the same catalogue; only the quantity differs.
    const lines = [];
    for (const raw of items) {
      const item = String(raw || '').trim();
      if (!item || !availability.isNameQuery(item)) {
        lines.push({ item, qty: 1 });
        continue;
      }
      let top = [];
      try {
        const hits = await availability.byName(vehicle.narrow(chatId, chatId ? withSpokenCar(chatId, item) : item));
        top = (hits && hits.top) || [];
      } catch (e) {
        store.log(this.key, `inquiry: catalogue lookup failed for "${item}": ${String((e && e.message) || e).slice(0, 80)}`);
      }
      // One part asked about by name: answer it the way a price question is
      // answered - what it is, its price, whether we have it, how many. The
      // bare "Stock check: 13780M55R50 - hai" told them nothing they could
      // order from (22 Sep, live).
      const asText = async (x) => x;
      // Same rule as the order path: one row that contradicts the question
      // is shown, not quoted (see availability.matchTrustworthy).
      const trustedOne = top.length === 1 && availability.matchTrustworthy(item, top[0]);
      if (items.length === 1 && m && trustedOne) {
        store.log(this.key, `"${item}" -> ${top[0].partNo} by name (only match)`);
        // Keep what it cost us to find. The next customer asking this way
        // is a vector lookup, not another search (core/parts.remember).
        parts.remember({ partNo: top[0].partNo, name: top[0].name }).catch(() => {});
        return this.quoteForOrder(m, [{ partNo: top[0].partNo, name: top[0].name, requested: item }], asText, t);
      }
      if (items.length === 1 && m && top.length >= 1) {
        store.log(this.key, `"${item}" -> ${top.length} catalogue matches; showing them priced`);
        return this.offerPriced(m, { base: item, qty: 1, rate: true }, top, top.length, asText, t);
      }
      if (top.length === 1 && availability.matchTrustworthy(item, top[0])) {
        store.log(this.key, `"${item}" -> ${top[0].partNo} by name (only match)`);
        // Keep what it cost us to find. The next customer asking this way
        // is a vector lookup, not another search (core/parts.remember).
        parts.remember({ partNo: top[0].partNo, name: top[0].name }).catch(() => {});
        lines.push({ item: top[0].partNo, qty: 1, requested: item });
        continue;
      }
      if (top.length >= 1 && chatId) {
        // Several parts carry that name — front or rear, which car. Ask the
        // way the counter would rather than quoting one of them at random.
        store.log(this.key, `"${item}" -> ${top.length} catalogue matches; asking which`);
        const q = clarify.nextQuestion(top, [], chatId);
        if (q) {
          clarify.ask(chatId, { base: item, qty: 1 }, q);
          return q.text;
        }
        return clarify.offer(chatId, { base: item, qty: 1 }, top);
      }
      lines.push({ item, qty: 1 });
    }

    const resolved = await availability.resolve(lines);
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
    // Anything else the portal could not place - a part number with no close
    // match, or a part described in words ("cartrend wiper blade 16 number")
    // - goes to a person, with who is asking and everything they sent. What
    // that person said before about the same thing is answered straight away
    // (founder, 22 Sep). A customer on the sales desk is never sent there.
    const ask = [];
    const taught = new Map();
    if (m && !salesOrder.isSalesPerson(m.from)) {
      for (const l of resolved) {
        if (l.source !== 'unidentified') continue;
        const asked = l.requested || l.item;
        if (unknown.includes(l) && near.get(asked)) continue;
        const n = knowledge.findNote(asked);
        if (n) taught.set(l, n.answer);
        else ask.push(l);
      }
      const onBehalf = route.onBehalfOf(m);
      const who = onBehalf || (await customers.resolve(m.from).catch(() => null));
      for (const l of ask) {
        await escalation.create(this, {
          chatId: m.chatId,
          customerPhone: m.from,
          customerMessageId: m.id || null,
          item: l.requested || l.item,
          partNo: ai.partNumberIn(String(l.requested || l.item || '')) || null,
          reason: ai.partNumberIn(String(l.requested || l.item || '')) ? 'NOT_IN_CATALOGUE' : 'NO_PART_NUMBER',
          qty: l.qty || 1,
          kind: 'inquiry',
          customerName: (who && who.name) || m.profileName || m.chatName || null,
          context: m.body || null,
        });
      }
    }
    const shown = resolved
      .map((l) => {
        const asked = l.requested || l.item;
        if (taught.has(l)) return `${asked} - ${taught.get(l)}`;
        if (ask.includes(l)) return t(`${asked} - checking with the team, will confirm shortly`, `${asked} - team se check karke batata hoon`);
        if (!unknown.includes(l)) return availability.describe(l, m && m.chatId);
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
