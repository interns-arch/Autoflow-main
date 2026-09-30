'use strict';
// WHO OUR OWN PEOPLE ARE (founder, 29 Sep: "each and every sales agent /
// creation team - the bot knows him from the first message").
//
// A staff number is one of ours from the settings (route.isStaff, the sales
// team, the account-creation team, the Sales Heads, the accountant, the
// helper). Here each gets a NAME and what they DO, so the very first reply
// is to a colleague by name - "Namaste Nirmal ji" - and never the treatment a
// customer gets. A name the settings do not have is the one the Dealer Portal
// keeps for that mobile (its own user record), looked up once a day.
const config = require('../config');
const store = require('../store');

const portalNames = new Map(); // phone -> { at, name }
const DAY_MS = 24 * 60 * 60 * 1000;

// "9588536736", "+91 95885 36736" and "919588536736" are one number.
const norm = (p) => {
  const d = String(store.normPhone(p) || p || '').replace(/\D/g, '');
  return d.length === 10 ? '91' + d : d;
};
const inList = (list, p) => (list || []).map(norm).includes(p);
const inMap = (map, p) => Boolean(map && Object.keys(map).map(norm).includes(p));
const nameIn = (map, p) => {
  if (!map) return null;
  for (const [k, v] of Object.entries(map)) if (norm(k) === p && v) return String(v);
  return null;
};

// -> { phone, name, roles: [..], staff } - roles in plain words.
function whoIsSync(phone) {
  const p = norm(phone);
  const c = config.creation || {};
  const roles = [];
  if (inList(config.adminNumbers, p)) roles.push('admin');
  if (inMap(c.approvers, p) || inMap(c.accountApprovers, p)) roles.push('Sales Head (approves orders, accounts and discounts)');
  if (inList(config.salesTeamNumbers, p)) roles.push('sales team (takes orders for customers)');
  if (inMap(c.team, p)) roles.push('account-creation team (opens new customer accounts)');
  if (inMap(config.payments && config.payments.accountants, p)) roles.push('accountant (confirms payments)');
  if ([config.escalationNumber, config.voiceEscalationNumber].map(norm).includes(p)) roles.push('parts specialist (answers questions the bot cannot)');
  if (inList(config.inquiryOnlyNumbers, p)) roles.push('enquiries only');
  const name =
    nameIn(c.team, p) ||
    nameIn(c.approvers, p) ||
    nameIn(c.accountApprovers, p) ||
    nameIn(config.payments && config.payments.accountants, p) ||
    (portalNames.get(p) && portalNames.get(p).name) ||
    null;
  return { phone: p, name, roles, staff: roles.length > 0 };
}

// The same, with the portal asked for a name the settings do not have.
async function whoIs(phone) {
  const who = whoIsSync(phone);
  if (!who.staff || who.name) return who;
  const hit = portalNames.get(who.phone);
  if (hit && Date.now() - hit.at < DAY_MS) return { ...who, name: hit.name };
  let name = null;
  try {
    const u = await require('../integrations/dealerPortal').userForMobile(who.phone);
    name = nameFromUsername(u && (u.name || u.fullName || u.username));
  } catch (_) {
    /* no name: they are still known as staff, by their role */
  }
  portalNames.set(who.phone, { at: Date.now(), name });
  return { ...who, name };
}

// The portal keeps a USERNAME for a mobile ("shubham_Maurya_Sales"), not a
// display name: the person's words are kept, the role words dropped.
// "admin_bot" or "user123" is nobody to greet -> null.
const NOT_A_NAME = /^(sales|sale|admin|bot|test|user|agent|team|staff|cartrends|ct|mgr|manager|exec|executive|\d+)$/i;
function nameFromUsername(raw) {
  const words = String(raw || '')
    .split(/[_.\s-]+/)
    .filter((w) => w && !NOT_A_NAME.test(w) && /^[a-z]{2,}$/i.test(w));
  if (!words.length) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// One line for the staff agent: who is writing, in its own words.
function describe(who) {
  if (!who || !who.staff) return null;
  const first = who.name ? who.name.split(/\s+/)[0] : null;
  return `[Staff member writing: ${who.name || 'name not on record'}${first && first !== who.name ? ` (call them ${first} ji)` : who.name ? ` (call them ${who.name} ji)` : ''} — ${who.roles.join('; ')}. One of OUR people, never a customer.]`;
}

module.exports = { whoIs, whoIsSync, describe, _portalNames: portalNames, _nameFromUsername: nameFromUsername };
