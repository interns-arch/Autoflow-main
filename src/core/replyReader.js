'use strict';
// WHAT A REPLY TO A YES/NO QUESTION MEANS — read by the model, in context.
//
// 29 Sep, live (a sales agent setting up a discount): "Hnnn", "Hnnn", "Hn"
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

// Flash, not Flash Lite: a "no" throws away what was filled in, and on 29 Sep
// Lite read "ek min ruko" and "hmm sochta hu" as a no. REPLY_MODEL overrides.
const MODEL = () => (process.env.REPLY_MODEL || config.gemini.visionModel).trim();
const TIMEOUT_MS = 10000;

// "Haaaaan" -> "han", "Hnnn" -> "hn", "okkk" -> "ok": a run of one letter is
// one letter. Only for the fallback's word list.
const squeeze = (s) => String(s || '').toLowerCase().trim().replace(/([a-z])\1+/g, '$1');

// Words that may sit beside a yes without changing it: "hmm ok", "han ji".
const YES_TOKEN = /^(han|hn|ha|hm|haji|ji|yes|yep|yeah|ya|y|ok|oke|okay|k|sure|ofcourse|ofc|of|course|bilkul|zarur|zaror|jarur|sahi|hai|he|thek|thik|done|kar|do|kardo|karo|bhej|bhejdo|bhejo|chalega|confirm|go|ahead|proced|sir|bhai|please|pls)$/;
const NO_TOKEN = /^(n|nahi|nhi|nai|no|nope|na|mat|rehne|rhne|ruko|cancel|galat|wrong)$/;

// A question ("hmm?") is not an answer; a no anywhere ("hmm nahi") is a no;
// a yes is a reply made only of yes-words ("hmm ok"), never "hmm sochta hu".
function fallback(reply) {
  const raw = String(reply || '');
  if (raw.includes('?')) return 'other';
  const words = squeeze(raw).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return 'other';
  if (words.some((w) => NO_TOKEN.test(w))) return 'no';
  if (words.length <= 4 && words.every((w) => YES_TOKEN.test(w))) return 'yes';
  return 'other';
}

const SYSTEM = `You are reading one WhatsApp reply from a member of the Cartrends sales team (an auto-parts distributor in India) to a yes/no question the Cartrends sales bot just asked them in a setup they started themselves. Read it the way a colleague sitting next to them would: from the conversation, not from a list of words.

They write Hindi, English or Hinglish, as people really type on WhatsApp — misspelt, stretched ("haaaan", "hnnn", "okkk"), shortened ("hn", "k", "ofc"), casual ("ofcourse", "bilkul", "kar do", "bhej do"), or just a sound ("hmm", "hm"). What a short reply means depends on the conversation: someone who asked for this setup and is answering the bot's questions one after another is usually carrying on; the same sound after a surprising summary may be hesitation. Judge it from the recent messages.

Answer with one of:
- "yes": they mean go ahead.
- "no": they clearly refuse, stop, or say it is the wrong one. A "no" throws away what they have filled in, so wanting time ("sochta hu", "ek min", "ruko dekhta hu") is NOT a no — that is "unclear", and "say" tells them it will wait.
- "unclear": it is a reply to this question, but you genuinely cannot tell yes from no even with the context. Then write "say": one short, natural line back to them, in the language and tone they use, that asks what they want — not a copy of the bot's question.
- "new": not a reply to this question at all — a new request, a question about something else, a part number, a different customer. It will be answered separately.

JSON only: {"answer":"yes"|"no"|"unclear"|"new","why":"<few words>","say":"<only when unclear>"}`;

// -> { answer: 'yes'|'no'|'unclear'|'new', say?: string }
//   question: what the bot just asked, as sent
//   options:  what yes and no mean at this step, e.g. { yes: 'add another rule', no: 'finished' }
//   phone:    whose chat — the last few messages are read from the chat log
async function readReply({ question, reply, options, phone, recent: given } = {}) {
  const said = String(reply || '').trim();
  const fromList = () => {
    const a = fallback(said);
    // Without a model a short reply that is neither is asked again; a longer
    // one is taken as a message of its own.
    return { answer: a === 'other' ? (said.split(/\s+/).length > 2 ? 'new' : 'unclear') : a };
  };
  if (!said) return { answer: 'unclear' };
  if (!ai.modelAvailable() && !ai._stubbed()) return fromList();
  // `given` (tests): the chat so far as lines, instead of the chat log.
  let recent = Array.isArray(given) ? given.join('\n') : '';
  if (!recent) try {
    const rows = phone ? require('./chatLog').messages(phone, { limit: 10 }) : [];
    recent = rows
      .filter((e) => e.dir === 'in' || e.dir === 'out')
      .map((e) => `${e.dir === 'in' ? 'Sales team' : 'Bot'}: ${String(e.text || '[' + e.kind + ']').replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');
  } catch (e) {
    recent = '';
  }
  const user = [
    recent ? `Recent messages (oldest first):\n${recent}` : null,
    `Question the bot asked:\n${String(question || '').slice(0, 600)}`,
    options ? `Here "yes" means: ${options.yes}. "no" means: ${options.no}.` : null,
    `Their reply:\n${said}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const out = await Promise.race([
      ai._model(SYSTEM, user, { modelName: MODEL(), timeoutMs: TIMEOUT_MS }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT_MS)),
    ]);
    const a = String((out && out.answer) || '').toLowerCase();
    if (['yes', 'no', 'unclear', 'new'].includes(a)) {
      const say = a === 'unclear' && out.say ? String(out.say).trim().slice(0, 300) : undefined;
      store.log('reply', `"${said.slice(0, 40)}" -> ${a}${out.why ? ' (' + String(out.why).slice(0, 60) + ')' : ''}${say ? ' says: ' + say.slice(0, 80) : ''}`);
      return { answer: a, say };
    }
    throw new Error('no answer in ' + JSON.stringify(out).slice(0, 80));
  } catch (e) {
    store.log('reply', `model could not read "${said.slice(0, 40)}": ${String((e && e.message) || e).slice(0, 80)} — word list used`);
    return fromList();
  }
}

