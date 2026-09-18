'use strict';
// A salesman ordering FOR a customer.
//
// Sir, 11 Sep: a salesman writes "Kalra Motors ka SO bana do". The bot finds
// the customer by name, asks the salesman WHICH customer, takes the parts,
// shows the draft SO to check, punches it on "haan", and then asks once more
// before Confirm SO — the step that starts allocation.
//
// How it talks: like a colleague, not a form. No "Reply *haan*", no "Number
// bhejiye", no capitals. "Sahi hai?" is a question anyone answers with haan /
// ok / yes / hn, and a numbered list is answered with a number without being
// told to. Every one of those answers is understood.
//
// Facts from the live portal (11 Sep) that shape this file:
//   * The portal's name search matches anywhere inside a name: "Anuj" also
//     brings back "Tanuj R". Here every word typed must START a word of the
//     name, so "Anuj" finds anuj / Anuj / ANUJ GOSAIN and never Tanuj.
//   * That search answers in 0.2 s. The full customer list took 77-80 s every
//     time, far past the portal client's 20 s limit, so it is not used.
//   * A customer's account id IS the buyer id an SO is punched for (M/S Maan
//     Motors: 345 by name, 345 by mobile).
//   * The search gives no home branch, and the branch decides which warehouse
//     stock is checked and allocated from. See enrich() below.
//   * Company SIMs are saved as customer phones — 9217030422 is Agent Hajra
//     AND customer M/S Maan Motors; the helper's 9999492550 is Fixit Auto. So
//     the salesman's own number must never decide who the order is for. Only
//     the customer picked here does.
//
// Who may: the sales team list (SALES_TEAM_NUMBERS) and admins. Anyone else
// writing "X ka order" is a customer talking about their own order.
const config = require('../config');
const store = require('../store');
const lookup = require('./customerLookup');
const chatState = require('./chatState');

const CHOOSE_TTL_MS = 15 * 60 * 1000; // picking a customer, answering Confirm SO
const ACTIVE_TTL_MS = 2 * 60 * 60 * 1000; // ordering for one customer
const MAX_CANDIDATES = 5;

function isSalesPerson(phone) {
  const p = store.normPhone(phone);
  if (!p) return false;
  return (config.salesTeamNumbers || []).includes(p) || (config.adminNumbers || []).includes(p);
}

// ---------------------------------------------------------------- reading the request
//
// "Kalra Motors ka SO bana do"          "Anuj ka SO: 16510M65L10 2"
// "Maan Motors ka order punch kar do"   "order for Kalra Motors: 16510M65L10 2"
// "Kalra ke liye 16510M65L10 2"
// with the parts, if any, after the trigger or on the lines below.
const PART_LIKE = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/;
const ORDER_WORD = String.raw`(?:order|orders|so|s\.o\.?|sale\s*order|sales\s*order)`;
const RE_KA = new RegExp(String.raw`^([^\n]{2,60}?)\s+(?:ka|ki|ke)\s+(?:(?:ye|yeh|this|wo|woh|wala|wali)\s+)?` + ORDER_WORD + String.raw`\b([\s\S]*)$`, 'i');
// "punch this order for Kalra Motors and give me order id", "place order for
// Maan Motors: 16510M65L10 2". The verb comes first in English; 13 Sep this
// read as nothing at all and went to the helper as an unknown part.
const RE_VERB_FOR = new RegExp(
  String.raw`^(?:please\s+|pls\s+)?(?:punch|place|create|book|make|put|laga|lagao|bana|banao)\s+(?:(?:this|that|the|an?|my|ye|yeh)\s+)?` +
    ORDER_WORD +
    String.raw`\s+(?:for|of)\s+([^\n:,]{2,60}?)(?:\s+(?:and|aur)\b[^\n:]*)?\s*(?:[:,]([\s\S]*))?$`,
  'i',
);
const RE_FOR = new RegExp(
  String.raw`^` + ORDER_WORD + String.raw`\s+(?:for|of)\s+([^\n:,]{2,60}?)\s*(?:[:,]([\s\S]*))?$`,
  'i',
);
const RE_KE_LIYE = /^([^\n]{2,60}?)\s+ke\s+liye\b([\s\S]*)$/i;
// "punch this order", "ye order punch kr do", "punch this order and give me
// order id" - an order with no customer named in it.
const PUNCH_THIS =
  /^\s*(?:please\s+|pls\s+)?(?:(?:punch|place|book|laga|lga|lagao|bana|bna|banao)\s+(?:(?:this|that|the|ye|yeh|is|wo)\s+)?(?:order|so)|(?:(?:this|that|the|ye|yeh|is|wo)\s+)?(?:order|so)\s+(?:punch|place|laga|lga|bana|bna)(?:\s+(?:kr|kar|karo|kro))?(?:\s+(?:do|de|dijiye))?)(?:\s+(?:and|aur)\b[^\n]*)?[\s.!]*$/i;
// "Kalra ka order kab aayega" asks about an order; it does not place one.
const STATUS = /\b(kab|status|kahan|kaha|aaya|aayega|aya|dispatch|deliver|delivery|track|pahuncha|bheja|gaya)\b/i;
const LEAD =
  /^\s*[:,-]?\s*(?:punch\s*kar\s*do|punch\s*karo|punch|bana\s*do|banao|bana|laga\s*do|lagao|daal\s*do|dalo|kar\s*do|karo|please|pls|plz|bhai|sir|ji)?\s*[:,-]?\s*/i;

function cleanItems(rest) {
  let s = String(rest || '');
  for (let i = 0; i < 4; i++) {
    const n = s.replace(LEAD, '');
    if (n === s) break;
    s = n;
  }
  s = s.trim();
  return s || null;
}

function cleanName(name) {
  return String(name || '')
    .replace(/^\s*m\s*[/.]\s*s\.?\s*/i, '')
    .replace(/\s+(?:bhai|sir|ji|wale|wala)\s*$/i, '')
    .replace(/[\s.:,-]+$/, '')
    .trim();
}

// text -> { customer, items, weak } or null. `weak` is "X ke liye": it only
// counts when X turns out to be a customer ("Swift ke liye brake pad" is a car).
function parseOrderFor(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (STATUS.test(t.split('\n')[0])) return null;
  let m;
  let name;
  let rest;
  let weak = false;
  if ((m = t.match(RE_KA))) [, name, rest] = m;
  else if ((m = t.match(RE_FOR))) [, name, rest] = m;
  else if ((m = t.match(RE_VERB_FOR))) [, name, rest] = m;
  else if ((m = t.match(RE_KE_LIYE))) {
    [, name, rest] = m;
    weak = true;
  } else return null;
  name = cleanName(name);
  if (name.length < 2 || PART_LIKE.test(name)) return null;
  return { customer: name, items: cleanItems(rest), weak };
}

