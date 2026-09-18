'use strict';
// Is this webhook really from Meta?
//
// Our webhook URL is public - it has to be, Meta has to reach it. Nothing
// checked who was posting to it, so anyone who learned the URL could have
// posted a message as any customer: a part enquiry, an escalation, or a
// "yes". Meta signs every POST with the app secret; this checks that.
//
// WA_APP_SECRET comes from the Meta app dashboard (App Settings -> Basic ->
// App Secret). Until it is set, `configured()` is false and the caller lets
// traffic through as before - a missing secret must not take the line down.
const crypto = require('crypto');
const config = require('../config');

function configured() {
  return Boolean(config.cloud && config.cloud.appSecret);
}

// `raw` must be the EXACT bytes Meta sent. A re-serialised JSON object will
// not match: key order and spacing change the hash.
function valid(raw, header, secret) {
  const key = secret || (config.cloud && config.cloud.appSecret) || '';
  if (!key) return true; // nothing to check against
  const got = String(header || '');
  if (!got.startsWith('sha256=')) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', key).update(raw).digest('hex');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  // Same length first: timingSafeEqual throws on a mismatch, and the length
  // of a hex digest is not a secret.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { valid, configured };
