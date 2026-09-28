'use strict';
// WhatsApp transport abstraction.
//   LIVE mode (bot number set in .env)  -> whatsapp-web.js client, QR link
//   SIM  mode (number empty)            -> in-memory simulator driven from the web console
//
// SHARED LINES: several bot roles may carry the SAME number in .env (e.g.
// purchase + warehouse + finance + helpdesk all on one SIM). They then share
// one WhatsApp session. Inbound messages are offered to each role's handler
// in registration order (= boot order: purchase, customer, warehouse,
// finance, helpdesk); the first handler that returns true CLAIMS the message
// and later roles never see it — so the helpdesk catch-all only fires when
// no operational role wanted the message.
//
// Both transports expose the same surface:
//   start(), sendText(number, text), sendToChat(chatId, text),
//   onMessage(handler({ from, chatId, chatName, isGroup, body, hasMedia, mediaType })),
//   status() -> { mode, state, qrDataUrl, roles }
const store = require('../store');
// Stand-in for the Cloud API's message ids, so tests can exercise the
// swipe-to-reply path the escalation helper actually uses.
let simMsgSeq = 0;

// first-claim dispatch shared by both transports
async function dispatch(handlers, m) {
  for (const fn of handlers) {
    if ((await fn(m)) === true) return;
  }
}

class SimTransport {
  constructor(botKey, label) {
    this.botKey = botKey;
    this.label = label;
    this.mode = 'SIMULATION';
    this.state = 'ready';
    this.handlers = [];
    this.outbox = []; // messages the bot "sent" — shown in the console simulator
  }
  async start() {
    if (this._started) return;
    this._started = true;
    store.log(this.botKey, `${this.label} started in SIMULATION mode (no number in .env yet)`);
  }
  onMessage(fn) {
    this.handlers.push(fn);
  }
  onDeliveryFailed(fn) {
    (this.failHandlers = this.failHandlers || []).push(fn);
  }
  // Tests: WhatsApp reporting a message as not delivered.
  async injectFailure(info) {
    for (const fn of this.failHandlers || []) await fn(info);
  }
  // called by the console simulator to inject an inbound message
  async injectIncoming(msg) {
    await dispatch(this.handlers, msg);
  }
  // Returns a message id like the Cloud API does, so the swipe-to-reply path
  // used by the escalation helper can be exercised in tests too.
  async sendText(number, text) {
    const id = 'sim-wamid-' + (++simMsgSeq);
    this.outbox.push({ ts: new Date().toISOString(), to: store.normPhone(number), text, id });
    if (this.outbox.length > 200) this.outbox.splice(0, this.outbox.length - 200);
    store.log(this.botKey, `SIM send -> ${number}: ${text.slice(0, 120).replace(/\n/g, ' | ')}`);
    return id;
  }
  async sendImage(chatId, buffer, mime, caption) {
    const id = 'sim-wamid-' + (++simMsgSeq);
    this.outbox.push({ ts: new Date().toISOString(), to: store.normPhone(chatId), text: caption || '', photo: true, id });
    store.log(this.botKey, `SIM send -> ${chatId}: [photo ${(buffer && buffer.length) || 0}b] ${String(caption || '').slice(0, 90).replace(/\n/g, ' | ')}`);
    return id;
  }
  async sendAudio(chatId, buffer, mime) {
    const id = 'sim-wamid-' + (++simMsgSeq);
    this.outbox.push({ ts: new Date().toISOString(), to: store.normPhone(chatId), text: '', audio: true, id });
    store.log(this.botKey, `SIM send -> ${chatId}: [voice ${(buffer && buffer.length) || 0}b]`);
    return id;
  }
  async sendTyping(messageId) {
    this.typed = (this.typed || 0) + 1;
    this.lastTypedFor = messageId || null;
    return true;
  }
  async sendToChat(chatId, text) {
    // Returns an id like the Cloud API does. A numbered list has to be findable
    // again when the customer swipe-replies to it with "Leave 9no. Item".
    const id = 'sim-wamid-' + ++simMsgSeq;
    this.outbox.push({ ts: new Date().toISOString(), to: chatId, text, id });
    if (this.outbox.length > 200) this.outbox.splice(0, this.outbox.length - 200);
    store.log(this.botKey, `SIM send -> chat ${chatId}: ${text.slice(0, 120).replace(/\n/g, ' | ')}`);
    return id;
  }
  status() {
    return { mode: this.mode, state: this.state, qrDataUrl: null };
  }
}

