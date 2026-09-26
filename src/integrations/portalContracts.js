'use strict';
// WHAT EVERY DEALER PORTAL CALL TAKES AND GIVES BACK — and, above all, WHICH
// KIND OF ID each id field is.
//
// 26 Sep, live: a discount rule for Houseneed Doorstep Services showed up in
// Super Admin under "Dhakad Car Decor Ct". The bot had found Houseneed with
// GET /accounts/search, whose rows carry `id` = the ACCOUNT id (227), and put
// that number into the rule's `dealer_id` — a DEALER id. Dealer 227 is Dhakad;
// Houseneed's dealer id is 3340. MIYA JI's rule went to dealer 8328 (TVS
// Automobile) the same way. Nothing checked, because nothing said what the
// numbers were.
//
// The portal has THREE separate numbering schemes for one customer, and the
// same integer means a different firm in each:
//   ACCOUNT  - the customer's ledger account (/accounts/*, orders' buyer,
//              pricing, credit). Houseneed = 227.
//   DEALER   - the dealer master (/dealers/*, discount rules, branches,
//              allocations). Houseneed = 3340. Branches are dealers too:
//              Bijwasan 23, Mansarovar 1078.
//   USER     - a portal login (/users/*, actor_user_id).
// The ONLY link between an ACCOUNT and its DEALER is the Odoo partner both
// carry (`odoo_partner_id`: Houseneed 1696 on both). See
// dealerPortal.dealerIdForAccount.
//
// Every field below was read from the live spec (GET /openapi.json) or, where
// the spec has no schema, from a live response; scripts/check-portal-contracts
// checks the spec still says so. A number is only ever passed where the
// contract says its KIND is expected.
const ID = Object.freeze({
  ACCOUNT: 'ACCOUNT',
  DEALER: 'DEALER',
  USER: 'USER',
  ORDER: 'ORDER', // a portal sales order
  RULE: 'RULE', // a discount rule
  ODOO_PARTNER: 'ODOO_PARTNER',
});

