# Cartrends AutoFlow

End-to-end multi-agent WhatsApp automation for Cartrends, implementing
`Automated_Workflow_Specification_and_Transcript.docx`:
sales order capture, vendor procurement, warehouse logistics, finance
reminders and internal helpdesk — run by 5 specialized bots on dedicated
WhatsApp numbers, synced with the Dealer Portal.

## How go-live works (the .env rule)

Every bot has a number slot in `.env`. **Empty number = SIMULATION mode**
(test the full flow from the web console). **Fill the number + restart =
LIVE**: a QR code appears in the console — scan it from that number's phone
(WhatsApp → Linked devices) and the bot starts working on real WhatsApp.
Nothing else changes; the flows are identical in both modes.

**You only need 2 numbers.** Roles can share a line — write the same number
into several slots. Recommended: the Customer/Sales bot gets its own number
(heavy customer traffic), and Purchase + Warehouse + Finance + Helpdesk all
share the second number (one QR scan covers all four). Inbound messages on a
shared line are routed by priority — vendor messages go to the purchase
role, `DO`/`DONE`/`REGISTER PICKER` to warehouse, `STATEMENT` to finance,
and anything else from an employee becomes a helpdesk ticket. Bot-to-bot
requests (sales → purchase `#PROCURE`) keep flowing over the internal bus
regardless of how many physical numbers you use, so splitting a role onto
its own number later is just a `.env` change.

```
copy .env.example .env    # then fill numbers as your WhatsApp setup completes
npm install
npm start                 # console: http://localhost:3010
```

Verify everything anytime with the built-in end-to-end test: `npm run smoke`

## Implementation phases

### Phase 0 — Foundation  ✅ built
Multi-bot engine (LIVE/SIM per bot), JSON datastore, event bus with
WhatsApp mirroring (`#PROCURE` messages 421→414), Dealer Portal adapter
(mock until `DEALER_PORTAL_BASE_URL` + key are set), IVR adapter
(mock / Twilio), schedulers, operations console with QR linking,
simulator and data admin.

### Phase 1 — Purchase Bot, Line 414  ✅ built  (spec Phase A)
- Stock broadcast to all registered vendors (2× daily, `STOCK_BROADCAST_TIMES`)
- Stock list ingestion from vendor replies (line parser + optional Gemini for messy/Hinglish lists)
- IVR voice follow-up 2× daily **only to vendors who haven't submitted since
  the last broadcast** — dynamic suppression, exactly as specified

### Phase 2 — Customer Bot, Line 421  ✅ built  (spec Phases B + C)
- Listens in customer groups (`CUSTOMER_GROUPS`, empty = all) and DMs
- Availability/ETA quotes from aggregated stock (internal Bijwasan first, then vendor feeds)
- Draft SO held locally; dynamic modification in chat ("Brake Pad to 8", "remove oil filter")
- Final **YES** → SO punched into Dealer Portal → automatic order split:
  - in-stock lines → WhatsApp dispatch alert to `WAREHOUSE_TEAM_NUMBERS` with the SO number
  - vendor lines → `procure.request` to the Purchase Bot per vendor (Northend, Mohan, …)
- Purchase Bot then: places PO on WhatsApp + automated confirmation call →
  vendor "yes" → PO punched into portal → **hourly invoice chase** →
  bill received → validated against PO → uploaded → marked **In Transit**
  (vehicle number auto-captured) → warehouse inbound alert
- Customer sees one unified order; zero human intervention end to end

### Phase 2.5 — Customer engagement  ✅ built
- **Order status on demand**: "status" / "order kahan hai" / "gadi kahan
  pahuchi" → live reply covering warehouse stage (picked/packed) and vendor
  legs (arranged → ordered → billed → on the way, with vehicle number)
- **Credit Notes on WhatsApp**: issue a CN from the console (or POST
  `/api/credit-notes` from the portal later) → customer instantly gets it
