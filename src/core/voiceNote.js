'use strict';
// The recording behind the words the bot is reading right now.
//
// Once a voice note is transcribed, the transcript goes down the ordinary text
// path — it is just a message the customer spoke instead of typed. If that path
// ends up asking a person, the person must still get the AUDIO: a transcript is
// Google's best guess, and "16510M65L10" against "16510M65L70" is decided by
// playing the clip, not by reading it.
//
// Carrying the clip through every call between here and escalation.create would
// mean a new argument on a dozen functions that have nothing to do with sound.
// So it waits here instead, and escalation picks it up by chatId.
//
// IN MEMORY ONLY, deliberately. These are hundreds of kilobytes of base64 per
// note; chatState writes to state.json, and a day of voice notes in there would
// make the file unusable. Losing a clip on restart costs the helper one played
// recording — the question itself is persisted as it always was.
//
// ONE MESSAGE AT A TIME. customerBot clears the chat's clip as each new message
// arrives, so what is held here always belongs to the message being handled and
// never to the one before it.
const clips = new Map(); // chatId -> { at, base64, mime, transcript }

// A belt-and-braces cap, in case a message is ever handled without the clear
// that customerBot does. Nothing should ever live here that long.
const MAX_AGE_MS = 5 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [chatId, c] of clips) if (now - c.at > MAX_AGE_MS) clips.delete(chatId);
}

function hold(chatId, { base64, mime, transcript } = {}) {
  if (!chatId || !base64) return;
  sweep();
  clips.set(chatId, {
    at: Date.now(),
    base64,
    mime: mime || 'audio/ogg',
    transcript: transcript || null,
  });
}

function forChat(chatId) {
  sweep();
  return clips.get(chatId) || null;
}

function clear(chatId) {
  clips.delete(chatId);
}

module.exports = { hold, forChat, clear };