// ---------------------------------------------------------------- finding the customer
function words(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\bm\s*[/.]\s*s\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

// Every word typed must START a word of the name. Tried on the live list of
// 7,492 customers (11 Sep): "Anuj" -> anuj, Anuj, ANUJ GOSAIN, Anuj Kumar
// Ph-3 and not Tanuj; "Kalra" -> Kalra Motors, Kalra Car Decor.
function match(query, rows) {
  const q = words(query);
  if (!q.length) return [];
  const out = [];
  for (const r of rows) {
    const n = words(r.name);
    if (!n.length) continue;
    if (!q.every((w) => n.some((x) => x.startsWith(w)))) continue;
    const exact = q.every((w) => n.includes(w));
    const whole = n.join(' ') === q.join(' ');
    out.push({ r, score: (whole ? 1000 : 0) + (exact ? 100 : 0) - (n.length - q.length) });
  }
  return out.sort((a, b) => b.score - a.score).map((x) => x.r);
}

// The portal finds names CONTAINING the phrase — a superset, "Anuj" with
// "Tanuj R" in it — and match() keeps only the right ones. The whole phrase
// is asked first because it is the most specific; if the portal knows no name
// containing it (words in another order, a missing "M/S"), the first word.
async function findCustomers(query) {
  const phrase = String(query || '').trim();
  const q = words(phrase);
  if (!q.length) return { total: 0, top: [] };
  const portal = require('../integrations/dealerPortal');
  // Both at once: a name the portal does not have costs a 4 s wait each
  // (see ACCOUNT_SEARCH_MS), so asking them one after the other doubled it.
  const [full, firstWord] = await Promise.all([
    portal.searchAccounts(phrase),
    q.length > 1 ? portal.searchAccounts(q[0]) : Promise.resolve([]),
  ]);
  const rows = full.length ? full : firstWord;
  const all = match(phrase, rows);
  return { total: all.length, top: all.slice(0, MAX_CANDIDATES) };
}

// Enough to tell two "Anuj"s apart: where they are, and whose customer.
// "M/S Maan Motors (Babarpur, Haryana · agent Seema)".
function place(row) {
  const parts = String(row.address || '')
    .split(',')
    .map((p) => p.replace(/\(IN\)/i, '').trim())
    .filter((p) => p && p.length > 2 && !/^[0-9 ]+$/.test(p));
  const pl = parts.slice(-2).join(', ');
  return pl || String(row.state_name || '').replace(/\(IN\)/i, '').trim();
}
function agentOf(row) {
  const m = String(row.group_name || '').match(/Agent\s*([A-Za-z .]+?)\s*-/i);
  return m ? m[1].trim() : '';
}
function label(row) {
  const extra = [place(row), agentOf(row) ? 'agent ' + agentOf(row) : ''].filter(Boolean).join(' · ');
  return extra ? row.name + ' (' + extra + ')' : row.name;
}

// The same shape customers.resolve() returns, so the order and confirm paths
// cannot tell a picked customer from one found by phone.
function ctxFor(row) {
  return {
    found: true,
    buyerId: row.id,
    branchId: row.home_branch_dealer || row.home_branch_dealer_id || null,
    name: row.name,
    gstNo: row.gst_no || null,
    canAnalyze: true,
    canConfirm: true,
    onBehalf: true,
    raw: row,
  };
}

// Which warehouse serves this customer. The portal's own record is the truth,
// so look the customer up by their phone — and trust the answer ONLY if it is
// the SAME account: company SIMs are saved on other customers, and a phone
// that belongs to someone else would move the order to their branch.
//
// Otherwise the company rule: Rajasthan -> Mansarovar, everyone else ->
// Bijwasan (the one the Data Entry automation uses). On 11 Sep the phone
// lookup came back as the same account 11 times out of 11, and the rule
// agreed with the portal 10 times out of 11 — the eleventh, S R Motors, sits
// on branch 8638. That is why the rule is the fallback and not the method.
async function enrich(ctx, row) {
  const phone = String(row.mobile || row.phone || '')
    .replace(/[^0-9]/g, '')
    .slice(-10);
  if (phone.length === 10) {
    try {
      const lk = await require('../integrations/dealerPortal').lookupCustomer(phone);
      if (lk && lk.found && lk.buyerId === row.id) {
        Object.assign(ctx, {
          branchId: lk.branchId || ctx.branchId,
          canAnalyze: lk.canAnalyze !== false,
          canConfirm: lk.canConfirm !== false,
          odooSynced: lk.odooSynced,
          branchFrom: 'portal',
        });
      } else if (lk && lk.found) {
        store.log('sales', 'phone of ' + row.name + ' belongs to ' + lk.name + ' (buyer ' + lk.buyerId + ') - not used');
      }
    } catch (e) {
      store.log('sales', 'branch lookup failed for ' + row.name + ': ' + String((e && e.message) || e).slice(0, 100));
    }
  }
  if (!ctx.branchFrom) {
    if (ctx.branchId) ctx.branchFrom = 'record';
    else {
      const { branchFor } = require('./dataEntryRequests');
      ctx.branchId = branchFor({ state: row.state_name || '', city: '', address: row.address || '' });
      ctx.branchFrom = 'rule';
    }
  }
  store.log('sales', 'branch for ' + ctx.name + ': ' + ctx.branchId + ' (' + ctx.branchFrom + ')');
  return ctx;
}

// ---------------------------------------------------------------- about a named customer
//
// "kalra motor give me pending", "Kalara mortor discount", "16510M65L10 10 pcs
// for kalra motors, detailed analysis". Whatever is left after the part
// number, the quantity and the asking words is the customer's name, and it
// only counts if the portal actually has an account by that name - so an
// ordinary message from a salesman is never hijacked.
// The words that ask for the FULL analysis. Founder, 13 Sep: only when asked
// - "analyse", "analysis", "detail". A customer's name next to a part is
// otherwise an availability question like any other.
const ANALYSIS_WORD = /\b(analy[sz]e|analy[sz]is|analyses|details?|detailed)\b/i;

const ABOUT_INTENT = [
  ['credit', /\b(credit\s*notes?|cn)\b/i],
  ['ledger', /\b(pending|dues?|balance|outstanding|ledger|khata|hisaab|hisab|baki|baaki|bakaya|payment)\b/i],
  ['discount', /\b(discount|disc)\b/i],
  ['status', /\b(status|kab\s*aayega|kahan\s*hai|where\s*is)\b/i],
];
const ABOUT_FILLER = /^(give|me|my|the|a|an|for|of|to|please|pls|sir|ji|detailed|detail|details|analysis|analyze|analyse|check|send|bhejo|batao|bata|do|dena|kya|hai|ka|ki|ke|ko|pcs|pc|pieces|piece|nos|no|pise|qty|x|and|aur|stock|mrp|rate|price|discount|disc|pending|dues|due|balance|outstanding|ledger|khata|hisaab|hisab|baki|baaki|bakaya|payment|credit|notes|note|cn|order|orders|status|where|is|kahan|kab|aayega|this|that|tell|show|what|how|much|about|customer|party|wala|wale|as|well|also|all|full|complete|everything|part|parts|item|items|iska|iske|iski|isko|same|bhi|sab|saari|sari|poori|puri|info|information|breakdown|i|need|needs|want|required|require|chahiye|chaiye|karo|kro|krdo|kardo|dijiye|plz|asap|urgent|jaldi)$/i;

function parseAbout(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 140 || line.indexOf('\n') >= 0) return null;
  const partish = require('./partish');
  // A digits-only part number (2630002752) is a part here too; nameFrom drops
  // it from the name either way.
  const part = partish.partNumber(line) || (line.match(/(?:^|\s)(\d{7,13})(?=\s|$)/) || [])[1] || null;
  // Several part numbers on one line are not a question about one of them;
  // a list for a customer goes one part per line (parseAboutMany).
  if (part && line.split(/[\s,;]+/).filter((w) => partish.isPartNumber(w)).length > 1) return null;
  let intent = part && ANALYSIS_WORD.test(line) ? 'analysis' : null;
  if (!intent) for (const [name, re] of ABOUT_INTENT) if (re.test(line)) { intent = name; break; }
  if (!intent) return null;

  let rest = partish.joined(line);
  if (part) rest = rest.split(/\s+/).filter((w) => partish.partNumber(w) === null).join(' ');
  // "(HARYANA, Haryana)" is where they are, not part of the name - it is how
  // our own list tells two Anujs apart, and the desk types it back.
  const placeM = rest.match(/\(([^)]*)\)/);
  const place = placeM ? placeM[1].trim() : null;
  if (placeM) rest = rest.replace(placeM[0], ' ');
  const qm = rest.match(/(?:^|\s)(\d{1,4})\s*(?:pcs?|pieces?|nos?|pise|qty)?(?=\s|$)/i);
  const qty = qm ? parseInt(qm[1], 10) : 1;
  // Only a number standing on its own is a quantity. "Ph-3" is part of
  // "Anuj Kumar Ph-3" and was cut to "Ph-" (13 Sep, live).
  const name = rest
    .replace(/(^|\s)\d+\s*(pcs?|pieces?|nos?|pise|qty)?(?=\s|$)/gi, ' ')
    .replace(/[^A-Za-z0-9&./\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:]+$/, ''))
    .filter((w) => w.length >= 2 && !ABOUT_FILLER.test(w))
    .join(' ')
    .trim();
  const asked = {
    intent,
    part: part ? String(part).toUpperCase() : null,
    qty: qty > 0 && qty <= 9999 ? qty : 1,
    // "all details", "detailed analysis": the whole picture, not one figure
    full: /\b(details?|detailed|analysis|analy[sz]e|all|full|complete)\b/i.test(line),
    place,
  };
  // No name at all: "give me discount as well for this part. all details."
  // That is about the customer just discussed - handle() decides whether
  // there is one. Only for the words that ask ABOUT a customer; a bare
  // "16510M65L10 5" is still an ordinary order line.
  if (!name) return ABOUT_INTENT.some(([, re]) => re.test(line)) ? { customer: null, ...asked } : null;
  if (name.length < 3 || partish.isVehicle(name)) return null;
  return { customer: name, ...asked };
}

// The customer's name out of whatever is left once the parts are taken out:
// asking words dropped, "(place)" kept aside, a number standing alone
// dropped ("Ph-3" stays).
function nameFrom(rest) {
  let s = String(rest || '');
  const placeM = s.match(/\(([^)]*)\)/);
  const place = placeM ? placeM[1].trim() : null;
  if (placeM) s = s.replace(placeM[0], ' ');
  const name = s
    .replace(/(^|\s)\d+\s*(pcs?|pieces?|nos?|pise|qty)?(?=\s|$)/gi, ' ')
    .replace(/[^A-Za-z0-9&./\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:]+$/, ''))
    .filter((w) => w.length >= 2 && !ABOUT_FILLER.test(w))
    .join(' ')
    .trim();
  return { name, place };
}

// The parts in a message, one per LINE (founder, 13 Sep: "not comma only new
// line"): each line that starts with a part number - hyphenated kind too -
// is a part with its quantity; a leading "1." from a copied list is skipped.
// Everything else comes back as `rest`.
function itemsAndRest(text) {
  const partish = require('./partish');
  const { groupedPart } = require('./availability');
  const items = [];
  const rest = [];
  for (const raw of String(text || '').split(/\n/)) {
    const piece = raw.trim().replace(/^\d{1,2}[.)]\s+/, '');
    if (!piece) continue;
    const m = piece.match(/^(\S+)(?:\s*[-x×*:=]?\s*(\d{1,4})\s*(?:pcs?|pieces?|nos?|pise|p|qty)?\.?)?(?:\s+(.*))?$/i);
    const head = m ? m[1] : '';
    // Digits only (2630002752) counts when a quantity comes with it - that is
    // what makes the line a part and not a phone number.
    const part = partish.isPartNumber(head) ? partish.joined(head) : groupedPart(head) || (/^\d{7,13}$/.test(head) && m[2] ? head : null);
    if (!part) {
      rest.push(piece);
      continue;
    }
    items.push({ part: String(part).toUpperCase(), qty: m[2] ? parseInt(m[2], 10) : 1, qtyGiven: Boolean(m[2]) });
    if (m[3]) rest.push(m[3]);
  }
  return { items, rest };
}