class LiveTransport {
  constructor(botKey, label, number) {
    this.botKey = botKey;
    this.label = label;
    this.number = number;
    this.mode = 'LIVE';
    this.state = 'starting';
    this.qrDataUrl = null;
    this.handlers = [];
    this.client = null;
    this.roles = [botKey]; // every bot role riding on this line
  }
  async start() {
    if (this._started) return; // shared line: first role initializes, others attach
    this._started = true;
    await this._createAndInit();
  }

  // stale/half-linked sessions sometimes hang at "starting" forever (no QR,
  // no ready). Watchdog: 90s tak kuch nahi hua to session folder wipe karke
  // ek baar fresh retry — fresh QR khud aa jaata hai.
  async _createAndInit(isRetry) {
    // lazy require: heavy dep only loaded when a bot actually goes live
    const { Client, LocalAuth } = require('whatsapp-web.js');
    const QRCode = require('qrcode');
    const path = require('path');
    const fs = require('fs');
    const config = require('../config');
    const sessionDir = path.join(config.dataDir, 'wa-sessions', 'session-' + this.botKey);

    const watchdog = setTimeout(async () => {
      if (this.state !== 'starting' || this.qrDataUrl || isRetry) return;
      store.log(this.botKey, `${this.label}: stuck at starting for 90s — wiping stale session and retrying with a fresh QR`);
      try { await this.client.destroy(); } catch {}
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      this._createAndInit(true).catch((e) => {
        this.state = 'failed: ' + e.message;
        store.log(this.botKey, `${this.label} retry failed: ${e.message}`);
      });
    }, 90 * 1000);

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.botKey,
        dataPath: path.join(config.dataDir, 'wa-sessions'),
      }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    });

    this.client.on('qr', async (qr) => {
      clearTimeout(watchdog);
      this.state = 'waiting_for_qr_scan';
      this.qrDataUrl = await QRCode.toDataURL(qr);
      // no UI needed: the QR is printed straight into the terminal too
      try {
        const term = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log(`\n=== Scan with the ${this.label} phone (${this.number}) — WhatsApp > Linked devices ===\n${term}`);
      } catch {}
      store.log(this.botKey, `${this.label}: QR ready — scan from the terminal (or console page) with the ${this.number} phone`);
    });
    this.client.on('ready', async () => {
      clearTimeout(watchdog);
      this.state = 'connected';
      this.qrDataUrl = null;
      // verify: kaunsa WhatsApp account ASL mein link hua (config se alag ho sakta hai!)
      const actual = (this.client.info && this.client.info.wid && this.client.info.wid._serialized) || 'unknown';
      store.log(this.botKey, `${this.label} CONNECTED — config number: ${this.number}, actual linked account: ${actual}`);
      if (actual !== 'unknown' && store.normPhone(actual.split('@')[0]) !== this.number) {
        store.log(this.botKey, `⚠️ WARNING: QR GALAT phone se scan hua hai! .env mein ${this.number} likha hai par link hua ${actual}`);
      }
      await this._ensureInjected(); // utils missing ho to abhi heal kar lo
      await this._primeOwnChats(); // send-crash fix: apne PN+LID chat models load karo
    });
    this.client.on('disconnected', (r) => {
      this.state = 'disconnected: ' + r;
      store.log(this.botKey, `${this.label} disconnected: ${r}`);
    });
    this.client.on('message', async (msg) => {
      try {
        // system/protocol noise — na process karo, na log karo
        if (['e2e_notification', 'notification_template', 'protocol', 'call_log', 'gp2', 'revoked', 'ciphertext'].includes(msg.type)) return;
        // TEMP DEBUG: raw ids — lid bug ka exact source pakadne ke liye
        try {
          const rm = msg.id && msg.id.remote;
          store.log(this.botKey, `dbg from=${msg.from} to=${msg.to} author=${msg.author || '-'} remote=${typeof rm === 'string' ? rm : (rm && rm._serialized)} fromMe=${msg.id && msg.id.fromMe} type=${msg.type}`);
        } catch {}
        // getChat() can fail on exotic message types (status, newsletters);
        // fall back to building chat info from the raw ids so one bad
        // message never kills handling of normal ones
        let chat = null;
        try {
          chat = await msg.getChat();
        } catch {}
        // wweb.js LID bug: DM par msg.from kabhi BOT KA APNA lid hota hai —
        // asli chat/sender msg.id.remote mein reliable milta hai
        const remote = msg.id
          ? (typeof msg.id.remote === 'string' ? msg.id.remote : (msg.id.remote && msg.id.remote._serialized)) || ''
          : '';
        let rawChatId = (chat && chat.id && chat.id._serialized) || remote || msg.from || '';
        if (/@(broadcast|newsletter)/.test(rawChatId)) return; // status/channel noise
        const isGroupChat = chat ? chat.isGroup : rawChatId.endsWith('@g.us');
        // DM mein sender = chat partner (rawChatId); group mein author
        let senderId = isGroupChat ? (msg.author || '') : rawChatId;
        let fromNumber = store.normPhone(String(senderId).split('@')[0]);
        // LID -> real number (whitelist real number ya lid dono se match hoti hai)
        if (/@lid$/.test(senderId)) {
          const real = await this._lidToPhone(senderId, msg);
          if (real) fromNumber = store.normPhone(real.split('@')[0]);
        }
        // agar ab bhi apna hi number/lid nikla (bug ka doosra roop) — msg.to
        // mein asli partner hota hai
        if (!isGroupChat && fromNumber === this.number) {
          const toId = typeof msg.to === 'string' ? msg.to : (msg.to && msg.to._serialized) || '';
          if (toId && store.normPhone(toId.split('@')[0]) !== this.number) {
            rawChatId = toId;
            senderId = toId;
            fromNumber = store.normPhone(toId.split('@')[0]);
            if (/@lid$/.test(toId)) {
              const real2 = await this._lidToPhone(toId, null);
              if (real2) fromNumber = store.normPhone(real2.split('@')[0]);
            }
          }
        }
        const m = {
          from: fromNumber,
          chatId: rawChatId,
          chatName: (chat && (chat.name || chat.formattedTitle)) || '',
          isGroup: isGroupChat,
          body: msg.body || '',
          hasMedia: msg.hasMedia,
          mediaType: msg.type,
          _raw: msg,
        };
        // pull image attachments down so bots can read photo orders
        if (msg.hasMedia && ['image', 'document'].includes(msg.type)) {
          try {
            const media = await msg.downloadMedia();
            if (media && /^image\//.test(media.mimetype || '')) {
              m.mediaBase64 = media.data;
              m.mediaMime = media.mimetype;
            }
          } catch (e) {
            store.log(this.botKey, 'media download failed: ' + String((e && e.message) || e).slice(0, 120));
          }
        }
        // group ka ID bhi log karo — registry mein ID hi rakhi jaati hai
        // (1203... wala number) likhna zyada reliable hai
        const where = m.isGroup ? `group "${m.chatName}" [${m.chatId.split('@')[0]}]` : m.from;
        store.log(this.botKey, `recv <- ${where}: ${(m.body || '(' + m.mediaType + ')').slice(0, 100).replace(/\n/g, ' | ')}`);
        await dispatch(this.handlers, m);
      } catch (e) {
        store.log(this.botKey, 'message handler error: ' + String((e && (e.stack || e.message)) || e).slice(0, 400));
      }
    });

    await this.client.initialize();
  }
  onMessage(fn) {
    this.handlers.push(fn);
  }

  // "1234...@lid" -> "91xxxxxxxxxx@c.us" — contact/Store se; SAME digits
  // wapas aaye to woh resolution nahi hai (reject); result cached
  async _lidToPhone(lidSerialized, msg) {
    if (!this._lidMap) this._lidMap = new Map();
    if (this._lidMap.has(lidSerialized)) return this._lidMap.get(lidSerialized);
    const lidDigits = store.normPhone(lidSerialized.split('@')[0]);
    const genuine = (v) => v && store.normPhone(String(v).split('@')[0]) !== lidDigits;

    let real = null;
    // best path: library ka apna resolver (server-query samet)
    try {
      await this._ensureInjected();
      const r = await this.client.pupPage.evaluate(async (lidStr) => {
        try {
          const res = await window.WWebJS.enforceLidAndPnRetrieval(lidStr);
          if (res && res.phone) {
            return res.phone._serialized || (res.phone.user ? res.phone.user + '@c.us' : null);
          }
        } catch (e) {}
        return null;
      }, lidSerialized);
      if (genuine(r)) real = r;
    } catch {}
    try {
      if (!real && msg) {
        const contact = await msg.getContact();
        if (contact && genuine(contact.number)) real = store.normPhone(contact.number) + '@c.us';
      }
    } catch {}
    if (!real) {
      try {
        const r = await this.client.pupPage.evaluate((lidStr) => {
          try {
            const wid = window.Store.WidFactory.createWid(lidStr);
            const lu = window.Store.LidUtils || {};
            for (const fn of ['getPhoneNumber', 'getPnForLid', 'getPn', 'getPhoneNumberFromLid']) {
              if (typeof lu[fn] === 'function') {
                const res = lu[fn](wid);
                if (res && res.user && res.user !== wid.user) return res._serialized || res.user + '@c.us';
              }
            }
            const c = window.Store.Contact.get(wid);
            if (c && c.phoneNumber && c.phoneNumber.user && c.phoneNumber.user !== wid.user) {
              return c.phoneNumber._serialized || c.phoneNumber.user + '@c.us';
            }
          } catch (e) {}
          return null;
        }, lidSerialized);
        if (genuine(r)) real = r;
      } catch {}
    }
    // apna hi number nikla to yeh self-chat hai — resolution useless
    if (real && store.normPhone(real.split('@')[0]) === this.number) {
      store.log(this.botKey, `lid ${lidSerialized} = bot ka APNA number (self-chat) — is par reply possible nahi`);
      this._lidMap.set(lidSerialized, null);
      return null;
    }
    if (real) {
      this._lidMap.set(lidSerialized, real);
      store.log(this.botKey, `lid resolved: ${lidSerialized} -> ${real}`);
    }
    return real;
  }

  // 1.34.x bug: sendMessage crash karta hai jab koi zaroori chat model
  // Store collection mein loaded nahi hota — find() se load/create karo
  async _primeChat(chatId) {
    try {
      return await this.client.pupPage.evaluate(async (id) => {
        const wid = window.Store.WidFactory.createWid(id);
        if (!window.Store.Chat.get(wid) && window.Store.Chat.find) {
          await window.Store.Chat.find(wid);
        }
        return Boolean(window.Store.Chat.get(wid));
      }, chatId);
    } catch (e) {
      store.log(this.botKey, `prime ${chatId} failed: ` + String((e && e.message) || e).slice(0, 120));
      return false;
    }
  }

  // WA internals ko message compose karte waqt BOT KE APNE chat model
  // chahiye hote hain (PN + LID) — warna "findChat: new chat not found
  // <apna-number>@c.us" har send par aata hai. Ready par ek baar prime karo.
  async _primeOwnChats() {
    const pnOk = await this._primeChat(this.number + '@c.us');
    let lidOk = false;
    try {
      lidOk = await this.client.pupPage.evaluate(async () => {
        try {
          const { getMaybeMeLidUser } = window.require('WAWebUserPrefsMeUser');
          const meLid = getMaybeMeLidUser && getMaybeMeLidUser();
          if (!meLid) return false;
          if (!window.Store.Chat.get(meLid) && window.Store.Chat.find) {
            await window.Store.Chat.find(meLid);
          }
          return Boolean(window.Store.Chat.get(meLid));
        } catch (e) {
          return false;
        }
      });
    } catch {}
    store.log(this.botKey, `own-chat prime: pn=${pnOk} lid=${lidOk}`);
  }

  // whatsapp-web.js ke injected utils (window.WWebJS) kabhi-kabhi load nahi
  // hote / ud jaate hain -> har send "reading 'getChat'" par crash karta hai.
  // Self-heal: send se pehle check, missing ho to khud LoadUtils chala do.
  async _ensureInjected() {
    try {
      const ok = await this.client.pupPage.evaluate(
        () => typeof window.WWebJS !== 'undefined' && typeof window.WWebJS.getChat === 'function'
      );
      if (ok) return true;
      const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
      await this.client.pupPage.evaluate(LoadUtils);
      const ok2 = await this.client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined');
      store.log(this.botKey, ok2 ? 'WWebJS utils re-injected (self-heal)' : 'WWebJS RE-INJECTION FAILED');
      return ok2;
    } catch (e) {
      store.log(this.botKey, 'utils inject error: ' + String((e && e.message) || e).slice(0, 250));
      return false;
    }
  }

  async sendText(number, text) {
    const id = store.normPhone(number) + '@c.us';
    await this._ensureInjected();
    await this.client.sendMessage(id, text);
    store.log(this.botKey, `send -> ${number}: ${text.slice(0, 120).replace(/\n/g, ' | ')}`);
  }
  async sendToChat(chatId, text) {
    await this._ensureInjected();
    let target = chatId;
    if (/@lid$/.test(chatId)) {
      // real number mil jaaye to usi chat par bhejo; warna lid chat ko
      // Store mein prime karke seedha bhejo (dono is bug ke fixes hain)
      const real = await this._lidToPhone(chatId);
      if (real) target = real;
      else await this._primeChat(chatId);
    }
    try {
      await this.client.sendMessage(target, text);
    } catch (e) {
      if (target === chatId) throw new Error(`send to ${target} failed: ${e.message}`);
      store.log(this.botKey, `send to ${target} failed (${String(e.message).slice(0, 80)}) — retrying on ${chatId}`);
      await this._primeChat(chatId);
      await this.client.sendMessage(chatId, text); // retry on the original lid chat
      target = chatId;
    }
    store.log(this.botKey, `send -> chat ${target}: ${text.slice(0, 100).replace(/\n/g, ' | ')}`);
  }
  status() {
    return { mode: this.mode, state: this.state, qrDataUrl: this.qrDataUrl, roles: this.roles };
  }
}

