'use strict';
// Every message in and out, per chat — the inbox behind the console.
//
// NOT in state.json: that file is rewritten whole on every save, and a
// transcript only ever grows. This is an append-only JSONL file in SHARED_DIR:
// one short write per message, readable with `tail`, and rotated at 20 MB so
// a busy day can never fill the root disk (which sits at 88% on this host).
//
// Only what a person needs to follow a conversation is kept — who, when,
// which way, and the text. Photos, voice notes and files are recorded as a
// line saying so; the bytes are not copied here.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MAX_BYTES = 20 * 1024 * 1024;
const TEXT_CAP = 2000;
const TAIL_BYTES = 4 * 1024 * 1024;

// In SHARED_DIR, not DATA_DIR: the data-entry container sends WhatsApp too
// ("naam ye rakhun?"), and each container has its own /data. One shared
// file means the console shows every message, whoever sent it.
function file() {
  return path.join(config.sharedDir, 'chats.jsonl');
}

// The picture the customer actually sent. Without it the console shows an
// empty bubble and nobody can tell WHICH photo the bot could not read.
// Capped: the newest 300 files and 150 MB, oldest deleted first - the root
// disk on this host sits at 88%.
const MEDIA_KEEP = 300;
const MEDIA_MAX_BYTES = 150 * 1024 * 1024;
const EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function mediaDir() {
  return path.join(config.sharedDir, 'media');
}

function prune(dir) {
  const sized = fs
    .readdirSync(dir)
    .sort()
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }));
  let total = sized.reduce((s, x) => s + x.size, 0);
  let i = 0;
  while (i < sized.length && (sized.length - i > MEDIA_KEEP || total > MEDIA_MAX_BYTES)) {
    try {
      fs.unlinkSync(path.join(dir, sized[i].f));
      total -= sized[i].size;
    } catch (e) {}
    i++;
  }
}

function keep(buffer, mime) {
  if (!buffer || !buffer.length) return null;
  try {
    const dir = mediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const ext = EXT[String(mime || "").toLowerCase().split(";")[0]] || "bin";
    const name = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
    fs.writeFileSync(path.join(dir, name), buffer);
    prune(dir);
    return name;
  } catch (e) {
    return null;
  }
}

function digits(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}

function write(entry) {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
    const size = fs.statSync(f).size;
    // One old file is kept, so the cost on disk is bounded at about 40 MB.
    if (size > MAX_BYTES) fs.renameSync(f, path.join(path.dirname(f), 'chats.1.jsonl'));
  } catch (e) {
    // A bot must never stop talking because a log line could not be written.
  }
}

function clean(s) {
  return String(s == null ? '' : s).trim().slice(0, TEXT_CAP);
}

function kindOf(m) {
  const t = String((m && m.mediaType) || '').toLowerCase();
  if (t === 'ptt' || t === 'audio' || t === 'voice') return 'voice';
  if (t === 'image' || t === 'photo' || t === 'sticker') return 'photo';
  if (t === 'document') return 'file';
  return 'text';
}

// A message the bot received.
function incoming(bot, m) {
  if (!m) return;
  write({
    at: new Date().toISOString(),
    bot,
    dir: 'in',
    chatId: String(m.chatId || m.from || ''),
    phone: digits(m.from),
    name: clean(m.chatName || ''),
    group: Boolean(m.isGroup),
    kind: kindOf(m),
    media: m.mediaBase64 ? keep(Buffer.from(m.mediaBase64, "base64"), m.mediaMime) : null,
    mime: m.mediaMime || undefined,
    text: clean(m.body),
  });
}

// A message the bot sent. `to` is a chat id or a number, as the transports use.
function outgoing(bot, to, text, kind, wamid, media) {
  write({
    at: new Date().toISOString(),
    bot,
    dir: 'out',
    chatId: String(to || ''),
    phone: digits(to),
    group: String(to || '').indexOf('@g.us') >= 0,
    kind: kind || 'text',
    media: media && media.buffer ? keep(media.buffer, media.mime) : null,
    mime: (media && media.mime) || undefined,
    text: clean(text),
    wamid: wamid && typeof wamid === 'string' ? wamid : undefined,
  });
}

// Why the bot did what it did, for the question a person asks later ("why
// did it not read my photo?"). Shown as a grey line in the console thread.
function note(bot, chatId, phone, text) {
  write({
    at: new Date().toISOString(),
    bot,
    dir: 'note',
    chatId: String(chatId || ""),
    phone: digits(phone || chatId),
    kind: 'note',
    text: clean(text),
  });
}

// The last stretch of the file, parsed. Reading the tail keeps the console
// fast however long the day has been.
function tail(bytes = TAIL_BYTES) {
  const out = [];
  let fd = null;
  try {
    const f = file();
    const size = fs.statSync(f).size;
    const start = Math.max(0, size - bytes);
    fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the first line is half a line
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch (e) {
        // a torn line, from a write that was interrupted
      }
    }
  } catch (e) {
    // no file yet
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
  return out;
}

function keyOf(e) {
  return e.phone || e.chatId || '';
}

// One row per conversation, newest first.
function chats({ limit = 200 } = {}) {
  const byKey = new Map();
  for (const e of tail()) {
    const key = keyOf(e);
    if (!key || e.dir === 'note') continue; // a note is not a message in the list
    const c = byKey.get(key) || { key, phone: e.phone || '', chatId: e.chatId || '', name: '', group: false, count: 0, inCount: 0, at: e.at, last: '', lastDir: '' };
    c.count++;
    if (e.dir === 'in') c.inCount++;
    if (e.name) c.name = e.name;
    if (e.group) c.group = true;
    if (!c.chatId && e.chatId) c.chatId = e.chatId;
    c.at = e.at;
    c.last = e.kind === 'text' ? e.text : '[' + e.kind + '] ' + e.text;
    c.lastDir = e.dir;
    byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

// One conversation, oldest first — the way a chat reads.
function messages(id, { limit = 400 } = {}) {
  const want = digits(id) || String(id || '');
  const rows = tail().filter((e) => keyOf(e) === want || e.chatId === String(id) || (e.phone && e.phone === want));
  return rows.slice(-limit);
}

module.exports = { incoming, outgoing, note, chats, messages, _file: file, _tail: tail, _mediaDir: mediaDir };