// -> 'yes' | 'no' | 'other'
async function readYesNo(args) {
  const { answer } = await readReply(args);
  return answer === 'yes' || answer === 'no' ? answer : 'other';
}

// ---- ANY STEP OF A FORM ----
//
// The founder, 29 Sep: the whole form path read by Gemini, not only its
// yes/no questions. The discount setup and the new-customer form ask one
// thing at a time, and until now each step read its answer with its own
// pattern — "skip", a number, a word from a list — so anything said another
// way was asked again, or worse, taken as the answer to the wrong thing.
//
// Here the model reads the reply against what the step wants and the chat so
// far, and says which of five things it is:
//   answer  — it answers the step; `value` is the answer alone, cleaned
//             ("mera email abc@x.com hai" -> "abc@x.com", "1 lakh" -> 100000)
//   skip    — no value, or not now, for this step ("nahi hai", "skip")
//   quit    — stop the whole form ("rehne do", "cancel kar do")
//   unclear — meant for this step but cannot be read; `say` is its line back
//   new     — not about this step at all; answered elsewhere, the form waits
//
// The model only READS. Whether the value is good — a GSTIN on the register,
// a six-digit PIN, a part on the portal — is still checked by the code, the
// way it always was. No model (or it fails): null, and the step reads the
// reply the old way.
const FORM_SYSTEM = `You read one WhatsApp reply to a step of a form the Cartrends bot is filling in over chat (Cartrends is an auto-parts distributor in India). The person may be a sales-team member or a customer. They write Hindi, English or Hinglish as people really type — misspelt, stretched ("haaaan", "hnnn"), shortened ("hn", "k"), casual ("ofcourse", "bilkul", "bhej do"), or just a sound ("hmm"). Read it as a colleague would, from the conversation, not from a list of words.

Decide which ONE of these it is:
- "answer": it answers what this step asks. Put the answer alone in "value", cleaned to the form the step asks for (a number as digits only, "1 lakh" -> 100000, "50k" -> 50000; an email without the words around it; a name without "mera naam hai").
- "skip": they have nothing for this step or want to leave it empty ("skip", "nahi hai", "koi nahi", "pata nahi").
- "quit": they want to stop the whole form, not just this step ("cancel kar do", "rehne do", "baad mein karenge", "abhi nahi banana").
- "unclear": it is meant for this step but you cannot tell what they mean even with the context. Put one short, natural line back in "say", in their language and tone, asking for what is missing — not a copy of the bot's question.
- "new": it is not about this step — a new request, a price or stock question, a part they want, something else entirely. It will be answered separately and the form waits.

Wanting time ("ek min", "ruko", "sochta hu") is "unclear" with a "say" that you will wait — never "quit".

JSON only: {"intent":"answer"|"skip"|"quit"|"unclear"|"new","value":<only for answer>,"say":"<only for unclear>","why":"<few words>"}`;

function recentLines(phone, given) {
  if (Array.isArray(given)) return given.join('\n');
  try {
    const rows = phone ? require('./chatLog').messages(phone, { limit: 10 }) : [];
    return rows
      .filter((e) => e.dir === 'in' || e.dir === 'out')
      .map((e) => `${e.dir === 'in' ? 'Them' : 'Bot'}: ${String(e.text || '[' + e.kind + ']').replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');
  } catch (e) {
    return '';
  }
}

// -> { intent, value?, say? } | null (no model, or it failed: read it the old way)
//   step:     what this step wants and in what form — see the callers
//   question: what the bot last asked, when the caller has it
async function readFormReply({ step, question, reply, phone, recent: given, flow } = {}) {
  const said = String(reply || '').trim();
  if (!said) return null;
  if (!ai.modelAvailable() && !ai._stubbed()) return null;
  const recent = recentLines(phone, given);
  const user = [
    flow ? `Form: ${flow}` : null,
    recent ? `Recent messages (oldest first):\n${recent}` : null,
    question ? `The bot's question at this step:\n${String(question).slice(0, 600)}` : null,
    `What this step wants:\n${step}`,
    `Their reply:\n${said}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const out = await Promise.race([
      ai._model(FORM_SYSTEM, user, { modelName: MODEL(), timeoutMs: TIMEOUT_MS }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), TIMEOUT_MS)),
    ]);
    const intent = String((out && out.intent) || '').toLowerCase();
    if (!['answer', 'skip', 'quit', 'unclear', 'new'].includes(intent)) throw new Error('no intent in ' + JSON.stringify(out).slice(0, 80));
    const value = intent === 'answer' && out.value != null && String(out.value).trim() ? String(out.value).trim() : undefined;
    // An answer with nothing in it is not an answer.
    if (intent === 'answer' && value === undefined) return { intent: 'unclear', say: undefined };
    const say = intent === 'unclear' && out.say ? String(out.say).trim().slice(0, 300) : undefined;
    store.log('reply', `${flow || 'form'}: "${said.slice(0, 40)}" -> ${intent}${value !== undefined ? ' "' + value.slice(0, 60) + '"' : ''}${say ? ' says: ' + say.slice(0, 80) : ''}`);
    return { intent, value, say };
  } catch (e) {
    store.log('reply', `${flow || 'form'}: model could not read "${said.slice(0, 40)}": ${String((e && e.message) || e).slice(0, 80)} — read the old way`);
    return null;
  }
}

module.exports = { readReply, readYesNo, readFormReply, _fallback: fallback, _squeeze: squeeze };
