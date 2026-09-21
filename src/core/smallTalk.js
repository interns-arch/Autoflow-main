'use strict';
// The messages the order pipeline has nothing to say about.
//
// "Wait" · "This also" · "Can you arrange this?" · "Please collect cheque
// tomorrow" · "You deal in rane also?" · "Bill all available items"
//
// None of these is a part, so the parser returns `other` and the bot says
// NOTHING. On a live chat that reads as broken — the counter man would have
// answered every one of them in four words. 62 of 265 messages in the Kalra
// Motor replay died here.
//
// So this is the ONLY place a model writes something a customer reads. It runs
// after the deterministic pipeline has declined, never before it, and it is
// fenced in hard:
//
//   * it may not quote a rate, a part number, or stock it was not given
//   * it may not confirm, place or cancel an order
//   * it may not promise a date
//   * it may answer, stay quiet, or hand over to a person — nothing else
//
// Anything that trips a fence is thrown away and the bot stays silent, which
// is exactly what it did before. The guardrails can only lose a reply, never
// produce a wrong one.
const config = require('../config');
const store = require('../store');
const conversation = require('./conversation');
const profiles = require('./profiles');

// Whatever we already know them as — filled in by customers.resolve() the
// first time an order/rate lookup runs for this number, and read here for
// free: no extra portal call just to say hello. Nothing yet for a brand new
// number, which is fine — the brief already says not to force a name in.
function knownName(phone) {
  const p = store.normPhone(phone || '');
  if (!p) return null;
  const hit = store.customers().find((c) => store.normPhone(c.phone) === p);
  return (hit && hit.name && String(hit.name).trim()) || null;
}

// The house voice, taught by example rather than by rule. The first block is
// real messages from the Kalra Motor chat with the real answer a person gave,
// or would have.
//
// The block below "jaldi batao yaar..." is curated from
// cartrends_hinglish_whatsapp_500_dataset.csv (18 Sep, 500 synthetic rows
// across 25 intents such as refund, cancel_order, part_compatibility). Not
// copied wholesale:
//   - product_availability, part_compatibility, part_number_identification,
//     bulk_order, order_status, order_confirmation: kept close to the
//     dataset's own "ask for the identifying detail, then check" answers —
//     they never state a price or a stock figure, so they cost nothing.
//   - refund, return, cancel_order, address_change, order_modify,
//     payment_issue, wrong_damaged_item, invoice, discount, human_agent:
//     the dataset answers these itself ("order number bhej do, refund status
//     check karta hoon"), but they are money, an existing order, or a
//     modification — all already (human) territory per WHAT YOU MUST NOT DO
//     above, so the answer here is (human), not the dataset's self-serve one.
//   - price_quote: same reasoning as rate elsewhere in this file — "Rates
//     come from the team, always" - so (human), never "checking the price".
//   - cod, pincode_delivery: left out entirely. Cartrends is a wholesale
//     dealer account business with its own dispatch, not courier/parcel
//     delivery - there is no pincode zone or cash-on-delivery concept
//     anywhere else in this codebase, and teaching the model to entertain one
//     would be inventing a policy that does not exist.
const EXAMPLES = `
Customer: order kr skta hoon?
Us: Haan sir, bilkul. Part number aur quantity bhej dijiye.

Customer: can I place an order here?
Us: Yes sir. Send the part number and quantity.

Customer: kaun si team?
Us: Cartrends ki sales team sir — rate aur billing wahi dekhte hain.

Customer: mtlb kon si team?
Us: Hamari sales team sir, wo aapko call kar legi.

Customer: tum kaun ho / are you a bot?
Us: Cartrends se hoon sir. Parts ki availability turant bata deta hoon.

Customer: kya kya milta hai aapke paas?
Us: Maruti, Hyundai, Toyota, Mahindra — sab genuine parts. Part number bhejiye, check kar deta hoon.

Customer: delivery karte ho?
Us: Haan sir. Order confirm ho jaye to team dispatch ka bata degi.

Customer: kitna time lagega
Us: Jo stock mein hai wo jaldi, baaki on order, ETA = 7 days.

Customer: Wait
Us: Theek hai sir.

Customer: pakka?
Us: Haan sir.

Customer: Ok
Us: (nothing)

Customer: Achha
Us: (nothing)

Customer: ??
Us: (nothing)

Customer: thank you
Us: Welcome sir.

Customer: Can you arrange this?
Us: Haan, check karke abhi batata hoon.

Customer: Need time for this
Us: Theek hai sir, jab chahiye bata dijiyega.

Customer: Please collect cheque tomorrow
Us: (human)

Customer: 8502 OUTSTANDING AMOUNT
Us: (human)

Customer: Send credit of returned items
Us: (human)

Customer: Bill all available items
Us: (human)

Customer: mera pichla order abhi tak nahi aaya
Us: (human)

Customer: thanks bhai
Us: Anytime 😊

Customer: (first message) hi, ye Rahul Motors se bol raha hoon
Us: Hi Rahul, kaise help karun?

Customer: jaldi batao yaar, dukaan band karni hai
Us: Bataiye, jaldi karta hoon.

Customer: thank you
Us: No problem.

Customer: bulk order chahiye
Us: Part numbers aur quantities bhej do, bulk availability check karta hoon.

Customer: ye part meri car me lagega?
Us: Car ka make, model aur year bhej do, fitment check karta hoon.

Customer: part no kaha likha hota hai
Us: Part ki clear photo bhej do, number identify karne ki try karta hoon.

Customer: mera order kaha hai
Us: Order number bhej do, abhi status check karta hoon.

Customer: order place ho gaya kya?
Us: Order number bhej do, confirmation status check karta hoon.

Customer: stock me hai?
Us: Part number ya product name bhej do, stock check karta hoon.

Customer: mujhe human se baat karni hai
Us: (human)

Customer: refund kab milega
Us: (human)

Customer: return kaise karna hai
Us: (human)

Customer: order cancel karna hai
Us: (human)

Customer: delivery address change karna hai
Us: (human)

Customer: order me item add kar sakte hain?
Us: (human)

Customer: payment failed aa raha hai
Us: (human)

Customer: wrong item mila
Us: (human)

Customer: invoice chahiye
Us: (human)

Customer: discount milega?
Us: (human)
`.trim();

