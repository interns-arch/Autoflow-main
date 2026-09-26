'use strict';
// APPROVALS THAT NEVER ARRIVED (founder, 26 Sep). DSC-NH2X went to three Sales
// Heads; WhatsApp refused two of them - the template for want of a currency
// on the Meta account (131042), then the text because no 24h window was open
// (131047) - and the agent was told "Sent for approval" all the same.
//
// Every approval message sent is remembered by its WhatsApp id. When the
// webhook reports one as failed, the failures of that approval are gathered
// for a few seconds (a template and its text fail separately, in either
// order) and ONE warning goes to whoever asked for it and to the Sales Heads
// whose copy did go out: who did not get it, why, and what to do about it.
const config = require('../config');
const store = require('../store');
const chatState = require('./chatState');

const tracked = chatState.slot('delivery.tracked'); // wamid -> { at, ref, to, requesterChat }
const recent = new Map(); // number -> [{ at, code, why }] - every failure, tracked or not
const batches = new Map(); // ref -> { failed: Set<number>, timer }
const warned = new Set(); // "ref|number": each failure is reported once
const GATHER_MS = Number(process.env.DELIVERY_WARN_GATHER_MS || 20000);
const RECENT_MS = 10 * 60 * 1000;

const norm = (p) => store.normPhone(String(p || ''));

function track(id, { ref, to, requesterChat = null }) {
  if (!id || !ref) return;
  tracked.set(id, { at: Date.now(), ref, to: norm(to), requesterChat });
}

// What the error means, for the people who have to act on it.
function explain(code, t) {
  const c = Number(code);
  if (c === 131042)
    return t(
      'WhatsApp Business account has no currency / payment method set up, so template messages cannot be sent (Meta Business Suite → WhatsApp Manager → Billing)',
      'WhatsApp Business account mein currency / payment method set nahi hai, isliye template message nahi ja sakte (Meta Business Suite → WhatsApp Manager → Billing)',
    );
  if (c === 131047)
    return t(
      'they have not messaged the bot in the last 24 hours — ask them to send "Hi" to the bot number',
      'unhone pichhle 24 ghante mein bot ko message nahi kiya — unse bot number pe "Hi" bhejne ko kahiye',
    );
  if (c === 131026) return t('the number cannot receive this message (not on WhatsApp, or blocked us)', 'is number pe message nahi ja sakta (WhatsApp pe nahi hai, ya block kiya hai)');
  return null;
}

function nameOf(number) {
  const p = norm(number);
  return (config.creation.approvers || {})[p] || (config.creation.team || {})[p] || '+' + p;
}

async function onFailed(bot, info) {
  const to = norm(info.to);
  if (to) {
    const list = (recent.get(to) || []).filter((x) => Date.now() - x.at < RECENT_MS);
    list.push({ at: Date.now(), code: info.code, why: info.why || '' });
    recent.set(to, list);
  }
  const tr = info.id && tracked.get(info.id);
  if (!tr) return;
  const key = tr.ref + '|' + tr.to;
  if (warned.has(key)) return;
  warned.add(key);
  let b = batches.get(tr.ref);
  if (!b) {
    b = { failed: new Set(), requesterChat: tr.requesterChat };
    batches.set(tr.ref, b);
    b.timer = setTimeout(() => flush(bot, tr.ref).catch((e) => store.log('delivery', `warning for ${tr.ref} failed: ${e.message}`)), GATHER_MS);
    if (b.timer.unref) b.timer.unref();
  }
  b.failed.add(tr.to);
  if (tr.requesterChat && !b.requesterChat) b.requesterChat = tr.requesterChat;
}

// Everyone this approval was sent to.
function recipientsOf(ref) {
  const out = new Set();
  for (const [, v] of tracked) if (v && v.ref === ref && v.to) out.add(v.to);
  return out;
}

function warningText(ref, failed, t) {
  const rows = [...failed].map((p) => {
    const reasons = [];
    for (const f of recent.get(p) || []) {
      const e = explain(f.code, t) || (f.why ? `${f.code || ''} ${f.why}`.trim() : null);
      if (e && !reasons.includes(e)) reasons.push(e);
    }
    return `• ${nameOf(p)} (+${p})${reasons.length ? ' — ' + reasons.join('; ') : ''}`;
  });
  return t(
    `⚠️ *${ref} did not reach ${failed.size === 1 ? 'one approver' : failed.size + ' approvers'}* — WhatsApp refused it:\n${rows.join('\n')}\n\nOnce fixed, the request needs to be sent again.`,
    `⚠️ *${ref} ${failed.size === 1 ? 'ek approver' : failed.size + ' approvers'} tak nahi pahuncha* — WhatsApp ne rok diya:\n${rows.join('\n')}\n\nTheek hone ke baad request dobara bhejni padegi.`,
  );
}

async function flush(bot, ref) {
  const b = batches.get(ref);
  batches.delete(ref);
  if (!b || !b.failed.size) return;
  const lang = require('./lang');
  const sentTo = recipientsOf(ref);
  const reached = [...sentTo].filter((p) => !b.failed.has(p));
  store.log('delivery', `${ref}: not delivered to ${[...b.failed].join(', ')}; warning ${b.requesterChat || '-'} and ${reached.join(', ') || 'nobody else'}`);
  const targets = [];
  if (b.requesterChat && !b.failed.has(norm(String(b.requesterChat).split('@')[0]))) targets.push(b.requesterChat);
  for (const p of reached) {
    if (b.requesterChat && norm(String(b.requesterChat).split('@')[0]) === p) continue;
    targets.push(p);
  }
  // Nobody who asked and no one else it reached (a payment to the
  // accountant): the Sales Heads hear.
  if (!targets.length) for (const p of Object.keys(config.creation.approvers || {})) if (!b.failed.has(norm(p))) targets.push(norm(p));
  for (const to of targets) {
    try {
      const chat = String(to).includes('@') ? to : null;
      const t = lang.for(chat || to + '@cloud');
      const text = warningText(ref, b.failed, t);
      if (chat) {
        const id = await bot.transport.sendToChat(chat, text);
        if (bot.recordOutgoing) bot.recordOutgoing(chat, id, text);
      } else {
        await bot.transport.sendText(to, text);
      }
    } catch (e) {
      store.log('delivery', `${ref}: could not warn ${to}: ${String((e && e.message) || e).slice(0, 80)}`);
    }
  }
}

// Tests: send the gathered warnings now instead of after GATHER_MS.
async function _flushAll(bot) {
  for (const ref of [...batches.keys()]) {
    clearTimeout(batches.get(ref).timer);
    await flush(bot, ref);
  }
}

module.exports = { track, onFailed, explain, warningText, _flushAll, _reset: () => { recent.clear(); batches.clear(); warned.clear(); } };
