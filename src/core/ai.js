'use strict';
// Message understanding.
// Deterministic parsers work out of the box; if ANTHROPIC_API_KEY is set,
// Claude is used first (handles Hinglish, free-form sentences, messy lists)
// and the deterministic parser remains the fallback.
const config = require('../config');
const store = require('../store');

// ---------------- deterministic parsers ----------------

// Real customer formats (group screenshots se):
//   "55810m75J30 2 pcs" · "26300_02752 40 pcs" · "Ecstar 0w20 engine oil 3 Box"
//   "16510m68k10.48 pcs" (qty part se chipki hui) · "Brake Pad - 10 - 450"
//   "10 x Brake Pad" · "Brake Pad qty 10 @450"
const UNITS = '(?:pcs?|nos?\\.?|box(?:es)?|sets?|pkts?|packets?|ltrs?|litres?|qty)';
function parseLine(line) {
  const t = line.replace(/[–—]/g, '-').trim();
  if (!t || t.length < 2) return null;

  // qty-first: "10 x Brake Pad", "2 pcs 55810m75J30"
  let m = t.match(new RegExp(`^(\\d+)\\s*(?:x|${UNITS})?\\s+(.+?)(?:\\s*[-@]\\s*(?:rs\\.?\\s*)?(\\d+(?:\\.\\d+)?))?$`, 'i'));
  if (m && m[2] && !/^[\d\s:-]+$/.test(m[2])) {
    return { item: clean(m[2]), qty: parseInt(m[1], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // qty-last with an "x" separator: "Spark Plug x 4", "Plug x4". The x must
  // be its OWN token (whitespace before it) so "Filter Max 4" ki item name
  // se 'x' kabhi nahi katta.
  m = t.match(/^(.+?)\s+[x×]\s*(\d+)\s*(?:[-@]\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?))?$/i);
  if (m && m[1].length >= 3 && !/^[\d\s._-]+$/.test(m[1])) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // "PART.48 pcs" — qty dot se part number mein chipki hai, unit word zaroori
  m = t.match(new RegExp(`^(.+?)\\.\\s*(\\d+)\\s*${UNITS}\\s*$`, 'i'));
  if (m && m[1].length >= 4) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: null };
  }
  m = t.match(new RegExp(`^(.+?)\\s*[-:]\\s*(\\d+)\\s*(?:${UNITS}\\s*)?(?:[-@]\\s*(?:rs\\.?\\s*)?(\\d+(?:\\.\\d+)?))?$`, 'i'));
  if (m) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // unit word PRESENT -> item kuch bhi ho sakta hai (digit-start part numbers samet)
  m = t.match(new RegExp(`^(.+?)\\s+(\\d+)\\s*${UNITS}\\s*(?:[-@]\\s*(?:rs\\.?\\s*)?(\\d+(?:\\.\\d+)?))?$`, 'i'));
  if (m && m[1].length >= 3) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // unit word ABSENT -> item pure digits nahi hona chahiye ("20 250" jaisi lines skip)
  m = t.match(/^(.+?)\s+(\d+)\s*(?:[-@]\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?))?$/i);
  if (m && m[1].length >= 3 && !/^[\d\s._-]+$/.test(m[1])) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  return null;
}
function clean(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^["'*\-\s]+|["'*\-\s]+$/g, '')
    // a trailing unit word belongs to the quantity, not the item name:
    // "41341-M68P00 qty" -> "41341-M68P00"
    .replace(new RegExp(`\\s+${UNITS}$`, 'i'), '')
    .trim();
}

// A token is a PART NUMBER only if it holds BOTH a digit and a letter. That one
// rule is what stops a phone number, a date or a bare quantity being looked up
// as a part. (Same rule ProcureHub's sales desk settled on.)
const PART_TOKEN_RE = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{4,}\b/g;

// ...but a QUANTITY glued to its unit also holds a digit and a letter, and
// customers write them constantly: "10pcs", "2pc", "3pise", "5nos". Without
// this exclusion "10pcs timing seal 16141M68K00" looks like TWO parts, and the
// real one loses its quantity. Seen in the Lagan Motors chat.
const QTY_UNIT_TOKEN = /^\d{1,5}\s*(?:pcs?|pise|peice?s?|pieces?|nos?|set|sets|box|boxes|pkts?|packets?|ltrs?)$/i;

// Words that are never an item, however the line is shaped. Customers ask for
// bills, credit notes and documents in the same chat as orders — "Bill no.
// 2565" must not become an order for 2,565 "Bill".
const NON_ITEM_WORD = /^(bill|bills|invoice|cn|credit|credit note|debit|note|send|bhejo|bhejna|need|chahiye|rc|no|number|total|amount|gst|order|ok|okay|yes|done|pending|payment|balance|rate|price|qty|mrp|batch|unit|incl|taxes|genuine|parts|accessories|item|items)$/i;

// The part number inside a line that also carries a name. Vision reads a
// Maruti label as "11610M55RA1 MOUNTING COMP ENG RH", and that line is a
// part number with a name attached - not a name to search the catalogue by.
function partNumberIn(text) {
  const toks = String(text || "").match(PART_TOKEN_RE) || [];
  const hit = toks.find((t) => isPartToken(t));
  return hit ? stripNoPrefix(hit) : null;
}

// "No" means "number", and Kalra Motor glues it on: "2pise No81830m73rb3".
// The part number underneath is real (81830M73RB3 is on the portal); the
// token with No on the front matches nothing, and the bot went silent.
// Only stripped when what follows still looks like a part number on its own.
function stripNoPrefix(tok) {
  const m = String(tok).match(/^(?:no|number|n)[.-]?([0-9][A-Za-z0-9-]{4,})$/i);
  return m ? m[1] : tok;
}

function isPartToken(tok) {
  return !QTY_UNIT_TOKEN.test(tok);
}

// A photo caption that is ONLY a quantity — the single most common way
// customers order from a picture. Straight from the Kalra Motor chat:
//   "<image> 2pc"   "<image> 3pise"   "<image> 4pise"   "<image> 2p"
//   "Send 4pc"      "2"
// The part is in the picture; the number is in the caption. Returns the
// quantity, or null when the caption says anything more than a quantity.
function bareQty(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 30) return null;
  const stripped = t
    .replace(/^(send|bhejo|bhej\s*do|dena|de\s*do|chahiye|need|want)\s+/i, '')
    // "1 kr do", "2 kardo", "3 hi", "4 chahiye", "5 rakho" - still just a
    // quantity (14 Sep, live: "1 kr do" was looked up as a part called "kr do").
    .replace(/\s+(kr\s*do|kar\s*do|kardo|krdo|karo|kro|kr\s*dijiye|kar\s*dijiye|kr|kar|hi|chahiye|chaiye|bhejo|bhej\s*do|rakho|rakh\s*do|lagao|laga\s*do|lga\s*do)\s*$/i, '')
    .trim();
  const m = stripped.match(/^x?\s*(\d{1,4})\s*(?:pcs?|pise|peices?|pieces?|p|nos?|set|sets|box|pkt)?\.?$/i);
  if (!m) return null;
  const q = parseInt(m[1], 10);
  return q > 0 && q <= 9999 ? q : null;
}

// The quantity on a photo CAPTION. `bareQty` wants the caption to be nothing
// but a quantity, and half of the real ones are not: "2pise ye hi ji",
// "4pise ye hai ji", "2pise returns hai ji". The number still leads, and that
// is what the customer means.
function captionQty(text) {
  const only = bareQty(text);
  if (only !== null) return only;
  const t = String(text || '').trim();
  if (!t || t.length > 60) return null;
  // A leading "<n><unit>" and then anything. The unit is required, so a
  // part number ("83150m79a22") and a sum ("3464-1760=1,704") never match.
  const m = t.match(/^(\d{1,4})\s*(?:pcs?|pise|peices?|pieces?|nos?|set|sets|box|pkt|p)\b/i);
  if (!m) return null;
  const q = parseInt(m[1], 10);
  return q > 0 && q <= 9999 ? q : null;
}

