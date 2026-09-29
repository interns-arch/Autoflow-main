'use strict';
// ONE CONVERSATION PER CUSTOMER, EVEN IN A GROUP.
//
// Founder, 29 Sep: in a group, any customer can ask for parts; the bot lists
// what is in stock and what is not, asks that customer whether to punch, and
// punches on THEIR portal account - or, when their number has no account,
// offers to open one.
//
// Everything the bot keeps about a conversation - the agent's memory, the
// cart, the account form, the photo just sent, the language - is keyed on the
// chat id. In a group that is the GROUP's id, so two customers asking at once
// shared one cart, and whoever said "yes" punched the other's list on their
// own account. So a customer's message in a group is given its own key, the
// group and their number ("<group>~<phone>"), and everything keyed on it is
// theirs alone. Only sending turns the key back into the group
// (wrapTransport): the reply is still posted in the group, for everyone.
const SEP = '~';

function memberKey(groupId, phone) {
  const p = String(phone || '').replace(/[^0-9]/g, '');
  return p ? `${groupId}${SEP}${p}` : String(groupId);
}

// -> the group id for a member key, or null for any other chat id.
function groupOf(key) {
  const s = String(key || '');
  const i = s.lastIndexOf(SEP);
  return i > 0 && /^[0-9]{8,15}$/.test(s.slice(i + 1)) ? s.slice(0, i) : null;
}

// WHO A REPLY IS FOR. Everyone in the group reads it, so a text sent to a
// member's key starts with their name - their account's, or their WhatsApp
// profile's - unless it already says it. Here, where every send passes, so a
// specialist's answer hours later is addressed too, not just the agent's
// reply to the message in hand.
const names = new Map(); // member key -> name
function noteName(key, name) {
  const n = String(name || '').trim();
  if (key && n) names.set(key, n.slice(0, 60));
}
function addressed(key, text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const name = names.get(key) || '+' + String(key).slice(String(key).lastIndexOf(SEP) + 1).replace(/^91/, '');
  const first = name.split(/\s+/)[0].toLowerCase();
  if (first && text.slice(0, 80).toLowerCase().includes(first)) return text;
  return `*${name}* — ${text}`;
}
const TEXT_SENDS = new Set(['sendToChat', 'sendText']);

// Every method of the transport that takes a chat id first gets the group
// in place of a member key, and a text is addressed to the member.
function wrapTransport(transport) {
  if (!transport || transport.__groupChat) return transport;
  return new Proxy(transport, {
    get(target, prop, receiver) {
      if (prop === '__groupChat') return true;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return function (first, ...rest) {
        const g = typeof first === 'string' ? groupOf(first) : null;
        if (g && TEXT_SENDS.has(prop) && rest.length) rest[0] = addressed(first, rest[0]);
        return v.call(target, g || first, ...rest);
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

module.exports = { memberKey, groupOf, wrapTransport, noteName, SEP };
