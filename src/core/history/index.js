'use strict';
// Importing exported WhatsApp history, and using it afterwards.
//
// The governing rule, and the reason this is not just "embed every message"
// (spec sections 3, 7 and 21):
//
//   history tells us what was ASKED, what a part is CALLED, and how our
//   people WRITE. It never tells us what is in stock, what something costs,
//   or what discount applies. Those come from the portal every time.
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');

const config = require('../../config');
const store = require('../../store');
const knowledge = require('../knowledge');
const embeddings = require('../kb/embeddings');
const db = require('../kb/db');
const parser = require('./parser');
const extract = require('./extract');
const repository = require('./repository');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function enabled() {
  return db.configured();
}

// What gets embedded for an example: the question, what it was about, and the
// pattern of the reply — never the reply's live numbers.
function searchableExample(e) {
  return [e.customerMessage, e.intent, e.normalizedPartNo || '', e.employeeAction || '', e.responsePattern || '']
    .filter(Boolean)
    .join('\n');
}

// Commercial wording in a dealer's own chat belongs to that dealer (spec 15,
// 16). "We get 12% special discount" must never become everyone's answer.
const COMMERCIAL = /\b(discount|rate|price|mrp|margin|credit|outstanding|ledger|scheme|special)\b/i;

function scopeFor(e) {
  if (COMMERCIAL.test(e.customerMessage + ' ' + e.employeeResponse)) {
    return e.customerId ? { scope: 'customer', review: 'pending_review' } : { scope: 'global', review: 'pending_review' };
  }
  return { scope: 'global', review: 'pending_review' };
}