// Scan part numbers OUT of free text instead of reading line by line, so
// several can share one line and conversational wrapping is ignored:
//   "41341M68P00 x 2 aur 75700TF0901 3"
//   "is 41341M68P00 available? 75700TF0901 x 10"
// The quantity is whatever number follows the token before the NEXT token;
// absent one, it defaults to 1.
function scanPartTokens(text) {
  const s = String(text || '');
  const toks = [...s.matchAll(PART_TOKEN_RE)].filter((t) => isPartToken(t[0]));
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i][0];
    const start = toks[i].index;
    const after = s.slice(start + tok.length, i + 1 < toks.length ? toks[i + 1].index : s.length);

    // quantity AFTER the part: "16141M68K00 x 10", "82500M75L00 2"
    let m = after.match(new RegExp(`^\\s*(?:x|×|@|-)?\\s*(?:${UNITS})?\\s*(\\d{1,5})\\b`, 'i'));
    let qty = m ? parseInt(m[1], 10) : null;

    // quantity BEFORE the part, the way customers actually write it:
    //   "10pcs timing seal 16141M68K00"
    //   "10pcs dicky latch dzire 82500M75L00"
    // Only look back as far as the previous part token, so one part's
    // quantity can never be stolen by the next.
    if (qty === null) {
      const from = i === 0 ? 0 : toks[i - 1].index + toks[i - 1][0].length;
      const before = s.slice(from, start);
      const b = before.match(new RegExp(`(\\d{1,5})\\s*(?:${UNITS})?\\s*[^\\d]*$`, 'i'));
      if (b) qty = parseInt(b[1], 10);
    }

    // A quantity we invented is not a quantity the customer gave us. Marked,
    // so the bot can ask instead of quietly ordering one of everything.
    const qtyMissing = qty === null;
    if (qty === null) qty = 1;
    if (qty > 0 && qty <= 99999) out.push({ item: stripNoPrefix(tok), qty, price: null, qtyMissing });
  }
  return out;
}

// How many part-number tokens sit on the busiest single line?
function maxTokensPerLine(text) {
  let max = 0;
  for (const line of String(text || '').split(/\n/)) {
    // the quantity-with-unit exclusion matters here too, otherwise
    // "10pcs timing seal 16141M68K00" counts as two parts
    const n = (line.match(PART_TOKEN_RE) || []).filter(isPartToken).length;
    if (n > max) max = n;
  }
  return max;
}

function isJunkItem(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  // A digits-only part number (2630002752) has no letters, and was thrown
  // away here as "no words" - the line vanished from a list (13 Sep).
  if (/^\d{7,13}$/.test(n)) return false;
  // "Bill no." -> "bill no" -> first word is a non-item word
  const words = n.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => NON_ITEM_WORD.test(w));
}

// Dealers send lists, one part per line, and half the lines carry no
// quantity at all:
//
//   Oil filter
//   Air filter
//   Spark plug 4pcs
//
// The line parser needs "item qty" on every line, so it kept ONLY the spark
// plug and threw the other four away — the customer asked about five parts and
// heard about one. A message is a LIST when it has two or more short lines and
// none of them is a sentence or a question; chit-chat ("YE VOLVO CAR HAI") is
// one line and never qualifies.
function looksLikeList(text) {
  const lines = String(text || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => bareQty(l) === null); // "2pc" on its own line is a quantity
  if (lines.length < 2) return false;
  if (!lines.every((l) => l.split(/\s+/).length <= 8 && !l.endsWith('?'))) return false;
  // The lines have to be the SAME KIND of thing. A printed label is also
  // several short lines — but there the part number is on line 1 and the rest
  // describe it ("F.FLOOR HUB ASSY,FRONT WHEEL", "QTY 1", "MRP 3380.00"), and
  // reading those as four separate parts is nonsense. So: either every line
  // carries a part number, or none does.
  const withToken = lines.filter((l) => (l.match(PART_TOKEN_RE) || []).some(isPartToken)).length;
  return withToken === 0 || withToken === lines.length;
}

function parseLinesBlock(rawText) {
  // Applied here rather than only in the OCR path: customers copy the spaced
  // form straight off the label into a typed message too.
  const text = joinSpacedPartNumbers(rawText);
  // Scan tokens when a line holds two or more part numbers (the line parser
  // would glue them into one nonsense item), or when a quantity is written
  // BEFORE the part ("10pcs timing seal 16141M68K00") — the line parser reads
  // that backwards.
  const leadingQty = /^\s*\d{1,5}\s*(?:pcs?|pise|peices?|pieces?|nos?|set|box|pkt)\b/i.test(String(text || ''));
  if (maxTokensPerLine(text) >= 2 || (leadingQty && maxTokensPerLine(text) >= 1)) {
    const scanned = scanPartTokens(text);
    if (scanned.length) return scanned;
  }
  const out = [];
  const asList = looksLikeList(text);
  let trailingQty = null;
  for (const line of String(text || '').split(/\n/)) {
    const raw = line.trim();
    if (!raw) continue;

    // A line that is nothing but a quantity — "2pc" under the part number,
    // exactly how it arrives from a phone. It belongs to the part above it.
    const only = bareQty(raw);
    if (only !== null) {
      trailingQty = only;
      continue;
    }

    // A digits-only part number with its quantity ("2630002752 4 pcs"). The
    // line parser reads a leading number as the QUANTITY and "4 pcs" as the
    // item, then drops it for the absurd quantity - so in a list next to a
    // Maruti number the Hyundai line vanished (13 Sep).
    if (/^\d{7,13}\s/.test(raw)) {
      const pq = partAndQty(raw);
      if (pq) {
        out.push(pq);
        continue;
      }
    }

    const p = parseLine(line);
    // qty cap: a "quantity" like 7703083335 is really a part number
    if (p && p.qty > 0 && p.qty <= 99999 && p.item && !isJunkItem(p.item)) {
      out.push(p);
      continue;
    }
    // In a list, a line with no quantity is still a part the customer asked
    // about. The quantity is missing, not the item.
    if (asList) {
      const name = clean(raw);
      if (name.length >= 3 && !isJunkItem(name)) out.push({ item: name, qty: 1, price: null, qtyMissing: true });
    }
  }
  // "57300M55R03" and then "2pc" on the next line: one quantity, one part
  // waiting for it. Applied to whichever path produced the lines — a single
  // part with its quantity underneath never reaches the loop above.
  const withTrailing = (lines) => {
    if (trailingQty !== null) {
      const waiting = lines.filter((l) => l.qtyMissing);
      if (waiting.length === 1) {
        waiting[0].qty = trailingQty;
        delete waiting[0].qtyMissing;
      }
    }
    return lines;
  };

  if (out.length) return withTrailing(out);

  // Nothing had a quantity attached — but a part number on its own IS an
  // order. This is the commonest photo of all: the customer snaps the Maruti
  // label ("43401M68R00 / HUB ASSY,FRONT WHEEL") and puts the quantity in the
  // caption. Requiring "item qty" on one line threw the whole label away and
  // answered "photo se order padh nahi paya".
  return withTrailing(scanPartTokens(text).filter((l) => !isJunkItem(l.item)));
}