const SYSTEM = `You answer WhatsApp messages for CARTRENDS, an auto-parts supplier in Gurugram selling to dealers and garages.

You are the person at the parts counter, typing on a phone between customers. Short. Plain. No structure.

WHAT YOU KNOW, and may say:
- Cartrends supplies genuine spare parts \u2014 Maruti Suzuki, Hyundai, Toyota, Mahindra and others.
- This WhatsApp number checks availability and takes orders. Yes, they can order here.
- The way to order is simple: send the part number and quantity.
- Something not in stock comes "on order, ETA = 7 days".
- "Our team" means the Cartrends sales team. They handle rates, billing, dispatch and payments, and they call the customer back.
- The customer is a dealer buying for their workshop. Treat them as one.

WHAT YOU MUST NOT DO:
- Never state a price, a rate or an amount. Rates come from the team, always.
- Never say whether a specific part is in stock \u2014 you have not checked. The system checks that separately when they send a part number.
- Never confirm, place, cancel or modify an order.
- Never promise a delivery date or a time. "ETA = 7 days" for an out-of-stock part is the only timing you may repeat.
- Never invent a part number.

PERSONALIZATION:
- When the brief below gives you "Customer's name", that is who you're talking to — use it the way a counter guy would, not a form letter: mainly at the start of a conversation, or wherever it feels natural, never forced into every line. No name given -> don't guess one.

Reply ONLY with JSON, one of:

  {"action":"reply","text":"..."}   you can answer it \u2014 one or two short lines
  {"action":"silent"}               nothing needs saying ("ok", "achha", "??")
  {"action":"human"}                MONEY or a specific existing order: cheques,
                                    outstanding, credit notes, returns, billing
                                    instructions, a complaint, or "where is my
                                    order". Only these. A general question about
                                    what you sell or how to order is NOT this.

STYLE:
- Match the customer's language exactly: Hinglish gets Hinglish, English gets English. Mostly Hindi in, more Hindi back; mostly English in, lighter Hinglish back. Don't translate every English word into Hindi, and don't reach for textbook-formal Hindi ("kripya", "aadesh sankhya", "samasya") \u2014 nobody at the counter talks like that.
- One line usually. Two at the very most. Give the answer first, then anything else \u2014 never bury it after a preamble.
- If you ask something, ask ONE thing. Don't stack two questions in one message, and don't re-ask what they already told you two lines ago.
- No "Certainly", "Absolutely", "I'd be happy to help", "Thank you for reaching out", "I understand your concern", "We sincerely apologize for the inconvenience", "Please don't hesitate to contact us", "Is there anything else I can help you with", "Rest assured", "Hope this helps", "your satisfaction is our priority". No headings, no bullets, no email voice.
- Say "sir" the way the counter does \u2014 often, but not in every sentence, and never "bro"/"ma'am" unless the customer's own tone invites it.
- Match their mood, don't paper over it. Annoyed about a delay -> deal with the actual thing, not a generic sorry. In a hurry -> answer straight, skip the small talk. Just said thanks -> a short "Anytime" or "Ji \ud83d\udc4d", nothing tacked on after it.
- A name to use is given below when we have one. Use it near the start of a conversation, or when it lands naturally \u2014 never stuffed into a sentence just to personalize it, and never in back-to-back messages.
- Vary how you open. Don't answer every message with "Hi" \u2014 most of the time, when the conversation is already going, just answer.
- Emojis occasionally, not on every line, and never more than one.

Here is how this counter actually talks:

${EXAMPLES}`;

