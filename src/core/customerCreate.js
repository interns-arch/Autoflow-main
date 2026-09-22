'use strict';
// A NEW CUSTOMER, asked for one question at a time.
//
// The paper form says "filled by the sales person, goes to Sales Head for
// approval, then to the data team for entry". This is that form, asked in
// chat — and the approval is kept, deliberately. Two of its fields are
// credit limit and brand-wise discount, and the person being onboarded does
// not get to set those. So:
//
//   customer answers  -> the facts about their firm
//   config supplies   -> the commercial defaults (core config `creation`)
//   an approver says yes -> only then is anything created on the portal
//
// The order of the questions follows the paper form, because the sales desk
// reads them in that order when they check one.
//
// The GSTIN is asked FIRST and does most of the typing: the firm's name,
// registered address, city, state and PIN are public record against it
// (integrations/gst), so those questions are filled and skipped. A garage
// owner typing an address on a phone gets it wrong; the GST register does
// not. A cancelled registration is refused outright — an order billed
// against a closed GSTIN is a problem nobody wants to find later.
const store = require('../store');
const config = require('../config');
const chatState = require('./chatState');

const open = chatState.slot('customerCreate'); // chatId -> form in progress
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // a form abandoned at lunch is not resumed at five

function sweep() {
  const now = Date.now();
  for (const [chatId, f] of open) if (now - (f.at || 0) > MAX_AGE_MS) open.delete(chatId);
}

// ---------------------------------------------------------------- the form

// Shape only, never a lookup. A wrong-shaped GSTIN is a typo worth catching
// in the moment; a well-shaped one that belongs to nobody is a job for the
// person who approves this.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/i;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_RE = /^[1-9][0-9]{5}$/;

const SKIP = /^(skip|nahi|nhi|no|na|-|n\/a|none|baad mein|later)$/i;
// A way OUT. Once the form is open every message is an answer to it, so
// without this a customer who changed their mind would be filling in a shop
// address to escape. Their cart is untouched — only the form closes.
const QUIT = /^(cancel|stop|rehne do|rhne do|chhodo|chodo|baad me karenge|baad mein karenge|nahi banana|abhi nahi)$/i;

