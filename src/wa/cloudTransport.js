'use strict';
// Official WhatsApp Cloud API transport (Meta Graph API).
// Same surface as the linked-device transports:
//   start(), sendText(number, text), sendToChat(chatId, text),
//   onMessage(handler), status()
// Receiving needs the webhook route (console/server.js mounts
// GET+POST /webhook/wa) reachable on a PUBLIC https URL — Meta se
// configure hota hai. Sending works standalone (24h service window
// ya approved template ke andar).
const config = require('../config');
const store = require('../store');
const seen = require('../core/seen');

const GRAPH = 'https://graph.facebook.com/v23.0';

class CloudTransport {
  constructor(botKey, label) {
    this.botKey = botKey;
    this.label = label;
    this.number = config.bots[botKey].number;
    this.mode = 'CLOUD';
    this.state = 'send-ready (webhook pending)';
    this.handlers = [];
    this.roles = [botKey];
    this.qrDataUrl = null; 
  }

  async start() {
    if (this._started) return;
    this._started = true;
    store.log(this.botKey, `${this.label} on OFFICIAL Cloud API (${this.number}) — sending live; receiving needs webhook`);
  }

  onMessage(fn) {
    this.handlers.push(fn);
  }

  async _post(path, body) {
    const res = await fetch(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.cloud.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data.error && (data.error.message + (data.error.error_data ? ' | ' + JSON.stringify(data.error.error_data) : ''))) || 'HTTP ' + res.status;
      throw new Error('CloudAPI: ' + err);
    }
    return data;
  }

  // Returns the WhatsApp message id. The escalation flow needs it: the helper
  // answers by REPLYING to our question rather than typing "E7 <part>", and the
  // only thing tying that reply to the question is this id.
  async sendText(number, text) {
    const to = store.normPhone(number);
    // WhatsApp refuses a text over 4096 characters; a 30-part analysis is
    // more. It goes as several messages, cut between lines. The id returned is
    // the last one's, the message a reply would swipe onto.
    let id = null;
    for (const piece of pieces(text)) {
      const data = await this._post(`${config.cloud.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: piece, preview_url: false },
      });
      store.log(this.botKey, `send -> ${to} [cloud]: ${piece.slice(0, 120).replace(/\n/g, ' | ')}`);
      id = (data && data.messages && data.messages[0] && data.messages[0].id) || id;
    }
    return id;
  }

  // Send a FILE. Two steps: upload the bytes to get a media id, then send a
  // message referencing it. A 71-line order does not belong in a chat bubble —
  // the customer sent a spreadsheet and can only check our answer against
  // theirs in the same form.
  async sendDocument(chatId, buffer, filename, mime, caption) {
    const to = String(chatId || '').split('@')[0];
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buffer], { type: mime }), filename);

    const up = await fetch(`${GRAPH}/${config.cloud.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.cloud.token },
      body: form,
    });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok || !upData.id) {
      throw new Error('CloudAPI media upload: ' + ((upData.error && upData.error.message) || 'HTTP ' + up.status));
    }

    await this._post(`${config.cloud.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: upData.id, filename, ...(caption ? { caption } : {}) },
    });
    store.log(this.botKey, `send -> ${to} [cloud]: 📄 ${filename} (${buffer.length} bytes)`);
  }

  // Send a PICTURE. Same two steps as a document. The helper cannot say what
  // part is in a photo they were never shown — before this, an unreadable
  // photo reached them as the words "label photo" and nothing else.
  async sendImage(chatId, buffer, mime, caption) {
    return this.sendMedia(chatId, buffer, mime, caption, 'image');
  }

  // A voice note the bot cannot understand can still be forwarded to somebody
  // who can listen to it. WhatsApp allows no caption on an audio message, so
  // the question goes as its own text just before it.
  async sendAudio(chatId, buffer, mime) {
    return this.sendMedia(chatId, buffer, mime || 'audio/ogg', null, 'audio');
  }

  async sendMedia(chatId, buffer, mime, caption, kind) {
    const to = String(chatId || '').split('@')[0];
    const type = kind || 'image';
    const name = type === 'audio' ? 'voice.ogg' : 'photo.jpg';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime || 'image/jpeg');
    form.append('file', new Blob([buffer], { type: mime || 'image/jpeg' }), name);

    const up = await fetch(`${GRAPH}/${config.cloud.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.cloud.token },
      body: form,
    });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok || !upData.id) {
      throw new Error('CloudAPI media upload: ' + ((upData.error && upData.error.message) || 'HTTP ' + up.status));
    }

    const payload = { messaging_product: 'whatsapp', to, type };
    payload[type] = { id: upData.id, ...(caption && type !== 'audio' ? { caption } : {}) };
    const data = await this._post(`${config.cloud.phoneNumberId}/messages`, payload);
    store.log(this.botKey, `send -> ${to} [cloud]: ${type === 'audio' ? '🎤 voice' : '📷 photo'} (${buffer.length} bytes)`);
    return (data && data.messages && data.messages[0] && data.messages[0].id) || null;
  }

  // Blue ticks, and the "typing..." bubble the customer already understands.
  //
  // This is one call: it marks their message READ and starts the indicator.
  // WhatsApp shows it for up to 25 seconds, or until we actually send —
  // whichever comes first — so it needs no cancelling.
  //
  // It is worth having beyond the look of it: a photo takes a few seconds to
  // read and a portal lookup a second or two, and in that gap the customer has
  // no idea their message even arrived.
  async sendTyping(messageId) {
    if (!messageId) return false;
    try {
      await this._post(`${config.cloud.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      });
      return true;
    } catch (e) {
      // Never let this break a reply. If the account or the API version does
      // not support it, the customer simply sees no indicator.
      store.log(this.botKey, 'typing indicator failed: ' + String((e && e.message) || e).slice(0, 120));
      return false;
    }
  }

  // chatId may be a 1:1 number or a group id — route accordingly.
  async sendToChat(chatId, text) {
    const id = String(chatId || '');
    const groups = require('../core/groups');
    if (/@g\.us/.test(id) || groups.findByGroupId(id)) {
      return this.sendToGroup(id, text);
    }
    return this.sendText(id.split('@')[0], text);
  }

  // ---- Groups -------------------------------------------------------------
  // Contract verified by probing the live API (see core/groups.js).
  async createGroup({ subject, participants, joinApprovalMode }) {
    if (!subject) throw new Error('group subject is required');
    const body = {
      messaging_product: 'whatsapp',
      subject: String(subject).slice(0, 100),
      join_approval_mode: joinApprovalMode || 'auto_approve',
    };
    const people = (participants || []).map((p) => store.normPhone(p)).filter(Boolean);
    if (people.length) body.participants = people.map((user) => ({ user }));

    const data = await this._post(`${config.cloud.phoneNumberId}/groups`, body);
    // be tolerant about where the id lands in the response
    const groupId =
      data.group_id || data.id || (data.groups && data.groups[0] && (data.groups[0].id || data.groups[0].group_id));
    if (!groupId) throw new Error('group created but no id in response: ' + JSON.stringify(data).slice(0, 200));
    store.log(this.botKey, `group created: "${subject}" -> ${groupId} (${people.length} participant(s) requested)`);
    return { groupId: String(groupId), inviteLink: data.invite_link || data.link || null, raw: data };
  }

  async listGroups() {
    const res = await fetch(`${GRAPH}/${config.cloud.phoneNumberId}/groups`, {
      headers: { Authorization: 'Bearer ' + config.cloud.token },
    });
    return res.json();
  }

  // send into a group; chatId here is the group id
  async sendToGroup(groupId, text) {
    for (const piece of pieces(text)) {
      await this._post(`${config.cloud.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'group',
        to: String(groupId).split('@')[0],
        type: 'text',
        text: { body: piece, preview_url: false },
      });
    }
    store.log(this.botKey, `send -> group ${groupId}: ${text.slice(0, 100).replace(/\n/g, ' | ')}`);
  }

  // template send — business-initiated messages (24h window ke bahar) ke liye
  async sendTemplate(number, templateName, langCode, components) {
    const to = store.normPhone(number);
    await this._post(`${config.cloud.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: langCode || 'en' }, ...(components ? { components } : {}) },
    });
    store.log(this.botKey, `send -> ${to} [cloud template:${templateName}]`);
  }

  // media id -> base64 (photo orders ke liye)
  async _downloadMedia(mediaId) {
    const meta = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: 'Bearer ' + config.cloud.token },
    }).then((r) => r.json());
    if (!meta.url) return null;
    const bin = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + config.cloud.token } });
    if (!bin.ok) return null;
    const buf = Buffer.from(await bin.arrayBuffer());
    return { base64: buf.toString('base64'), mime: meta.mime_type || 'image/jpeg' };
  }

  // Meta webhook POST body -> dispatch to bot handlers
  // Feed a message in as if it had arrived from WhatsApp. SimTransport has had
  // this all along; the Cloud one needs it too so recorded customer traffic can
  // be replayed against the live portal without inventing a webhook payload.
  // Nothing is sent to the number the message claims to be from — replies go
  // wherever the caller set chatId.
  async injectIncoming(m) {
    for (const fn of this.handlers) {
      if ((await fn(m)) === true) break;
    }
  }

  async handleWebhook(body) {
    this.state = 'connected (webhook live)';
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Meta sends more than inbound messages here (delivery statuses,
        // errors, template updates). Log what actually arrived — silently
        // dropping them makes "webhook fired but nothing happened"
        // impossible to debug.
        const pnid = value.metadata && value.metadata.phone_number_id;
        const kinds = Object.keys(value).filter((k) => k !== 'messaging_product' && k !== 'metadata');
        if (!value.messages) {
          // Meta puts the REASON inside each status, not at the top level.
          // Reading only value.errors meant a failed send logged as a bare
          // "failed -> 91xxxx" with no cause — which is how an escalation that
          // never reached the helper looked exactly like one that did.
          const detail = (value.statuses || [])
            .map((s) => {
              const why = (s.errors || [])
                .map((e) =>
                  [e.code, e.title || e.message, e.error_data && e.error_data.details]
                    .filter(Boolean)
                    .join(' ')
                )
                .join('; ');
              return (
                `${s.status}${s.recipient_id ? ' -> ' + s.recipient_id : ''}` +
                (why ? ` [${why}]` : '')
              );
            })
            .join(', ');
          const errs = (value.errors || []).map((e) => e.title || e.message).join('; ');
          store.log(
            this.botKey,
            `webhook [${change.field}] pn=${pnid || '?'} keys=${kinds.join('+') || 'none'}` +
              (detail ? ` :: ${detail}` : '') +
              (errs ? ` :: ERROR ${errs}` : '')
          );
        }
        // sirf APNE number ke events process karo — shared WABA par doosre
        // numbers (e.g. 414/ProcureHub) ke events bhi aa sakte hain
        if (pnid && pnid !== config.cloud.phoneNumberId) {
          store.log(this.botKey, `webhook ignored: for phone_number_id ${pnid}, not ours (${config.cloud.phoneNumberId})`);
          continue;
        }
        for (const msg of value.messages || []) {
          // The same message, twice. Meta retries a webhook it believes was
          // not acknowledged, so this is not a rare case - and a repeat used
          // to double the cart, or punch the order again (core/seen).
          // Claimed now, recorded as seen only once it has been handled (the
          // finally below): a restart half way through must not turn the
          // relay's second offer into a "duplicate".
          if (!seen.begin(this.botKey, msg.id)) continue;
          try {
            // GROUP DETECTION. The exact field Meta uses for inbound group
            // messages is not documented in what we have, so check every
            // plausible location. When something looks group-ish but we
            // cannot place it, the raw payload is logged below so the real
            // shape can be read off a live message once.
            const groupId =
              msg.group_id ||
              (msg.group && (msg.group.id || msg.group.group_id)) ||
              (msg.context && msg.context.group_id) ||
              (value.metadata && value.metadata.group_id) ||
              null;
            const isGroup = Boolean(groupId);
            const m = {
              from: store.normPhone(msg.from),
              chatId: isGroup ? String(groupId) : store.normPhone(msg.from) + '@cloud',
              chatName: (msg.group && msg.group.subject) || '',
              isGroup,
              // This message's own id. Needed to mark it read and to show the
              // customer that something is being typed.
              id: msg.id || null,
              // Which message this one is a reply to. WhatsApp puts it here
              // when someone swipes-to-reply, and it is how the helper's bare
              // "23710M74L00" gets matched to the right question.
              contextId: (msg.context && msg.context.id) || null,
              body:
                (msg.text && msg.text.body) ||
                (msg.image && msg.image.caption) ||
                (msg.document && msg.document.caption) ||
                '',
              hasMedia: Boolean(msg.image || msg.document),
              mediaType: msg.type,
              fileName: (msg.document && msg.document.filename) || '',
            };
            // Learn the real payload shape: log anything carrying a hint of a
            // group that we did not manage to parse into a group id.
            if (!isGroup && /group/i.test(JSON.stringify(msg))) {
              store.log(this.botKey, 'UNRECOGNISED GROUP PAYLOAD (raw): ' + JSON.stringify(msg).slice(0, 700));
            }
            // Voice notes were never downloaded, so there was nothing to
            // pass on to a person — the customer just got "I cannot listen to
            // voice messages". Eleven of those in seventeen days on one chat.
            if (msg.audio && msg.audio.id) {
              const media = await this._downloadMedia(msg.audio.id);
              if (media) {
                m.mediaBase64 = media.base64;
                m.mediaMime = media.mime;
                m.hasMedia = true;
              }
            }
            if (msg.image && msg.image.id) {
              const media = await this._downloadMedia(msg.image.id);
              if (media && /^image\//.test(media.mime)) {
                m.mediaBase64 = media.base64;
                m.mediaMime = media.mime;
              }
            }
            // A customer forwarding "FORD PENDING LIST 1-09.xlsx" is sending an
            // order. Documents were flagged hasMedia but never fetched, so the
            // message arrived with an empty body and fell out of every handler
            // — the customer got total silence, which is worse than a refusal.
            if (msg.document && msg.document.id) {
              const media = await this._downloadMedia(msg.document.id);
              if (media) {
                m.mediaBase64 = media.base64;
                m.mediaMime = msg.document.mime_type || media.mime;
              }
            }
            store.log(this.botKey, `recv <- ${m.from} [cloud]: ${(m.body || '(' + m.mediaType + ')').slice(0, 100).replace(/\n/g, ' | ')}`);
            for (const fn of this.handlers) {
              if ((await fn(m)) === true) break;
            }
          } catch (e) {
            store.log(this.botKey, 'cloud webhook handler error: ' + String((e && e.message) || e).slice(0, 200));
          } finally {
            seen.done(this.botKey, msg.id);
          }
        }
      }
    }
  }

  status() {
    return { mode: this.mode, state: this.state, qrDataUrl: null, roles: this.roles };
  }
}

// A text cut into messages WhatsApp accepts (4096 characters), between lines
// where it can, and never splitting a line that fits.
const PIECE_MAX = 3800;
function pieces(text, max = PIECE_MAX) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return [s];
  const out = [];
  let cur = '';
  for (const line of s.split('\n')) {
    // One line longer than a whole message: cut it where it must be cut.
    const parts = line.length > max ? line.match(new RegExp('[\\s\\S]{1,' + max + '}', 'g')) : [line];
    for (const p of parts) {
      if (cur && cur.length + 1 + p.length > max) {
        out.push(cur);
        cur = p;
      } else {
        cur = cur ? cur + '\n' + p : p;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { CloudTransport, _pieces: pieces };
