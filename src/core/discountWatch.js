'use strict';
// A DISCOUNT RULE WAITING ON THE PORTAL'S SUPER ADMIN.
//
// Founder, 28 Sep: "super admin approve the discount manually, and for
// discount approval don't send to sales head - directly send to dealer portal
// for approval, and as it is approved customers are able to punch orders with
// the discount, same time it gets approved".
//
// So the bot writes the rule to the portal as PENDING and nothing else; the
// Super Admin approves it on the portal; the portal applies it at the next
// order punch. This watches the rules the bot wrote and tells the agent who
// asked the moment one is approved (or rejected) - so nobody has to keep
// opening the portal to find out, and nobody is told "done" before it is.
const store = require('../store');
const chatState = require('./chatState');

const waiting = chatState.slot('discount.awaitingPortal'); // ruleId -> { chatId, name, what, at }
const EVERY_MS = 5 * 60 * 1000;
const GIVE_UP_MS = 14 * 24 * 60 * 60 * 1000;

function watch(ruleId, { chatId, name, what }) {
  if (!ruleId || !chatId) return;
  waiting.set(String(ruleId), { chatId, name: name || null, what: what || null, at: Date.now() });
  store.log('discount', `rule ${ruleId} is waiting for the Super Admin on the portal (${name || what || ''})`);
}

function pending() {
  return [...waiting.entries()].map(([ruleId, w]) => ({ ruleId, ...w }));
}

// One pass. -> [{ ruleId, status }] for the rules it reported on.
async function checkOnce(bot) {
  const list = pending();
  if (!list.length) return [];
  const portal = require('../integrations/dealerPortal');
  let rules;
  try {
    rules = await portal.listDiscountRules();
  } catch (e) {
    store.log('discount', 'could not read the rules to check approvals: ' + String((e && e.message) || e).slice(0, 100));
    return [];
  }
  const lang = require('./lang');
  const done = [];
  for (const w of list) {
    const r = rules.find((x) => String(x.rule_id || x.id) === String(w.ruleId));
    const status = r ? String(r.approval_status || '').toUpperCase() : 'GONE';
    const label = w.name || (r && r.rule_name) || `rule #${w.ruleId}`;
    const t = lang.for(w.chatId);
    let text = null;
    if (status === 'APPROVED') {
      text = t(
        `✅ ${label} (rule #${w.ruleId}) is approved on the Dealer Portal — orders punched from now get the discount.`,
        `✅ ${label} (rule #${w.ruleId}) Dealer Portal pe approve ho gaya — ab se order pe discount lagega.`,
      );
    } else if (status === 'REJECTED') {
      text = t(`❌ ${label} (rule #${w.ruleId}) was rejected on the Dealer Portal — no discount.`, `❌ ${label} (rule #${w.ruleId}) Dealer Portal pe reject ho gaya — discount nahi lagega.`);
    } else if (status === 'GONE') {
      text = t(`${label} (rule #${w.ruleId}) is no longer on the Dealer Portal.`, `${label} (rule #${w.ruleId}) ab Dealer Portal pe nahi hai.`);
    } else if (Date.now() - w.at > GIVE_UP_MS) {
      waiting.delete(String(w.ruleId));
      store.log('discount', `rule ${w.ruleId} still ${status} after 14 days — no longer watched`);
      continue;
    }
    if (!text) continue;
    waiting.delete(String(w.ruleId));
    done.push({ ruleId: w.ruleId, status });
    store.log('discount', `rule ${w.ruleId} is ${status} on the portal — ${w.chatId} told`);
    try {
      const id = await bot.transport.sendToChat(w.chatId, text);
      if (bot.recordOutgoing) bot.recordOutgoing(w.chatId, id, text);
    } catch (e) {
      store.log('discount', `could not tell ${w.chatId} about rule ${w.ruleId}: ` + String((e && e.message) || e).slice(0, 80));
    }
  }
  return done;
}

let timer = null;
function start(bot) {
  if (timer) return;
  timer = setInterval(() => checkOnce(bot).catch(() => {}), EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { watch, pending, checkOnce, start, _clear: () => waiting.clear() };