// GSTIN FIRST, because it answers five of the questions below on its own.
// A firm's name, registered address, city, state and PIN are public record
// against its GSTIN, and a garage owner typing them on a phone gets them
// wrong. Everything the lookup fills is marked `fromGst` so the form skips
// it, and the customer is shown what was found before it is used.
const FIELDS = [
  {
    // ONLY when someone is opening an account for a firm that is not
    // theirs — a sales agent at a counter, or a customer who already has
    // an account and is registering a friend. Everyone else is writing
    // from the number being registered, so this is skipped.
    key: 'phoneFor',
    req: true,
    type: 'phone',
    when: (form) => form.forSomeoneElse === true,
    ask: [
      'Whose account is this? Send their WhatsApp number.',
      'Kiska account banana hai — unka WhatsApp number bhejiye.',
    ],
  },
  {
    key: 'gstNo',
    req: true,
    type: 'gst',
    // A Sales Head has already seen this firm cannot produce a verified
    // GSTIN and said to carry on. Asking again would just repeat the
    // three failures that got it escalated.
    when: (form) => form.gstWaived !== true,
    // No "skip". A verified GSTIN is the condition for opening an account
    // over WhatsApp at all: it is the only thing in this form that proves
    // the firm exists and that the person typing is not inventing one. The
    // shape is NOT checked here — integrations/gst checks it first and
    // costs nothing for a typo, and the tries are counted in one place.
    ask: ['GST number?', 'GST number bhej dijiye — baaki details khud bhar jayengi.'],
    clean: (v) => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    key: 'name',
    req: true,
    ask: ['Firm / shop name?', 'Firm ya shop ka naam?'],
  },
  {
    key: 'businessType',
    req: true,
    ask: ['Business type? (retailer / wholesaler / garage / fleet)', 'Business type? (retailer / wholesaler / garage / fleet)'],
  },
  {
    key: 'contactPerson',
    req: true,
    ask: ['Contact person ka naam?', 'Contact person ka naam?'],
  },
  {
    key: 'contactPhone',
    req: true,
    type: 'phone',
    // Usually the number they are typing from, which is why "same" is an
    // answer. Often it is not: the owner registers, the manager answers
    // the phone. The portal has no box for it, so it travels in remarks.
    ask: [
      'Contact person ka phone number? (agar yahi number hai to "same" likh dijiye)',
      'Contact person ka phone number? (agar yahi number hai to "same" likh dijiye)',
    ],
  },
  {
    key: 'panNo',
    req: false,
    // Asked only if the GSTIN somehow did not supply it. Characters 3-12 of
    // any GSTIN ARE the PAN, by construction, so a verified GSTIN answers
    // this question and the customer never sees it.
    ask: ['PAN number? (optional)', 'PAN number? (optional, "skip" chalega)'],
    check: (v) => (PAN_RE.test(v.replace(/\s/g, '')) ? null : 'PAN 10 character ka hota hai, jaise AABCU9603R. Dobara bhejiye ya "skip".'),
    clean: (v) => v.replace(/\s/g, '').toUpperCase(),
  },
  {
    key: 'email',
    // NOT optional. The portal sends every invoice and statement to it, and
    // an account opened without one has no way to be billed.
    req: true,
    ask: ['Email address?', 'Email address? (invoice isi par jayega)'],
    check: (v) => (EMAIL_RE.test(v) ? null : 'Email theek nahi lag raha. Dobara bhejiye.'),
    clean: (v) => v.trim().toLowerCase(),
  },
  {
    key: 'address',
    req: true,
    ask: ['Shop ka pura address?', 'Shop ka pura address?'],
  },
  { key: 'city', req: true, ask: ['City?', 'City?'] },
  { key: 'state', req: true, ask: ['State?', 'State?'] },
  {
    key: 'pin',
    req: true,
    ask: ['PIN code?', 'PIN code?'],
    check: (v) => (PIN_RE.test(v.replace(/\s/g, '')) ? null : 'PIN 6 digit ka hota hai. Dobara bhejiye.'),
    clean: (v) => v.replace(/\s/g, ''),
  },
  // THE PHOTO IS ASKED FOR FIRST, because it may answer the question
  // after it. A picture taken at the shop often carries the camera's own
  // GPS fix, and when it does there is no reason to ask for a pin as well.
  {
    key: 'shopPhoto',
    req: true,
    type: 'photo',
    ask: [
      'Shop ke saamne ki photo bhejiye — board/banner dikhna chahiye.',
      'Shop ke saamne ki photo bhejiye — shop ka board ya banner dikhna chahiye.',
    ],
  },
  {
    key: 'location',
    req: true,
    type: 'location',
    // The photo before this one may have carried a GPS fix. If it did,
    // the answer is already on the form under lat/lng and asking for a
    // pin is asking for something we are holding.
    when: (form) => form.answers.lat === undefined,
    // Typing "28.6139" by hand is how a shop ends up in the sea. WhatsApp's
    // own location share is one tap and exact.
    ask: [
      'Shop ki location bhej dijiye — attach (📎) → Location → Send your current location.',
      'Shop ki location bhej dijiye — attach (📎) → Location → Send your current location.',
    ],
  },
  { key: 'remarks', req: false, ask: ['Aur kuch batana hai? (optional)', 'Aur kuch batana hai? (optional)'] },
];

// What a CUSTOMER is never asked. These are the Sales Head's to set, and
// they are filled from config so the request is complete when it reaches
// them — an approver changing a number is a conversation, a customer
// choosing one is not.
function commercialDefaults() {
  return {
    creditDays: config.creation.defaultCreditDays,
    creditLimit: config.creation.defaultCreditLimit,
  };
}

// "Create customer", "account bana do", "naya account chahiye".
//
// 21 Sep, live: a customer typed "Create coustomer" and the bot searched the
// catalogue for it, answering with sixty headlight restorers. There was no
// way to ASK for the form — it only opened by itself when an unregistered
// number confirmed an order. Spellings are loose on purpose: coustomer,
// custmer and costumer are all how it actually arrives.
const WORD_ACCOUNT = '(?:customer|coustomer|custmer|costumer|custumer|account|akaunt|khata|khaata|id)';
const WORD_MAKE = '(?:creat\\w*|new|naya|nayi|register|registr\\w*|banao|bana\\s?do|bana\\s?dijiye|banana|banwana|kholo|khol\\s?do|open|add)';
const START_RE = new RegExp(
  `\\b${WORD_MAKE}\\b[\\s\\S]{0,24}\\b${WORD_ACCOUNT}\\b` +
    `|\\b${WORD_ACCOUNT}\\b[\\s\\S]{0,24}\\b${WORD_MAKE}\\b` +
    `|\\b${WORD_ACCOUNT}\\s+(?:chahiye|chaiye|kab\\s+banega|nahi\\s+hai)\\b`,
  'i',
);
// The same words appear in questions ABOUT an account, which are not a
// request to open one. "Account balance", "khata dekho", a ledger.
const NOT_START_RE = /\b(balance|statement|ledger|bakaya|baaki|outstanding|bill|invoice|payment|due|kitna|number|no\.?)\b/i;

