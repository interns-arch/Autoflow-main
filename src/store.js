'use strict';
// Simple JSON persistence layer. One state file, atomic debounced writes.
// Deliberately dependency-free so the system installs cleanly on Windows;
// the accessors below are the only surface, so swapping in SQLite later is local.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.dataDir, 'state.json');

const DEFAULT_STATE = {
  seq: { order: 1000, po: 5000, ticket: 100, so: 20000, ppo: 30000, inquiry: 1 },
  // NOTE: this process holds NO stock. Vendor stock lives in the Dealer
  // Portal (ProcureHub pushes it there); availability comes from the portal's
  // analyze API. `vendors` is kept ONLY for the parked purchase bot.
  vendors: [],        // {id, name, phone, aliases[], lastRequestAt, lastStockAt}
  orders: [],         // sales orders, see core/orders.js
  pos: [],            // purchase orders, see core/procurement.js
  invoicesOutstanding: [], // finance module: {customer, phone, amount, dueDate, lastReminderAt}
  customers: [],      // {phone, name, addedAt} — auto-captured from orders + console
  creditNotes: [],    // {id, cnNumber, customerPhone, amount, reason, createdAt, sharedAt}
  offers: [],         // broadcast history {id, text, sentTo, createdAt}
  crossSell: {        // item -> related items suggested after order confirmation
    'Brake Pad': ['Brake Fluid', 'Brake Disc'],
    'Oil Filter': ['Engine Oil', 'Air Filter'],
    'Air Filter': ['Oil Filter'],
    'Clutch Plate': ['Pressure Plate', 'Release Bearing'],
  },
  // chatId -> the numbered list we last sent them, so a swipe-reply saying
  // "Leave 9no. Item" survives a restart. See core/lists.js.
  numberedLists: {},
  knowledge: { aliases: {}, notes: [] }, // learned phrase->part + human notes
  inquiries: [],      // every asked-for line + outcome, see core/inquiries.js
  tickets: [],        // helpdesk: {id, from, category, text, status, createdAt}
  picklists: [],      // warehouse: {id, soNumber, lines, picker, status, createdAt}
  logs: [],           // capped activity log {ts, tag, msg}
};

let state = null;
let writeTimer = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  // forward-fill any keys added after first deploy
  for (const k of Object.keys(DEFAULT_STATE)) {
    if (state[k] === undefined) state[k] = JSON.parse(JSON.stringify(DEFAULT_STATE[k]));
  }
  return state;
}

function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error('[store] write failed:', e.message);
    }
  }, 150);
}

function nextSeq(name) {
  const s = load();
  s.seq[name] = (s.seq[name] || 0) + 1;
  save();
  return s.seq[name];
}

function log(tag, msg) {
  const s = load();
  s.logs.push({ ts: new Date().toISOString(), tag, msg });
  if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
  save();
  console.log(`[${tag}] ${msg}`);
}

function normPhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// ---------- vendors ----------
function vendors() {
  return load().vendors;
}
function findVendorByPhone(phone) {
  const p = normPhone(phone);
  return load().vendors.find((v) => normPhone(v.phone) === p) || null;
}
function findVendorByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return (
    load().vendors.find(
      (v) =>
        v.name.toLowerCase() === n ||
        (v.aliases || []).some((a) => a.toLowerCase() === n)
    ) || null
  );
}
function upsertVendor({ name, phone, aliases }) {
  const s = load();
  // match by phone only when a phone was actually given — otherwise every
  // phone-less vendor would collapse into the first one
  let v = (normPhone(phone) ? findVendorByPhone(phone) : null) || findVendorByName(name);
  if (v) {
    if (name) v.name = name;
    if (phone) v.phone = normPhone(phone);
    if (aliases) v.aliases = aliases;
  } else {
    v = {
      id: 'V' + (s.vendors.length + 1),
      name: name || 'Vendor ' + (s.vendors.length + 1),
      phone: normPhone(phone),
      aliases: aliases || [],
      lastRequestAt: null,
      lastStockAt: null,
    };
    s.vendors.push(v);
  }
  save();
  return v;
}
// Vendor/internal stock accessors exist ONLY for the PARKED purchase and
// warehouse bots (ENABLE_EXTRA_BOTS=true). They lazily create their own state
// section, so a sales-only run never carries a stock table at all — the
// Dealer Portal is the single source of stock.
function _legacyStock() {
  const s = load();
  if (!s.vendorStock) s.vendorStock = {};
  if (!s.internalStock) s.internalStock = [];
  return s;
}
function setVendorStock(vendorId, lines) {
  const s = _legacyStock();
  const now = new Date().toISOString();
  s.vendorStock[vendorId] = lines.map((l) => ({ ...l, updatedAt: now }));
  const v = s.vendors.find((x) => x.id === vendorId);
  if (v) v.lastStockAt = now;
  save();
}
function vendorStock(vendorId) {
  return _legacyStock().vendorStock[vendorId] || [];
}

// ---------- customers ----------
function customers() {
  return load().customers;
}
function upsertCustomer(phone, name) {
  const s = load();
  const p = normPhone(phone);
  if (!p) return null;
  let c = s.customers.find((x) => x.phone === p);
  if (!c) {
    c = { phone: p, name: name || '', addedAt: new Date().toISOString() };
    s.customers.push(c);
  } else if (name) {
    c.name = name;
  }
  save();
  return c;
}

// ---------- internal stock (PARKED bots only) ----------
function internalStock() {
  return _legacyStock().internalStock;
}
function setInternalStock(lines) {
  _legacyStock().internalStock = lines;
  save();
}
function adjustInternalStock(item, delta) {
  const s = _legacyStock();
  const row = s.internalStock.find((r) => r.item.toLowerCase() === item.toLowerCase());
  if (row) {
    row.qty = Math.max(0, row.qty + delta);
    save();
  }
}

// ---------- orders / POs ----------
function orders() {
  return load().orders;
}
function pos() {
  return load().pos;
}

// Tests only: write NOW rather than in 150 ms, and read the file again the
// way a freshly started process would.
function _flushNow() {
  clearTimeout(writeTimer);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}
function _reload() {
  state = null;
  return load();
}

module.exports = {
  _flushNow,
  _reload,
  load,
  save,
  nextSeq,
  log,
  normPhone,
  vendors,
  findVendorByPhone,
  findVendorByName,
  upsertVendor,
  setVendorStock,
  vendorStock,
  customers,
  upsertCustomer,
  internalStock,
  setInternalStock,
  adjustInternalStock,
  orders,
  pos,
};
