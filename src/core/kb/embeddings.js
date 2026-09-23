'use strict';
// Text -> vector, using Gemini's embedding endpoint and the GEMINI_API_KEY the
// vision and voice paths already use. Anthropic has no embeddings API, which
// is the only reason this is not Claude like everything else in the bot.
//
// There is NO offline fallback on purpose. A "roughly similar" vector computed
// from word overlap would look exactly like a real one to everything
// downstream, and the first time it matched the wrong question the bot would
// answer a customer confidently and wrongly. When embedding is unavailable,
// this returns null, retrieval finds nothing, and a person gets asked.
const config = require('../../config');
const store = require('../../store');

// The same question arrives many times a day in slightly different words, but
// identical text is common enough (menu prompts, repeated asks) to be worth a
// small cache. Bounded, because this process is long-lived.
const CACHE_MAX = 500;
const cache = new Map();

function cached(text) {
  const hit = cache.get(text);
  if (!hit) return undefined;
  // Refresh recency: Map preserves insertion order, so re-inserting moves it
  // to the end and the oldest key is the first one out.
  cache.delete(text);
  cache.set(text, hit);
  return hit;
}

function remember(text, vec) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(text, vec);
}

function available() {
  return Boolean(config.gemini && config.gemini.apiKey);
}

// What actually gets embedded. The question alone is too thin — two questions
// about different things ("return policy", "delivery time") share most of
// their words — so the answer and the labels go in with it, which is what
// makes "Ye part wapas ho sakta hai?" land on the returns entry.
function searchableText(entry) {
  return [
    entry.canonical_question || entry.question || '',
    entry.answer || '',
    entry.category || '',
    entry.subcategory || '',
    (entry.keywords || []).join(' '),
  ]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join('\n');
}

// -> number[] of config.kb.embeddingDim, or null when it cannot be had.
async function embed(text) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return null;
  if (!available()) return null;

  const hit = cached(clean);
  if (hit !== undefined) return hit;

  const model = config.kb.embeddingModel;
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':embedContent';

  // 500-class is the model being busy and is worth one more ask; 429 is a
  // spent quota and is not. Same rule the vision path already follows.
  const RETRY_ON = new Set([500, 502, 503, 504]);
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt));
    try {
      res = await fetch(url + '?key=' + encodeURIComponent(config.gemini.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/' + model,
          content: { parts: [{ text: clean }] },
          outputDimensionality: config.kb.embeddingDim,
        }),
        signal: AbortSignal.timeout(config.kb.embeddingTimeoutMs),
      });
    } catch (e) {
      store.log('kb', 'embedding request failed: ' + String((e && e.message) || e).slice(0, 100));
      return null;
    }
    if (res.ok || !RETRY_ON.has(res.status)) break;
  }
  if (!res || !res.ok) {
    store.log('kb', 'embedding HTTP ' + (res ? res.status : '?') + ' for ' + model);
    return null;
  }

  let vec = null;
  try {
    const data = await res.json();
    vec = ((data.embedding || {}).values || data.values || null);
  } catch (e) {
    store.log('kb', 'embedding reply was not JSON: ' + String((e && e.message) || e).slice(0, 80));
    return null;
  }
  if (!Array.isArray(vec) || !vec.length) return null;

  // A width that does not match the column makes every later search fail with
  // a Postgres error rather than a bad answer, but it fails for EVERY question
  // from then on — so it is caught here, once, with a message that says what
  // to change.
  if (vec.length !== config.kb.embeddingDim) {
    store.log(
      'kb',
      'embedding width ' + vec.length + ' but EMBEDDING_DIM=' + config.kb.embeddingDim + ' and the column is vector(' + config.kb.embeddingDim + ')',
    );
    return null;
  }

  remember(clean, vec);
  return vec;
}

// MANY AT ONCE.
//
// A catalogue of 100,000 parts is 100,000 embeddings. One call each is days of
// wall clock; a hundred per call is about half an hour. Measured against the
// live endpoint (23 Sep): 100 vectors in 1.68s, and 250 is refused — the
// batch ceiling is 100.
//
// -> array the same length as `texts`, with null wherever one could not be
// embedded. Never throws: the caller stores what came back and tries the rest
// later.
const BATCH_MAX = 100;

async function embedBatch(texts) {
  const list = (texts || []).map((t) => String(t == null ? '' : t).trim());
  if (!list.length) return [];
  if (!available()) return list.map(() => null);

  const out = new Array(list.length).fill(null);
  const model = config.kb.embeddingModel;
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':batchEmbedContents';

  for (let start = 0; start < list.length; start += BATCH_MAX) {
    const slice = list.slice(start, start + BATCH_MAX);
    // A cached vector still counts; only the unseen ones are sent.
    const need = [];
    slice.forEach((t, i) => {
      const hit = t ? cached(t) : null;
      if (hit !== undefined && hit !== null) out[start + i] = hit;
      else if (t) need.push({ i: start + i, text: t });
    });
    if (!need.length) continue;

    const body = {
      requests: need.map((n) => ({
        model: 'models/' + model,
        content: { parts: [{ text: n.text }] },
        outputDimensionality: config.kb.embeddingDim,
      })),
    };

    let res = null;
    // 429 is a rate limit, and on a run this long it WILL happen. Backing off
    // and carrying on is the difference between a finished import and a half
    // one.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
      try {
        res = await fetch(url + '?key=' + encodeURIComponent(config.gemini.apiKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(config.kb.embeddingTimeoutMs, 30000)),
        });
      } catch (e) {
        store.log('kb', 'batch embedding request failed: ' + String((e && e.message) || e).slice(0, 90));
        res = null;
        continue;
      }
      if (res.ok || ![429, 500, 502, 503, 504].includes(res.status)) break;
    }
    if (!res || !res.ok) {
      store.log('kb', 'batch embedding HTTP ' + (res ? res.status : '?') + ' for ' + need.length + ' item(s)');
      continue; // leave them null; the caller will come back for them
    }

    let vectors = [];
    try {
      const data = await res.json();
      vectors = (data.embeddings || []).map((e) => (e && e.values) || null);
    } catch (e) {
      store.log('kb', 'batch embedding reply was not JSON');
      continue;
    }
    need.forEach((n, k) => {
      const v = vectors[k];
      if (!Array.isArray(v) || v.length !== config.kb.embeddingDim) return;
      remember(n.text, v);
      out[n.i] = v;
    });
  }
  return out;
}

// pgvector's text form: '[0.1,0.2,...]'. Passed as a string parameter and cast
// in SQL, which is how the driver and the extension agree on the type.
function toSqlVector(vec) {
  return '[' + vec.map((n) => (Number.isFinite(n) ? n : 0)).join(',') + ']';
}

// Cosine similarity, for the places that compare two vectors outside SQL
// (duplicate detection during learning, and the offline test suite).
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function _clearCacheForTests() {
  cache.clear();
}

module.exports = { embed, embedBatch, available, searchableText, toSqlVector, cosine, _clearCacheForTests };
