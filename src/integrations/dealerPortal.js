'use strict';
// Dealer Portal client — the ONLY source of stock and the ONLY place a sales
// order is punched. This process holds no stock of its own.
//
//   login    POST /auth/login                       -> access_token   [VERIFIED]
//   analyze  POST /api/v1/PUSH_ORDER/analyze        -> availability   [VERIFIED]
//   confirm  POST /api/v1/purchase-orders/confirm   -> order punched  [VERIFIED]
//
// Paths and request shapes were read off the live OpenAPI spec at
// vagmine.vagminetech.com/openapi.json (1 Sep 2026). The analyze RESPONSE
// body is declared free-form in that spec, so readAnalyzeResponse below stays
// tolerant AND keeps the raw row (`_raw`) to echo back on confirm.
//
// STILL BLOCKED: analyze returns 400 "Token user is not linked to any dealer"
// for the current credentials. A dealer-linked account is required — this is
// an account issue, not a code issue.
//
// ---------------------------------------------------------------------------
// !! THE ONE PLACE TO EDIT IF THE WIRE FORMAT TURNS OUT DIFFERENT
//
// Only `buildAnalyzeRequest` / `readAnalyzeResponse` / `buildConfirmRequest` /
// `readConfirmResponse` below know the wire format. Everything else in the
// codebase talks through the normalised shapes:
//
//   analyze(lines) -> [{ item, partNo, qty, available, vendors:[{name, qty,
//                        price, mrp, tatDays}], mrp, price, source, eta }]
//   confirm(order) -> { soNumber }
//
// The endpoint PATHS are already env-configurable (see config.dealerPortal),
// so a path change needs no code edit at all.
// ---------------------------------------------------------------------------
//
// With no DEALER_PORTAL_BASE_URL set the module runs in MOCK mode: analyze
// answers from data/mock-stock.json (if present) and confirm issues local
// SO- numbers, so the whole sales flow still runs end-to-end offline.
const config = require('../config');
const store = require('../store');

const dp = config.dealerPortal;

// ---- Token lifecycle constants ----
// The portal's access_token expires; these control proactive refresh so no
// customer request ever hits an expired token.
const TOKEN_LIFETIME_MS = dp.tokenLifetimeMs || 8 * 60 * 60 * 1000; // default 8h
const REFRESH_BEFORE_MS = dp.refreshBeforeMs || 5 * 60 * 1000;       // default 5 min

// ---- Response cache: survive token refreshes without data loss ----
// Keyed by method + path + body; entries expire after CACHE_TTL_MS.
const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — well beyond the refresh window

function cacheKey(method, urlPath, body) {
  return `${method}:${urlPath}:${body ? JSON.stringify(body) : ''}`;
}
function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) { responseCache.delete(key); return undefined; }
  return entry.data;
}
function cacheSet(key, data) {
  responseCache.set(key, { data, at: Date.now() });
}
// Periodic cleanup so the Map does not grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of responseCache) {
    if (now - v.at > CACHE_TTL_MS) responseCache.delete(k);
  }
}, CACHE_TTL_MS).unref();

// A customer name the portal HAS comes back in ~0.4 s; one it does not have
// takes ~40 s to 404 (measured 13 Sep). Four seconds is ten times the real
// answer and a tenth of the wait for "not found".
const ACCOUNT_SEARCH_MS = parseInt(process.env.DEALER_PORTAL_ACCOUNT_SEARCH_MS || '4000', 10);

function enabled() {
  return Boolean(dp.baseUrl && (dp.token || (dp.username && dp.password)));
}
const isMock = () => !enabled();

// ---------------------------------------------------------------- transport

// TWO IDENTITIES, on purpose.
//
//   'sales' — the dealer-role account the bot runs as all day. It can read
//             stock and punch orders, and that is ALL it can do.
//   'admin' — an admin-role account used only by the data-entry script, which
//             creates customers, vendors and parts.
//
// They are separate because the sales bot handles messages from outside the
// company around the clock; it has no business holding the right to create
// users or move product prices. No single portal role covers both anyway:
// `admin` has product.create/user.create but no order:create, and `dealer` has
// order:create but only product.view.own. Verified from two real logins.
//
// Each identity keeps its OWN token: the portal allows one session per user,
// so sharing a cache between them would have each login silently evict the
// other.
const sessions = {
  sales: {
    token: null,
    refresh: null,      // the rotating refresh token, so the password is sent once
    expiresAt: 0,       // Date.now() at which token becomes invalid
    refreshTimer: null, // setTimeout handle for proactive refresh
    renewing: null,     // in-flight renewal, so two callers never race
    creds: () => ({ user: dp.username, pass: dp.password, fixed: dp.token }),
  },
  admin: {
    token: null,
    refresh: null,
    expiresAt: 0,
    refreshTimer: null,
    renewing: null,
    // Falls back to the sales credentials so a deployment with only one
    // account still works — it will simply fail on create with a permission
    // error, which is far clearer than silently doing nothing.
    creds: () => ({ user: dp.adminUsername || dp.username, pass: dp.adminPassword || dp.password, fixed: dp.adminToken }),
  },
};

// Login and refresh answer in the same shape, and the portal sends it both at
// the top level and nested under `data`. `expires_at` is authoritative when
// present; `expires_in` (seconds) is the fallback.
function readAuth(data) {
  const d = (data && data.data) || {};
  const token = d.access_token || d.token || data.access_token || data.token || null;
  const refresh = d.refresh_token || data.refresh_token || null;
  const at = d.expires_at || data.expires_at || null;
  const inSec = Number(d.expires_in || data.expires_in) || 0;
  let expiresAt = at ? Date.parse(at) : 0;
  if (!Number.isFinite(expiresAt) || !expiresAt) expiresAt = inSec ? Date.now() + inSec * 1000 : 0;
  return { token, refresh, expiresAt };
}

async function login(as = 'sales') {
  const s = sessions[as];
  const { user, pass, fixed } = s.creds();
  // A permanent / refresh token skips the interactive login entirely.
  if (fixed) {
    s.token = fixed;
    s.expiresAt = Infinity; // permanent tokens do not expire
    return s.token;
  }
  const res = await fetch(dp.baseUrl + dp.loginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // NO device_id ON PURPOSE. Sending one makes the portal reject the
    // login with 409 SESSION_ALREADY_ACTIVE whenever that user is signed in
    // anywhere else. Omitting it logs in cleanly and does not disturb them.
    body: JSON.stringify({ username: user, password: pass }),
    signal: AbortSignal.timeout(dp.timeoutMs),
  });
  if (!res.ok) throw new Error(`Dealer Portal login failed (${as}): HTTP ` + res.status);
  const auth = readAuth(await res.json());
  s.token = auth.token;
  if (!s.token) throw new Error('Dealer Portal login returned no access_token');
  // Kept so every later renewal can use this instead of the password.
  s.refresh = auth.refresh;

  // ---- Token lifetime tracking ----
  // The portal's own expires_at / expires_in, else the configured default.
  s.expiresAt = auth.expiresAt || Date.now() + TOKEN_LIFETIME_MS;
  const lifetimeMs = Math.max(0, s.expiresAt - Date.now());

  // Schedule proactive refresh BEFORE the token dies.
  scheduleRefresh(as, lifetimeMs);

  const expiresInMin = Math.round(lifetimeMs / 60000);
  store.log('portal', `Dealer Portal login OK as ${user} (${as}), token valid ${expiresInMin} min, refresh in ${expiresInMin - Math.round(REFRESH_BEFORE_MS / 60000)} min`);
  return s.token;
}

// Schedule a proactive token refresh REFRESH_BEFORE_MS before expiry.
function scheduleRefresh(as, lifetimeMs) {
  const s = sessions[as];
  if (s.refreshTimer) clearTimeout(s.refreshTimer);
  const delay = Math.max(0, lifetimeMs - REFRESH_BEFORE_MS);
  s.refreshTimer = setTimeout(() => refreshSession(as), delay);
  // Don't keep the process alive just for a token timer.
  if (s.refreshTimer.unref) s.refreshTimer.unref();
}

// Trade the refresh token for a new access token — WITHOUT the password.
//
// Two things the live portal taught us on 21 Sep, both of which this depends
// on getting right:
//   * NO Authorization header. Sending one answers 401; the refresh token in
//     the body is the whole credential.
//   * The refresh token ROTATES. The reply carries a NEW one and the old one
//     dies the moment it is used — replaying it answers 401
//     AUTH_TOKEN_INVALID. So the new one must be stored, or it is the NEXT
//     renewal that fails, hours later and for no visible reason.
//
// Returns true when the session now holds a good token. Never throws: a
// refresh that cannot be done falls back to a full login, which is exactly
// what this code did before refreshing existed.
async function renewWithRefreshToken(as) {
  const s = sessions[as];
  if (!s.refresh) return false;
  try {
    const res = await fetch(dp.baseUrl + dp.refreshPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh }),
      signal: AbortSignal.timeout(dp.timeoutMs),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const auth = readAuth(await res.json());
    if (!auth.token) throw new Error('no access_token in the refresh reply');
    s.token = auth.token;
    if (auth.refresh) s.refresh = auth.refresh;
    s.expiresAt = auth.expiresAt || Date.now() + TOKEN_LIFETIME_MS;
    scheduleRefresh(as, Math.max(0, s.expiresAt - Date.now()));
    store.log('portal', `token refreshed (${as}) without a login, good for another ${Math.round((s.expiresAt - Date.now()) / 60000)} min`);
    return true;
  } catch (e) {
    // A spent or rejected refresh token is worse than none: keeping it would
    // have every later renewal try the same dead credential.
    s.refresh = null;
    store.log('portal', `token refresh failed (${as}): ${String((e && e.message) || e).slice(0, 120)} — falling back to login`);
    return false;
  }
}