// "Detail analysis for kalra motors": the analysis word and a customer's name,
// and no part in it - the parts were in the message before (13 Sep, live: this
// was handed to the helper as "not a parts question"). Discount, pending and
// the rest stay parseAbout's.
function parseAnalysisAsk(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 120 || t.indexOf('\n') >= 0 || !ANALYSIS_WORD.test(t)) return null;
  const partish = require('./partish');
  const { groupedPart } = require('./availability');
  if (t.split(/\s+/).some((w) => partish.isPartNumber(w) || groupedPart(w) || /^\d{7,13}$/.test(w))) return null;
  if (ABOUT_INTENT.some(([, re]) => re.test(t))) return null;
  const { name, place } = nameFrom(t);
  if (!name || name.length < 3 || partish.isVehicle(name)) return null;
  return { customer: name, place };
}

// The parts an analysis without part numbers is about: the message it was
// swiped onto, else the latest message in this chat, within the hour, that
// had parts in it.
function recentItems(chatId, contextId) {
  const row = chatState.slot('quotable').get(chatId);
  const msgs = (row && row.items) || [];
  if (contextId) {
    const qi = msgs.findIndex((x) => x.id === contextId);
    const q = qi >= 0 ? msgs[qi] : null;
    const got = q ? itemsAndRest(q.text).items : [];
    // Our own reply names the parts but often not how many ("16510M65L10 -
    // available"); the customer's message it answered has the quantities.
    if (got.length && q.dir === 'us' && got.every((g) => !g.qtyGiven)) {
      const key = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const want = new Set(got.map((g) => key(g.part)));
      for (let i = qi - 1; i >= 0; i--) {
        if (msgs[i].dir !== 'customer') continue;
        const theirs = itemsAndRest(msgs[i].text).items;
        if (theirs.length && theirs.some((x) => want.has(key(x.part)))) return theirs;
      }
    }
    if (got.length) return got;
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const x = msgs[i];
    if (x.dir !== 'customer' || !x.at || Date.now() - x.at > 60 * 60 * 1000) continue;
    const got = itemsAndRest(x.text).items;
    if (got.length) return got;
  }
  return [];
}

// Several parts for one customer: "26300-02752 40 pcs\n16510m65L10 100
// pcs\nkalra motors analysis", "16510M65L10 10, 13780M76SA0 5 for kalra
// motors". Founder, 13 Sep: "Kai parts ek saath chahiye ... bna do" - the
// portal chat answered a list in one table, the bot one part a message.
// Each line or comma piece that STARTS with a part number is a part; what
// else is written is the name and the asking words. Two parts at least -
// one part is parseAbout's.
function parseAboutMany(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 1500) return null;
  const partish = require('./partish');
  const { groupedPart } = require('./availability');
  const { items, rest } = itemsAndRest(t);
  if (items.length < 2) return null;
  const restText = rest.join(' ');
  // Only when the analysis is asked for; a list with a name and nothing else
  // is an availability question.
  if (!ANALYSIS_WORD.test(restText)) return null;
  const { name, place } = nameFrom(restText);
  if (!name) {
    // No name: handle() uses the customer being discussed, if any.
    return { customer: null, intent: 'analysis', items, many: true, place };
  }
  if (name.length < 3 || partish.isVehicle(name)) return null;
  return { customer: name, intent: 'analysis', items, many: true, place };
}

