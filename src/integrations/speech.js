'use strict';
// Turning a customer's voice note into text, so the person answering it can
// READ it instead of listening to it.
//
// Why Gemini: it takes audio, which a text-and-image model does not, and it
// accepts audio/ogg, which is exactly the codec WhatsApp records in — no
// conversion step.
//
// Why not whisper on our own box: measured on this EC2 at 46 seconds for a
// 15-second clip, and it came back in Devanagari. The box is shared and capped
// at 512MB. It is not a real option.
//
// WHAT THIS IS ALLOWED TO DO, and it is deliberately small:
//   the transcript goes to the HELPER, next to the recording.
// It never places an order, never resolves a part number, never reaches the
// customer. A mis-heard digit in "16510M65L10" is an order for the wrong part;
// a mis-heard word in a line the helper is reading costs nothing, because the
// recording is right there underneath it.
//
// NOTE on the free tier: Google's pricing page says free-tier content is
// "used to improve our products", paid-tier content is not. These are real
// customers' voices. Use a billed key. At 32 tokens per second of audio a
// 15-second note is about 480 tokens, so the bill is negligible either way.
const config = require('../config');
const store = require('../store');

const enabled = () => !!(config.speech && config.speech.apiKey);

// Gemini wants a bare mime type; WhatsApp sends "audio/ogg; codecs=opus".
function mimeOf(raw) {
  const m = String(raw || 'audio/ogg')
    .split(';')[0]
    .trim()
    .toLowerCase();
  return /^audio\//.test(m) ? m : 'audio/ogg';
}

const PROMPT = [
  'Transcribe this voice message from an Indian auto-parts customer talking to his supplier.',
  'He speaks Hindi, English or a mix of both.',
  '',
  'Rules:',
  '- Write Hindi in Roman letters (Hinglish), not Devanagari. "nauwa hata do", not "नौवां हटा दो".',
  '- Write part numbers exactly as spoken, with no spaces: 16510M65L10.',
  '- Write EVERY number as digits, including spoken Hindi ones: "do" -> 2, "teen" -> 3,',
  '  "chaar" -> 4, "paanch" -> 5, "nau" -> 9, "das" -> 10. "do pise" is "2 pise".',
  '  A quantity written as a word cannot be read as a quantity downstream.',
  '- If you are unsure of a word, write it as [unclear] rather than guessing.',
  '- Output ONLY the transcript. No preamble, no translation, no explanation.',
].join('\n');

// base64 audio -> plain text, or null. NEVER throws: a voice note must still
// reach a person when Google is down, out of quota, or not configured.
async function transcribe(base64, mime) {
  if (!enabled() || !base64) return null;

  const bytes = Math.floor((String(base64).length * 3) / 4);
  if (bytes > config.speech.maxBytes) {
    store.log('speech', `voice note too big to transcribe (${Math.round(bytes / 1024)}KB)`);
    return null;
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.speech.model)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.speech.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.speech.apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeOf(mime), data: base64 } },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 512 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      store.log('speech', `Gemini HTTP ${res.status}${body ? ' — ' + body.slice(0, 160) : ''}`);
      return null;
    }
    const data = await res.json();
    const text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!text) {
      store.log('speech', 'Gemini returned an empty transcript');
      return null;
    }
    // A transcript that is mostly [unclear] tells the reader nothing and takes
    // up space above the recording they now have to play anyway.
    const unclear = (text.match(/\[unclear\]/gi) || []).length;
    if (unclear && unclear * 10 >= text.split(/\s+/).length) {
      store.log('speech', 'transcript was mostly [unclear] — not showing it');
      return null;
    }
    store.log('speech', `transcribed ${Math.round(bytes / 1024)}KB -> "${text.slice(0, 60)}"`);
    return text.slice(0, 600);
  } catch (e) {
    store.log('speech', `transcribe failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { transcribe, enabled, mimeOf, PROMPT };
