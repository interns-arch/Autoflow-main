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
