'use strict';
// WHAT WHATSAPP DOES TO TEXT ON THE WAY BACK.
//
// The bot asks people to reply in an exact format, and it asks in BOLD so the
// format stands out:
//
//   Reply *OK WA-MUF9D6Q6* to create, *NO WA-MUF9D6Q6* to reject.
//
// WhatsApp renders that bold. The obvious way to comply is to copy what you
// were shown — and copying bold text brings the asterisks with it.
//
// Live, 24 Sep, 13:51 to 14:00: Prateek sir was asked three times for the
// exact format, sent exactly the format he was asked for, and was refused
// every time, because what arrived was
//
//   *OK WA-MUF9D6Q6*
//
// and the parser wanted OK WA-MUF9D6Q6. A customer's account sat unopened for
// nine minutes while the bot and the person approving it argued about
// punctuation the bot had put there itself.
//
// So every parser that reads a person's reply strips the markup first. The
// four markers are WhatsApp's whole formatting vocabulary: *bold*, _italic_,
// ~strike~ and `mono`. A trailing full stop goes too — people end sentences.
//
// Markers become SPACES rather than nothing, so "*OK* *WA-1*" does not
// collapse into "OKWA-1"; the runs of space are squeezed afterwards. None of
// the four ever appears inside a request id (WA-[A-Z0-9]+) or a part number,
// so nothing real is lost.
const MARKUP = /[*_~`]/g;
const TRAILING = /[.!,;:]+$/;

function unformat(text) {
  return String(text == null ? '' : text)
    .replace(MARKUP, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILING, '')
    .trim();
}

module.exports = { unformat };
