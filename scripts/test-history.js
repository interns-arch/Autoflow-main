#!/usr/bin/env node
'use strict';
// Tests A-G for the historical-chat import (spec section 20).
//
// The pure parsing and part-matching tests always run. The rest need a real
// Postgres, because that is where the behaviour being tested lives; without
// one they are reported as SKIPPED rather than quietly passing.
//
// Nothing production is touched: every row this writes carries a TEST-
// conversation id and is deleted at the end, and it refuses to truncate
// anything.
require('dotenv').config();

const parser = require('../src/core/history/parser');
const extract = require('../src/core/history/extract');
const knowledge = require('../src/core/knowledge');

let pass = 0;
let skipped = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fails.push(name);
    console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : ''));
  }
}
function skip(name, why) {
  skipped++;
  console.log('  SKIP  ' + name + '  (' + why + ')');
}

const SAMPLE = [
  'Messages and calls are end-to-end encrypted.',
  '[8/6/26, 12:36:25 PM] +91 98919 89965: 5pcs shocker buffer 42111M79M00',
  '[8/6/26, 12:36:26 PM] +91 98919 89965: 3pcs wiper bottel 38450M72R00',
  '[8/6/26, 12:40:00 PM] Alam - Founder Team - Cartrend: dono available hai sir, 4 pcs hai stock me',
  '[8/6/26, 12:41:00 PM] +91 98919 89965: CTWB 18 milega?',
  '[8/6/26, 12:42:00 PM] Alam - Founder Team - Cartrend: haan CTWBSI26P-18INCH available hai',
  '[8/6/26, 12:43:00 PM] Lakshmi Motor Co Ct: Please share invoices',
  '[8/6/26, 12:44:00 PM] Rahul Sinha - Warehouse - Cartrend: OK SIR',
  '[7/24/26, 4:37:42 PM] - You added Bhawna - CRM - Cartrend',
].join('\n');