// Proactive refresh: renew before the current token expires so no API call
// ever sees an expired one. The refresh token is tried first; only if that
// fails does the password come out.
async function refreshSession(as) {
  const s = sessions[as];
  const { fixed } = s.creds();
  if (fixed) return; // permanent tokens don't refresh
  try {
    store.log('portal', `proactive token refresh for ${as} — expires in ${Math.round(Math.max(0, s.expiresAt - Date.now()) / 1000)}s`);
    if (await renewWithRefreshToken(as)) return;
    s.token = null; // force login() to fetch a fresh token
    await login(as);
  } catch (e) {
    // Refresh failure is not fatal: the safety-net in api() will re-try on
    // the next actual request. Log it so the ops team sees it.
    store.log('portal', `proactive token refresh FAILED for ${as}: ${String(e.message || e).slice(0, 150)}`);
  }
}

// Everything that needs a token comes through here.
//
// Single-flight per identity: two customer messages arriving together used to
// mean two logins, and the portal allows one session per user — so they could
// evict each other. With a rotating refresh token it is worse still: the
// second renewal would be spending one the first had already used.
function ensureToken(as) {
  const s = sessions[as];
  const { fixed } = s.creds();
  if (fixed) {
    s.token = fixed;
    s.expiresAt = Infinity;
    return Promise.resolve(s.token);
  }
  const usable = s.token && s.expiresAt && Date.now() < s.expiresAt - REFRESH_BEFORE_MS;
  if (usable) return Promise.resolve(s.token);
  if (!s.renewing) {
    s.renewing = (async () => {
      if (s.token && s.refresh && (await renewWithRefreshToken(as))) return s.token;
      s.token = null;
      return login(as);
    })().finally(() => {
      s.renewing = null;
    });
  }
  return s.renewing;
}

