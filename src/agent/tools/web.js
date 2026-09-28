'use strict';
// THE OPEN WEB — for finding a part NUMBER, and nothing else.
//
// When a customer describes a part we cannot place — "Brezza 2019 ka cabin
// filter", a photo of a box with a worn label — the number often exists on
// Maruti's own site, on a parts catalogue, in a forum. Finding it there turns
// a question for Prateek sir into a portal lookup.
//
// THE WEB IS A LEAD, NEVER AN ANSWER.
//
// A price on a website is somebody else's price, in somebody else's city,
// possibly for a different market or a superseded part. Stock on a website is
// meaningless to us. So this tool returns part NUMBERS and source names, and
// the money is stripped out of what it returns before the model ever sees it
// — the rule is enforced here, in code, not asked for in the prompt. Whatever
// comes back still has to survive check_stock_and_price.
//
// Search grounding runs through Gemini with the key the bot already has, so
// there is no second vendor and no second bill.
const { tool } = require('langchain');
const { z } = require('zod');

const config = require('../../config');
const store = require('../../store');
const partish = require('../../core/partish');

// Three attempts, each asking differently, because the first phrasing is
// often the customer's own and the web does not speak it. The tool does all
// three by itself so the model cannot turn a miss into six slow retries.
const MAX_ATTEMPTS = 3;

// Boodmo lists most Indian-market OEM parts with the maker's own number
// (founder, 28 Sep: "check the product on boodmo"), so it is asked second -
// after the maker's own wording, before the open web.
function queriesFor(phrase, vehicle) {
  const what = String(phrase || '').trim();
  const car = String(vehicle || '').trim();
  const base = car ? car + ' ' + what : what;
  return [
    'Maruti Suzuki genuine part number for ' + base,
    'boodmo.com ' + base + ' OEM part number',
    base + ' OEM part number India',
  ];
}

// A number AS OUR PORTAL STORES IT: capitals, no dashes or spaces.
// "16510-M68K00" on a website is 16510M68K00 on the portal.
function asStored(partNo) {
  return String(partNo || '').toUpperCase().replace(/[\s\-./]/g, '');
}

// MONEY GOES. PART NUMBERS AND SIZES STAY.
//
// The first version of this stripped anything that looked like a figure and
// ate part numbers doing it: "Rs.450 for part 13780M68P01" came out as
// "[price removed]M68P01", destroying the one thing the tool exists to find.
//
// So part numbers are masked out of the way FIRST, then money is removed,
// then they are put back. Sizes and years survive on purpose — "16 inch" and
// "2018 model" are how a customer identifies a part, and a bot that cannot
// repeat them cannot ask "the 16 inch one?".
const MONEY = [
  // a currency marker with a number after it
  /(?:₹|Rs\.?|INR|USD|\$)\s*[\d,]+(?:\.\d+)?/gi,
  // a number with a currency word after it
  /\b[\d,]+(?:\.\d+)?\s*(?:rupees|rs\.?|inr|dollars)\b/gi,
];

// "price is 450", "MRP: 799", "costs around 1,299" — the WORD is kept so the
// sentence still reads; only the figure goes.
// The gap is generous — "the price of this filter is 350" puts eighteen
// characters between the word and the figure — and it is safe to be generous
// because part numbers are already masked and cannot be swallowed by it.
const PRICED_WORD = /\b(price|cost|costs|mrp|rate|priced)\b([^.\n]{0,25}?)\b[\d,]+(?:\.\d+)?\b/gi;

// A part number, for masking: a token carrying BOTH a letter and a digit.
const PART_LIKE = /\b(?=[A-Za-z0-9\-/]*[A-Za-z])(?=[A-Za-z0-9\-/]*[0-9])[A-Za-z0-9][A-Za-z0-9\-/]{3,}\b/g;

// The placeholder has to be something no web page and none of the rules above
// can match, so it is wrapped in a control character rather than anything
// printable — a "[[0]]" style marker would itself be chewed up by the money
// rules.
//
// And it carries NO DIGITS. The obvious placeholder, MARK + the index, put a
// number back into the text: "Price is Rs.450 for part 13780M68P01" masked
// the part number to "\x01 0 \x01", and the priced-word rule then reached
// past "for part" and removed the mask itself, part number and all. So the
// index is written in letters, where no rule that hunts figures can find it.
const MARK = String.fromCharCode(1);
const UNMASK = new RegExp(MARK + '([a-j]+)' + MARK, 'g');
const inLetters = (n) => String(n).replace(/\d/g, (d) => String.fromCharCode(97 + Number(d)));
const fromLetters = (s) => Number(s.replace(/[a-j]/g, (c) => String(c.charCodeAt(0) - 97)));

