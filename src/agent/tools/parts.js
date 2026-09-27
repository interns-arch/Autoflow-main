'use strict';
// WHICH PART IS THE CUSTOMER TALKING ABOUT?
//
// Three tools, deliberately in the order the agent should reach for them:
// what we have already been taught, then the catalogue index, then the live
// portal search. The first costs nothing and is exact; the last is slow and
// is the one that quoted a Fortuner blade for a Cartrends question on 23 Sep.
//
// The guards live in here, not in the prompt. matchTrustworthy and the
// near-tie margin decide what comes back, so the model cannot talk its way
// past them — it never sees the rejected row.
const { tool } = require('langchain');
const { z } = require('zod');

const knowledge = require('../../core/knowledge');
const availability = require('../../core/availability');
const partsIndex = require('../../core/parts');
const store = require('../../store');

// What every parts tool returns, so the agent reads one shape.
//   found:    one part number it may rely on
//   options:  several — the customer has to choose, the agent must not pick
//   none:     nothing; try the next tool, or ask a person
const found = (partNo, name, how) => JSON.stringify({ result: 'found', partNo, name: name || null, how });
const options = (rows, why) =>
  JSON.stringify({
    result: 'options',
    why,
    options: rows.slice(0, 5).map((r) => ({ partNo: r.partNo || r.part_no, name: (r.name || '').slice(0, 70) })),
  });
const none = (why) => JSON.stringify({ result: 'none', why });

const lookupKnownPart = tool(
  async ({ phrase }) => {
    const asked = String(phrase || '').trim();
    if (!asked) return none('nothing was asked for');

    // 1. a phrase somebody already taught us, or a size out of a learned range
    const alias = knowledge.lookupAlias(asked);
    if (alias) return found(alias, null, 'learned earlier');

    // 2. a learned range that needs the size naming — "Cartend wiper blade"
    //    with no number. Shown, never guessed at.
    const fam = knowledge.familyFor(asked);
    if (fam && fam.variant) return found(fam.variant.partNo, fam.family.subject, 'learned range');
    if (fam) {
      return options(
        fam.family.variants.map((v) => ({ partNo: v.partNo, name: fam.family.subject + ' ' + v.label })),
        'we stock ' + fam.family.variants.length + ' of these — which one?',
      );
    }

    // 3. a part we already said is not carried. Answering from memory beats
    //    asking a person the same question a second time.
    const refused = knowledge.notCarried(asked);
    if (refused) return JSON.stringify({ result: 'not_carried', since: refused.at, why: 'we were told we do not carry this' });

    // 4. THE SAME QUESTION, IN DIFFERENT WORDS.
    //
    //    Everything above is a string key, and a string key only answers the
    //    wording it was taught. A sentence is never typed twice the same way,
    //    so a part the specialist had already named came back to him under a
    //    new phrasing. The phrases he answered are embedded (core/parts/
    //    aliases), and this finds them by meaning. It will not pick between
    //    two remembered parts, and will not answer across a brand the
    //    customer named.
    const recalled = await partsIndex.recall(asked).catch(() => null);
    if (recalled && recalled.partNo) {
      // Taught under this wording too, so the next one is the free exact hit
      // at step 1 rather than another embedding call.
      knowledge.learnAlias(asked, recalled.partNo, 'memory', { partName: recalled.name });
      return found(recalled.partNo, recalled.name, 'answered before as "' + String(recalled.phrase || '').slice(0, 40) + '"');
    }

    return none('not taught yet');
  },
  {
    name: 'lookup_known_part',
    description:
      'Resolve a part the bot has ALREADY been taught: an exact part number, a learned shortcut such as "CTWB 18", one size out of a learned range such as "Cartend wiper blade 16 number", or a question the specialist answered before in different words. ' +
      'Nearly free, and it is the only tool that knows what a person has already told us. ALWAYS TRY THIS FIRST for any message that names a part. ' +
      'Returns result "found" with a part number, "options" when the wording matches a range but not one size, "not_carried" when we were told we do not stock it, or "none" if it has not been taught.',
    schema: z.object({ phrase: z.string().describe('the customer\'s own words for the part, exactly as they wrote them') }),
  },
);

const searchCatalogueIndex = tool(
  async ({ phrase }) => {
    const asked = String(phrase || '').trim();
    if (!asked) return none('nothing was asked for');
    if (!partsIndex.enabled()) return none('the catalogue index is not configured');

    const hit = await partsIndex.find(asked);
    if (!hit) return none('nothing in the index came close');
    if (hit.partNo) return found(hit.partNo, hit.name, hit.exact ? 'exact part number' : 'catalogue index');

    // The index deliberately refuses to choose: a near-tie, or a match that
    // contradicts the brand the customer named. Both mean SHOW, never pick.
    const why = hit.contradicts
      ? 'the closest part is not the brand they asked for'
      : hit.tooClose
        ? 'two parts are too close to call'
        : 'nothing was close enough to be sure';
    return (hit.candidates || []).length ? options(hit.candidates, why) : none(why);
  },
  {
    name: 'search_catalogue_index',
    description:
      'Find a part by MEANING in the indexed catalogue. Use when lookup_known_part returned "none". ' +
      'Handles dealer wording and phonetic spelling such as "barek oil cap" or "wiper bottel". ' +
      'Returns "found" only when one part clearly wins; otherwise "options" for the customer to choose from. It will NOT guess between two close parts, and will not return a part of a different brand to the one asked for.',
    schema: z.object({ phrase: z.string().describe('the customer\'s own words for the part') }),
  },
);

const searchPortalCatalogue = tool(
  async ({ phrase }) => {
    const asked = String(phrase || '').trim();
    if (!asked) return none('nothing was asked for');
    let rows = [];
    try {
      rows = ((await availability.byName(asked)) || {}).top || [];
    } catch (e) {
      store.log('agent', 'portal catalogue search failed: ' + String((e && e.message) || e).slice(0, 80));
      return none('the dealer portal did not answer');
    }
    if (!rows.length) return none('the portal catalogue has nothing matching those words');

    // ONE ROW IS NOT THE SAME AS THE RIGHT ROW. The portal drops words it
    // cannot use, so "Cartend wiper blade 17 number" became "wiper blade 17"
    // and matched a Fortuner blade. A single hit that contradicts the question
    // is shown, not returned as the answer.
    if (rows.length === 1 && availability.matchTrustworthy(asked, rows[0])) {
      // Worth keeping: the next customer asking this way skips the search, and
      // the next one asking ANOTHER way skips it too — the words go to the
      // phrase memory, the part to the catalogue index.
      partsIndex.remember({ partNo: rows[0].partNo, name: rows[0].name }).catch(() => {});
      partsIndex
        .rememberPhrase({ phrase: asked, partNo: rows[0].partNo, partName: rows[0].name, source: 'portal' })
        .catch(() => {});
      return found(rows[0].partNo, rows[0].name, 'portal catalogue, single confident match');
    }
    return options(rows, rows.length === 1 ? 'the only match is not the brand they asked for' : rows.length + ' parts carry that name');
  },
  {
    name: 'search_portal_catalogue',
    description:
      'Search the LIVE dealer portal catalogue by name. Slower than the index. Use only when both lookup_known_part and search_catalogue_index returned "none". ' +
      'Returns "found" only when exactly one part matches AND it does not contradict what the customer said; otherwise "options". Never returns a part of a different brand as though it were the answer.',
    schema: z.object({ phrase: z.string().describe('the part name or description to search the catalogue for') }),
  },
);

module.exports = { lookupKnownPart, searchCatalogueIndex, searchPortalCatalogue };