// Everything a bot hears or says passes through here, so the console inbox
// (core/chatLog) is recorded in ONE place instead of in every send method of
// three transports. The wrapper is cached per transport: bots that share a
// live line must keep sharing ONE object, or the webhook would be handled
// twice.
const watchedPool = new WeakMap();
const OUT_KINDS = {
  sendText: 'text',
  sendToChat: 'text',
  sendToGroup: 'text',
  sendImage: 'photo',
  sendAudio: 'voice',
  sendDocument: 'file',
};

function watched(transport, botKey) {
  if (watchedPool.has(transport)) return watchedPool.get(transport);
  const chatLog = require('../core/chatLog');
  // The bot, the admin commands and the escalation helper all listen on
  // the same transport, so one incoming message reaches three handlers.
  // It is ONE message: without this the inbox showed it three times and
  // kept three copies of the same photo.
  const logged = new WeakSet();
  const proxy = new Proxy(transport, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== 'function') return v;
      if (prop === 'onMessage') {
        return (fn) =>
          v.call(t, async (m) => {
            if (m && typeof m === 'object' && !logged.has(m)) {
              logged.add(m);
              chatLog.incoming(botKey, m);
            }
            return fn(m);
          });
      }
      if (OUT_KINDS[prop]) {
        return async (...args) => {
          const sent = await v.apply(t, args);
          const text =
            prop === 'sendDocument'
              ? '[file] ' + (args[2] || '') + (args[4] ? ' - ' + args[4] : '')
              : prop === 'sendImage'
                ? '[photo] ' + (args[3] || '')
                : prop === 'sendAudio'
                  ? '[voice note]'
                  : args[1];
          const media =
            prop === 'sendDocument'
              ? { buffer: args[1], mime: args[3] }
              : prop === 'sendImage' || prop === 'sendAudio'
                ? { buffer: args[1], mime: args[2] }
                : null;
          chatLog.outgoing(botKey, args[0], text, OUT_KINDS[prop], sent, media);
          return sent;
        };
      }
      return v.bind(t);
    },
  });
  watchedPool.set(transport, proxy);
  return proxy;
}

// one live session per unique number — bots with the same number share it
const livePool = new Map();

function createTransport(botKey) {
  const config = require('../config');
  const bot = config.bots[botKey];
  // customer line official Cloud API par (CUSTOMER_TRANSPORT=cloud + creds)
  if (
    botKey === 'customer' &&
    config.customerTransport === 'cloud' &&
    config.cloud.token &&
    config.cloud.phoneNumberId
  ) {
    const { CloudTransport } = require('./cloudTransport');
    return watched(new CloudTransport(botKey, bot.label), botKey);
  }
  if (config.isLive(botKey)) {
    let t = livePool.get(bot.number);
    if (t) {
      t.roles.push(botKey);
      store.log(botKey, `${bot.label} rides on the shared line ${bot.number} (with ${t.roles.filter((r) => r !== botKey).join(', ')})`);
      return watched(t, botKey);
    }
    t = new LiveTransport(botKey, bot.label, bot.number);
    livePool.set(bot.number, t);
    return watched(t, botKey);
  }
  return watched(new SimTransport(botKey, bot.label), botKey);
}

module.exports = { createTransport, SimTransport, LiveTransport };
