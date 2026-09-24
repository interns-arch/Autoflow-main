'use strict';
// WHAT THE CUSTOMER ACTUALLY DID — in words the model can read.
//
// A WhatsApp message is more than its text. Meta's messages webhook (read 24
// Sep) delivers, besides the words: which message this one swipe-replies to,
// that it was forwarded, that the words were a CAPTION under a photo, an emoji
// reaction on one of our messages, an EDIT of something they sent, a DELETION,
// a shared location or contact, a sticker, a product from our catalogue, an ad
// it came in from. The model only ever saw the text, so "2" swiped onto our
// "Kitne chahiye?" and "2" typed out of nowhere were the same message to it,
// and a 👍 on "Yahi chahiye, 20 pcs?" was nothing at all.
//
// So the message goes to the agent with short bracketed notes in front of it,
// and the prompt explains what each one means (agent/prompt.js, "WHATSAPP, AS
// IT REACHES YOU"). The notes describe; they never decide. What a reaction or
// an edit MEANS for the cart is the model's judgement, made with its tools.
//
// And a CATCH-UP. Some messages never reach the agent — a photo is read by the
// order pipeline, a customer form owns the chat until it is finished — and
// the agent's own memory has a hole where they were. Everything said in the
// chat since the agent last spoke is put in front of the next message it does
// see. The first time a chat reaches the agent at all, that is the recent
// conversation the template path had with them, so it does not start blind.
const conversation = require('../core/conversation');
const agentSeen = require('../core/chatState').slot('agentSeen');

function clip(t, n = 160) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// A message that carries no text but still says something.
function isEvent(m) {
  return Boolean(
    m &&
      (m.reaction || m.edit || m.revoke || (m.contacts && m.contacts.length) || m.sticker || m.location || m.unsupported),
  );
}

// `quoted(id)` -> { dir: 'us' | 'customer', text } | null. The bot owns that
// memory (the last forty messages each way, by WhatsApp id); this only asks.
function which(quoted, id) {
  const q = typeof quoted === 'function' && id ? quoted(id) : null;
  return q && q.text ? q : null;
}
const whose = (q) => (q.dir === 'us' ? 'OUR' : 'THEIR OWN');

// The notes for one message, and the words themselves, as one block.
function envelope(m, { text, quoted } = {}) {
  const notes = [];

  if (m.forwarded) {
    notes.push(
      m.forwarded === 'frequently'
        ? '[Forwarded many times — someone else wrote this]'
        : '[Forwarded — someone else wrote this]',
    );
  }
  if (m.referral) notes.push(`[Came in from our ad${m.referral.headline ? ': "' + clip(m.referral.headline, 80) + '"' : ''}]`);
  if (m.product) notes.push(`[Asked from a product in our WhatsApp catalogue: ${m.product.productId || 'unknown id'}]`);

  // A swipe-reply. Not for a reaction, which names its message separately.
  if (m.contextId && !m.reaction) {
    const q = which(quoted, m.contextId);
    notes.push(
      q
        ? `[Swipe-reply to ${whose(q)} earlier message: "${clip(q.text)}"]`
        : '[Swipe-reply to an older message we no longer have on record]',
    );
  }

  if (m.reaction) {
    const q = which(quoted, m.reaction.messageId);
    const target = q ? `${whose(q)} message "${clip(q.text)}"` : 'one of our earlier messages';
    notes.push(m.reaction.emoji ? `[Reacted ${m.reaction.emoji} to ${target}]` : `[Took back their reaction on ${target}]`);
  }

  if (m.edit) {
    const q = which(quoted, m.edit.originalId);
    notes.push(`[EDITED their earlier message${q ? ' "' + clip(q.text) + '"' : ''} — the new version replaces it. It now reads:]`);
  }
  if (m.revoke) {
    const q = which(quoted, m.revoke.originalId);
    notes.push(`[DELETED their earlier message${q ? ' "' + clip(q.text) + '"' : ''} — they took it back]`);
  }

  if (m.caption) {
    const kind = m.mediaType === 'video' ? 'a video (we cannot watch videos)' : m.mediaType === 'document' ? 'a document' : 'a photo';
    notes.push(`[Sent ${kind}; the words below were written UNDER it]`);
  }
  if (m.location) {
    const l = m.location;
    const where = [l.name, l.address].filter(Boolean).join(', ');
    notes.push(`[Shared a location${where ? ': ' + clip(where, 120) : ''} (${l.lat}, ${l.lng})]`);
  }
  if (m.contacts && m.contacts.length) {
    notes.push(`[Shared contact${m.contacts.length > 1 ? 's' : ''}: ${m.contacts.map((c) => [c.name, c.phone].filter(Boolean).join(' ')).join('; ')}]`);
  }
  if (m.sticker) notes.push('[Sent a sticker]');
  if (m.unsupported) notes.push('[Sent something WhatsApp could not show us]');

  const words = m.edit ? m.edit.text : text;
  return [...notes, String(words || '').trim()].filter(Boolean).join('\n');
}

// One line for the conversation log, so the chat's own record — which the
// template path answers from, and the catch-up below reads — says what
// happened instead of logging a photo with a caption as if it were typed.
function forLog(m) {
  const body = String(m.body || '').trim();
  if (m.reaction) return m.reaction.emoji ? `(reacted ${m.reaction.emoji})` : '(took back a reaction)';
  if (m.edit) return `(edited a message) ${clip(m.edit.text, 250)}`;
  if (m.revoke) return '(deleted a message)';
  if (m.sticker) return '(sticker)';
  if (m.contacts && m.contacts.length) return '(shared a contact)';
  if (m.location && !body) return '(shared a location)';
  const kind =
    m.mediaType === 'image' ? 'photo' : m.mediaType === 'video' ? 'video' : m.mediaType === 'document' ? 'document' : m.voice ? 'voice note' : m.mediaType === 'audio' ? 'audio' : null;
  if (kind && body) return `(${kind}) ${body}`;
  if (kind) return `(${kind})`;
  return (m.forwarded ? '(forwarded) ' : '') + (body || `(${m.mediaType || 'message'})`);
}

// Everything said in this chat since the agent last spoke, other than the
// message it is answering now (recorded at `before`).
function catchUp(chatId, before) {
  const seen = (agentSeen.get(chatId) || {}).at || 0;
  const turns = conversation.turns(chatId).filter((t) => t.at > seen && (!before || t.at < before));
  if (!turns.length) return '';
  return (
    "[Earlier in this chat, answered by the shop's order desk before this message reached you:\n" +
    turns.map((t) => `${t.role === 'customer' ? 'Customer' : 'Us'}: ${clip(t.text, 300)}`).join('\n') +
    ']'
  );
}

// The agent has spoken; everything up to now is in its own memory.
function markSeen(chatId) {
  if (chatId) agentSeen.set(chatId, { at: Date.now() });
}

// The whole input for one agent turn.
function forAgent(m, { text, quoted, before } = {}) {
  return [catchUp(m.chatId, before), envelope(m, { text, quoted })].filter(Boolean).join('\n\n');
}

module.exports = { envelope, forLog, catchUp, markSeen, forAgent, isEvent };