// A typed name one or two letters off: "Kalara mortor" for Kalra Motors. The
// portal's search is a plain substring match, so it finds nothing; ask it for
// the first letters and keep the names whose words are close to what was typed.
function editDistance(a, b) {
  a = String(a || '').toLowerCase();
  b = String(b || '').toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
async function findCustomersFuzzy(phrase) {
  const typed = words(phrase).filter((w) => w.length >= 4);
  if (!typed.length) return { total: 0, top: [] };
  const portal = require('../integrations/dealerPortal');
  // The first word with one letter taken out, each variant an exact lookup:
  // "kalara" -> ... "kalra" -> Kalra Motors. Never a two-letter prefix.
  const first = typed[0];
  const variants = [];
  for (let i = 0; i < first.length; i++) {
    const v = first.slice(0, i) + first.slice(i + 1);
    if (v.length >= 4 && !variants.includes(v)) variants.push(v);
  }
  // All variants at once, and every answer kept: the first one with rows
  // is not the right one ("alara" -> Balaram Jeppesen), the closest one is.
  const answers = await Promise.all(
    variants.slice(0, 10).map((v) => portal.searchAccounts(v).catch(() => [])),
  );
  const seen = new Set();
  const rows = [];
  for (const list of answers) {
    for (const r of list) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
  }
  // Close means: same first letter, and one letter off on a short word, two
  // on a longer one. "anuj" is not "tanuj"; "mortor" is "motors".
  const close = (w, n) => {
    if (!n || w[0] !== n[0]) return 99;
    const d = editDistance(w, n);
    return d <= (w.length <= 5 ? 1 : 2) ? d : 99;
  };
  const scored = [];
  for (const r of rows) {
    const nameWords = words(r.name);
    let total = 0;
    let ok = true;
    for (const w of typed) {
      const best = Math.min(99, ...nameWords.map((n) => close(w, n)));
      if (best >= 99) { ok = false; break; }
      total += best;
    }
    if (ok) scored.push({ r, total });
  }
  scored.sort((x, y) => x.total - y.total);
  return { total: scored.length, top: scored.slice(0, MAX_CANDIDATES).map((x) => x.r) };
}

// Who a salesman is talking ABOUT right now - kept apart from "active", which
// means he is ORDERING for them. A price question is not an order.
const discussingMap = chatState.slot('sales.discussing'); // chatId -> { ctx, at }
function discussing(chatId) {
  const d = discussingMap.get(chatId);
  if (!d) return null;
  if (Date.now() - d.at > ACTIVE_TTL_MS) {
    discussingMap.delete(chatId);
    return null;
  }
  return d.ctx;
}

// The catalogue name as a person would say it. The portal sends
// "OIL FILTER | MARUTI SUZUKI ALTO | #16510M65L10" (read live 13 Sep): the
// part number is already on the line above, and capitals in pipes read as a
// database row, not a reply.
function prettyPartName(name) {
  const parts = String(name || '')
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s && !/^#/.test(s));
  if (!parts.length) return null;
  const title = (s) =>
    s.replace(/[A-Za-z][A-Za-z']*/g, (w) => (/^[A-Z0-9]{1,3}$/.test(w) && /\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
  return parts.map(title).join(' - ');
}

// The GST INSIDE a GST-inclusive amount. The portal's rate already includes
// it: Odoo bill CT-DL-26-27/3227 (Kalra, 12 Sep) is 10 x 105 at 12% = ₹924,
// untaxed 783.05 + tax 140.95, tax "price_include". Until 13 Sep the bot
// added 18% on top and said ₹1,090.32. Returns null without a tax percent.
function gstSplit(gross, taxPercent) {
  const tp = Number(taxPercent);
  if (!gross || !tp) return null;
  const taxable = Math.round((gross / (1 + tp / 100)) * 100) / 100;
  return { taxable, gst: Math.round((gross - taxable) * 100) / 100 };
}

function inr(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-';
}

async function answerAbout(bot, m, row, about, reply, t) {
  const portal = require('../integrations/dealerPortal');
  store.log('sales', m.from + ' asked about ' + row.name + ' (' + about.intent + (about.part ? ' ' + about.part : '') + ')');
  if (about.intent === 'ledger' || about.intent === 'credit' || about.intent === 'status') {
    return reply(await lookup.answer(row, about.intent, t));
  }
  const ctx = await enrich(ctxFor(row), row);
  discussingMap.set(m.chatId, { ctx, at: Date.now() });

  // "Kalra Motors discount" names no part, and the discount is decided per
  // part. Their latest ordered part is priced for them, live.
  let part = about.part;
  let qty = about.qty || 1;
  let fromHistory = false;
  if (!part && about.intent === 'discount') {
    try {
      const recent = await portal.recentOrders(row.name, { limit: 5 });
      const hit = recent.find((o) => (o.lines || []).length) || null;
      if (hit) { part = hit.lines[0].part_no; qty = 1; fromHistory = true; }
    } catch (e) {
      store.log('sales', 'recent orders for ' + row.name + ' failed: ' + String((e && e.message) || e).slice(0, 90));
    }
    if (!part) {
      // The part number they send next is the one asked for (13 Sep, live: a
      // bare "83401M82P11" after this got no answer at all).
      discussingMap.set(m.chatId, { ctx, at: Date.now(), awaitPart: 'discount' });
      return reply(t(
        row.name + "'s discount depends on the part - send me a part number.",
        row.name + ' ka discount part pe depend karta hai - part number bhej dijiye.',
      ));
    }
  }

  let r = null;
  try {
    const rows = await portal.commercialAnalyze([{ item: part, partNo: part, qty }], ctx);
    r = rows && rows[0];
  } catch (e) {
    store.log('sales', 'commercial-analyze for ' + row.name + ' failed: ' + String((e && e.message) || e).slice(0, 110));
  }
  if (!r) return reply(t("I can't open the price for " + row.name + ' right now.', row.name + ' ka rate abhi khul nahi raha.'));
  // The part and quantity too, so "discount bhi batao" and "punch this order"
  // in the next message mean exactly this.
  discussingMap.set(m.chatId, { ctx, at: Date.now(), part, qty });
  try { require('./focus').remember(m.chatId, [r]); } catch (_) {}

  if (about.intent === 'discount') {
    // No discount is still an answer with a price in it (13 Sep, live: "No
    // discount set for Bhagwati Motors on 83401M82P11." and nothing else).
    if (!r.discountPercent) {
      return reply(
        t('No discount for ' + row.name + ' on ' + part, row.name + ' ka ' + part + ' pe koi discount nahi') +
          (r.mrp ? '\nMRP ₹' + inr(r.mrp) + ' -> ₹' + inr(r.rate || r.mrp) + (r.taxPercent ? ' incl. ' + r.taxPercent + '% GST' : ' incl. GST') : ''),
      );
    }
    return reply(
      row.name + ' - ' + r.discountPercent + t('% discount', '% discount') +
        (fromHistory ? t(' (on ' + part + ', their last order)', ' (' + part + ' pe, pichhle order ke hisaab se)') : ' - ' + part) +
        '\nMRP ₹' + inr(r.mrp) + ' -> ₹' + inr(r.rate) + (r.taxPercent ? ' incl. ' + r.taxPercent + '% GST' : ' incl. GST'),
    );
  }

  if (r.source === 'unidentified') {
    return reply(t(part + ' is not in the catalogue.', part + ' catalogue mein nahi mila.'));
  }
  const stock =
    r.source === 'unavailable'
      ? t('on order, ETA ', 'on order, ETA ') + (require('../config').onOrderEtaDays) + t(' days', ' din')
      : r.partial
        ? t('only ' + r.available + ' available', 'sirf ' + r.available + ' available')
        : t(r.available + ' available', r.available + ' available') + (r.tatDays ? t(', TAT ' + r.tatDays + ' day', ', TAT ' + r.tatDays + ' din') : '');
  // Everything the portal answered, the way the desk reads it on the portal
  // (founder, 13 Sep, comparing with a chat on the same API): the part's own
  // name, the warehouse, allocated and short, and the money with the GST
  // worked out. Our purchase price (allocations base_price) is never here.
  const warehouse = (r.vendors || []).map((v) => v.name).filter(Boolean)[0] || null;
  const allocated = Number(r.available) || 0;
  const short = r.shortfall != null ? r.shortfall : Math.max(0, qty - allocated);
  const lines = [row.name + ' - ' + part + ' x' + qty];
  if (r.partName) lines.push(prettyPartName(r.partName) || r.partName);
  lines.push(t('Stock: ', 'Stock: ') + stock);
  lines.push(
    t('Allocated ', 'Allocated ') + allocated + ' · shortfall ' + short +
      (warehouse ? t(' · from ' + warehouse, ' · ' + warehouse + ' se') : ''),
  );
  if (r.rate) {
    lines.push('MRP ₹' + inr(r.mrp) + ' · ' + (r.discountPercent || 0) + '% off · rate ₹' + inr(r.rate) + (r.taxPercent ? ' incl. ' + r.taxPercent + '% GST' : ' incl. GST'));
    // What the bill will say: the total, with the taxable value and the GST
    // inside it - never added on top (see gstSplit).
    const gross = Math.round(r.rate * qty * 100) / 100;
    const split = gstSplit(gross, r.taxPercent);
    lines.push('Total ₹' + inr(gross) + (split ? ' (taxable ₹' + inr(split.taxable) + ', GST ₹' + inr(split.gst) + ')' : ' incl. GST'));
  }
  if (r.hsn) lines.push('HSN ' + r.hsn);
  // "discount bhi batao": the thing asked for first, then the rest. Live on
  // 13 Sep the answer was the previous analysis again, word for word.
  if (about.lead === 'discount' && r.discountPercent) {
    lines.unshift(
      t(
        'Discount ' + r.discountPercent + '% for ' + row.name + ' - MRP ₹' + inr(r.mrp) + ' → ₹' + inr(r.rate) + ' per pc',
        row.name + ' ka discount ' + r.discountPercent + '% - MRP ₹' + inr(r.mrp) + ' → ₹' + inr(r.rate) + ' per pc',
      ),
    );
  }
  return reply(lines.join('\n'));
}

// ---------------------------------------------------------------- the conversation
const sessions = chatState.slot('sales.session'); // chatId -> { stage, candidates, items, customer, intent, at }

// The customers we listed for a QUESTION ("pending of anuj" -> five Anujs),
// kept after the first pick. 13 Sep, live: "1." answered, then "2", a swiped
// "3." and "4." were read as quantities of the part discussed earlier and
// went into a cart. A desk going down a list picks more than once. Dropped
// the moment a message is not a pick.
const lastLists = chatState.slot('sales.lastList'); // chatId -> { candidates, about, intent, at }

// The last few customer lists shown for a question, so a number swiped onto
// an OLDER one still picks from it. 13 Sep, live: "1." swiped onto the Anuj
// list after other messages got a stale "Kaunsi gaadi?" answer instead.
const listHistory = chatState.slot('sales.lists'); // chatId -> { at, lists: [{ candidates, about, intent, at }] }
function rememberList(chatId, candidates, intent, about) {
  const h = listHistory.get(chatId) || { at: 0, lists: [] };
  h.lists.push({ candidates, about: about || null, intent, at: Date.now() });
  if (h.lists.length > 5) h.lists.splice(0, h.lists.length - 5);
  h.at = Date.now();
  listHistory.set(chatId, h);
}

// "Pending for anuj (Haryana)", "Pending of Anuj Kumar Ph-3 (HARYANA,
// Haryana)" - our own label typed back. Every word of the label must be in
// the message; of those, the fullest label wins.
function byLabel(text, rows) {
  const said = new Set(words(text));
  let best = null;
  let bestLen = 0;
  for (const r of rows || []) {
    const lw = words(label(r));
    if (lw.length < 2 || !lw.every((w) => said.has(w))) continue;
    if (lw.length > bestLen) {
      best = r;
      bestLen = lw.length;
    }
  }
  return best;
}

function sweep() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    const ttl = s.stage === 'active' ? ACTIVE_TTL_MS : CHOOSE_TTL_MS;
    if (now - s.at > ttl) sessions.delete(k);
  }
}
function session(chatId) {
  sweep();
  return sessions.get(chatId) || null;
}
function start(chatId, candidates, items, intent, about) {
  sessions.set(chatId, { stage: 'choose', candidates, items: items || null, intent: intent || 'order', about: about || null, at: Date.now() });
  if (intent && intent !== 'order') rememberList(chatId, candidates, intent, about);
}
async function choose(chatId, index) {
  const s = sessions.get(chatId);
  if (!s || s.stage !== 'choose') return null;
  const row = s.candidates[index];
  if (!row) return null;
  const customer = await enrich(ctxFor(row), row);
  sessions.set(chatId, { stage: 'active', customer, at: Date.now() });
  return { customer, items: s.items };
}
// The customer this salesman is ordering for right now, or null.
function activeCustomer(chatId) {
  const s = session(chatId);
  if (!s || s.stage !== 'active') return null;
  if (s.stage === 'active') {
    s.at = Date.now();
    sessions.save(); // changed in place
  }
  return s.customer;
}
function clear(chatId) {
  sessions.delete(chatId);
}

// "2" -> index 1; "haan" -> 0 when there is only one; "nahi" -> 'no'.
function readChoice(text, n) {
  const t = String(text || '').trim().toLowerCase();
  const num = t.match(/^(\d{1,2})[.)]?$/);
  if (num) {
    const k = Number(num[1]);
    return k >= 1 && k <= n ? k - 1 : null;
  }
  const said = require('./voiceOrder').readAnswer(t);
  if (said === 'yes' && n === 1) return 0;
  if (said === 'no') return 'no';
  return null;
}

// "1 ya 2", "1, 2 ya 3" — the way a person asks which one.
function oneOf(n, or) {
  const nums = Array.from({ length: n }, (_, i) => String(i + 1));
  return nums.length > 1 ? nums.slice(0, -1).join(', ') + ' ' + or + ' ' + nums[nums.length - 1] : nums[0];
}

// The draft to check, instead of a bare "Confirm sir?" — sir asked that the
// salesman sees the customer and every line before anything is punched.
function draftAsk(chatId, order, t) {
  const c = activeCustomer(chatId);
  if (!c || !order || !order.lines || !order.lines.length) return null;
  const orders = require('./orders');
  return t(
    'Draft for ' + c.name + ':\n' + orders.summary(order) + '\n\nAll good?',
    c.name + ' ka draft:\n' + orders.summary(order) + '\n\nSahi hai?',
  );
}