async function main() {
  console.log('\nHISTORICAL CHAT IMPORT — tests A to G\n');

  // ---------------------------------------------------------------- A (parse)
  const { messages, senders, systemLines } = parser.parseChat(SAMPLE, 'TEST-chat');
  // 7 conversation lines; the encryption notice and the 'You added' line are not messages.
  check('A. export parses into messages', messages.length === 7, 'got ' + messages.length);
  check('A. system lines are not messages', systemLines === 1, 'got ' + systemLines);
  const types = {};
  for (const [, v] of senders) types[v.type] = (types[v.type] || 0) + 1;
  check(
    'A. employees and customers are told apart',
    types.EMPLOYEE === 2 && types.CUSTOMER === 2 && !types.UNKNOWN,
    JSON.stringify(types),
  );
  const got = extract.fromChat(messages, 'TEST-chat');
  check('A. order lines become part mappings', got.mappings.length === 2, 'got ' + got.mappings.length);
  check(
    'A. the customer\'s own spelling is kept',
    got.mappings.some((m) => m.phrase === 'wiper bottel'),
    JSON.stringify(got.mappings.map((m) => m.phrase)),
  );

  // ------------------------------------------------------- C (normalisation)
  const forms = ['CTWB 18', 'CTWB18', 'ctwb-18', 'CTWB-18'];
  const normalised = new Set(forms.map(extract.normalizePart));
  check('C. the four ways of typing one part normalise together', normalised.size === 1, [...normalised].join(', '));

  // --------------------------------------------------------- D (false match)
  // The real guard lives in the bot's alias store, so it is tested there.
  const DATA = require('path').join(require('os').tmpdir(), 'autoflow-hist-test');
  require('fs').mkdirSync(DATA, { recursive: true });
  require('fs').writeFileSync(require('path').join(DATA, 'state.json'), '{}');
  process.env.DATA_DIR = DATA;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/core/knowledge')];
  const k2 = require('../src/core/knowledge');
  k2.learnAlias('CTWB 18', 'CTWBSI26P-18INCH', 'historical_chat');
  check(
    'C. a learned shortcut is found however it is retyped',
    forms.every((f) => k2.lookupAlias(f) === 'CTWBSI26P-18INCH'),
    forms.map((f) => f + '=' + k2.lookupAlias(f)).join(' | '),
  );
  const wrong = ['CTWB180', 'CTWB19', 'XCTWB18'];
  check(
    'D. near-miss part numbers never match it',
    wrong.every((w) => !k2.lookupAlias(w)),
    wrong.map((w) => w + '=' + k2.lookupAlias(w)).join(' | '),
  );

  // ------------------------------------------------------- families (H)
  // Ambiguous names are variant families, chosen by words instead of by the
  // inch sizes the wiper family uses.
  const fam = require('../src/core/history/families');

  check(
    'H. the portal name is parsed into part / side / models',
    (() => {
      const p = fam.parsePortalName('Bonnet Hinge| Right Side | Ciaz / Ertiga 2nd Gen | Petrol / CNG');
      return p.what === 'bonnet hinge' && p.side === 'right side' && /ciaz/.test(p.models);
    })(),
  );
  check(
    'H. fuel is not mistaken for a car model',
    !/petrol/.test(fam.parsePortalName('Air Filter Ciaz / SCross (1.5 K15) | Petrol / CNG').models),
    fam.parsePortalName('Air Filter Ciaz / SCross (1.5 K15) | Petrol / CNG').models,
  );
  check(
    'H. a part the portal calls something else is not accepted',
    fam.namesAgree('clutch plate', 'Clutch Plate|  | Baleno | Petrol') === true &&
      fam.namesAgree('clutch bearing', 'Clutch Master Cylinder|  | Ciaz | Petrol') === false,
  );
  check(
    'H. a catalogue entry flagged VERIFY is not used',
    fam.portalIsUnsure("VERIFY - code '82S' (needs Maruti catalogue / photo)") === true &&
      fam.portalIsUnsure('Clutch Plate|  | Baleno | Petrol') === false,
  );

  k2.learnFamily(
    'air filter',
    [
      { key: 'brezza', label: 'Brezza / Fronx', partNo: 'A-1', match: ['brezza', 'fronx'] },
      { key: 'scross', label: 'Ciaz / SCross', partNo: 'B-2', match: ['scross'] },
      { key: 'diesel', label: 'Ciaz diesel', partNo: 'C-3', match: ['diesel'] },
    ],
    'historical_chat',
  );
  const pick = (q) => {
    const f = k2.familyFor(q);
    return f && f.variant ? f.variant.partNo : f ? 'ASKS' : 'NONE';
  };
  check('H. a named model picks its own variant', pick('air filter brezza') === 'A-1' && pick('air filter scross') === 'B-2', pick('air filter brezza') + ' / ' + pick('air filter scross'));
  check('H. a bare name asks instead of guessing', pick('air filter') === 'ASKS', pick('air filter'));
  check(
    'H. a word shared by two variants also asks',
    (() => {
      k2.learnFamily(
        'fan assy',
        [
          { key: 'wagonr', label: 'WagonR', partNo: 'W-1', match: ['wagonr'] },
          { key: 'ciaz', label: 'Ciaz / Ertiga', partNo: 'C-1', match: ['ciaz'] },
        ],
        'historical_chat',
      );
      return pick('fan assy') === 'ASKS' && pick('fan assy wagonr') === 'W-1';
    })(),
  );


  // --------------------------------------------------------- F (dynamic data)
  const reply = 'dono available hai sir, 4 pcs hai stock me';
  check('F. a reply quoting stock is flagged as dynamic', extract.hasDynamicFacts(reply) === true);
  const patt = extract.responsePattern(reply);
  check('F. the stored pattern has the number taken out', !/\b4\b/.test(patt), 'pattern: ' + patt);
  check('F. ...and still reads like the person wrote it', /available/i.test(patt), 'pattern: ' + patt);

  // ------------------------------------------------------------ intents seen
  const intents = new Set(got.examples.map((e) => e.intent));
  check('intents are assigned to examples', intents.size >= 1, [...intents].join(', '));

  // ------------------------------------------------------- database-backed
  const db = require('../src/core/kb/db');
  const health = await db.health();
  if (!health.ok) {
    for (const t of [
      'B. importing the same ZIP twice adds nothing',
      'E. a reworded question finds the historical example',
      'F. current stock wins over the historical number',
      'G. one dealer\'s commercial chat is not shown to another',
    ]) {
      skip(t, (health.reason || 'no database') + ' — needs a real Postgres');
    }
  } else {
    const history = require('../src/core/history');
    const repo = require('../src/core/history/repository');
    const embeddings = require('../src/core/kb/embeddings');
    const crypto = require('crypto');
    const CONV = 'TEST-history-suite';

    const cleanup = async () => {
      await db.query('DELETE FROM historical_chat_examples WHERE conversation_id = $1', [CONV]);
    };
    await cleanup();

    const mk = async (customerMessage, employeeResponse, over = {}) => {
      const e = {
        conversationId: CONV,
        messageId: 'm' + Math.random(),
        contentHash: crypto.createHash('sha256').update(CONV + customerMessage + employeeResponse).digest('hex'),
        customerMessage,
        employeeResponse,
        responsePattern: extract.responsePattern(employeeResponse),
        hasDynamicFacts: extract.hasDynamicFacts(employeeResponse),
        intent: 'CHECK_STOCK',
        employeeAction: 'check_stock',
        resolvedPartNo: 'CTWBSI26P-18INCH',
        normalizedPartNo: 'CTWB18',
        scope: 'global',
        reviewStatus: 'approved',
        confidence: 0.8,
        ...over,
      };
      e.embedding = await embeddings.embed(history.searchableExample(e));
      return repo.upsertExample(e, null);
    };

    // B — the same content twice is one row
    const first = await mk('CTWB 18 milega?', 'haan CTWBSI26P-18INCH available hai');
    const again = await mk('CTWB 18 milega?', 'haan CTWBSI26P-18INCH available hai');
    check(
      'B. importing the same content twice adds nothing',
      first === 'inserted' && again === 'duplicate',
      first + ' then ' + again,
    );

    if (!embeddings.available()) {
      skip('E. a reworded question finds the historical example', 'no embedding key');
      skip('G. one dealer\'s commercial chat is not shown to another', 'no embedding key');
    } else {
      // E — a different wording finds it
      const hits = await history.similar('Bhai CTWB18 available hai?', {});
      const hit = hits[0];
      check(
        'E. a reworded question finds the historical example',
        Boolean(hit) && /CTWB/i.test(String(hit.partNo || '') + String(hit.question || '')),
        hits.length ? JSON.stringify(hits[0]).slice(0, 160) : 'no matches',
      );
      check(
        'F. what comes back is the pattern, not June\'s stock figure',
        !hit || !/\b4 pcs\b/i.test(String(hit.pattern || '')),
        hit ? 'pattern: ' + hit.pattern : 'n/a',
      );

      // G — a commercial chat belonging to one dealer
      await mk('humko kitna discount milega?', 'aapko 12 percent special discount hai', {
        scope: 'customer',
        customerId: '919000000777',
        intent: 'DISCOUNT_REQUEST',
      });
      const mine = await history.similar('discount kitna hai', { customerId: '919000000777' });
      const theirs = await history.similar('discount kitna hai', { customerId: '919000000888' });
      check(
        'G. the dealer it belongs to can see it',
        mine.some((m) => /discount/i.test(String(m.question))),
        JSON.stringify(mine).slice(0, 140),
      );
      check(
        'G. another dealer cannot',
        !theirs.some((m) => /12 percent|discount/i.test(String(m.pattern || '') + String(m.question || ''))),
        JSON.stringify(theirs).slice(0, 140),
      );
    }
    await cleanup();
  }

  console.log('\n' + pass + ' passed, ' + fails.length + ' failed' + (skipped ? ', ' + skipped + ' skipped' : '') + '\n');
  if (fails.length) process.exit(1);
}

main()
  .then(async () => {
    try {
      await require('../src/core/kb/db').close();
    } catch (_) {}
  })
  .catch((e) => {
    console.error('\nsuite crashed: ' + String((e && e.stack) || e));
    process.exit(1);
  });
