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
- Stock list ingestion from vendor replies (line parser + optional Claude for messy/Hinglish lists)
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
- **Photo orders** (✅ tested end-to-end, 26 Aug 2026): customer sends the
  order as a photograph → OCR reads it into order lines and the normal
  draft/confirm flow continues. Measured: photo → parsed lines in ~1 second.

  **The chain, in order (first hit wins):**
  1. Python OCR libraries (`scripts/ocr/read_order.py` — `pytesseract` or
     `easyocr`, both optional; exits silently when not installed)
  2. **Windows built-in OCR** (`scripts/ocr/windows_ocr.ps1`) — the WinRT
     `Windows.Media.Ocr` engine that ships inside Windows 10/11. **Zero
     installs, zero API keys, works offline.** This is the engine that runs
     in practice; verified reading printed order text correctly.
  3. Claude vision — only if `ANTHROPIC_API_KEY` is set, and only for photos
     the OCR engines could not read at all (e.g. handwriting).

  **After OCR, the same deterministic line parser as typed orders** handles
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
  handwriting poorly — handwritten photos generally need the optional
  `ANTHROPIC_API_KEY` (Claude vision) to work.

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
8. Optional: `ANTHROPIC_API_KEY` for AI parsing of free-form/Hinglish messages

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

node scripts/import_closing_stock.js "D:\Downloads\ClosingStock.csv"

# for checking log
ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "cd ~/cartrends-autoflow && sudo docker compose logs -f --tail 50 autoflow"

# restart
ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "cd ~/cartrends-autoflow && sudo docker compose restart"

# checking working of bot (upto 2h means good)

ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "sudo docker ps --filter name=cartrends-autoflow"

# deploy

ssh -i ~/.ssh/CT_EC2_key.pem ubuntu@52.66.83.8 "cd ~/cartrends-autoflow && sudo docker compose up -d --build"
