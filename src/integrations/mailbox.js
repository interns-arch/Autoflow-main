'use strict';
// Reads "[Data Entry] ... Request" mails from the IT support mailbox.
//
// Gmail REST API with the OAuth refresh token that is already in .env — not
// IMAP, and not a new App Password. Two reasons that matters:
//
//   * the existing token is scoped `gmail.readonly`, so nothing here can
//     alter, move or delete a mail even by mistake;
//   * readonly also means we CANNOT mark a mail as read, so "already handled"
//     is tracked in our own state by request id instead. That is the better
//     record anyway: it survives someone opening the mail by hand, and it
//     answers "was CUST-260905-150010-F6D done?" directly.
const config = require('../config');
const store = require('../store');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

let cached = { token: null, expiresAt: 0 };

function enabled() {
  const g = config.mailbox;
  return Boolean(g.clientId && g.clientSecret && g.refreshToken);
}

// Access tokens last an hour; refresh a minute early so a long run never
// fails on a token that expired mid-loop.
async function accessToken() {
  if (cached.token && Date.now() < cached.expiresAt - 60000) return cached.token;
  const g = config.mailbox;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.clientId,
      client_secret: g.clientSecret,
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Gmail token refresh failed: ' + (data.error_description || data.error || res.status));
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

async function api(path) {
  const res = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + (await accessToken()) } });
  if (!res.ok) throw new Error(`Gmail ${path} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Gmail splits a mail into nested parts. Take the HTML if there is one — the
// request is a table — and fall back to plain text.
function bodyOf(payload) {
  if (!payload) return '';
  const decode = (d) => Buffer.from(String(d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (payload.body && payload.body.data && !payload.parts) return decode(payload.body.data);

  const walk = (p, want) => {
    if (!p) return '';
    if (p.mimeType === want && p.body && p.body.data) return decode(p.body.data);
    for (const child of p.parts || []) {
      const hit = walk(child, want);
      if (hit) return hit;
    }
    return '';
  };
  return walk(payload, 'text/html') || walk(payload, 'text/plain') || '';
}

function header(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Newest first, so a run that is interrupted has still covered what matters.
// `query` is Gmail search syntax — the same thing you would type in the search
// box, which makes it easy to check by hand what the bot will see.
async function fetchRequests({ limit = 20, query } = {}) {
  if (!enabled()) return [];
  const q = query || config.mailbox.query;
  const list = await api(`/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`);
  const out = [];
  for (const ref of list.messages || []) {
    const msg = await api(`/messages/${ref.id}?format=full`);
    out.push({
      id: ref.id,
      subject: header(msg, 'Subject'),
      from: header(msg, 'From'),
      date: header(msg, 'Date'),
      body: bodyOf(msg.payload),
    });
  }
  // Silent when there is nothing. A watcher polling every two minutes would
  // otherwise emit "0 mails" all day, which buries the one line that matters.
  if (out.length) {
    store.log('mailbox', `${out.length} request mail(s) read (of ~${list.resultSizeEstimate || 0} matching)`);
  }
  return out;
}

// ---- "already handled" lives in OUR state, not in the mailbox ----------
// The token cannot mark a mail read, and doing so would be the wrong record
// anyway: a person opening the mail would look identical to the bot having
// created the account.

function doneList() {
  const s = store.load();
  if (!s.dataEntryDone) s.dataEntryDone = {};
  return s.dataEntryDone;
}

function isDone(requestId) {
  return Boolean(requestId && doneList()[requestId]);
}

function markDone(requestId, detail) {
  if (!requestId) return;
  doneList()[requestId] = { at: new Date().toISOString(), ...detail };
  store.save();
}

// The "Mark as Done — Entry Completed" link inside the mail. It updates the
// Data Entry dashboard, which is what the IT team looks at — so an account
// created here must tick the same box a person would have ticked, or the
// dashboard shows work still pending that is actually finished.
function doneLink(body, requestId) {
  const links = String(body || '').match(/https:\/\/script\.google\.com[^"'<>\s]+/g) || [];
  return (
    links.find((l) => /action=markDone/i.test(l) && (!requestId || l.includes(requestId))) ||
    links.find((l) => /action=markDone/i.test(l)) ||
    null
  );
}

// Called ONLY after the portal has actually accepted the record. Failing to
// tick the box is a nuisance; ticking it for an account that was not created
// would hide real work.
async function clickDone(url) {
  if (!url) return { ok: false, reason: 'no markDone link in the mail' };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = (await res.text()).slice(0, 200);
    return { ok: res.ok, status: res.status, body: text };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}

module.exports = { enabled, fetchRequests, isDone, markDone, bodyOf, accessToken, doneLink, clickDone };
