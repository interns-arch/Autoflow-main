'use strict';
// Per-customer WhatsApp group registry.
//
// One bot number, many groups. A group is created through the Cloud API
// Groups edge, its id is stored against the customer, and every inbound
// message is routed back to the right customer by that id:
//
//   webhook -> group id -> lookup here -> customer context -> reply to
//   the SAME group
//
// Verified create contract (probed against the live API):
//   POST /{phone_number_id}/groups
//   { messaging_product: "whatsapp",            <- required
//     subject: "Customer - Rahul",              <- required
//     participants: [{ user: "919..." }],       <- optional, direct add works
//     join_approval_mode: "auto_approve" | "approval_required" }
const store = require('../store');

function bucket() {
  const s = store.load();
  if (!s.groups) s.groups = [];
  return s.groups;
}

function normId(id) {
  return String(id || '').trim();
}

function all() {
  return bucket();
}

function findByGroupId(groupId) {
  const g = normId(groupId);
  if (!g) return null;
  // match on the raw id and on the bare digits, since different parts of the
  // payload may carry "1203...@g.us" or just "1203..."
  const bare = g.split('@')[0];
  return bucket().find((row) => row.groupId === g || String(row.groupId).split('@')[0] === bare) || null;
}

function findByCustomer(phone) {
  const p = store.normPhone(phone);
  return bucket().find((row) => row.customer === p) || null;
}

function record({ groupId, subject, customer, participants }) {
  const row = {
    groupId: normId(groupId),
    subject: subject || '',
    customer: store.normPhone(customer) || null,
    participants: (participants || []).map((p) => store.normPhone(p)).filter(Boolean),
    createdAt: new Date().toISOString(),
  };
  const existing = findByGroupId(row.groupId);
  if (existing) {
    Object.assign(existing, row, { createdAt: existing.createdAt });
    store.save();
    return existing;
  }
  bucket().push(row);
  if (row.customer) store.upsertCustomer(row.customer);
  store.save();
  store.log('groups', `group registered: ${row.groupId} "${row.subject}" (${row.participants.length} participant(s))`);
  return row;
}

// Create a real WhatsApp group through the bot's Cloud API transport and
// remember it. `transport` must be the CLOUD transport.
async function create(transport, { subject, customer, participants, autoApprove = true }) {
  if (!transport || transport.mode !== 'CLOUD') {
    throw new Error('groups need the Cloud API transport (CUSTOMER_TRANSPORT=cloud)');
  }
  const config = require('../config');
  // customer + every standing member (dealer / care / monitor) from .env
  const people = [
    ...new Set(
      [...(participants || []), ...config.groupDefaultMembers].map((p) => store.normPhone(p)).filter(Boolean)
    ),
  ];
  const result = await transport.createGroup({
    subject,
    participants: people,
    joinApprovalMode: autoApprove ? 'auto_approve' : 'approval_required',
  });
  return record({
    groupId: result.groupId,
    subject,
    customer: customer || people[0] || null,
    participants: people,
    inviteLink: result.inviteLink,
  });
}

module.exports = { all, create, record, findByGroupId, findByCustomer };
