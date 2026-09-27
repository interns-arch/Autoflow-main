#!/usr/bin/env node
'use strict';
// THE SAME PART, ASKED IN DIFFERENT WORDS, IS ONE QUESTION TO A PERSON.
//
// The bug this suite exists to keep fixed, in the founder's own terms: Prateek
// sir is asked for a part number, he gives it, the portal is asked what it
// costs, the customer is answered — and a week later another customer asks for
// the same part in their own words and he is asked all over again.
//
// Why it happened: the learning was a STRING KEY on the customer's exact
// sentence (core/knowledge), and nobody types the same sentence twice.
//
//   "swift ka clutch plate chahiye"        <- what he answered
//   "clutch plate for swift dzire 2 pcs"  <- what came back to him
//
// core/parts/aliases embeds the phrase instead, so the second question only has
// to MEAN the same thing. The rules that keep that from becoming a wrong answer
// are the same three the catalogue index already carries — a threshold, a
// near-tie that goes to a person, and a brand check — and they are what most of
// the cases below are about.
//
// HOW THIS RUNS WITHOUT A DATABASE
//
// As in test:kb: a stand-in Postgres that understands only the statements
// core/parts/aliases issues, with cosine distance computed in JavaScript, and a
// bag-of-words embedding so paraphrases score high without a network call.
//
//   proves      the recall rules, the learning, and that escalation.create no
//               longer reaches a person for a question already answered
//   proves not  that the SQL text is valid Postgres
//
// For that, run it with DATABASE_URL set and the migrations applied.
//
//   npm run test:aliases
require('dotenv').config();

const path = require('path');
const os = require('os');
process.env.DATA_DIR = process.env.ALIAS_TEST_DATA_DIR || path.join(os.tmpdir(), 'autoflow-alias-test');
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
require('fs').writeFileSync(path.join(process.env.DATA_DIR, 'state.json'), '{}');
process.env.ESCALATION_NUMBER = '919999492550';
process.env.GEMINI_API_KEY = '';
process.env.GEMINI_API_KEY = '';
let REAL_DB = false;
if (!(process.env.DATABASE_URL || '').trim()) process.env.DATABASE_URL = 'postgres://stand-in/none';

