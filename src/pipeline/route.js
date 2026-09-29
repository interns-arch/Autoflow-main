'use strict';
// Stage 2 of the pipeline: WHO is sending, and is this message for the bot at
// all.
//
// Phase 2 of the pipeline lifted these out of
// customerBot.handleMessage and the bot's own methods without changing what
// they decide. The bot keeps thin listensTo / inquiryOnly / isStaff methods
// that call these, because escalation and the tests ask the bot directly.
const config = require('../config');
const store = require('../store');

function listensTo(m) {
  // DMs: whitelist-only — CUSTOMER_DMS numbers (or the LID digits that show
  // up in the logs). "all" = testing mode.
  if (!m.isGroup) return config.customerDmsAll || config.customerDms.includes(store.normPhone(m.from));
  // GROUPS: the bot speaks ONLY in groups it created itself. Nothing to
  // configure and nothing to get wrong — being added to some unrelated
  // company group can never make it start answering there.
  // ...unless GROUPS_ANSWER_ALL says any group it is in (config).
  if (config.groupsAnswerAll) return true;
  return Boolean(require('../core/groups').findByGroupId(m.groupId || m.chatId));
}

// A number that only ever asks — never orders. Availability yes, cart no.
// The sales team is the same until they say who the order is for ("Kalra
// ka SO bana do"): their SIMs are saved on customers' accounts (9217030422
// is Agent Hajra AND M/S Maan Motors), so parts sent before a customer is
// picked would otherwise land in that customer's cart.
//
// NOT admins (founder, 13 Sep, after asking for it and then seeing what it
// meant): "punch hona chahiye..hn bolne se..agr customer ka naam le kr bole tb
// bhi aur agr na bole to jo no. hai admin ke naam se". An admin orders for a
// named customer, or else on the account of his own number.
function inquiryOnly(phone, chatId) {
  const p = store.normPhone(phone);
  if (config.inquiryOnlyNumbers.includes(p)) return true;
  if (!(config.salesTeamNumbers || []).includes(p)) return false;
  return !(chatId && require('../core/salesOrder').activeCustomer(chatId));
}

// Cartrends people, as opposed to customers: admins, the members added to
// every group, and the human the bot escalates to.
function isStaff(phone) {
  const p = store.normPhone(phone);
  return (
    config.adminNumbers.includes(p) ||
    config.groupDefaultMembers.includes(p) ||
    p === config.escalationNumber ||
    // The voice helper is staff too. The console role list knew that and
    // this did not, so in a group their message was read as a customer.
    p === config.voiceEscalationNumber
  );
}

// Is this message for the bot at all?
function forBot(m) {
  if (!listensTo(m)) return false;
  const botNumbers = Object.values(config.bots)
    .map((b) => b.number)
    .filter(Boolean);
  if (botNumbers.includes(m.from)) return false;

  // A STAFF number is not a customer. In a group the Cartrends people
  // (admins, the default members added to every group, the escalation
  // helper) talk to the customer as humans — the bot must never read
  // their "Brake Pad - 5" as an order, and never take THEIR "yes" as the
  // customer's confirmation.
  if (m.isGroup && isStaff(m.from)) return false;
  return true;
}

// The senders with a job of their own, before anyone is treated as a customer.
// true = handled here.
async function handleRoles(bot, m, text, reply, t) {
  const salesOrder = require('../core/salesOrder');
  const partApprovals = require('../core/partApprovals');

  // A salesman ordering FOR a customer: "Kalra Motors ka SO bana do". Only
  // the sales team list and admins may. Checked before the rest, because
  // "1" and "haan" mean something exact while a customer is being picked.
  if (!m.isGroup && salesOrder.isSalesPerson(m.from)) {
    if (await salesOrder.handle(bot, m, text, reply, t)) return true;
  }

  // The data-entry desk answering "naam ye rakhun?" about a new part
  // (core/partApprovals). Only while a question is open; otherwise their
  // messages go through like anyone's.
  if (!m.isGroup && partApprovals.isApprover(m.from)) {
    if (await partApprovals.handle(bot, m, text, reply)) return true;
  }
  return false;
}

// The customer a salesman is speaking FOR right now - the one he is asking
// about, or failing that the one he is ordering for. null for everyone else.
function onBehalfOf(m) {
  const salesOrder = require('../core/salesOrder');
  return salesOrder.isSalesPerson(m.from)
    ? salesOrder.discussing(m.chatId) || salesOrder.activeCustomer(m.chatId)
    : null;
}

module.exports = { listensTo, inquiryOnly, isStaff, forBot, handleRoles, onBehalfOf };
