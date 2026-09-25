'use strict';
// EVERY REQUEST AND EVERY DECISION, in one file that outlives a restart.
//
// Accounts, discount rules and orders all go to the Sales Heads ("OK WA-…",
// "OK DSC-…", "OK ORD-…"), and until 25 Sep what happened to them lived only
// in the container log — which a restart empties. The 6 pm report
// (core/dailyApprovalReport) reads this file: who asked, who decided, when,
// and what it was.
//
// One JSON line per event in SHARED_DIR/approvals.jsonl:
//   { at, kind: 'account'|'discount'|'order', id, event: 'requested'|
//     'approved'|'rejected'|'failed', by, customer, phone, ...details }
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../store');

const file = () => path.join(config.sharedDir, 'approvals.jsonl');

function record(entry) {
  try {
    fs.mkdirSync(config.sharedDir, { recursive: true });
    fs.appendFileSync(file(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    // A report line that could not be written must never fail the approval.
    store.log('approvals', 'could not record ' + (entry && entry.id) + ': ' + String((e && e.message) || e).slice(0, 80));
  }
}

// Everything recorded between two instants (ISO strings or Dates).
function between(from, to) {
  let text = '';
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch (_) {
    return [];
  }
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const t = new Date(e.at).getTime();
      if (t >= a && t < b) out.push(e);
    } catch (_) {
      /* a torn line is skipped, not fatal */
    }
  }
  return out;
}

// The customer's details from an account form, as the report lists them.
function accountFacts(a) {
  a = a || {};
  return {
    customer: a.name || null,
    phone: a.phone || null,
    gst: a.gstNo || null,
    businessType: a.businessType || null,
    contactPerson: a.contactPerson || null,
    contactPhone: a.contactPhone || null,
    email: a.email || null,
    address: [a.address, a.city, a.state, a.pin].filter(Boolean).join(', ') || null,
    dob: a.dob || null,
    bank: a.bankDetails || null,
    location: a.lat != null ? `${a.lat}, ${a.lng}` : null,
    homeBranch: (() => {
      const de = require('./dataEntryRequests');
      return de.branchName(de.branchFor(a));
    })(),
    openedBy: a.createdByName || null,
    openedFor: a.openedFor || null,
  };
}

module.exports = { record, between, file, accountFacts };