// Several parts for one customer in ONE answer: per part its name, stock,
// allocated and short, MRP, discount, rate incl. GST, line total and HSN; then
// one total with the taxable value and GST inside it, and how many are fully
// in stock. The same resolve the order path uses - commercial-analyze for the
// customer's account and the hyphen repair - so the numbers match the cart.
async function answerAboutMany(bot, m, row, about, reply, t) {
  const ctx = await enrich(ctxFor(row), row);
  store.log('sales', m.from + ' asked about ' + row.name + ' (analysis of ' + about.items.length + ' parts)');
  let lines = [];
  try {
    lines = await require('./availability').resolve(about.items.map((i) => ({ item: i.part, qty: i.qty })), ctx);
  } catch (e) {
    store.log('sales', 'analysis of ' + about.items.length + ' parts for ' + row.name + ' failed: ' + String((e && e.message) || e).slice(0, 110));
    return reply(t("I can't open the prices for " + row.name + ' right now.', row.name + ' ke rate abhi khul nahi rahe.'));
  }
  const known = lines.filter((l) => l.source !== 'unidentified');
  // Every part, so "punch this order" next means all of them.
  discussingMap.set(m.chatId, {
    ctx,
    at: Date.now(),
    part: known.length ? known[0].partNo || known[0].item : about.items[0].part,
    qty: known.length ? known[0].qty : about.items[0].qty,
    items: known.map((l) => ({ part: l.partNo || l.item, qty: l.qty })),
  });
  try { require('./focus').remember(m.chatId, known); } catch (_) {}

  const houses = [...new Set(lines.flatMap((l) => (l.vendors || []).map((v) => v.name)).filter(Boolean))];
  const out = [row.name + ' - ' + lines.length + ' parts' + (houses.length ? t(' from ' + houses.join(', '), ' - ' + houses.join(', ') + ' se') : '') + ':'];
  let gross = 0;
  let taxable = 0;
  let gst = 0;
  let priced = 0;
  let full = 0;
  // A part the portal does not have, with the catalogue numbers that begin
  // with it: a handwritten "71751M69R00" is 71751M69R005PK (13 Sep, live - 12
  // of 22 lines on the founder's list said only "not in the catalogue").
  const unknownAsked = lines
    .map((l, i) => (l.source === 'unidentified' ? (about.items[i] ? about.items[i].part : l.requested) : null))
    .filter(Boolean);
  const near =
    unknownAsked.length && bot && typeof bot.nearParts === 'function'
      ? await bot.nearParts(unknownAsked, { ctx, t, qtys: new Map(lines.map((l, i) => [about.items[i] ? about.items[i].part : l.requested, l.qty])) })
      : new Map();
  lines.forEach((l, i) => {
    const asked = about.items[i] ? about.items[i].part : l.requested;
    const pn = String(l.partNo || l.item || asked);
    const shown = pn.toUpperCase() + (asked && String(asked).toUpperCase() !== pn.toUpperCase() ? ' (' + asked + ')' : '');
    if (l.source === 'unidentified') {
      const close = near.get(asked);
      out.push(
        '',
        i + 1 + '. ' + asked + ' x' + l.qty + ' - ' +
          (close
            ? t('not in the catalogue; closest: ' + close.join(', '), 'catalogue mein nahi mila; milta-julta: ' + close.join(', '))
            : t('not in the catalogue', 'catalogue mein nahi mila')),
      );
      return;
    }
    const alloc = Number(l.available) || 0;
    const short = l.shortfall != null ? Number(l.shortfall) : Math.max(0, l.qty - alloc);
    if (!short) full++;
    const stock =
      l.source === 'unavailable'
        ? 'on order, ETA ' + config.onOrderEtaDays + t(' days', ' din')
        : short
          ? t(alloc + ' now, ' + short + ' on order', alloc + ' abhi, ' + short + ' on order')
          : t('in stock', 'stock mein') + (l.tatDays ? ', TAT ' + l.tatDays + t(' day', ' din') : '');
    const name = prettyPartName(l.partName);
    out.push('', i + 1 + '. ' + shown + ' x' + l.qty + (name ? ' · ' + name : ''));
    out.push('Allocated ' + alloc + ' · shortfall ' + short + ' · ' + stock);
    if (l.rate) {
      const g = Math.round(l.rate * l.qty * 100) / 100;
      gross += g;
      priced++;
      const s = gstSplit(g, l.taxPercent);
      if (s) {
        taxable += s.taxable;
        gst += s.gst;
      }
      out.push(
        'MRP ₹' + inr(l.mrp) + ' · ' + (l.discountPercent || 0) + '% off · ₹' + inr(l.rate) + '/pc incl. ' + (l.taxPercent ? l.taxPercent + '% ' : '') + 'GST · ₹' + inr(g) + (l.hsn ? ' · HSN ' + l.hsn : ''),
      );
    }
  });
  const r2 = (v) => Math.round(v * 100) / 100;
  out.push('');
  if (priced) out.push('Total ₹' + inr(r2(gross)) + (gst ? ' (taxable ₹' + inr(r2(taxable)) + ', GST ₹' + inr(r2(gst)) + ')' : ' incl. GST'));
  out.push(t(full + ' of ' + lines.length + ' fully in stock.', lines.length + ' mein se ' + full + ' poore stock mein.'));
  return reply(out.join('\n'));
}

// Several parts for one customer, in one answer - typed as a list (handle, step
// 2b-many) or read off a photo, a PDF or a sheet (analyseLines). false = no
// customer to answer for, and the caller decides what that means.
async function analyseMany(bot, m, many, reply, t) {
  if (!many.customer) {
    const d = discussingMap.get(m.chatId);
    if (d && Date.now() - d.at <= ACTIVE_TTL_MS && d.ctx && d.ctx.raw) return answerAboutMany(bot, m, d.ctx.raw, many, reply, t);
    return false;
  }
  let hits = { total: 0, top: [] };
  try {
    hits = await findCustomers(many.customer);
    if (!hits.total) hits = await findCustomersFuzzy(many.customer);
  } catch (e) {
    // Not "no such customer": the portal did not answer. 13 Sep, live: a 401
    // SESSION_INACTIVE was told to the founder as "No customer called lagan
    // motors found".
    many.searchFailed = true;
    store.log('sales', 'customer search failed: ' + String((e && e.message) || e).slice(0, 120));
  }
  if (many.place && hits.top.length > 1) {
    const pw = words(many.place);
    const here = hits.top.filter((r) => pw.every((w) => words(label(r)).includes(w)));
    if (here.length) hits = { total: here.length, top: here };
  }
  if (hits.top.length === 1) return answerAboutMany(bot, m, hits.top[0], many, reply, t);
  if (hits.top.length > 1) {
    start(m.chatId, hits.top, null, 'analysis', many);
    sessions.get(m.chatId).about = many;
    sessions.save(); // changed in place
    const rows = hits.top.map((r, i) => i + 1 + '. ' + label(r)).join('\n');
    return reply(t('Which one?\n' + rows, 'Kaunsa wala?\n' + rows));
  }
  return false;
}

// A photo, PDF or sheet from the desk with "analyse this for Kalra Motors"
// under it. 13 Sep, live, the founder: a photo of 30 parts captioned "analyze
// this order for kalra motors. I need all details." came back as a stock check
// on his own account, and a cart. "analysis vala saara kaam achhe se hona
// chahiye... jo poche jb pooche jiska pooche sb aana chahiye." The parts read
// off the file get the same analysis a typed list gets.
async function analyseLines(bot, m, lines, caption, reply, t) {
  if (!isSalesPerson(m.from) || !ANALYSIS_WORD.test(String(caption || ''))) return false;
  // The bare part number: vision sometimes gives "83401M82P11 REGULATOR ASSY,
  // FRONT WINDOW RH", and the analysis printed that whole string in brackets.
  const items = (lines || [])
    .map((l) => {
      const raw = String(l.partNo || l.item || '').trim();
      const pn = require('./ai').partNumberIn(raw) || raw;
      return { part: String(pn).toUpperCase(), qty: parseInt(l.qty, 10) > 0 ? parseInt(l.qty, 10) : 1 };
    })
    .filter((i) => i.part);
  if (!items.length) return false;
  // Kept like a typed list, so "Analysis this for Kalra Motors" next finds them.
  try {
    const q = chatState.slot('quotable');
    const row = q.get(m.chatId) || { at: 0, items: [] };
    row.items.push({ id: m.id || 'file-' + Date.now(), dir: 'customer', text: items.map((i) => i.part + ' ' + i.qty).join('\n').slice(0, 1500), at: Date.now() });
    if (row.items.length > 40) row.items.splice(0, row.items.length - 40);
    row.at = Date.now();
    q.set(m.chatId, row);
  } catch (_) {}
  const partish = require('./partish');
  const { name, place } = nameFrom(String(caption).replace(ANALYSIS_WORD, ' '));
  const customer = name && name.length >= 3 && !partish.isVehicle(name) ? name : null;
  const many = { customer, intent: 'analysis', items, many: true, place };
  store.log('sales', m.from + ' sent ' + items.length + ' part(s) in a file for analysis' + (customer ? ' for "' + customer + '"' : ''));
  if (await analyseMany(bot, m, many, reply, t)) return true;
  // The parts wait for the name. "lagan motors" on its own next is that name
  // (13 Sep, live: it was answered "part number bhej dijiye" instead, after the
  // bot had said the parts were kept).
  fileAnalysis.set(m.chatId, { items, at: Date.now() });
  return reply(
    many.searchFailed
      ? t(
          "I can't open the customer list right now - send the customer's name again in a minute (the " + items.length + ' parts are kept).',
          'Customer list abhi khul nahi rahi - ek minute mein customer ka naam dobara bhejiye (' + items.length + ' parts yaad hain).',
        )
      : customer
        ? t(
            'No customer called "' + customer + '" found. Send the name again (the ' + items.length + ' parts are kept).',
            '"' + customer + '" naam ka customer nahi mila. Naam dobara bhejiye (' + items.length + ' parts yaad hain).',
          )
        : t(
            'Which customer is the analysis of these ' + items.length + ' parts for?',
            'In ' + items.length + ' parts ka analysis kis customer ke liye hai?',
          ),
  );
}

// Parts from a file waiting for the customer's name, per chat.
const FILE_ANALYSIS_TTL_MS = 30 * 60 * 1000;
const fileAnalysis = chatState.slot('sales.fileAnalysis');

// The name, sent on its own after "kis customer ke liye?" / "nahi mila".
async function fileAnalysisName(bot, m, text, reply, t) {
  const waiting = fileAnalysis.get(m.chatId);
  if (!waiting) return false;
  if (Date.now() - waiting.at > FILE_ANALYSIS_TTL_MS) {
    fileAnalysis.delete(m.chatId);
    return false;
  }
  const partish = require('./partish');
  const line = String(text || '').trim();
  // A name: short, one line, no part number, not a yes/no or a question.
  if (!line || line.length > 60 || line.indexOf('\n') >= 0 || partish.partNumber(line) || /\?\s*$/.test(line)) return false;
  if (/^(ha+n?|hn|yes|ok+|nahi|nhi|no|cancel|rehne do)\b/i.test(line)) return false;
  const { name, place } = nameFrom(line.replace(ANALYSIS_WORD, ' '));
  if (!name || name.length < 3 || partish.isVehicle(name)) return false;
  const many = { customer: name, intent: 'analysis', items: waiting.items, many: true, place };
  store.log('sales', m.from + ' named "' + name + '" for the ' + waiting.items.length + ' parts from a file');
  if (await analyseMany(bot, m, many, reply, t)) {
    fileAnalysis.delete(m.chatId);
    return true;
  }
  waiting.at = Date.now();
  fileAnalysis.set(m.chatId, waiting);
  return reply(
    many.searchFailed
      ? t("I can't open the customer list right now - one more time in a minute?", 'Customer list abhi khul nahi rahi - ek minute mein dobara bhejiye?')
      : t('No customer called "' + name + '" found - check the name?', '"' + name + '" naam ka customer nahi mila - naam check kar lijiye?'),
  );
}

