'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}
function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function times(v, fallback) {
  const out = list(v).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
  return out.length ? out : fallback;
}
// "919810238966:NK Jain, 919999492550:Prateek Jain" -> { 919810238966: 'NK Jain', … }
// A name against a number, so an approval reads "Prateek Sir ne approve kiya"
// rather than a twelve-digit number nobody recognises.
function nameMap(v) {
  const out = {};
  for (const pair of list(v)) {
    const i = pair.indexOf(':');
    const phone = digits(i < 0 ? pair : pair.slice(0, i));
    if (!phone) continue;
    out[phone] = (i < 0 ? '' : pair.slice(i + 1).trim()) || phone;
  }
  return out;
}

function bool(v, dflt = false) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === '1' || s === 'yes';
}

// SCOPE (Aneeq sir, current phase): only the customer/sales bot is in play.
// purchase / warehouse / finance / helpdesk are PARKED — their code is kept
// but they are not started unless ENABLE_EXTRA_BOTS=true. Vendor stock now
// lives in the Dealer Portal (pushed there by ProcureHub), so this process
// no longer collects stock, places POs, or chases invoices.
const SALES_BOTS = ['customer'];
const EXTRA_BOTS = ['purchase', 'warehouse', 'finance', 'helpdesk'];

const config = {
  tz: process.env.TZ || 'Asia/Kolkata',
  // Render (and most PaaS) inject PORT. CONSOLE_PORT stays as the local name.
  consolePort: parseInt(process.env.PORT || process.env.CONSOLE_PORT || '3010', 10),
  // DATA_DIR lets the state file live on a mounted persistent disk in
  // production (Render disk), instead of inside the deploy directory which
  // is wiped on every deploy.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // A directory BOTH containers mount (docker-compose: /shared), only for the
  // few things one of them writes and the other reads: the data-entry desk's
  // open "naam ye rakhun?" questions and the part names it confirmed. Never
  // state.json, which each container rewrites whole on every save.
  sharedDir: process.env.SHARED_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'shared'),

  // Parked bots stay off unless explicitly switched on.
  enableExtraBots: bool(process.env.ENABLE_EXTRA_BOTS, false),

  bots: {
    purchase: { number: digits(process.env.PURCHASE_BOT_NUMBER), label: 'Purchase Bot (414)' },
    customer: { number: digits(process.env.CUSTOMER_BOT_NUMBER), label: 'Customer Bot (421)' },
    warehouse: { number: digits(process.env.WAREHOUSE_BOT_NUMBER), label: 'Warehouse Bot' },
    finance: { number: digits(process.env.FINANCE_BOT_NUMBER), label: 'Finance Bot' },
    helpdesk: { number: digits(process.env.HELPDESK_BOT_NUMBER), label: 'HR/IT Helpdesk Bot' },
  },

  // DM whitelist: sirf in numbers (ya LID digits) ke DMs process honge;
  // khali = koi DM nahi; "all" = sab DMs (sirf testing ke liye)
  customerDms: list(process.env.CUSTOMER_DMS).map(digits).filter(Boolean),
  customerDmsAll: list(process.env.CUSTOMER_DMS).some((v) => v.toLowerCase() === 'all'),
  warehouseTeamNumbers: list(process.env.WAREHOUSE_TEAM_NUMBERS).map(digits).filter(Boolean),
  // Numbers added to EVERY customer group the bot creates (dealer, customer
  // care, monitoring...). The customer's own number is added on top.
  groupDefaultMembers: list(process.env.GROUP_DEFAULT_MEMBERS).map(digits).filter(Boolean),
  groupSubjectPrefix: (process.env.GROUP_SUBJECT_PREFIX || 'Cartrends').trim(),
  internalWarehouseName: process.env.INTERNAL_WAREHOUSE_NAME || 'Bijwasan',

  stockBroadcastTimes: times(process.env.STOCK_BROADCAST_TIMES, ['09:30', '16:00']),
  ivrFollowupTimes: times(process.env.IVR_FOLLOWUP_TIMES, ['11:30', '17:30']),
  invoiceChaseCron: process.env.INVOICE_CHASE_CRON || '0 * * * *',

  // ---- Dealer Portal: the ONLY source of stock and the ONLY place orders
  // are punched. Vendor stock reaches it from ProcureHub, not from here.
  dealerPortal: {
    baseUrl: (process.env.DEALER_PORTAL_BASE_URL || '').trim().replace(/\/$/, ''),
    username: (process.env.DEALER_PORTAL_USERNAME || '').trim(),
    password: (process.env.DEALER_PORTAL_PASSWORD || '').trim(),
    // Permanent / refresh token. When set, no interactive login is performed.
    token: (process.env.DEALER_PORTAL_TOKEN || '').trim(),
    // Endpoint paths are env-configurable ON PURPOSE: /auth/login is verified,
    // but the analyze/confirm paths are still to be confirmed with Aneeq sir.
    // When he shares them this is a .env change, not a code change.
    loginPath: (process.env.DEALER_PORTAL_LOGIN_PATH || '/auth/login').trim(),
    // The access token lasts 8 hours. Renewing it a few minutes early costs
    // one request; discovering it expired costs a customer a failed message
    // and a retry. Verified 21 Sep against the live portal.
    refreshPath: (process.env.DEALER_PORTAL_REFRESH_PATH || '/auth/refresh-token').trim(),
    // DISCOVERED from the live OpenAPI spec (vagmine.vagminetech.com), 1 Sep 2026:
    //   analyze -> POST /api/v1/PUSH_ORDER/analyze      { items:[{part_no,quantity}] }
    //   confirm -> POST /api/v1/purchase-orders/confirm { user_id, lines:[...] }
    // Paths here are relative to DEALER_PORTAL_BASE_URL (which ends in /api/v1).
    analyzePath: (process.env.DEALER_PORTAL_ANALYZE_PATH || '/PUSH_ORDER/analyze').trim(),
    confirmPath: (process.env.DEALER_PORTAL_CONFIRM_PATH || '/purchase-orders/confirm').trim(),
    // confirm requires user_id; analyze needs a dealer-linked token. The
    // branch id scopes allocation to a Cartrends warehouse (e.g. 103 =
    // Bijwasan Hub HO, 23 = Bijwasan Warehouse).
    userId: parseInt(process.env.DEALER_PORTAL_USER_ID || '0', 10) || null,
    // commercial-analyze prices against an ACCOUNT. For a customer the portal
    // knows we use theirs, and they get their own discount. For everyone else
    // — a number not registered yet — this account is used to read the
    // portal's MRP, and ONLY the MRP: the discount on it belongs to this
    // account, not to the person asking. Unset = no portal price for an
    // unregistered customer, and the Odoo MRP is used as before.
    listPriceAccountId: parseInt(process.env.DEALER_PORTAL_ACCOUNT_ID || '0', 10) || null,
    sourceBranchDealerId: parseInt(process.env.DEALER_PORTAL_BRANCH_ID || '0', 10) || null,
    timeoutMs: parseInt(process.env.DEALER_PORTAL_TIMEOUT_MS || '20000', 10),
    // A quoted quantity goes stale: another order may take the same stock.
    // Past TTL a confirm re-checks and asks again; past MAX_AGE the draft is
    // abandoned and the customer is asked to resend.
    quoteTtlMinutes: parseInt(process.env.QUOTE_TTL_MINUTES || '60', 10),
    quoteMaxAgeHours: parseInt(process.env.QUOTE_MAX_AGE_HOURS || '24', 10),

    // MASTER SWITCH for punching real sales orders. While testing against the
    // live portal every stray "yes" creates a real order someone has to cancel
    // by hand, so this defaults to OFF: the bot quotes, drafts and answers
    // exactly as it will in production, and stops at the last step.
    // Set ORDER_CONFIRM_ENABLED=true in .env to go live.
    confirmEnabled: String(process.env.ORDER_CONFIRM_ENABLED || '').trim().toLowerCase() === 'true',

    // SEPARATE admin identity for the data-entry script. The sales bot must not
    // hold the right to create users or move product prices — it runs all day
    // on messages from outside the company. Blank = fall back to the sales
    // account, which then fails on create with a clear permission error.
    adminUsername: (process.env.DEALER_PORTAL_ADMIN_USERNAME || '').trim(),
    adminPassword: (process.env.DEALER_PORTAL_ADMIN_PASSWORD || '').trim(),
    adminToken: (process.env.DEALER_PORTAL_ADMIN_TOKEN || '').trim(),

    // Token lifecycle: the portal's access_token expires; these control
    // proactive refresh so no customer request ever hits an expired token.
    tokenLifetimeMs: parseFloat(process.env.DEALER_PORTAL_TOKEN_LIFETIME_HOURS || '8') * 60 * 60 * 1000,
    refreshBeforeMs: parseFloat(process.env.DEALER_PORTAL_REFRESH_BEFORE_MIN || '5') * 60 * 1000,
  },

  // Official WhatsApp Cloud API (Meta) — customer line ka production transport
  cloud: {
    token: (process.env.WA_CLOUD_TOKEN || '').trim(),
    phoneNumberId: (process.env.WA_PHONE_NUMBER_ID || '').trim(),
    wabaId: (process.env.WA_WABA_ID || '').trim(),
    verifyToken: (process.env.WA_VERIFY_TOKEN || 'cartrends-autoflow-verify').trim(),
    // Meta signs every webhook POST with this (App Settings -> Basic ->
    // App Secret). Unset = signatures are not checked, which is how it was
    // until 12 Sep: anyone who knew the public URL could post as a customer.
    appSecret: (process.env.WA_APP_SECRET || '').trim(),
  },
  // 'linked' (QR wala, default) ya 'cloud' (official API) — customer bot ke liye
  customerTransport: (process.env.CUSTOMER_TRANSPORT || 'linked').trim().toLowerCase(),

  // Render par chal raha webhook relay (incoming Cloud API messages ka rasta)
  relay: {
    url: (process.env.WEBHOOK_RELAY_URL || '').trim().replace(/\/$/, ''),
    secret: (process.env.WEBHOOK_RELAY_SECRET || '').trim(),
    // 3s poll meant a customer could wait 3s before the bot even SAW the
    // message — the slowest part of the whole round trip. 1.2s halves the
    // felt delay and also keeps the free Render instance awake.
    pollMs: parseInt(process.env.WEBHOOK_RELAY_POLL_MS || '1200', 10),
  },

  adminNumbers: list(process.env.ADMIN_NUMBERS).map(digits).filter(Boolean),

  // Who hears about a Data Entry request that could NOT be completed. Kept
  // separate from ADMIN_NUMBERS on purpose: the people who run the bot are
  // not the people who chase an incomplete request form.
  dataEntryAlertNumbers: list(process.env.DATA_ENTRY_ALERT_NUMBERS).map(digits).filter(Boolean),
  // Numbers that only ever ASK. They get a straight availability answer and
  // nothing else: no cart, no "confirm?", no order. Founder's line — "vo
  // kabhi order karenge hi nahi, to unka draft bhi mat banana."
  inquiryOnlyNumbers: list(process.env.INQUIRY_ONLY_NUMBERS).map(digits).filter(Boolean),
  // Salesmen: the numbers that may order FOR a customer ("Kalra Motors ka SO
  // bana do"). Written 91XXXXXXXXXX - normPhone() never adds the prefix.
  salesTeamNumbers: list(process.env.SALES_TEAM_NUMBERS).map(digits).filter(Boolean),
  // PDF reading shells out to Python. It can be switched off without touching
  // the rest of the bot — it degrades to "ask a person", which is what
  // happened before it existed.
  // How long an out-of-stock part takes. The portal gives no lead time of
  // its own (every allocation comes back with tatDays: null), so this is the
  // founder's rule, written once. Shown to the customer as "ETA = 7 days".
  onOrderEtaDays: Math.max(1, parseInt(process.env.ON_ORDER_ETA_DAYS || '7', 10)),
  documents: {
    pdf: (process.env.PDF_READING || 'on').toLowerCase() !== 'off',
  },
  dailyReportTime: (process.env.DAILY_REPORT_TIME || '20:00').trim(),

  // human-confirm escalation: confusion par is number ko DM, itni der jawab
  // ka intezar, phir customer ko fallback reply. Helper ka jawab PERMANENTLY
  // seekha jaata hai (core/knowledge.js) — wahi sawal dobara nahi poocha jaata.
  escalationNumber: digits(process.env.ESCALATION_NUMBER || '917004130460'),
  // Voice notes go to their OWN person. Nothing else about escalation
  // changes: part questions, documents, rates and everything else still go
  // to escalationNumber exactly as before.
  voiceEscalationNumber: digits(
    process.env.VOICE_ESCALATION_NUMBER || process.env.ESCALATION_NUMBER || '917004130460',
  ),
  escalationTimeoutMs: Math.max(10, parseFloat(process.env.ESCALATION_TIMEOUT_MIN || '5') * 60) * 1000,

  ivr: {
    provider: (process.env.IVR_PROVIDER || 'mock').trim().toLowerCase(),
    twilio: {
      sid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
      token: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
      from: (process.env.TWILIO_FROM_NUMBER || '').trim(),
    },
  },

  // The IT-support mailbox the approved Data Entry requests land in.
  // IMAP + a Google App Password: no OAuth client, no Cloud project, nothing
  // that needs a second person to set up.
  // The IT-support mailbox the approved Data Entry requests land in.
  // Reuses the Gmail OAuth credentials already in .env. The token is scoped
  // gmail.readonly, so this can read mail and nothing else — it cannot mark,
  // move or delete anything.
  mailbox: {
    clientId: (process.env.GMAIL_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GMAIL_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.GMAIL_REFRESH_TOKEN || '').trim(),
    // Gmail search syntax — the same string you can paste into Gmail's own
    // search box to see exactly what the bot will pick up.
    // newer_than keeps a first live run from trying to create every account in
    // the mailbox's history — there are ~200 of them, all long since entered
    // by hand. Widen it deliberately, never by accident.
    query: (process.env.MAIL_QUERY || 'subject:("Creation Request") newer_than:2d').trim(),
    pollMinutes: parseInt(process.env.GMAIL_POLL_INTERVAL_SECONDS || '300', 10) / 60,
    // OFF by default, like order confirmation: reading mail is safe, creating
    // accounts in the live portal is not something a default should enable.
    autoCreate: String(process.env.MAIL_AUTO_CREATE || '').trim().toLowerCase() === 'true',
  },

  // Odoo (erp.cartrends.co.in): read-only, for the ledger and credit notes
  // behind a customer's balance. ODOO_URL may be pasted with the web
  // client's /odoo path; integrations/odoo.js uses its origin.
  odoo: {
    url: (process.env.ODOO_URL || '').trim(),
    db: (process.env.ODOO_DB || '').trim(),
    username: (process.env.ODOO_USERNAME || '').trim(),
    apiKey: (process.env.ODOO_API_KEY || '').trim(),
    timeoutMs: Number(process.env.ODOO_TIMEOUT_MS || 30000),
  },

  ai: {
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim(),
    // Phase 3 of the pipeline review: the Understand model runs beside the bot
    // and writes what it WOULD have decided to /shared/shadow.jsonl. It answers
    // nobody. AI_SHADOW=true switches it on (pipeline/shadow).
    shadow: (process.env.AI_SHADOW || '').toLowerCase() === 'true',
    // The production image ships no tesseract and no PowerShell (see the
    // Dockerfile: OCR is CPU-heavy and this host has none spare). Spawning two
    // processes per photo that can only fail costs seconds of the customer's
    // wait for nothing. On Windows the local OCR is real and stays on.
    // AI_OCR=on / off overrides either way.
    ocr: (process.env.AI_OCR || '').toLowerCase() === 'on'
      ? true
      : (process.env.AI_OCR || '').toLowerCase() === 'off'
        ? false
        : process.platform === 'win32',
  },

  // GSTIN -> the firm (integrations/gst, gstinapi.in). Fills in the half of
  // the customer form nobody should have to type. NOTE the URL has no /api
  // in it — /api/v1/gstin answers "Route not found" for every key, which
  // looks exactly like a bad one. Blank key = the form asks by hand.
  gst: {
    apiKey: (process.env.GST_API_KEY || '').trim(),
    url: (process.env.GST_API_URL || 'https://gstinapi.in/v1/gstin').trim(),
    timeoutMs: parseInt(process.env.GST_TIMEOUT_MS || '15000', 10),
  },

  // NEW CUSTOMER, asked for over WhatsApp.
  //
  // The paper form is "filled by the sales person, goes to Sales Head for
  // approval, then to the data team". This is the same form asked one
  // question at a time in chat — and the approval step is kept, because the
  // fields it gates are credit and discount. Nothing reaches the portal
  // until an approver says yes.
  //
  // The phone:name lists were already in .env and read by nothing; this is
  // what finally uses them.
  creation: {
    // Who may be asked to fill one in, and what to call them.
    team: nameMap(process.env.CREATION_TEAM_NUMBERS),
    // Who says yes. Without one of these the flow still collects, but
    // nothing can be created — deliberately.
    approvers: nameMap(process.env.CREATION_APPROVER_NUMBERS),
    // Told when an account is made, so the desk is not surprised by it.
    notify: nameMap(process.env.CREATION_NOTIFY_NUMBERS),
    // The commercial terms a CUSTOMER is never asked for. A person being
    // onboarded does not set their own credit limit.
    defaultCreditDays: parseInt(process.env.CREATION_DEFAULT_CREDIT_DAYS || '1', 10),
    defaultCreditLimit: parseFloat(process.env.CREATION_DEFAULT_CREDIT_LIMIT || '100000'),
  },

  // Number plate -> what the car is (integrations/vahan). Cashfree's
  // verification suite wraps the VAHAN registry; the key is their client
  // SECRET and the client id rides in VAHAN_API_HEADERS as x-client-id.
  // Their production API refuses any IP not whitelisted in their dashboard,
  // so a new server needs its IP added there before this works at all.
  // Blank key = mock mode, reading data/mock-vehicles.json.
  vahan: {
    apiKey: (process.env.VAHAN_API_KEY || '').trim(),
    url: (process.env.VAHAN_API_URL || 'https://api.cashfree.com/verification/vehicle-rc').trim(),
    // Their reference field differs between products, so it is named in env.
    refParam: (process.env.VAHAN_API_REF_PARAM || 'verification_id').trim(),
    timeoutMs: parseInt(process.env.VAHAN_TIMEOUT_MS || '20000', 10),
    headers: (() => {
      try {
        const h = JSON.parse(process.env.VAHAN_API_HEADERS || '{}');
        return h && typeof h === 'object' ? h : {};
      } catch (e) {
        // A broken JSON blob here must not stop the bot booting — the
        // lookup simply goes without the header and says why.
        return {};
      }
    })(),
  },

  // A SECOND pair of eyes on a photo, for when the first is unavailable.
  //
  // 21 Sep: the Anthropic key was revoked and every photo stopped being read —
  // one dead credential took the whole photo path down, and with local OCR off
  // there was nothing behind it. Claude is still tried first; this runs only
  // when that fails or is not configured. Same GEMINI_API_KEY as the voice
  // notes use, but its own model: reading a label is not transcribing audio.
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    // gemini-2.5-flash is RETIRED (404 "no longer available to new users").
    // 3.5-flash read the test label correctly in 3s on 21 Sep.
    visionModel: (process.env.GEMINI_VISION_MODEL || 'gemini-3.5-flash').trim(),
    timeoutMs: parseInt(process.env.GEMINI_VISION_TIMEOUT_MS || '30000', 10),
  },

  // How long an answer that is not a part number stays good for.
  knowledgeMemory: {
    // "We do not carry that" is true of a catalogue, not forever. After this
    // many days the question goes back to a person once, in case it is now
    // stocked. A wrong "not available" costs a sale; one extra question does
    // not.
    notCarriedDays: parseInt(process.env.NOT_CARRIED_MEMORY_DAYS || 30, 10),
  },

  // The catalogue index: which PART the customer means. Never what it costs
  // or whether we have it - see core/parts.
  // THE AGENT.
  //
  // One agent, every tool, a docstring on each so the model chooses rather
  // than a router deciding for it. Flash Lite because routing accuracy is
  // what matters here and it measured 94% at a fraction of the latency.
  agent: {
    // The name it answers to and signs off as. Appears in the system prompt
    // and nowhere else, so changing it here changes it everywhere.
    name: process.env.AGENT_NAME || 'Prateek',
    model: process.env.AGENT_MODEL || 'gemini-3.5-flash-lite',
    // OFF by default. Nothing reaches a customer through the agent until
    // this is set, so the existing deterministic path stays in charge while
    // the agent is being driven by hand from a test number.
    enabled: String(process.env.AGENT_ENABLED || '').toLowerCase() === 'true',
    // Numbers allowed to talk to the agent while it is being trialled. Empty
    // means nobody, even when enabled is true.
    allowFrom: String(process.env.AGENT_ALLOW_FROM || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // A runaway loop costs money and makes a customer wait. Measured: a
    // normal part-and-price turn is 2 to 4 tool calls.
    maxToolCalls: parseInt(process.env.AGENT_MAX_TOOL_CALLS || '10', 10),
    // THE OPEN WEB, for finding a part number our own sources do not have.
    // Grounded search runs through Gemini on the key the bot already holds,
    // so there is no second vendor and no second bill. Flash rather than
    // Flash Lite: this call reads search results, which is the one job in
    // the loop where the bigger model earns its latency.
    webSearchModel: process.env.AGENT_WEB_SEARCH_MODEL || 'gemini-3.5-flash',
    webSearchTimeoutMs: parseInt(process.env.AGENT_WEB_SEARCH_TIMEOUT_MS || '20000', 10),
    // How long a question may sit with the specialist before the paused
    // conversation is given up on. Longer than escalation's own five-minute
    // nudge on purpose: a hard part can take him an afternoon, and the
    // customer has already been told someone is looking.
    hitlHours: parseInt(process.env.AGENT_HITL_HOURS || '48', 10),
  },

  parts: {
    // Lower than the knowledge threshold on purpose. A part name is a short,
    // dense string and the customer writes a different short, dense string;
    // "Cartend wiper blade 16 number" against "Wiper Blade | 16 Inches | All
    // Cars" is a real match that scores nothing like a paraphrased sentence.
    // Tune with /api/parts/search before trusting it.
    threshold: parseFloat(process.env.PARTS_SIMILARITY_THRESHOLD || '0.60'),
    topK: parseInt(process.env.PARTS_TOP_K || '5', 10),
    // How far clear the best match must be from the runner-up. Two parts a
    // whisker apart is the wiper case - right size, wrong brand, sitting
    // next to each other - and a near-tie is shown rather than chosen.
    margin: parseFloat(process.env.PARTS_MATCH_MARGIN || '0.03'),
  },

  // ---------------------------------------------------------------- knowledge
  // The self-learning knowledge base: what a person has told us that is worth
  // telling the next customer who asks the same thing. Postgres + pgvector,
  // separate from data/state.json on purpose — see core/kb/db.js.
  //
  // With DATABASE_URL unset the whole feature is OFF and the bot behaves
  // exactly as it did before: it asks a person. Nothing degrades silently.
  kb: {
    databaseUrl: (process.env.DATABASE_URL || '').trim(),
    ssl: /^(1|true|yes)$/i.test(process.env.DATABASE_SSL || ''),
    poolMax: parseInt(process.env.DATABASE_POOL_MAX || '5', 10),
    connectTimeoutMs: parseInt(process.env.DATABASE_CONNECT_TIMEOUT_MS || '4000', 10),

    // Gemini's embedding endpoint, using the key the vision and voice paths
    // already use.
    //
    // text-embedding-004 was the default here and answers 404 on this key —
    // the same way gemini-2.5-flash was retired under the vision path. The
    // models this account can actually call are gemini-embedding-001 and
    // gemini-embedding-2; -001 is the one measured against real questions.
    // It returns 3072 floats by default and is asked for 768 via
    // outputDimensionality, which MUST match the vector(768) column in
    // migrations/001 — change one without the other and every search fails.
    embeddingModel: (process.env.EMBEDDING_MODEL || 'gemini-embedding-001').trim(),
    embeddingDim: parseInt(process.env.EMBEDDING_DIM || '768', 10),
    embeddingTimeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '10000', 10),

    // How close a stored question must be before it is even considered.
    //
    // 0.85 came from the specification and was WRONG for this model: measured
    // against the real endpoint, a stored return-policy entry scores 0.80
    // against "Can I return this part?" and 0.76 against "Ye part wapas ho
    // sakta hai?" — so nothing ever matched and nothing was ever recalled.
    // Unrelated questions sit at 0.46-0.53, so the gap is wide and real; the
    // threshold just has to be inside it. Measured 22 Sep on
    // gemini-embedding-001 at 768 dims. Re-measure with /api/kb/search if the
    // model or the dimension ever changes.
    similarityThreshold: parseFloat(process.env.KNOWLEDGE_SIMILARITY_THRESHOLD || '0.65'),
    topK: parseInt(process.env.KNOWLEDGE_TOP_K || '5', 10),
    // Below this the model's own "yes this answers it" is not trusted either.
    minConfidence: parseFloat(process.env.KNOWLEDGE_MIN_CONFIDENCE || '0.75'),
    // Two stored entries this close are the same question, and the second one
    // updates the first instead of becoming a duplicate.
    //
    // Measured on gemini-embedding-001, comparing whole entries (question +
    // answer + keywords, which is what duplicate detection compares):
    //   0.976  same question, answer corrected 7 days -> 15 days
    //   0.976  reworded question, same answer
    //   0.946  Hinglish question, same answer
    //   0.799  a different subject entirely
    // 0.93 left the Hinglish case clearing by 0.016 - one phrasing away from
    // silently creating a second copy. 0.90 sits between the two groups.
    duplicateThreshold: parseFloat(process.env.KNOWLEDGE_DUPLICATE_THRESHOLD || '0.90'),

    // Who may call the knowledge-management API. Unset = the endpoints refuse
    // every request rather than standing open.
    apiToken: (process.env.KNOWLEDGE_API_TOKEN || '').trim(),
  },

  // Voice notes -> text, for the HELPER to read. Claude takes no audio at all,
  // so this is Google. Blank key = the whole feature is off and voice notes
  // reach a person exactly as they did before.
  //
  // Use a BILLED key: Google's pricing page says free-tier content is "used to
  // improve our products". These are real customers' voices. The bill is
  // nothing either way — audio counts at 32 tokens/second, so a 15-second note
  // is about 480 tokens.
  speech: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    // gemini-2.5-flash was the default and Google RETIRED it: on 12 Sep the
    // API answered 404 "no longer available to new users", so every voice
    // note in the Kalra replay went to a person instead of being read.
    // gemini-3.5-flash transcribes the same file fine. (gemini-3.5-transcribe
    // exists and is cheaper, but returned an empty transcript for our opus.)
    model: (process.env.GEMINI_MODEL || 'gemini-3.5-flash').trim(),
    timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '15000', 10),
    // Inline audio has to fit in the request. A WhatsApp voice note is opus at
    // roughly 1KB/second, so 8MB is minutes of speech — far past anything a
    // customer sends about an order.
    maxBytes: parseInt(process.env.GEMINI_MAX_AUDIO_BYTES || '8000000', 10),
  },
};

config.isLive = (botKey) => Boolean(config.bots[botKey] && config.bots[botKey].number);
config.SALES_BOTS = SALES_BOTS;
config.EXTRA_BOTS = EXTRA_BOTS;
// Bots actually booted this run.
config.BOTS = config.enableExtraBots ? [...SALES_BOTS, ...EXTRA_BOTS] : [...SALES_BOTS];

module.exports = config;