// ------------------------------------------------------------------ import
//
// Idempotent on the ZIP's own bytes and, inside it, on each example's content.
// Re-importing the same file is a no-op; importing an overlapping export adds
// only what is new.
async function importZip(zipPath, opts = {}) {
  if (!enabled()) throw new Error('DATABASE_URL is not set — nothing to import into');
  const buf = fs.readFileSync(zipPath);
  const fileHash = sha(buf);
  const fileName = path.basename(zipPath);

  const already = await repository.findImport(fileHash);
  if (already && !opts.force) {
    return { skipped: true, reason: 'this exact file was imported on ' + already.imported_at, importId: already.id };
  }

  const row = await repository.createImport(fileName, fileHash);
  const importId = row ? row.id : already && already.id;

  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && /chat\.txt$/i.test(e.entryName));

  const stats = {
    files: 1, chats: 0, messages: 0, noise: 0, media: 0, systemLines: 0,
    customerMessages: 0, employeeMessages: 0, pairs: 0,
    examples: 0, duplicates: 0, mappings: 0, mappingRows: 0,
    orderLines: 0, parts: 0, intents: {}, senders: { EMPLOYEE: 0, CUSTOMER: 0, UNKNOWN: 0 },
    portalChecked: 0, portalConfirmed: 0, autoApproved: 0, needsReview: 0,
  };

  // A chat export with no chat.txt (some tools export only .md).
  if (!entries.length) {
    const md = zip.getEntries().filter((e) => /chat\.md$/i.test(e.entryName));
    if (md.length) throw new Error('this ZIP has only chat.md — export the chat again with the .txt included');
    throw new Error('no chat.txt found in ' + fileName);
  }

  const allMappings = new Map();
  const seenParts = new Set();

  for (const entry of entries) {
    // The conversation id is the folder the chat came from, which for these
    // exports is the dealer's group name — stable across re-exports.
    const conversationId =
      path.dirname(entry.entryName) === '.' ? fileName.replace(/\.zip$/i, '') : path.dirname(entry.entryName);
    const raw = entry.getData().toString('utf8');
    const { messages, senders, systemLines } = parser.parseChat(raw, conversationId);
    stats.chats++;
    stats.messages += messages.length;
    stats.systemLines += systemLines;
    stats.noise += messages.filter((m) => m.noise).length;
    stats.media += messages.filter((m) => m.media).length;
    stats.customerMessages += messages.filter((m) => m.senderType === 'CUSTOMER').length;
    stats.employeeMessages += messages.filter((m) => m.senderType === 'EMPLOYEE').length;
    for (const [, v] of senders) stats.senders[v.type] = (stats.senders[v.type] || 0) + 1;

    const got = extract.fromChat(messages, conversationId);
    stats.orderLines += got.counts.orderLines;
    for (const p of got.counts.parts) seenParts.add(p);
    for (const [k, v] of got.counts.intents) stats.intents[k] = (stats.intents[k] || 0) + v;
    stats.pairs += got.examples.length;

    for (const e of got.examples) {
      const placed = scopeFor(e);
      e.scope = placed.scope;
      e.reviewStatus = placed.review;
      e.contentHash = sha(conversationId + '|' + e.customerMessage + '|' + e.employeeResponse);
      e.confidence = e.intent === 'OTHER' ? 0.3 : 0.6;
      const vec = opts.embed === false ? null : await embeddings.embed(searchableExample(e));
      e.embedding = vec;
      const outcome = await repository.upsertExample(e, importId);
      if (outcome === 'inserted') stats.examples++;
      else stats.duplicates++;
    }

    for (const m of got.mappings) {
      const k = m.normalizedPhrase + '||' + m.normalizedPartNo;
      const prev = allMappings.get(k);
      if (prev) {
        prev.evidence += m.evidence;
        for (const c of m.conversations) prev.conversations.add(c);
      } else {
        allMappings.set(k, { ...m, conversations: new Set(m.conversations) });
      }
    }
  }
  stats.parts = seenParts.size;

  // ---- part mappings: count the evidence, then ask the portal ----
  const byPhrase = new Map();
  for (const m of allMappings.values()) {
    if (!byPhrase.has(m.normalizedPhrase)) byPhrase.set(m.normalizedPhrase, []);
    byPhrase.get(m.normalizedPhrase).push(m);
  }

  for (const [, rivals] of byPhrase) {
    const total = rivals.reduce((s, r) => s + r.evidence, 0);
    for (const m of rivals) {
      const competing = rivals.filter((r) => r !== m).map((r) => ({ partNo: r.resolvedPartNo, evidence: r.evidence }));
      // Confidence is the share of the evidence this reading holds. One name
      // pointing at three part numbers is a variant family, not a mapping, and
      // scores low on purpose.
      const confidence = total ? m.evidence / total : 0;
      const saved = await repository.upsertMapping({
        phrase: m.phrase,
        normalizedPhrase: m.normalizedPhrase,
        resolvedPartNo: m.resolvedPartNo,
        normalizedPartNo: m.normalizedPartNo,
        evidenceCount: m.evidence,
        competingParts: competing,
        confidence,
        sourceConversations: [...m.conversations],
        firstSeenAt: m.firstSeen || null,
        lastSeenAt: m.lastSeen || null,
      });
      if (!saved) continue;
      stats.mappingRows++;
      if (saved.inserted) stats.mappings++;

      // THE PORTAL IS THE AUTHORITY. A chat is evidence that somebody typed a
      // number; only the catalogue says it is real.
      let verified = null;
      let portalName = null;
      if (opts.verify !== false) {
        const hit = await portalLookup(m.resolvedPartNo);
        stats.portalChecked++;
        verified = Boolean(hit);
        portalName = hit ? hit.name : null;
        if (hit) stats.portalConfirmed++;
        await repository.setMappingPortal(saved.id, verified, portalName);
      }

      // Approved automatically only when nothing competes with it AND the
      // portal carries the part. Everything else waits for a person.
      const safe = competing.length === 0 && verified === true && m.evidence >= (opts.minEvidence || 1);
      if (safe) {
        await repository.setMappingStatus(saved.id, 'approved', false);
        stats.autoApproved++;
      } else {
        await repository.setMappingStatus(saved.id, 'pending_review', false);
        stats.needsReview++;
      }
    }
  }

  if (importId) await repository.finishImport(importId, stats);
  store.log('history', `imported ${fileName}: ${stats.examples} example(s), ${stats.mappings} mapping(s)`);
  return { skipped: false, importId, stats };
}