// THE BUTTON, and the words for anyone whose transport has no buttons or
// who simply types. "Kisi aur ka" is the phrase the button is labelled
// with, so a customer who reads the label and types it lands here too.
const SOMEONE_ELSE_RE =
  /^(CREATE_FOR_OTHER|kisi\s*aur\s*(ka|ke|ki)?( account)?( banana hai)?|kisi\s*or\s*ka|someone\s*else|for\s*someone\s*else|doosre\s*ka|dusre\s*ka)$/i;

function wantsSomeoneElse(text) {
  return SOMEONE_ELSE_RE.test(String(text || '').trim());
}

// The button that says no. Nothing to do but say fine.
function declinedCreate(text) {
  return /^(CREATE_NO|nahi,? rehne do|rehne do|nahi)$/i.test(String(text || '').trim());
}

// A colleague on the creation team, by name. An account they open goes on
// the portal as theirs — and they are never told "you already have an
// account", because the one being opened is not theirs.
function agentName(phone) {
  return config.creation.team[store.normPhone(phone)] || null;
}

function wantsToStart(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 90) return false;
  if (NOT_START_RE.test(t)) return false;
  return START_RE.test(t);
}

// ------------------------------------------------------------- the machine

function pending(chatId) {
  sweep();
  return open.get(chatId) || null;
}

function cancel(chatId) {
  open.delete(chatId);
}

function fieldAt(i) {
  return FIELDS[i] || null;
}

// Start the form. `by` is whoever is filling it in — a salesman on the
// customer's behalf, or the customer themselves.
//
// `forSomeoneElse` means the account being opened is NOT the number this
// is being typed from: a sales agent standing at a counter, or a customer
// who already has an account registering someone they know. The first
// question then becomes whose number it is.
function start(chatId, phone, t, opts) {
  sweep();
  const filler = store.normPhone(phone);
  const forSomeoneElse = Boolean(opts && opts.forSomeoneElse);
  // A number on the creation team is a colleague filling this in; anyone
  // else is the customer registering themselves. Recorded because the
  // approver needs to know which they are reading — and because the portal
  // keeps it as the sales representative on the account.
  const agent = config.creation.team[filler] || null;
  const form = {
    at: Date.now(),
    chatId,
    phone: filler,
    byName: agent,
    forSomeoneElse,
    idx: 0,
    answers: {
      // Their own number, unless they are opening it for somebody else —
      // in which case the first question asks whose it is.
      ...(forSomeoneElse ? {} : { phone: filler }),
      // WHO OPENED IT. Anik, 12 Sep, about sales orders: "baad mein main
      // dekh paun kis agent ne kitna kiya". The same question gets asked
      // about accounts. A customer registering themselves has no agent, and
      // the field is left off rather than filled in with their own name.
      ...(agent ? { createdByName: agent, createdByPhone: filler } : {}),
    },
  };
  // Not an answer to a question — it decides which questions there are.
  if (forSomeoneElse) form.answers.openedFor = 'someone else';
  open.set(chatId, form);
  store.log('create', chatId + ': customer form started by ' + (agent || filler) + (forSomeoneElse ? ' FOR someone else' : ''));

  // The first question is not always FIELDS[0]: "whose account is this"
  // only exists when the form is being filled in for somebody else, and
  // idx has to point at whatever is actually being asked or the answer is
  // read as the answer to a question nobody saw.
  form.idx = FIELDS.findIndex((f) => !f.when || f.when(form));
  const first = FIELDS[form.idx];
  const lead = forSomeoneElse
    ? 'Theek hai — unka account bana dete hain. Kuch details chahiye, ek ek karke poochta hoon.'
    : 'Account banane ke liye kuch details chahiye — ek ek karke poochta hoon.';
  return t(lead + '\n\n' + first.ask[1], lead + '\n\n' + first.ask[1]);
}

