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

// customerPhone: the CUSTOMER the rule is for (founder, 29 Sep: "the approved
// msg goes to agent but not to customer ... send msg to both that agent and
// customer"). Told too, on their own number, when the portal decides.
function watch(ruleId, { chatId, name, what, customerPhone, customerName }) {
  if (!ruleId || !chatId) return;
  waiting.set(String(ruleId), { chatId, name: name || null, what: what || null, customerPhone: customerPhone || null, customerName: customerName || null, at: Date.now() });
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
    // THE CUSTOMER TOO, on an approval or a rejection (not on a rule that
    // simply vanished - nobody decided anything they need to hear about).
    const custChat = w.customerPhone && (status === 'APPROVED' || status === 'REJECTED') ? store.normPhone(w.customerPhone) + '@cloud' : null;
    const toCustomer = custChat && custChat.split('@')[0] !== String(w.chatId).split('@')[0] ? customerText(status, r, w, lang.for(custChat)) : null;
    if (toCustomer) text += t('\n\nThe customer has been told as well.', '\n\nCustomer ko bhi bata diya hai.');
    const told = [];
    try {
      const id = await bot.transport.sendToChat(w.chatId, text);
      if (bot.recordOutgoing) bot.recordOutgoing(w.chatId, id, text);
      told.push('agent');
    } catch (e) {
      store.log('discount', `could not tell ${w.chatId} about rule ${w.ruleId}: ` + String((e && e.message) || e).slice(0, 80));
    }
    if (toCustomer) {
      try {
        const phone = custChat.split('@')[0];
        await require('./escalation').ensureWindow(bot.transport, phone, 'Your discount — details follow', w.customerName || 'Discount').catch(() => {});
        const id = await bot.transport.sendToChat(custChat, toCustomer);
        if (bot.recordOutgoing) bot.recordOutgoing(custChat, id, toCustomer);
        told.push('customer ' + phone);
      } catch (e) {
        store.log('discount', `could not tell the customer ${w.customerPhone} about rule ${w.ruleId}: ` + String((e && e.message) || e).slice(0, 80));
      }
    }
    done.push({ ruleId: w.ruleId, status, told });
    store.log('discount', `rule ${w.ruleId} is ${status} on the portal — told: ${told.join(', ') || 'nobody'}`);
  }
  return done;
}

// What the CUSTOMER reads: their discount in plain words, as the portal has
// it now (the value the Super Admin approved, which may differ from the ask).
function customerText(status, r, w, t) {
  const who = w.customerName ? w.customerName + ' ji' : 'ji';
  const on = r ? (String(r.rule_type).toUpperCase() === 'ITEM' ? 'part ' + r.part_no : r.brand ? r.brand + ' parts' : 'all parts') : null;
  const pct = r && r.discount_value != null ? r.discount_value + '%' : null;
  const till = r && r.valid_to ? new Date(r.valid_to).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
  if (status === 'APPROVED') {
    return t(
      `Good news, ${who} — a ${pct ? pct + ' ' : ''}discount${on ? ' on ' + on : ''} is now set on your account${till ? ', valid till ' + till : ''}. It applies on your orders from now. Thank you for your business!`,
      `Khushkhabri ${who} — aapke account pe${on ? ' ' + on + ' par' : ''} ${pct ? pct + ' ka ' : ''}discount set ho gaya hai${till ? ', ' + till + ' tak' : ''}. Ab se aapke orders pe lagega. Dhanyavaad!`,
    );
  }
  return t(
    `Dear ${who}, the discount requested for your account${on ? ' on ' + on : ''} could not be approved this time. Your sales representative will be happy to talk it over with you.`,
    `${who}, aapke account ke liye${on ? ' ' + on + ' par' : ''} jo discount maanga gaya tha, woh is baar approve nahi ho paya. Aapke sales representative aapse is baare mein baat kar lenge.`,
  );
}

let timer = null;
function start(bot) {
  if (timer) return;
  timer = setInterval(() => checkOnce(bot).catch(() => {}), EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { watch, pending, checkOnce, start, _clear: () => waiting.clear() };