// The portal is not part of this story: every case here is about what happens
// BEFORE anybody is asked and before the portal is searched by name.
function stub(mod, exports) {
  const p = require.resolve(mod);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
let portalRows = [];
stub('../src/integrations/dealerPortal', {
  searchByName: async () => ({ top: portalRows }),
  analyze: async (p) => p,
  commercialAnalyze: async () => null,
});
// The REAL word rules, captured before the stub goes in: which words name
// something and which are filler, and which words mean the same thing. Every
// refusal in this suite turns on them, so a double that always said yes would
// be testing nothing.
const real = require('../src/core/availability');
stub('../src/core/availability', {
  resolve: async (l) => l.map((x) => ({ item: x.item, partNo: x.item, qty: 1, source: 'available' })),
  describe: (l) => l.item + ' - available',
  displayName: (l) => l.item,
  matchTrustworthy: real.matchTrustworthy,
  distinctiveWords: real.distinctiveWords,
  synonymsOf: real.synonymsOf,
});
stub('../src/core/orders', {
  getOrCreateDraft: () => ({ id: 'SO', lines: [] }),
  addLines: (o, l) => o.lines.push(...l),
  ack: (l) => 'added: ' + l.map((x) => x.item).join(', '),
});

const db = require('../src/core/kb/db');
const embeddings = require('../src/core/kb/embeddings');

// ---------------------------------------------------------------- doubles
//
// A bag of words, with the words that NAME a part weighted above the rest. Two
// ways of asking for a Swift clutch plate then land near each other, and the
// filler a customer wraps it in ("chahiye", "2 pcs", "please") moves the vector
// very little — which is the property a real embedding has and a word-overlap
// count does not.
const NAMES = [
  'clutch', 'plate', 'swift', 'dzire', 'wiper', 'blade', 'cartrends', 'cartrend', 'fortuner',
  'air', 'filter', 'brezza', 'shocker', 'rear', 'front', 'bumper', 'alto', 'baleno', 'inch',
  'horn',
];
const FILLER = ['chahiye', 'ka', 'ki', 'ke', 'hai', 'for', 'please', 'pcs', 'number', 'no', 'kitna', 'bhejo'];
const LEX = [...NAMES, ...FILLER];

function unit(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}
// Spelled by ear. "cartend" and "cartrends", "horan" and "horn" are ONE word to
// a real embedding — that is most of what an embedding is for — and two words to
// a bag of words. The double is told so explicitly, because a suite whose
// embedding cannot connect them would pass cases the live system fails, and
// would fail this one, which is taken from the log.
//
// It only makes the double's SIMILARITY realistic. What is then allowed through
// is decided by the real guards in core/parts/aliases.
const EAR = { cartend: 'cartrends', cartrend: 'cartrends', horan: 'horn', horran: 'horn' };

function fakeEmbed(text) {
  const words = (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).map((w) => EAR[w] || w);
  const v = LEX.map((w) => {
    if (!words.includes(w)) return 0;
    return NAMES.includes(w) ? 1 : 0.15;
  });
  // Sizes matter: a 16-inch blade and a 22-inch blade are different parts, and
  // a double that cannot tell them apart would pass a test the real thing
  // fails. One dimension per size seen, weighted like a name.
  const sizes = ['12', '14', '16', '18', '22', '26'];
  const out = [...v, ...sizes.map((s) => (words.includes(s) ? 1 : 0))];
  const u = unit(out);
  if (u.every((x) => !x)) u[0] = 0.0001;
  const want = require('../src/config').kb.embeddingDim;
  while (u.length < want) u.push(0);
  return u.slice(0, want);
}

// ------------------------------------------------- stand-in for Postgres
//
// Only the statements core/parts/aliases sends. Anything else throws loudly,
// so a new query cannot quietly go untested.
function standInPool() {
  const rows = [];
  let nextId = 1;
  const parseVec = (s) => String(s).replace(/^\[|\]$/g, '').split(',').map(Number);

  return {
    async connect() {
      return { query: (t, p) => this.query(t, p), release() {} };
    },
    async end() {},
    on() {},
    _rows: rows,
    async query(text, params) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      const P = params || [];

      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };

      // remember(): is it there already?
      if (/^SELECT id, norm_part_no, embedding IS NOT NULL AS has_vec FROM bot_part_aliases/i.test(sql)) {
        const r = rows.find((x) => x.norm_phrase === P[0]);
        return { rows: r ? [{ id: r.id, norm_part_no: r.norm_part_no, has_vec: Boolean(r.embedding) }] : [] };
      }

      if (/^INSERT INTO bot_part_aliases/i.test(sql)) {
        const [phrase, norm_phrase, part_no, norm_part_no, part_name, source, taught_by, emb] = P;
        const existing = rows.find((x) => x.norm_phrase === norm_phrase);
        const vec = emb ? parseVec(emb) : null;
        if (existing) {
          existing.part_no = part_no;
          existing.norm_part_no = norm_part_no;
          existing.part_name = part_name || existing.part_name;
          existing.source = source;
          existing.taught_by = taught_by || existing.taught_by;
          if (vec) existing.embedding = vec;
          return { rows: [], rowCount: 1 };
        }
        rows.push({
          id: nextId++, phrase, norm_phrase, part_no, norm_part_no, part_name,
          source, taught_by, embedding: vec, hits: 0,
        });
        return { rows: [], rowCount: 1 };
      }

      // recall(), exact
      if (/^SELECT part_no, part_name, phrase FROM bot_part_aliases WHERE norm_phrase/i.test(sql)) {
        const r = rows.find((x) => x.norm_phrase === P[0]);
        return { rows: r ? [{ part_no: r.part_no, part_name: r.part_name, phrase: r.phrase }] : [] };
      }

      // recall(), by meaning
      if (/FROM bot_part_aliases WHERE embedding IS NOT NULL ORDER BY embedding/i.test(sql)) {
        const v = parseVec(P[0]);
        return {
          rows: rows
            .filter((r) => r.embedding)
            .map((r) => ({ ...r, similarity: embeddings.cosine(v, r.embedding) }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, P[1]),
        };
      }

      if (/^UPDATE bot_part_aliases SET hits = hits \+ 1/i.test(sql)) {
        const r = rows.find((x) => x.norm_phrase === P[0]);
        if (r) r.hits++;
        return { rows: [], rowCount: r ? 1 : 0 };
      }

      if (/^SELECT id, norm_phrase FROM bot_part_aliases WHERE embedding IS NULL/i.test(sql)) {
        return { rows: rows.filter((r) => !r.embedding).map((r) => ({ id: r.id, norm_phrase: r.norm_phrase })) };
      }
      if (/^UPDATE bot_part_aliases SET embedding = v.emb/i.test(sql)) {
        const ids = P[0];
        const vecs = P[1];
        ids.forEach((id, i) => {
          const r = rows.find((x) => x.id === id);
          if (r) r.embedding = parseVec(vecs[i]);
        });
        return { rows: [], rowCount: ids.length };
      }
      if (/count\(\*\)::int AS total FROM bot_part_aliases/i.test(sql)) {
        return { rows: [{ total: rows.length, embedded: rows.filter((r) => r.embedding).length, hits: rows.reduce((s, r) => s + r.hits, 0) }] };
      }
      if (/FROM bot_part_aliases ORDER BY hits DESC/i.test(sql)) return { rows: rows.slice(0, P[0]) };

      // The catalogue index and the knowledge base share this database, and the
      // escalation path writes to both. Neither is what this suite is about, so
      // they answer "nothing" rather than throwing — and crucially rather than
      // erroring: an unknown statement looks to core/kb/db like a server that
      // has gone down, which puts every query after it into a 30-second
      // cooldown and silently turns off the very recall under test. That is
      // exactly how the first run of this suite "proved" the bug was unfixed.
      if (/bot_parts\b|bot_escalations|bot_knowledge/i.test(sql)) {
        return { rows: /RETURNING/i.test(sql) ? [{ id: nextId++ }] : [], rowCount: 0 };
      }

      throw new Error('stand-in database does not know this statement: ' + sql.slice(0, 140));
    },
  };
}