// One answer. `m` is the whole message, so a photo or a dropped pin can be
// the answer as easily as text.
//
// Returns { reply, done, form } — `done` true when every field is in.
async function answer(chatId, m, text, t) {
  const form = pending(chatId);
  if (!form) return null;
  const field = fieldAt(form.idx);
  if (!field) return null;

  const said = String(text || '').trim();
  form.at = Date.now();

  if (QUIT.test(said)) {
    open.delete(chatId);
    store.log('create', `${chatId}: customer form cancelled by the customer`);
    return {
      reply: t(
        'Theek hai, rehne dete hain. Jab kahiye tab bana denge — aapki list waise hi hai.',
        'Theek hai, rehne dete hain. Jab kahiye tab bana denge — aapki list waise hi hai.',
      ),
      done: false,
      quit: true,
      form,
    };
  }

  // "skip" on an optional field moves on; on a required one it does not.
  if (SKIP.test(said)) {
    // The GSTIN is the one field with a reason worth giving. "Ye chhod
    // nahi sakte" invites an argument; saying a firm without GST is opened
    // by a person ends it, and that is what actually happens next.
    if (field.type === 'gst' && !form.gstWaived) {
      return escalate(form, 'no-gst', t);
    }
    if (field.req && field.type !== 'location' && field.type !== 'photo') {
      return { reply: t('Ye chhod nahi sakte sir — ' + field.ask[1], 'Ye chhod nahi sakte sir — ' + field.ask[1]), done: false, form };
    }
    if (!field.req) return advance(form, t);
  }

  if (field.type === 'location') {
    const loc = m && m.location;
    if (!loc || !Number.isFinite(loc.lat)) {
      return {
        reply: t(
          'Location attach karke bhejiye (📎 → Location). Type karne ki zarurat nahi.',
          'Location attach karke bhejiye (📎 → Location). Type karne ki zarurat nahi.',
        ),
        done: false,
        form,
      };
    }
    form.answers.lat = loc.lat;
    form.answers.lng = loc.lng;
    return advance(form, t);
  }

  if (field.type === 'photo') {
    if (!m || !m.mediaBase64 || !/^image\//.test(m.mediaMime || '')) {
      return {
        reply: t('Photo bhejiye sir — shop ke saamne ki, board dikhna chahiye.', 'Photo bhejiye sir — shop ke saamne ki, board dikhna chahiye.'),
        done: false,
        form,
      };
    }

    // IS IT ACTUALLY A SHOP, AND IS THE BOARD IN IT?
    //
    // The board is the point: it is what ties the photograph to the firm
    // name on the GST certificate, and it is the first thing an approver
    // looks for. A selfie or a picture of a part gets one honest retry.
    //
    // A model that could not be reached says NOTHING, and nothing is not a
    // refusal — the photo is accepted and the approver decides, exactly as
    // before any of this existed.
    const look = await require('./ai').readShopPhoto(m.mediaBase64, m.mediaMime);
    if (look && !look.isShop) {
      form.photoTries = (form.photoTries || 0) + 1;
      if (form.photoTries < 2) {
        return {
          reply: t(
            'That does not look like a shop. Please send a photo of the shop front, with the signboard visible.',
            'Ye shop ki photo nahi lag rahi. Shop ke saamne ki photo bhejiye, jisme board dikhe.',
          ),
          done: false,
          form,
        };
      }
      // Asked twice is enough. Some shops genuinely have no front worth
      // photographing, and an account must not die on a camera angle.
      form.answers.photoNote = 'does not look like a shop';
    } else if (look && look.isShop && !look.hasBanner) {
      form.photoTries = (form.photoTries || 0) + 1;
      if (form.photoTries < 2) {
        return {
          reply: t(
            'I cannot see the signboard. One more please, with the shop name board in the frame.',
            'Board nahi dikh raha. Ek aur bhejiye — shop ke naam wala board frame mein aa jaye.',
          ),
          done: false,
          form,
        };
      }
      form.answers.photoNote = 'no signboard visible';
    }
    if (look && look.bannerText) form.answers.bannerText = look.bannerText;

    // The bytes are NOT kept in state.json: it is rewritten whole on every
    // save and a photo in it would be copied on every write. chatLog already
    // stored this image on disk when it arrived; the approver is sent the
    // picture itself, which is what they actually look at.
    form.answers.shopPhoto = { mime: m.mediaMime, bytes: m.mediaBase64.length };
    form._photo = m.mediaBase64;

    // THE CAMERA MAY HAVE ANSWERED THE NEXT QUESTION ALREADY. A photo taken
    // at the shop often carries a GPS fix, and when it does, asking for a
    // pin is asking for something we are holding.
    //
    // Usually it does not: WhatsApp strips EXIF from anything sent as a
    // photo. It survives when the picture is sent as a DOCUMENT. So this
    // fires sometimes and the pin is still asked for the rest of the time.
    const fix = require('./exif').gpsFrom(m.mediaBase64);
    if (fix && form.answers.lat === undefined) {
      form.answers.lat = fix.lat;
      form.answers.lng = fix.lng;
      form.answers.locationFrom = 'photo';
      store.log('create', `${form.chatId}: location read from the photo (${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)})`);
      const step = advance(form, t);
      const said = t(
        'Got it — I took the location from the photo itself.\n\n',
        'Photo se hi location mil gayi — alag se bhejne ki zarurat nahi.\n\n',
      );
      return step.done ? step : { ...step, reply: said + step.reply };
    }
    return advance(form, t);
  }

  if (!said) {
    return { reply: t(field.ask[1], field.ask[1]), done: false, form };
  }

  // THE CONTACT PERSON'S PHONE. Usually the number they are typing from,
  // which is why "same" is an answer worth having — but often it is the
  // manager's, not the owner's, so it cannot just be assumed.
  if (field.type === 'phone') {
    const same = /^(same|wahi|yahi|yeh hi|ye hi|yahi number|same number|wahi number)$/i.test(said);
    const digits = same ? form.answers.phone : String(said).replace(/[^0-9]/g, '');
    // 10 local digits, or 12 with the 91. Anything else is a typo, and a
    // typo here is a number nobody can ring.
    const norm = digits.length === 10 ? '91' + digits : digits;
    if (!/^91[6-9][0-9]{9}$/.test(norm)) {
      return {
        reply: t(
          'That does not look like a mobile number. Send 10 digits, or "same" for this one.',
          'Ye mobile number nahi lag raha. 10 digit bhejiye, ya "same" likh dijiye.',
        ),
        done: false,
        form,
      };
    }
    // The first field, when an agent is opening this for someone else,
    // sets the account's OWN number — not a contact number.
    if (field.key === 'phoneFor') {
      const taken = await refuseIfTaken(form, 'phone', norm, t);
      if (taken) return taken;
      form.answers.phone = norm;
      return advance(form, t);
    }

    form.answers.contactPhone = norm;
    // Only worth checking when it is NOT the number they are writing from:
    // that one was looked up before the form ever opened.
    if (norm !== form.answers.phone) {
      const taken = await refuseIfTaken(form, 'contactPhone', norm, t);
      if (taken) return taken;
    }
    return advance(form, t);
  }
  if (field.check) {
    const problem = field.check(said);
    if (problem) return { reply: problem, done: false, form };
  }
  form.answers[field.key] = field.clean ? field.clean(said) : said;

  // THE GSTIN FILLS THE FORM IN. Five questions answered by one.
  if (field.type === 'gst') return fillFromGst(form, form.answers.gstNo, t);

  // An email the portal already has will be refused at the create. Better
  // here, where the customer can simply give another one.
  if (field.key === 'email') {
    const taken = await refuseIfTaken(form, 'email', form.answers.email, t);
    if (taken) return taken;
  }
  return advance(form, t);
}

