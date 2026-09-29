'use strict';
// WHAT A REPLY TO A YES/NO QUESTION MEANS — read by the model, in context.
//
// 29 Sep, live (Shubham Maurya, setting up a discount): "Hnnn", "Hnnn", "Hn"
// to "Isi customer ka discount setup karein?" and then "Ofcourse",
// "Haaaaan", "Hn" to "Ye rule approval ke liye bhejun?" — six yeses, each
// answered with the same question again, because a fixed list of yes-words
// had none of them. People type how they talk: stretched, shortened, in
// Hinglish, with typos. A list never catches up with that; a reader does.
//
// So the model reads the reply against the question just asked and the last
// few messages, and says what it means: yes, no, or neither — a message of
// its own ("Maruti ka headlight kitne ka hai?"), which the flow hands on to be
// answered instead of swallowing it.
//
// The word list below is only the fallback for when there is no model, or it
// fails — and even that reads a stretched word as its short self.
const ai = require('./ai');
const store = require('../store');
const config = require('../config');

// The agent's own model (Flash Lite): reading one short reply is a light job,
// and the agent is waiting on it.
const TIMEOUT_MS = 8000;

// "Haaaaan" -> "han", "Hnnn" -> "hn", "okkk" -> "ok": a run of one letter is
// one letter. Only for the fallback's word list.
const squeeze = (s) => String(s || '').toLowerCase().trim().replace(/([a-z])\1+/g, '$1');

const YES_WORDS =
  /^(han|hn|ha|hm|hmm|haji|ji|ji han|yes|yep|yeah|ya|y|ok|oke|okay|k|sure|of ?course|ofc|bilkul|zarur|zaroor|jarur|sahi|sahi hai|thek|thik|thek hai|thik hai|done|kar do|kardo|karo|bhej do|bhejdo|bhejo|chalega|confirm|haan ji|go ahead|proceed)\b/;
const NO_WORDS = /^(nahi|nhi|nai|no|nope|n|na|mat|mat karo|rehne do|rhne do|ruko|cancel|galat|wrong)\b/;

function fallback(reply) {
  const s = squeeze(reply).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'other';
  if (NO_WORDS.test(s)) return 'no';
  // A long message that happens to start with "ok" is still its own message.
  if (YES_WORDS.test(s) && s.split(' ').length <= 3) return 'yes';
  return 'other';
}

const SYSTEM = `You read one WhatsApp reply to a yes/no question the Cartrends sales bot just asked a member of its sales team (an auto-parts distributor in India). Replies are Hindi, English or Hinglish, often misspelt, stretched ("haaaan", "hnnn", "okkk"), shortened ("hn", "k", "ofc") or casual ("ofcourse", "bilkul", "kar do", "bhej do", "hmm theek hai").

Decide what the reply MEANS as an answer to that question:
- "yes": agrees / goes ahead.
- "no": refuses, stops, or says it is the wrong one.
- "other": not an answer to this question — a new request, a question, a part number, a different customer, or something unclear. Do not guess yes when unsure.

Use the question and the recent messages for context. Answer with JSON only: {"answer":"yes"|"no"|"other","why":"<few words>"}`;

// -> 'yes' | 'no' | 'other'
//   question: what the bot just asked, as sent
//   options:  what yes and no mean at this step, e.g. { yes: 'add another rule', no: 'finished' }
//   phone:    whose chat — the last few messages are read from the chat log
async function readYesNo({ question, reply, options, phone } = {}) {
  const said = String(reply || '').trim();
  if (!said) return 'other';
  if (!ai.modelAvailable() && !ai._stubbed()) return fallback(said);
  let recent = '';
  try {
    const rows = phone ? require('./chatLog').messages(phone, { limit: 8 }) : [];
    recent = rows
      .filter((e) => e.dir === 'in' || e.dir === 'out')
      .map((e) => `${e.dir === 'in' ? 'Sales team' : 'Bot'}: ${String(e.text || '[' + e.kind + ']').replace(/\s+/g, ' ').slice(0, 200)}`)
      .join('\n');
  } catch (e) {
    recent = '';
  }
  const user = [
    recent ? `Recent messages:\n${recent}` : null,
    `Question the bot asked:\n${String(question || '').slice(0, 600)}`,
    options ? `Here "yes" means: ${options.yes}. "no" means: ${options.no}.` : null,
    `Their reply:\n${said}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const out = await Promise.race([
      ai._model(SYSTEM, user, { modelName: config.agent.model, timeoutMs: TIMEOUT_MS }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT_MS)),
    ]);
    const a = String((out && out.answer) || '').toLowerCase();
    if (a === 'yes' || a === 'no' || a === 'other') {
      store.log('reply', `"${said.slice(0, 40)}" -> ${a}${out.why ? ' (' + String(out.why).slice(0, 60) + ')' : ''}`);
      return a;
    }
    throw new Error('no answer in ' + JSON.stringify(out).slice(0, 80));
  } catch (e) {
    store.log('reply', `model could not read "${said.slice(0, 40)}": ${String((e && e.message) || e).slice(0, 80)} — word list used`);
    return fallback(said);
  }
}

module.exports = { readYesNo, _fallback: fallback, _squeeze: squeeze };
