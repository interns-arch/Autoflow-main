'use strict';
// IVR / automated voice call adapter.
//   mock   -> logs the call (default until a voice provider is chosen)
//   twilio -> places a real call with text-to-speech via the Twilio REST API
const config = require('../config');
const store = require('../store');

async function twilioCall(toNumber, sayText) {
  const { sid, token, from } = config.ivr.twilio;
  if (!sid || !token || !from) throw new Error('Twilio credentials missing in .env');
  const twiml = `<Response><Say language="en-IN">${sayText.replace(/[<>&]/g, ' ')}</Say></Response>`;
  const body = new URLSearchParams({ To: '+' + store.normPhone(toNumber), From: from, Twiml: twiml });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error('Twilio call failed: HTTP ' + res.status);
  return res.json();
}

module.exports = {
  // Place an automated voice call. Never throws — a failed call is logged
  // and the WhatsApp flow continues.
  async call(toNumber, sayText, reason) {
    try {
      if (config.ivr.provider === 'twilio') {
        await twilioCall(toNumber, sayText);
        store.log('ivr', `CALL placed to ${toNumber} (${reason})`);
      } else {
        store.log('ivr', `MOCK CALL to ${toNumber} (${reason}): "${sayText}"`);
      }
      return true;
    } catch (e) {
      store.log('ivr', `call to ${toNumber} FAILED (${reason}): ${e.message}`);
      return false;
    }
  },
};
