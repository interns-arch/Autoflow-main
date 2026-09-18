'use strict';
// Internal event bus — the source of truth for bot-to-bot communication.
// When two bots are both LIVE on WhatsApp, the sending bot also mirrors the
// event as a real WhatsApp message (audit trail + works if bots are later
// split into separate processes).
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