// How many GSTINs a customer may try before this stops being a typo and
// starts being a firm we cannot verify. Counted across ALL failures —
// wrong shape, not on the register, cancelled — because from the form's
// point of view they are the same thing: no verified firm.
const MAX_GST_TRIES = 3;

// The form cannot go on, and the customer must not be left on it. Their
// side closes with an honest sentence; the request goes to the Sales Heads
// with the GSTINs that were tried, and THEY decide whether this account is
// opened by hand. Nothing is created either way — this is a hand-off, not
// a rejection the customer has to argue with.
function escalate(form, why, t) {
  // An unverified GSTIN is never kept as THE GSTIN — an account must not
  // carry a number nobody confirmed. It is recorded as something that was
  // tried, which is what the approver needs to see.
  const tried = form.gstTried || [];
  for (const g of [form.answers.gstNo, form.answers._lastGst]) if (g && !tried.includes(g)) tried.push(g);
  if (tried.length) form.answers.gstTried = tried;
  delete form.answers.gstNo;
  delete form.answers._lastGst;
  delete form.answers._firm;
  form.answers.gstVerified = false;
  form.answers.requestId = 'WA-' + Date.now().toString(36).toUpperCase();
  form.answers.kind = 'gst-review';
  form.answers.gstProblem = why;
  Object.assign(form.answers, commercialDefaults());
  open.delete(form.chatId);
  store.log('create', `${form.chatId}: GST not verified (${why}) — ${form.answers.requestId} to the Sales Heads`);
  return {
    reply: t(
      'I could not verify that GST number, so I cannot open the account from here. Our team is checking it and will call you.',
      'Ye GST number verify nahi ho paya, isliye main yahan se account nahi khol sakta. Hamari team check kar rahi hai, aapko call aayega.',
    ),
    done: false,
    review: true,
    form,
  };
}

// A GSTIN that did not verify. Either ask again, or — once the tries are
// used up — hand it to a person.
function gstFail(form, why, message, t) {
  delete form.answers.gstNo;
  form.gstTries = (form.gstTries || 0) + 1;
  form.gstTried = form.gstTried || [];
  const last = form.answers._lastGst;
  if (last && !form.gstTried.includes(last)) form.gstTried.push(last);
  form.answers.gstTried = form.gstTried;

  if (form.gstTries >= MAX_GST_TRIES) return escalate(form, why, t);

  const left = MAX_GST_TRIES - form.gstTries;
  open.set(form.chatId, form);
  return {
    reply: `${message} (${left} ${left === 1 ? 'koshish' : 'koshishein'} baaki)`,
    done: false,
    form,
  };
}

