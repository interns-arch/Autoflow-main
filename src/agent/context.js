'use strict';
// WHO IS TALKING, AND UNDER WHOSE ACCOUNT.
//
// The model must never be told the chat id or the customer's account, because
// anything in the prompt can end up in a reply, and because a model that can
// name an account can be talked into pricing against somebody else's. So the
// per-conversation facts travel beside the message in LangChain's `config`
// and are read here, inside the tools.
//
// LangGraph's checkpointer keys its thread off `configurable.thread_id`, so
// the same object carries the memory key and the identity together.
function contextFrom(config) {
  const c = (config && config.configurable) || {};
  return {
    chatId: c.chatId || c.thread_id || null,
    // The dealer-portal customer record, or null for a number the portal does
    // not know. resolve() reads accountId/buyerId off it and decides from that
    // whether a rate is repeatable — see availability.priceOf.
    customer: c.customer || null,
    // The phone the question came from, for escalation bookkeeping.
    phone: c.phone || String(c.chatId || c.thread_id || '').replace(/@.*$/, '') || null,
  };
}

// The translator the existing reply builders expect: t(english, hinglish).
function translatorFor(chatId) {
  return require('../core/lang').for(chatId);
}

module.exports = { contextFrom, translatorFor };
