'use strict';
// Reading an exported WhatsApp chat.
//
// The export is a text file, one message per line, except when it is not: a
// message with newlines in it continues on the following lines with no
// timestamp, and 635 of the 3,641 lines in the supplied exports are those
// continuations. Losing them truncates exactly the long messages worth
// reading.
//
// Format found in the 16 Cartrends exports (23 Sep):
//   [6/23/26, 3:10:24 PM] +91 85959 55156: @Rahul ... confirm MRP of OX1085?
//   [6/23/26, 3:13:57 PM] Rahul Sinha - Warehouse - Cartrend: 499
//   [7/13/26, 10:49:02 AM] - [System notification]
//   [7/24/26, 4:37:42 PM] - You added Bhawna - CRM - Cartrend
const config = require('../../config');

// A dash instead of "sender:" is WhatsApp talking, not a person.
const SYSTEM = /^\[[^\]]+\]\s*-\s/;
const HEADER =
  /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]\s*([^:]{1,80}?):\s*([\s\S]*)$/;

const MEDIA = /<(?:image|video|document|audio|sticker|GIF|Media)\s*omitted>/i;

// Lines that are not conversation at all. Every one of these appeared in the
// supplied exports and, left in, becomes a "customer question" with an
// "answer" that has nothing to do with it.
const NOT_CONVERSATION = [
  /^Messages and calls are end-to-end encrypted/i,
  /^This message was deleted$/i,
  /^You deleted this message$/i,
  /^Waiting for this message/i,
  /^Thank you for your message\. We're unavailable right now/i,
  /^<This message was edited>$/i,
  /^null$/i,
];

function isNoise(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return NOT_CONVERSATION.some((re) => re.test(t));
}

// Who is Cartrends and who is the dealer?
//
// The exports carry NO phone number for saved contacts — only display names —
// so a phone-number list alone would identify nobody. What they do carry is
// the company in the name: "Rahul Sinha - Warehouse - Cartrend", "Alam -
// Founder Team - Cartrend". That, plus "You" (whoever exported the chat, who
// is on our side), identifies all 14 staff across the 16 exports.
//
// Still configurable, because the next export may come from a phone where the
// contacts are saved differently.
function employeeMatchers() {
  const names = (process.env.EMPLOYEE_NAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const phones = (process.env.EMPLOYEE_PHONE_NUMBERS || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
  const marker = (process.env.EMPLOYEE_NAME_CONTAINS || 'cartrend').toLowerCase();
  return { names, phones, marker };
}

function classify(sender, matchers) {
  const s = String(sender || '').trim();
  if (!s) return 'UNKNOWN';
  const low = s.toLowerCase();
  const digits = s.replace(/\D/g, '');

  if (low === 'you') return 'EMPLOYEE'; // the export is from our own phone
  if (matchers.marker && low.includes(matchers.marker)) return 'EMPLOYEE';
  if (matchers.names.some((n) => n && low.includes(n))) return 'EMPLOYEE';
  if (digits && matchers.phones.includes(digits)) return 'EMPLOYEE';

  // A bare phone number is somebody whose contact we have not saved — in a
  // dealer group, the dealer.
  if (/^\+?\d[\d\s-]{6,}$/.test(s)) return 'CUSTOMER';

  // A SAVED NAME that is not one of ours. These exports are one-to-one dealer
  // groups: our people on one side, that dealer on the other. Held at UNKNOWN
  // at first, this threw away 222 messages from "Lakshmi Motor Co Ct",
  // "Manish Auto Spare Parts" and six other dealers — every one of them the
  // customer, and every one of them named after the group they were in.
  //
  // Getting this wrong in the other direction is cheap: a member of staff
  // mistaken for a customer only adds a question nobody answers, because a
  // pair needs an EMPLOYEE reply to exist at all. A customer mistaken for
  // staff would put their words in our mouth, which is why the employee test
  // above is the strict one.
  if (/[a-z]/i.test(s)) return 'CUSTOMER';
  return 'UNKNOWN';
}

function toDate(dd, mm, yy, hh, mi, ss, ampm) {
  let year = parseInt(yy, 10);
  if (year < 100) year += 2000;
  let hour = parseInt(hh, 10);
  const ap = (ampm || '').toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  // WhatsApp exports in the phone's locale. Indian exports are D/M/Y; the US
  // default is M/D/Y. Whichever reading puts the day past 12 decides it, and
  // when both are possible the difference is a few hours on a timestamp that
  // is only ever used for ordering.
  let day = parseInt(dd, 10);
  let month = parseInt(mm, 10);
  if (month > 12) {
    const t = day;
    day = month;
    month = t;
  }
  const d = new Date(Date.UTC(year, month - 1, day, hour, parseInt(mi, 10), parseInt(ss || '0', 10)));
  return Number.isNaN(d.getTime()) ? null : d;
}

// -> { messages: [{ at, sender, senderType, text, media, index }], senders, systemLines }
function parseChat(raw, conversationId) {
  const matchers = employeeMatchers();
  const messages = [];
  const senders = new Map();
  let systemLines = 0;
  let current = null;

  const flush = () => {
    if (!current) return;
    current.text = current.text.trim();
    messages.push(current);
    current = null;
  };

  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = HEADER.exec(line);
    if (!m) {
      if (SYSTEM.test(line)) {
        systemLines++;
        flush();
        continue;
      }
      // A continuation of the message above. Blank lines inside a message are
      // kept; a blank line outside one is nothing.
      if (current) current.text += '\n' + line;
      continue;
    }
    flush();
    const sender = m[8].trim();
    const body = m[9];
    const senderType = classify(sender, matchers);
    senders.set(sender, { type: senderType, count: (senders.get(sender) || { count: 0 }).count + 1 });
    current = {
      at: toDate(m[1], m[2], m[3], m[4], m[5], m[6], m[7]),
      sender,
      senderType,
      text: body,
      media: MEDIA.test(body),
      index: messages.length,
      conversationId,
    };
  }
  flush();

  // A media placeholder can still carry a caption ("<image omitted> Good
  // morning Sir, kindly clear the outstanding"). The caption is the message;
  // the placeholder is not.
  for (const msg of messages) {
    msg.text = msg.text.replace(MEDIA, '').trim();
    msg.noise = isNoise(msg.text);
  }

  return { messages, senders, systemLines };
}

module.exports = { parseChat, classify, employeeMatchers, isNoise, MEDIA };
