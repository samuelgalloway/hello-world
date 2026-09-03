# Expense Capture App

Capture receipts as they happen — photo, voice, or manual entry — normalize
them into one consistent record, review/confirm them, and export a file for
Concur (or a personal-tax log) without a slow manual entry process.

This is a v1 build covering **Build Order steps 1–2** from the project spec:
schema + manual/voice capture + file export, plus photo capture with vision
extraction. Email ingestion, cross-route dedup polish beyond the basic
matcher, the Google Drive personal-tax log, and the Concur API adapter are
not built yet (see "Not built yet" below).

## Architecture

Three decoupled stages, so later work (email ingestion, a real Concur API
adapter) slots in without touching what already works:

1. **Capture** (`src/routes/capture.ts`) — photo, voice, and manual entry
   all land here.
2. **Normalize** (`src/normalize.ts`) — every capture becomes the same
   `ExpenseRecord` shape (`src/types.ts`), with dedup and `receipt_required`
   computed the same way regardless of source.
3. **Deliver** (`src/routes/export.ts`) — CSV/JSON export per route
   (`concur` / `personal_tax`); a direct Concur API push can replace this
   later without touching capture or normalize.

The **shared parser** (`src/claude.ts` → `parseExpenseText`) is one function
called from three places: initial voice capture, a follow-up note attached
to an existing record, and a voice/typed field edit in the review queue —
per the spec, not three separate parsers. Photo capture uses a sibling
function, `parseReceiptImage`, that feeds the *same* structured-output tool
schema, so both capture paths normalize identically downstream.

## Setup

```bash
npm install
cp .env.example .env   # then edit .env and add your ANTHROPIC_API_KEY
npm run dev             # http://localhost:3000
```

`npm run build && npm start` runs the compiled version.

### API key security

- The key lives only in `.env`, which is **git-ignored** — it is never
  committed and never leaves this repo checkout.
- It is read once, server-side, in `src/claude.ts` via
  `process.env.ANTHROPIC_API_KEY`. No other file touches it.
- The frontend (`public/`) is plain static HTML/JS with no build/bundle
  step, so there is no mechanism by which the key could end up in code
  shipped to the browser. The browser only ever talks to this server's own
  `/api/*` routes.
- No route echoes the key back in a response, and `GET /api/health` only
  reports whether a key is *configured* (`true`/`false`), never its value.
- If you deploy this beyond your own machine, keep `.env` off the deployed
  filesystem's public directory and out of any container image layer that
  gets pushed somewhere shared — treat it exactly like a database password.

## Using it

- **Capture** (`/`) — take a photo of a receipt, hold the voice button and
  describe the expense ("lunch with Nathan, $32.59, Winking Lizard"), or
  fill in the manual form. Voice transcription runs in the browser
  (Chrome/Edge's SpeechRecognition); Firefox/Safari fall back to
  manual/typed entry.
- **Review** (`/review.html`) — everything `captured` or flagged
  `needs_review`. Edit any field by typing, or tap "Talk to edit" and say
  what changed ("actually this was $45, and it's personal") — routed
  through the same shared parser. Confirm when it looks right.
- **Status** (`/status.html`) — counts by status, recent activity, and
  export buttons. Exporting marks those records `exported` and downloads a
  CSV or JSON file scoped to one route (`concur` or `personal_tax`) — the
  file Claude Cowork or a human uses to fill out the Concur UI, or your
  personal-tax record.

## Data model

See `src/types.ts` for the full `ExpenseRecord` shape — it mirrors the
schema table in the spec, including the hotel-only `stay_start_date` /
`stay_end_date` fields (populated only when `category = hotel`).

- `receipt_required` is derived: `false` only when `category = meals` and
  `amount < 50`.
- `dedup_key` is a hash of `date + normalized vendor + amount`, checked
  across **both** routes on every insert/edit (`src/normalize.ts`), so the
  same receipt can't land in both the Concur and personal-tax lists.
- Route defaults to `concur`; the shared parser flips it to `personal_tax`
  only on an explicit cue in the text ("personal expense", "for my taxes",
  "not reimbursable", etc. — see the tool description in `src/claude.ts`).
  It can also be changed by hand in the review queue.

## Storage

SQLite (`data/expenses.db`, git-ignored) via `better-sqlite3` — no external
DB to stand up. Uploaded photos and voice notes are saved under
`data/uploads/` (also git-ignored) and served at `/uploads/...`.

## Not built yet

Per the spec's suggested build order, these are follow-on work:

3. Email ingestion (forwarding inbox + IMAP parser).
4. Duplicate detection is implemented as an exact-match hash; fuzzier
   matching (near-identical amounts/vendor spelling) is not yet handled.
5. Personal-tax route currently exports to a downloadable file rather than
   writing directly to Google Drive.
6. Concur API adapter — `src/routes/export.ts` is the seam where a direct
   API push would replace the file download, once IT provides credentials.

Also open, per the spec's "Open Items" section: exact cue phrases for
routing to `personal_tax` (a first pass is in `src/claude.ts`, easy to
tune), Concur category/policy flagging, trip-level grouping, and
international currency/tip handling.