function stripFigures(text) {
  const held = [];
  let masked = String(text || '').replace(PART_LIKE, (m) => {
    held.push(m);
    return MARK + inLetters(held.length - 1) + MARK;
  });

  for (const re of MONEY) masked = masked.replace(re, '[price removed]');
  masked = masked.replace(PRICED_WORD, (_m, word, gap) => word + gap + '[removed]');

  return masked.replace(UNMASK, (_m, i) => held[fromLetters(i)]);
}

// Part numbers out of free text. partish.isPartNumber is the same rule the
// rest of the bot uses to decide whether a token IS a part number, so a
// number this returns is one the portal can actually be asked about.
function partNumbersIn(text) {
  const out = [];
  const seen = new Set();
  for (const tok of String(text || '').match(/\b[A-Za-z0-9][A-Za-z0-9\-/]{4,}\b/g) || []) {
    const clean = tok.replace(/[.,;:]+$/, '');
    if (!partish.isPartNumber(clean)) continue;
    const k = clean.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(asStored(clean));
    if (out.length >= 6) break;
  }
  return out;
}

// `image` ({ base64, mime }) goes with the question, so the model searches
// for what it SEES - the photo of a part with no number on it.
async function askGoogle(query, image) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(config.agent.webSearchModel) +
    ':generateContent?key=' +
    encodeURIComponent(config.gemini.apiKey);

  const parts = [];
  if (image && image.base64) parts.push({ inline_data: { mime_type: image.mime || 'image/jpeg', data: image.base64 } });
  parts.push({
    text:
      query +
      '\n\nAnswer with the manufacturer part number or numbers only, and say which variant each belongs to if they differ. ' +
      'Do not give any price. If you cannot find a part number, say exactly: NOT FOUND.',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(config.agent.webSearchTimeoutMs),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const j = await res.json();
  const cand = (j.candidates || [])[0];
  if (!cand) return { text: '', sources: [] };
  const text = (cand.content && cand.content.parts ? cand.content.parts : []).map((p) => p.text || '').join('');
  const chunks = ((cand.groundingMetadata || {}).groundingChunks || []).slice(0, 4);
  const sources = chunks.map((c) => (c.web && (c.web.title || c.web.uri)) || '').filter(Boolean);
  return { text, sources };
}

const searchTheWeb = tool(
  async ({ description, vehicle }) => {
    const what = String(description || '').trim();
    if (!what) return JSON.stringify({ found: false, why: 'nothing to search for' });
    if (!config.gemini || !config.gemini.apiKey) {
      return JSON.stringify({ found: false, why: 'web search is not configured', askAPerson: true });
    }

    const tried = [];
    for (const query of queriesFor(what, vehicle).slice(0, MAX_ATTEMPTS)) {
      tried.push(query);
      let got = null;
      try {
        got = await askGoogle(query);
      } catch (e) {
        store.log('agent', 'web search failed: ' + String((e && e.message) || e).slice(0, 80));
        continue;
      }
      const safe = stripFigures(got.text);
      const candidates = partNumbersIn(safe);
      if (!candidates.length) continue;

      store.log('agent', `web search "${what.slice(0, 40)}" -> ${candidates.join(', ')} (attempt ${tried.length})`);
      return JSON.stringify({
        found: true,
        // LEADS. Not answers. Each one still has to be confirmed by the
        // portal before a single word of it reaches the customer.
        candidatePartNumbers: candidates,
        // Money is already stripped, so there is no price in here to repeat.
        whatTheWebSaid: safe.slice(0, 400),
        sources: got.sources,
        attempts: tried.length,
        nextStep:
          'These are UNCONFIRMED leads from websites, not our stock. Call check_stock_and_price on them. ' +
          'Only a part the portal confirms may be mentioned to the customer, and only the portal price. ' +
          'If the portal does not recognise any of them, call ask_a_person.',
      });
    }

    store.log('agent', `web search "${what.slice(0, 40)}" found nothing in ${tried.length} attempt(s)`);
    return JSON.stringify({
      found: false,
      attempts: tried.length,
      why: 'nothing on the web gave a usable part number',
      askAPerson: true,
    });
  },
  {
    name: 'search_the_web',
    description:
      'Search the open web for a part NUMBER when our own sources have all failed. Use it after lookup_known_part, search_catalogue_index and search_portal_catalogue have each returned "none" — and before ask_a_person, so a colleague is only disturbed when the web cannot help either. ' +
      'Good for a part the customer can only describe ("Brezza 2019 ka cabin filter") or one read off a photo. It tries up to three different phrasings by itself, so call it ONCE and do not retry it. ' +
      'It returns candidate part numbers ONLY. It never returns a price, and there is never a price to repeat: whatever it finds is an unconfirmed lead from a website, possibly for another market or a superseded part. ' +
      'Always put the candidates through check_stock_and_price, and tell the customer only what the portal confirms.',
    schema: z.object({
      description: z.string().describe('what the customer is after, in their words or as read off their photo'),
      vehicle: z.string().optional().describe('the car and year if they mentioned one, e.g. "Swift 2018 petrol"'),
    }),
  },
);

// THE PHOTO OF A PART THE PORTAL DOES NOT KNOW (founder, 28 Sep: "when
// customer send photo of any product which bot not able to search on portal
// then it web search the product and try to find part no like we store / or
// check the product on boodmo").
//
// The photo itself goes to the search, not a description of it: a model
// looking at a wiper blade or a filter it cannot read a number off still
// knows what it is and, with the web, what it is sold as. Same rules as
// search_the_web - part numbers only, money stripped here, every one still to
// be confirmed by the portal.
function photoQueries(hint, vehicle) {
  const extra = [String(vehicle || '').trim(), String(hint || '').trim()].filter(Boolean).join(', ');
  const about = extra ? ' The customer says: ' + extra + '.' : '';
  return [
    'This is a photo of a car spare part sent by a customer in India.' + about +
      ' Identify the part (what it is, which car it fits, brand if visible) and find its OEM part number, looking on boodmo.com first.',
    'Find this car part on boodmo.com or the car maker\'s parts catalogue and give its OEM part number.' + about,
  ];
}

const identifyPartFromPhoto = tool(
  async ({ hint, vehicle }, cfg) => {
    const ctx = require('../context').contextFrom(cfg);
    const photo = ctx.chatId ? require('../incoming').heldPhoto(ctx.chatId) : null;
    if (!photo) return JSON.stringify({ found: false, why: 'there is no recent photo in this chat' });
    if (!config.gemini || !config.gemini.apiKey) {
      return JSON.stringify({ found: false, why: 'web search is not configured', askAPerson: true });
    }
    let tries = 0;
    for (const query of photoQueries(hint, vehicle)) {
      tries++;
      let got = null;
      try {
        got = await askGoogle(query, photo);
      } catch (e) {
        store.log('agent', 'photo web search failed: ' + String((e && e.message) || e).slice(0, 80));
        continue;
      }
      const safe = stripFigures(got.text);
      const candidates = partNumbersIn(safe);
      if (!candidates.length) continue;
      store.log('agent', `photo web search -> ${candidates.join(', ')} (attempt ${tries}${got.sources.length ? ', ' + got.sources.slice(0, 2).join(' / ') : ''})`);
      return JSON.stringify({
        found: true,
        // In the portal's own form (no dashes, capitals).
        candidatePartNumbers: candidates,
        whatThePartIs: safe.slice(0, 300),
        sources: got.sources,
        nextStep:
          'UNCONFIRMED leads from the web for the part in the photo. Call check_stock_and_price on them. ' +
          'Only a part the portal confirms may be mentioned, at the portal price. If none is confirmed, call ask_a_person (the photo goes with it) and pass these as webCandidates.',
      });
    }
    store.log('agent', `photo web search found no part number in ${tries} attempt(s)`);
    return JSON.stringify({ found: false, attempts: tries, why: 'the web did not give a part number for this photo', askAPerson: true });
  },
  {
    name: 'identify_part_from_photo',
    description:
      'Find the part number of the part in the customer\'s PHOTO by searching the web with the photo itself (Boodmo first, then the maker\'s catalogue). ' +
      'Use it when a photo shows a part but no part number can be read off it, or the numbers read off it are not on the portal - after our own lookups found nothing and before ask_a_person. Call it ONCE. ' +
      'It returns candidate part numbers in the portal\'s form and never a price; put them through check_stock_and_price and say only what the portal confirms.',
    schema: z.object({
      hint: z.string().optional().describe('anything the customer said about the photo, e.g. "iska rate" or "front wiper"'),
      vehicle: z.string().optional().describe('the car and year if known, e.g. "Swift 2018 petrol"'),
    }),
  },
);

module.exports = { searchTheWeb, identifyPartFromPhoto, _internals: { stripFigures, partNumbersIn, queriesFor, photoQueries, asStored, askGoogle } };