// ---------------------------------------------------------------- fences
// Everything below decides whether a generated line is allowed out. It only
// ever REJECTS. A reply that trips any of these is dropped and the bot stays
// silent — the behaviour it had before this file existed.

const PART_LIKE = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g;
const MONEY =
  /(₹|\brs\.?\b|\brupee|\bprice\b|\brate\b|\bmrp\b|\bdiscount\b|\bpaise\b|\b\d{3,}(\.\d{2})?\s*(rs|rupees)?\b)/i;
const PROMISE =
  /\b(order (is )?(placed|confirmed|booked)|confirm(ed|ing)? (your|the) order|dispatch(ed|ing)? (today|tomorrow)|deliver(ed|y)? (today|tomorrow)|kal (bhej|aa) ?(denge|jayega)|aaj hi (bhej|nikal))\b/i;
const STOCK_CLAIM = /\b(in stock|out of stock|stock (hai|nahi)|available hai|not available|avl\b)/i;
const AI_TELL =
  /\b(certainly|absolutely|of course|i'?d be happy|i understand your concern|great question|here (are|is) (a |the )?(detailed|list|steps)|as an ai|i apologi[sz]e for any|thank you for reaching out|please don'?t hesitate|is there anything else i can|rest assured|hope this helps|your satisfaction|we sincerely apologi[sz]e|kripya|humein khed hua)/i;

function fenceFails(text, context) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (t.length > 220) return 'too long';
  if (t.split('\n').length > 2) return 'more than two lines';
  if (MONEY.test(t)) return 'mentions money or a rate';
  if (PROMISE.test(t)) return 'promises an order or a date';
  if (STOCK_CLAIM.test(t)) return 'claims stock it has not checked';
  if (AI_TELL.test(t)) return 'assistant boilerplate';
  // A part number may only be repeated back, never introduced.
  const said = String(context || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  for (const tok of t.match(PART_LIKE) || []) {
    if (!said.includes(tok.toUpperCase().replace(/[^A-Z0-9]/g, ''))) return `invented a part number (${tok})`;
  }
  return null;
}

// When the Understand model has said a message is conversation, nobody is
// asked about it - so the reply may not pretend somebody was.
const NO_HUMAN =
  '\n\nTHIS MESSAGE IS NOT GOING TO A PERSON: answer it in words, or choose silent. Never choose human, and never say you have told or passed it to the team. (NOT going to a person)';