- **Offers & stock broadcasts**: compose an offer ("Maruti mein ye discount
  hai…") or one-click *stock highlights* — a nicely formatted ready-stock +
  on-order list — broadcast to every captured customer (customers are
  auto-captured from orders, or added in the console)
- **Cross-selling**: after each confirmed order the bot suggests related
  items (map editable in the console, e.g. Brake Pad → Brake Fluid)
- **Photo orders**: customer sends the order as a photograph → vision reads
  it into order lines and the normal draft/confirm flow continues.

  **The reader: Gemini vision.** There is no
  local OCR — the old Windows-only chain (`pytesseract` / `easyocr` / WinRT)
  never ran in production, where the image ships no OCR binary, and has been
  taken out. A photo with no vision key available goes to a person, with the
  photo attached.

  **After reading, the same deterministic line parser as typed orders** handles
  `Brake Pad - 5`, `Spark Plug x 4`, `10 x Brake Pad`, `Oil Filter x 2 @
  rs 350`, unit words, and Hinglish variants — so a photo order and a typed
  order produce identical drafts.

  **Safety guards (all verified):**
  - a photo of a **GST/tax invoice is refused entirely** — "Invoice No 2939"
    can never become an order for 2,939 invoices;
  - header words (total, GST, HSN, qty, rate…) are never items;
  - quantities are capped (a 10-digit "qty" is a part number, not a qty);
  - unreadable photos get a polite ask-to-type in DMs; groups are never
    spammed.

  **Known limit:** the built-in engine reads print well but genuine
  handwriting poorly — handwritten photos need `GEMINI_API_KEY` (Gemini
  vision) to work.

### No UI needed — admin runs on WhatsApp too
The web console is a **dev/testing tool only**; production runs headless.
QR codes for linking print directly in the terminal. Numbers listed in
`ADMIN_NUMBERS` can DM any bot line with commands — `REPORT`, `STOCK`,
`ORDERS`, `POS`, `OFFER <text>`, `HIGHLIGHTS`, `CN <phone> <amount>
<reason>`, `VENDOR ADD name, phone`, `CUSTOMER ADD name, phone`,
`STOCKREQ`, `CHASE`, `HELP` — and a full ops report is pushed to them
daily at `DAILY_REPORT_TIME`.

### ProcureHub integration (purchase bot 414 = ProcureHub)
With `PROCUREHUB_BASE_URL` + `PROCUREHUB_USERNAME`/`PASSWORD` set, the
Customer Bot enriches availability checks from ProcureHub's live
consolidated vendor stock (`/api/command-centre/part-intelligence`) —
vendors and live-remaining quantities are cached locally, so items not in
the WhatsApp-collected stock still quote correctly. Without the env vars,
the standalone WhatsApp stock-collection flow is used.

### Phase 3 — Warehouse Manager Bot  🟡 core built, goes live with its number
- Inbound transit alerts already flow from Phase 2
- DO-Confirmed → picklist from Dealer Portal → WhatsApp task to pickers with shelf locations
  (trigger: portal webhook when available; manual `DO <SO#>` message or console button today)
- Pickers register with `REGISTER PICKER`, close tasks with `DONE <SO#>`
- GRN verification remains human by design

### Phase 4 — Finance Bot  🟡 core built
- Daily payment reminders from the outstanding-invoices table
- `STATEMENT` reply → ledger statement on WhatsApp
- Reconciliation endpoints stubbed in the portal adapter, to wire when API spec arrives

### Phase 5 — HR/IT Helpdesk Bot  🟡 core built
- Every employee DM becomes a ticket, auto-classified HR vs IT, logged with an ID

## Setup checklist (in order)

1. `npm install`, copy `.env.example` → `.env`, `npm start`
2. Open http://localhost:3010 — add your **vendors** (name + WhatsApp number)
   and paste **internal stock** (item, qty, shelf)
3. Test flows in the simulator (vendor stock reply → customer order → YES →
   watch SO/PO/dispatch happen in the tables)
4. WhatsApp numbers ready? Put `PURCHASE_BOT_NUMBER` and `CUSTOMER_BOT_NUMBER`
   in `.env`, restart, scan the two QR codes → **Phases 1–2 live**
5. Fill `WAREHOUSE_TEAM_NUMBERS` (+ later `WAREHOUSE_BOT_NUMBER`) → Phase 3
6. Dealer Portal creds from Aneeq → `DEALER_PORTAL_BASE_URL` + `DEALER_PORTAL_API_KEY`
   (until then the mock portal issues SO-/PO- numbers so nothing blocks)
7. Voice calls: keep `IVR_PROVIDER=mock`, or set `twilio` + credentials
8. `GEMINI_API_KEY` for AI parsing of free-form/Hinglish messages and photos

## Architecture

```
customer groups ──> Customer Bot 421 ──┐            ┌──> vendors (stock, POs, invoices)
                                       │            │
                    draft SO ──YES──> Dealer Portal adapter <── Purchase Bot 414
                                       │  (mock/real)          ▲ 2x/day IVR follow-up
        in-stock lines                 │      vendor lines ────┘   hourly invoice chase
              │                        │
              ▼                        ▼
   Warehouse Bot / team numbers   Finance Bot · Helpdesk Bot
   (dispatch, inbound, picklists)
```

All bots run in one Node process and talk over an internal event bus;
inter-bot WhatsApp messages (`#PROCURE …`) mirror the bus so the bots can be
split into separate processes/machines later without code changes.

## Self-learning knowledge base (RAG)

A question Prateek sir answers once, the bot answers by itself from then on.
This covers **business** questions — returns, warranty, GST, payment terms,
delivery — and deliberately **not** part identification: "16 inch" and "18
inch" are nearly identical to an embedding, and a near-miss there ships the
wrong part. Part numbers keep using the exact alias/family matching in
`core/knowledge.js`.

```
customer question
   │
   ▼
search approved knowledge ──► vector top-K ──► similarity ≥ threshold?
   │                                                  │
   │ no                                               │ yes
   ▼                                                  ▼
ask Prateek sir                            does it ANSWER the question?
   │                                        (LLM relevance check)
   │                                             │yes        │no
   ▼                                             ▼           └──► ask Prateek sir
his reply ──► structured ──► embedded ──► saved ──► customer gets it
                                  │
                                  └──► next customer is served with nobody asked
```

Two rules the code enforces rather than trusts:

- **The LLM never invents a business fact.** It phrases an *approved* answer.
  A reply containing a number the approved answer does not contain is thrown
  away and the stored wording is sent instead (`core/kb/index.js`, `phrase`).
- **One dealer's terms never reach another.** Scope is filtered in the SQL
  `WHERE` clause, and an answer stating money or percentages is never saved
  as `global` — it is tied to that customer, or held for review.

### Setup

```
docker compose up -d autoflow-db     # Postgres with pgvector
# put DATABASE_URL + KNOWLEDGE_API_TOKEN in .env
npm run migrate                      # creates bot_knowledge, bot_escalations
npm start                            # boot log says: knowledge base: ready
```

**Where it actually runs.** pgvector cannot be built on a Windows laptop
without admin rights, so the database lives on the EC2 host beside the other
containers:

```
container  cartrends-autoflow-db        pgvector/pgvector:pg17
bound to   127.0.0.1:5433               never exposed to the internet
compose    ~/autoflow-kb/docker-compose.yml   (its own project, so bringing it
                                               up restarts nothing else)
applied    001_knowledge_base           PostgreSQL 17.11, pgvector 0.8.6
```

From EC2 the bot reaches it as `autoflow-db:5432` once both are on the same
compose project. From a laptop, tunnel first:

```
ssh -i ~/.ssh/CT_EC2_key.pem -L 5433:127.0.0.1:5433 ubuntu@52.66.83.8
```

`DATABASE_URL` empty = the feature is **off** and the bot behaves exactly as
before: every question goes to a person. Nothing degrades silently — a
database that is down or a schema that is missing is reported at boot and each
question simply goes to a person.

Embeddings come from Gemini using the `GEMINI_API_KEY` already configured for
photos and voice notes — one provider for everything. `EMBEDDING_DIM` must
match the `vector(768)` column in `migrations/001`.

### Tuning

`KNOWLEDGE_SIMILARITY_THRESHOLD` (default 0.85) is the knob that matters. Too
low and the bot answers the wrong question confidently; too high and Prateek
sir keeps being asked things he has already answered. Try real questions
against it without messaging anyone:

```
curl -s localhost:3010/api/kb/search -H "Authorization: Bearer $KNOWLEDGE_API_TOKEN" \
  -H 'content-type: application/json' -d '{"question":"Ye part wapas ho sakta hai?"}'
```

```json
{ "answered": true, "similarity": 0.93, "confidence": 0.94,
  "text": "Parts can be returned within 7 days if unused...",
  "entry": { "id": 4, "category": "returns", "scope": "global" } }
```

### Managing what it knows

All of these need `Authorization: Bearer $KNOWLEDGE_API_TOKEN`; with no token
configured they return 503 rather than standing open.

```
GET    /api/kb?status=pending_review     what is waiting for approval
POST   /api/kb                           add an answer by hand
POST   /api/kb/:id/approve               let the bot start using it
POST   /api/kb/:id/reject
PUT    /api/kb/:id                       edit (re-embeds automatically)
POST   /api/kb/:id/archive
GET    /api/kb/analytics                 most-asked unanswered questions
GET    /api/escalations?status=pending
POST   /api/escalations/:id/answer       answer from the console, and learn
```

Corrections are handled for you: answering a question the bot already knows
differently **archives** the old entry and replaces it, so two conflicting
answers are never live at once.

## Learning from exported chat history

Years of WhatsApp exports tell us what a dealer *calls* a part and which part
number our people gave them. They do **not** tell us what is in stock or what
it costs — those are read from the portal on every question, every time.

```
npm run import:whatsapp-history -- ./chats/*.zip     parse, verify, store
npm run import:whatsapp-history -- --apply           make approved mappings live
```

Importing the same ZIP twice does nothing: the file's sha256 is unique, and
inside it each example is keyed by a content hash.

What the pipeline keeps, and what it throws away:

| From the chat | Kept as | Why |
|---|---|---|
| `5pcs petrol filter 15410M72R00` | alias `petrol filter` → `15410M72R00` | the dealer's own wording, spelling included |
| `"CTWB 18 milega?"` | example: intent `CHECK_STOCK`, part `CTWB18` | tells us what the question means |
| `"4 pcs hai stock me"` | pattern `"{qty} pcs hai stock me"` | June's stock is not today's |
| `"aapko 12 percent discount"` | example scoped to **that dealer** | never another customer's answer |

A mapping becomes an alias only when **nothing competes with it and the dealer
portal confirms the part exists**. `"air filter"` pointed at three different
part numbers across the exports and stays in review, because an alias either
way would be wrong for two cars out of three.

```
GET  /api/history/imports          what has been imported
GET  /api/history/mappings?status=pending_review
GET  /api/history/examples?intent=CHECK_STOCK
POST /api/history/mappings/:id/approve
POST /api/history/mappings/apply   write approved mappings into the alias store
POST /api/history/similar          what history makes of a question (no answer)
```

Result of the first import (16 dealer exports, 23 Sep): 2,922 messages →
392 examples, 120 part mappings, 104 confirmed by the portal, **50 applied**,
70 held for review.

## When Prateek sir gets a message

Only when the data cannot be got any other way. In order:

1. **Already learned?** the alias/family store, then the knowledge base
2. **The dealer portal** — for a part question the catalogue is searched by
   name one last time. A single confident hit answers the customer and the
   phrase is learned, so nobody is disturbed
3. **Already asked?** the same part question already waiting on an answer does
   not go a second time. The second customer is recorded as waiting and gets
   the same answer the moment it arrives
4. Otherwise he is asked

Ambiguous portal results (several matches) and an unreachable portal both
count as "cannot fetch" and do reach him — silence is not an answer. Voice
notes and documents are never deduplicated: every recording is its own
question even though they all carry the label "voice note".

Answering: swipe-reply on his phone, or `#72 <answer>`. A business answer is
also accepted with no swipe-reply when exactly one such question is open —
but never when two are, and never for chatter like "ok dekh lunga".

### Tests

```
npm run test:kb                                  offline (stand-in database)
DATABASE_URL=postgres://... npm run test:kb      against real Postgres
npm run test:escalation                          when a person gets asked
```

The offline run covers the retrieval rules, the scope boundary, duplicate
detection, corrections and the no-invention guards. It does **not** prove the
SQL is valid Postgres — that needs the second form, with the migrations
applied.

node scripts/import_closing_stock.js "D:\Downloads\ClosingStock.csv"

# for checking log
ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "cd ~/cartrends-autoflow && sudo docker compose logs -f --tail 50 autoflow"

# restart
ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "cd ~/cartrends-autoflow && sudo docker compose restart"

# checking working of bot (upto 2h means good)

ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "sudo docker ps --filter name=cartrends-autoflow"

# deploy

ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "cd ~/cartrends-autoflow && sudo docker compose up -d --build"