// THE PORTAL WILL NOT HOLD IT TWICE.
//
// Asked while the customer is still here to answer, rather than at the
// create — which happens after they have answered everything and a Sales
// Head has approved it, and where the only thing left to do is apologise.
//
// A check that could NOT be made is not a pass: it is recorded on the form
// so the approver reads "email not checked" instead of assuming it was.
const DUP_LABEL = { gstNo: 'GST number', email: 'email', contactPhone: 'number', phone: 'number' };

async function refuseIfTaken(form, field, value, t) {
  const portal = require('../integrations/dealerPortal');
  let r;
  try {
    // findDuplicate asks the portal, and the portal only knows 'phone' —
    // a contact number is looked up exactly like any other mobile.
    const asks = field === 'contactPhone' ? 'phone' : field;
    r = await portal.findDuplicate({ [asks]: value });
  } catch (e) {
    store.log('create', form.chatId + ': duplicate check threw — ' + String((e && e.message) || e).slice(0, 80));
    return null;
  }

  const note = (k) => {
    form.notChecked = form.notChecked || [];
    if (!form.notChecked.includes(k)) form.notChecked.push(k);
  };
  for (const u of (r && r.unchecked) || []) note(u);

  if (!r || r.dup !== true) {
    if (r && r.dup === null) note(field);
    return null;
  }

  const what = DUP_LABEL[field] || field;
  const whose = r.name ? ' (' + r.name + ')' : '';
  delete form.answers[field];
  store.log('create', form.chatId + ': ' + field + ' ' + value + ' is already on the portal' + whose);
  return {
    reply: t(
      'That ' + what + ' is already registered with us' + whose + '. Please send a different one.',
      'Ye ' + what + ' pehle se hamare paas registered hai' + whose + '. Koi doosra bhejiye.',
    ),
    done: false,
    form,
  };
}

async function fillFromGst(form, gstin, t) {
  const gst = require('../integrations/gst');
  form.answers._lastGst = gstin;
  const firm = await gst.lookup(gstin);

  // Wrong shape. Caught before the network, so a typo never costs a credit.
  if (firm && firm.error === 'shape') {
    return gstFail(form, 'shape', t(
      'That is not a GST number — they are 15 characters, like 07AABCU9603R1ZM. Send it again.',
      'Ye GST number nahi lag raha — 15 character ka hota hai, jaise 07AABCU9603R1ZM. Dobara bhejiye.',
    ), t);
  }

  if (firm && firm.error === 'notfound') {
    return gstFail(form, 'notfound', t(
      'That GSTIN is not on the GST database. Check it and send again.',
      'Ye GSTIN GST database mein nahi mila. Check karke dobara bhejiye.',
    ), t);
  }

  // Not configured, or the register is down. NOT the customer's fault, so
  // they do not spend a try on it — but the account still cannot be opened
  // unverified, so it goes to a person immediately.
  if (!firm) return escalate(form, 'unavailable', t);

  // A cancelled registration must not open an account: the order would be
  // billed against a GSTIN the tax portal has already closed. Not a typo,
  // so there is nothing to try again — straight to a person.
  if (!gst.isLive(form.answers._firm = firm)) {
    store.log('create', `${form.chatId}: GSTIN ${gstin} is ${firm.status}, not Active`);
    form.answers.gstStatus = firm.status;
    return escalate(form, `status:${firm.status}`, t);
  }

  // VERIFIED — but is this firm already a customer? A GSTIN the portal
  // already holds will be refused at the create, so it is asked about
  // here, where the customer can still say "oh, use the other one".
  const taken = await refuseIfTaken(form, 'gstNo', firm.gstin || gstin, t);
  if (taken) {
    open.set(form.chatId, form);
    return taken;
  }

  // Everything the register knows is filled in, and only what it cannot
  // know is still asked.
  const a = form.answers;
  delete a._lastGst;
  delete a._firm;
  a.gstNo = firm.gstin || gstin;
  a.gstVerified = true;
  a.name = firm.name;
  a.legalName = firm.legalName;
  a.address = firm.address;
  a.city = firm.city;
  a.state = firm.state;
  a.pin = firm.pin;
  // Characters 3-12 of a GSTIN ARE the PAN. Reading it off a verified
  // GSTIN is not a guess, and it removes a question.
  const pan = a.gstNo.slice(2, 12).toUpperCase();
  if (PAN_RE.test(pan)) a.panNo = pan;
  // The GST register's "constitution" is Proprietorship / Private Limited —
  // a legal form, NOT the retailer/wholesaler/garage/fleet the sales desk
  // means by business type. Kept for the approver to read, never used to
  // answer that question.
  if (firm.businessType) a.constitution = firm.businessType;
  if (firm.taxpayerType) a.taxpayerType = firm.taxpayerType;

  form.fromGst = ['name', 'address', 'city', 'state', 'pin', 'panNo'].filter((k) => a[k]);
  store.log('create', `${form.chatId}: GSTIN ${a.gstNo} verified — filled ${form.fromGst.length} field(s) — ${firm.name}`);

  const step = advance(form, t);
  // Say what was found BEFORE the next question, so a wrong GSTIN is caught
  // by the person who knows, rather than by the approver an hour later.
  const found = t(`Got it — ${gst.describe(firm)}\n\n`, `Mil gaya — ${gst.describe(firm)}\n\n`);
  return step.done ? step : { ...step, reply: found + step.reply };
}