async function api(method, urlPath, body, retry = true, as = 'sales', timeoutMs = 0) {
  const s = sessions[as];

  // ---- Safety-net expiry check ----
  // If the timer was missed (laptop sleep, event-loop stall), this catches it
  // BEFORE the fetch, not after a 401 — and renews with the refresh token
  // rather than the password.
  await ensureToken(as);

  const ck = cacheKey(method, urlPath, body);

  let res;
  try {
    // A full URL is used as it is: a few portal routes sit outside /api/v1
    // (GET /api/orders/track/{id}).
    res = await fetch(/^https?:\/\//.test(urlPath) ? urlPath : dp.baseUrl + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + s.token,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs || dp.timeoutMs),
    });
  } catch (fetchErr) {
    // Network error during a token refresh window — serve from cache if warm.
    const cached = cacheGet(ck);
    if (cached !== undefined) {
      store.log('portal', `api ${method} ${urlPath} fetch failed, serving from cache: ${String(fetchErr.message || fetchErr).slice(0, 100)}`);
      return cached;
    }
    throw fetchErr;
  }

  // A 401 is usually this identity's session being evicted by another login,
  // not a bad password — so re-login once before giving up.
  if (res.status === 401 && retry && !s.creds().fixed && s.creds().user) {
    // The clock said the token was still good and the portal disagreed, so
    // do not trust the refresh token either — start clean with a login.
    s.token = null;
    s.refresh = null;
    s.expiresAt = 0;
    return api(method, urlPath, body, false, as, timeoutMs);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const err = new Error(`Dealer Portal ${method} ${urlPath} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = parsed;
    err.code = parsed && parsed.error_code;
    throw err;
  }

  const data = await res.json();
  // ---- Cache the successful response ----
  cacheSet(ck, data);
  return data;
}

// The same door for a PDF: bytes, not JSON. Anything that is not a PDF (an
// error page, a JSON "detail") is an error, never a file sent to someone.
async function apiPdf(urlPath, retry = true, as = 'sales') {
  const s = sessions[as];
  // Safety-net expiry check (same as api()).
  await ensureToken(as);
  const res = await fetch(dp.baseUrl + urlPath, {
    headers: { Authorization: 'Bearer ' + s.token },
    signal: AbortSignal.timeout(Math.max(dp.timeoutMs, 60000)),
  });
  if (res.status === 401 && retry && !s.creds().fixed && s.creds().user) {
    s.token = null;
    s.refresh = null;
    s.expiresAt = 0;
    return apiPdf(urlPath, false, as);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`Dealer Portal GET ${urlPath} -> HTTP ${res.status} ${buf.toString('utf8', 0, 200)}`);
  }
  return buf;
}

// ------------------------------------------------------- wire format (EDIT ME)

// Per Aneeq sir: "part number aur quantity, do item ke saath analyze API call
// karega ... output yahi batayega ki kis vendor ke paas kitna stock available
// hai" — plus MRP and quantity per the same description.
// VERIFIED against the live OpenAPI spec:
//   POST /api/v1/PUSH_ORDER/analyze
//   required: items[] of { part_no: string, quantity: int }
//   optional: order_reference_no, order_for_user_id,
//             source_branch_dealer_id, bypass_threshold
// The portal's catalog is CASE-SENSITIVE: "43401M68P01" resolves, the same
// part in lowercase does not. Customers type lowercase constantly, so every
// part number is upper-cased on the way out.
// Tests only: what a mock order holds, so the draft-SO flow can be walked
// end to end offline.
const mockOrderLines = new Map();
let mockCredit = null;
// Rows the duplicate check pretends the portal already holds, for tests.
let mockDuplicates = [];

// EVERY GSTIN THE PORTAL ALREADY HOLDS, kept in memory.
//
// There is no "is this GSTIN taken" route. The only way to know is
// /users/customers/list, which on 22 Sep returned 7551 rows and 3.2 MB in
// 84 seconds. Nobody waits 84 seconds in the middle of a WhatsApp form, so
// the list is pulled in the background and answered from memory.
//
// Deliberately NOT persisted: a stale file read at boot would answer a
// duplicate question with yesterday's truth and we would never know which.
// A restart simply rebuilds it, and until it is built the answer is
// "could not check", which is the honest one.
const GST_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const gstIndex = {
  map: null, // GSTIN -> customer name
  at: 0,
  building: null,

  // The index if it is fresh, else null. Never blocks.
  ready() {
    if (this.map && Date.now() - this.at < GST_INDEX_TTL_MS) return this.map;
    return null;
  },

  // Kick off a rebuild. Returns the promise so a caller that CAN wait
  // (the boot warm-up) may; callers inside a conversation must not.
  refresh() {
    if (this.building) return this.building;
    this.building = (async () => {
      const t0 = Date.now();
      try {
        const data = await api('GET', '/users/customers/list', null, true, 'sales', 180000);
        const rows = Array.isArray(data) ? data : (data && (data.items || data.data || data.results)) || [];
        const map = new Map();
        for (const r of rows) {
          const g = String((r && r.gst_no) || '').trim().toUpperCase();
          if (g && g !== 'NULL') map.set(g, r.name || null);
        }
        this.map = map;
        this.at = Date.now();
        store.log('portal', `GSTIN index built: ${map.size} GSTIN(s) from ${rows.length} customer(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        return map;
      } catch (e) {
        store.log('portal', 'GSTIN index build failed: ' + String((e && e.message) || e).slice(0, 120));
        return null;
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  },
};

// The portal has no box for the contact person's phone, and a number the
// customer was asked for must not be thrown away. Anything else the form
// collected that the schema cannot hold joins it here.
function remarksWith(fields) {
  const bits = [];
  if (fields.remarks) bits.push(String(fields.remarks));
  if (fields.contactPhone && String(fields.contactPhone) !== String(fields.phone)) {
    bits.push('Contact phone: ' + fields.contactPhone);
  }
  if (fields.gstVerified === false) bits.push('GST NOT verified' + (fields.gstWaiver ? ' (waived on ' + fields.gstWaiver + ')' : ''));
  return bits.join(' | ') || null;
}
let mockHistory = null;
const mockDiscountRules = [];
let mockBrands = ['CARTRENDS', 'MARUTI SUZUKI', 'BOSCH', 'MINDA'];
// tests: { track: {id: obj}, dispatches: [], invoiceStatus: {id: obj}, challans: {id: true}, shortages: [], partStatus: {part: obj}, incoming: [] }
let mockLookups = {};
const mockUsers = new Map(); // tests: mobile -> portal user
const userCache = new Map(); // mobile -> { at, value }
const USER_TTL_MS = 6 * 60 * 60 * 1000;

// Upper-cased: the catalogue is case-sensitive and customers type "16510m65l10".
// Not a number with a SPACE in it: that is the portal's own spelling, learned
// from its catalogue ("CTWBSI26P-16 Inch"), and upper-casing it made it a part
// the portal has never heard of.
function portalPartNo(v) {
  const s = String(v == null ? '' : v).trim();
  return /\s/.test(s) ? s : s.toUpperCase();
}

// What create-part is sent for an Inventory Creation request. The house-style
// name (core/partNaming), not the mail's bare "windshield", goes into
// part_name AND attribute_desc: every part the team made by hand carries the
// two identical (41800M79G00 and the rest, read 11 Sep). Quantity 1 and
// country India are the team's fixed values.
function partBody(fields) {
  const name = fields.standardName || fields.partName;
  return {
    part_no: portalPartNo(fields.partNo),
    part_name: name,
    brand: fields.brand,
    attribute_desc: name,
    attribute_quantity: '1',
    attribute_country_origin: 'India',
    ...(fields.hsnCode ? { hsn_code: String(fields.hsnCode) } : {}),
    ...(fields.gstPercent != null ? { gst_percent: fields.gstPercent } : {}),
    ...(fields.mrpValue != null ? { mrp: fields.mrpValue } : {}),
  };
}

function buildAnalyzeRequest(lines, ctx) {
  const body = {
    items: lines.map((l) => ({
      part_no: portalPartNo(l.partNo || l.item),
      quantity: Number(l.qty) || 1,
    })),
  };
  // Scope availability to the CUSTOMER's own home branch. Verified live:
  // sending source_branch_dealer_id=23 resolves to "BIJWASAN WAREHOUSE".
  const branch = (ctx && ctx.branchId) || dp.sourceBranchDealerId;
  if (branch) body.source_branch_dealer_id = branch;

  // NOTE: `order_for_user_id` wants a USER id, NOT the customer/dealer id.
  // The mobile lookup returns `selected_buyer_id` (a DEALER id) — passing
  // that here returns 401 "User not found for token". Verified the hard way.
  // The customer's identity belongs on CONFIRM, as `selected_buyer_id`.
  // Only send this when a real portal user id was configured.
  if (dp.userId) body.order_for_user_id = dp.userId;
  return body;
}

// REAL response, captured from the live API 2 Sep 2026:
//
//   { status: "READY", can_push_order: true, blocking_errors: [],
//     order_for_user_id: 1434, buyer_dealer_id: 8510,
//     branch_resolution_source: "ACCOUNT_HOME_BRANCH",
//     lines: [ { part_no: "17521M68PA0", requested_qty: 2, shortfall: 0,
//                allocations: [ { dealer_id: 23, qty: 2,
//                                 is_interbranch_transfer: false } ] } ] }
//
// Notes that shaped this reader:
//   * availability = requested_qty - shortfall (allocations sum to the same)
//   * `allocations[].dealer_id` is WHICH branch/vendor supplies it
//   * the response carries NO price or MRP — the bot cannot quote a rate from
//     analyze alone, so price stays null and the reply omits it
function readAnalyzeResponse(data, lines) {
  const rows = Array.isArray(data.lines) ? data.lines : [];
  return lines.map((line, i) => {
    const match =
      rows.find((r) => same(r.part_no, line.partNo || line.item)) || rows[i] || null;
    const row = match || {};
    const requested = num(row.requested_qty) || Number(line.qty) || 1;
    const shortfall = num(row.shortfall);
    const allocations = Array.isArray(row.allocations) ? row.allocations : [];
    const vendors = allocations
      .map((a) => ({
        name: 'Dealer ' + (a.dealer_id ?? '?'),
        dealerId: a.dealer_id ?? null,
        qty: num(a.qty),
        interbranch: Boolean(a.is_interbranch_transfer),
        price: null,
        mrp: null,
        tatDays: null,
      }))
      .filter((v) => v.qty > 0)
      .sort((a, b) => b.qty - a.qty);
    const available = vendors.length
      ? vendors.reduce((s, v) => s + v.qty, 0)
      : Math.max(0, requested - shortfall);
    return normaliseLine(line, {
      // reaching here at all means the portal accepted the part number —
      // an unknown part comes back as a 400 INVALID_PART_NO instead (see
      // `analyze` below), never as a row in this list
      known: true,
      available,
      vendors,
      mrp: null,
      price: null,
      partNo: row.part_no || line.partNo || line.item,
      name: null,
      raw: match, // echoed back verbatim on confirm
    });
  });
}

// The portal names the parts it did not recognise in the 400 body:
//   { error_code: "INVALID_PART_NO",
//     details: [ { part_no: "ZZZ...", action: "..." } ] }
function invalidPartsFrom(err) {
  if (!err || err.code !== 'INVALID_PART_NO') return [];
  const details = (err.body && err.body.details) || [];
  return details.map((d) => String(d.part_no || '')).filter(Boolean);
}

// VERIFIED against the live OpenAPI spec:
//   POST /api/v1/purchase-orders/confirm
//   required: user_id (int), lines[]
//   lines[] mirrors the ANALYZE output — each line carries the dealers[]
//   allocation the portal itself worked out, so we echo analyze's own row
//   back rather than inventing one. `_raw` is the untouched analyze row,
//   stashed on the line by readAnalyzeResponse.
function buildConfirmRequest(order) {
  const sellable = order.lines.filter((l) => l.source !== 'unidentified' && l.source !== 'unknown');
  const ctx = order.portalCustomer || null;
  const body = {
    // the acting account (the bot's portal user)
    user_id: dp.userId,
    // WHO the order is for — the customer resolved from their WhatsApp number
    ...(ctx && ctx.buyerId ? { selected_buyer_id: ctx.buyerId } : {}),
    // The customer's OWN order number when their file carried one, so their
    // bill comes back under the number they track the goods by.
    external_order_reference: order.customerRef ? `${order.id}/${order.customerRef}` : order.id,
    // Every line names its part and the quantity being punched. 14 Sep, live,
    // SO 687: on-order lines went as `{"allocations":[]}` with no part number.
    // Founder, same day: "punch avl item ka hi hoga abhi" - core/orders sends
    // only what is in stock, at the quantity in stock, so the portal is asked
    // for exactly what it can allocate. No unallocated order is requested.
    lines: sellable.map((l) => {
      const raw = l._raw && typeof l._raw === 'object' ? l._raw : {};
      const allocations = Array.isArray(raw.dealers) ? raw.dealers : Array.isArray(raw.allocations) ? raw.allocations : null;
      return {
        ...raw,
        part_no: raw.part_no || l.partNo || l.item,
        requested_qty: l.qty,
        shortfall: 0,
        dealers: allocations
          ? allocations
          : (l.vendors || []).map((v) => ({
              dealer_name: v.name,
              dealer_id: v.dealerId,
              qty: v.qty,
              price: v.price,
              mrp: v.mrp,
            })),
      };
    }),
  };
  const branch = (ctx && ctx.branchId) || dp.sourceBranchDealerId;
  if (branch) body.source_branch_dealer_id = branch;
  // WHO punched it. The portal has a field for exactly this — actor_user_id —
  // and it is how "which agent sold what" can be read later; the user_id above
  // stays the acting account. Only set when the portal knows a user for that
  // mobile (GET /PUSH_ORDER/order-for-user?mobile=).
  if (order.actorUserId) body.actor_user_id = Number(order.actorUserId);
  // So bot orders can be told apart from ones typed on the portal.
  body.client_source = 'whatsapp-bot';
  return body;
}

// The order number lives at primary_order.order_id — the shape the portal's
// own OpenAPI declares (OrderConfirmResponse -> OrderResponse). We were looking
// only at top-level so_number/order_number/id, found none, and threw. The order
// had in fact been created: the customer was told "our system did not accept
// it" for an order that exists in the portal. Guessing a field name here is the
// most expensive kind of guess, so the documented path is tried first.
function readConfirmResponse(data) {
  const primary = data.primary_order || data.unallocated_order || null;
  const soNumber =
    (primary && (primary.order_id || primary.so_number || primary.id)) ||
    data.so_number ||
    data.soNumber ||
    data.order_number ||
    data.orderNumber ||
    data.id ||
    null;
  if (!soNumber) {
    // Say what actually came back, so the next surprise takes minutes and not
    // a week of customers being told their orders failed.
    throw new Error(
      'Dealer Portal confirm returned no order number; response keys: ' + Object.keys(data || {}).join(',')
    );
  }
  const extra = data.unallocated_order && primary !== data.unallocated_order ? data.unallocated_order.order_id : null;
  // What the portal actually took, part by part, across both orders - so the
  // customer is never told a part is ordered when it is not. null when the
  // response carries no lines (then nothing is claimed either way).
  const orderLines = (o) => (o && Array.isArray(o.lines) ? o.lines : null);
  const took = [orderLines(data.primary_order), orderLines(data.unallocated_order && data.unallocated_order !== data.primary_order ? data.unallocated_order : null)];
  let portalLines = null;
  if (took.some(Boolean)) {
    portalLines = [];
    for (const [i, ls] of took.entries()) {
      for (const l of ls || []) {
        portalLines.push({ partNo: String(l.part_no || ''), qty: Number(l.final_quantity) || Number(l.quantity) || Number(l.requested_qty) || 0, onOrder: i === 1 });
      }
    }
  }
  return {
    soNumber: String(soNumber),
    unallocatedOrderId: extra || null,
    portalLines,
    odooSyncStatus: data.odoo_sync_status || null,
    // Odoo's own SO number (portal 570 -> Odoo 235917) - what the ERP SO PDF
    // is fetched by. Often not there yet at punch time; soPdf() looks it up.
    odooSoName: (primary && primary.odoo_so_name) || data.odoo_so_name || null,
  };
}

// ------------------------------------------------------------------ helpers

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function same(a, b) {
  return norm(a) && norm(a) === norm(b);
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function norm(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// One requested line + DP's answer -> the shape the rest of the app uses.
function normaliseLine(line, info) {
  const qty = Number(line.qty) || 1;
  const available = info.available || 0;
  const best = (info.vendors || [])[0] || null;
  const price = info.price || (best && best.price) || null;
  const mrp = info.mrp || (best && best.mrp) || null;

  if (available <= 0) {
    // CRITICAL DISTINCTION:
    //   known: false -> the portal does not know this part at all. A human
    //                   must identify it, and we learn the answer forever.
    //   known: true  -> the part exists, stock is zero. No human needed;
    //                   founder's answer is "on order, ETA = 7 days".
    return {
      item: info.name || line.item,
      partNo: info.partNo,
      qty,
      source: info.known ? 'unavailable' : 'unidentified',
      available: 0,
      vendors: [],
      price,
      mrp,
      // Founder's line: "ye order pe laga hua hai, abhi nahi hai, but aa
      // jayega 1 hafte mein. Aap confirm karo to aapke liye rok deta hun."
      eta: `on order — ETA = ${config.onOrderEtaDays} days`,
    };
  }
  const partial = available < qty;
  return {
    _raw: info.raw || null,
    item: info.name || line.item,
    partNo: info.partNo,
    qty,
    source: 'portal',
    available,
    partial,
    vendors: info.vendors || [],
    vendorName: best ? best.name : null,
    price,
    mrp,
    eta: partial ? `only ${available} available` : 'available',
  };
}

// --------------------------------------------------------------- mock mode

// data/mock-stock.json: [{ part_no, name, quantity, price, mrp }]
let mockCache = null;
function mockStock() {
  if (mockCache) return mockCache;
  try {
    const fs = require('fs');
    const path = require('path');
    mockCache = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'mock-stock.json'), 'utf-8'));
  } catch {
    mockCache = [];
  }
  return mockCache;
}
function setMockStock(rows) {
  mockCache = Array.isArray(rows) ? rows : [];
  return mockCache.length;
}

