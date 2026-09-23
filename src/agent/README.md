# The agent

One agent. Every tool. The model picks which to reach for, from the docstrings
on the tools themselves.

There is no orchestrator, no supervisor and no sub-agent, because a routing
layer only moves the same decision somewhere harder to test — and it was
measured: a single agent picked the right tool first time 83% of the time at
1085ms, and the misses corrected themselves inside the loop rather than being
locked in by a router.

```
customer message
      |
      |  echo guard, voice/photo, route.forBot   <- deterministic, stays in front
      v
  src/agent/index.js          createAgent, Gemini Flash Lite
      |
      |  prompt.js            who it is, and the order it works in
      |  memory.js            the thread (checkpointer) + the live cart
      v
  tools/  ->  the existing, tested core modules
```

## Where the rules live

Everything that must not be broken is enforced **inside the tools**, not in the
prompt, because a prompt is advice and a customer can talk a model out of
advice. The model never sees the data a guard rejected.

| Rule | Enforced by | In |
|---|---|---|
| A rate that is not this customer's is never quoted | `availability.priceOf` | `tools/commerce.js` |
| A single portal hit that contradicts the question is shown, not answered | `availability.matchTrustworthy` | `tools/parts.js` |
| Two near-identical parts are shown, never chosen | the index margin | `core/parts` |
| No order is placed while `ORDER_CONFIRM_ENABLED` is off | `orders.confirm` | `core/orders` |
| A quantity below 1 is refused | the tool body | `tools/orders.js` |
| No policy is answered from general knowledge | `kb.answer` returning false | `tools/knowledge.js` |

The quantity floor is in the tool body rather than the schema because Gemini's
function-declaration dialect rejects `exclusiveMinimum`, which is what zod's
`.positive()` emits. If it were not in the body it would not be anywhere.

## Memory

Two different things, kept apart:

- **The conversation** — LangGraph's checkpointer, keyed on `thread_id`, which
  is the chat id. Remembered.
- **The cart** — *not* in the conversation. It lives in `core/orders`, and
  `memory.cartNote()` re-reads it and injects one line on every single turn. A
  cart quoted from six messages ago may have been confirmed, cancelled or
  re-priced since, and a model reading its own stale summary will happily
  confirm an order that no longer exists.

So: history is remembered, state is re-read.

## Identity

The chat id, the phone and the customer's portal account travel in
LangChain's `config.configurable` and are read by `context.js` **inside** the
tools. They are never put in the prompt: anything in the prompt can end up in
a reply, and a model that can name an account can be talked into pricing
against somebody else's.

`configurable.thread_id` is the same chat id, so one object carries both the
memory key and the identity.

## Turning it on

Both gates default to shut.

```
AGENT_ENABLED=true
AGENT_ALLOW_FROM=919999492550,917355374975
```

`AGENT_ALLOW_FROM` is empty by default, so setting the flag on by accident
still reaches nobody. While it is being trialled it answers exactly the
numbers in that list.

Other settings: `AGENT_NAME` (default `Prateek`), `AGENT_MODEL` (default
`gemini-3.5-flash-lite`), `AGENT_MAX_TOOL_CALLS` (default 10 — a normal
part-and-price turn is 2 to 4).

## Driving it by hand

```
npm run try:agent
npm run try:agent -- "cartend wiper blade 16 number ka rate"
```

Nothing there touches WhatsApp, and every tool call is printed as it happens,
so a wrong answer can be traced to the tool that produced it. The tools are
the real ones — real portal, real catalogue — but no order can be placed,
because `ORDER_CONFIRM_ENABLED` gates that below this layer.

## Tests

```
npm run test:agent
```

Two halves, and the difference matters. The **tools** are tested offline with
no model at all: they are ordinary functions holding rules that are testable
to the letter. The **agent** is tested against the live model, because what is
being measured is a judgement — did it reach for the right tool, did it answer
in the customer's language. That half skips itself without `GEMINI_API_KEY`.
