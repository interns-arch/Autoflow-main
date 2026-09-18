'use strict';
// Replay real customer queries from WhatsApp chat exports through the bot.
//
//   node scripts/replay-chats.js <exports-dir> --to 91XXXXXXXXXX [--dry] [--limit N]
//
// SAFETY: every reply is addressed to --to, never to the customer number the
// message originally came from. Replaying against live WhatsApp with the real
// chat ids would message real customers with a bot's half-finished answers.
// The `to` number is the only destination; escalations still go to the real
// ESCALATION_NUMBER, which is the point of the exercise.
//
// --dry prints what would be sent and touches nothing.
const fs = require('fs');
const path = require('path');

const STAFF =
  /gunjan|ronak|bhavna|bhawna|ujjwal|cartrends|sales bot|crm|amit marketing|arun sir|prateek|adi\b/i;
// A part number holds BOTH a letter and a digit — the same rule the bot uses.
const PART_RE = /(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*[0-9])[A-Za-z0-9][A-Za-z0-9-]{4,}/;
// Acknowledgements and greetings. Sending these to a human helper wastes their
// time, and they were never questions in the first place.
const CHIT_CHAT =
  /^(ok(ay)?|yes|no|nhi|nahi|hn|ha|haan|thik|theek|thik hai|\?+|checked|done|ji|hello|hi|namaste|jai mata di.*|ram ram.*|thanks?|tx|k)$/i;

// Conversation that continues an order rather than starting one. In the real
// chat each of these pointed at a photo or a line the salesman had in front of
// him; replayed on its own it is not a query, and sending it to the helper is
// asking a person to identify the words "Please send me correct information".
const NOT_A_QUERY =
  /^(ye hai ji|this also|place order|return ji|bhejo|wait|leave this|add|pise|price\??|available\??|when to expect\??|can you arrange this\??|need time for this|please send me correct information|ok hai ji|sticker galat hai|bill|send|yes ji|no ji)$/i;