function advance(form, t) {
  form.idx += 1;
  // Skip anything the GSTIN already answered. Asking a customer to type a
  // city we just read off the GST register is how a form gets abandoned.
  while (
    fieldAt(form.idx) &&
    ((form.answers[fieldAt(form.idx).key] !== undefined && fieldAt(form.idx).key !== 'remarks') ||
      (fieldAt(form.idx).when && !fieldAt(form.idx).when(form)))
  ) {
    form.idx += 1;
  }
  const next = fieldAt(form.idx);
  if (next) {
    open.set(form.chatId, form);
    return { reply: t(next.ask[1], next.ask[1]), done: false, form };
  }
  // Every field is in. The commercial terms join it here, from config.
  Object.assign(form.answers, commercialDefaults(), { kind: 'customer' });
  form.answers.requestId = 'WA-' + Date.now().toString(36).toUpperCase();
  open.set(form.chatId, form);
  store.log('create', `${form.chatId}: form complete — ${form.answers.name} (${form.answers.requestId})`);
  return { reply: null, done: true, form };
}

// A GST that would not verify. The approver gets the little that is known
// and the numbers that were tried, and decides whether a person opens this
// account by hand. Nothing has been created.
function reviewSummary(form, t) {
  const a = form.answers;
  const why = {
    shape: 'the number was never a valid GSTIN',
    notfound: 'not on the GST database',
    'no-gst': 'the customer says they have no GST number',
    unavailable: 'the GST service could not be reached',
  }[a.gstProblem] || `registration is ${String(a.gstProblem || '').replace(/^status:/, '')}, not Active`;
  return [
    `*GST not verified* — ${a.requestId}`,
    form.byName ? `Bheja: ${form.byName}` : `Customer: ${a.phone}`,
    '',
    `Problem: ${why}`,
    a.gstTried && a.gstTried.length ? `Tried: ${a.gstTried.join(', ')}` : null,
    a.name ? `Firm (unverified): ${a.name}` : null,
    '',
    t(
      `Reply *OK ${a.requestId}* to let them fill the form without GST, or *NO ${a.requestId}* and we will call them instead.`,
      `*OK ${a.requestId}* bhejiye to bina GST ke form bhar lenge, ya *NO ${a.requestId}* — phir hum call kar lenge.`,
    ),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// An approver said yes to a firm whose GST would not verify. The form
// reopens in the CUSTOMER's chat at the question after the GSTIN, and the
// account carries gstVerified: false so nobody downstream assumes it was.
function resumeWithoutGst(req, t) {
  const form = {
    at: Date.now(),
    chatId: req.chatId,
    phone: req.answers.phone,
    byName: req.byName || null,
    idx: 0,
    gstWaived: true,
    answers: { phone: req.answers.phone, gstVerified: false, gstWaiver: req.answers.requestId },
  };
  form.idx = FIELDS.findIndex((f) => !f.when || f.when(form));
  open.set(req.chatId, form);
  store.log('create', req.chatId + ': GST waived on ' + req.answers.requestId + ' — form reopened');
  return t(FIELDS[form.idx].ask[1], FIELDS[form.idx].ask[1]);
}

// What the approver reads. Every field, in the order of the paper form, so
// it can be checked against one.
function summary(form, t) {
  const a = form.answers;
  if (a.kind === 'gst-review') return reviewSummary(form, t);
  const line = (label, v) => (v === undefined || v === null || v === '' ? null : `${label}: ${v}`);
  return [
    `*New customer* — ${a.requestId}`,
    form.byName ? `Bheja: ${form.byName}` : `Bheja: customer khud (${a.phone})`,
    '',
    line('Firm', a.name),
    line('Business type', a.businessType),
    line('Contact', a.contactPerson),
    line('Mobile', a.phone),
    a.contactPhone && a.contactPhone !== a.phone ? 'Contact phone: ' + a.contactPhone : null,
    line('GSTIN', a.gstNo ? `${a.gstNo}${a.gstVerified ? ' (verified)' : ''}` : null),
    a.gstVerified === false ? `GSTIN: NOT VERIFIED — waived on ${a.gstWaiver}` : null,
    line('Constitution', a.constitution),
    line('PAN', a.panNo),
    line('Email', a.email),
    '',
    line('Address', a.address),
    line('City', a.city),
    line('State', a.state),
    line('PIN', a.pin),
    a.lat ? `Location: ${a.lat}, ${a.lng}` : null,
    '',
    a.bannerText ? 'Board reads: ' + a.bannerText : null,
    a.photoNote ? 'Photo: ' + a.photoNote : null,
    a.locationFrom === 'photo' ? 'Location: read from the photo EXIF' : null,
    form.notChecked && form.notChecked.length
      ? 'NOT checked against the portal: ' + form.notChecked.join(', ')
      : null,
    a.createdByName ? 'Opened by: ' + a.createdByName + (a.openedFor ? ' (for ' + a.openedFor + ')' : '') : null,
    '',
    line('Credit days', a.creditDays),
    line('Credit limit', a.creditLimit),
    line('Remarks', a.remarks),
    '',
    t(
      `Reply *OK ${a.requestId}* to create, or *NO ${a.requestId}* to reject.`,
      `*OK ${a.requestId}* bhejiye banane ke liye, ya *NO ${a.requestId}* reject karne ke liye.`,
    ),
    t(
      'Already has an account? Swipe-reply to this message with "already hai".',
      'Account pehle se hai? Is message pe swipe karke "already hai" likh dijiye.',
    ),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// "OK WA-ABC123" / "NO WA-ABC123" from an approver.
function readDecision(text) {
  const m = String(text || '').trim().match(/^(ok|yes|haan|approve|no|nahi|reject)\s+(WA-[A-Z0-9]+)$/i);
  if (!m) return null;
  return { yes: /^(ok|yes|haan|approve)$/i.test(m[1]), requestId: m[2].toUpperCase() };
}

function isApprover(phone) {
  return Boolean(config.creation.approvers[store.normPhone(phone)]);
}
function approverName(phone) {
  return config.creation.approvers[store.normPhone(phone)] || store.normPhone(phone);
}

// Forms waiting on a yes, by request id. Kept out of the per-chat slot
// because the approver answers from THEIR chat, not the customer's.
const awaiting = chatState.slot('customerCreate.awaiting');

function park(form) {
  awaiting.set(form.answers.requestId, { at: Date.now(), chatId: form.chatId, answers: form.answers, byName: form.byName });
  open.delete(form.chatId);
}
function parked(requestId) {
  return awaiting.get(String(requestId || '').toUpperCase()) || null;
}
function unpark(requestId) {
  awaiting.delete(String(requestId || '').toUpperCase());
}

// Which of OUR messages carried which request, by WhatsApp id. 22 Sep, live:
// the Sales Head swiped onto the summary and wrote "Ye toh already created
// hai" — no OK, no NO, so it fell through to "koi order pending nahi hai",
// the customer heard nothing and the request sat there. A swipe tells us
// only the id of the message it quotes; this is what turns that back into
// a request.
const summaries = chatState.slot('customerCreate.summaries'); // wamid -> requestId
function noteSummary(wamid, requestId) {
  if (wamid && typeof wamid === 'string') summaries.set(wamid, String(requestId || '').toUpperCase());
}
function requestForMessage(wamid) {
  return (wamid && summaries.get(wamid)) || null;
}
// "WA-MUCA1E42 pehle se hai" — typed rather than swiped.
function requestIdIn(text) {
  const m = String(text || '').match(/\bWA-[A-Z0-9]{4,}\b/i);
  return m ? m[0].toUpperCase() : null;
}
// The approver saying this firm is already on the portal. Anything else
// they write is not a decision, and is never guessed at as one.
function saysAlreadyExists(text) {
  return /already|pehle\s*(se|hi)|pahle\s*(se|hi)|exist|duplicate|bana\s*hua|bani\s*hui|bana\s*(hai|h)\b|ban\s*chuka|khula\s*hua|created|account\s*(hai|h)\b/i.test(
    String(text || ''),
  );
}

module.exports = {
  wantsToStart,
  wantsSomeoneElse,
  declinedCreate,
  agentName,
  start,
  answer,
  pending,
  cancel,
  summary,
  reviewSummary,
  resumeWithoutGst,
  readDecision,
  isApprover,
  approverName,
  park,
  parked,
  unpark,
  noteSummary,
  requestForMessage,
  requestIdIn,
  saysAlreadyExists,
  FIELDS,
  _internals: { GSTIN_RE, PAN_RE, PIN_RE, commercialDefaults, MAX_GST_TRIES },
};