// Every way a dealer says yes on WhatsApp. "hn", "ji", "kar do", "bhej do"
// were all missing, and a customer agreeing was answered with silence.
const CONFIRM_RE =
  /^(yes+|yup|yeah|confirm(ed)?|ok(ay)?( ji)?|done|haan+|han+|hn+|ha|ji( haan| han)?|thik( hai)?|theek( hai)?|sahi( hai)?|pakka|final|bilkul|confirm (karo|kar ?do)|kar ?do|bhej ?do|bhej ?dijiye|order (laga ?do|lga ?do|kar ?do|bana ?do|daal ?do|punch kar ?do|place kar ?do)|laga ?do|lga ?do|punch kar ?do|book it|place (the )?order|de ?do( ji)?|dedo( ji)?|de ?dijiye|bhejo( ji)?|send it|send kar ?do)\b/i;
// A HARD cancel: the customer used the word.
// Also "poora kr do cancel", "sab cancel", "poora order cancel kar do" - the
// word WHOLE is said, so there is nothing to ask. 13 Sep, live: "Poora kr do
// cancel" got "Thoda aur detail bata dijiye?".
const CANCEL_RE =
  /^(cancel|cancel (the )?order|order cancel|stop)\b|^(?:poora|pura|puraa|sab|saara|sara|whole|full|entire)\s+(?:order\s+)?(?:(?:kr|kar)\s+(?:do|dijiye)\s+)?cancel\b/i;
// A SOFT one. "rehne do", "abhi rehne do", "nahi chahiye" mean "leave it" —
// which might be one item, the whole order, or just this conversation. Binning
// a two-item cart on that, with no confirmation, is how an order vanishes.
const SOFT_CANCEL_RE =
  /^(abhi |ye |yeh |wo |woh )?(rehne do|rhne do|rahne do|chhod do|chod do|mat karo|nahi chahiye|nhi chahiye|no)\b/i;
// Hindi puts the verb LAST: "55810M75J30 hata do", "ye wala nikal do". The
// verb-first pattern missed every one of those, and the customer was told a
// part was not in an order it was sitting in.
const REMOVE_TAIL_RE =
  /^(.+?)\s+(hata ?do|hatao|hata dijiye|hta ?do|nikal ?do|nikaal ?do|remove|delete)\s*$/i;