// Does the dealer portal carry this part number?
async function portalLookup(partNo) {
  try {
    const portal = require('../../integrations/dealerPortal');
    const rows = ((await portal.searchByName(partNo, 5)) || {}).top || [];
    const want = extract.normalizePart(partNo);
    return rows.find((r) => extract.normalizePart(r.partNo) === want) || null;
  } catch (e) {
    store.log('history', 'portal check failed for ' + partNo + ': ' + String((e && e.message) || e).slice(0, 80));
    return null;
  }
}

// Write approved mappings into the bot's OWN alias store, which is what the
// live lookup actually consults. Kept separate from approval so a person can
// approve first and apply deliberately.
async function applyApprovedMappings(limit = 500) {
  const rows = await repository.listMappings({ status: 'approved', applied: false, limit });
  let applied = 0;
  for (const m of rows) {
    // Never overwrite something a person taught directly.
    const existing = knowledge.lookupAlias(m.phrase);
    if (existing && extract.normalizePart(existing) !== m.normalized_part_no) {
      store.log('history', `alias for "${m.phrase}" already points at ${existing} — left alone`);
      await repository.setMappingStatus(m.id, 'rejected', false);
      continue;
    }
    knowledge.learnAlias(m.phrase, m.resolved_part_no, 'historical_chat');
    await repository.setMappingStatus(m.id, 'approved', true);
    applied++;
  }
  return applied;
}

// --------------------------------------------------------------- retrieval
//
// Similar things people have asked before. Returned as CONTEXT — what the
// question probably means and which part it is probably about — never as the
// answer. The caller still checks the portal.
async function similar(question, { customerId = null, agentId = null, limit = 3 } = {}) {
  if (!enabled()) return [];
  const vec = await embeddings.embed(String(question || ''));
  if (!vec) return [];
  const rows = await repository.searchExamples(vec, { customerId, agentId, limit });
  const threshold = config.kb.similarityThreshold;
  const out = [];
  for (const r of rows) {
    if (Number(r.similarity) < threshold) continue;
    await repository.noteExampleUsed(r.id);
    out.push({
      id: r.id,
      similarity: Number(r.similarity),
      question: r.customer_message,
      intent: r.intent,
      action: r.employee_action,
      partNo: r.resolved_part_no,
      // The pattern, not the original: the original may quote June's stock.
      pattern: r.response_pattern,
      hasDynamicFacts: r.has_dynamic_facts,
    });
  }
  return out;
}

async function backfillEmbeddings(limit = 100) {
  if (!enabled() || !embeddings.available()) return 0;
  const rows = await repository.examplesNeedingEmbedding(limit);
  let n = 0;
  for (const r of rows) {
    const vec = await embeddings.embed(
      searchableExample({
        customerMessage: r.customer_message,
        intent: r.intent,
        normalizedPartNo: r.normalized_part_no,
        employeeAction: r.employee_action,
        responsePattern: r.response_pattern,
      }),
    );
    if (!vec) break;
    await repository.setExampleEmbedding(r.id, vec);
    n++;
  }
  return n;
}

module.exports = {
  enabled,
  importZip,
  similar,
  applyApprovedMappings,
  backfillEmbeddings,
  portalLookup,
  searchableExample,
  scopeFor,
  listImports: repository.listImports,
  listExamples: repository.listExamples,
  listMappings: repository.listMappings,
  mappingById: repository.mappingById,
  setExampleStatus: repository.setExampleStatus,
  setMappingStatus: repository.setMappingStatus,
  intentCounts: repository.intentCounts,
};
