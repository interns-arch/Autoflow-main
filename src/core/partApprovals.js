'use strict';
// New parts whose catalogue name needs a person's OK — asked on WhatsApp.
//
// Founder, 11 Sep: when the reference list cannot confirm a name, the bot
// still does the work (core/partNaming: siblings, then the model searching
// the web for the part number) and asks the data-entry desk "naam ye
// rakhun?". OK -> the part is created with that name. Not OK -> it asks for
// the right name, creates the part with it, and remembers it, so the next
// part like it is named right without asking.
//
// The question goes out from the data-entry container; the answer arrives at
// the sales bot, which owns the webhook. So each open question is one small
// file in SHARED_DIR, a directory both containers mount — never state.json,
// which each container rewrites whole on every save.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');

// How long "sahi naam bata dijiye" waits for an unquoted answer. After that
// only a swipe-reply, or a message that is itself a name, counts — the desk
// also uses this chat for everything else.
const NAME_WAIT_MS = 30 * 60 * 1000;

function dir() {
  const d = path.join(config.sharedDir, 'part-approvals');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function file(id) {
  return path.join(dir(), String(id).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}
function save(p) {
  const f = file(p.requestId);
  fs.writeFileSync(f + '.tmp', JSON.stringify(p, null, 1));
  fs.renameSync(f + '.tmp', f);
}
function add(p) {
  save({ stage: 'ask', askedAt: new Date().toISOString(), at: new Date().toISOString(), askedWamids: [], ...p });
}
function all() {
  let names = [];
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }
  return names
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)));
}
function remove(id) {
  try {
    fs.unlinkSync(file(id));
  } catch (_) {}
}

function isApprover(phone) {
  const p = store.normPhone(phone);
  return Boolean(p) && (config.dataEntryAlertNumbers || []).includes(p);
}

// "Naam ye rakhun?" — the suggestion, and the facts that go in with it.
function askText(p) {
  const f = p.fields;
  const facts = [
    f.hsnCode ? 'HSN ' + f.hsnCode + (p.hsnFound ? ' (dhoondha hai, mail mein nahi tha)' : '') : null,
    f.gstPercent != null ? 'GST ' + f.gstPercent + '%' : null,
    f.mrpValue != null ? 'MRP ' + f.mrpValue : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    `Naya part aaya hai — ${p.requestId}`,
    `*${f.partNo}* · ${f.brand || ''} · mail mein: "${f.partName || ''}"`,
    '',
    'Naam ye rakhun?',
    p.suggested,
    ...(facts ? ['', facts] : []),
  ].join('\n');
}

async function create(p, name, how, reply) {
  const f = p.fields;
  try {
    const res = await require('../integrations/dealerPortal').createPart({ ...f, standardName: name });
    remove(p.requestId);
    require('./partNaming').remember(name);
    let ticked = null;
    if (p.doneLink) ticked = (await require('../integrations/mailbox').clickDone(p.doneLink)).ok;
    store.log('dataentry', `part ${f.partNo} created from ${p.requestId} (${how}): ${name}`);
    await reply(
      [
        `✅ Bana diya — *${res.partNo || f.partNo}*`,
        name,
        ...(how === 'corrected' ? ['', 'Ye naam yaad rakh liya — aage aise parts isi tarah banenge.'] : []),
        ...(ticked === false ? ['', '⚠️ Dashboard pe tick nahi hua — haath se tick kar dijiye.'] : []),
      ].join('\n'),
    );
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 160);
    remove(p.requestId);
    store.log('dataentry', `part ${f.partNo} from ${p.requestId} NOT created: ${why}`);
    await reply(`⚠️ Portal ne *${f.partNo}* nahi banaya: ${why}\n\nHaath se bana dijiye — ya chhod dijiye agar ye pehle se hai.`);
  }
  return true;
}

// A message from the data-entry desk. true = it was an answer about a part.
async function handle(bot, m, text, reply) {
  if (m.isGroup || !isApprover(m.from)) return false;
  const open = all();
  if (!open.length) return false;
  const said = require('./voiceOrder').readAnswer(text);
  const named = String(text).includes('|');

  // Which question is this the answer to? A swipe-reply says; otherwise the
  // only one open.
  let p = null;
  if (m.contextId) {
    p = open.find((x) => (x.askedWamids || []).includes(m.contextId)) || null;
    if (!p) return false; // a reply to some other message
  } else {
    const waiting = open.filter((x) => x.stage === 'name' && Date.now() - Date.parse(x.at) < NAME_WAIT_MS);
    if (!said && !named && !waiting.length) return false; // not about a part
    if (open.length === 1) p = open[0];
    else if (waiting.length === 1 && !said) p = waiting[0];
    else {
      await reply(
        `${open.length} parts ka naam pending hai (${open.map((x) => x.fields.partNo).join(', ')}). ` +
          'Jis sawaal ka jawab hai, us message pe swipe karke reply kar dijiye.',
      );
      return true;
    }
  }

  const f = p.fields;
  const naming = require('./partNaming');
  if (named) {
    const name = naming.fromPerson(text, f.partNo, f.brand);
    if (!name) {
      await reply(`Ye naam samajh nahi aaya — is tarah bhejiye:\n${p.suggested}`);
      return true;
    }
    return create(p, name, 'corrected', reply);
  }
  if (p.stage === 'name') {
    if (said === 'no') {
      remove(p.requestId);
      store.log('dataentry', `part ${f.partNo} from ${p.requestId} dropped on WhatsApp`);
      await reply(`Theek hai — *${f.partNo}* abhi nahi banaya.`);
      return true;
    }
    await reply(`*${f.partNo}* ka poora naam bhejiye, is tarah:\n${p.suggested}`);
    return true;
  }
  if (said === 'yes') return create(p, p.suggested, 'ok', reply);
  if (said === 'no') {
    save({ ...p, stage: 'name', at: new Date().toISOString() });
    await reply(`Theek hai — *${f.partNo}* ka sahi naam bata dijiye.`);
    return true;
  }
  return false;
}

module.exports = { add, all, remove, handle, askText, isApprover, _dir: dir };