// Asking for a price, in every shape it arrives. Rates never go over
// WhatsApp, so "which part do you need?" is a misleading answer to one.
// "13780M68P01 ka rate", "oil filter ki MRP", "16510M65L10 rate": the rate
// word comes after ka/ki/ke, or LAST with nothing after it. Neither form
// above caught those, so the part number made the message an ORDER and a
// customer asking a price was asked "How many do you need?".
const RATE_RE =
  /^(what('?s| is)? (the )?)?(rate|rates|price|prices|cost|mrp|kimat|keemat|daam|discount)\b|\b(rate|price|mrp|cost|daam|kimat)\s*(kya|kitna|kitni|batao|bataiye|batana|btao|bta|bata do|bta do|bhejo|bhej do|send|share|do)\b|\b(ka|ki|ke)\s+(rate|rates|price|prices|mrp|daam|kimat|keemat)\b|\b(rate|rates|price|prices|mrp|daam|kimat|keemat)\s*[?.!]*\s*$/i;
// "kitne ka hai" is the commonest way of asking a price in this trade, and
// it names no part, so nothing else catches it.
const PRICE_ASK_RE = /\b(kitne? k[aiy]|kitni k[iy]|kitne? me|how much)\b/i;
// "Total kitna hoga" names no rate word, so neither of the two above caught
// it — 21 Sep it fell all the way through to the chat layer, which is
// forbidden from quoting money and answered "total hamari sales team
// batayegi sir". The customer had a priced cart sitting right there, and
// "Price" one message later worked perfectly. Deliberately narrow: "total"
// only counts next to a question or an amount word, so "total 5 pcs
// chahiye" is still a quantity and not a price question.
const TOTAL_ASK_RE =
  /\btotal\s*(kitna|kitne|kitni|kya|amount|price|rate|hoga|hogi|batao|bataiye|btao|bta)\b|\b(kitna|kitne|kitni|kya)\s+total\b|\btotal\s+amount\b/i;
const STATUS_RE = /\b(status|track(ing)?|kitna\s*(time|din|days?)|how\s*long|kaha+n?\s*(hai|tak|pahuncha|pahunchi|pohcha)|where('?s| is)?\s*(my|the)?\s*(order|delivery|goods|maal|gadi)|order (kahan|kidhar|kab)|gadi (kahan|kidhar)|deliver(y|ed)?\s*(kab|when)|kab (tak )?(aayega|milega|pahunchega))\b/i;
const REMOVE_RE = /^(remove|delete|hata(o| do)?)\s+(.+)$/i;

// "Thik hai.. mt kro", "ok rehne do", "haan mat karo": the first word agrees,
// the rest says no. CONFIRM_RE only looks at how a message STARTS, and on 13
// Sep, live, "Thik hai.. mt kro" came back as a yes. Checked before any yes:
//   a wait ("ok wait", "thik hai ruko")   -> other: neither yes nor cancel
//   a no   ("mt kro", "rehne do", "nahi") -> maybe_cancel: the bot asks
// Short messages with no part number only - "16510M65L10 nahi chahiye" is
// about one part, and the hard "cancel" keeps its own path.
const HOLD_RE = /\b(wait|ruko|ruk\s*jao|ruk\s*ja|ek\s*min(ute)?|thodi\s*der|baad\s*(mein|me)|later|abhi\s*(nahi|nhi))\b/i;
// Words that only ever mean "don't": wherever they sit, the message is a no.
const NO_RE = /\b(mat|mt|rehne\s*do|rhne\s*do|rahne\s*do|chhod\s*do|chod\s*do|don'?t|do\s*not|no\s*need)\b/i;
// A bare "nahi" is not enough: "Ye vala hai ki nhi", "Avl nhi hai sir" and
// "Available hai ki nhi ye batao" all carry one and are about stock. It counts
// only after a yes-word ("ok nahi chahiye") or as the whole message
// ("nahi chahiye", "nahi karna").
const NAHI_RE = /\b(nahi|nahin|nhi|nai)\b/i;
const ONLY_NAHI_RE = /^(nahi|nahin|nhi|nai)(\s+(chahiye|chaiye|karna|krna|bhejna|lagana|lgana|order))?(\s+(ji|sir|bhai|bhaiya))?[\s.!]*$/i;
const ABOUT_STOCK_RE = /\b(avl|aval|available|availability|stock|milega|milegi|mila|aaya|hai\s*ki|h\s*ki|ya\s*(nahi|nhi))\b/i;
const NOT_A_NO_RE = /\bkoi\s*(baat|dikkat|problem|tension)\s*(nahi|nhi|nai)\b/i;

function yesThatIsNot(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 40 || CANCEL_RE.test(s) || NOT_A_NO_RE.test(s)) return null;
  if ((s.match(PART_TOKEN_RE) || []).some(isPartToken)) return null;
  if (HOLD_RE.test(s)) return 'other';
  if (NO_RE.test(s)) return 'maybe_cancel';
  if (NAHI_RE.test(s) && !ABOUT_STOCK_RE.test(s) && (CONFIRM_RE.test(s) || ONLY_NAHI_RE.test(s))) return 'maybe_cancel';
  return null;
}
const SET_QTY_RE = /^(?:make|set|change)?\s*(.+?)\s+(?:to|=|ko)\s*(\d+)$/i;

// intent for a customer message given the known catalog item names
function parseCustomerMessageBasic(text, catalogNames) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'other' };
  // "pakka?" is a QUESTION, not a confirmation — and it used to place the
  // order. A question mark turns every one of these words back into a query:
  // "ok?", "done?", "confirm?", "final?". Nobody confirms an order with a
  // question mark on the end.
  const asking = /\?\s*$/.test(t);
  const notYes = yesThatIsNot(t);
  if (notYes) return { intent: notYes };
  if (!asking && CONFIRM_RE.test(t)) return { intent: 'confirm' };
  if (!asking && CANCEL_RE.test(t)) return { intent: 'cancel' };
  if (!asking && SOFT_CANCEL_RE.test(t)) return { intent: 'maybe_cancel' };
  if (STATUS_RE.test(t)) return { intent: 'status' };

  let m = t.match(REMOVE_RE);
  if (m) return { intent: 'remove', item: clean(m[3]) };
  // "Brake Pad to 8" -- a quantity change. Do NOT gate this on a catalog:
  // the catalog is the Dealer Portal now and is not available here. The bot
  // falls back to treating it as a new order line if the draft has no such
  // item (see customerBot's set_qty case).
  m = t.match(SET_QTY_RE);
  if (m && m[1].trim().length >= 3 && !/^[\d\s._-]+$/.test(m[1])) {
    return { intent: 'set_qty', item: clean(m[1]), qty: parseInt(m[2], 10) };
  }

  // An item name has to survive `clean()` to be worth anything. "Bhejo 5pc"
  // and "Add 2pc if available" left it empty, and an empty part number reached
  // the portal as HTTP 422 and the customer as a line reading " x15 - checking".
  const lines = parseLinesBlock(t).filter((l) => l.item && l.item.trim().length >= 2);
  if (lines.length) return { intent: 'order', lines };

  // part-number inquiry: "17521M68PA0 avl?", "7703083335 available?", "Part
  // No ARVM001623 LR h" — the bot ALWAYS answers (found or "not available").
  // Mixed letter+digit tokens are always parts; pure-digit tokens count as
  // parts only alongside inquiry words (so phone numbers in chit-chat don't).
  const mixedTokens = t.match(/\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g) || [];
  const inquiryish = /price|rate|stock|avl|available|availability|kitna|hai kya|milega|need|want|chahiye|required?|requirement|lena hai|part\s*no/i.test(t);
  const digitTokens = inquiryish ? t.match(/\b\d{6,15}\b/g) || [] : [];
  const partTokens = [...mixedTokens, ...digitTokens]
    .map((x) => x.replace(/-(avl|aval|avail|qty|pcs?|nos?)$/i, '')) // "17521M68PA0-avl" -> part only
    .filter((x) => x.length >= 6 && !/^(whatsapp|cartrends)/i.test(x));
  if (partTokens.length) return { intent: 'inquiry', items: [...new Set(partTokens)] };

  // inquiry: mentions availability/price/need + a catalog item
  // ("Hello I need some brake pad" — no qty yet, so ask/quote first)
  if (/price|rate|stock|available|availability|kitna|hai kya|milega|need|want|chahiye|required?|requirement|lena hai/i.test(t)) {
    const hits = catalogNames.filter((n) => t.toLowerCase().includes(n.toLowerCase()));
    if (hits.length) return { intent: 'inquiry', items: hits };

    // Strip the question words AND the Hinglish filler around them. What is
    // left is either a product name worth looking up ("brake pad") or
    // nothing at all — and "nothing at all" must NEVER be sent to the portal
    // as a part. "Available hai ki nhi ye batao" once became a lookup for
    // "nhi ye batao", which is how the bot ended up talking nonsense.
    const leftover = t
      .replace(/\bpart\s*(no|number)\b/gi, ' ')
      .replace(
        /\b(price|rate|stock|available|availability|avl|aval|kitna|kitne|kya|hai|hain|ho|ka|ki|ke|ko|what|is|the|of|for|mein|me|milega|milta|aur|and|do|please|pls|bhai|sir|ji|need|want|chahiye|required|requirement|lena|nhi|nahi|na|ye|yeh|wo|woh|batao|bata|bataiye|mujhe|hume|aap|aapke|main|hum|to|toh|bhi|abhi|thoda|zara|jara|check|karo|kar|dijiye|dena)\b/gi,
        ' '
      )
      .replace(/[?.!,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Nothing but filler, and no part number anywhere -> plain conversation.
    if (leftover.length < 3 && !(t.match(PART_TOKEN_RE) || []).some(isPartToken)) {
      return { intent: 'inquiry', items: [], noPart: true };
    }
    if (leftover.length >= 3) return { intent: 'inquiry', items: [leftover] };
    // No local catalog match -- strip the question words and let the Dealer
    // Portal decide. The portal IS the catalog; asking a human comes only
    // after the portal says it does not know the part.
    const phrase = t
      .replace(/\bpart\s*(no|number)\b/gi, ' ')
      .replace(
        /\b(price|rate|stock|available|availability|avl|aval|kitna|kya|hai|ka|ki|ke|what|is|the|of|for|mein|me|milega|aur|and|do|please|bhai|sir|need|want|chahiye|required|requirement|lena)\b/gi,
        ' '
      )
      .replace(/[?.!,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { intent: 'inquiry', items: phrase.length >= 3 ? [phrase] : [] };
  }
  // single free-form order like "need 5 brake pads"
  const one = t.match(/(?:need|want|chahiye|send|bhejo|order)\s+(\d+)\s+(.+)/i);
  if (one) return { intent: 'order', lines: [{ item: clean(one[2]), qty: parseInt(one[1], 10), price: null }] };
  return { intent: 'other' };
}

function matchCatalog(name, catalogNames) {
  const n = String(name || '').toLowerCase().trim();
  return catalogNames.find((c) => c.toLowerCase() === n || c.toLowerCase().includes(n) || n.includes(c.toLowerCase())) || null;
}

// Does the customer's own message actually support this item, or did it only
// come from the catalog list handed to the model as a naming aid? A real
// match either sits in the text verbatim, or shares one real word (3+
// letters) with it — enough for "brake pad" to survive matching catalog entry
// "Brake Pad Front", but not enough for a catalog name with zero overlap.
function textGrounded(item, text) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hay = norm(text);
  const needle = norm(item);
  if (!hay || !needle) return false;
  if (hay.includes(needle)) return true;
  return needle.split(' ').some((w) => w.length >= 3 && hay.includes(w));
}

// ---------------- Claude-backed parsing ----------------

// Tests put a stand-in here, so the suite can reproduce what the live model
// actually did (13 Sep: "16510m65l10 -5" came back as an inquiry) without a
// network call.
let claudeStub = null;

// Gemini, asked the same question and answering in the same shape, so every
// caller of claude() below works unchanged when Anthropic is not there.
//
// 21 Sep: the Anthropic key was revoked and this bot lost its voice — not
// just photos. smallTalk, the free-text parser and the naming model all go
// through claude(), so one dead credential turned every conversational reply
// into "Samajh nahi paya sir". Routing the fallback HERE rather than at each
// call site means there is one place that knows about providers.
//
// `user` is Claude's own shape: a plain string, or content blocks where an
// image is { type:'image', source:{ media_type, data } }. Both are mapped.
async function geminiJson(system, user) {
  const g = config.gemini;
  if (!g.apiKey) throw new Error('no Gemini key');
  const blocks = Array.isArray(user) ? user : [{ type: 'text', text: String(user == null ? '' : user) }];
  const parts = blocks
    .map((b) => {
      if (b && b.type === 'image' && b.source && b.source.data) {
        return { inline_data: { mime_type: b.source.media_type || 'image/jpeg', data: b.source.data } };
      }
      const text = b && typeof b === 'object' ? b.text : b;
      return text ? { text: String(text) } : null;
    })
    .filter(Boolean);

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(g.visionModel) +
    ':generateContent';
  // 500-class is the model being busy — worth one more ask. 429 is not: it is
  // either "slow down" or a spent quota, and neither is fixed by hammering.
  const RETRY_ON = new Set([500, 502, 503, 504]);
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
    res = await fetch(url + '?key=' + encodeURIComponent(g.apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: String(system) }] } : undefined,
        contents: [{ parts }],
      }),
      signal: AbortSignal.timeout(g.timeoutMs),
    });
    if (res.ok || !RETRY_ON.has(res.status)) break;
  }
  if (!res.ok) throw new Error('Gemini API HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const data = await res.json();
  const text = (((data.candidates || [])[0] || {}).content?.parts || []).map((p) => p.text || '').join('');
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('no JSON in the Gemini reply');
  return JSON.parse(json[0]);
}

