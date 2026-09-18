'use strict';
// Cloud API test send.
//   node scripts/test_cloud_send.js 919911999361 "Hello from Cartrends official line!"
// NOTE: free-form text sirf tab deliver hota hai jab us number ne pichhle
// 24 ghante mein 9289015775 ko message kiya ho (customer service window).
// Pehle apne phone se bot number ko "hi" bhejo, phir yeh chalao.
const config = require('../src/config');

const to = (process.argv[2] || '').replace(/\D/g, '');
const text = process.argv[3] || 'Test message from Cartrends AutoFlow (official Cloud API line).';
if (!to) {
  console.error('usage: node scripts/test_cloud_send.js <number> "text"');
  process.exit(1);
}

(async () => {
  const res = await fetch(`https://graph.facebook.com/v23.0/${config.cloud.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.cloud.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  const data = await res.json();
  if (res.ok) {
    console.log('SENT ✅ message id:', data.messages && data.messages[0] && data.messages[0].id);
  } else {
    console.error('FAILED ❌', JSON.stringify(data.error || data, null, 2));
    if (data.error && data.error.code === 131047) {
      console.error('\n(24h window band hai — pehle us phone se 9289015775 ko koi message bhejo, phir dobara try karo)');
    }
  }
})();