// The part and quantity just analysed for a customer become that customer's
// order, and the check comes back in one message. `quiet` keeps
// processOrderLines from sending its own "x10 - available" first: the check
// says all of that and more (13 Sep, live, it arrived as two messages).
async function punchAnalysed(bot, m, d, reply, t) {
  const orders = require('./orders');
  const c = d.ctx;
  const old = orders.findDraft(m.chatId);
  if (old && old.lines.length && !(old.portalCustomer && old.portalCustomer.buyerId === c.buyerId)) orders.cancel(old);
  sessions.set(m.chatId, { stage: 'active', customer: c, at: Date.now() });
  // Every part of a several-part analysis, or the one part.
  const items = d.items && d.items.length ? d.items : [{ part: d.part, qty: d.qty }];
  store.log('sales', m.from + ' is ordering the analysed ' + items.map((i) => i.part + ' x' + i.qty).join(', ') + ' for ' + c.name + ' (buyer ' + c.buyerId + ')');
  await bot.processOrderLines(m, items.map((i) => ({ item: i.part, qty: i.qty })), reply, null, { quiet: true });
  const order = orders.findDraft(m.chatId);
  if (!order || !order.lines.length) return true; // processOrderLines already said why
  order.confirmAskedAt = new Date().toISOString();
  store.save();
  return reply(precheck(order, c, t));
}

// The check before a punch, in one message: who, from which warehouse, each
// line at its rate, the total with GST, whether it is all in stock, and the
// question. Built from what commercial-analyze already put on the lines.
function precheck(order, c, t) {
  // Only what will be punched: in stock, at the quantity in stock (founder, 14
  // Sep: "punch avl item ka hi hoga"). 15:05 live, it listed a part with no
  // stock and ended "1 item poora stock mein nahi" - neither is said now.
  const ls = (order.lines || [])
    .filter((l) => l.source !== 'unidentified' && l.source !== 'unknown' && l.source !== 'unavailable' && (Number(l.available) || 0) > 0)
    .map((l) => ({ ...l, qty: Math.min(l.qty, Number(l.available) || 0) }));
  if (!ls.length) {
    return t('None of these is in stock right now - there is nothing to punch.', 'Inme se koi part abhi stock mein nahi hai - punch karne ko kuch nahi.');
  }
  const houses = [...new Set(ls.flatMap((l) => (l.vendors || []).map((v) => v.name)).filter(Boolean))];
  const interbranch = ls.some((l) => (l.vendors || []).some((v) => v.interbranch));
  let gross = 0;
  let taxable = 0;
  let gst = 0;
  let priced = true;
  const rows = ls.map((l, i) => {
    const head = i + 1 + '. ' + (l.partNo || l.item) + ' x' + l.qty;
    if (!l.rate) {
      priced = false;
      return head;
    }
    // The rate includes GST: the line total is what the bill says, and the
    // GST is inside it (see gstSplit).
    const n = Math.round(l.rate * l.qty * 100) / 100;
    gross += n;
    const s = gstSplit(n, l.taxPercent);
    if (s) {
      taxable += s.taxable;
      gst += s.gst;
    }
    return head + ' · ₹' + inr(l.rate) + '/pc' + (l.taxPercent ? ' incl. ' + l.taxPercent + '% GST' : ' incl. GST');
  });
  const r2 = (v) => Math.round(v * 100) / 100;
  const out = [
    t('Order for ' + c.name, c.name + ' ka order') + (houses.length ? t(' from ' + houses.join(', '), ' - ' + houses.join(', ') + ' se') : '') + ':',
    ...rows,
  ];
  if (priced && gross) out.push('Total ₹' + inr(r2(gross)) + (gst ? ' (taxable ₹' + inr(r2(taxable)) + ', GST ₹' + inr(r2(gst)) + ')' : ' incl. GST'));
  if (interbranch) out.push(t('Some from another branch.', 'Kuch doosri branch se.'));
  out.push(t('Shall I punch it?', 'Punch kar dun?'));
  return out.join('\n');
}

// Punching is switched off: say so plainly, and keep the draft.
function whenBlocked(chatId, order, t) {
  const c = activeCustomer(chatId);
  if (!c) return null;
  store.log('sales', 'SO for ' + c.name + ' not punched - ORDER_CONFIRM_ENABLED is off');
  return t(
    "Haven't punched the SO for " + c.name + " - we're still testing, nothing went to the portal.",
    c.name + ' ka SO punch nahi kiya - abhi testing chal rahi hai, portal pe kuch nahi gaya.',
  );
}

// Punched: the SO exists with do_status "pending", nothing allocated. The
// draft SO document goes out next (core/soReview) and the salesman's haan
// confirms it - the same check sir does on the portal, and the same one the
// customer now gets.
function afterPunch(chatId, result, t) {
  const s = session(chatId);
  if (!s || !s.customer || !result || !result.soNumber) return null;
  const c = s.customer;
  // He can keep ordering for this customer; the draft SO is the review's
  // business from here.
  sessions.set(chatId, { stage: 'active', customer: c, at: Date.now() });
  store.log('sales', 'SO ' + result.soNumber + ' punched for ' + c.name + ' - draft going out to be checked');
  // The WHOLE message for a salesman, not a tail on the customer's: that one
  // says "Order confirm ho gaya", which reads as a contradiction next to a
  // draft still waiting to be checked.
  const back = (result.backordered || []).map((l) => l.requested || l.item);
  const eta = ' (ETA = ' + config.onOrderEtaDays + ' days)';
  return t(
    'Punched SO *' + result.soNumber + '* for ' + c.name + '.' + (back.length ? '\n' + back.join(', ') + ' are on order' + eta + '.' : ''),
    c.name + ' ka SO *' + result.soNumber + '* punch ho gaya.' + (back.length ? '\n' + back.join(', ') + ' on order hain' + eta + '.' : ''),
  );
}