// Is there any model at all behind this bot? Callers used to ask
// `config.ai.apiKey`, which is now only half the answer.
function modelAvailable() {
  return Boolean(config.ai.apiKey || (config.gemini && config.gemini.apiKey));
}

// user may be a plain string or a content-block array (for images)
async function claude(system, user) {
  if (claudeStub) return claudeStub(system, user);
  // No Anthropic key configured at all — Gemini is the model, not a fallback.
  if (!config.ai.apiKey) return geminiJson(system, user);
  try {
    return await anthropic(system, user);
  } catch (e) {
    // A revoked key, a rate limit, an outage: whatever it is, the customer is
    // still waiting. Try the other provider before giving up on them.
    if (!config.gemini || !config.gemini.apiKey) throw e;
    store.log('ai', 'Anthropic failed (' + String((e && e.message) || e).slice(0, 60) + ') — asking Gemini');
    return geminiJson(system, user);
  }
}

async function anthropic(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.ai.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic API HTTP ' + res.status);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in AI reply');
  return JSON.parse(jsonMatch[0]);
}

// The same call with Anthropic's server-side web search, for facts the model
// should look up rather than remember: which car 3V5845049RNVB fits, its HSN.
// The searching happens on Anthropic's side inside this one request. A long
// search can stop with `pause_turn`; sending the reply back continues it.
async function claudeWeb(system, user, { maxSearches = 5 } = {}) {
  const messages = [{ role: 'user', content: user }];
  for (let round = 0; round < 3; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.ai.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: 8000,
        system,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }],
        messages,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error('Anthropic API HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    const text = (data.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in AI reply');
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error('web research did not finish');
}

// A space before the quantity is required. Without it "43430-0K021" would
// read as part 43430-0K02 x1, and a Maruti number ending in digits as a qty.
const PART_AND_QTY_RE =
  /^([A-Za-z0-9][A-Za-z0-9-]{4,})\s+(?:[-x×*:=]\s*)?(\d{1,3})\s*(?:pcs?|pise|peices?|pieces?|p|nos?|set|sets|box|pkts?)?\.?$/i;

// How orders really get typed (founder, 14 Sep, a salesman's list): "26300_02752
// 40 pcs" - an underscore where the label has a hyphen - and "16510m68k10.48 pcs"
// - a full stop between the part and its quantity. Straightened out before any
// reading: the underscore becomes a hyphen (the hyphen repairs already know that
// shape), and the full stop after a part number becomes a space. Only after a
// real part-number shape, so "₹52.8", "Bill no 2565" and "1100.10" are untouched.
function normalizeOrderText(text) {
  return String(text == null ? '' : text)
    // Digits on both sides is a Hyundai/Toyota number printed in two groups:
    // joined ("26300_02752" -> 2630002752). Letters in it: a hyphen.
    .replace(/\b(\d{3,})_(\d{2,})\b/g, '$1$2')
    .replace(/\b([A-Za-z0-9]{3,})_([A-Za-z0-9]{2,})\b/g, '$1-$2')
    .replace(/\b((?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}|\d{7,13})\.(\d{1,4})(?=\s*(?:pcs?|pieces?|nos?|pise|p|qty|sets?|box|pkt)\b|\s*$)/gim, '$1 $2');
}

function partAndQty(text) {
  const m = String(text || '').trim().match(PART_AND_QTY_RE);
  if (!m) return null;
  let tok = stripNoPrefix(m[1]).replace(/-+$/, '');
  // Digits only is a part number too - Hyundai 2630002752, Toyota 9091510003
  // (founder, 13 Sep). With a quantity next to it the line is shaped like an
  // order; the portal says whether the number is real. Written in groups
  // ("26300-02752") it is the same number: the hyphen goes.
  if (/^\d+(?:-\d+)+$/.test(tok) && /^\d{7,13}$/.test(tok.replace(/-/g, ''))) tok = tok.replace(/-/g, '');
  const digitsOnly = /^\d{7,13}$/.test(tok);
  if (!digitsOnly && (!/[A-Za-z]/.test(tok) || !/\d/.test(tok) || !isPartToken(tok))) return null;
  if (require('./partish').isVehicle(tok)) return null;
  const qty = parseInt(m[2], 10);
  return qty > 0 ? { item: tok, qty, price: null } : null;
}

async function parseCustomerMessage(text, catalogNames) {
  // Decided HERE, before any model call. These patterns are anchored and
  // specific, and the model gets them wrong in ways that cost real money:
  // "order laga do" reached a person as a support ticket because it came back
  // "other", and "abhi rehne do" binned a two-item cart because it came back
  // "cancel". Trusting the exact words costs nothing and removes both.
  const t0 = String(text || '').trim();
  const asking0 = /\?\s*$/.test(t0);
  const notYes0 = yesThatIsNot(t0);
  if (notYes0) return { intent: notYes0 };
  if (!asking0 && CONFIRM_RE.test(t0)) return { intent: 'confirm' };
  if (!asking0 && CANCEL_RE.test(t0)) return { intent: 'cancel' };
  if (!asking0 && SOFT_CANCEL_RE.test(t0)) return { intent: 'maybe_cancel' };
  const rmTail = t0.match(REMOVE_TAIL_RE);
  if (rmTail && clean(rmTail[1]).length >= 3) return { intent: 'remove', item: clean(rmTail[1]) };
  if (RATE_RE.test(t0) || PRICE_ASK_RE.test(t0) || TOTAL_ASK_RE.test(t0)) return { intent: 'rate' };
  // One part number and how many, and nothing else: "16510m65l10 -5",
  // "16510M65L10 - 5", "16510M65L10 x5", "16510m65l10 -5pcs". 13 Sep, live:
  // the model read the first as an inquiry, and the customer was asked for a
  // quantity they had just given. The shape is exact, so it is decided here.
  const pq = partAndQty(t0);
  if (pq) return { intent: 'order', lines: [pq] };

  if (modelAvailable()) {
    try {
      const r = await claude(
        'You parse WhatsApp messages from auto-parts customers (English/Hindi/Hinglish). ' +
          'Reply ONLY with JSON: {"intent":"order|inquiry|confirm|cancel|remove|set_qty|status|other",' +
          '"lines":[{"item":str,"qty":int}],"items":[str],"item":str,"qty":int}. ' +
          'Use "confirm" only for a clear final yes. Known catalog items: ' +
          catalogNames.slice(0, 200).join(', '),
        text
      );
      if (r && r.intent) {
        // Claude answers "Bhejo 5pc" with {item:"", qty:5} — it correctly sees
        // a quantity and honestly reports no item. That empty string must not
        // reach the portal, which rejects the whole batch with a 422, nor the
        // customer, who was shown a line reading " x5 - checking".
        if (Array.isArray(r.lines)) r.lines = r.lines.filter((l) => l && String(l.item || '').trim().length >= 2);
        if (Array.isArray(r.items)) r.items = r.items.filter((i) => String(i || '').trim().length >= 2);
        // "Known catalog items" in the prompt is there so Claude can match a
        // name the customer typed to its real spelling — never a menu to pick
        // from. A vague quantity with no named item ("I need one piece of each
        // item", 13 Sep live) made it invent lines from that list, and the cart
        // silently gained three parts nobody asked for, doubling every time the
        // customer repeated the phrase (addLines adds typed lines, it does not
        // replace them). A line the customer's own words do not support in any
        // way is dropped rather than trusted.
        if (Array.isArray(r.lines)) r.lines = r.lines.filter((l) => textGrounded(l.item, text));
        if (r.intent === 'order' && !r.lines.length) return { intent: 'other' };
        // The same guard the basic parser applies. A model reads "pakka?" as
        // agreement because the WORD agrees; the question mark is the whole
        // point, and taking it as a final yes places an order the customer was
        // only asking about.
        if (/\?\s*$/.test(String(text || '').trim()) && (r.intent === 'confirm' || r.intent === 'cancel')) {
          return { intent: 'other' };
        }
        return r;
      }
    } catch (e) {
      store.log('ai', 'Claude parse failed, using basic parser: ' + e.message);
    }
  }
  return parseCustomerMessageBasic(text, catalogNames);
}

