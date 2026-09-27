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
function envelope(m, { text, quoted, attachment } = {}) {
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

  // WHAT AN ATTACHMENT SAID. Photos, documents and voice notes are read before
  // the agent sees the message (pipeline/media.readForAgent) and arrive here
  // as what they contain — never as a reply somebody else already wrote.
  if (attachment) notes.push(describeAttachment(attachment));

  const words = m.edit ? m.edit.text : text;
  return [...notes, String(words || '').trim()].filter(Boolean).join('\n');
}

function describeAttachment(a) {
  const listed = (lines) =>
    lines
      .slice(0, 60)
      .map((l, i) => `${i + 1}. ${l.item}${l.qtyMissing ? ' (no quantity given)' : ' x ' + l.qty}`)
      .join('\n') + (lines.length > 60 ? `\n… and ${lines.length - 60} more` : '');
  if (a.kind === 'voice') {
    return a.transcript
      ? '[Sent a VOICE NOTE. What it says is below — written down by machine, so a part number in it may be misheard]'
      : '[Sent a voice note we could not make out. If it matters, ask_a_person with reason "voice_note" — the recording goes with it]';
  }
  if (a.kind === 'photo') {
    if (a.forForm) return '[Sent a photo]';
    if (a.lines && a.lines.length) return `[Sent a PHOTO. It reads as ${a.lines.length} order line(s):\n${listed(a.lines)}]`;
    return `[Sent a photo; no part number could be read from it${a.note ? ' (' + a.note + ')' : ''}. If they want something from it, ask_a_person — the photo goes with it]`;
  }
  if (a.kind === 'document') {
    const name = a.fileName ? ` "${clip(a.fileName, 60)}"` : '';
    if (a.lines && a.lines.length) return `[Sent a document${name}. It lists ${a.lines.length} order line(s):\n${listed(a.lines)}]`;
    return `[Sent a document${name}; nothing in it could be read as an order${a.note ? ' (' + a.note + ')' : ''}]`;
  }
  return '[Sent an attachment]';
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
function forAgent(m, { text, quoted, before, attachment } = {}) {
  return [catchUp(m.chatId, before), envelope(m, { text, quoted, attachment })].filter(Boolean).join('\n\n');
}

// THE PHOTO BEING TALKED ABOUT. A question about a photo reaches a person
// with the photo, or he is asked to name a part from the words "label photo".
// Held per chat, the way core/voiceNote holds a recording.
const photos = new Map();
function holdPhoto(chatId, photo) {
  if (chatId && photo && photo.base64) photos.set(chatId, { ...photo, at: Date.now() });
}
function heldPhoto(chatId) {
  const p = photos.get(chatId);
  return p && Date.now() - p.at < 30 * 60 * 1000 ? { base64: p.base64, mime: p.mime } : null;
}
function dropPhoto(chatId) {
  photos.delete(chatId);
}

module.exports = { envelope, forLog, catchUp, markSeen, forAgent, isEvent, holdPhoto, heldPhoto, dropPhoto, describeAttachment };