// Customers for the salesman flow in tests: the mock has no customer list.
let mockCustomers = [];
function setMockCustomers(rows) {
  mockCustomers = Array.isArray(rows) ? rows : [];
  return mockCustomers.length;
}

// The mock's version of commercial-analyze: the same four statuses and the
// same money fields, so the tests exercise the real mapping. A flat 12% is
// what Kalra Motors actually carries on the live portal.
function mockCommercial(lines) {
  const MOCK_DISCOUNT = 12;
  const MOCK_TAX = 18;
  return lines.map((line) => {
    const want = norm(line.partNo || line.item);
    const row = mockStock().find((r) => norm(r.part_no) === want || norm(r.name) === want) || null;
    const qty = Number(line.qty) || 1;
    const have = row ? Number(row.quantity) || 0 : 0;
    const allocated = Math.min(have, qty);
    const mrp = row ? Number(row.mrp) || Number(row.price) || 0 : 0;
    const rate = Math.round(mrp * (1 - MOCK_DISCOUNT / 100) * 100) / 100;
    const out = normaliseLine(line, {
      name: null,
      partNo: row ? row.part_no : line.partNo || line.item,
      available: allocated,
      known: Boolean(row),
      vendors: allocated
        ? [{ name: row.vendor || 'Dealer 23', dealerId: 23, qty: allocated, price: rate, mrp, tatDays: 1, interbranch: false }]
        : [],
      price: rate || null,
      mrp: mrp || null,
      raw: null,
    });
    out.rate = rate || null;
    out.mrp = mrp || null;
    out.discountPercent = row ? MOCK_DISCOUNT : null;
    out.taxPercent = row ? MOCK_TAX : null;
    out.hsn = row ? '84212300' : null;
    out.partName = row ? row.name || null : null;
    out.portalStatus = !row ? 'Invalid Part No' : allocated >= qty ? 'Available' : allocated ? 'Partially Available' : 'Not Available';
    out.shortfall = Math.max(0, qty - allocated);
    out.tatDays = allocated ? 1 : null;
    out.commercial = true;
    return out;
  });
}

function mockAnalyze(lines) {
  return lines.map((line) => {
    const key = line.partNo || line.item;
    const row =
      mockStock().find((r) => same(r.part_no, key)) ||
      mockStock().find((r) => {
        const a = String(r.name || '').toLowerCase();
        const b = String(key).toLowerCase();
        return a && b && (a === b || a.includes(b) || b.includes(a));
      });
    if (!row) return normaliseLine(line, { known: false, available: 0, vendors: [], partNo: key });
    const qty = num(row.quantity);
    return normaliseLine(line, {
      known: true,
      available: qty,
      vendors: qty > 0 ? [{ name: row.vendor || 'Portal', qty, price: num(row.price), mrp: num(row.mrp), tatDays: 0 }] : [],
      price: num(row.price),
      mrp: num(row.mrp),
      partNo: row.part_no || key,
      name: row.name || line.item,
    });
  });
}

// ------------------------------------------------------------------- public

