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
const staffAgent = require('../agent/staff');
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
const replyReader = require('../core/replyReader');

// WHAT EACH STEP OF THE DISCOUNT SETUP WANTS, for Gemini to read the reply
// against (core/replyReader.readFormReply). The value it pulls out is then
// read by the step exactly as if it had been typed that way.
const YESNO = (what) => `A yes or a no: ${what}. value: "yes" or "no".`;
const DISCOUNT_STEP = {
  customer: (st) =>
    st.candidates
      ? 'Which customer: the list number of one shown (1-6), or a 10-digit mobile number, a GSTIN or a shop name. value: that number, GSTIN or name alone (a mobile as digits only).'
      : 'Which customer the discount is for: a 10-digit mobile number, a GSTIN or a shop name. value: that alone (a mobile as digits only).',
  confirmCustomer: (st) =>
    YESNO(`is ${(st.row && st.row.name) || 'the customer shown'} the right customer, and go on setting up their discount`) +
    ' If instead they send a different mobile or GST number, it is an answer with that number (digits / GSTIN only) as the value.',
  pickRule: (st) => `Which existing discount rule to change: its list number (1 to ${(st.rules || []).length}), or a new rule. value: the number, or "new".`,
  changePrice: () => 'The lowest price in rupees the part may be sold at. value: the number only.',
  changeValue: () => 'The new discount, in percent. value: the number only, e.g. 12.5.',
  confirmChange: () => YESNO('send this discount change for approval'),
  type: () => 'Whether the new rule is for a whole brand or one part number. value: "brand" or "part".',
  target: (st) =>
    st.draft && st.draft.kind === 'brand'
      ? 'The brand the discount is on (a car or parts maker, e.g. Maruti, Bosch, Cartrends). value: the brand name alone.'
      : 'The part number the discount is on. value: the part number alone, as written.',
  price: () => 'The lowest price in rupees the part may be sold at. value: the number only.',
  value: () => 'How much discount, in percent. value: the number only, e.g. 10.',
  minQty: () => 'The minimum quantity for the discount to apply; nothing given means 1 (that is a skip). value: a whole number.',
  maxQty: () => 'The maximum quantity the discount applies to, if any (none is a skip). value: a whole number.',
  minAmount: () => 'The minimum order amount in rupees, if any (none is a skip). value: the number only.',
  maxAmount: () => 'The maximum order amount in rupees, if any (none is a skip). value: the number only.',
  duration: () =>
    'How long the rule lasts from approval. value: like "30 days", "3 months", "1 year" (a bare number is days), or "always" for no end date.',
  confirm: () => YESNO('send this discount rule to the Dealer Portal for approval (a no starts the rule again)'),
  more: () => YESNO('set up another discount rule for this customer (a no means finished)'),
};
const approvalLog = require('../core/approvalLog');
const payments = require('../core/payments');
const advanceOrders = require('../core/advanceOrders');
const deliveryWatch = require('../core/deliveryWatch');
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
// "only avl item punch krna hai", "sirf available part", "jo stock mein hai"
// (26 Sep, live: Shubham asked five times; ORD-1069 still went to Prateek sir
// with all 58 lines).
const ONLY_AVAILABLE = /\b(avl|avail\w*|in[\s-]?stock|stock\s*(wale|vale|mein|me)|jo\s+(hai|h|stock))\b/i;

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
    // A customer in a group has a conversation of their own, keyed
    // "<group>~<phone>" (core/groupChat); whatever is sent to that key is
    // posted in the group.
    this.transport = require('../core/groupChat').wrapTransport(createTransport(this.key));
  }

  async start() {
    // pipeline/shadow watches beside the handler when AI_SHADOW=true, and
    // otherwise just calls it. It never changes what the handler returns.
    this.transport.onMessage((m) => require('../pipeline/shadow').around(this, m, () => this.handleMessage(m)));
    // An approval WhatsApp would not deliver is reported (core/deliveryWatch).
    if (this.transport.onDeliveryFailed) this.transport.onDeliveryFailed((info) => deliveryWatch.onFailed(this, info));
    // Discount rules waiting for the Super Admin on the portal: the agent is
    // told when one is approved (core/discountWatch).
    require('../core/discountWatch').start(this);
    // Orders punched and then cancelled on the portal: marked, and the
    // customer (and the salesman) told (core/cancelWatch).
    require('../core/cancelWatch').start(this);
    // A cheque that bounces or is rejected: the staff are told (core/chequeWatch).
    require('../core/chequeWatch').start(this);
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

    // A CUSTOMER IN A GROUP gets a conversation of their own (founder, 29
    // Sep): their cart, their account form, the agent's memory of them — never
    // the group's, shared with every other customer in it. The reply is still
    // posted in the group (core/groupChat). Staff in a group keep the group's
    // own chat, as before.
    if (m.isGroup && !m.groupId && !this.isOperator(m)) {
      m.groupId = m.chatId;
      m.chatId = require('../core/groupChat').memberKey(m.chatId, store.normPhone(m.from));
      require('../core/groupChat').noteName(m.chatId, m.profileName);
    }

    // m._desk: the STAFF AGENT (agent/staff) driving the desk. The message is
    // its instruction, not the staff member's words: nothing about it is
    // recorded, no typing is shown, the chat's language is not re-read from
    // it, and every reply goes to m._capture for the agent to read instead of
    // to WhatsApp.
    const viaAgent = Boolean(m._desk);

    // They wrote, so their 24h window is open: an approval sent to them in
    // the next day goes as plain text, with no template in front of it.
    if (!m.isGroup && !viaAgent) escalation.noteInbound(m.from);

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
    if (this.transport.sendTyping && m.id && !viaAgent) {
      Promise.resolve(this.transport.sendTyping(m.id)).catch(() => {});
    }

    // Which language does THIS customer write in? Read from the message they
    // just sent (a caption counts), remembered per chat, and used by every
    // reply below. A bare "16510M65L10 10" says nothing either way, so the
    // language they last showed us stands.
    if (!viaAgent) lang.note(m.chatId, m.body || '');
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
    if (!viaAgent && isOurOwnMessageBack(m.chatId, m.body)) {
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
    if (!viaAgent) {
      conversation.record(m.chatId, 'customer', incoming.forLog(m));
      rememberMsg(m.chatId, m.id, 'customer', m.body || '');
    }

    // They carried on talking, so the "send me a part number" nudge is no
    // longer wanted — whatever they said next IS the conversation.
    cancelNudge(m.chatId);
    cancelConfirmNudge(m.chatId);

    // Style for THIS customer — length, honorifics, emoji, their word for
    // "pcs". Never the facts: polish() throws its own work away if a digit or
    // a part number moved. See core/profiles.js.
    const say = (text) => profiles.polish(m.from, text);

    const reply = async (text) => {
      // The staff agent reads the desk's reply and writes its own.
      if (viaAgent && typeof m._capture === 'function') {
        m._capture(text);
        return true;
      }
      const out = say(text);
      const sentId = await this.transport.sendToChat(m.chatId, out);
      conversation.record(m.chatId, 'us', out);
      rememberMsg(m.chatId, sentId, 'us', out);
      return true;
    };

    // A yes/no to an ETA offer (core/advanceOrders) - customer or salesman -
    // is taken before anything else reads it.
    if (await this.answerEtaOffer(m, reply, t)) return true;

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
      // DISCOUNTS ARE SET UP BY THE SALES TEAM, not by customers (founder,
      // 25 Sep). A customer asking for one is answered by the agent, which
      // passes it to a person; a setup left open from before is dropped.
      if (discountSetup.pending(m.chatId)) discountSetup.cancel(m.chatId);
      return this.answerCustomer(m, asWritten, t);
    }

    // STAFF, UNDERSTOOD AND ANSWERED BY THE STAFF AGENT (agent/staff), which
    // drives everything below through the desk tool. Approvals, the helper's
    // answers, buttons and media stay with the desk directly (staff.takes).
    if (!viaAgent && staffAgent.takes(this, m)) {
      const done = await this.askStaffAgent(m);
      if (done !== null) return done;
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
      // THE ACCOUNTANT on a payment: "OK PAY-… <amount>" / "NO PAY-…".
      const payDecision = payments.readDecision(text);
      if (payDecision && payments.isAccountant(m.from)) return this.decidePayment(m, payDecision, reply, t);
      const decision = customerCreate.readDecision(text);
      if (decision && customerCreate.isApprover(m.from)) {
        if (/^DSC-/.test(decision.requestId)) return this.decideDiscount(m, decision, reply, t);
        if (/^ORD-/.test(decision.requestId)) return this.decideOrder(m, decision, reply, t);
        // A NEW CUSTOMER is approved only by the customer approvers (founder,
        // 29 Sep: Arun Sir). Anyone else is told whose it is, and nothing moves.
        if (!customerCreate.isAccountApprover(m.from)) return reply(this.accountApproverOnly(t));
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
        // A BARE "ok" / "haan" / "no" (26 Sep, live: Shad's "ok'" on
        // DSC-OCDJ got "koi order pending nahi hai"). Swiped onto a request,
        // it decides that one; typed on its own, it decides the request only
        // when exactly one is open - with several, it asks which.
        const bare = customerCreate.readBareDecision(text);
        if (bare) {
          const swiped = m.contextId && customerCreate.requestForMessage(m.contextId);
          // A new customer is not theirs to decide unless they are a customer approver.
          const open = this.openApprovals().filter((id) => !/^WA-/.test(id) || customerCreate.isAccountApprover(m.from));
          const pick = swiped && open.includes(swiped) ? [swiped] : open;
          if (pick.length === 1) {
            store.log(this.key, `"${text}" from ${m.from}: the only open request is ${pick[0]} - taken as ${bare.yes ? 'OK' : 'NO'}`);
            const d = { yes: bare.yes, requestId: pick[0] };
            if (/^DSC-/.test(d.requestId)) return this.decideDiscount(m, d, reply, t);
            if (/^ORD-/.test(d.requestId)) return this.decideOrder(m, d, reply, t);
            return this.decideNewCustomer(m, d, reply, t);
          }
          if (pick.length > 1) {
            const w = bare.yes ? 'OK' : 'NO';
            return reply(
              t(
                `${pick.length} requests are waiting — which one? Reply with its number:\n${pick.map((id) => `*${w} ${id}*`).join('\n')}`,
                `${pick.length} request pending hain — kaunsa? Number ke saath bhejiye:\n${pick.map((id) => `*${w} ${id}*`).join('\n')}`,
              ),
            );
          }
        }
        const rid = (m.contextId && customerCreate.requestForMessage(m.contextId)) || customerCreate.requestIdIn(text);
        if (rid && /^WA-/.test(rid)) return this.noteOnNewCustomer(m, rid, text, reply, t);
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

    // Said another way than the word list knows: Gemini reads it (29 Sep, live:
    // Nirmal's "Costamber creat karni h" got small talk instead of the form).
    // Only for the sales team - a customer is answered by the agent - and only
    // when the list did not already say yes.
    const listSaysCreate = createAnswer === 'yes' || customerCreate.wantsToStart(text) || customerCreate.wantsSomeoneElse(text);
    const geminiSaysCreate =
      !listSaysCreate && !customerCreate.pending(m.chatId) && (customerCreate.agentName(m.from) || salesOrder.isSalesPerson(m.from)) && !ai.partNumberIn(text)
        ? (await replyReader.wantsNewAccount(text, { phone: store.normPhone(m.from) }).catch(() => null)) === true
        : false;
    if (listSaysCreate || geminiSaysCreate) {
      createAsk.delete(m.chatId);
      // A SALES AGENT is never told they already have an account: opening
      // one for a customer standing at their counter is their job, and the
      // account goes on the portal under their name.
      const agent = customerCreate.agentName(m.from) || (salesOrder.isSalesPerson(m.from) ? 'sales team' : null);
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
      const opened = customerCreate.start(m.chatId, m.from, t, { forSomeoneElse: forElse });
      // THE NUMBER IN THE REQUEST (founder, 28 Sep): "customer bana do
      // 9812345678" is that customer's account - their number is the form's
      // first answer, not asked for again. The form's own checks still run on
      // it (already a customer? then it says so and asks for another).
      const key = (agent || forElse) && salesOrder.findKeyIn(text);
      if (key && key.phone && customerCreate.pending(m.chatId)) {
        const step = await customerCreate.answer(m.chatId, { ...m, body: key.phone.slice(-10) }, key.phone.slice(-10), t);
        if (step && step.reply) {
          store.log(this.key, `${m.from}: account form for ${key.phone.slice(-10)}, the number in the request`);
          return reply(t(`Opening an account for ${key.phone.slice(-10)}.`, `${key.phone.slice(-10)} ka account bana rahe hain.`) + '\n\n' + step.reply);
        }
      }
      return reply(opened);
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
      if (open && open.lines.length && text.length <= 80 && ONLY_WORD.test(text) && ONLY_AVAILABLE.test(text)) {
        return this.keepAvailable(m, text, reply, t, open);
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

        // ONE INVOICE ON CREDIT (founder, 26 Sep): a salesman's order for a
        // customer who still owes Rs 1 or more is held — the customer gets the
        // amount and the QR, the accountant confirms the payment, and then the
        // order goes on by itself (to the Sales Heads while placing is off).
        const heldFor = salesOrder.activeCustomer(m.chatId);
        if (heldFor && order.portalCustomer && order.portalCustomer.buyerId) {
          const pc = order.portalCustomer;
          const custPhone = String(pc.phone || (pc.raw && (pc.raw.phone || pc.raw.mobile)) || '').replace(/\D/g, '').slice(-10);
          const hold = await this.holdForPayment(order, pc, {
            customerPhone: custPhone.length === 10 ? '91' + custPhone : null,
            agent: customerCreate.agentName(m.from) || null,
          }).catch(() => null);
          if (hold && hold.chequeAmount > 0) {
            // A cheque is in but does not cover it all: the total, the
            // cheque, and what is still to pay (founder, 29 Sep).
            return reply(
              t(
                `${heldFor.name} — the cheque is counted, but the due is not cleared yet:

${payments.breakdown(hold.detail, t)}

${order.id} is on hold until the remaining ${payments.money(hold.due)} is paid${custPhone.length === 10 ? '; the breakdown and the payment QR went to the customer' : ''}. Once our accountant confirms the payment it goes for approval, and you get the order number here.`,
                `${heldFor.name} — cheque gin liya hai, par baaki abhi pura nahi hua:

${payments.breakdown(hold.detail, t)}

Baaki ${payments.money(hold.due)} pay hone tak ${order.id} hold pe hai${custPhone.length === 10 ? '; ye detail aur payment QR customer ko bhej diya' : ''}. Accountant ke confirm karte hi approval ke liye jayega aur order number yahin milega.`,
              ),
            );
          }
          if (hold) {
            return reply(
              t(
                `${heldFor.name} still owes ${payments.money(hold.due)} — with one invoice on credit, no new order until it is paid. ${order.id} is on hold${custPhone.length === 10 ? '; the amount and the payment QR went to the customer' : ''}. Once our accountant confirms the payment it goes for approval, and you get the order number here.`,
                `${heldFor.name} ka ${payments.money(hold.due)} abhi baaki hai — ek invoice credit billing hai, isliye pay hone tak naya order nahi. ${order.id} hold pe hai${custPhone.length === 10 ? '; amount aur payment QR customer ko bhej diya' : ''}. Accountant ke confirm karte hi approval ke liye jayega aur order number yahin milega.`,
              ),
            );
          }
        }

        try {
          const result = await orders.confirm(order);

          // Two "yes" in the same second - a duplicate webhook, or a double
          // tap. The first one is already at the portal; a second punch would
          // be a second sales order.
          if (result.busy) {
            return reply(t('One moment — I am placing it now.', 'Ek minute — laga raha hoon.'));
          }
          // No customer on the order: the portal would bill nobody.
          if (result.noCustomer) {
            return reply(t('Which customer is this order for? Send their name first.', 'Ye order kis customer ka hai? Pehle customer ka naam bhejiye.'));
          }

          // Testing mode: the draft is kept exactly as it is, so the same YES
          // will place it the moment ORDER_CONFIRM_ENABLED is turned on.
          if (result.blocked) {
            // A SALESMAN'S ORDER while placing is switched off goes to the
            // Sales Heads, like a customer's: "OK ORD-…" places it and the
            // portal order number comes back here. 26 Sep, live: it was
            // answered "abhi testing chal rahi hai" and dropped.
            const forCustomer = salesOrder.activeCustomer(m.chatId);
            if (forCustomer && order.portalCustomer && order.portalCustomer.buyerId) {
              const sent = await this.requestOrderApproval(order, { by: customerCreate.agentName(m.from) || m.from });
              if (sent) {
                return reply(
                  this.chequeCoveredNote(order, t) +
                    t(
                      `${forCustomer.name}'s order (${order.id}) has gone to the Sales Head for approval. Once approved it is placed on the portal and you get the order number here.`,
                      `${forCustomer.name} ka order (${order.id}) Sales Head ko approval ke liye bhej diya. Approve hote hi portal pe place hoga aur order number yahin milega.`,
                    ),
                );
              }
            }
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
    if (!require('../core/ai').modelAvailable() && !understandMod._stubbed()) return null;
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
    if (ONLY_AVAILABLE.test(text)) return this.keepAvailable(m, text, reply, t, order);
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

  // "Only available items": drop every line with nothing in stock and cut the
  // rest down to what is there, so the list - and the approval Prateek sir
  // gets - is exactly what will be punched.
  async keepAvailable(m, text, reply, t, order) {
    const n = order.lines.length;
    const have = (l) => l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0;
    if (!order.lines.some(have)) {
      store.log(this.key, `"${text}" - nothing in stock on ${order.id}`);
      return reply(t(`None of the ${n} items is in stock right now, so there is nothing to place.`, `Sir, ${n} mein se abhi koi bhi item stock mein nahi hai - punch karne ko kuch nahi hai.`));
    }
    const dropped = order.lines.filter((l) => !have(l));
    // Kept for the customer's "placed" message: what could not be punched.
    order.leftOut = order.leftOut || [];
    // ...and as lines, so they can be offered to the customer with an ETA.
    order.leftOutLines = order.leftOutLines || [];
    for (const l of dropped) order.leftOut.push(`${l.partNo || l.item} × ${l.qty}`);
    for (const l of dropped) if (l.source === 'unavailable') order.leftOutLines.push({ partNo: l.partNo || l.item, item: l.item, qty: Number(l.qty) || 1, price: l.rate != null ? l.rate : l.price, mrp: l.mrp });
    for (const l of dropped) orders.removeItem(order, l.partNo || l.item);
    let cut = 0;
    for (const l of order.lines) {
      const a = Number(l.available) || 0;
      if (a > 0 && Number(l.qty) > a) {
        order.leftOut.push(`${l.partNo || l.item} × ${Number(l.qty) - a} (only ${a} in stock)`);
        order.leftOutLines.push({ partNo: l.partNo || l.item, item: l.item, qty: Number(l.qty) - a, price: l.rate != null ? l.rate : l.price, mrp: l.mrp });
        l.qty = a;
        cut++;
      }
    }
    cancelConfirmNudge(m.chatId);
    order.confirmAskedAt = new Date().toISOString();
    store.save();
    store.log(this.key, `"${text}" - kept ${order.lines.length} available line(s) of ${n} on ${order.id} (${dropped.length} dropped, ${cut} cut to stock)`);
    const note = t(
      `Removed ${dropped.length} item(s) not in stock${cut ? `; ${cut} cut to the quantity in stock` : ''}.`,
      `${dropped.length} item jo stock mein nahi hain hata diye${cut ? `; ${cut} ki quantity stock jitni kar di` : ''}.`,
    );
    return reply(
      t(
        `Only the available items, then:\n${orders.summary(order)}\n\n${note}\nShall I send this for approval?`,
        `Sirf available items:\n${orders.summary(order)}\n\n${note}\nYe approval ke liye bhej dun?`,
      ),
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
    // Only the customer approvers - Arun Sir (founder, 29 Sep).
    const approvers = customerCreate.accountApprovers();
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
        deliveryWatch.track(sentId, { ref: form.answers.requestId, to: phone, requesterChat: this.isOperator(m) ? m.chatId : null });
      } catch (e) {
        store.log(this.key, `could not reach approver ${phone}: ${String((e && e.message) || e).slice(0, 90)}`);
      }
    }
    store.log(this.key, `${form.answers.requestId} sent to ${approvers.length} approver(s)`);
    approvalLog.record({ kind: 'account', id: form.answers.requestId, event: 'requested', by: form.byName || form.answers.createdByName || 'customer (' + m.from + ')', ...approvalLog.accountFacts(form.answers) });
    await reply(
      t(
        `Thank you — sent for approval (${form.answers.requestId}). You will hear as soon as it is open.`,
        `Shukriya — approval ke liye bhej diya (${form.answers.requestId}). Account khulte hi bata dunga.`,
      ),
    );
    // A SALES-TEAM AGENT who opened it sets its discount now, while the
    // approval runs (founder, 25 Sep: only the sales team sets discounts). A
    // customer registering themselves is not asked. Every rule still goes to
    // the Sales Head before the portal is touched.
    if (form.byName) return this.startDiscountSetup(m, form, reply, t);
    return true;
  }


  // The Odoo partner the portal linked to this number's account. The portal
  // links it within seconds of creating the account, so it is asked a few
  // times before being reported missing.
  // -> { partnerId } or { partnerId: null, why }
  async odooLinkOf(phone, { tries = 4, waitMs = 5000 } = {}) {
    let why = null;
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, waitMs));
      try {
        customers.forget(phone);
        const c = await portal.lookupCustomer(phone);
        const id = c && c.raw && Number(c.raw.odoo_partner_id);
        if (id > 0) return { partnerId: id };
        why = c && c.found ? 'no odoo_partner_id on the account' : 'the account is not found by its number yet';
      } catch (e) {
        why = String((e && e.message) || e).slice(0, 80);
      }
    }
    return { partnerId: null, why };
  }

  // A GSTIN that would not verify. Nothing is created and the customer is
  // not left arguing with a form — the Sales Heads are told what was tried
  // and decide whether this firm is opened by hand.
  async reviewNewCustomer(m, step, reply, t) {
    const form = step.form;
    const approvers = customerCreate.accountApprovers();
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
        const sentId = await this.transport.sendText(phone, text);
        customerCreate.noteSummary(sentId, form.answers.requestId);
        deliveryWatch.track(sentId, { ref: form.answers.requestId, to: phone, requesterChat: this.isOperator(m) ? m.chatId : null });
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
        approvalLog.record({ kind: 'account', id: decision.requestId, event: 'rejected', by: who, note: 'GST review', ...approvalLog.accountFacts(req.answers) });
        await this.transport.sendText(
          req.answers.phone,
          t(
            'Our team needs to check a few things before opening the account — someone will call you.',
            'Account kholne se pehle team ko kuch check karna hai — aapko call aayega.',
          ),
        );
        await this.tellAccountDecision(m, `❌ ${req.answers.name || req.answers.phone} (${decision.requestId}) — GST not verified, rejected by ${who}. The customer was told we will call.`);
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
      approvalLog.record({ kind: 'account', id: decision.requestId, event: 'rejected', by: who, ...approvalLog.accountFacts(req.answers) });
      await escalation.ensureWindow(this.transport, req.answers.phone, 'Your account — details follow', req.answers.name || 'Account').catch(() => {});
      await this.transport.sendText(
        req.answers.phone,
        t(
          'Our team needs a little more information before opening the account — someone will call you.',
          'Account ke liye thodi aur jaankari chahiye — team aapko call karegi.',
        ),
      );
      await this.tellAccountAgent(req, (tt) => tt(`❌ The account request for ${req.answers.name || req.answers.phone} (${decision.requestId}) was not approved by ${who}. The customer has been told.`, `❌ ${req.answers.name || req.answers.phone} ka account request (${decision.requestId}) ${who} ne approve nahi kiya. Customer ko bata diya hai.`));
      await this.tellAccountDecision(m, `❌ New customer *${req.answers.name || req.answers.phone}* (${decision.requestId}) — rejected by ${who}.${req.byName ? ' Opened by ' + req.byName + '.' : ''} The customer${req.byName ? ' and the agent have' : ' has'} been told.`);
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

      await escalation.ensureWindow(this.transport, req.answers.phone, 'Your account — details follow', req.answers.name || 'Account').catch(() => {});
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
      // The agent who opened it hears it too - with the rules below when
      // there are some, on its own otherwise.
      if (!waiting.length) {
        await this.tellAccountAgent(req, (tt) => tt(`✅ ${req.answers.name || req.answers.phone}'s account is open (${account.username}) — approved by ${who}. The customer has been told.`, `✅ ${req.answers.name || req.answers.phone} ka account khul gaya (${account.username}) — ${who} ne approve kiya. Customer ko bata diya hai.`));
      }
      if (waiting.length) {
        const lines = [];
        for (const r of waiting) {
          if (r.status !== 'approved') {
            lines.push(`⏳ ${r.rule.ruleName} — ${t('waiting for its own approval', 'approval ka wait')} (${r.id})`);
            continue;
          }
          const made = await this.createDiscountFor(r);
          if (made.ok) discountSetup.drop(r.id);
          lines.push(
            !made.ok
              ? `⚠️ ${made.name} — ${made.why}`
              : made.live
                ? '✅ ' + made.name
                : `📨 ${made.name} — ${t('on the Dealer Portal for a Super Admin to approve', 'Dealer Portal pe Super Admin ke approval ke liye')} (rule #${made.ruleId})`,
          );
        }
        try {
          await this.transport.sendToChat(req.chatId, t(`${req.answers.name} is approved. Discount rules:\n${lines.join('\n')}`, `${req.answers.name} approve ho gaya. Discount rules:\n${lines.join('\n')}`));
        } catch (e) {
          /* the rules exist either way */
        }
      }
      // The older "account ban gaya" list, only when nobody is set to hear of
      // customer decisions: those go ONLY to Prateek Sir, the agent and the
      // customer now (founder, 29 Sep; tellAccountDecision below).
      const oldNotify = Object.keys(config.creation.accountDecisionNotify || {}).length ? [] : Object.keys(config.creation.notify);
      for (const phone of oldNotify) {
        if (store.normPhone(phone) === store.normPhone(m.from)) continue;
        try {
          await this.transport.sendText(phone, `${req.answers.name} ka account ban gaya (${account.username}) — ${who} ne approve kiya.`);
        } catch (e) {
          /* a notification nobody received must not fail the creation */
        }
      }
      // ON ODOO TOO. The portal creates the Odoo partner itself when it opens
      // an account (MIYA JI MOTORS: partner 51815, six seconds before the
      // account; SHREE SHYAM ENTERPRISES: 51818). An account with no partner
      // can take orders that never become an Odoo SO, so it is checked here
      // and the Sales Head is told plainly if it is missing.
      let odoo = await this.odooLinkOf(req.answers.phone);
      // The portal did not make it: the bot makes it — or finds the one that
      // is already there by GSTIN or phone — and asks the portal again, which
      // links a partner it can match on its own.
      if (!odoo.partnerId) {
        try {
          const made = await require('../integrations/odoo').ensurePartner(account);
          store.log(this.key, `${decision.requestId}: Odoo partner ${made.id} ${made.created ? 'created by the bot' : 'found by ' + made.matchedBy}`);
          const again = await this.odooLinkOf(req.answers.phone, { tries: 3 });
          odoo = again.partnerId
            ? again
            : { partnerId: null, made: made.id, why: `created on Odoo as partner ${made.id}, but the portal has not linked it to the account yet` };
        } catch (e) {
          odoo.why = 'Odoo: ' + String((e && e.message) || e).slice(0, 80);
        }
      }
      const odooNote = odoo.partnerId
        ? t(` On Odoo as partner ${odoo.partnerId}.`, ` Odoo pe bhi hai (partner ${odoo.partnerId}).`)
        : t(
            `\n⚠️ Not on Odoo yet — the portal has not linked an Odoo customer to it${odoo.why ? ` (${odoo.why})` : ''}. Orders will not reach Odoo until it is linked.`,
            `\n⚠️ Odoo pe abhi nahi hai — portal ne Odoo customer link nahi kiya${odoo.why ? ` (${odoo.why})` : ''}. Link hone tak order Odoo tak nahi jayenge.`,
          );
      store.log(this.key, `${decision.requestId}: Odoo ${odoo.partnerId ? 'partner ' + odoo.partnerId : 'NOT linked' + (odoo.why ? ' — ' + odoo.why : '')}`);
      // HOME BRANCH, from the location (founder, 25 Sep): Rajasthan ->
      // Mansarovar, anywhere else -> Bijwasan. The account was opened with it;
      // checked on the portal and set there if it did not take.
      let branchNote = '';
      try {
        const want = account.branchId || dataEntry.branchFor(req.answers);
        const created = (await portal.searchAccounts(req.answers.name).catch(() => [])).find((r) => String(r.phone || '').slice(-10) === String(req.answers.phone || '').slice(-10));
        if (created && want) {
          let now = await portal.homeBranchOf(created.id, created.name).catch(() => null);
          if (now && now.id !== Number(want)) {
            const fixed = await portal.setHomeBranch(created.id, created.name, want).catch(() => null);
            now = (fixed && fixed.now) || now;
          }
          branchNote = t(` Home branch: ${dataEntry.branchName(now ? now.id : want)}.`, ` Home branch: ${dataEntry.branchName(now ? now.id : want)}.`);
        }
      } catch (e) {
        store.log(this.key, `${decision.requestId}: home branch not checked: ${String((e && e.message) || e).slice(0, 80)}`);
      }
      approvalLog.record({ kind: 'account', id: decision.requestId, event: 'approved', by: who, username: account.username, odooPartner: odoo.partnerId || null, ...approvalLog.accountFacts(req.answers) });
      await this.tellAccountDecision(m, `✅ New customer *${req.answers.name || req.answers.phone}* (${decision.requestId}) — approved by ${who}, account ${account.username} is open.${req.byName ? ' Opened by ' + req.byName + '.' : ''} The customer${req.byName ? ' and the agent have' : ' has'} been told.`);
      return reply(t(`Done — ${req.answers.name} is open (${account.username}).`, `Ho gaya — ${req.answers.name} ka account khul gaya (${account.username}).`) + branchNote + odooNote);
    } catch (e) {
      // The request STAYS parked: a failed create is worth another try, and
      // losing the form would mean asking the customer everything again.
      const why = String((e && e.message) || e).slice(0, 160);
      store.log(this.key, `${decision.requestId} create FAILED: ${why}`);
      return reply(t(`Could not create it: ${why}\nThe request is still here — try *OK ${decision.requestId}* again.`, `Nahi ban paya: ${why}\nRequest abhi bhi hai — dobara *OK ${decision.requestId}* bhejiye.`));
    }
  }

  // A NEW CUSTOMER APPROVED OR REJECTED (founder, 29 Sep): Prateek Sir is told
  // (config.creation.accountDecisionNotify), besides the agent and the
  // customer - never the one who decided.
  async tellAccountDecision(m, text) {
    for (const phone of Object.keys(config.creation.accountDecisionNotify || {})) {
      if (store.normPhone(phone) === store.normPhone(m.from)) continue;
      try {
        await escalation.ensureWindow(this.transport, phone, 'New customer decided — details follow').catch(() => {});
        await this.transport.sendText(phone, text);
      } catch (e) {
        store.log(this.key, `could not tell ${phone} of the customer decision: ${String((e && e.message) || e).slice(0, 80)}`);
      }
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
      for (const phone of customerCreate.accountApprovers()) {
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
  // portal is touched (founder, 22 Sep). A part-wise rule is set in %, like
  // a brand rule (founder, 29 Sep - no longer by the lowest sale price): the
  // portal's MRP is shown, the % is asked, and the price it sells at is shown.
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
        payments.isAccountant(p) ||
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
    // THE MODEL IS DOWN (credits, quota, key): the admins are told once, with
    // why — not Prateek sir once per customer message. 26 Sep, live: Gemini
    // answered 402 "prepayment credits are depleted" and every "Hi" became a
    // question to him.
    await this.alertModelDown().catch(() => {});

    // A GREETING or a courtesy is answered here, never sent to a person.
    const said = String(text || '').trim();
    if (!attachment && said && (GREETING.test(said) || /^(ok+|okay|thik|theek|theek hai|thik hai|thanks?|thank you|thx|dhanyawad|shukriya|haan|ha|ji|hmm+|👍)[\s!.]*$/i.test(said))) {
      store.log(this.key, `agent could not answer ${m.from} — greeting answered without it: "${said.slice(0, 30)}"`);
      return reply(
        GREETING.test(said)
          ? t('Hello! Send me the part number and quantity — I will check it for you.', 'Namaste! Part number aur quantity bhejiye — main check karke batata hoon.')
          : t('👍', '👍'),
      );
    }

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

  // Once per 6 hours while the model cannot run: the admins, with the reason.
  async alertModelDown() {
    const f = agent.lastFailure && agent.lastFailure();
    if (!f || !f.down) return;
    const slot = require('../core/chatState').slot('agent.downAlert');
    const last = slot.get('last') || 0;
    if (Date.now() - last < 6 * 60 * 60 * 1000) return;
    slot.set('last', Date.now());
    const credits = /credits? (are )?depleted|402|billing|prepay/i.test(f.message);
    const text = [
      '⚠️ *The bot\'s AI is down* — customers are not getting proper answers.',
      credits ? 'Reason: the Gemini account is out of credit (HTTP 402 "prepayment credits are depleted").' : 'Reason: ' + f.message.slice(0, 200),
      credits ? 'Fix: add credits at https://ai.studio/projects (Billing).' : 'Check the Gemini key / quota.',
      'Until then: greetings are answered by the bot; other messages go to a person.',
    ].join('\n');
    for (const n of config.adminNumbers || []) {
      try {
        await escalation.ensureWindow(this.transport, n, 'Bot alert — details follow');
        await this.transport.sendText(n, text);
      } catch (e) {
        store.log(this.key, `model-down alert to ${n} failed: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    store.log(this.key, 'model is down — admins alerted: ' + f.message.slice(0, 120));
  }

  // ONE STAFF MESSAGE TO THE STAFF AGENT. -> true when answered, null when
  // the desk should answer it the old way (the model could not run and had
  // done nothing yet). Once the desk has acted, it is never asked twice: if
  // the model then fails, the desk's own words are sent.
  async askStaffAgent(m) {
    const send = async (text) => {
      const id = await this.transport.sendToChat(m.chatId, text);
      conversation.record(m.chatId, 'us', text);
      rememberMsg(m.chatId, id, 'us', text);
      return true;
    };
    const res = await staffAgent.handle(this, m).catch((e) => {
      store.log(this.key, 'staff agent threw: ' + String((e && e.message) || e).slice(0, 120));
      return { handled: false, deskCalls: 0, deskSaid: [] };
    });
    if (res.handled && res.reply) return send(res.reply);
    if (res.deskCalls > 0) {
      const words = (res.deskSaid || []).filter(Boolean);
      store.log(this.key, `staff agent gave no usable reply after ${res.deskCalls} desk call(s) — the desk's own words are sent`);
      if (words.length) return send(words.join('\n\n'));
      return true;
    }
    store.log(this.key, `staff agent could not run for ${m.from} — the desk answers directly`);
    return null;
  }

  // ONE MESSAGE TO THE AGENT, and whatever it says back.
  //
  // -> the reply's result when the agent answered (the caller returns it), or
  //    null when it could not run.
  async askAgent(m, text, reply, t, attachment) {
    const who = await customers.resolve(m.from).catch(() => null);
    // In a group, replies are addressed by the name their account carries.
    if (m.groupId && who && who.found && who.name) require('../core/groupChat').noteName(m.chatId, who.name);
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
    // What was last asked, for Gemini to read the next reply against.
    const st = discountSetup.get(m.chatId);
    if (st) {
      st.lastAsked = String(text || '').slice(0, 600);
      discountSetup.save(m.chatId, st);
    }
    if (m._capture) {
      m._capture(text);
      return true;
    }
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

  // Every request waiting on a Sales Head: accounts, discounts, orders.
  // Only the last three days: one left unanswered last week must not make
  // every bare "ok" ambiguous.
  // "Customer approvals are with Arun Sir" - to an approver who is not one.
  accountApproverOnly(t) {
    const own = config.creation.accountApprovers || {};
    const names = customerCreate
      .accountApprovers()
      .map((p) => own[p] || customerCreate.approverName(p))
      .join(', ');
    return t(`New-customer approvals are with ${names} now — nothing was changed.`, `Naye customer ka approval ab ${names} karte hain — kuch change nahi hua.`);
  }

  openApprovals(now = Date.now()) {
    const fresh = (at) => {
      const ms = typeof at === 'number' ? at : Date.parse(at || '');
      return Number.isFinite(ms) && now - ms < 3 * 86400000;
    };
    const ids = [];
    for (const id of customerCreate.parkedIds()) {
      const p = customerCreate.parked(id);
      if (p && fresh(p.at)) ids.push(String(id).toUpperCase());
    }
    for (const [id, r] of discountSetup.requests) {
      if (!r || r.status === 'approved' || r.status === 'rejected' || !fresh(r.at)) continue;
      if (r.accountRequestId && customerCreate.parked(r.accountRequestId)) continue; // not sent yet: waits on its account
      ids.push(String(id).toUpperCase());
    }
    for (const o of store.orders()) if (o.status === 'approval' && fresh(o.approvalAskedAt)) ids.push(String(o.id).toUpperCase());
    return [...new Set(ids)];
  }

  // track = { ref, requesterChat }: an approval request, watched for delivery
  // (core/deliveryWatch) - the one who asked hears if a Sales Head never got it.
  async toApprovers(text, track = null) {
    let sent = 0;
    for (const phone of Object.keys(config.creation.approvers)) {
      try {
        // Outside the 24h window a plain text is silently dropped (escalation.ensureWindow).
        await escalation.ensureWindow(this.transport, phone, 'Discount approval coming — details follow');
        const id = await this.transport.sendText(phone, text);
        if (track) deliveryWatch.track(id, { ...track, to: phone });
        // A swipe-reply onto it names this request (customerCreate.requestForMessage).
        if (track && track.ref) customerCreate.noteSummary(id, track.ref);
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
  // ONLY THE SALES TEAM SETS UP A DISCOUNT, and only for a customer that
  // exists (founder, 25 Sep). The agent names the customer by phone or GST
  // number (or name), is shown everything the portal has on them, and says
  // yes before the setup starts. A customer that is not on the portal yet is
  // opened first ("customer bana do"), which asks for its discount at the end.
  async startDiscountChange(m, text, reply, t) {
    const agent = customerCreate.agentName(m.from);
    const staff = Boolean(agent) || salesOrder.isSalesPerson(m.from) || this.isOwnTeam(m);
    if (!staff) {
      return reply(
        t(
          'Discounts are set up by our sales team — please speak to your sales representative.',
          'Discount hamari sales team set karti hai — apne sales representative se baat kijiye.',
        ),
      );
    }
    const st = { mode: 'change', step: 'customer', draft: {}, count: 0, setBy: agent || m.profileName || m.from };
    // THE CUSTOMER IN THE REQUEST ITSELF (founder, 28 Sep): "discount create
    // karna hai 9122781913" is that customer's - their rules come back at once,
    // with no "whose discount?" and no "this one?", because the desk just said.
    const key = salesOrder.findKeyIn(text);
    if (key) {
      const rows = await salesOrder.findByKey(key).catch(() => []);
      if (rows.length === 1) {
        st.row = rows[0];
        st.step = 'confirmCustomer';
        discountSetup.save(m.chatId, st);
        const card = await salesOrder.customerCard(rows[0], t);
        store.log(this.key, `${m.from}: discount for ${rows[0].name}, named by number in the request`);
        return this.answerDiscount({ ...m, body: 'haan', buttonId: 'DSC_YES' }, 'haan', (x) => reply(card + '\n\n' + x), t);
      }
      if (rows.length > 1) {
        st.candidates = rows.slice(0, 9);
        discountSetup.save(m.chatId, st);
        return reply(t('Which account?\n', 'Kaunsa account?\n') + st.candidates.map((r, i) => `${i + 1}. ${r.name}${r.state_name ? ' (' + r.state_name + ')' : ''}`).join('\n'));
      }
      const what = key.phone ? key.phone.slice(-10) : key.gst;
      discountSetup.save(m.chatId, st);
      return reply(t(`No customer on the portal with ${what}. Send the right customer's number.`, `${what} pe portal mein koi customer nahi mila. Sahi customer ka number bhejiye.`));
    }
    // The customer the desk is already on - being ordered for, or just looked
    // up - is offered, with one yes/no, instead of asking for the number again.
    const picked = salesOrder.activeCustomer(m.chatId);
    if (picked && picked.buyerId) {
      return this.confirmDiscountCustomer(m, st, { ...(picked.raw || {}), id: picked.buyerId, name: picked.name }, reply, t);
    }
    const known = salesOrder.lastLookedUp(m.chatId);
    if (known && known.id) return this.confirmDiscountCustomer(m, st, known, reply, t);
    discountSetup.save(m.chatId, st);
    return reply(
      salesOrder.mobileOnly()
        ? t("Whose discount? Send the customer's 10-digit mobile number.", 'Kis customer ka discount? Customer ka 10 digit mobile number bhejiye.')
        : t(
            "Whose discount? Send the customer's phone number or GST number (or the name).",
            'Kis customer ka discount? Customer ka phone number ya GST number bhejiye (ya naam).',
          ),
    );
  }

  // The customer, in full, and one question: this one?
  async confirmDiscountCustomer(m, st, row, reply, t) {
    st.row = row;
    st.step = 'confirmCustomer';
    discountSetup.save(m.chatId, st);
    const card = await salesOrder.customerCard(row, t);
    return reply(card + '\n\n' + t('Set up the discount for this customer? (yes / no)', 'Isi customer ka discount setup karein? (haan / nahi)'));
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
      minQty: r.min_qty || null,
      maxQty: r.max_qty || null,
      validFrom: r.valid_from || null,
      validTo: r.valid_to || null,
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

  // A CHANGE TO A RULE THAT EXISTS, sent as soon as the new figure is known.
  // There used to be one more "Send for approval?" first, and a customer who
  // wrote anything else next — "Maruti part btao" — had it read as a no: the
  // change was dropped and the Sales Head never heard of it (25 Sep, live).
  // The Super Admin's approval on the portal is the check; this one only
  // lost requests.
  async sendDiscountChange(m, st, submit, reply, t) {
    const r = st.rule;
    const d = st.draft;
    discountSetup.cancel(m.chatId);
    const askedByCustomer = /^customer/.test(String(st.setBy || ''));
    const { sent } = await submit('change', {
      ruleId: r.id,
      oldValue: r.value,
      oldName: r.name,
      oldRule: { minQty: r.minQty, maxQty: r.maxQty, validFrom: r.validFrom, validTo: r.validTo },
      customerPhone: askedByCustomer ? m.from : null,
    });
    const head = `${r.name || d.target}: ${r.value}% → ${d.value}%.`;
    if (!sent.ok) return reply(head + '\n' + t(`Could not put it on the portal: ${sent.why}. Please try again.`, `Portal pe nahi daal paya: ${sent.why}. Dobara try kijiye.`));
    return reply(head + '\n' + this.discountSentText(sent, t));
  }

  // The portal's MRP for a part, for the price question.
  async mrpOf(partNo, accountId) {
    try {
      const got = await rates.prices([partNo], { ctx: accountId ? { buyerId: accountId } : null });
      const p = got.get(rates.norm(partNo));
      return p && p.mrp ? Number(p.mrp) : null;
    } catch (e) {
      return null;
    }
  }

  // A yes/no step of the discount setup, answered in the agent's own words:
  // the model reads the reply against the question (core/replyReader). A
  // tapped button needs no reading.
  // -> { answer: 'yes'|'no'|'unclear'|'new', say? } — `say` is Gemini's own
  // line back when it cannot tell, used instead of the same question again.
  async readDiscountYesNo(m, said, question, options) {
    if (m.buttonId === 'DSC_YES' || m.buttonId === 'DSC_MORE_YES') return { answer: 'yes' };
    if (m.buttonId === 'DSC_NO' || m.buttonId === 'DSC_MORE_NO') return { answer: 'no' };
    // Already read at the top of answerDiscount: only an answer gets here,
    // and its value is the yes or the no.
    if (m._read) {
      const v = String(m._read.value || '').toLowerCase();
      return { answer: v === 'yes' || v === 'no' ? v : 'unclear' };
    }
    return replyReader.readReply({ question, reply: said, options, phone: store.normPhone(m.from) });
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

    // GEMINI READS THE REPLY (founder, 29 Sep): against what this step wants
    // and the chat so far. What it makes of it replaces the patterns below;
    // the value it pulls out goes through each step's own checks, as typed.
    // A tapped button needs no reading; no model, and the patterns read it.
    let quit = discountSetup.LATER.test(said) || m.buttonId === 'DSC_LATER';
    let read = null;
    if (!m.buttonId && said && DISCOUNT_STEP[st.step]) {
      read = await replyReader.readFormReply({
        flow: 'discount rule setup for a customer',
        step: DISCOUNT_STEP[st.step](st),
        question: st.lastAsked,
        reply: said,
        phone: store.normPhone(m.from),
      });
    }
    if (read) {
      quit = read.intent === 'quit';
      if (read.intent === 'new') {
        // At "another rule?" the setup is over either way (see 'more').
        if (st.step === 'more') discountSetup.cancel(m.chatId);
        return null;
      }
      if (read.intent === 'unclear') return next(st.step, read.say || st.lastAsked || t('Sorry, once more?', 'Samajh nahi aaya — ek baar phir bhejiye?'));
      if (read.intent === 'skip') said = 'skip';
      if (read.intent === 'answer') said = read.value;
      m._read = read;
    }

    if (quit) {
      discountSetup.cancel(m.chatId);
      store.log(this.key, `discount setup left (${st.count} rule(s) sent for approval)`);
      return reply(
        st.count
          ? t(`Done — ${st.count} discount rule(s) are on the Dealer Portal for a Super Admin's approval.`, `Theek hai — ${st.count} discount rule Dealer Portal pe Super Admin ke approval ke liye hain.`)
          : t('No discount rule, then. It can be set later.', 'Theek hai, koi discount rule nahi. Baad mein set ho sakta hai.'),
      );
    }
    // A price question or a part order in the middle is not an answer here.
    // (Only when Gemini did not read it: it tells a question from an answer.)
    if (!read && !m.buttonId && /\b(kitne|kitna|rate|stock|hai kya)\b|\?\s*$/i.test(said) && !['confirm', 'confirmChange'].includes(st.step)) return null;

    // The request, filed and written straight to the Dealer Portal for the
    // Super Admin (founder, 28 Sep: not to the Sales Head any more).
    // -> { req, sent }
    const submit = async (type, extra) => {
      const req = discountSetup.file({
        type,
        rule: { ...d },
        customer: st.customer,
        // Two different ids (integrations/portalContracts): the ACCOUNT the
        // agent picked, and the DEALER the portal's rules are made against.
        accountId: st.accountId || null,
        dealerId: st.dealerId || null,
        odooPartnerId: st.odooPartnerId || null,
        accountRequestId: st.accountRequestId || null,
        // The customer's own number: told when the portal decides (discountWatch).
        phone: st.phone || (st.row && (st.row.phone || st.row.mobile)) || null,
        by: st.setBy,
        chatId: m.chatId,
        ...extra,
      });
      approvalLog.record({ kind: 'discount', id: req.id, event: 'requested', by: st.setBy || null, customer: st.customer, detail: `${type === 'change' ? 'change ' + (extra && extra.oldValue) + '% → ' : ''}${d.kind || ''} ${d.target || ''} ${d.value}%`.trim() });
      const sent = await this.discountToPortal(req, st.setBy || null);
      store.log(this.key, `${req.id}: discount ${type} for ${st.customer} (${d.target || ''} ${d.value}%) ${sent.ok ? 'on the portal for approval' : 'NOT written: ' + sent.why}`);
      if (sent.ok) await this.tellDiscountSetup(req, sent, st.setBy || m.from).catch(() => {});
      return { req, sent };
    };

    switch (st.step) {
      // ---- whose (agent or desk changing a customer's discount) ----
      case 'customer': {
        const n = /^(\d{1,2})[.)]?$/.exec(said);
        let row = n && st.candidates ? st.candidates[Number(n[1]) - 1] : null;
        if (!row) {
          // By phone or GST number first — one account — and by name otherwise.
          const key = salesOrder.readCustomerKey(said);
          let rows = [];
          if (key) rows = await salesOrder.findByKey(key).catch(() => []);
          // Searching by mobile only: a name or a GSTIN is not searched.
          else if (salesOrder.mobileOnly()) return next('customer', salesOrder.askMobile(t));
          else rows = ((await salesOrder.findCustomers(said).catch(() => ({ top: [] }))).top || []);
          if (!rows.length) {
            return next(
              'customer',
              key
                ? t(
                    `No customer on the portal with ${key.phone ? key.phone.slice(-10) : key.gst}. Open the account first ("customer bana do") — its discount is asked for at the end — or send another number.`,
                    `${key.phone ? key.phone.slice(-10) : key.gst} pe portal mein koi customer nahi hai. Pehle customer banaiye ("customer bana do") — discount wahi end mein poochha jayega — ya dusra number bhejiye.`,
                  )
                : t(`No customer called "${said}". Send the phone number or GST number.`, `"${said}" naam ka customer nahi mila. Phone number ya GST number bhejiye.`),
            );
          }
          if (rows.length > 1) {
            st.candidates = rows.slice(0, 6);
            return next('customer', t('Which one?', 'Kaunsa?') + '\n' + st.candidates.map((c, i) => `${i + 1}. ${salesOrder.label(c)}`).join('\n'));
          }
          row = rows[0];
        }
        delete st.candidates;
        return this.confirmDiscountCustomer(m, st, row, reply, t);
      }
      // ---- the agent has seen the customer's details: this one? ----
      case 'confirmCustomer': {
        // Another phone or GST number here is another customer.
        if (!m.buttonId && salesOrder.readCustomerKey(said)) {
          st.step = 'customer';
          delete st.row;
          discountSetup.save(m.chatId, st);
          return this.answerDiscount(m, said, reply, t);
        }
        const { answer: ans, say } = await this.readDiscountYesNo(m, said, t(`Set up the discount for ${st.row.name}?`, `${st.row.name} ka discount setup karein?`), {
          yes: `this is the right customer, go on with the discount setup for ${st.row.name}`,
          no: 'wrong customer, or do not set it up',
        });
        if (ans === 'no') {
          delete st.row;
          return next(
            'customer',
            salesOrder.mobileOnly()
              ? t("Then send the right customer's 10-digit mobile number.", 'Theek hai — sahi customer ka 10 digit mobile number bhejiye.')
              : t("Then send the right customer's phone number or GST number.", 'Theek hai — sahi customer ka phone number ya GST number bhejiye.'),
          );
        }
        // A message of its own is answered elsewhere; the customer waits.
        if (ans === 'new') return null;
        if (ans !== 'yes') {
          return next('confirmCustomer', say || t(`Set up the discount for ${st.row.name}? yes or no`, `${st.row.name} ka discount setup karein? haan ya nahi`));
        }
        // The row is an ACCOUNT (its id is the account id). A rule is made
        // against the customer's DEALER record: found through the Odoo
        // partner both carry, or the setup stops - never the account id put
        // where a dealer id goes (26 Sep, live: Houseneed's rule landed on
        // dealer 227, Dhakad Car Decor).
        st.accountId = Number(st.row.id);
        const dl = await portal.dealerIdForAccount(st.accountId, st.row).catch((e) => ({ dealerId: null, why: 'the portal did not answer (' + String((e && e.message) || e).slice(0, 60) + ')' }));
        if (!dl.dealerId) {
          const name = st.row.name;
          discountSetup.cancel(m.chatId);
          store.log(this.key, `${m.from}: no discount for ${name} (account ${st.accountId}): ${dl.why}`);
          return reply(
            t(
              `I can't set a discount for ${name}: ${dl.why}. Discount rules are made against the customer's dealer record on the portal — please ask the portal team to link this account to its dealer, then try again.`,
              `${name} ka discount set nahi ho sakta: ${dl.why}. Discount rule portal pe customer ke dealer record pe banta hai — portal team se is account ko uske dealer se link karwaiye, phir dobara try kijiye.`,
            ),
          );
        }
        st.dealerId = dl.dealerId;
        st.odooPartnerId = dl.odooPartnerId;
        st.customer = st.row.name;
        delete st.row;
        store.log(this.key, `${m.from} confirmed ${st.customer} (account ${st.accountId} -> dealer ${st.dealerId}) for a discount setup`);
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
          const mrp = await this.mrpOf(rule.partNo, st.accountId);
          if (mrp) {
            d.mrp = mrp;
            return next(
              'changeValue',
              t(
                `${rule.partNo} — MRP ${money(mrp)}. Now ${rule.value}% off: sells at ${money(discountSetup.priceAt(mrp, rule.value))}.\nNew discount %?`,
                `${rule.partNo} — MRP ${money(mrp)}. Abhi ${rule.value}% discount: ${money(discountSetup.priceAt(mrp, rule.value))} mein bikta hai.\nNaya discount %?`,
              ),
            );
          }
        }
        return next('changeValue', t(`Now ${rule.value}%. New discount %?`, `Abhi ${rule.value}% hai. Naya discount %?`));
      }
      // Only a change left open by the build before this one (which asked for
      // the lowest sale price) still stops here.
      case 'changePrice': {
        const price = discountSetup.readNumber(said);
        const pct = discountSetup.pctFromPrice(d.mrp, price);
        if (pct === null) return next('changePrice', t(`A price below the MRP (${money(d.mrp)}), in ₹.`, `MRP (${money(d.mrp)}) se kam price, ₹ mein.`));
        d.value = pct;
        d.minPrice = price;
        return this.sendDiscountChange(m, st, submit, reply, t);
      }
      case 'changeValue': {
        const v = discountSetup.readNumber(said);
        if (v === null || v <= 0 || v >= 100) return next('changeValue', t('Send the discount as a percentage, like 12.', 'Discount % mein bhejiye, jaise 12.'));
        d.value = v;
        return this.sendDiscountChange(m, st, submit, reply, t);
      }
      // Only a setup left open by the build before this one still stops here.
      // A yes sends it and a no drops it; anything else — "Maruti part btao"
      // — is not an answer, goes on to be answered, and the change waits.
      // (25 Sep, live: that message was read as a no and the change died.)
      case 'confirmChange': {
        const { answer: ans, say } = await this.readDiscountYesNo(m, said, t('Send this change for approval?', 'Ye change approval ke liye bhejun?'), { yes: 'send the discount change', no: 'do not send it' });
        if (ans === 'no') {
          discountSetup.cancel(m.chatId);
          return reply(t('Not sent. Nothing was changed.', 'Theek hai, nahi bheja. Kuch change nahi hua.'));
        }
        if (ans === 'unclear') return next('confirmChange', say || t('Send this change for approval? Yes or no.', 'Ye change approval ke liye bhejun? Haan ya Nahi.'));
        if (ans !== 'yes') return null;
        return this.sendDiscountChange(m, st, submit, reply, t);
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
        const mrp = await this.mrpOf(d.target, st.accountId);
        if (mrp) {
          d.mrp = mrp;
          return next('value', t(`${d.target} — MRP ${money(mrp)}. How much discount, in %?`, `${d.target} — MRP ${money(mrp)}. Kitna discount (%)?`));
        }
        return next('value', t(`${d.target} — the portal has no MRP for it. How much discount, in %?`, `${d.target} — portal pe MRP nahi mila. Kitna discount (%)?`));
      }
      // Only a setup left open by the build before this one (which asked for
      // the lowest sale price) still stops here.
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
        const sells = d.mrp
          ? t(`${v}% off MRP ${money(d.mrp)}: sells at ${money(discountSetup.priceAt(d.mrp, v))}.\n`, `MRP ${money(d.mrp)} pe ${v}% discount: ${money(discountSetup.priceAt(d.mrp, v))} mein bikega.\n`)
          : '';
        return next('minQty', sells + t('Minimum quantity? (default 1 — "skip")', 'Minimum quantity? (default 1 — "skip" likh dijiye)'));
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
        return next('confirm', discountSetup.describe(d, t) + priced + '\n\n' + t('Send this rule to the Dealer Portal for approval?', 'Ye rule Dealer Portal pe approval ke liye bhejun?'), [
          { id: 'DSC_YES', title: t('Yes', 'Haan') },
          { id: 'DSC_NO', title: t('No, start again', 'Nahi, dobara') },
        ]);
      }
      case 'confirm': {
        const { answer: ans, say } = await this.readDiscountYesNo(m, said, discountSetup.describe(d, t) + '\n' + t('Send this rule to the Dealer Portal for approval?', 'Ye rule Dealer Portal pe approval ke liye bhejun?'), {
          yes: 'send this rule for approval',
          no: 'do not send it, start the rule again',
        });
        if (ans === 'no') {
          st.draft = {};
          return next('type', t('Again, then — brand-wise or part-wise?', 'Theek hai, dobara — Brand wise ya Part wise?'), this.discountTypeButtons(t));
        }
        // A message of its own ("Maruti ka headlight kitne ka hai?") is not
        // an answer: it goes on, and the rule waits for its yes. A reply the
        // model cannot place gets its own line back, not the same question.
        if (ans === 'new') return null;
        if (ans !== 'yes') {
          return next('confirm', say || t('Send this rule for approval? Yes or no.', 'Ye rule approval ke liye bhejun? Haan ya Nahi.'), [
            { id: 'DSC_YES', title: t('Yes', 'Haan') },
            { id: 'DSC_NO', title: t('No, start again', 'Nahi, dobara') },
          ]);
        }
        const { sent } = await submit('new', {});
        if (!sent.ok) {
          return next('confirm', t(`Could not put it on the portal: ${sent.why}\nSend it again? Yes or no.`, `Portal pe nahi daal paya: ${sent.why}\nDobara bhejun? Haan ya Nahi.`), [
            { id: 'DSC_YES', title: t('Yes', 'Haan') },
            { id: 'DSC_NO', title: t('No, start again', 'Nahi, dobara') },
          ]);
        }
        st.count += 1;
        st.draft = {};
        return next('more', this.discountSentText(sent, t) + '\n\n' + t('Another rule for this customer?', 'Is customer ke liye aur rule?'), [
          { id: 'DSC_MORE_YES', title: t('Add another', 'Aur add karo') },
          { id: 'DSC_MORE_NO', title: t('Done', 'Bas itna') },
        ]);
      }
      case 'more': {
        // "done", "bas", "itna hi" mean STOP here, even though "done" is a yes
        // at the confirm step. With a button it never mattered which word was
        // typed; answered in words, "done" would have started another rule.
        const { answer: ans, say } =
          m.buttonId === 'DSC_MORE_NO' || /^(done|bas|bas itna|itna hi|that'?s all|no more|enough)\b/i.test(said)
            ? { answer: 'no' }
            : await this.readDiscountYesNo(m, said, t('Another rule for this customer?', 'Is customer ke liye aur rule?'), {
                yes: 'add another discount rule for this customer',
                no: 'finished, no more rules',
              });
        if (ans === 'yes') {
          return next('type', t('Brand-wise or part-wise?', 'Brand wise ya Part wise?'), this.discountTypeButtons(t));
        }
        if (ans === 'unclear') return next('more', say || t('Another rule for this customer? Yes or no.', 'Is customer ke liye aur rule? Haan ya Nahi.'));
        discountSetup.cancel(m.chatId);
        // "Maruti ka right headlight chahiye" is not an answer to "another
        // rule?" (25 Sep, live: it was swallowed and answered "Ho gaya — 1
        // discount rule…"). The setup is over; the message goes on.
        if (ans !== 'no') return null;
        return reply(
          t(
            `Done — ${st.count} discount rule(s) ${st.accountRequestId ? 'go to the Dealer Portal once the account is open' : 'are on the Dealer Portal'}, waiting for a Super Admin's approval. I will tell you as each is approved.`,
            `Ho gaya — ${st.count} discount rule ${st.accountRequestId ? 'account khulte hi Dealer Portal pe jayenge' : 'Dealer Portal pe hain'}, Super Admin ke approval ka wait. Har ek approve hote hi bata dunga.`,
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
    // The ACCOUNT the request is for. Requests filed before 26 Sep kept it
    // in `dealerId` (the bug this fixes): without an odooPartnerId, that
    // number is the account id.
    let accountId = req.accountId || (!req.odooPartnerId ? req.dealerId : null) || null;
    let name = req.customer;
    if (!accountId && req.phone) {
      try {
        const c = await portal.lookupCustomer(req.phone);
        if (c && c.found) {
          accountId = c.buyerId; // selected_buyer_id: an ACCOUNT id
          name = c.name || name;
        }
      } catch (e) {
        store.log(this.key, 'discount: customer lookup failed: ' + String((e && e.message) || e).slice(0, 80));
      }
    }
    if (!accountId) return { ok: false, name: req.rule.ruleName, why: 'customer not found on the portal yet' };
    let target;
    try {
      target = await portal.dealerIdForAccount(accountId);
    } catch (e) {
      return { ok: false, name: req.rule.ruleName, why: 'the portal did not answer: ' + String((e && e.message) || e).slice(0, 80) };
    }
    if (!target.dealerId) return { ok: false, name: req.rule.ruleName, why: target.why };
    const body = discountSetup.toPortal({ ...req.rule, requestId: req.id, setBy: req.by }, target, name);
    // PENDING on the portal: the Super Admin approves it there, by hand
    // (founder, 28 Sep). The bot never approves a rule itself.
    body.approval_status = 'PENDING';
    try {
      const made = await portal.createDiscountRule(body);
      const id = made && (made.rule_id || made.id);
      const live = String((made && made.approval_status) || '').toUpperCase() === 'APPROVED';
      if (id && !live && req.chatId) require('../core/discountWatch').watch(id, { chatId: req.chatId, name: body.rule_name, customerPhone: await this.discountCustomerPhone(req, accountId), customerName: name });
      return { ok: true, name: body.rule_name, ruleId: id, live };
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
      approvalLog.record({ kind: 'discount', id: req.id, event: 'rejected', by: who, customer: req.customer, detail: what });
      await tell(t(`Discount request ${req.id} (${what}) was not approved.`, `Discount request ${req.id} (${what}) approve nahi hua.`));
      return reply(t(`Rejected ${req.id}. ${req.by || 'They'} was told.`, `${req.id} reject kar diya. ${req.by || 'Unko'} bata diya.`));
    }

    // A request filed before 28 Sep, when the Sales Head still approved on
    // WhatsApp: it goes to the portal now, for the Super Admin like any other.
    const sent = await this.discountToPortal(req, who);
    if (!sent.ok) return reply(t(`Could not put it on the portal: ${sent.why}\nTry *OK ${req.id}* again.`, `Portal pe nahi daal paya: ${sent.why}\nDobara *OK ${req.id}* bhejiye.`));
    const text = this.discountSentText(sent, t);
    await tell(text);
    return reply(text);
  }

  // ONE DISCOUNT REQUEST, WRITTEN TO THE DEALER PORTAL (founder, 28 Sep): a
  // new rule or the changed %, left PENDING for the Super Admin, who approves
  // it on the portal by hand. From then on orders get it: the portal applies
  // an APPROVED rule at order punch, and the rule starts at midnight the day
  // before (discountSetup.opensFrom), so it counts the moment it is approved.
  // core/discountWatch tells the agent when that happens.
  //   -> { ok, ruleId, name, live, waitsForAccount } | { ok: false, why }
  async discountToPortal(req, by) {
    const what = req.type === 'change' ? `${req.customer}: ${req.oldValue}% → ${req.rule.value}%` : `${req.rule.ruleName || req.customer}`;
    if (req.type === 'change') {
      let now;
      try {
        now = (await portal.listDiscountRules()).find((x) => String(x.rule_id || x.id) === String(req.ruleId));
      } catch (e) {
        return { ok: false, why: 'the portal did not answer: ' + String((e && e.message) || e).slice(0, 100) };
      }
      if (!now) {
        discountSetup.drop(req.id);
        return { ok: false, why: `rule #${req.ruleId} is no longer on the portal` };
      }
      // THE SAME RULE, only its % changed — never a new rule. Sent back whole,
      // so a PUT that treats a missing field as "clear it" cannot blank its
      // brand, dates or limits.
      const keep = ['rule_type', 'part_no', 'brand', 'dealer_id', 'discount_mode', 'min_qty', 'max_qty', 'min_amount', 'max_amount', 'is_active', 'valid_from', 'valid_to', 'priority', 'rule_metadata'];
      const body = {};
      for (const k of keep) if (now[k] !== undefined) body[k] = now[k];
      body.discount_value = req.rule.value;
      body.valid_from = discountSetup.opensFrom(now.valid_from);
      body.rule_name = discountSetup.ruleName(req.customer, req.rule.target, req.rule.value);
      body.rule_metadata = { ...(now.rule_metadata || {}), source: 'whatsapp-bot', requestId: req.id, changedFrom: req.oldValue, setBy: by || null };
      let updated;
      try {
        updated = await portal.updateDiscountRule(req.ruleId, body);
      } catch (e) {
        const why = String((e && e.message) || e).slice(0, 120);
        store.log(this.key, `${req.id} discount update FAILED: ${why}`);
        return { ok: false, why };
      }
      discountSetup.drop(req.id);
      const live = String((updated && updated.approval_status) || 'PENDING').toUpperCase() === 'APPROVED';
      if (!live && req.chatId) require('../core/discountWatch').watch(req.ruleId, { chatId: req.chatId, name: body.rule_name, what, customerPhone: await this.discountCustomerPhone(req, req.accountId), customerName: req.customer });
      store.log(this.key, `${req.id}: rule ${req.ruleId} changed to ${req.rule.value}% on the portal — ${live ? 'APPROVED' : 'waiting for the Super Admin'}`);
      approvalLog.record({ kind: 'discount', id: req.id, event: 'sent to portal', by: by || null, customer: req.customer, detail: `${what} (rule #${req.ruleId})` });
      return { ok: true, ruleId: req.ruleId, name: body.rule_name, live };
    }

    // A new rule for an account that is itself still waiting: written to the
    // portal the moment the account opens (the account approval path).
    if (req.accountRequestId && customerCreate.parked(req.accountRequestId)) {
      req.status = 'approved';
      discountSetup.requests.set(req.id, req);
      store.log(this.key, `${req.id} waits for account ${req.accountRequestId} before it goes to the portal`);
      return { ok: true, name: req.rule.ruleName || what, waitsForAccount: req.accountRequestId };
    }
    const made = await this.createDiscountFor(req);
    if (!made.ok) {
      store.log(this.key, `${req.id} discount create FAILED: ${made.why}`);
      return { ok: false, why: made.why };
    }
    discountSetup.drop(req.id);
    store.log(this.key, `${req.id}: ${made.name} written to the portal as rule ${made.ruleId} — ${made.live ? 'APPROVED' : 'waiting for the Super Admin'}`);
    approvalLog.record({ kind: 'discount', id: req.id, event: 'sent to portal', by: by || null, customer: req.customer, detail: `${made.name} (rule #${made.ruleId})` });
    return { ok: true, ruleId: made.ruleId, name: made.name, live: made.live };
  }

  // A DISCOUNT SET UP OR CHANGED BY AN AGENT (founder, 29 Sep): Prateek Sir is
  // told what was set, for whom and by whom (config.creation.
  // discountSetupNotify). A notice only - the rule is approved or rejected on
  // the Dealer Portal by a Super Admin, not here, so it asks for no reply.
  async tellDiscountSetup(req, sent, by) {
    const to = Object.keys(config.creation.discountSetupNotify || {});
    if (!to.length) return;
    const r = req.rule || {};
    const on = r.kind === 'brand' ? `Brand ${r.target}` : r.kind === 'part' ? `Part ${r.target}` : 'All parts';
    const limits = [r.minQty > 1 ? `min qty ${r.minQty}` : null, r.maxQty ? `max qty ${r.maxQty}` : null, r.minAmount ? `min ₹${r.minAmount}` : null, r.maxAmount ? `max ₹${r.maxAmount}` : null, req.type === 'change' ? null : r.durationLabel ? `valid ${r.durationLabel}` : null].filter(Boolean);
    const where = sent.waitsForAccount
      ? `Goes to the Dealer Portal when the new account ${sent.waitsForAccount} is approved.`
      : `On the Dealer Portal as rule #${sent.ruleId}${sent.live ? ' — already APPROVED there.' : ' — waiting for a Super Admin.'}`;
    const text = [
      `🏷️ *Discount ${req.type === 'change' ? 'change' : 'setup'}* by ${by || 'an agent'}`,
      `Customer: ${req.customer}`,
      `${on} — ${req.type === 'change' ? `${req.oldValue}% → *${r.value}%*` : `*${r.value}%*`}${limits.length ? ' (' + limits.join(', ') + ')' : ''}`,
      r.mrp ? `MRP ₹${r.mrp} → ₹${discountSetup.priceAt(r.mrp, r.value)}` : null,
      where,
      '',
      sent.live ? 'For your information.' : 'Please check it and approve or reject it on the Dealer Portal (Super Admin).',
    ]
      .filter((l) => l !== null)
      .join('\n');
    for (const phone of to) {
      try {
        await escalation.ensureWindow(this.transport, phone, 'Discount setup — details follow').catch(() => {});
        await this.transport.sendText(phone, text);
      } catch (e) {
        store.log(this.key, `could not tell ${phone} of discount ${req.id}: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    store.log(this.key, `${req.id}: discount ${req.type} notice sent to ${to.join(', ')}`);
  }

  // THE AGENT WHO OPENED AN ACCOUNT, told of the decision: the chat the form
  // was filled in, when that is not the customer's own.
  async tellAccountAgent(req, textFor) {
    const chat = req && req.chatId;
    if (!chat) return false;
    const ten = (p) => String(p || '').replace(/\D/g, '').slice(-10);
    if (ten(String(chat).split('@')[0]) === ten(req.answers && req.answers.phone)) return false;
    try {
      const text = textFor(lang.for(chat));
      const id = await this.transport.sendToChat(chat, text);
      this.recordOutgoing(chat, id, text);
      return true;
    } catch (e) {
      store.log(this.key, `could not tell the agent about ${req.answers && req.answers.requestId}: ` + String((e && e.message) || e).slice(0, 80));
      return false;
    }
  }

  // THE CUSTOMER a discount request is for, as a number to tell when the
  // portal decides it (founder, 29 Sep: "the approved msg goes to agent but
  // not to customer"). The request's own number, else the account's on the
  // portal. Never the agent's own number.
  async discountCustomerPhone(req, accountId) {
    const norm = (p) => {
      const ten = String(p || '').replace(/\D/g, '').slice(-10);
      return ten.length === 10 ? '91' + ten : null;
    };
    let p = norm(req.phone) || norm(req.customerPhone);
    if (!p && accountId) p = await portal.accountPhone(accountId).catch(() => null);
    const agentPhone = norm(String(req.chatId || '').split('@')[0]);
    return p && p !== agentPhone ? p : null;
  }

  // What the agent is told once a request is on the portal.
  discountSentText(sent, t) {
    if (sent.waitsForAccount) {
      return t(
        `Saved: ${sent.name}. It goes to the Dealer Portal for approval as soon as account ${sent.waitsForAccount} is open.`,
        `Save ho gaya: ${sent.name}. Account ${sent.waitsForAccount} khulte hi Dealer Portal pe approval ke liye chala jayega.`,
      );
    }
    if (sent.live) {
      return t(`✅ ${sent.name} (rule #${sent.ruleId}) is live on the Dealer Portal — orders get the discount from now.`, `✅ ${sent.name} (rule #${sent.ruleId}) Dealer Portal pe live hai — ab se order pe discount lagega.`);
    }
    return t(
      `Sent to the Dealer Portal for approval: ${sent.name} (rule #${sent.ruleId}). Orders get the discount as soon as a Super Admin approves it there — I will tell you when.`,
      `Dealer Portal pe approval ke liye bhej diya: ${sent.name} (rule #${sent.ruleId}). Super Admin approve karte hi order pe discount lagega — approve hote hi bata dunga.`,
    );
  }

  // ---- payment before a new order (core/payments) ----

  // At the order's "yes": does this customer still owe money? -> null when
  // the order may go on, or { req, due, qrSent } when it is held.
  // `opts.customerPhone`: the order is a SALESMAN'S (founder, 26 Sep: credit
  // billing is one invoice — no new order until the balance is paid, whoever
  // places it). The payment request, the QR and "your balance is settled" go
  // to the CUSTOMER's WhatsApp; the agent hears when the order goes on.
  // "Total due ₹X, cheque ₹X received - covered" in front of the news that the
  // order went ahead, when a cheque is why it was not held.
  chequeCoveredNote(order, t) {
    const c = order && order.chequeCovered;
    if (!c) return '';
    return (
      t('The due is covered by the cheque, so the order goes ahead:', 'Cheque se baaki pura ho gaya, isliye order aage badh gaya:') +
      '\n' +
      payments.breakdown({ owed: c.owed, chequeAmount: c.chequeAmount, cheques: c.cheques, due: 0 }, t) +
      '\n\n'
    );
  }

  async holdForPayment(order, customer, opts = {}) {
    const due = await payments.dueOf(customer).catch(() => null);
    if (!due || payments.settled(due.due)) {
      // CLEARED BY A CHEQUE (founder, 29 Sep): Odoo still shows a due, but the
      // cheques they gave cover it - the order goes ahead, and whoever is told
      // it went is told why (order.chequeCovered).
      if (due && due.chequeAmount > 0 && due.owed >= 1) {
        order.chequeCovered = { owed: due.owed, chequeAmount: due.chequeAmount, cheques: due.cheques };
        store.log(this.key, `${order.id}: ${customer.name} owes ${payments.money(due.owed)} in Odoo, covered by cheque(s) of ${payments.money(due.chequeAmount)} - not held`);
      }
      return null;
    }
    const custChat = opts.customerPhone ? store.normPhone(opts.customerPhone) + '@cloud' : null;
    if (custChat) {
      const ct = lang.for(custChat);
      // With a cheque in, the total, the cheque and what is left - so they
      // see the cheque was counted and pay only the rest.
      const withCheque = due.chequeAmount > 0;
      const text = withCheque
        ? ct(
            `Hello ${customer.name}. Thank you for your cheque — it has been counted.

${payments.breakdown(due, ct)}

The new order${opts.agent ? ' placed by ' + opts.agent : ''} is on hold until the remaining ${payments.money(due.due)} is paid. Please pay it with the QR below and reply "payment done" — the order goes ahead as soon as it is confirmed.`,
            `Namaste ${customer.name}. Aapka cheque mil gaya hai, shukriya — wo gin liya gaya hai.

${payments.breakdown(due, ct)}

Baaki ${payments.money(due.due)} pay hone tak naya order${opts.agent ? ' (' + opts.agent + ' ne lagaya)' : ''} ruka hua hai. Neeche QR se pay karke "payment kar diya" likhiye — confirm hote hi order aage badh jayega.`,
          )
        : ct(
            `Hello ${customer.name}. Your previous balance of ${payments.money(due.due)} is unpaid, so the new order${opts.agent ? ' placed by ' + opts.agent : ''} is on hold. Please pay it with the QR below and reply "payment done" — the order goes ahead as soon as it is confirmed.`,
            `Namaste ${customer.name}. Aapka pichla ${payments.money(due.due)} baaki hai, isliye naya order${opts.agent ? ' (' + opts.agent + ' ne lagaya)' : ''} ruka hua hai. Neeche QR se pay karke "payment kar diya" likhiye — confirm hote hi order aage badh jayega.`,
          );
      try {
        await escalation.ensureWindow(this.transport, store.normPhone(opts.customerPhone), 'Payment due — details follow', customer.name);
        const id = await this.transport.sendToChat(custChat, text);
        this.recordOutgoing(custChat, id, text);
      } catch (e) {
        store.log(this.key, `${order.id}: could not tell ${customer.name} about the due: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    const req = payments.open({
      chatId: custChat || order.chatId,
      phone: custChat ? store.normPhone(opts.customerPhone) : String(order.chatId || '').split('@')[0],
      customer: customer.name,
      buyerId: customer.buyerId,
      due: due.due,
      orderId: order.id,
    });
    order.status = 'awaitingPayment';
    order.paymentId = req.id;
    store.save();
    store.log(this.key, `${order.id} held: ${customer.name} owes ${payments.money(due.due)} (${req.id})`);
    approvalLog.record({ kind: 'payment', id: req.id, event: 'requested', by: 'bot (order ' + order.id + ')', customer: customer.name, phone: req.phone, detail: 'due ' + payments.money(due.due) + ' before ' + order.id, amount: due.due });
    const qrSent = await this.sendPaymentQr(req, due.due);
    return { req, due: due.due, owed: due.owed, chequeAmount: due.chequeAmount || 0, cheques: due.cheques || [], detail: due, qrSent };
  }

  // The QR for the amount, into the customer's chat. -> true when one went.
  async sendPaymentQr(req, amount) {
    const q = await payments.qr(amount, `${req.customer} ${req.id}`).catch(() => null);
    if (!q || !this.transport.sendImage) return false;
    const t = lang.for(req.chatId);
    const caption = t(`Pay ${payments.money(amount)} — scan to pay (${req.id})`, `${payments.money(amount)} pay kijiye — scan karke (${req.id})`);
    try {
      const id = await this.transport.sendImage(req.chatId, q.buffer, q.mime, caption);
      this.recordOutgoing(req.chatId, id, caption);
      return true;
    } catch (e) {
      store.log(this.key, `${req.id}: payment QR not sent: ${String((e && e.message) || e).slice(0, 80)}`);
      return false;
    }
  }

  // The customer says they have paid: the accountant is asked to check.
  // -> { sent, req } | { nothingDue } | { unknown }
  async paymentClaimed(chatId, phone, customer, claim) {
    let req = payments.forChat(chatId);
    if (!req) {
      // No held order, but they are paying what they owe: check it anyway.
      const due = await payments.dueOf(customer).catch(() => null);
      if (!due) return { unknown: true };
      if (payments.settled(due.due)) return { nothingDue: true };
      req = payments.open({ chatId, phone: store.normPhone(phone), customer: customer.name, buyerId: customer.buyerId, due: due.due, orderId: null });
    }
    req.status = 'checking';
    req.claim = claim || null;
    payments.save(req);
    const text = payments.accountantText(req, claim);
    const photo = incoming.heldPhoto(chatId); // a payment screenshot, if they sent one
    let sent = 0;
    for (const acc of Object.keys(config.payments.accountants || {})) {
      try {
        await escalation.ensureWindow(this.transport, acc, 'Payment to check — details follow');
        const sentId =
          photo && this.transport.sendImage ? await this.transport.sendImage(acc, Buffer.from(photo.base64, 'base64'), photo.mime, text) : await this.transport.sendText(acc, text);
        deliveryWatch.track(sentId, { ref: req.id, to: acc });
        sent++;
      } catch (e) {
        store.log(this.key, `${req.id}: could not reach accountant ${acc}: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    store.log(this.key, `${req.id}: ${req.customer} says paid — sent to ${sent} accountant(s)`);
    approvalLog.record({ kind: 'payment', id: req.id, event: 'claimed', by: 'customer (' + store.normPhone(phone) + ')', customer: req.customer, detail: claim ? String(claim).slice(0, 120) : 'says paid', amount: req.due });
    return { sent: sent > 0, req };
  }

  // "OK PAY-7F3K 22002" / "NO PAY-7F3K" from the accountant.
  async decidePayment(m, decision, reply, t) {
    const req = payments.find(decision.requestId);
    if (!req) return reply(t(`${decision.requestId} not found.`, `${decision.requestId} nahi mila.`));
    if (req.status === 'settled') return reply(t(`${req.id} is already settled.`, `${req.id} pehle hi settle ho chuka hai.`));
    const who = payments.accountantName(m.from);
    const ct = lang.for(req.chatId);
    const tell = async (text) => {
      try {
        const id = await this.transport.sendToChat(req.chatId, text);
        this.recordOutgoing(req.chatId, id, text);
      } catch (e) {
        store.log(this.key, `${req.id}: could not tell the customer: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    };

    if (!decision.yes) {
      req.status = 'waiting';
      payments.save(req);
      approvalLog.record({ kind: 'payment', id: req.id, event: 'rejected', by: who, customer: req.customer, detail: 'payment not received' });
      await tell(
        ct(
          `We have not received the payment yet. ${payments.money(req.due)} is still due — please pay it and let us know.`,
          `Payment abhi tak nahi aaya hai. ${payments.money(req.due)} abhi baaki hai — pay karke bata dijiye.`,
        ),
      );
      await this.sendPaymentQr(req, req.due);
      return reply(t(`Noted — ${req.customer} was told it has not come in.`, `Theek hai — ${req.customer} ko bata diya ki payment nahi aaya.`));
    }

    if (decision.amount) req.received.push({ amount: decision.amount, by: who, at: new Date().toISOString() });
    // The balance as the portal has it NOW — after he recorded the receipt.
    require('./../core/customers').forget(req.phone);
    const now = await payments.dueOf({ name: req.customer, buyerId: req.buyerId }).catch(() => null);
    const left = now ? now.due : null;
    approvalLog.record({ kind: 'payment', id: req.id, event: 'approved', by: who, customer: req.customer, detail: `received ${decision.amount ? payments.money(decision.amount) : '(amount not given)'}; portal due now ${left === null ? 'unknown' : payments.money(left)}`, amount: decision.amount || null });

    if (left === null) {
      payments.save(req);
      return reply(t(`Noted. I cannot read ${req.customer}'s balance on the portal right now — send OK ${req.id} again in a minute.`, `Note kar liya. ${req.customer} ka balance portal pe abhi nahi dikh raha — ek minute mein dobara OK ${req.id} bhejiye.`));
    }
    // Money came in, but the portal has not moved yet: the receipt is still to
    // be recorded. The customer is not asked for the full amount again.
    if (!payments.settled(left) && decision.amount && left >= req.due - 0.5) {
      req.status = 'checking';
      payments.save(req);
      await tell(
        ct(
          `${payments.money(decision.amount)} received, thank you — your account is being updated. You will hear as soon as it is done.`,
          `${payments.money(decision.amount)} mil gaya, shukriya — aapka account update ho raha hai. Hote hi bata denge.`,
        ),
      );
      return reply(
        t(
          `Noted ${payments.money(decision.amount)}. The portal still shows ${payments.money(left)} due for ${req.customer} — record the receipt on the portal, then send *OK ${req.id}* again.`,
          `${payments.money(decision.amount)} note kar liya. Portal pe ${req.customer} ka abhi bhi ${payments.money(left)} due hai — receipt portal pe update karke dobara *OK ${req.id}* bhejiye.`,
        ),
      );
    }
    if (!payments.settled(left)) {
      req.due = left;
      req.status = 'waiting';
      payments.save(req);
      await tell(
        ct(
          `${decision.amount ? payments.money(decision.amount) + ' received, thank you. ' : ''}${payments.money(left)} is still due — please pay it to settle your account before the new order.`,
          `${decision.amount ? payments.money(decision.amount) + ' mil gaya, shukriya. ' : ''}Abhi ${payments.money(left)} baaki hai — naye order se pehle ise settle kar dijiye.`,
        ),
      );
      await this.sendPaymentQr(req, left);
      return reply(
        t(
          `The portal still shows ${payments.money(left)} due for ${req.customer}. The customer was asked for it. If the full amount has come in, record it on the portal and send *OK ${req.id}* again.`,
          `Portal pe ${req.customer} ka abhi bhi ${payments.money(left)} due dikh raha hai. Customer ko bata diya. Agar poora amount aa gaya hai to portal pe update karke dobara *OK ${req.id}* bhejiye.`,
        ),
      );
    }

    // SETTLED. The customer is told, and the held order goes on.
    req.status = 'settled';
    req.due = left;
    payments.save(req);
    approvalLog.record({ kind: 'payment', id: req.id, event: 'settled', by: who, customer: req.customer, detail: 'balance settled' });
    store.log(this.key, `${req.id}: ${req.customer} settled (portal due ${payments.money(left)}), confirmed by ${who}`);
    const order = req.orderId ? store.orders().find((o) => o.id === req.orderId) : null;
    let next = '';
    if (order && order.status === 'awaitingPayment') {
      const went = await this.releaseHeldOrder(order);
      next = went;
      // A salesman's order: the agent hears it is moving again.
      if (order.chatId && order.chatId !== req.chatId) {
        const at = lang.for(order.chatId);
        const msg = at(
          `✅ ${req.customer} has paid — balance settled. ${order.id} ${went ? 'has gone on (' + went.en + ')' : 'can go ahead now'}.`,
          `✅ ${req.customer} ne pay kar diya — balance settle ho gaya. ${order.id} ${went ? 'aage badh gaya (' + went.hi + ')' : 'ab aage ja sakta hai'}.`,
        );
        try {
          const id = await this.transport.sendToChat(order.chatId, msg);
          this.recordOutgoing(order.chatId, id, msg);
        } catch (e) {
          store.log(this.key, `${order.id}: could not tell the agent: ${String((e && e.message) || e).slice(0, 80)}`);
        }
      }
    }
    await tell(
      ct(`✅ Your balance is settled. Thank you!${next ? ' ' + next.en : ''}`, `✅ Aapka balance settle ho gaya. Shukriya!${next ? ' ' + next.hi : ''}`),
    );
    return reply(t(`Settled — ${req.customer}.${order ? ' Their order ' + order.id + ' has gone on.' : ''}`, `Settle ho gaya — ${req.customer}.${order ? ' Unka order ' + order.id + ' aage bhej diya.' : ''}`));
  }

  // The order that waited on the payment: placed, or — while placing is off —
  // sent to the Sales Heads for approval. -> the words for the customer.
  async releaseHeldOrder(order) {
    order.status = 'draft';
    // A salesman's order says so on the approval (not the agent's number as
    // the customer's).
    const placer = String(order.chatId || '').split('@')[0];
    const byAgent = salesOrder.isSalesPerson(placer) ? { by: customerCreate.agentName(placer) || placer } : {};
    store.save();
    let res = null;
    try {
      res = await orders.confirm(order);
    } catch (e) {
      store.log(this.key, `${order.id}: placing after the payment failed: ${String((e && e.message) || e).slice(0, 100)}`);
      const sent = await this.requestOrderApproval(order, byAgent);
      return sent ? { en: `Your order ${order.id} has gone for approval.`, hi: `Aapka order ${order.id} approval ke liye bhej diya hai.` } : null;
    }
    if (res && res.blocked) {
      const sent = await this.requestOrderApproval(order, byAgent);
      return sent ? { en: `Your order ${order.id} has gone for approval.`, hi: `Aapka order ${order.id} approval ke liye bhej diya hai.` } : null;
    }
    if (res && res.soNumber) return { en: `Your order is placed — order no. ${res.soNumber}.`, hi: `Aapka order place ho gaya — order no. ${res.soNumber}.` };
    return null;
  }

  // ---- orders approved by the Sales Head ----
  //
  // While ORDER_CONFIRM_ENABLED is off, a customer's "yes" to their cart does
  // not place it: the cart goes to the Sales Heads as "Order approval —
  // ORD-…", and "OK ORD-…" places it on the dealer portal (core/orders.confirm
  // with approvedBy). 25 Sep, live: the order was handed to a person as a
  // question instead, he answered "Allow", nothing reached the portal, and the
  // customer was told "Order place ho gaya".

  // -> how many approvers it reached. The cart is taken out of the draft
  // state while it waits, so what the customer adds next starts a new cart.
  async requestOrderApproval(order, opts = {}) {
    const inStock = (l) => l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0;
    const pc = order.portalCustomer || {};
    // order.customer is the agent's customer RECORD, not a name — printed as
    // is it read "Customer: [object Object]" (25 Sep, live).
    const oc = order.customer && typeof order.customer === 'object' ? order.customer.name : order.customer;
    // The CUSTOMER's number: for a salesman's order the chat is the agent's,
    // so the account's own phone is used when there is one.
    const chatPhone = String(order.chatId || '').split('@')[0];
    const acctPhone = String(pc.phone || (pc.raw && (pc.raw.phone || pc.raw.mobile)) || '').replace(/\D/g, '');
    const phone = opts.by ? acctPhone : chatPhone;
    const custName = pc.name || oc || phone;
    // Who asked: a salesman's order also tells the customer once it is placed.
    order.requestedBy = opts.by || null;
    // What they still owe, for the Sales Head to weigh (Odoo's receivable).
    const due = await payments.dueOf(pc).catch(() => null);
    // Only what will be punched (founder, 26 Sep: "send only available part
    // request to prateek sir"): in-stock lines at the quantity in stock; the
    // rest is a count, not a list.
    const punchable = order.lines.filter(inStock);
    const left = order.lines.length - punchable.length;
    const rows = punchable.map((l, i) => {
      const got = Math.min(Number(l.qty) || 0, Number(l.available) || 0);
      return `${i + 1}. ${l.partNo || l.item} × ${got}${availability.priceOf(l)}${got < l.qty ? ` (asked ${l.qty}, ${got} in stock)` : ''}`;
    });
    if (left) rows.push('', `(${left} other item(s) not in stock — not included)`);
    const total = punchable.reduce((s, l) => s + (Number(l.rate) || Number(l.mrp) || 0) * Math.min(Number(l.qty) || 0, Number(l.available) || 0), 0);
    const text = [
      `*Order approval* — ${order.id}`,
      `Customer: ${custName}${phone ? ` (+${phone})` : ''}`,
      opts.by ? `Requested by: ${opts.by} (sales team)` : null,
      due ? (payments.settled(due.due) ? 'Due balance: nil' : `⚠️ Due balance: ${payments.money(due.due)} unpaid`) : null,
      '',
      ...rows,
      '',
      punchable.length
        ? `In-stock lines go to the portal: ₹${Math.round(total).toLocaleString('en-IN')} incl. GST.`
        : 'Nothing in this cart is in stock — an OK will not place anything yet.',
      `Reply *OK ${order.id}* to place it on the portal, or *NO ${order.id}* to reject.`,
    ]
      .filter((l) => l !== null)
      .join('\n');
    const was = order.status;
    order.status = 'approval';
    order.approvalAskedAt = new Date().toISOString();
    store.save();
    const sent = await this.toApprovers(text, { ref: order.id, requesterChat: opts.by ? order.chatId : null });
    if (!sent) {
      order.status = was;
      store.save();
    }
    store.log(this.key, `${order.id} sent to ${sent} approver(s) for approval`);
    if (sent) approvalLog.record({ kind: 'order', id: order.id, event: 'requested', by: opts.by ? opts.by + ' (sales team)' : 'customer (' + phone + ')', customer: custName, phone, detail: `${order.lines.length} line(s)`, amount: Math.round(total) });
    return sent;
  }

  // "OK ORD-12" / "NO ORD-12" from a Sales Head.
  async decideOrder(m, decision, reply, t) {
    const order = store.orders().find((o) => String(o.id).toUpperCase() === decision.requestId);
    if (!order) return reply(t(`${decision.requestId} not found.`, `${decision.requestId} nahi mila.`));
    if (order.status === 'confirmed') return reply(t(`${order.id} is already placed — portal order ${order.soNumber}.`, `${order.id} pehle hi place ho chuka hai — portal order ${order.soNumber}.`));
    if (order.status !== 'approval') return reply(t(`${order.id} is not waiting for approval (${order.status}).`, `${order.id} approval ke liye nahi ruka hai (${order.status}).`));
    const who = customerCreate.approverName(m.from);
    const ct = lang.for(order.chatId);
    const tell = async (text) => {
      try {
        const id = await this.transport.sendToChat(order.chatId, text);
        this.recordOutgoing(order.chatId, id, text);
      } catch (e) {
        store.log(this.key, `${order.id}: could not tell the customer: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    };

    if (!decision.yes) {
      order.status = 'rejected';
      order.rejectedBy = who;
      store.save();
      store.log(this.key, `${order.id} rejected by ${who}`);
      approvalLog.record({ kind: 'order', id: order.id, event: 'rejected', by: who, customer: (order.portalCustomer && order.portalCustomer.name) || null });
      const pcR = order.portalCustomer || {};
      // AN AGENT'S ORDER (founder, 29 Sep: "whatever agent do for customer and
      // it get approved or decline send msg to both"): the agent's chat, AND
      // the customer on their own number.
      if (order.requestedBy) {
        await tell(ct(`${pcR.name ? pcR.name + "'s o" : 'O'}rder ${order.id} was not approved by the Sales Head. The customer has been told.`, `${pcR.name ? pcR.name + ' ka o' : 'O'}rder ${order.id} Sales Head ne approve nahi kiya. Customer ko bata diya hai.`));
        const custChatR = this.customerChatOf(order);
        if (custChatR) {
          const cr = lang.for(custChatR);
          const text = cr(
            `Dear ${pcR.name ? pcR.name + ' ji' : 'customer'}, we are sorry — your order ${order.id} could not be approved this time. Please call us or your sales representative, and we will gladly help.`,
            `${pcR.name ? pcR.name + ' ji' : 'Ji'}, maaf kijiye — aapka order ${order.id} is baar approve nahi ho paya. Humein ya apne sales representative ko call kijiye, hum zaroor madad karenge.`,
          );
          try {
            await escalation.ensureWindow(this.transport, custChatR.split('@')[0], `Order ${order.id} — details follow`, order.id);
            const id = await this.transport.sendToChat(custChatR, text);
            this.recordOutgoing(custChatR, id, text);
          } catch (e) {
            store.log(this.key, `${order.id}: could not tell the customer it was rejected: ${String((e && e.message) || e).slice(0, 80)}`);
          }
        }
      } else {
        await tell(ct(`Your order ${order.id} was not approved. Please call us if you want to talk about it.`, `Aapka order ${order.id} approve nahi hua. Baat karni ho to humein call kijiye.`));
      }
      return reply(t(`Rejected ${order.id}. The customer was told.`, `${order.id} reject kar diya. Customer ko bata diya.`));
    }

    let res;
    try {
      res = await orders.confirm(order, { approvedBy: who });
    } catch (e) {
      const full = String((e && e.message) || e);
      // Recorded once, by core/orders.confirm, for every punch the portal refuses.
      store.log(this.key, `${order.id} approved by ${who} but the portal refused it: ${full.slice(0, 600)}`);
      // 25 Sep: MIYA JI MOTORS's order came back 409 "Customer credit control
      // blocked order confirmation" — a credit limit or overdue bills. That
      // is for the Sales Head to clear on the portal, so it is named as such.
      if (/credit control/i.test(full)) {
        const cc = (full.match(/"credit_control":\s*(\{[\s\S]*?\})\s*\}/) || [])[1] || '';
        const reason = (cc.match(/"(?:reason|message)":\s*"([^"]+)"/) || [])[1] || '';
        return reply(
          t(
            `The portal blocked ${order.id}: this customer is on *credit control*${reason ? ` (${reason})` : ''} — credit limit or overdue bills. Nothing was placed. Clear it on the portal, then send *OK ${order.id}* again.`,
            `Portal ne ${order.id} rok diya: customer *credit control* pe hai${reason ? ` (${reason})` : ''} — credit limit ya overdue. Kuch place nahi hua. Portal pe clear karke dobara *OK ${order.id}* bhejiye.`,
          ),
        );
      }
      const why = full.slice(0, 300);
      return reply(t(`The portal did not take it: ${why}\nNothing was placed — send *OK ${order.id}* again to retry.`, `Portal ne nahi liya: ${why}\nKuch place nahi hua — dobara *OK ${order.id}* bhejiye.`));
    }
    if (res && res.busy) return reply(t(`${order.id} is being placed right now.`, `${order.id} abhi place ho raha hai.`));
    if (res && res.noCustomer) return reply(t(`${order.id} has no customer account attached, so the portal cannot bill it. Nothing was placed.`, `${order.id} pe customer account nahi hai, portal bill nahi kar sakta. Kuch place nahi hua.`));
    if (res && res.nothingInStock) {
      store.log(this.key, `${order.id} approved by ${who} — nothing in stock, nothing placed`);
      // All of it is on order: the customer is offered the lot with its ETA.
      const offered = await this.offerEta(order, { skipped: res.skipped || order.lines, short: [] }, null);
      if (offered) {
        order.status = 'eta-offered';
        order.approvedBy = who;
        store.save();
        return reply(
          t(
            `Nothing in ${order.id} is in stock, so nothing was placed now. The customer has been asked to accept an ETA of ${advanceOrders.pretty(offered.etaDate)}; on their yes the parts are booked on the portal as an advance order.`,
            `${order.id} mein abhi kuch stock mein nahi hai, isliye abhi kuch place nahi hua. Customer se ${advanceOrders.pretty(offered.etaDate)} ki ETA ke liye poocha hai; unke haan pe portal pe advance order book ho jayega.`,
          ),
        );
      }
      return reply(t(`Nothing in ${order.id} is in stock now, so nothing was placed on the portal. It stays waiting — *OK ${order.id}* again once stock is in.`, `${order.id} mein abhi kuch stock mein nahi hai, isliye portal pe kuch place nahi hua. Stock aane pe dobara *OK ${order.id}* bhejiye.`));
    }

    order.approvedBy = who;
    store.save();
    const so = (res.placed || []).map((p) => p.soNumber).filter(Boolean).join(', ') || res.soNumber;
    const punched = (res.punchedLines || []).map((l) => `• ${l.partNo} × ${l.qty}`).join('\n');
    // Everything asked for and not punched (founder, 26 Sep: "customer knows
    // which parts order punched and which is not available"): lines with no
    // stock, the rest of short lines, and lines an agent's "only available"
    // took out of the cart before approval.
    const later = [
      ...(res.skipped || []).map((l) => `• ${l.partNo || l.item} × ${l.qty}`),
      ...(res.short || []).map((l) => `• ${l.partNo} × ${l.asked - l.punched} (only ${l.punched} in stock)`),
      ...(order.leftOut || []).map((x) => `• ${x}`),
    ];
    store.log(this.key, `${order.id} approved by ${who} — placed on the portal as ${so}`);
    approvalLog.record({ kind: 'order', id: order.id, event: 'approved', by: who, customer: (order.portalCustomer && order.portalCustomer.name) || null, detail: `portal order ${so}` });
    const pc = order.portalCustomer || {};
    const placedText = (tt, name) =>
      tt(
        `✅ ${name ? `${name} — y` : 'Y'}our order is placed — order no. ${so}.\n\n*Punched (${(res.punchedLines || []).length}):*\n${punched}${later.length ? `\n\n*Not available — could not be punched (${later.length}):*\n${later.join('\n')}` : ''}`,
        `✅ ${name ? `${name} — a` : 'A'}apka order place ho gaya — order no. ${so}.\n\n*Punch hue (${(res.punchedLines || []).length}):*\n${punched}${later.length ? `\n\n*Stock mein nahi — punch nahi ho paye (${later.length}):*\n${later.join('\n')}` : ''}`,
      );
    await tell(placedText(ct, order.requestedBy ? pc.name : null));
    // A salesman's order: the chat is the agent's, so the customer is told on
    // the phone on their account too (never on one of our own numbers).
    const custChat = this.customerChatOf(order);
    if (order.requestedBy && custChat) {
      const to = custChat.split('@')[0];
      try {
        await escalation.ensureWindow(this.transport, to, `Order ${so} placed — details follow`, so);
        const text = placedText(lang.for(custChat), pc.name);
        const id = await this.transport.sendToChat(custChat, text);
        this.recordOutgoing(custChat, id, text);
        store.log(this.key, `${order.id}: customer ${pc.name || ''} told on +${to}`);
      } catch (e) {
        store.log(this.key, `${order.id}: could not tell the customer on +${to}: ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    // Parts on order: the customer is offered them with an ETA, and they are
    // booked in advance only on a yes.
    await this.offerEta(order, res, so);
    return reply(t(`Placed — ${order.id} is portal order ${so}.\n${punched}`, `Place ho gaya — ${order.id} portal order ${so} hai.\n${punched}`));
  }

  // The customer's own chat for an order: the chat itself when they placed it,
  // the phone on their account when a salesman did (never one of our numbers).
  customerChatOf(order) {
    if (!order.requestedBy) return order.chatId || null;
    const pc = order.portalCustomer || {};
    const acct = String(pc.phone || (pc.raw && (pc.raw.phone || pc.raw.mobile)) || '').replace(/\D/g, '').slice(-10);
    const to = acct.length === 10 ? '91' + acct : null;
    if (!to || to === String(order.chatId || '').split('@')[0] || this.isOperator({ from: to })) return null;
    return to + '@cloud';
  }

  // Offer the parts that could not be punched to the customer, with their ETA
  // (core/advanceOrders). With no customer number on a salesman's order, the
  // salesman is asked instead. The salesman hears either way.
  async offerEta(order, res, so) {
    // OFF FOR NOW (founder, 29 Sep: "for now dont escalate eta to customer and
    // prateek sir"): no ETA offer to the customer, no note to whoever placed
    // the order. ETA_OFFERS=true turns it back on.
    if (!config.etaOffers) {
      store.log(this.key, `${order.id}: ETA offer skipped (ETA_OFFERS is off)`);
      return null;
    }
    const custChat = this.customerChatOf(order);
    const to = custChat || order.chatId;
    if (!to) return null;
    try {
      const o = await advanceOrders.offer(this, {
        order,
        res,
        soNumber: so,
        to,
        customerName: (order.portalCustomer && order.portalCustomer.name) || null,
        agentChat: order.requestedBy ? order.chatId : null,
        agentName: order.requestedBy || null,
      });
      if (o && order.requestedBy && custChat) {
        const at = lang.for(order.chatId);
        const text = at(
          `ℹ️ ${o.lines.length} part(s) of ${order.id} are on order. ${o.customerName || 'The customer'} has been asked to accept the ETA (${advanceOrders.pretty(o.etaDate)}); on their yes they are booked as an advance order and you will be told.`,
          `ℹ️ ${order.id} ke ${o.lines.length} part on order hain. ${o.customerName || 'Customer'} se ETA (${advanceOrders.pretty(o.etaDate)}) ke liye poocha hai; unke haan pe advance order book hoga aur aapko bata denge.`,
        );
        const id = await this.transport.sendToChat(order.chatId, text);
        this.recordOutgoing(order.chatId, id, text);
      }
      return o;
    } catch (e) {
      store.log(this.key, `${order.id}: ETA offer failed: ${String((e && e.message) || e).slice(0, 120)}`);
      return null;
    }
  }

  // THE CUSTOMER'S ANSWER TO AN ETA OFFER, acted on - shared by the agent's
  // eta_offer tool (agent/tools/advance) and the fixed yes/no path below.
  // Returns FACTS; whoever talks to the customer words them.
  //   -> { none } | { declined, offer } | { booked, orderNo, offer } | { bookingFailed, offer }
  async etaOfferAnswered(chatId, yes) {
    const o = advanceOrders.pending(chatId);
    if (!o) return { none: true };
    const tellAgent = async (en, hi) => {
      if (!o.agentChat || o.agentChat === chatId) return;
      try {
        const text = lang.for(o.agentChat)(en, hi);
        const id = await this.transport.sendToChat(o.agentChat, text);
        this.recordOutgoing(o.agentChat, id, text);
      } catch (_) {
        /* the customer's answer stands either way */
      }
    };
    if (!yes) {
      advanceOrders.decline(chatId);
      await tellAgent(`${o.customerName || 'The customer'} said NO to the ETA for ${o.orderId} — nothing booked.`, `${o.customerName || 'Customer'} ne ${o.orderId} ki ETA ke liye NA kaha — kuch book nahi hua.`);
      return { declined: true, offer: o };
    }
    let done;
    try {
      done = await advanceOrders.accept(this, chatId);
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 200);
      store.log(this.key, `${o.orderId}: advance order refused by the portal: ${why}`);
      await this.toApprovers(`⚠️ Advance order for ${o.customerName || chatId} (${o.orderId}) — the customer accepted ETA ${advanceOrders.pretty(o.etaDate)}, but the portal refused it: ${why}\nParts:\n${o.lines.map((l) => `• ${l.partNo} × ${l.qty}`).join('\n')}\nPlease book it on the portal by hand.`).catch(() => {});
      return { bookingFailed: true, offer: o };
    }
    if (!done) return { none: true };
    await tellAgent(
      `✅ ${o.customerName || 'The customer'} accepted the ETA — ${o.lines.length} part(s) of ${o.orderId} booked as advance order ${done.soNumber} (expected ${advanceOrders.pretty(o.etaDate)}).`,
      `✅ ${o.customerName || 'Customer'} ne ETA maan li — ${o.orderId} ke ${o.lines.length} part advance order ${done.soNumber} mein book (${advanceOrders.pretty(o.etaDate)} tak).`,
    );
    await this.toApprovers(`📦 *Advance order* ${done.soNumber} — ${o.customerName || chatId} accepted ETA ${advanceOrders.pretty(o.etaDate)} for ${o.orderId}:\n${o.lines.map((l) => `• ${l.partNo} × ${l.qty}`).join('\n')}`).catch(() => {});
    return { booked: true, orderNo: done.soNumber, offer: o };
  }

  // A plain yes/no to a standing ETA offer, answered without the agent: for
  // a salesman asked on the customer's behalf (staff never reach the agent),
  // and for a customer while the agent cannot run. A customer's reply
  // otherwise goes to the agent, which calls eta_offer itself. true when it
  // was one.
  async answerEtaOffer(m, reply, t) {
    const o = advanceOrders.pending(m.chatId);
    if (!o) return false;
    if (!this.isOperator(m) && agent.enabled()) return false;
    const said = String(m.body || '').trim();
    // Gemini reads a typed reply against the offer (founder, 29 Sep); the
    // patterns only when there is no model. Anything else goes on to be
    // answered, and the offer stands.
    let answer = null;
    // (Not for a long message: this runs on every message while an offer is
    // open, and a paragraph is not a reply to it.)
    const read = m.buttonId || !said || said.split(/\s+/).length > 12
      ? null
      : await replyReader.readFormReply({
          flow: 'an offer to book out-of-stock parts in advance',
          step: YESNO('book these parts in advance (a no, or not wanting them, is a no)'),
          question: advanceOrders.offerText(o, t),
          reply: said,
          phone: store.normPhone(m.from),
        });
    if (read) {
      if (read.intent === 'unclear' && read.say) return reply(read.say);
      if (read.intent === 'quit') answer = 'no';
      else if (read.intent === 'answer' && ['yes', 'no'].includes(String(read.value).toLowerCase())) answer = String(read.value).toLowerCase();
    } else {
      answer = advanceOrders.readReply(said, m.buttonId);
    }
    if (!answer) return false;
    const r = await this.etaOfferAnswered(m.chatId, answer === 'yes');
    if (r.none) return false;
    if (r.declined) return reply(t('No problem — nothing has been booked. Just message us whenever you need them.', 'Koi baat nahi — kuch book nahi kiya. Jab zaroorat ho, bas message kar dijiye.'));
    if (r.bookingFailed) return reply(t('Thank you! Our team is booking these for you and will confirm shortly.', 'Shukriya! Hamari team inhe aapke liye book kar rahi hai, thodi der mein confirm karenge.'));
    return reply(advanceOrders.bookedText(o, r.orderNo, t));
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
          salesOrder.mobileOnly()
            ? "To place an order, pick the customer first: send the customer's 10-digit mobile number."
            : "To place an order, pick the customer first: send the customer's phone number or GST number (or \"Kalra Motors ka SO bana do\").",
          salesOrder.mobileOnly()
            ? 'Order ke liye pehle customer chuniye: customer ka 10 digit mobile number bhejiye.'
            : 'Order ke liye pehle customer chuniye: customer ka phone number ya GST number bhejiye (ya "Kalra Motors ka SO bana do").',
        )
      );
    }
    // "Kitni quantity chahiye?" is over once those parts are in the cart with
    // a quantity. 26 Sep, live: it was asked again after "72321M76M01 2pcs,
    // 71822M75L00 4 pcs" had gone into the draft, on every stray message.
    const waitingQty = askQty.get(m.chatId);
    const inCart = orders.findDraft(m.chatId);
    const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (
      waitingQty &&
      waitingQty.items &&
      inCart &&
      inCart.lines.length &&
      waitingQty.items.every((i) => inCart.lines.some((l) => norm(l.partNo || l.item) === norm(i.partNo || i.item)))
    ) {
      askQty.clear(m.chatId);
    } else if (waitingQty && waitingQty.items && waitingQty.items.length) {
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
      // A SALESMAN with no customer picked yet: the parts are kept, and he
      // is asked whose order it is — by phone or GST number, so the portal
      // and Odoo know who is billed and where it ships (founder, 25 Sep).
      // Answered, the parts become that customer's draft.
      if (salesOrder.isSalesPerson(m.from) && !(config.inquiryOnlyNumbers || []).includes(store.normPhone(m.from))) {
        salesOrder.holdItems(m.chatId, usable);
        salesOrder.orderAsked(m.chatId);
        const n = salesOrder.heldCount(m.chatId);
        const ask = t(
          `To order ${n > 1 ? 'these ' + n + ' parts' : 'this'}, which customer is it for? Send the customer's ${salesOrder.mobileOnly() ? '10-digit mobile number' : 'phone number or GST number'}.`,
          `Order karna hai to ${n > 1 ? 'ye ' + n + ' parts' : 'ye'} kis customer ke liye hai? Customer ka ${salesOrder.mobileOnly() ? '10 digit mobile number' : 'phone number ya GST number'} bhejiye.`,
        );
        return reply([shown, askText, ask].filter(Boolean).join(NL));
      }
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
    // The staff agent reads this and writes its own (handleMessage, m._capture).
    if (m._capture) {
      m._capture(outText);
      return true;
    }
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