let pass = 0;
const fails = [];
const check = (n, c, d) => {
  if (c) {
    pass++;
    console.log('  PASS  ' + n);
  } else {
    fails.push(n);
    console.log('  FAIL  ' + n + (d ? '\n          ' + d : ''));
  }
};

(async () => {
  const probe = await db.query('SELECT 1 AS ok', []);
  REAL_DB = Boolean(probe && probe.rows && probe.rows[0]);
  if (REAL_DB) {
    const n = (await db.query('SELECT count(*)::int AS n FROM bot_part_aliases', [])).rows[0].n;
    if (n > 0 && process.env.ALIAS_TEST_ALLOW_NONEMPTY !== 'yes') {
      console.error('\nREFUSING TO RUN: bot_part_aliases already holds ' + n + ' row(s).');
      console.error('This suite writes fabricated phrases. Point DATABASE_URL at a throwaway');
      console.error('database, or set ALIAS_TEST_ALLOW_NONEMPTY=yes if those rows are disposable.\n');
      process.exit(1);
    }
    console.log('\nRunning against REAL Postgres + pgvector — the actual SQL is exercised\n');
  } else {
    console.log('\nRunning offline: stand-in database, fake embeddings');
    console.log('  The SQL itself is therefore NOT exercised by this run.\n');
    db._setPoolForTests(standInPool());
  }

  embeddings.embed = async (t) => fakeEmbed(t);
  embeddings.embedBatch = async (ts) => ts.map((t) => fakeEmbed(t));
  embeddings.available = () => true;

  const aliases = require('../src/core/parts/aliases');
  const knowledge = require('../src/core/knowledge');
  const escalation = require('../src/core/escalation');

  console.log('WHAT IS WORTH REMEMBERING');
  check('a sentence is', aliases.worthRemembering('swift ka clutch plate chahiye'));
  check('one word is not', !aliases.worthRemembering('clutch'));
  check(
    'a part number is not — those are found exactly or not at all',
    !aliases.worthRemembering('ctwbsi26p 16'),
    'a nearest-neighbour hit on a part number is how the wrong part gets quoted',
  );

  console.log('\nTHE BUG ITSELF');
  await aliases.remember({
    phrase: 'swift ka clutch plate chahiye',
    partNo: '22400M74L00',
    partName: 'Clutch Plate | | Maruti Swift | Petrol',
    source: 'helper',
  });

  const same = await aliases.recall('swift ka clutch plate chahiye');
  check('the words he answered come back', same && same.partNo === '22400M74L00' && same.exact === true);

  const reworded = await aliases.recall('clutch plate chahiye swift ke liye 2 pcs');
  check(
    'THE SAME QUESTION IN OTHER WORDS comes back too',
    reworded && reworded.partNo === '22400M74L00',
    reworded ? 'got ' + JSON.stringify(reworded).slice(0, 120) : 'got nothing — he would be asked again',
  );

  // THE ONE FROM THE LOG, 23 Sep, exactly as it happened. The customer wrote
  // "Cartend ka Horan 5 set" twice. The understand model called it "Cartend
  // Horn" the first time, the specialist answered CTHNKAM889WP, and THAT is the
  // wording that went into the alias map — so when the model called the same
  // message "Cartend ka Horan" the second time, nothing matched and he was asked
  // again. Two words apart, and one of them spelled by ear.
  await aliases.remember({ phrase: 'Cartend Horn', partNo: 'CTHNKAM889WP', partName: 'Horn | | Cartrends', source: 'helper' });
  const horn = await aliases.recall('Cartend ka Horan');
  check(
    'THE HORN: "cartend ka horan" finds what "cartend horn" was taught',
    horn && horn.partNo === 'CTHNKAM889WP',
    horn ? 'got ' + JSON.stringify(horn).slice(0, 130) : 'got nothing',
  );
  const hornQty = await aliases.recall('Cartend ka Horan 5 set');
  check('...and the quantity they wrote does not change the answer', hornQty && hornQty.partNo === 'CTHNKAM889WP');

  console.log('\nWHAT IT REFUSES TO ANSWER');
  const otherPart = await aliases.recall('rear shocker alto');
  check(
    'a part nobody has taught it is not guessed at',
    !otherPart || !otherPart.partNo,
    otherPart ? 'answered ' + otherPart.partNo : '',
  );

  await aliases.remember({ phrase: 'cartrends wiper blade 16 inch', partNo: 'CTWBSI26P-16 Inch', partName: 'Wiper Blade | 16 Inches', source: 'helper' });
  const wrongSize = await aliases.recall('cartrends wiper blade 22 inch');
  check(
    'a different SIZE is not answered from the one we know',
    !wrongSize || !wrongSize.partNo,
    wrongSize && wrongSize.partNo ? 'answered ' + wrongSize.partNo + ' for a 22 inch blade' : '',
  );

  const someoneElsesHorn = await aliases.recall('fortuner ka horn');
  check(
    'another brand of the SAME part is not answered from it',
    !someoneElsesHorn || !someoneElsesHorn.partNo,
    someoneElsesHorn && someoneElsesHorn.partNo ? 'answered ' + someoneElsesHorn.partNo : '',
  );

  const wrongBrand = await aliases.recall('fortuner wiper blade 16 inch');
  check(
    'a different BRAND is not answered from the one we know',
    !wrongBrand || !wrongBrand.partNo,
    wrongBrand && wrongBrand.partNo ? 'answered ' + wrongBrand.partNo + ' for a Fortuner blade' : '',
  );

  // Two phrases, one meaning, two different parts: nobody can tell which was
  // meant, so nobody should try.
  await aliases.remember({ phrase: 'brezza air filter', partNo: '13780M79P00', partName: 'Air Filter | | Brezza', source: 'helper' });
  await aliases.remember({ phrase: 'brezza air filter petrol', partNo: '13780M79P99', partName: 'Air Filter | | Brezza Petrol', source: 'helper' });
  const tie = await aliases.recall('air filter brezza ka');
  check(
    'two remembered parts too close to call go to a person',
    !tie || !tie.partNo,
    tie && tie.partNo ? 'picked ' + tie.partNo + ' between two' : '',
  );

  console.log('\nA QUESTION IS NOT A PART');
  const hours = await aliases.recall('kya tum log sunday ko khule ho');
  check('opening hours are never answered with a part number', !hours || !hours.partNo);

  console.log('\nEND TO END: DOES A PERSON GET ASKED?');
  let toHelper = [];
  let toCustomer = [];
  const transport = {
    number: '919289015775', mode: 'CLOUD', state: 'connected',
    sendText: async (to, t) => { toHelper.push({ to, t }); return 'wamid.H' + toHelper.length; },
    sendToChat: async (c, t) => { toCustomer.push({ chat: c, t }); return 'w'; },
    onMessage: () => {},
  };
  const bot = {
    key: 'customer', transport, inquiryOnly: () => false,
    askToConfirmLater: () => {}, answerInquiry: async () => 'inq', offerPriced: async () => {},
  };
  bot._allBots = { customer: bot };
  const ask = (item, phone) =>
    escalation.create(bot, {
      chatId: phone + '@c.us', item, qty: 1, kind: 'order', reason: 'NOT_IN_CATALOGUE',
      customerPhone: phone, customerMessageId: 'wamid.C',
    });

  // Nothing learned about this one anywhere: a person is asked, as always.
  portalRows = [];
  toHelper = [];
  const first = await ask('bonnet kabza baleno left side', '919000000001');
  check('an unknown part still reaches a person', toHelper.length === 1 && typeof first === 'number', 'sent ' + toHelper.length);

  // He answers. The phrase is learned both ways — the string key and the
  // meaning.
  toCustomer = [];
  await escalation.handleReply({ from: '919999492550', body: '#' + first + ' 48310M74L00', isGroup: false });
  check('his answer reaches the customer', toCustomer.length >= 1, JSON.stringify(toCustomer).slice(0, 120));
  check('and the exact words are learned', knowledge.lookupAlias('bonnet kabza baleno left side') === '48310M74L00');

  // A DIFFERENT customer, a DIFFERENT wording, the same part. Before this
  // change he was asked a second time.
  toHelper = [];
  toCustomer = [];
  const second = await ask('left side bonnet kabza chahiye baleno ka', '919000000002');
  check(
    'THE NEXT CUSTOMER, IN THEIR OWN WORDS, DOES NOT REACH HIM',
    toHelper.length === 0,
    toHelper.length ? 'he was asked again: ' + String(toHelper[0].t).slice(0, 80) : '',
  );
  check('and that customer is answered anyway', toCustomer.length >= 1 && second === null, 'replies: ' + toCustomer.length);

  console.log('\nOFF WITHOUT A DATABASE');
  // The whole feature is additive: with DATABASE_URL unset the bot behaves
  // exactly as it did, which is what makes it safe to deploy.
  const url = require('../src/config').kb.databaseUrl;
  require('../src/config').kb.databaseUrl = '';
  const dead = await aliases.recall('swift ka clutch plate chahiye');
  const kept = await aliases.remember({ phrase: 'something new entirely here', partNo: '1234', source: 'helper' });
  require('../src/config').kb.databaseUrl = url;
  check('recall is silent, not broken', dead === null);
  check('learning is silent, not broken', kept === false);

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) {
    console.log('failed: ' + fails.join('; '));
    process.exit(1);
  }
  await db.close().catch(() => {});
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