module.exports = {
  enabled,
  get isMock() {
    return isMock();
  },
  setMockStock,
  setMockCustomers,
  _setMockDuplicates: (rows) => { mockDuplicates = rows || []; },
  // Pulled at boot so the first customer who types a GSTIN is not the
  // one who finds out it takes 84 seconds.
  warmGstIndex: () => (isMock() ? Promise.resolve(null) : gstIndex.refresh()),
  _setGstIndex: (pairs) => { gstIndex.map = new Map(pairs || []); gstIndex.at = Date.now(); },
  _setMockOrderLines: (id, lines) => mockOrderLines.set(String(id), lines),
  _setMockCredit: (v) => { mockCredit = v; },
  _setMockOrderHistory: (v) => { mockHistory = v; },
  _setMockLookups: (v) => { mockLookups = v || {}; },
  _setMockUser: (mobile, user) => { mockUsers.set(String(mobile).replace(/[^0-9]/g, "").slice(-10), user); },
  // exported so token renewal can be exercised without waiting eight hours
  _sessions: () => sessions,
  // exported so the response shape can be tested without a live portal
  _readConfirmResponse: readConfirmResponse,
  _partBody: partBody,
  // exported so the punch body can be checked without punching anything
  _confirmBody: buildConfirmRequest,
  // exported so the punch body can be asserted without punching anything

  // Create a customer account from an approved Data Entry request.
  //
  // The portal has TWO doors for this and they mean different things:
  //   users/customer/create                     -> the account exists now
  //   finance/approval-requests/customer-creation -> queued for someone to approve
  // The email these come from has ALREADY been approved by a human
  // (arun.sharma@cartrends.in in the sample), so the direct create is the
  // honest match — routing an approved request back into an approval queue
  // would just move the typing, not remove it.
  //
  // Never throws past the caller: a failed creation must be reported, not
  // retried blindly, because a half-succeeded retry makes duplicate accounts.
  async createCustomer(fields, { asApprovalRequest = false } = {}) {
    if (isMock()) return { mock: true, accountId: 'MOCK-CUST-1', username: fields.username };
    const body = {
      name: fields.name,
      phone: fields.phone,
      username: fields.username,
      password: fields.password,
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.gstNo ? { gst_no: fields.gstNo } : {}),
      ...(fields.address ? { address: fields.address } : {}),
      ...(fields.creditDays != null ? { credit_days: fields.creditDays } : {}),
      ...(fields.creditLimit != null ? { credit_limit: fields.creditLimit } : {}),
      ...(fields.category ? { dealer_category: fields.category } : {}),
      ...(fields.branchId ? { home_branch_dealer_id: fields.branchId } : {}),
      // The API defaults this to 'dealer' for a customer account, which is
      // the wrong role. Sent explicitly.
      ...(fields.userType ? { user_type: fields.userType } : {}),
      ...(fields.alsoVendor ? { also_add_as_vendor: true } : {}),
      // WHO opened this account. Anik, 12 Sep, about sales orders: "baad
      // mein main dekh paun kis agent ne kitna kiya" — the same question
      // gets asked about accounts, and an account opened by an agent is
      // that agent's. A customer who registered themselves has no agent,
      // and the field is left off rather than filled with their own name.
      // FIELD NAMES ARE THE PORTAL'S, checked against its own OpenAPI
      // schema (CustomerCreateSchema) on 22 Sep — not guessed. Several of
      // the obvious spellings are wrong there: it is state_name not state,
      // pin_code not pincode, primary_contact_person not contact_person,
      // and destination_latitude not latitude.
      ...(fields.createdByName ? { sales_representative_name: fields.createdByName } : {}),
      ...(fields.createdByEmail ? { sales_representative_email: fields.createdByEmail } : {}),
      ...(fields.contactPerson ? { primary_contact_person: fields.contactPerson } : {}),
      ...(fields.businessType ? { business_type: fields.businessType } : {}),
      ...(fields.city ? { city: fields.city } : {}),
      ...(fields.state ? { state_name: fields.state } : {}),
      ...(fields.pin ? { pin_code: fields.pin } : {}),
      ...(fields.panNo ? { pan_no: fields.panNo } : {}),
      ...(fields.lat != null ? { destination_latitude: fields.lat, destination_longitude: fields.lng } : {}),
      // The schema has NO field for the contact person's phone. Rather
      // than drop a number the customer was asked for, it rides along in
      // remarks, which is where the data team looks for anything the form
      // had no box for.
      ...(remarksWith(fields) ? { remarks: remarksWith(fields) } : {}),
    };
    // The two schemas spell the same thing differently: the direct create
    // takes business_type (set above), the approval-request one dealer_type.
    if (asApprovalRequest && fields.businessType) {
      delete body.business_type;
      body.dealer_type = fields.businessType;
    }

    const path = asApprovalRequest
      ? '/finance/approval-requests/customer-creation'
      : '/users/customer/create';
    const data = await api('POST', path, body, true, 'admin');
    store.log('portal', `customer created: "${fields.name}" (${fields.username})`);
    return {
      accountId: data.account_id || data.id || data.dealer_id || null,
      requestNumber: data.request_number || null,
      username: fields.username,
      raw: data,
    };
  },

  // Add a part to the catalogue, from an approved Inventory Creation request.
  //
  // create-part carries `mrp`; the part UPDATE endpoint does not. That is why
  // an MRP CHANGE cannot go through here — re-creating an existing part to
  // move its price would overwrite the rest of the record, and the request
  // mails themselves say "Affects Active Orders: Yes". Those stay manual.
  async createPart(fields) {
    if (isMock()) return { mock: true, partNo: fields.partNo };
    const body = partBody(fields);
    const data = await api('POST', '/parts/create-part', body, true, 'admin');
    store.log('portal', `part created: ${body.part_no} (${body.brand})`);
    return { partNo: body.part_no, raw: data };
  },

  // DISCOUNT RULES - what the portal's "Create Discount Rule" screen writes.
  // A new account's discount is set up here by the agent who opened it, and
  // only created once the account itself is approved (core/discountSetup).
  async listDiscountRules() {
    if (isMock()) return mockDiscountRules.slice();
    const data = await api('GET', '/discount-rules/', null, true, 'admin');
    return Array.isArray(data) ? data : (data && (data.items || data.data || data.results)) || [];
  },
  async createDiscountRule(body) {
    if (isMock()) {
      const rule = { id: mockDiscountRules.length + 1, ...body };
      mockDiscountRules.push(rule);
      return rule;
    }
    const data = await api('POST', '/discount-rules/', body, true, 'admin');
    store.log('portal', `discount rule created: "${body.rule_name || ''}" (${body.rule_type}, ${body.discount_value}${body.discount_mode === 'percent' ? '%' : ''})`);
    return data;
  },
  // A rule that exists, changed: only the fields sent are touched.
  async updateDiscountRule(ruleId, body) {
    if (isMock()) {
      const r = mockDiscountRules.find((x) => x.id === ruleId || x.rule_id === ruleId);
      if (!r) throw Object.assign(new Error('rule ' + ruleId + ' not found'), { status: 404 });
      Object.assign(r, body);
      return r;
    }
    const data = await api('PUT', '/discount-rules/' + encodeURIComponent(ruleId), body, true, 'admin');
    store.log('portal', `discount rule ${ruleId} updated: ${JSON.stringify(body).slice(0, 120)}`);
    return data;
  },
  _setMockDiscountRules: (list) => {
    mockDiscountRules.length = 0;
    for (const r of list || []) mockDiscountRules.push(r);
  },
  // The brands the product master knows, so "cartrend" is written as the
  // portal writes it before a rule is made against it.
  async listBrands(q) {
    if (isMock()) return mockBrands.filter((b) => !q || b.toLowerCase().includes(String(q).toLowerCase()));
    const data = await api('GET', `/parts/brands?q=${encodeURIComponent(q || '')}&limit=20`);
    const rows = Array.isArray(data) ? data : (data && (data.items || data.data || data.results || data.brands)) || [];
    return rows.map((r) => (typeof r === 'string' ? r : r.brand || r.name || r.value)).filter(Boolean);
  },
  _setMockBrands: (list) => {
    mockBrands = list || [];
  },

  // Vendor accounts. Same shape as a customer except the name field is called
  // vendor_name and the cross-link runs the other way — a real difference, and
  // routing a VEND- request through createCustomer would have quietly made the
  // wrong kind of account under the right name.
  async createVendor(fields) {
    if (isMock()) return { mock: true, accountId: 'MOCK-VEND-1', username: fields.username };
    const body = {
      vendor_name: fields.name,
      phone: fields.phone,
      username: fields.username,
      password: fields.password,
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.gstNo ? { gst_no: fields.gstNo } : {}),
      ...(fields.address ? { address: fields.address } : {}),
      ...(fields.creditDays != null ? { credit_days: fields.creditDays } : {}),
      ...(fields.creditLimit != null ? { credit_limit: fields.creditLimit } : {}),
      ...(fields.category ? { dealer_category: fields.category } : {}),
      ...(fields.userType ? { user_type: fields.userType } : {}),
      ...(fields.alsoCustomer ? { also_add_as_customer: true } : {}),
    };
    const data = await api('POST', '/users/vendor/create', body, true, 'admin');
    store.log('portal', `vendor created: "${fields.name}" (${fields.username})`);
    return { accountId: data.account_id || data.id || data.dealer_id || null, username: fields.username, raw: data };
  },

  // Find parts by NAME. `analyze` only understands part numbers, so a customer
  // writing "Brake pad - 5" got no answer at all. This is the catalogue search
  // the portal's own UI uses, and unlike analyze it returns PRICE and per-dealer
  // stock. Never throws — a failed search is "no candidates", not an error.
  //
  // "brake pad" alone matches 592 parts, so the caller must handle the case
  // where the customer has to narrow it down. Guessing one would sell them the
  // wrong part for the wrong car.
  async searchByName(query, limit = 6) {
    const q = String(query || '').trim();
    if (!q || isMock()) return { total: 0, top: [] };
    // Brackets and commas are not part of any word: "rear bumper (2018
    // model)" kept "(2018" and "model)" as part words and matched nothing.
    const words = q.replace(/[()[\]{},;:!?"]/g, ' ').split(/\s+/).filter(Boolean);
    try {
      // The portal matches the phrase literally, and part names are written
      // "BRAKE PAD | MAHINDRA SCORPIO | FRONT" — the PART first, the car after.
      // So the words to search on are the part words, and everything else is a
      // filter applied here.
      //
      // Trying only leading words assumed the customer writes the part first
      // ("brake pad scorpio front"), which is how people TYPE. It is not how
      // they SPEAK: "Maruti Suzuki ka bumper chahiye" led with the car, so the
      // search ran on "maruti", matched half the catalogue, and the customer
      // was told to send a part number for a part they had just named
      // (21 Sep, live — three voice notes about a Swift bumper in one chat).
      const partish = require('../core/partish');
      const partWords = words.filter((w) => !partish.isCarWord(w));

      // 22 Sep, live, against the real portal: "Maruti Suzuki Swift Dzire
      // front bumper" came down to "front bumper", which the portal reads as
      // a phrase - 140 rows, a Ciaz garnish and Chevrolet retainers, and not
      // one Dzire bumper. The search is a literal phrase ("bumper dzire" finds
      // nothing), so when a MODEL is named, search the part word alone -
      // "bumper" - and let the model, the position ("front") and the rest
      // narrow it below. That gives 176 rows, every one a Dzire bumper.
      //
      // The same goes for a position with no car: "rear bumper" as a phrase
      // found four Chevrolet Tavera parts; "bumper" narrowed by "rear" finds
      // every rear bumper. So whenever the part word is not the whole of what
      // they said, it is searched on its own first.
      const core = partWords.filter((w) => !partish.isPositionWord(w) && !partish.isFiller(w) && !partish.isYear(w));
      const year = Number(words.find((w) => partish.isYear(w)) || 0);
      const tries = [];
      if (core.length && core.length !== words.length) tries.push(core);

      // Then: the phrase as they said it; the part words alone; then the
      // leading words, shortest last — the old behaviour, still the right
      // answer for "brake pad front" where nothing is a car word.
      tries.push(words);
      if (partWords.length && partWords.length !== words.length) tries.push(partWords);
      for (let n = words.length - 1; n >= 1; n--) tries.push(words.slice(0, n));

      let rows = [];
      let used = words;
      const asked = new Set();
      for (const cand of tries) {
        const phrase = cand.join(' ');
        if (!phrase || asked.has(phrase.toLowerCase())) continue;
        asked.add(phrase.toLowerCase());
        const data = await api('GET', `/search?q=${encodeURIComponent(phrase)}`);
        rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length) {
          used = cand;
          break;
        }
      }

      // Words the customer gave that were not part of the search: "scorpio",
      // "front", "rear", a model name. Applied ONE AT A TIME and kept only
      // when the catalogue actually knows the word — a customer saying
      // "Maruti Suzuki Swift" against names written "MARUTI SWIFT" would
      // otherwise have the whole narrowing thrown away over "suzuki", and get
      // every bumper we sell instead of the Swift ones.
      // Maker and joining words never narrow: "suzuki" would keep only the
      // rows that happen to spell the maker out, and "ka" matches anything.
      const inUse = new Set(used.map((w) => w.toLowerCase()));
      const extra = words
        .map((w) => w.toLowerCase())
        .filter((w) => !inUse.has(w) && !partish.isMaker(w) && !partish.isFiller(w) && !partish.isYear(w));
      for (const w of extra) {
        const narrowed = rows.filter((r) => String(r.partName || '').toLowerCase().includes(w));
        if (narrowed.length) rows = narrowed;
      }
      // A bumper, not a bumper bracket. Names lead with what the part IS
      // ("Bumper| Front Side | Swift..."), so when some rows are exactly what
      // was asked for, the brackets, holders and garnishes that merely
      // mention it go.
      if (core.length) {
        const want = core.join(' ').toLowerCase();
        const exact = rows.filter((r) => String(r.partName || '').split('|')[0].trim().toLowerCase() === want);
        if (exact.length) rows = exact;
      }
      // The model year against the years a part is written for: "(2011-2017)",
      // "(2017+ sedan)". A part that names no year is kept - most do not.
      if (year) {
        const fitsYear = (name) => {
          const s = String(name || '');
          const ranges = [...s.matchAll(/\b(19\d\d|20\d\d)\s*[-–]\s*(19\d\d|20\d\d)\b/g)].map((m) => [Number(m[1]), Number(m[2])]);
          const from = [...s.matchAll(/\b(19\d\d|20\d\d)\s*\+/g)].map((m) => [Number(m[1]), 9999]);
          const all = [...ranges, ...from];
          return !all.length || all.some(([a, b]) => year >= a && year <= b);
        };
        const byYear = rows.filter((r) => fitsYear(r.partName));
        if (byYear.length) rows = byYear;
      }
      const out = rows.map((r) => {
        const dealers = Array.isArray(r.dealers) ? r.dealers : [];
        const qty = dealers.reduce((s, d) => s + (num(d.quantity) || 0), 0);
        const price = dealers.length ? num(dealers[0].price) : null;
        return {
          partNo: r.partNo,
          name: String(r.partName || '').replace(/\s*\|\s*#\S+\s*$/, ''), // drop the trailing "| #PARTNO"
          available: qty,
          price: price || null,
          dealers: dealers.map((d) => ({ dealerId: d.sellerId, name: d.sellerName, qty: num(d.quantity), price: num(d.price) })),
        };
      });
      // In stock first — a customer asking by name wants what they can have.
      out.sort((a, b) => (b.available > 0) - (a.available > 0) || b.available - a.available);
      store.log('portal', `search "${q}" -> ${rows.length} match(es)`);
      return { total: rows.length, top: out.slice(0, limit) };
    } catch (e) {
      store.log('portal', `search "${q}" failed: ${String((e && e.message) || e).slice(0, 120)}`);
      return { total: 0, top: [] };
    }
  },

  // Ask the portal what is available. Never throws — on failure every line
  // comes back 'unknown' so the bot escalates instead of promising wrongly.
  // WhatsApp number -> portal customer. 404 means "not a customer yet", which
  // is a normal answer, not an error.
  // Customer accounts whose name CONTAINS `name` - the portal matches inside
  // words, so "Anuj" also brings back "Tanuj R"; salesOrder.js narrows it.
  // Each row: id (= the buyer id an SO is punched for), name, address,
  // state_name, group_name (the agent). 0.2 s on the live portal (11 Sep).
  // The full /users/customers/list took 77-80 s and is not used.
  async searchAccounts(name) {
    const q = String(name || '').trim();
    if (!q) return [];
    if (isMock()) {
      const lq = q.toLowerCase();
      return mockCustomers.filter((r) => String(r.name || '').toLowerCase().indexOf(lq) !== -1);
    }
    let data;
    try {
      data = await api('GET', '/accounts/search?customer_name=' + encodeURIComponent(q), null, true, 'sales', ACCOUNT_SEARCH_MS);
    } catch (e) {
      // The portal answers "nobody by that name" with a 404 after ~40 s.
      // Either one - the 404 or our cap running out first - is that answer.
      if (e && (e.status === 404 || /abort|timeout/i.test(String(e.message || e.name || '')))) return [];
      throw e;
    }
    return Array.isArray(data) ? data : (data && (data.items || data.data || data.results)) || [];
  },

  // "Confirm SO": the step after the punch. The punch creates the SO with
  // do_status "pending"; this makes it "confirmed", which starts allocation
  // (live orders 11 Sep carry do_confirmed_by / do_confirmed_at). NOT yet
  // exercised against a real order: order punching is still switched off.
  async confirmSO(orderId) {
    if (isMock()) {
      store.log('portal', 'MOCK Confirm SO ' + orderId);
      return { ok: true, mock: true };
    }
    const data = await api('POST', '/orders/' + encodeURIComponent(orderId) + '/confirm-do');
    store.log('portal', 'Confirm SO ' + orderId + ' done');
    return { ok: true, raw: data };
  },

  // The "ERP SO" PDF: Odoo's own sale-order print, the file the team downloads
  // from the portal after Confirm SO (or later via Track Order -> ERP). The
  // portal fetches it from Odoo for us, so nothing is written to Odoo:
  //   GET /orders/{id}                           -> odoo_so_name (570 -> 235917)
  //   GET /odoo/documents/so/pdf?odoo_ref=<name> -> application/pdf
  // Verified 11 Sep with the bot's own account on order 570: a 100 KB PDF.
  // document_type takes only "so" or "po". null = Odoo has no SO for it yet.
  async soPdf(orderId, odooSoName) {
    if (isMock()) {
      const name = odooSoName || 'MOCK-' + orderId;
      return { name, buffer: Buffer.from('%PDF-1.4\n% mock ERP SO ' + name + '\n', 'latin1') };
    }
    let name = odooSoName;
    if (!name) {
      const o = await api('GET', '/orders/' + encodeURIComponent(orderId));
      name = ((o && o.data) || o || {}).odoo_so_name || null;
    }
    if (!name) return null;
    const buffer = await apiPdf('/odoo/documents/so/pdf?odoo_ref=' + encodeURIComponent(name));
    // The endpoint reads a bare number as an Odoo ID, not a name: asking
    // it for "632" (a PORTAL order id) came back with another customer's
    // SO 234866 on 12 Sep. A document that does not carry the number we
    // asked for is not this customer's - it is never sent.
    if (!buffer.toString('latin1').includes(String(name))) {
      store.log('portal', 'SO PDF for ' + name + ' came back as a different document - not sent');
      return null;
    }
    return { name: String(name), buffer };
  },

  // Why an account cannot order right now, in the portal own figures.
  //
  // 12 Sep, account 8191: a punch came back 409 "credit control blocked" and
  // it read like the customer owed money. This endpoint said otherwise -
  // balance 0, no pending or overdue bill, 98,311 of the limit free, and the
  // only true flag single_order_blocked: one order (633 / SO 235954) was
  // already open and the account credit term is 1 day. Money and house rule
  // are different things to say to a customer, so they are read, not guessed.
  async creditControl(accountId) {
    const id = String(accountId == null ? '' : accountId).replace(/[^0-9]/g, '');
    if (!id) return null;
    if (isMock()) return mockCredit;
    const data = await api('GET', '/accounts/' + id + '/credit-control');
    return (data && data.data) || data || null;
  },
  // A customer recent orders, for "Kalra ka order kab aayega". The portal
  // matches buyer_search against the buyer NAME, so the caller filters the
  // rows down to the account it actually picked (core/customerLookup).
  async recentOrders(name, { limit = 8 } = {}) {
    if (isMock()) {
      if (mockHistory) return mockHistory;
      return [
        { order_id: 512, order_date: '2026-09-09T17:35:53', customer_name: name, status: 'Unallocated', do_status: 'pending', odoo_so_name: '235866', lines: [{ part_no: '16510M65L10' }] },
        { order_id: 486, order_date: '2026-09-09T12:37:14', customer_name: name, status: 'confirmed', do_status: 'confirmed', odoo_so_name: '235843', lines: [{ part_no: '13780M68P01' }, { part_no: '41800M79G00' }] },
      ];
    }
    const data = await api('GET', '/orders/?order_status=all&limit=' + encodeURIComponent(limit) + '&buyer_search=' + encodeURIComponent(name));
    return Array.isArray(data) ? data : (data && (data.items || data.data || data.results || data.orders)) || [];
  },

  // The bill for one order, as the portal own PDF. The warehouse endpoint
  // serves the confirmed invoice; before it is billed there is a draft one.
  // Verified 12 Sep on order 486: 97 KB of application/pdf. null = no bill.
  async invoicePdf(orderId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) return null;
    if (isMock()) {
      return id === '999' ? null : Buffer.from('%PDF-1.4' + String.fromCharCode(10) + '% mock bill ' + id + String.fromCharCode(10), 'latin1');
    }
    for (const path of ['/warehouse/orders/' + id + '/confirmed-invoice', '/warehouse/orders/' + id + '/draft-invoice']) {
      try {
        return await apiPdf(path);
      } catch (e) {
        store.log('portal', 'no bill at ' + path + ': ' + String((e && e.message) || e).slice(0, 120));
      }
    }
    return null;
  },

  // One order, by its portal id - used for the bill number and the customer
  // name on the file the desk receives.
  async order(orderId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) return null;
    if (isMock()) {
      return {
        order_id: Number(id),
        customer_name: 'Mock Customer',
        invoice_no: 'CT-TEST-1',
        odoo_so_name: '2359' + id,
        do_status: 'pending',
        lines: mockOrderLines.get(String(id)) || [{ part_no: 'BP-1001', quantity: 1, dealer_id: 23, price: 450, tat_days: 0 }],
      };
    }
    const data = await api('GET', '/orders/' + id);
    return (data && data.data) || data || null;
  },

  // ---- desk lookups (founder, 14 Sep). All read-only GETs, all verified that
  // day to be allowed for the bot's SALES user (see memory portal-api-permissions).

  // Where an order is: delivery mode, transporter, tracker status, invoice,
  // payment status. GET /api/orders/track/{id} - outside /api/v1.
  async trackOrder(orderId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) return null;
    if (isMock()) return (mockLookups.track || {})[id] || null;
    const host = dp.baseUrl.replace(/\/api\/v1\/?$/, '');
    return api('GET', host + '/api/orders/track/' + id);
  },

  // The dispatch row for an order: transporter, dispatched_at, invoice_no, POD.
  async dispatchFor(orderId, sellerId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) return null;
    const rows = isMock()
      ? mockLookups.dispatches || []
      : await api('GET', '/warehouse/dispatches' + (sellerId ? '?seller_id=' + encodeURIComponent(sellerId) : ''));
    const list = Array.isArray(rows) ? rows : (rows && (rows.data || rows.items)) || [];
    return list.filter((d) => String(d.order_id) === id).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0] || null;
  },

  // Bill made or not: invoice_no, invoice_status, odoo_invoice_state.
  async invoiceStatus(orderId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) return null;
    if (isMock()) return (mockLookups.invoiceStatus || {})[id] || null;
    return api('GET', '/warehouse/orders/' + id + '/invoice-status');
  },

  // The delivery challan PDF. null when the warehouse has none for it.
  async challanPdf(orderId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) return null;
    if (isMock()) return (mockLookups.challans || {})[id] ? Buffer.from('%PDF-1.4\n% mock challan ' + id + '\n', 'latin1') : null;
    try {
      return await apiPdf('/warehouse/orders/' + id + '/challan');
    } catch (e) {
      store.log('portal', 'no challan for order ' + id + ': ' + String((e && e.message) || e).slice(0, 110));
      return null;
    }
  },

  // The shortage list (parts customers asked for that were not there). The
  // portal's `search` did not match customer names on 14 Sep, so the caller
  // filters; this returns every row.
  async shortages() {
    if (isMock()) return mockLookups.shortages || [];
    const rows = await api('GET', '/out-of-stock/', null, true, 'sales', 60000);
    return Array.isArray(rows) ? rows : (rows && (rows.data || rows.items)) || [];
  },

  // One part's purchase orders, sales orders and stock balance.
  async partStatus(partNo) {
    const p = String(partNo || '').trim().toUpperCase();
    if (!p) return null;
    if (isMock()) return (mockLookups.partStatus || {})[p] || null;
    return api('GET', '/masterpurchase/part-status/' + encodeURIComponent(p));
  },

  // Goods on the way in: PO number, supplier, item count, ETA, status.
  async incomingShipments(sellerId) {
    if (isMock()) return mockLookups.incoming || [];
    const rows = await api('GET', '/warehouse/incoming-shipments' + (sellerId ? '?seller_id=' + encodeURIComponent(sellerId) : ''));
    return Array.isArray(rows) ? rows : (rows && (rows.data || rows.items)) || [];
  },

  // NO updateOrderLines HERE, AND THAT IS THE FINDING.
  //
  // PUT /orders/{id} takes a whole line list, answers HTTP 200, and changes
  // nothing. Tried twice against the live portal on 12 Sep:
  //   * order 632 (partially allocated), one line dropped -> still 5 lines
  //   * order 633 (pending, nothing allocated), quantity 9 sent as 5 -> 9
  // Without `status` in the body it is a 422 ("status Field required"), so
  // the 200 is real and the edit is simply ignored.
  //
  // So a punched order cannot be corrected. core/soReview removes a line
  // the way a person does on the portal: cancel the order, punch the rest
  // again, send the new draft SO.
  // A draft SO the customer turned down. The order exists on the portal
  // and in Odoo, so it has to be taken back, not just forgotten.
  async cancelOrder(orderId) {
    const id = String(orderId == null ? '' : orderId).replace(/[^0-9]/g, '');
    if (!id) throw new Error('no order id');
    if (isMock()) {
      mockOrderLines.delete(id);
      store.log('portal', 'MOCK order ' + id + ' cancelled');
      return { ok: true, mock: true };
    }
    const data = await api('DELETE', '/orders/' + id);
    store.log('portal', 'order ' + id + ' cancelled');
    return { ok: true, raw: data };
  },


  // ALREADY ON THE PORTAL?
  //
  // The portal will not hold the same GSTIN or mobile twice, and it says so
  // by refusing the create — AFTER a customer has answered every question
  // and a Sales Head has approved it. Asking here turns a dead end into
  // "wo number pehle se hai, doosra bhejiye".
  //
  // WHAT CAN ACTUALLY BE CHECKED, from the portal's own OpenAPI schema
  // (read 22 Sep, 504 routes):
  //   mobile -> /users/customer/mobile, one fast call. Authoritative.
  //   GSTIN  -> only by pulling /users/customers/list, which is 7551 rows,
  //             3.2 MB and 84 SECONDS. Far too slow to do inside a form, so
  //             it is cached (see gstIndex) and refreshed in the background.
  //   email  -> NOT POSSIBLE. No route takes it and the list does not carry
  //             it. Reported as unchecked rather than quietly passed.
  //
  // Returns { dup, field, name, unchecked: [...] } where dup is true, false
  // or null. NULL MEANS NOBODY LOOKED — never "no duplicate".
  async findDuplicate({ phone, gstNo, email } = {}) {
    if (isMock()) {
      const hit = mockDuplicates.find(
        (d) =>
          (phone && d.phone === String(phone)) ||
          (gstNo && String(d.gstNo || '').toUpperCase() === String(gstNo).toUpperCase()),
      );
      if (hit) {
        const field = hit.phone === String(phone) ? 'phone' : 'gstNo';
        return { dup: true, field, name: hit.name || null, unchecked: email ? ['email'] : [] };
      }
      return { dup: false, unchecked: email ? ['email'] : [] };
    }

    const unchecked = [];
    // Email has nowhere to be looked up. Said out loud so no caller can
    // read a clean result as "this email is free".
    if (email) unchecked.push('email');

    if (phone) {
      try {
        const data = await api('GET', `/users/customer/mobile?mobileno=${encodeURIComponent(phone)}`);
        if (data) return { dup: true, field: 'phone', name: data.name || null, unchecked };
      } catch (e) {
        if (e.status !== 404) {
          store.log('portal', 'duplicate check (phone) failed: ' + String(e.message || e).slice(0, 100));
          return { dup: null, field: 'phone', unchecked };
        }
      }
    }

    if (gstNo) {
      const idx = gstIndex.ready();
      if (!idx) {
        // The index is being built, or the last build failed. A customer
        // must not wait 84 s for it, so this is honestly unknown.
        gstIndex.refresh();
        unchecked.push('gstNo');
      } else {
        const hit = idx.get(String(gstNo).toUpperCase());
        if (hit) return { dup: true, field: 'gstNo', name: hit, unchecked };
      }
    }

    return { dup: false, unchecked };
  },

  async lookupCustomer(mobile) {
    if (isMock()) {
      return { found: true, buyerId: 1, branchId: 23, name: 'Mock Customer', canAnalyze: true, canConfirm: true };
    }
    try {
      const data = await api('GET', `/users/customer/mobile?mobileno=${encodeURIComponent(mobile)}`);
      return {
        found: true,
        buyerId: data.selected_buyer_id ?? data.dealer_portal_customer_id ?? null,
        branchId: data.home_branch_dealer_id ?? null,
        name: data.name || '',
        gstNo: data.gst_no || null,
        odooSynced: data.odoo_sync_status === 'linked',
        canAnalyze: data.can_call_analyze !== false,
        canConfirm: data.can_call_confirm !== false,
        raw: data,
      };
    } catch (e) {
      if (e.status === 404) return { found: false };
      store.log('portal', 'customer lookup failed: ' + String(e.message || e).slice(0, 140));
      return { found: null }; // unknown — caller must not guess
    }
  },

  // WHO is standing at the counter.
  //
  // Anik, 12 Sep: "jab sales order jo agent apne number se bhejega, toh usi
  // agent ke naam pe sale hogi na? baad mein main dekh paun kis agent ne kitne
  // sales order bheje". Every bot order until now carried only the bot's own
  // portal user, so they all looked like one person's work.
  //
  // The portal already knows the mapping - no list has to be kept by hand:
  //   GET /PUSH_ORDER/order-for-user?mobile=9217030418 -> 1208 / amit_kumar
  // Six of the nine sales numbers answer 404 today; those users simply have no
  // mobile on their portal account yet, and their orders carry no actor until
  // someone adds it there.
  //
  // Cached, because this is asked on every punch and the answer never moves.
  async userForMobile(mobile) {
    const mob = String(mobile == null ? '' : mobile).replace(/[^0-9]/g, '').slice(-10);
    if (mob.length !== 10) return null;
    if (isMock()) return mockUsers.get(mob) || null;
    const hit = userCache.get(mob);
    if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.value;
    let value = null;
    try {
      const data = await api('GET', '/PUSH_ORDER/order-for-user?mobile=' + encodeURIComponent(mob));
      const id = data && (data.order_for_user_id || data.orderForUserId);
      if (id) {
        value = {
          userId: Number(id),
          username: data.username || null,
          dealerId: data.dealer_id || null,
          dealerName: data.dealer_name || null,
        };
        store.log('portal', mob + ' is portal user ' + value.userId + ' (' + (value.username || '?') + ')');
      }
    } catch (e) {
      // 404 "User not found for mobile" is the normal answer for a number
      // nobody has put on a portal user. Not an error worth shouting about.
      const msg = String((e && e.message) || e);
      if (!/404/.test(msg)) store.log('portal', 'user lookup for ' + mob + ' failed: ' + msg.slice(0, 100));
    }
    userCache.set(mob, { at: Date.now(), value });
    return value;
  },

  // THE COMMERCIAL ANSWER: stock AND what it costs this customer.
  //
  // `PUSH_ORDER/analyze` (below) answers "can this be punched" - allocations,
  // blocking errors, interbranch - and nothing about money. We used only that,
  // so every rate question had to go to a person while the figures were one
  // call away. 12 Sep, live, for Kalra Motors (account 265):
  //
  //   16510M65L10 x5 -> status "Available", mrp 105, discount_percent 12,
  //   tax_percent 18, price 92.4, hsn 84212300, allocations[{23, qty 5, tat 1}]
  //
  // Four statuses come back: Available / Partially Available / Not Available /
  // Invalid Part No - and the money is filled in even for the ones with no
  // stock, so an on-order part can still be quoted.
  //
  // `account_id` is REQUIRED (422 without it), so this only runs for a
  // customer the portal knows; everyone else falls back to the plain analyze.
  // `price` is the customer's rate after their discount. `base_price` in the
  // allocations is OUR purchase cost - it stays inside the response and is
  // never put on a line.
  async commercialAnalyze(lines, ctx) {
    if (!lines || !lines.length) return [];
    const accountId = ctx && (ctx.accountId || ctx.buyerId);
    if (!accountId) return null; // the caller falls back to analyze()
    if (isMock()) return mockCommercial(lines);

    const branch = (ctx && ctx.branchId) || dp.sourceBranchDealerId;
    const body = {
      account_id: Number(accountId),
      items: lines.map((l) => ({ part_no: portalPartNo(l.partNo || l.item), quantity: Number(l.qty) || 1 })),
    };
    if (branch) body.source_branch_dealer_id = Number(branch);

    const data = await api('POST', '/PUSH_ORDER/commercial-analyze', body);
    const rows = Array.isArray(data) ? data : (data && (data.items || data.data || data.results)) || [];
    if (!rows.length) return null;

    // Matched by part number, never by position: a reordered reply must not
    // hand one customer's line another line's price.
    // One QUEUE per part number, not one row. A list can ask for the same
    // part twice ("5 now, and 2 for the other car") and the portal answers
    // each line; a plain map handed both lines the last answer, so a request
    // for 5 reported the availability of the 999 line next to it.
    const byPart = new Map();
    for (const r of rows) {
      const k = norm(r.part_no);
      if (!byPart.has(k)) byPart.set(k, []);
      byPart.get(k).push(r);
    }

    return lines.map((line) => {
      const queue = byPart.get(norm(line.partNo || line.item));
      // Take them in order; if the portal answered once for a part asked
      // twice, the same row serves both.
      const row = queue && queue.length ? (queue.length > 1 ? queue.shift() : queue[0]) : null;
      if (!row) {
        return {
          item: line.item,
          partNo: line.partNo || line.item,
          qty: Number(line.qty) || 1,
          source: 'unknown',
          available: 0,
          vendors: [],
          eta: 'checking',
        };
      }
      const allocations = row.allocations || [];
      const available = allocations.reduce((s, a) => s + (Number(a.qty) || 0), 0);
      const out = normaliseLine(line, {
        // The catalogue name is kept aside, not swapped in: the customer
        // recognises the words they typed, not "OIL FILTER | ALTO | #165...".
        name: null,
        partNo: row.part_no,
        available,
        known: row.status !== 'Invalid Part No',
        vendors: allocations.map((a) => ({
          name: a.dealer_name,
          dealerId: a.dealer_id,
          qty: Number(a.qty) || 0,
          price: a.price,
          mrp: a.mrp,
          tatDays: a.tat_days,
          interbranch: Boolean(a.is_interbranch_transfer),
        })),
        price: row.price,
        mrp: row.mrp,
        raw: row,
      });
      // Everything the portal said, kept on the line. "Do not drop other
      // information" — Anik, 12 Sep: the next question ("kya rate hai", "GST",
      // "kitne din") is then answered from what we already have.
      out.rate = numOrNull(row.price);
      out.mrp = numOrNull(row.mrp);
      out.discountPercent = numOrNull(row.discount_percent);
      out.taxPercent = numOrNull(row.tax_percent);
      out.hsn = row.hsn_code || null;
      out.partName = row.part_name || null;
      out.portalStatus = row.status || null;
      out.shortfall = numOrNull(row.shortfall);
      out.tatDays = allocations.length ? numOrNull(allocations[0].tat_days) : null;
      out.commercial = true;
      return out;
    });
  },

  // `ctx` (optional) carries the resolved customer, so the portal allocates
  // against THAT buyer's home branch instead of the bot account's own.
  //
  // Two portal behaviours shape this method:
  //   1. ONE unknown part rejects the WHOLE batch (400 INVALID_PART_NO), so a
  //      single typo would otherwise lose the customer's entire order.
  //   2. A rejected part number is usually RIGHT but written differently —
  //      separators ("77220M74T00-5PK" vs "71711M55R005PK") or OCR letter/digit
  //      confusion (a photographed "37410M68P00" arrives as "37410M68POO").
  //
  // So: keep one slot per requested line, and each round send only the lines
  // still unresolved. Parts the portal named as invalid move to their next
  // spelling; everything else simply retries. No recursion, no re-ordering —
  // a line's answer always lands back in its own slot.
  async analyze(lines, ctx) {
    if (!lines || !lines.length) return [];
    if (isMock()) return mockAnalyze(lines);

    const failed = (line, source) => ({
      item: line.item,
      partNo: line.partNo || line.item,
      qty: Number(line.qty) || 1,
      source,
      available: 0,
      vendors: [],
      eta: source === 'unidentified' ? 'part not recognised' : 'checking',
    });

    const VARIANTS = [
      ['separators removed', (p) => p.replace(/[^A-Z0-9]/g, '')],
      ['O read as 0, I as 1', (p) => p.replace(/O/g, '0').replace(/I/g, '1')],
      ['both', (p) => p.replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1')],
    ];

    const out = new Array(lines.length).fill(null);
    const slots = lines.map((line, slot) => ({ slot, line, partNo: portalPartNo(line.partNo || line.item) }));

    // one call for a set of slots; assigns results, or throws with the list of
    // part numbers the portal refused
    const askFor = async (group) => {
      const batch = group.map((p) => ({ ...p.line, partNo: p.partNo }));
      const data = await api('POST', dp.analyzePath, buildAnalyzeRequest(batch, ctx));
      const resolved = readAnalyzeResponse(data, batch);
      group.forEach((p, k) => {
        out[p.slot] = resolved[k];
      });
    };

    // 1. The whole order in one call — the normal case.
    let rejected = [];
    try {
      await askFor(slots);
      return out;
    } catch (e) {
      rejected = invalidPartsFrom(e);
      if (!rejected.length) {
        store.log('portal', 'analyze failed: ' + String(e.message || e).slice(0, 160));
        return lines.map((l) => failed(l, 'unknown'));
      }
    }

    // 2. Peel the bad parts off until what remains goes through together, so
    //    a single bad part never costs the customer the rest of the order.
    //    NOTE: the portal names only SOME invalid parts per response, so one
    //    pass is not enough — keep splitting until the batch is accepted.
    //    Each pass removes at least one line, so this always terminates.
    const refused = slots.filter((p) => rejected.some((b) => same(b, p.partNo)));
    let group = slots.filter((p) => !rejected.some((b) => same(b, p.partNo)));
    while (group.length) {
      try {
        await askFor(group);
        break;
      } catch (e2) {
        const bad2 = invalidPartsFrom(e2);
        if (!bad2.length) {
          store.log('portal', 'analyze (clean batch) failed: ' + String(e2.message || e2).slice(0, 120));
          group.forEach((p) => {
            out[p.slot] = failed(p.line, 'unknown');
          });
          break;
        }
        const peeled = group.filter((p) => bad2.some((b) => same(b, p.partNo)));
        group = group.filter((p) => !bad2.some((b) => same(b, p.partNo)));
        refused.push(...peeled);
        if (!peeled.length) break; // nothing removed — avoid spinning
      }
    }

    // 3. Each refused part on its own, walking the spellings. One at a time so
    //    one hopeless part can never drag a fixable one down with it.
    for (const p of refused) {
      let done = false;
      for (const [label, rewrite] of VARIANTS) {
        const candidate = rewrite(p.partNo);
        if (candidate === p.partNo || !candidate) continue;
        try {
          await askFor([{ ...p, partNo: candidate }]);
          store.log('portal', `analyze: "${p.partNo}" resolved as "${candidate}" (${label})`);
          done = true;
          break;
        } catch {
          // try the next spelling
        }
      }
      if (!done) {
        store.log('portal', `analyze: portal does not know "${p.partNo}" in any spelling`);
        out[p.slot] = failed(p.line, 'unidentified');
      }
    }

    return out.map((r, i) => r || failed(lines[i], 'unidentified'));
  },

  // Punch the confirmed sales order. Throws on failure — the caller must NOT
  // tell the customer an order exists unless the portal actually made one.
  async confirm(order) {
    if (isMock()) {
      const soNumber = 'SO-' + store.nextSeq('so');
      store.log('portal', `MOCK sales order punched: ${soNumber} (${order.lines.length} lines)`);
      return { soNumber };
    }
    const data = await api('POST', dp.confirmPath, buildConfirmRequest(order));
    const result = readConfirmResponse(data);
    store.log('portal', `sales order punched: ${result.soNumber}`);
    return result;
  },
};