// Everything a salesman's message can mean here. true = answered; false = let
// the normal flow have it.
async function handle(bot, m, text, reply, t) {
  const orders = require('./orders');
  const s = session(m.chatId);

  // The second OK - "Sahi hai?" on the draft SO - is answered in
  // core/soReview, which confirms it and sends the confirmed document.

  // 1b. The customer's name for parts sent in a file, sent on its own.
  if (await fileAnalysisName(bot, m, text, reply, t)) return true;

  // 2. Picking the customer.
  if (s && s.stage === 'choose') {
    const pick = readChoice(text, s.candidates.length);
    if (pick === 'no') {
      clear(m.chatId);
      return reply(t("OK - tell me the customer's name again.", 'Theek hai, customer ka naam phir se bata dijiye.'));
    }
    if (typeof pick === 'number') {
      // The desk asked ABOUT this customer (orders, ledger, credit notes)
      // rather than ordering for them: answer, and close the picker.
      if (s.intent && s.intent !== 'order') {
        const row = s.candidates[pick];
        const about = s.about || null;
        lastLists.set(m.chatId, { candidates: s.candidates, about, intent: s.intent, at: Date.now() });
        clear(m.chatId);
        if (about) return about.many ? answerAboutMany(bot, m, row, about, reply, t) : answerAbout(bot, m, row, about, reply, t);
        store.log('sales', m.from + ' asked about ' + row.name + ' (' + s.intent + ')');
        return reply(await lookup.answer(row, s.intent, t));
      }
      const chosen = await choose(m.chatId, pick);
      const c = chosen.customer;
      // Parts gathered before the customer was picked belong to nobody: they
      // must not ride along into this customer's SO.
      const old = orders.findDraft(m.chatId);
      let dropped = 0;
      if (old && old.lines.length && !(old.portalCustomer && old.portalCustomer.buyerId === c.buyerId)) {
        dropped = old.lines.length;
        orders.cancel(old);
      }
      store.log(
        'sales',
        m.from + ' is ordering for ' + c.name + ' (buyer ' + c.buyerId + ')' + (dropped ? ', cleared ' + dropped + ' earlier line(s)' : ''),
      );
      const note = dropped ? t(' (cleared the earlier ' + dropped + ' item(s))', ' (pichhle ' + dropped + ' item hata diye)') : '';
      if (chosen.items) {
        const lines = require('./ai').parseLinesBlock(chosen.items) || [];
        if (lines.length) {
          return bot.processOrderLines(m, lines, reply, t('Draft for ' + c.name + note + ':', c.name + ' ka draft' + note + ':'));
        }
      }
      return reply(t('Got it - ' + c.name + note + '. Send the parts.', 'Theek hai, ' + c.name + note + '. Parts bataiye.'));
    }
    // Not an answer. A new "X ka SO" starts over; anything else gets the
    // question again. Never a fall-through: a stray "haan" here would reach
    // the order confirm and punch whatever cart was open.
    if (!parseOrderFor(text) && !lookup.parse(text)) {
      const n = s.candidates.length;
      return reply(t('Which customer first - ' + oneOf(n, 'or') + '?', 'Pehle ye bata dijiye kaunsa customer - ' + oneOf(n, 'ya') + '?'));
    }
  }

  // 2a0. A number swiped onto an OLDER customer list: the list it quotes, not
  //      whatever came after it.
  if (m.contextId && !(s && s.stage === 'choose')) {
    const quotedRows = (chatState.slot('quotable').get(m.chatId) || {}).items || [];
    const q = quotedRows.find((x) => x.id === m.contextId);
    if (q && /^(Which one\?|Kaunsa wala\?)/.test(String(q.text || '').trim())) {
      const h = listHistory.get(m.chatId);
      const entry =
        h &&
        [...h.lists]
          .reverse()
          .find((e) => Date.now() - e.at <= 60 * 60 * 1000 && e.candidates.length && e.candidates.every((r) => String(q.text).indexOf(r.name) >= 0));
      const pick = entry ? readChoice(text, entry.candidates.length) : null;
      if (entry && typeof pick === 'number') {
        const row = entry.candidates[pick];
        lastLists.set(m.chatId, { candidates: entry.candidates, about: entry.about, intent: entry.intent, at: Date.now() });
        store.log('sales', m.from + ' picked ' + row.name + ' from an older list (swiped)');
        if (entry.about) {
          return entry.about.many
            ? answerAboutMany(bot, m, row, { ...entry.about, customer: row.name }, reply, t)
            : answerAbout(bot, m, row, { ...entry.about, customer: row.name }, reply, t);
        }
        return reply(await lookup.answer(row, entry.intent, t));
      }
    }
  }

  // 2a. Another pick from the list already shown for a question: "2", a
  //     swiped "3.", or the label itself. Checked before anything reads a
  //     bare number as a quantity.
  const ll = lastLists.get(m.chatId);
  if (ll && !(s && s.stage === 'choose')) {
    let row = null;
    if (Date.now() - ll.at <= CHOOSE_TTL_MS) {
      const pick = readChoice(text, ll.candidates.length);
      row = typeof pick === 'number' ? ll.candidates[pick] : byLabel(text, ll.candidates);
    }
    if (row) {
      lastLists.set(m.chatId, { ...ll, at: Date.now() });
      store.log('sales', m.from + ' picked ' + row.name + ' from the list again (' + ll.intent + ')');
      if (ll.about) {
        return ll.about.many
          ? answerAboutMany(bot, m, row, { ...ll.about, customer: row.name }, reply, t)
          : answerAbout(bot, m, row, { ...ll.about, customer: row.name }, reply, t);
      }
      return reply(await lookup.answer(row, ll.intent, t));
    }
    lastLists.delete(m.chatId);
  }

  // 1c. Several questions, one per line: "pending of Libra Motors" and
  //     "pending of Bhagwati Motors" in one message. 13 Sep, live: only the
  //     first line was ever read as a question, the message fell through, and
  //     the founder got Kalra Motors' order list - the customer discussed
  //     earlier. Each line is answered on its own, in order; a line that needs
  //     a pick ("Which one?") stops there.
  {
    const qLines = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (qLines.length >= 2 && qLines.length <= 6 && !itemsAndRest(text).items.length) {
      const asks = qLines.every((x) => (parseAbout(x) && parseAbout(x).customer) || lookup.parse(x) || parseAnalysisAsk(x));
      if (asks) {
        store.log('sales', m.from + ' asked ' + qLines.length + ' questions in one message');
        for (const x of qLines) {
          await handle(bot, { ...m, body: x, contextId: null }, x, reply, t);
          const now = session(m.chatId);
          if (now && now.stage === 'choose') break;
        }
        return true;
      }
    }
  }

  // 1d. The part number asked for: "discount depends on the part - send me a
  //     part number", and then just "83401M82P11".
  {
    const d = discussingMap.get(m.chatId);
    const line = String(text || '').trim();
    const partishP = require('./partish');
    const lone = line.indexOf('\n') < 0 && line.split(/\s+/).length <= 3 ? partishP.partNumber(line) : null;
    if (d && d.awaitPart && lone && Date.now() - d.at <= CHOOSE_TTL_MS && d.ctx && d.ctx.raw) {
      const q = (line.match(/(?:^|\s)(\d{1,4})\s*(?:pcs?|pieces?|nos?|pise)?$/i) || [])[1];
      store.log('sales', m.from + ' sent ' + lone + ' for ' + d.ctx.name + "'s " + d.awaitPart);
      return answerAbout(bot, m, d.ctx.raw, { intent: d.awaitPart, part: lone, qty: q ? parseInt(q, 10) : 1, customer: d.ctx.name }, reply, t);
    }
  }

  // "486 ka bill" - the portal own invoice PDF for one order.
  // Desk lookups (founder, 14 Sep): where an order is, its challan, bill made
  // or not, the shortage list, one part's history, goods coming in. Before
  // "486 ka bill", which sends the bill PDF: "639 ka bill bana?" asks a question.
  let desk = lookup.parseDesk(text);
  // Not one of the known phrasings, but it sounds like one: the model sorts it
  // (only when a desk word is in it, and only with a number that is really there).
  if (!desk && !parseOrderFor(text) && !lookup.parse(text)) desk = await lookup.classifyDesk(text);
  if (desk) {
    store.log('sales', m.from + ' desk lookup: ' + desk.kind + ' ' + (desk.orderId || desk.part || desk.name || ''));
    if (desk.kind === 'challan') {
      const portal = require('../integrations/dealerPortal');
      let pdf = null;
      try {
        pdf = await portal.challanPdf(desk.orderId);
      } catch (_) {}
      const tr = bot && bot.transport;
      if (pdf && tr && typeof tr.sendDocument === 'function') {
        await tr.sendDocument(m.chatId, pdf, 'Challan ' + desk.orderId + '.pdf', 'application/pdf', 'Challan ' + desk.orderId);
        return true;
      }
      return reply(t('No delivery challan for order ' + desk.orderId + ' yet.', 'Order ' + desk.orderId + ' ka challan abhi nahi bana.'));
    }
    if (desk.kind === 'track') return reply(await lookup.trackText(desk.orderId, t));
    if (desk.kind === 'billStatus') return reply(await lookup.invoiceStatusText(desk.orderId, t));
    if (desk.kind === 'shortage') return reply(await lookup.shortageText(desk.name, t));
    if (desk.kind === 'partStatus') return reply(await lookup.partStatusText(desk.part, t));
    if (desk.kind === 'incoming') return reply(await lookup.incomingText(t));
  }

  const bill = lookup.parseBill(text);
  if (bill) return lookup.sendBill(bot, m, bill.orderId, reply, t);

  // "detail of order 686" / "order 686" - that order, from the portal.
  const orderNo = lookup.parseOrderDetail(text);
  if (orderNo) {
    store.log('sales', m.from + ' asked about order ' + orderNo.orderId);
    return reply(await lookup.orderDetail(orderNo.orderId, t));
  }

  // 2b. The same questions as people actually type them, in English or with
  //     the name anywhere: "kalra motor give me pending", "16510M65L10 10 pcs
  //     for kalra motors". Only when the portal has an account by that name.
  // An order request ("Anuj ka SO: 13780M68P01 5") is not a question, even
  // though it names a customer and a part.
  // 2b0. "Detail analysis for kalra motors" - analysis asked for a named
  //      customer, with the parts in an earlier message (or the one swiped).
  const analysisAsk = lookup.parse(text) || parseOrderFor(text) ? null : parseAnalysisAsk(text);
  if (analysisAsk) {
    let hits = { total: 0, top: [] };
    try {
      hits = await findCustomers(analysisAsk.customer);
      if (!hits.total) hits = await findCustomersFuzzy(analysisAsk.customer);
    } catch (e) {
      store.log('sales', 'customer search failed: ' + String((e && e.message) || e).slice(0, 120));
    }
    if (analysisAsk.place && hits.top.length > 1) {
      const pw = words(analysisAsk.place);
      const here = hits.top.filter((r) => pw.every((w) => words(label(r)).includes(w)));
      if (here.length) hits = { total: here.length, top: here };
    }
    if (hits.top.length) {
      const items = recentItems(m.chatId, m.contextId);
      if (!items.length) {
        return reply(
          t(
            "Which parts should I analyse? Send the part numbers, one per line, with the customer's name.",
            'Kin parts ki analysis chahiye? Part number bhej dijiye - har part nayi line mein - customer ke naam ke saath.',
          ),
        );
      }
      const about =
        items.length > 1
          ? { intent: 'analysis', items, many: true, full: true }
          : { intent: 'analysis', part: items[0].part, qty: items[0].qty, full: true };
      store.log('sales', m.from + ' asked for an analysis of ' + items.length + ' earlier part(s) for "' + analysisAsk.customer + '"');
      if (hits.top.length > 1) {
        start(m.chatId, hits.top, null, 'analysis', about);
        const rows = hits.top.map((r, i) => i + 1 + '. ' + label(r)).join('\n');
        return reply(t('Which one?\n' + rows, 'Kaunsa wala?\n' + rows));
      }
      const row = hits.top[0];
      return about.many
        ? answerAboutMany(bot, m, row, { ...about, customer: row.name }, reply, t)
        : answerAbout(bot, m, row, { ...about, customer: row.name }, reply, t);
    }
    // No customer by that name: say so, rather than passing it to a person.
    return reply(
      t(
        'No customer called "' + analysisAsk.customer + '" - can you give me a bit more of the name?',
        '"' + analysisAsk.customer + '" naam se koi customer nahi mila - naam thoda aur bataiye?',
      ),
    );
  }

  // 2b1. "Analysis this" - the analysis word, no name, no part: the parts
  //      swiped onto (or just sent), for the customer being discussed; with
  //      nobody discussed, ask who it is for. 13 Sep, live: "Sorry, didn't get
  //      that".
  if (ANALYSIS_WORD.test(text) && text.length <= 60 && text.indexOf('\n') < 0 && !ABOUT_INTENT.some(([, re]) => re.test(text)) && !lookup.parse(text) && !parseOrderFor(text)) {
    const partishA = require('./partish');
    const { groupedPart } = require('./availability');
    const hasPart = text.split(/\s+/).some((w) => partishA.isPartNumber(w) || groupedPart(w) || /^\d{7,13}$/.test(w));
    if (!hasPart && !nameFrom(text).name) {
      const items = recentItems(m.chatId, m.contextId);
      if (items.length) {
        const d = discussingMap.get(m.chatId);
        if (d && Date.now() - d.at <= ACTIVE_TTL_MS && d.ctx && d.ctx.raw) {
          const about =
            items.length > 1
              ? { intent: 'analysis', items, many: true, full: true, customer: d.ctx.name }
              : { intent: 'analysis', part: items[0].part, qty: items[0].qty, full: true, customer: d.ctx.name };
          store.log('sales', m.from + ' asked for an analysis of ' + items.length + ' part(s) for ' + d.ctx.name + ' (being discussed)');
          return about.many ? answerAboutMany(bot, m, d.ctx.raw, about, reply, t) : answerAbout(bot, m, d.ctx.raw, about, reply, t);
        }
        return reply(
          t(
            'For which customer? Send it with the name - like "analysis for Kalra Motors".',
            'Kis customer ke liye? Naam ke saath bhej dijiye - jaise "analysis for Kalra Motors".',
          ),
        );
      }
    }
  }

  // 2b-many. Several parts for one customer, in one answer. Checked first: a
  //     one-line list would otherwise be read as a question about its first
  //     part only.
  const many = lookup.parse(text) || parseOrderFor(text) ? null : parseAboutMany(text);
  // No such customer: the parts are still a stock question, and the rest of
  // the bot answers that.
  if (many && (await analyseMany(bot, m, many, reply, t))) return true;

  const eng = lookup.parse(text) || parseOrderFor(text) ? null : parseAbout(text);
  // No name in it: about the customer just discussed, for the part and
  // quantity just priced unless this message names others. Nobody being
  // discussed - the rest of the bot answers it, as before.
  if (eng && !eng.customer) {
    const d = discussingMap.get(m.chatId);
    const fresh = d && Date.now() - d.at <= ACTIVE_TTL_MS && d.ctx && d.ctx.raw ? d : null;
    if (!fresh) return false;
    const part = eng.part || fresh.part || null;
    const qty = eng.part ? eng.qty : fresh.qty || eng.qty || 1;
    const intent = eng.intent === 'discount' && part && eng.full ? 'analysis' : eng.intent;
    store.log('sales', m.from + ' follow-up about ' + fresh.ctx.name + ' (' + intent + (part ? ' ' + part + ' x' + qty : '') + ')');
    return answerAbout(
      bot,
      m,
      fresh.ctx.raw,
      { ...eng, customer: fresh.ctx.name, intent, part, qty, lead: eng.intent === 'discount' ? 'discount' : null },
      reply,
      t,
    );
  }
  if (eng) {
    let found = { total: 0, top: [] };
    let failed = false;
    try {
      found = await findCustomers(eng.customer);
      if (!found.total) found = await findCustomersFuzzy(eng.customer);
    } catch (e) {
      failed = true;
      store.log('sales', 'customer search failed: ' + String((e && e.message) || e).slice(0, 120));
    }
    // Several by that name, and a place in brackets: the place decides.
    if (eng.place && found.top.length > 1) {
      const pw = words(eng.place);
      const here = found.top.filter((r) => pw.every((w) => words(label(r)).includes(w)));
      if (here.length) found = { total: here.length, top: here };
    }
    if (found.top.length === 1) return answerAbout(bot, m, found.top[0], eng, reply, t);
    if (found.top.length > 1) {
      start(m.chatId, found.top, null, eng.intent, eng);
      sessions.get(m.chatId).about = eng;
      sessions.save(); // changed in place
      const rows = found.top.map((r, i) => i + 1 + '. ' + label(r)).join('\n');
      return reply(t('Which one?\n' + rows, 'Kaunsa wala?\n' + rows));
    }
    // No account by that name. With a part in it, it is still a stock
    // question and the rest of the bot answers it. Without one ("Kalara
    // mortor discount") it can only be about a customer - it must not be
    // looked up as a part.
    if (!eng.part) {
      if (failed) {
        return reply(t("I can't open the customer list right now - try again in a minute?", 'Customer list abhi khul nahi rahi - ek minute mein phir poochhiye?'));
      }
      return reply(
        t(
          'No customer called "' + eng.customer + '" - can you give me a bit more of the name?',
          '"' + eng.customer + '" naam se koi customer nahi mila - naam thoda aur bataiye?',
        ),
      );
    }
  }

  // 3. "Kalra ka order kab aayega" / "... ka ledger" / "... ke credit note".
  // Asked BEFORE the order trigger: these are questions ABOUT a customer,
  // not an order for them. Until now the bot answered them with the
  // salesman's own draft, because it read the question as his order.
  const about = lookup.parse(text);
  if (about) {
    let match;
    try {
      match = await findCustomers(about.customer);
    } catch (e) {
      store.log('sales', 'customer search failed: ' + String((e && e.message) || e).slice(0, 140));
      return reply(
        t(
          "I can't open the customer list right now - try again in a minute?",
          'Customer list abhi khul nahi rahi - ek minute mein phir poochhiye?',
        ),
      );
    }
    if (!match.total) {
      return reply(
        t(
          'No customer called "' + about.customer + '" - can you give me a bit more of the name?',
          '"' + about.customer + '" naam se koi customer nahi mila - naam thoda aur bataiye?',
        ),
      );
    }
    if (match.top.length === 1) {
      store.log('sales', m.from + ' asked about ' + match.top[0].name + ' (' + about.intent + ')');
      return reply(await lookup.answer(match.top[0], about.intent, t));
    }
    start(m.chatId, match.top, null, about.intent);
    const rows = match.top.map((r, i) => i + 1 + '. ' + label(r)).join('\n');
    return reply(t('Which one?\n' + rows, 'Kaunsa wala?\n' + rows));
  }

  // 4a. "punch this order", "ye order punch kr do" - no name. The cart already
  // built for the customer being ordered for, or else the part just analysed
  // for the customer just discussed. Never left to the chat model: on 13 Sep,
  // live, it made up "We're still testing, so I haven't punched Lagan
  // Motors's SO" with nothing drafted at all.
  if (PUNCH_THIS.test(text)) {
    const active = activeCustomer(m.chatId);
    const cart = orders.findDraft(m.chatId);
    if (active && cart && cart.lines.length) {
      // Already asked, and this is worded as a yes ("order laga do"): the
      // normal confirm path punches it.
      if (cart.confirmAskedAt && require('./ai').CONFIRM_RE.test(text)) return false;
      cart.confirmAskedAt = new Date().toISOString();
      store.save();
      return reply(precheck(cart, active, t));
    }
    const d = discussingMap.get(m.chatId);
    if (d && d.part && d.ctx && Date.now() - d.at <= ACTIVE_TTL_MS) return punchAnalysed(bot, m, d, reply, t);
    return reply(
      t(
        'Which customer is the order for? Send it with the name - like "punch this order for Kalra Motors".',
        'Order kis customer ka hai? Naam ke saath bhej dijiye - jaise "Kalra Motors ka order punch kar do".',
      ),
    );
  }

  // 4. "X ka SO bana do".
  const req = parseOrderFor(text);
  if (!req) return false;
  let found;
  try {
    found = await findCustomers(req.customer);
  } catch (e) {
    store.log('sales', 'customer search failed: ' + String((e && e.message) || e).slice(0, 140));
    if (req.weak) return false;
    return reply(t("I can't open the customer list right now - try again in a minute?", 'Customer list abhi khul nahi rahi - ek minute mein phir bhejiye?'));
  }
  if (!found.total) {
    if (req.weak) return false;
    return reply(
      t(
        "Couldn't find a customer called \"" + req.customer + '" - can you give me a bit more of the name?',
        '"' + req.customer + '" naam se koi customer nahi mila - naam thoda aur bataiye?',
      ),
    );
  }
  // "punch this order for Kalra Motors" right after an analysis for Kalra
  // Motors: the order IS that analysis - the part and quantity just priced,
  // for the customer already picked by it. One check comes back before
  // anything is punched, and the yes to it goes through the normal confirm.
  const d = discussingMap.get(m.chatId);
  if (!req.items && d && d.part && d.ctx && Date.now() - d.at <= ACTIVE_TTL_MS && /\b(this|that|ye|yeh|wahi|same|isko|iska)\b/i.test(text)) {
    const same = found.top.find((r) => r.id === d.ctx.buyerId);
    if (same) return punchAnalysed(bot, m, d, reply, t);
  }

  start(m.chatId, found.top, req.items);
  store.log('sales', m.from + ' asked to order for "' + req.customer + '": ' + found.total + ' match(es)');
  if (found.top.length === 1) {
    return reply(t(label(found.top[0]) + ' - this one?', label(found.top[0]) + ' - yahi wale?'));
  }
  const listed = found.top.map((r, i) => i + 1 + '. ' + label(r)).join('\n');
  const more =
    found.total > found.top.length
      ? t('\n...and a few more - give me a bit more of the name.', '\n...aur bhi hain, thoda poora naam bata dijiye.')
      : '';
  return reply(t('Which one?\n' + listed + more, 'Kaunsa wala?\n' + listed + more));
}

// Tests only.
function _resetDirectory() {
  sessions.clear();
  discussingMap.clear();
  lastLists.clear();
}

module.exports = {
  isSalesPerson,
  parseOrderFor,
  findCustomers,
  match,
  label,
  activeCustomer,
  discussing,
  parseAbout,
  prettyPartName,
  precheck,
  analyseLines,
  session,
  clear,
  readChoice,
  draftAsk,
  whenBlocked,
  afterPunch,
  handle,
  _resetDirectory,
};
