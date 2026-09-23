'use strict';
// DRIVE THE AGENT BY HAND.
//
//   node scripts/try-agent.js
//   node scripts/try-agent.js "cartend wiper blade 16 number ka rate"
//
// Nothing here touches WhatsApp. The tools are the real ones — the real
// portal, the real catalogue, the real knowledge base — so what you see is
// what a customer would have got. The one thing that cannot happen is an
// order being placed, because ORDER_CONFIRM_ENABLED gates that inside
// core/orders and this script does not turn it on.
//
// Every tool call is printed as it happens, so a wrong answer can be traced
// to the tool that produced it rather than guessed at.
require('dotenv').config();
const readline = require('readline');

const config = require('../src/config');
const agent = require('../src/agent');
const customers = require('../src/core/customers');

// A number that is not a real customer, so nothing is filed against anybody.
const PHONE = process.env.TRY_AGENT_PHONE || '919999000001';
const CHAT = PHONE + '@c.us';

// The agent asks a person by sending WhatsApp messages. Here that is printed
// instead, so a test question never reaches a colleague's phone.
const fakeBot = {
  transport: {
    async sendToChat(chatId, body) {
      console.log('\n  [would send to ' + chatId + ']: ' + String(body).replace(/\n/g, '\n      ') + '\n');
      return { id: 'test' };
    },
  },
};

async function main() {
  if (!config.gemini || !config.gemini.apiKey) {
    console.error('GEMINI_API_KEY is not set — the agent cannot run.');
    process.exit(1);
  }
  console.log('Agent : ' + config.agent.name + ' on ' + config.agent.model);
  console.log('As    : ' + PHONE);

  let customer = null;
  try {
    const who = await customers.resolve(PHONE);
    customer = who && who.found ? who : null;
    console.log('Portal: ' + (customer ? customer.name : 'not a registered number (MRP only)'));
  } catch (e) {
    console.log('Portal: could not be reached — ' + String((e && e.message) || e).slice(0, 60));
  }
  console.log('');

  const one = process.argv.slice(2).join(' ').trim();
  if (one) {
    await turn(one, customer);
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you > ' });
  rl.prompt();
  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/quit' || text === '/exit') return rl.close();
    await turn(text, customer);
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

async function turn(text, customer) {
  const started = Date.now();
  let res = { handled: false, reply: null };
  try {
    res = await agent.handle({ bot: fakeBot, chatId: CHAT, phone: PHONE, customer, text });
  } catch (e) {
    console.log('\n  FAILED: ' + String((e && e.message) || e) + '\n');
    return;
  }
  const said = res.reply
    ? res.reply
    : res.handled
      ? '(nothing more to add - a tool has already replied above)'
      : '(the agent could not run; the deterministic bot would take over)';
  console.log('\n' + config.agent.name + ' > ' + said);
  console.log('  (' + (Date.now() - started) + 'ms)\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