function parseChat(file) {
  const out = [];
  for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\[([^\]]+)\]\s([^:]{1,40}):\s([\s\S]*)$/);
    if (!m) continue;
    const [, when, whoRaw, bodyRaw] = m;
    const who = whoRaw.trim();
    if (/^-\s/.test(who) || STAFF.test(who)) continue; // system lines and our own staff

    let body = bodyRaw.trim().replace(/^\[Forwarded\]\s*/, '');
    if (/^\/9j\/|^iVBOR/.test(body)) continue; // inline image blobs
    if (/Location: -?\d+\./.test(body)) continue;
    if (/<group-history|message_history_notice|album message/.test(body)) continue;

    // The export omits the media itself, so a photo or voice query cannot be
    // replayed — only its caption, if it had one.
    const mediaCaption = body.match(/<(?:image|audio|document|video) omitted>\s*(.*)$/i);
    if (mediaCaption) {
      const cap = (mediaCaption[1] || '').trim();
      if (!cap) continue; // nothing left to replay
      body = cap;
    }
    if (!body || CHIT_CHAT.test(body) || NOT_A_QUERY.test(body)) continue;

    // NEVER replay a confirmation. A recorded "yes" from a chat months ago
    // would punch a real sales order into the Dealer Portal today, against a
    // cart the customer never saw. This is the one mistake in a replay that
    // cannot be undone, so it is refused outright rather than filtered.
    if (/^(yes|yess+|ok(ay)?|confirm(ed)?|done|haan+|ha|thik hai|theek hai|pakka|final|confirm karo|book it|place (the )?order)\b/i.test(body)) continue;

    // Everything below was a query in the chat but cannot be one here.
    if (/^<.*omitted>$/i.test(body)) continue; // voice / GIF / sticker, no file in the export
    if (/message was deleted|null$/i.test(body)) continue;
    if (/^@/.test(body)) continue; // a mention aimed at a colleague
    // A bare quantity was the caption on a photo we do not have. Without the
    // picture there is no part to attach it to — replaying it just makes the
    // bot ask what the customer wants.
    if (/^(send\s+|need\s+)?\d{1,4}\s*(pcs?|pc|p|pise|pieces?|nos?|no\.?|box|set)?\s*(more|needed|right)?$/i.test(body)) continue;
    // Payment arithmetic and running totals from the same threads.
    if (/^[\d\s,+\-=.]+$/.test(body)) continue;
    if (/cheque|payment|paid|balance|amount|rs\.?\s*\d/i.test(body) && !PART_RE.test(body)) continue;
    // "Leave 9no. Item", "4th. No. Item 3pc" — these edit a photo-based order
    // that only makes sense with the photo in front of you.
    if (/\b(no\.?|item)\b/i.test(body) && !PART_RE.test(body)) continue;

    out.push({ when, who, body });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const to = (args[args.indexOf('--to') + 1] || '').replace(/\D/g, '');
  const dry = args.includes('--dry');
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : Infinity;
  const gapMs = args.includes('--gap') ? parseInt(args[args.indexOf('--gap') + 1], 10) : 4000;

  if (!dir || (!dry && !to)) {
    console.error('usage: node scripts/replay-chats.js <exports-dir> --to 91XXXXXXXXXX [--dry] [--limit N] [--gap ms]');
    process.exit(1);
  }

  // "Sales Experts" is the Cartrends sales team's own group, not a customer
  // one: its traffic is dealer names ("Pappu motor"), internal status ("nahi
  // hai") and stock chatter. Replaying it would ask the helper to identify
  // three hundred shop names as if they were parts. --internal includes it.
  const INTERNAL = /sales\s*experts/i;
  const chats = fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    .filter((d) => fs.existsSync(path.join(dir, d, 'chat.txt')))
    .filter((d) => args.includes('--internal') || !INTERNAL.test(d));

  let queries = [];
  for (const c of chats) {
    const msgs = parseChat(path.join(dir, c, 'chat.txt'));
    queries.push(...msgs.map((m) => ({ ...m, chat: c })));
  }

  // The same part asked five times teaches the bot nothing new and asks the
  // helper the same question five times.
  const seen = new Set();
  queries = queries.filter((q) => {
    const k = q.body.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  queries = queries.slice(0, limit);

  console.log(`${chats.length} chat(s), ${queries.length} unique queries to replay`);
  if (dry) {
    queries.forEach((q, i) => console.log(String(i + 1).padStart(4), '|', q.chat.slice(0, 18).padEnd(18), '|', q.body.slice(0, 70)));
    return;
  }

  const store = require('../src/store');
  store.load();
  const CustomerBot = require('../src/bots/customerBot');
  const customer = new CustomerBot();
  const bots = { customer };
  require('../src/core/admin').attach(bots);
  require('../src/core/escalation').attach(bots);
  await customer.start();

  // The helper's answers arrive as INBOUND webhooks, so this process has to be
  // listening for them — otherwise every question is asked into the void and
  // nothing is ever learned, which is the entire point of the run.
  // This means `npm start` must NOT be running: two pollers would fight over
  // the same relay queue and each would see half the replies.
  require('../src/wa/relayPoller').start(bots);
  console.log('listening for helper replies — do not run `npm start` at the same time\n');

  const chatId = to + '@cloud';
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    console.log(`\n--- [${i + 1}/${queries.length}] ${q.chat} :: ${q.body.slice(0, 70)}`);
    try {
      await customer.transport.injectIncoming({
        from: to,
        chatId,
        chatName: '',
        isGroup: false,
        body: q.body,
        hasMedia: false,
        mediaType: 'chat',
      });
    } catch (e) {
      console.log('    ERROR:', String((e && e.message) || e).slice(0, 160));
    }
    // Pace it. The portal is a live system and the helper is a person.
    if (i < queries.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  // Questions stay open for a late answer, so the process has to stay up to
  // receive it. Ctrl-C when the helper is done.
  console.log(
    `\nreplay finished — ${queries.length} sent. Staying up for the helper's answers; Ctrl-C to stop.`
  );
  setInterval(() => {}, 60000);
}

main().catch((e) => {
  console.error('replay crashed:', e);
  process.exit(1);
});
