'use strict';
// Customer identity: WhatsApp number -> Dealer Portal customer.
//
// This is the missing link between "someone messaged us" and "punch an order
// against the right buyer". The portal resolves it directly:
//
//   GET /api/v1/users/customer/mobile?mobileno=9217030422
//   -> { dealer_portal_customer_id, selected_buyer_id,
//        home_branch_dealer_id, name, gst_no, odoo_sync_status,
//        can_call_analyze, can_call_confirm }
//   -> 404 { detail: "Customer not found for the provided mobile number." }
//
// The two `can_call_*` flags are the portal telling us, up front, whether this
// customer may be used for an order at all — so the bot never starts a flow it
// cannot finish.
//
// Resolution is cached per number (portal records rarely change mid-chat) and
// mirrored into the local customer row for reporting.
const store = require('../store');

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // phone -> { at, value }

function cached(phone) {
  const hit = cache.get(phone);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  return undefined;
}

// Returns:
//   { found: true, buyerId, branchId, name, gstNo, canAnalyze, canConfirm, raw }
//   { found: false }                      -> not on the portal yet
//   { found: null }                       -> lookup failed (portal down); the
//                                            caller must not assume either way
async function resolve(phone) {
  const p = store.normPhone(phone);
  if (!p) return { found: false };

  const hit = cached(p);
  if (hit !== undefined) return hit;

  const portal = require('../integrations/dealerPortal');
  const result = await portal.lookupCustomer(p);
  cache.set(p, { at: Date.now(), value: result });

  if (result.found) {
    // keep the local row in step so reports show real names, not raw numbers
    store.upsertCustomer(p, result.name || '');
    store.log('customers', `${p} -> ${result.name} (buyer ${result.buyerId}, branch ${result.branchId})`);
  } else if (result.found === false) {
    store.log('customers', `${p} is not on the Dealer Portal yet`);
  }
  return result;
}

function forget(phone) {
  cache.delete(store.normPhone(phone));
}

module.exports = { resolve, forget };