async function parseVendorStock(text) {
  const basic = parseLinesBlock(text);
  if (basic.length) return basic;
  if (modelAvailable()) {
    try {
      const r = await claude(
        'You parse WhatsApp stock lists from auto-parts vendors (any format/language). ' +
          'Reply ONLY with JSON: {"lines":[{"item":str,"qty":int,"price":number|null}]}. ' +
          'If the message is not a stock list, reply {"lines":[]}.',
        text
      );
      if (r && Array.isArray(r.lines)) return r.lines.filter((l) => l.item && l.qty > 0);
    } catch (e) {
      store.log('ai', 'Claude stock parse failed: ' + e.message);
    }
  }
  return [];
}

// ---------------- photo orders (OCR chain) ----------------
// "Customer photograph mein order bheje" — read it with, in order:
//   1. Python OCR libraries  (scripts/ocr/read_order.py: pytesseract/easyocr)
//   2. Windows built-in OCR  (scripts/ocr/windows_ocr.ps1 — zero install)
//   3. Claude vision         (only if ANTHROPIC_API_KEY is set)
// OCR text is parsed with the deterministic line parser; if that finds
// nothing and an AI key exists, Claude cleans up the raw OCR text.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OCR_DIR = path.join(__dirname, '..', '..', 'scripts', 'ocr');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 60000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