// Nor promise that someone will do something: "wahi contact karenge aapse" and
// "sales team call karke confirm kar degi" went out in the sandbox on 13 Sep
// with no one told. Listing phrasings lost that race, so with nobody asked a
// reply may not mention the team or say what anyone WILL do.
const PASSED_ON =
  /\bteam\b|\b(bata diya|passing (this|it)|passed (this|it)|forwarded|informed|get back to you|will (contact|call|reach|get back|confirm|arrange|send|check))\b|\b\w+(enge|egi|ega|lenge|legi|lega|denge|degi|dega|yenge|yegi|yega)\b/i;

// text -> { action, text } | null. Never throws: a failure here must leave the
// bot exactly as silent as it used to be, not break the message.
// opts.noHuman: the model decided nobody is asked; a hand-over is a refusal.
async function respond(chatId, message, phone, opts = {}) {
  // ANY model will do — ai.claude() falls back to Gemini on its own. This
  // used to ask for the Anthropic key specifically, so when that key was
  // revoked the bot went quiet on every conversational message even though
  // a perfectly good model was configured.
  if (!require('./ai').modelAvailable()) return null;
  const body = String(message || '').trim();
  if (!body || body.length > 400) return null;

  // A message carrying a PART NUMBER is never conversation, whatever the
  // parser made of it. "43430-0K021 another part no" reached here on the live
  // line and was handed to a person as "not a parts question" — with the part
  // number sitting in it. When the order pipeline has declined something like
  // this, silence is right: the part is already being looked at, or the
  // customer is about to be asked for the number.
  if (PART_LIKE.test(body)) {
    PART_LIKE.lastIndex = 0;
    store.log('chat', `not conversation — a part number is in it: "${body.slice(0, 60)}"`);
    return null;
  }
  PART_LIKE.lastIndex = 0;

  const history = conversation.recent(chatId, 12);
  const style = conversation.styleOf(chatId, body);
  const name = knownName(phone);
  const user =
    `Language the customer writes in: ${style.language === 'hi' ? 'Hinglish' : 'English'}\n` +
    `Tone: ${style.formality}\n` +
    (name ? `Customer's name: ${name}\n` : '') +
    '\n' +
    (history ? `Conversation so far:\n${history}\n\n` : '') +
    `Their new message:\n${body}`;

  let r;
  try {
    // The profile's style note is appended to the brief; the customer's own
    // name went into `user` above, next to language and tone, since it is a
    // fact about THIS message like they are, not a standing style rule. The
    // brief already forbids stating a price or a stock figure, so either one
    // can only change how a reply reads, never what it is allowed to say.
    r = await require('./ai')._claude(SYSTEM + profiles.briefFor(phone) + (opts.noHuman ? NO_HUMAN : ''), user);
  } catch (e) {
    store.log('chat', 'smalltalk failed: ' + String((e && e.message) || e).slice(0, 100));
    // Said as a refusal, so the bot answers with where things stand instead
    // of leaving the customer with nothing.
    return { action: 'silent', refused: 'model failed' };
  }
  if (!r || !r.action) return null;
  if (r.action === 'silent') return { action: 'silent' };
  if (r.action === 'human') return opts.noHuman ? { action: 'silent', refused: 'wanted a person' } : { action: 'human' };
  if (r.action !== 'reply') return null;

  // The model may only repeat part numbers already in the conversation.
  const bad = fenceFails(r.text, history + '\n' + body) || (opts.noHuman && PASSED_ON.test(r.text) ? 'promises something' : null);
  if (bad) {
    store.log('chat', `smalltalk reply refused (${bad}): ${String(r.text || '').slice(0, 80)}`);
    // `refused`, not a chosen silence: the model had something to say and it
    // was not safe. 13 Sep, live: "5 p" and "Kya hua" both ended here and the
    // customer got nothing at all. The bot replaces it (customerBot.converse).
    return { action: 'silent', refused: bad };
  }
  return { action: 'reply', text: String(r.text).trim() };
}

module.exports = { respond, fenceFails, SYSTEM };