// method, path (as in the spec), what goes in, what comes out.
//   query / body: field -> description (an ID kind in capitals where it is one)
//   response:     field -> description
//   ids:          every id field, request or response -> its KIND
const CONTRACTS = {
  searchAccountsByName: {
    method: 'GET',
    path: '/api/v1/accounts/search',
    query: { customer_name: 'text to match against the account name' },
    response: 'array of AccountResponse',
    responseSchema: 'AccountResponse',
    fields: ['id', 'name', 'phone', 'mobile', 'gst_no', 'state_name', 'address', 'balance', 'credit_limit', 'credit_days', 'odoo_partner_id', 'group_name', 'billing_blocked'],
    ids: { id: ID.ACCOUNT, odoo_partner_id: ID.ODOO_PARTNER },
    note: '`id` here is the ACCOUNT id — never a dealer id. There is no dealer id in this response.',
  },
  searchAccountsByMobile: {
    method: 'GET',
    path: '/api/v1/accounts/search',
    query: { customer_mobile: '10-digit mobile; reads the `mobile` column only (accounts the bot opened carry it in `phone`)' },
    response: 'array of AccountResponse',
    responseSchema: 'AccountResponse',
    ids: { id: ID.ACCOUNT, odoo_partner_id: ID.ODOO_PARTNER },
  },
  getAccount: {
    method: 'GET',
    path: '/api/v1/accounts/{account_id}',
    params: { account_id: ID.ACCOUNT },
    responseSchema: 'AccountResponse',
    fields: ['id', 'name', 'odoo_partner_id'],
    ids: { account_id: ID.ACCOUNT, id: ID.ACCOUNT, odoo_partner_id: ID.ODOO_PARTNER },
  },
  creditControl: {
    method: 'GET',
    path: '/api/v1/accounts/{account_id}/credit-control',
    params: { account_id: ID.ACCOUNT },
    ids: { account_id: ID.ACCOUNT },
  },
  customerByMobile: {
    method: 'GET',
    path: '/api/v1/users/customer/mobile',
    query: { mobileno: '10-digit mobile' },
    response: 'no schema in the spec; live fields: selected_buyer_id, home_branch_dealer_id, name, gst_no, odoo_sync_status, can_call_analyze, can_call_confirm',
    ids: { selected_buyer_id: ID.ACCOUNT, dealer_portal_customer_id: ID.ACCOUNT, home_branch_dealer_id: ID.DEALER },
    note: 'selected_buyer_id is an ACCOUNT id (Anuj: account 8191; dealer 8191 is Guru Kirpa Automobiles). The bot calls it buyerId.',
  },
  getDealer: {
    method: 'GET',
    path: '/api/v1/dealers/{dealer_id}',
    params: { dealer_id: ID.DEALER },
    fields: ['dealer_id', 'dealer_name', 'odoo_partner_id', 'is_active'],
    ids: { dealer_id: ID.DEALER, odoo_partner_id: ID.ODOO_PARTNER },
  },
  listDealers: {
    method: 'GET',
    path: '/api/v1/dealers/',
    response: 'array of dealers (about 8,500): dealer_id, dealer_name, odoo_partner_id, dealer_contact, is_active',
    ids: { dealer_id: ID.DEALER, odoo_partner_id: ID.ODOO_PARTNER },
    note: 'How an ACCOUNT is turned into its DEALER: the dealer with the same odoo_partner_id.',
  },
  listDiscountRules: {
    method: 'GET',
    path: '/api/v1/discount-rules/',
    responseSchema: 'DiscountRuleResponse',
    fields: ['rule_id', 'dealer_id', 'rule_type', 'brand', 'part_no', 'discount_mode', 'discount_value', 'approval_status', 'is_active', 'valid_from', 'valid_to', 'rule_metadata'],
    ids: { rule_id: ID.RULE, dealer_id: ID.DEALER },
    note: 'dealer_id is a DEALER id. A rule is matched to a customer through dealerIdForAccount, never by comparing it with an account id.',
  },
  createDiscountRule: {
    method: 'POST',
    path: '/api/v1/discount-rules/',
    requestSchema: 'DiscountRuleCreate',
    body: ['rule_type', 'brand', 'part_no', 'dealer_id', 'discount_mode', 'discount_value', 'min_qty', 'max_qty', 'min_amount', 'max_amount', 'is_active', 'approval_status', 'valid_from', 'valid_to', 'priority', 'rule_name', 'rule_metadata'],
    ids: { dealer_id: ID.DEALER },
    note: 'dealer_id MUST come from dealerIdForAccount. createDiscountRule re-reads the dealer and refuses when its odoo_partner_id is not the one in rule_metadata.',
  },
  updateDiscountRule: {
    method: 'PUT',
    path: '/api/v1/discount-rules/{rule_id}',
    params: { rule_id: ID.RULE },
    requestSchema: 'DiscountRuleUpdate',
    ids: { rule_id: ID.RULE, dealer_id: ID.DEALER },
  },
  reviewDiscountRule: {
    method: 'POST',
    path: '/api/v1/discount-rules/{rule_id}/review',
    params: { rule_id: ID.RULE },
    query: { action: 'approve / reject (spelling not enumerated in the spec)' },
    ids: { rule_id: ID.RULE },
  },
  commercialAnalyze: {
    method: 'POST',
    path: '/api/v1/PUSH_ORDER/commercial-analyze',
    requestSchema: 'CommercialOrderAnalysisRequest',
    body: ['account_id', 'items', 'source_branch_dealer_id'],
    ids: { account_id: ID.ACCOUNT, source_branch_dealer_id: ID.DEALER },
  },
  confirmOrder: {
    method: 'POST',
    path: '/api/v1/purchase-orders/confirm',
    requestSchema: 'app__schemas__purchase_order_schema__OrderCreate',
    body: ['user_id', 'selected_buyer_id', 'source_branch_dealer_id', 'external_order_reference', 'include_unallocated', 'allow_empty_dealers', 'client_source', 'actor_user_id', 'lines', 'remarks'],
    responseSchema: 'OrderConfirmResponse',
    fields: ['primary_order', 'unallocated_order', 'odoo_sync_status'],
    ids: { user_id: ID.USER, selected_buyer_id: ID.ACCOUNT, source_branch_dealer_id: ID.DEALER, actor_user_id: ID.USER, 'lines[].dealers[].dealer_id': ID.DEALER },
  },
  etaMapping: {
    method: 'GET',
    path: '/api/v1/eta-mapping',
    query: { partNo: 'part number', limit: 'rows' },
    fields: ['partNo', 'eta', 'mappedEta', 'status', 'Date'],
    ids: {},
  },
  orderForUser: {
    method: 'GET',
    path: '/api/v1/PUSH_ORDER/order-for-user',
    query: { mobile: "a salesman's mobile" },
    ids: { order_for_user_id: ID.USER },
  },
};

// The KIND a field holds in a call, or null when it is not an id.
function idKind(contract, field) {
  const c = CONTRACTS[contract];
  return (c && c.ids && c.ids[field]) || null;
}

module.exports = { ID, CONTRACTS, idKind };
