'use strict';
// Ek naya number WABA mein add karke Cloud API par register karna.
// ⚠️ WARNING: register hote hi us number ka normal WhatsApp (app) band ho
// jaayega. Pehle phone par WhatsApp > Settings > Account > Delete account
// karna padta hai, warna verify fail hota hai.
//
// Steps (ek-ek karke):
//   node scripts/register_cloud_number.js add 917004130460 "CarTrends Support"
//   node scripts/register_cloud_number.js request-code <phone-id> sms   (ya voice)
//   node scripts/register_cloud_number.js verify-code <phone-id> <otp>
//   node scripts/register_cloud_number.js register <phone-id> <6-digit-pin>
const config = require('../src/config');

const GRAPH = 'https://graph.facebook.com/v23.0';
const [cmd, a, b] = process.argv.slice(2);

async function call(method, path, body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + config.cloud.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  console.log(res.ok ? 'OK' : 'FAILED', JSON.stringify(data, null, 2));
  return data;
}

(async () => {
  if (cmd === 'add') {
    // a = full number with country code, b = display/verified name
    const cc = '91';
    const num = String(a || '').replace(/\D/g, '').replace(/^91/, '');
    await call('POST', `${config.cloud.wabaId}/phone_numbers`, {
      cc,
      phone_number: num,
      migrate_phone_number: true,
      verified_name: b || 'CarTrends',
    });
    console.log('\nab WABA ke phone list mein naya phone-id dekho:');
    await call('GET', `${config.cloud.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status`);
  } else if (cmd === 'request-code') {
    await call('POST', `${a}/request_code`, { code_method: (b || 'SMS').toUpperCase(), language: 'en' });
  } else if (cmd === 'verify-code') {
    await call('POST', `${a}/verify_code`, { code: b });
  } else if (cmd === 'register') {
    await call('POST', `${a}/register`, { messaging_product: 'whatsapp', pin: b || '152563' });
  } else if (cmd === 'list') {
    await call('GET', `${config.cloud.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,platform_type`);
  } else {
    console.log('usage: add <91xxxxxxxxxx> "Name" | request-code <phone-id> sms|voice | verify-code <phone-id> <otp> | register <phone-id> <pin> | list');
  }
})();