async function ocrImageToText(base64, mediaType) {
  const ext = (mediaType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  const tmp = path.join(os.tmpdir(), 'autoflow-ocr-' + Date.now() + '.' + ext);
  fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
  // Both backends failing looks identical to "OCR is not installed", and the
  // customer is told the feature is off when in fact it ran and saw nothing.
  // Log which one was tried and what came back, so a photo that fails on this
  // machine can be told apart from one that is genuinely unreadable.
  const bytes = Buffer.from(base64, 'base64').length;
  try {
    let text = await run('python', [path.join(OCR_DIR, 'read_order.py'), tmp]);
    if (text && text.trim()) {
      store.log('ai', `OCR via python: ${text.trim().length} chars from ${bytes} byte ${ext}`);
      return text;
    }
    if (process.platform === 'win32') {
      text = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(OCR_DIR, 'windows_ocr.ps1'), '-Path', tmp]);
      if (text && text.trim()) {
        store.log('ai', `OCR via windows: ${text.trim().length} chars from ${bytes} byte ${ext}`);
        return text;
      }
    }
    store.log('ai', `OCR found NO text in a ${bytes} byte ${ext} image (both backends ran)`);
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Customers photograph their WHATSAPP SCREEN, so the OCR text carries the
// chat furniture with it — and a timestamp is just digits to a parser.
// "3pcs clutch bearing 23820M72R40 11:59 am" was read as quantity ELEVEN for
// every single line of a 27-item order. Scrub the chrome before parsing.
// Maruti Genuine Parts labels print the part number SPACED: "43401 M 68R00",
// "17522 M 92TA0". Tokenised as-is, the leading block becomes a quantity and
// the tail becomes the item — an order for 43,401 hub assemblies of "M 68R00".
// Every "M68K00" / "OOM81" fragment in the early photo tests came from here.
// The shape is fixed (5 digits, a letter, 5 more) so gluing it is safe.
function joinSpacedPartNumbers(text) {
  return String(text || '').replace(
    /\b(\d{5})\s*([A-Za-z])\s*([A-Za-z0-9]{5})\b/g,
    (_, a, b, c) => a + b + c
  );
}

function scrubOcrNoise(text) {
  return joinSpacedPartNumbers(String(text || ''))
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ') // 11:59 am · 5:31 pm
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ') // 31/8/26
    .replace(/\b(yesterday|today|forwarded|omitted|image|document|voice message)\b/gi, ' ')
    .replace(/[✓✔]{1,2}/g, ' ') // delivery ticks
    .replace(/[ \t]+/g, ' ');
}

// Sanity filter for photo-derived lines: an invoice/bill photo must never
// become an order ("Invoice - 2939" parsing as item "Invoice" x 2939).
const NON_ITEM_RE = /^(invoice|bill|total|subtotal|amount|gst|sgst|cgst|igst|hsn|challan|date|no|number|qty|quantity|rate|price|order|item|sr|s\.?no)\b/i;
function sanitizeOrderLines(lines, rawText) {
  // if the text looks like a tax invoice, refuse the whole thing
  if (rawText && /(gst\s*invoice|tax\s*invoice|invoice\s*(no|number|#|-)\s*\d+|hsn|igst|cgst|sgst)/i.test(rawText)) return [];
  return (lines || [])
    // Maruti prints the part number SPACED on the box: "33400 M 68K31". The
    // OCR path already joined it; Claude vision reads it off the label the
    // same way and its lines went through untouched, so "33400 M 68K31 COIL
    // ASSY,IGNITION" reached the portal as a NAME and the customer was asked
    // "Which vehicle?" about a part number sitting in the photo.
    .map((l) => (l && l.item ? { ...l, item: joinSpacedPartNumbers(l.item) } : l))
    // A photo of a box label carries a part number and no quantity at all.
    // Dropping those lines threw the part away; the quantity is the thing
    // that is missing, and the bot asks for it.
    .map((l) => (Number(l.qty) > 0 ? l : { ...l, qty: 1, qtyMissing: true }))
    .filter(
      (l) => l.item && l.item.length >= 3 && !NON_ITEM_RE.test(l.item.trim()) && l.qty > 0 && l.qty <= 500
    );
}

// Returns: lines[] on success, [] if nothing readable, null only when no
// OCR backend produced text AND no AI key exists (caller apologises politely).
// Why the last photo gave no order lines. The console prints it next to
// the picture, so "why did it not read my photo?" has an answer without
// anyone opening the container logs.
let lastImageNote = null;
function imageNote() {
  return lastImageNote;
}

// What Claude is told about a photo.
//
// Customers do not only photograph lists. They photograph the BOX, the printed
// label, another dealer's WhatsApp screen, an estimate, and the bare part
// itself. Asking only for "order lists" made the model answer {"lines":[]} for
// a perfectly readable label, and the customer was told to type it out.
//
// Handwriting (13 Sep, founder: "ye handwritten photo kyon nhi pd rha..claude
// api lagaya hi isliye hai"). A coil box labelled "33400 M" with "68P10" written
// after it came back twice as "33400M" and went to a person; 33400M68P10 is on
// the portal. On a handwritten 22-line list "- 10" was read as x16 and
// 71712M50S00 as 71712M50500. Tried on those very photos inside the container:
// this prompt read 33400M68P10, x10 and 71712M50S00; the old one did not.
//
// Customers also photograph our own paperwork - invoices, gate passes, cheques,
// delivery challans. Those are not orders, and telling a person "could not read
// the part number from this photo" about a bill they can plainly see is worse
// than saying nothing.
const VISION_PROMPT =
  'You look at photos sent by auto-parts customers on WhatsApp. They may be: a handwritten or typed ' +
  'order list, a printed part label or box, a screenshot of another chat, an estimate, or the part ' +
  'itself. Read EVERY part number and part name you can see. Part numbers look like 16510M65L10, ' +
  '"43401 M 68R00", 0603BAB0015KT, 2S6Z6500B. ' +
  'CRITICAL: Do NOT hallucinate or guess part names or numbers. If a part name or number is not explicitly written in the image, do not include it. ' +
  'HANDWRITING COUNTS as much as print. On a box the printed part number is often partly covered by a ' +
  'sticker or finished by hand: printed "33400 M" with "68P10" written after it is ONE part number, ' +
  '33400M68P10. Always give the COMPLETE part number, joining the printed and handwritten pieces - never ' +
  'a fragment like "33400M". A Maruti number is 5 digits, M, then 5 more characters (16510M65L10). ' +
  'A handwritten price or MRP (for example "1364" written over the MRP box), batch codes, barcodes, dates ' +
  'and phone numbers are NOT part numbers and NOT quantities. The "QTY 1" printed on a box is the pack, ' +
  'not an order quantity. In a handwritten list "71821M55T00 - 10" means quantity 10; read each digit ' +
  'carefully and do not merge a line with the one below it. ' +
  'Give "qty" ONLY when the photo states a quantity for the order; omit it otherwise — do not guess 1. ' +
  'ALSO say what the photo IS, in "doc": one of "order" (a request for parts), "invoice" (a tax ' +
  'invoice or bill), "gatepass", "challan", "payment" (cheque, receipt, UPI screenshot), "part" (a ' +
  'photo of the component itself with no readable number), or "other". ' +
  'ALSO read the vehicle REGISTRATION NUMBER if a number plate is visible anywhere in the photo — ' +
  'a customer photographing their car means "this is my car, find me a part for it". Indian plates ' +
  'look like DL7CW1692, HR 26 DQ 5551, MH12AB1234. Give it in "plate", with no spaces. A chassis or ' +
  'engine number on a VIN plate is NOT a registration number: leave "plate" out for those. Never ' +
  'guess a plate that is not legible. ' +
  'Reply ONLY with JSON: {"doc":str,"plate":str,"lines":[{"item":str,"qty":int}]}. ' +
  'If there is no part number and no part name in the photo, use an empty lines array.';

// "33400M" or "33400 M COIL ASSY IGNITION": the printed half of a Maruti number.
function visionFragment(lines) {
  for (const l of lines || []) {
    const m = String((l && l.item) || '').trim().match(/^(\d{5})\s?M(?:\s+[A-Za-z].*)?$/i);
    if (m) return m[1] + 'M';
  }
  return null;
}

async function parseOrderImage(base64, mediaType) {
  lastImageNote = null;
  const raw = config.ai.ocr ? await ocrImageToText(base64, mediaType) : null;
  const ocrText = raw ? scrubOcrNoise(raw) : raw;
  if (ocrText) {
    const lines = sanitizeOrderLines(parseLinesBlock(ocrText), ocrText);
    if (lines.length) {
      store.log('ai', `photo order read via OCR: ${lines.length} line(s)`);
      return lines;
    }
    if (modelAvailable()) {
      try {
        const r = await claude(
          'This is raw OCR text from a photo of an auto-parts order (may be messy/Hinglish). ' +
            'Reply ONLY with JSON: {"lines":[{"item":str,"qty":int}]}. If it is not an order, reply {"lines":[]}.',
          ocrText
        );
        const clean = r && Array.isArray(r.lines) ? sanitizeOrderLines(r.lines, ocrText) : [];
        if (clean.length) {
          store.log('ai', `photo order read via OCR + Claude: ${clean.length} line(s)`);
          return clean;
        }
      } catch (e) {
        store.log('ai', 'OCR-text cleanup failed: ' + e.message);
      }
    }
    // OCR produced text, but nothing usable came out of it. That is not a
    // reason to give up: a label OCR read as three characters of noise is
    // exactly what vision handles well. Falling through here instead of
    // returning meant the best reader we have was skipped whenever the worst
    // one managed to emit a single character.
    store.log('ai', `OCR text (${ocrText.trim().length} chars) held no order — trying vision`);
  }
  // GEMINI FIRST, Claude behind it.
  //
  // 21 Sep: the Anthropic key was revoked, and with local OCR off that left
  // no reader at all — every photo went to a person. Gemini reads a label
  // just as well (3s on the test fixture) and its key is the one that works,
  // so it leads and Claude catches what it cannot do. A photo that Gemini
  // reads but finds no part in is a finished answer, not a failure: it
  // returns an empty list and nobody else is asked, exactly as Claude did
  // when it led.
  const primary = await geminiOrderImage(base64, mediaType);
  if (primary) return primary;

  // Gemini is not configured, or could not answer — Claude vision if available
  if (config.ai.apiKey) {
    try {
      const image = { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } };
      let r = await claude(VISION_PROMPT, [image, { type: 'text', text: 'Extract the order lines from this image.' }]);
      // It stopped at the printed half of a number ("33400M"): one more look,
      // told where the rest usually is. Used only if it then gives a longer
      // number that starts the same way.
      const fragment = r && Array.isArray(r.lines) ? visionFragment(r.lines) : null;
      if (fragment) {
        store.log('ai', `photo gave only "${fragment}" - asking again for the whole number`);
        try {
          const again = await claude(VISION_PROMPT, [
            image,
            {
              type: 'text',
              text:
                'Extract the order lines from this image. The part number starting "' + fragment + '" is incomplete - ' +
                'the rest is usually written by hand next to it or hidden under a sticker. Give the full part number.',
            },
          ]);
          const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const whole = (l) => {
            const pn = norm(partNumberIn(String(l.item || '')) || String(l.item || '').split(/\s+/)[0]);
            return pn.startsWith(fragment) && pn.length >= fragment.length + 4;
          };
          if (again && Array.isArray(again.lines) && again.lines.some(whole)) r = again;
        } catch (e) {
          store.log('ai', 'second look at the photo failed: ' + String((e && e.message) || e).slice(0, 90));
        }
      }
      if (r && Array.isArray(r.lines)) {
        const clean = sanitizeOrderLines(r.lines, null);
        // Carried on the array so the caller can tell "a bill" from "could not
        // read it" without a second call to the model. Callers that only use
        // .length / .map are unaffected.
        if (r.doc) clean.docType = String(r.doc).toLowerCase().slice(0, 20);
        // A number plate in the photo is the customer's CAR, not a part.
        // Carried on the array so media.js can look it up instead of sending
        // an unreadable photo to a person.
        if (r.plate) clean.plate = require('../integrations/vahan').plateIn(String(r.plate)) || null;
        lastImageNote = clean.length ? null : "the photo was read, but no part number is visible in it";
        // Say what happened either way. Without this the log went silent after
        // "OCR found NO text", which reads as "Claude was never called" when in
        // fact it looked at the photo and found no order in it — two completely
        // different problems with the same symptom on the customer's screen.
        store.log(
          'ai',
          clean.length
            ? `photo order read via Claude vision: ${clean.length} line(s)`
            : `Claude vision saw the photo but found no order lines (${r.lines.length} raw)`
        );
        return clean;
      }
      lastImageNote = "the model did not answer properly about this photo";
      store.log('ai', 'Claude vision returned no usable JSON');
    } catch (e) {
      lastImageNote = "reading the photo failed: " + String((e && e.message) || e).slice(0, 90);
      store.log('ai', 'Claude vision failed: ' + String((e && e.message) || e).slice(0, 120));
    }
    return [];
  }
  lastImageNote = "there is no AI key on this machine, so photos cannot be read";
  store.log('ai', 'no OCR text and no vision key — photo cannot be read');
  return null;
}

// Ask Gemini to read the photo, in the same shape Claude is asked for.
// Returns the cleaned lines, or null when Gemini is not configured or could
// not answer — null means "nothing to add", never "the photo is empty".
async function geminiOrderImage(base64, mediaType) {
  const g = config.gemini;
  if (!g.apiKey) return null;
  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(g.visionModel) +
      ':generateContent';
    // 503 means "the model is busy, ask again", NOT "this photo cannot be
    // read" — and the two had the same ending: straight past a dead Claude
    // key to a person. Measured 21 Sep: one in five calls came back 503 while
    // the same photo read perfectly on the retry. Backs off 1s, 2s.
    //
    // 429 is NOT in that set on purpose. Google answers 429 both for "too
    // fast, slow down" and for "your quota is gone until it resets", and the
    // second is not worth three attempts — on 21 Sep a spent free-tier quota
    // cost five seconds of retries per photo before the same failure. A
    // rate-limited call is caught by the next photo anyway; an exhausted one
    // needs a person to fix the billing, not a tighter loop.
    const RETRY_ON = new Set([500, 502, 503, 504]);
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
      res = await fetch(url + '?key=' + encodeURIComponent(g.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: VISION_PROMPT + '\n\nExtract the order lines from this image.' },
                { inline_data: { mime_type: mediaType || 'image/jpeg', data: base64 } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(g.timeoutMs),
      });
      if (res.ok || !RETRY_ON.has(res.status)) break;
      store.log('ai', `Gemini vision HTTP ${res.status} (attempt ${attempt + 1}/3) — retrying`);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    const text = (((data.candidates || [])[0] || {}).content?.parts || [])
      .map((p) => p.text || '')
      .join('');
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('no JSON in the reply');
    const r = JSON.parse(json[0]);
    if (!r || !Array.isArray(r.lines)) throw new Error('no lines array');
    const clean = sanitizeOrderLines(r.lines, null);
    if (r.doc) clean.docType = String(r.doc).toLowerCase().slice(0, 20);
    // A number plate in the photo is the customer's CAR, not a part.
    // Carried on the array so media.js can look it up instead of sending
    // an unreadable photo to a person.
    if (r.plate) clean.plate = require('../integrations/vahan').plateIn(String(r.plate)) || null;
    lastImageNote = clean.length ? null : 'the photo was read, but no part number is visible in it';
    store.log(
      'ai',
      clean.length
        ? `photo order read via Gemini vision: ${clean.length} line(s)`
        : `Gemini vision saw the photo but found no order lines (${r.lines.length} raw)`
    );
    return clean;
  } catch (e) {
    store.log('ai', 'Gemini vision failed: ' + String((e && e.message) || e).slice(0, 120));
    return null;
  }
}


// IS THIS A SHOP, AND DOES IT HAVE A BOARD?
//
// The form asks for "shop ke saamne ki photo". What arrives is sometimes a
// selfie, sometimes the inside of a boot, sometimes a screenshot — and the
// approver then has to open every one to find out. The signboard is the
// point: it is what ties the photograph to the firm name on the GST
// certificate, and an approver checking an account reads it first.
//
// Returns { isShop, hasBanner, bannerText, why } or null when there is no
// vision model configured. NULL MEANS "NOBODY LOOKED" — never "it is fine"
// and never "it is wrong". The caller must not refuse a photo on a null.
const SHOP_PHOTO_PROMPT = [
  'You are looking at a photograph sent by a shop owner to open a trade account.',
  'Answer ONLY with JSON, no prose:',
  '{"isShop": true|false, "hasBanner": true|false, "bannerText": "<text on the signboard, or empty>", "why": "<six words>", "gps": {"lat": <number or null>, "lng": <number or null>, "address": "<address printed with it, or empty>"}}',
  '',
  'isShop: true if this shows a shop, garage, workshop or business premises —',
  '  inside or outside. False for a selfie with no premises, a screenshot, a',
  '  document, a car on its own, a part on its own, or a plain room.',
  'hasBanner: true if a signboard, banner, hoarding or painted shop name is',
  '  visible AND readable. A blank awning is not a banner.',
  'bannerText: exactly what the board says, if you can read it. Do not guess.',
  'gps: a GPS stamp PRINTED on the photo by a camera app (e.g. "GPS Map Camera": "Lat 28.530972° Long',
  '  77.053152°" and an address in a corner). Copy the numbers exactly as printed; south and west are',
  '  negative. null for both when nothing like that is printed - never estimate a location from the scene.',
].join('\n');

// A printed stamp, if the numbers are a real place. 0,0 and out-of-range
// numbers are a misread, not a location.
function stampedGps(g) {
  if (!g || typeof g !== 'object') return null;
  const lat = Number(g.lat);
  const lng = Number(g.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng, address: String(g.address || '').trim().slice(0, 200) || null };
}

async function readShopPhoto(base64, mediaType) {
  const g = config.gemini;
  if (!g.apiKey || !base64) return null;
  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(g.visionModel) +
      ':generateContent';
    // Same retry rule as the order reader: 503 means "busy, ask again",
    // 429 means a spent quota and is not worth three attempts.
    const RETRY_ON = new Set([500, 502, 503, 504]);
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
      res = await fetch(url + '?key=' + encodeURIComponent(g.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: SHOP_PHOTO_PROMPT }, { inline_data: { mime_type: mediaType || 'image/jpeg', data: base64 } }] }],
        }),
        signal: AbortSignal.timeout(g.timeoutMs),
      });
      if (res.ok || !RETRY_ON.has(res.status)) break;
    }
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    const data = await res.json();
    const text = (((data.candidates || [])[0] || {}).content?.parts || []).map((p) => p.text || '').join('');
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('no JSON in the reply');
    const r = JSON.parse(json[0]);
    const out = {
      isShop: r.isShop === true,
      hasBanner: r.hasBanner === true,
      bannerText: String(r.bannerText || '').trim().slice(0, 80) || null,
      why: String(r.why || '').trim().slice(0, 60) || null,
      gps: stampedGps(r.gps),
    };
    store.log('ai', `shop photo: shop=${out.isShop} banner=${out.hasBanner}${out.bannerText ? ' "' + out.bannerText + '"' : ''}${out.gps ? ` gps=${out.gps.lat},${out.gps.lng}` : ''}`);
    return out;
  } catch (e) {
    // A vision call that failed must not stop an account being opened.
    store.log('ai', 'shop photo check failed: ' + String((e && e.message) || e).slice(0, 120));
    return null;
  }
}

module.exports = {
  stripNoPrefix,
  normalizeOrderText,
  // What the gate chain decided is noted for the shadow log (pipeline/shadow).
  // The result is returned untouched.
  parseCustomerMessage: (...args) => parseCustomerMessage(...args).then((r) => require('../pipeline/shadow').noteGate(r)),
  parseVendorStock, parseOrderImage, parseLinesBlock, readShopPhoto, matchCatalog, CONFIRM_RE, partNumberIn,
  // why the last photo could not be read - written into the chat as a note
  imageNote,
  // exported for tests
  bareQty,
  captionQty,
  // The raw model call, so core/smallTalk.js does not open a second one.
  // Is there a model behind this bot at all — Anthropic, Gemini, either.
  modelAvailable,
  _claude: claude,
  // With web search, for looking facts up (core/partNaming).
  _claudeWeb: claudeWeb,
  _setClaude: (fn) => {
    claudeStub = fn || null;
  },
  // exported for tests
  _internals: { scanPartTokens, maxTokensPerLine, isPartToken, isJunkItem, joinSpacedPartNumbers, sanitizeOrderLines, PART_TOKEN_RE, QTY_UNIT_TOKEN } };
