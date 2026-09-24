# Muse Nexus Witness — v1 build spec

This is the shared contract for the v1 build. Every component builds against it.
If you must deviate, change this file in the same commit and say why.

## 1. What it is

**Muse Nexus Witness** ("Witness") quietly keeps the real things people say and do
for you: the kind text, the thank-you email, the photo with someone who loves you.
It then brings one back on the rhythm you chose while you were doing well. When your
mind tells you a story that isn't true, Witness has the receipts, in the other
person's exact words.

It is built for people who, at their lowest, will not open an app. So:

1. **Setup is once.** Connect sources once. After that, nothing requires action.
2. **Capture is automatic.** Email (forwarding), texts (Mac helper / iPhone
   Shortcut), photos and screenshots, and AI assistants all feed one store.
3. **Saving is automatic.** A transparent detector saves clear evidence and puts
   uncertain finds in a "maybe" pile nobody has to look at. Removing is one tap.
4. **It comes to you.** A scheduled email (the "rhythm") delivers one piece of
   evidence. AI agents connected over MCP can *offer* evidence and reveal it only
   after an explicit yes ("ask-first").
5. **One store.** A single hosted core (Cloudflare Worker + D1 + R2) is the source
   of truth. Muse Nexus plans to run a hosted instance (not deployed yet); anyone
   can self-host with `wrangler deploy`.

## 2. Non-negotiable principles (see docs/SAFETY.md)

- **Verbatim only.** Store and show the other person's exact words. Never
  paraphrase, summarize, generate, or "improve" evidence. Models may only
  *classify* and *select a verbatim span*; code verifies the span is an exact
  substring. Unknown dates/names stay unknown.
- **Never argue with pain.** No "look how lucky you are", no worth scores, streaks,
  guilt, urgency, cheerleading, or exclamation marks in product copy.
- **Reach out only by consent.** Two ways only: (a) the rhythm the person set
  up, (b) an agent *offer* the person explicitly accepts. Never triggered by
  inferred mood or detected distress. Witness never messages anyone else.
- **Crisis first.** Witness is not treatment. Every delivery and the app footer
  include a crisis line (US: call or text 988; elsewhere findahelpline.com).
  Agent tool descriptions tell agents to prioritize crisis resources and not
  offer evidence to someone in acute crisis.
- **Never an empty-handed message.** If there is nothing to deliver, send nothing.
  Never tell someone they have "no proof".
- **Other people's words:** keep only the evidence snippet (never whole threads),
  support "never save from this sender", delete on request.
- **Privacy:** evidence text and media are encrypted at rest with a per-user key.
  No analytics on content, no ads, no selling data, no training on user data.
  Export and delete-everything are always available.
- **Synthetic data only** in code, tests, fixtures, docs, screenshots and issues.

## 3. Repository layout

```
apps/core/        Cloudflare Worker: REST API, MCP, inbound email, cron delivery, serves apps/web/dist
apps/web/         React 19 + Vite web app (landing, sign-in, setup, gallery, settings)
apps/mac/         Swift package: Witness for Mac (Messages + Photos collector) — M1 = core library + CLI
packages/detector TypeScript "is this evidence?" detector + lexicon.json (shared with Swift) + corpus
docs/             User docs (guides/), safety, privacy, self-hosting; docs/dev/ for contributors
legacy/           README pointing to Proof Gallery v0 in git history (commit 547e99d). No code.
```

Package manager: bun 1.2.23 workspaces. TypeScript ^6, vitest 4.1.8, vite 8.0.16,
React 19.2.8. Do not add dependencies casually; if you must, add them to the
workspace package.json and commit the updated `bun.lock` (CI installs with
`--frozen-lockfile`).

## 4. Brand (Muse Nexus)

Heavily branded Muse Nexus. Match https://musenexus.studio.

- Name: **Muse Nexus Witness**. Wordmark: small tracked-caps eyebrow `MUSE NEXUS`
  over `Witness` set in Fraunces, followed by a coral period: `Witness.`
  (echoes the studio's `Muse Nexus.` mark).
- Tagline: **A witness to your life.**
- Sub-line: *Witness quietly keeps the real things people say and do for you, and
  brings one back on the days you choose.*
- Palette (CSS custom properties; dark is the default, light supported):
  - `--ink` `oklch(0% 0 0)` (dark bg) · `--cream` `oklch(96.5% .016 90)` (≈ #F7F2E8, text on dark / bg in light)
  - `--coral` dark mode `oklch(71% .17 25)`, light mode `#ad4238`; `--coral-foreground` `#f7f0e3` (light) / `oklch(8% 0 0)` (dark)
  - accents: `--lavender oklch(78% .07 300)`, `--mist oklch(87% .025 240)`, `--moss oklch(58% .06 145)`,
    `--seafoam oklch(82% .07 185)` (light `#27665c`), `--teal oklch(60% .07 185)`
  - hairlines: `color-mix(in oklab, var(--cream) 14%, transparent)`
- Type: **Fraunces** (display, and all quoted evidence in italic, opsz), **Inter**
  (UI, 400/500/600). Google Fonts:
  `https://fonts.googleapis.com/css2?family=Fraunces:opsz,ital,wght@9..144,0,400;9..144,0,500;9..144,1,400&family=Inter:wght@400;500;600&display=swap`
- Motifs: coral block cursor `▍` before section eyebrows; hairline rules; generous
  black space; evidence quotes large in Fraunces italic with a coral opening mark.
- Voice: calm, plain, warm, second person, short sentences. No exclamation marks,
  no therapy-speak, no "you've got this". Footer: "Made by Muse Nexus in Hawaiʻi ·
  Open source (MIT)".

## 5. Data model (D1, `apps/core/migrations/0001_init.sql`)

All timestamps are integer milliseconds since epoch (UTC). IDs are random
URL-safe strings (`crypto.randomUUID()` is fine). `*_ct` columns hold ciphertext
strings (see §7).

```sql
users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT,
      inbound_slug TEXT NOT NULL UNIQUE, timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at INTEGER NOT NULL)
user_addresses(user_id TEXT, address TEXT, verified_at INTEGER, PRIMARY KEY(user_id,address))
  -- envelope senders allowed to deliver inbound mail for this user (account email + added ones)
magic_links(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)
sessions(id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER)
tokens(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT CHECK(kind IN ('agent','device')),
       label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, -- JSON array
       created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER)
items(id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('saved','maybe','removed')),
      kind TEXT NOT NULL CHECK(kind IN ('text','image','mixed')),
      quote_ct TEXT, context_ct TEXT, from_name_ct TEXT,
      occurred_at INTEGER, source_type TEXT NOT NULL
        CHECK(source_type IN ('email','text','photo','screenshot','manual','agent','import')),
      source_label TEXT NOT NULL, dedupe_key TEXT NOT NULL,
      sender_key TEXT,  -- HMAC of normalized sender handle, for "never save from"; never plaintext
      category TEXT NOT NULL, score REAL, reasons TEXT, -- JSON [{rule,weight}] (no text)
      media_key TEXT, media_type TEXT, edited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_delivered_at INTEGER, delivered_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, dedupe_key))
blocked_senders(user_id TEXT, sender_key TEXT, created_at INTEGER, PRIMARY KEY(user_id, sender_key))
rhythms(user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, channel TEXT NOT NULL DEFAULT 'email',
        local_time TEXT NOT NULL DEFAULT '08:30', days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri,sat,sun',
        timezone TEXT NOT NULL DEFAULT 'UTC', paused_until INTEGER, skip_next INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER, consented_at INTEGER, updated_at INTEGER)
deliveries(id TEXT PRIMARY KEY, user_id TEXT, item_id TEXT, channel TEXT, sent_at INTEGER,
           status TEXT, feedback TEXT)
offers(id TEXT PRIMARY KEY, user_id TEXT, token_id TEXT, item_id TEXT, created_at INTEGER,
       expires_at INTEGER, revealed_at INTEGER)
inbound_events(id TEXT PRIMARY KEY, user_id TEXT, received_at INTEGER, source_type TEXT,
               outcome TEXT CHECK(outcome IN ('saved','maybe','excluded','duplicate','confirmation','rejected')),
               reason TEXT) -- NO content, for status only
pending_confirmations(user_id TEXT, provider TEXT, url_ct TEXT, code_ct TEXT, received_at INTEGER,
                      PRIMARY KEY(user_id, provider))
```

Categories (shared by detector, core, web): `love`, `care`, `pride`, `gratitude`,
`trust` (chosen/hired/relied on), `belonging`, `accomplishment`, `recovery`, `other`.
Display names: Love · Care · Pride · Gratitude · Trusted · Belonging · Accomplishment · Recovery · Other.

`dedupe_key` = hex SHA-256 of `source_type + ":" + (source_ref || normalizedText)`
where `normalizedText` = lowercase, collapse whitespace, trim.
As built (migration `0003`): core stores it keyed instead, hex HMAC-SHA256(HKDF(master,
info="witness:dedupe:v1"), user_id + ":" + source_type + ":" + (source_ref || normalizedText)),
so a database copy without the master key cannot confirm guessed messages and the same
words differ per person; captures also match the older plain form. `items.text_key` is
the same keyed hash over `normalizedText` alone (null for image-only items): a capture
counts as a duplicate when an item with the same `text_key`, dated within 48 hours, came
by the other kind of path (one with a `sourceRef`, one without), so the Mac helper and
the iPhone Shortcut never keep one message twice, while two messages that each carry
their own id stay two.

As built (core): one additive table, `rate_limits(key TEXT PRIMARY KEY, window_start
INTEGER, count INTEGER)`, holds fixed-window counters (keys are hashes, never emails
or IPs). Image-only captures without a `sourceRef` dedupe on `"image:" + sha256(bytes)`.
Indexes: see the migration. `0002_blocked_sender_label.sql` adds
`blocked_senders.label_ct` (encrypted display name for "Allow again").
`0005_delivery_claim.sql` adds `rhythms.delivery_claim` and `rhythms.delivery_claim_until`
(one delivery email at a time per person, §8 "Delivery"). `0006_media_cleanup.sql` adds
`media_cleanup(prefix TEXT PRIMARY KEY, created_at INTEGER)`: R2 prefixes (`u/<user_id>/`)
of deleted accounts that the cron still sweeps (§8 "Removing").

## 6. Detector (`packages/detector`)

Pure TypeScript, no platform APIs except `crypto.subtle` where needed. Deterministic
and synchronous for rules; async only for the optional model stage.

```ts
export type Category = 'love'|'care'|'pride'|'gratitude'|'trust'|'belonging'|'accomplishment'|'recovery'|'other';
export type Channel = 'email'|'text'|'ocr'|'manual'|'agent';
export interface Candidate {
  text: string;                 // the message body (already stripped of quoted replies/signatures for email)
  subject?: string;
  channel: Channel;
  from?: { name?: string; handle?: string; isMe?: boolean };
  headers?: Record<string, string>;   // lowercased header names (email)
  threadKind?: 'direct'|'group';
  occurredAt?: number;
}
export type Caveat = 'possible_sarcasm'|'negated'|'boilerplate'|'apology'|'group_message'|'not_directed'|'transactional'|'rejection';
export interface Verdict {
  decision: 'save'|'maybe'|'exclude';
  score: number;                // 0..1
  category: Category;
  quote: string;                // verbatim substring of candidate.text: the best evidence span (sentence(s))
  quoteStart: number; quoteEnd: number;
  reasons: { rule: string; weight: number; start?: number; end?: number }[];
  caveats: Caveat[];
  excludedBy?: string;          // rule id when decision === 'exclude'
  engine: 'rules'|'rules+model';
}
export function detect(c: Candidate, lexicon?: Lexicon): Verdict;   // Lexicon = loadLexicon(json); default = bundled lexicon.json
export interface ModelJudge {
  judge(input: { text: string; subject?: string; channel: Channel; fromName?: string }): Promise<{
    isEvidence: boolean; directedAtRecipient: boolean; category: Category;
    quote: string; confidence: number; // 0..1
  } | null>;                            // null (or a throw) = no judgement; the rules verdict stands
}
export function detectWithModel(c: Candidate, judge: ModelJudge | null, lexicon?: Lexicon): Promise<Verdict>;
export function anthropicJudge(opts: { apiKey: string; model?: string; baseURL?: string;
  timeoutMs?: number; maxRetries?: number; fetch?: typeof fetch }): ModelJudge; // default model 'claude-haiku-4-5'
export function extractEmailEvidence(raw: { text?: string; html?: string; subject?: string;
  from?: { name?: string; address?: string }; date?: string; headers: Record<string,string> }):
  { text: string; subject?: string; from?: { name?: string; handle?: string }; occurredAt?: number;
    forwarded: boolean; headers: Record<string,string> };
export function normalizeForDedupe(text: string): string;
export const CATEGORY_LABELS: Record<Category, string>;
// Also exported: loadLexicon, validateLexicon, defaultLexicon, prefilter (reference for the
// Swift prefilter), gmailFilterQuery, cueTerms, dedupeKey (SPEC §5), exclusionFor, decide,
// MAX_TEXT_CHARS (20,000: the most text read from one message, see §8), MAX_JUDGE_TEXT.
// extractEmailEvidence also returns `truncated: true` when an HTML-only body ran past MAX_HTML_CHARS.
```

Stages:
1. **Hard exclusions** (decision `exclude`): from-me; OTP/verification codes;
   short-code/business senders (numeric handle ≤ 6 digits, `urn:biz`);
   `list-unsubscribe`, `list-id`, `precedence: bulk|list|junk`, `auto-submitted` ≠ `no`;
   noreply/notifications/billing/receipts/support senders; receipts/orders/invoices/
   shipping; newsletters/marketing; calendar invitations; job-board/recruiter spam.
2. **Lexicon scorer** driven by `packages/detector/lexicon.json` (data, not code, so
   Swift can reuse it): weighted phrase lists per category (gratitude, praise/pride,
   love, care, trust/chosen/hired/recommended/invited, congratulations, impact
   "because of you"/"you helped"/"made my day", belonging, recovery), boosters
   (second-person targeting, direct thread, emoji hearts), dampeners and caveats
   (negation window, boilerplate thanks "thanks in advance"/"thank you for your
   order", rejection "unfortunately"/"not moving forward", apology-for-hurt → maybe,
   sarcasm markers → caveat). Selects the best verbatim evidence span (1–3 sentences
   around the strongest matches, never cutting a negation away).
3. **Optional model judge** for borderline scores only (0.35–0.75). Accept `save`
   only if `isEvidence && directedAtRecipient && confidence ≥ 0.8` and the returned
   quote is an exact substring of the text (otherwise keep the rules span). A model
   never downgrades a rules `exclude` to save. Model errors → rules verdict.
   As built: only `maybe` verdicts with 0.35 ≤ score < 0.75 and no `apology`,
   `rejection`, `transactional` or `possible_sarcasm` caveat are sent (those are
   policy, not reading comprehension), and only for text of at most `MAX_JUDGE_TEXT`
   (6,000) characters, the most the judge is shown; a longer message keeps the rules
   verdict rather than being judged on its start. The model only promotes maybe → save; it
   never demotes. A quote that is not an exact substring rejects the whole model
   answer (the rules verdict, span included, stands).

`lexicon.json` schema (v1; regexes must be portable to Swift `NSRegularExpression`
and JS — no lookbehind, no named groups; matching is case-insensitive):

```json
{
  "version": 1,
  "language": "en",
  "categories": {
    "gratitude": { "phrases": [ { "p": "thank you so much", "w": 0.55 } ], "patterns": [ { "id": "couldnt_without_you", "re": "couldn'?t have (done|made) it without you", "w": 0.7 } ] }
  },
  "boosters":   [ { "id": "second_person", "re": "\\byou(r|rs|'re|'ve)?\\b", "w": 0.1 } ],
  "dampeners":  { "negation": ["not", "never", "no longer"], "negationWindow": 3,
                  "boilerplate": [ { "id": "thanks_in_advance", "re": "thanks? in advance" } ],
                  "rejection": [], "apology": [], "sarcasm": [], "transactional": [] },
  "exclusions": { "senderPatterns": [ { "id": "noreply", "re": "no-?reply|notifications?@" } ],
                  "subjectPatterns": [], "bodyPatterns": [ { "id": "otp", "re": "\\b(code|otp|passcode)\\b.{0,20}\\b\\d{4,8}\\b" } ],
                  "headers": { "list-unsubscribe": "*", "list-id": "*", "precedence": ["bulk", "list", "junk"] } },
  "gmailFilterTerms": ["\"thank you\"", "\"proud of you\"", "congrats"]
}
```

Consumers: TS detector (full scoring), Swift Mac prefilter (exclusions + "any
category phrase/pattern matches" → send to server), web/core (`gmailFilterQuery()`
builds the Gmail filter string from `gmailFilterTerms`). As built, the web app imports
`gmailFilterQuery`, `gmailFilterTerms` and `plainCues` from the narrow subpath
`@witness/detector/gmail`, which reads only that list from lexicon.json (no compiled
lexicon, no model code), so there is one source of cue terms and the browser bundle
stays small. Document the schema in
`packages/detector/LEXICON.md` so contributors can tune it without code.

Schema additions made while building v1 (all additive; consumers that only need
exclusions and "any cue" can ignore them; full reference in LEXICON.md):
- `secondPerson`: regex for "you/your/u…", used to decide whether a cue is aimed at the reader.
- `implicit: true` on a phrase or pattern: addressed to the reader without saying
  "you" ("congrats", "thanks"). Other cues need a "you" in their sentence or get the
  `not_directed` caveat.
- `dampeners.negationExceptions` (phrases that start with a negation word but do not
  negate: "can't believe", "not gonna lie") and `dampeners.notDirected` (praise aimed
  at someone else: "congrats to Priya", "proud of my son").
- `exclusions.headers` values: `"*"` (present), a list (value is one of), or
  `{"not": [...]}` (value is anything else, used for `auto-submitted` ≠ `no`).
- Optional `context` scoring knobs (direct-thread boost, group factor, undirected
  factor, support factor, booster cap, subject factor) with defaults in code.
- Matching folds curly apostrophes/quotes to ASCII first; phrases match whole words,
  any whitespace, optional apostrophes. The validator rejects non-portable regex
  (lookbehind, named groups, inline flags, possessive/atomic, `\p{}`, emoji inside `[]`)
  and unbounded repetition of a group (`(so |really )*`), which backtracks
  quadratically on long messages; use `{0,4}`.
- A kept verdict always has a non-empty quote; evidence found only in an email
  subject over an empty body is excluded (`excludedBy: 'no_quote'`).

Stage 1 as built also excludes SMS alphanumeric sender ids (text channel, handle
with letters and no `@`), and never excludes `channel: 'manual'` (the person chose it).
In a pasted chat, lines starting `You:`/`Me:` are the owner's words and never count.

Thresholds (rules): `save` if score ≥ 0.75 and no caveat in {possible_sarcasm,
negated, apology, rejection, transactional, not_directed}; `maybe` if score ≥ 0.35
or any of those blocking caveats with score ≥ 0.25; else `exclude`. `boilerplate`
and `group_message` are informational (they never force maybe, or every "thanks" in a
group chat would land there). Caveats are raised only when some evidence survives
dampening: a message whose only cues were negated, boilerplate or transactional is
excluded, with the reason recorded. **Precision over recall for auto-save.**

Corpus: `packages/detector/corpus/*.jsonl`, ≥ 200 synthetic labeled examples
(`{id, text, html?, subject?, channel, from?, headers?, threadKind?, expect: 'save'|'maybe'|'exclude', category?, hard?, note?}`;
email examples go through `extractEmailEvidence` first, `html` is an email HTML body)
including hard negatives (`hard: true`). Test gates: save-precision ≥ 0.97, (save ∪ maybe)-recall on
positives ≥ 0.9, zero hard-negative saves. `corpus/holdout.jsonl` is written before
tuning and never tuned on; its gate is save-precision ≥ 0.95 (plus the same recall
and hard-negative gates). Names/handles in the corpus are fictional.

Model default `claude-haiku-4-5`, chosen for low cost (~$1/M input, $5/M output ⇒
roughly $1/month per active user at ~30 borderline items/day).
Configurable via `WITNESS_MODEL`; `WITNESS_JUDGE=none|anthropic` (default `none`
when no `ANTHROPIC_API_KEY`). Use the official `@anthropic-ai/sdk` with a JSON
schema output (structured outputs) and a short, cached system prompt that states:
classify only, return an exact substring, never write new words.
As built: `messages.create` with `output_config.format` (json_schema), `max_tokens:
400`, no extended thinking, stop reasons other than `end_turn` (refusal, truncation)
→ null. The system prompt carries `cache_control`, but Haiku 4.5 only caches
prefixes of 4096+ tokens, so this short prompt is not actually cached on the default
model; it is cheap either way (a few hundred tokens per call).

## 7. Crypto

- Secret `WITNESS_MASTER_KEY`: 32 random bytes, base64.
- Per-user data key: HKDF-SHA256(master, salt = utf8(user_id), info = "witness:data:v1") → AES-GCM-256.
- Ciphertext string format: `v1.<base64url iv 12B>.<base64url ciphertext+tag>`.
- Media in R2 encrypted with the same per-user key (whole-object AES-GCM), key
  `u/<user_id>/<item_id>`; `media_type` stored in D1.
- Sender key: HMAC-SHA256(HKDF(master, info="witness:sender:v1"), user_id + ":" + normalizedHandle) hex.
- Tokens (session, magic link, API): random 32 bytes base64url, prefixed
  `wit_sess_`, `wit_link_`, `wit_agent_`, `wit_dev_`; store SHA-256 hex only.
- Signed delivery-action links: HMAC(HKDF(master, info="witness:link:v1"),
  `deliveryId.action.exp`), 14-day expiry.

As built (core, `apps/core/src/crypto.ts`): HKDF for the sender and link keys uses an
empty salt. The media object body is `iv (12 B) || ciphertext+tag`. Handles are
normalized before the sender HMAC: trimmed, lowercased, `mailto:`/`tel:` dropped;
phone numbers keep digits with a leading `+` (10 digits → `+1…`). A delivery link is
`/d?t=<deliveryId>.<action>.<exp>.<base64url mac>` with `exp` in epoch ms and `action` one
of `keep|skip|pause|remove|stop|block`. The token is in the query string (Workers Logs
redact query strings; a path is logged as is), and the confirm page posts it back as the
form field `t`. `stop` and `pause` links last 365 days so an old email can always stop or
pause; the others last 14. `/d/<token>` (the old path form) only answers "This link does
not work". Signed media URLs reuse the link key:
`/api/v1/items/:id/media?sig=<exp>.<mac of "itemId.media.exp">` (7 days in emails,
1 hour from MCP reveals).

## 8. Core API (`apps/core`)

Hono on Workers. Bindings (`wrangler.jsonc`): `DB` (D1 `witness`), `MEDIA` (R2
`witness-media`), `ASSETS` (apps/web/dist, SPA fallback), `EMAIL` (send_email
binding, optional). Vars: `APP_URL`, `INBOUND_DOMAIN`, `INBOUND_ADDRESS_STYLE`,
`INBOUND_PLUS_USER`, `MAIL_FROM`,
`MAILER` (`cloudflare`|`resend`|`log`), `SIGNUPS` (`open`|`invite`),
`ALLOWED_EMAILS` (comma list; used when `invite`), `WITNESS_JUDGE`, `WITNESS_MODEL`.
Secrets: `WITNESS_MASTER_KEY`, `RESEND_API_KEY?`, `ANTHROPIC_API_KEY?`.
Cron: `*/15 * * * *`.

Auth: session cookie `wit_session` (HttpOnly, Secure, SameSite=Lax, 30 days) for the
web app; `Authorization: Bearer wit_agent_…|wit_dev_…` for agents/devices. Mutating
cookie-auth requests must carry header `X-Witness-CSRF: 1` and a same-origin
`Origin`. Rate-limit auth/start (per IP+email, D1-backed counter is fine).

All JSON errors: `{ "error": { "code": string, "message": string } }`.

| Method & path | Auth | Purpose |
|---|---|---|
| POST `/api/v1/auth/start` `{email}` | none | Send magic link (always 200; don't leak existence) |
| GET `/auth/callback?token=` | none | Consume link, create user on first sign-in, set cookie, redirect `/app` (first sign-in → `/app/setup`) |
| POST `/api/v1/auth/logout` | session | |
| GET `/api/v1/me` | session | `{email, displayName, timezone, inboundAddress, createdAt}` |
| PATCH `/api/v1/me` | session | `{displayName?, timezone?}` |
| GET `/api/v1/status` | session, agent(status) or device(status) | `{saved, maybe, lastCapturedAt, sources:[{type, lastAt, count7d}], rhythm:{enabled, nextAt, pausedUntil}}` — counts only |
| GET `/api/v1/items?status=saved\|maybe&cursor=&limit=&q=` | session | Decrypted items, newest first |
| POST `/api/v1/items` | session | Manual add → always `saved` |
| PATCH `/api/v1/items/:id` | session | `{status?, category?, fromName?, occurredAt?, quote?}` (quote edit sets `edited=1`) |
| DELETE `/api/v1/items/:id` | session | Hard delete + media |
| POST `/api/v1/items/:id/block-sender` | session | Adds sender to blocked_senders, removes item |
| GET `/api/v1/items/:id/media` | session or `?sig=` | Decrypted media stream |
| POST `/api/v1/capture` | device(capture) / agent(add) / session | Detector → saved/maybe/excluded (see below) |
| GET/PUT `/api/v1/rhythm` | session | `{enabled, localTime, days[], timezone, channel}`; enabling sets `consented_at` |
| POST `/api/v1/rhythm/pause` `{days}` · `/resume` · `/send-now` | session (pause also agent) | |
| GET/POST/DELETE `/api/v1/tokens[/:id]` | session | Create returns plaintext token once + ready-to-paste MCP configs |
| GET/POST/DELETE `/api/v1/addresses` | session | Allowed inbound envelope senders |
| GET `/api/v1/inbound/confirmations` | session | Latest detected forwarding confirmation (Gmail etc.) `{provider, url?, code?, receivedAt}` |
| GET `/api/v1/export` | session | JSON export (decrypted, media base64) |
| DELETE `/api/v1/account` | session | Delete everything (D1 rows + R2 objects) |
| GET/POST `/d?t=` | signed link | Delivery actions. **GET renders a confirm page; only POST mutates** (mail scanners prefetch links) |
| POST `/mcp` | agent bearer | MCP Streamable HTTP, stateless, JSON responses |
| `email()` | Email Routing | Inbound capture |
| `scheduled()` | cron | Rhythm delivery |

`POST /api/v1/capture` body:
```json
{ "sourceType": "text|email|photo|screenshot|agent|import|manual",
  "text": "…", "subject": "…", "fromName": "…", "fromHandle": "…",
  "occurredAt": 1727000000000, "sourceRef": "stable id from the source",
  "sourceLabel": "iMessage", "threadKind": "direct|group",
  "image": { "base64": "…", "mediaType": "image/jpeg" } }
```
Response: `{ "status": "saved|maybe|excluded|duplicate|blocked", "id"?, "category"?, "quote"? }`.
Excluded items store nothing but an `inbound_events` row. Images without text are
`maybe` unless sent by the session owner (manual) or tagged by a device source
the user marked trusted (v1: photo `favorites` from the Mac helper → saved). A photo
emailed in is always `maybe` (the sender is not authenticated).
Max image 10 MB; accept jpeg/png/webp/heic(stored as-is)/gif. As built, no client
re-encodes an image before upload either (the web app sends the file's own bytes, even
where the browser could decode HEIC): evidence is the original image. Display is handled
where it is shown: the web card offers "Download the original" when the browser cannot
draw it, and email never embeds HEIC (below).
Text limit (as built): `MAX_TEXT_CHARS` = 20,000 characters, exported by the detector and
used by every path. The capture API, a hand-added quote, a quote edit and `witness_add`
refuse longer text (`400`); inbound email whose evidence text (after extraction) is longer,
whose subject is over 500 characters, or whose HTML-only body ran past `MAX_HTML_CHARS`
(`EmailEvidence.truncated`) is excluded with reason `too_long`. Nothing is cut to fit: a
verdict made on the start of a message could keep words whose ending was never read.

### Inbound email

Address: `<inbound_slug>@<INBOUND_DOMAIN>` (slug: 10 lowercase letters+digits,
unguessable). As built, two styles (var `INBOUND_ADDRESS_STYLE`, default `plus`):
`plus` shows `<INBOUND_PLUS_USER>+<slug>@<INBOUND_DOMAIN>` (`INBOUND_PLUS_USER` defaults
to `witness`; needs one Email Routing rule for that mailbox with subaddressing on);
`local` shows `<slug>@<INBOUND_DOMAIN>` (needs the catch-all, which is not confirmed to
work on a subdomain). `email()` accepts both forms whatever the style (and a trailing
`+tag`), so switching never strands an address; `/me` and the export show the
configured one. Accept only if the SMTP envelope sender (`message.from`) is in
`user_addresses` (the account email is added at sign-up, verified) — otherwise
reject with `setReject("Unknown sender")` and log `rejected`. Exception: known
forwarding-confirmation senders (Gmail `forwarding-noreply@google.com`, Outlook,
iCloud) → parse the confirmation URL/code into `pending_confirmations` (encrypted).
Parse with `postal-mime`, run `extractEmailEvidence` (handles "Forwarded message"
blocks → original sender/date; strips quoted replies/signatures), then the detector.
`sourceRef` = original `Message-ID`. Label: "Email".

### Rhythm delivery (cron every 15 min)

For each rhythm with `enabled=1 AND next_run_at <= now` and not paused:
if `skip_next`, clear it and reschedule. Else pick one `saved` item:
1. an "on this day" item (same month/day, earlier year) not delivered in 300 days;
2. else never delivered, oldest first;
3. else least recently delivered, excluding any delivered in the last 30 days;
avoid the same category/sender as the previous delivery when possible.
**If nothing qualifies, send nothing.** Send the email, record `deliveries`,
update item counters and `next_run_at` (next matching local day/time in the
rhythm's IANA timezone; use `Intl.DateTimeFormat`, handle DST).

Email (HTML + plain text; subject never contains evidence, e.g. "Your witness for
Tuesday"): the exact quote large (Fraunces/Georgia italic), then
`— {fromName or "Someone"} · {Month D, YYYY or "Date unknown"} · {sourceLabel}`,
the image (signed 7-day URL) if any, then quiet links: *Keep them coming* ·
*Not today* (skip next) · *Pause a week* · *Remove this one* · *Open Witness*.
Footer: "You chose this rhythm on {date}. Change or stop it any time." and
"If you are in crisis, call or text 988 (US) or visit findahelpline.com." No other
commentary. Never add words that tell the person how to feel.

### As built (core)

Changes and additions made while building `apps/core` (details in `apps/core/README.md`):

- **Sign-in link.** `GET /auth/callback?token=` renders a page that submits itself
  to `POST /auth/callback` (form field `token`); only the POST uses the link, sets
  the cookie and redirects (303). Reason: mail scanners prefetch links, which would
  otherwise use the link up before the person clicks it. The POST refuses a
  cross-site `Origin`. Links last 15 minutes. `auth/start` sends in the background
  so timing does not reveal whether an account exists, and is limited to 5 per
  15 min per visitor+address, 30 per hour per visitor, and 5 per hour / 20 per day per
  address across all visitors (429 + `Retry-After`); IPv6 visitors are grouped by /64
  and counter keys are HMACs ("witness:ratelimit:v1"). `auth/start` also sets a
  15-minute pre-auth cookie `wit_pre` (path `/auth`) whose SHA-256 is kept on the link
  (`magic_links.nonce_hash`, migration `0004`). The callback page submits itself only in
  that browser; anywhere else it shows "Continue as a•••@example.com?" and the POST needs
  that click (`confirm=1`) or the cookie. An address that may not sign up logs a
  content-free `auth.signup_not_allowed` line.
- **Cookies** drop `Secure` only when `APP_URL` is plain-http localhost.
- **Response shapes.** `GET /items` → `{items, nextCursor}` (item: `id, status,
  kind, quote, context, fromName, occurredAt, sourceType, sourceLabel, category,
  categoryLabel, score, reasons, hasMedia, mediaType, mediaUrl, edited,
  canBlockSender, createdAt, updatedAt, lastDeliveredAt, deliveredCount`), sorted by
  `COALESCE(occurred_at, created_at)` desc; `q` is matched after decryption (up to
  2000 rows scanned per request). `POST /items` → `201` the created item (the same
  item shape); adding text that is already there by hand → `409 duplicate`. `PATCH
  /items/:id` → the updated item (`status` is `saved` or `maybe`; removing is `DELETE`).
  `send-now` → `{sent: true}` or `{sent: false, reason: 'nothing_qualifies'|'all_recent'|'send_failed'|'in_progress'}`
  (sends nothing when nothing qualifies; `nothing_qualifies` = nothing kept yet,
  `all_recent` = things are kept but each was sent recently or cannot be shown by email,
  `in_progress` = another delivery to this person is being sent at that moment).
  `GET /inbound/confirmations` → the object, or `null` when none has arrived. `GET/PUT
  /rhythm`, `pause` and `resume` all return the full rhythm, plus `skipNext`; `PUT`
  fields other than `enabled` are optional. `POST /tokens` → `201 {id, kind, label,
  scopes, createdAt, lastUsedAt, revokedAt, token, configs}` (`token` is the plaintext,
  shown once); `GET /tokens` → `{tokens: [...same without token/configs]}`. Assistant
  `configs` = `{claudeCode, codex, json, curl, mcpUrl, captureUrl}`; device `configs` =
  `{captureUrl}` plus `curl` when the token has `status`. Every `curl` is a read-only
  `GET /api/v1/status` check, so trying it never adds words to someone's Witness.
  Device tokens get scopes `capture` and `status` by default; the web app's phone key
  asks for `capture` only. `POST /addresses` → `201 {address, verifiedAt,
  isAccountEmail}`; `GET` → `{addresses: [...]}`.
- **Blocked senders.** `GET /api/v1/blocked-senders` → `{senders: [{senderKey,
  createdAt, label}]}`, `DELETE /api/v1/blocked-senders/:senderKey` → `{ok: true}` (404
  when not blocked). `label` is the display name from the item that was blocked, kept
  encrypted in `blocked_senders.label_ct` (migration `0002`); the handle is never
  stored. `POST /items/:id/block-sender` → `{ok, removed, removedIds}` so the web app
  can drop every card from that sender. The export lists blocked senders the same way.
  `POST /api/v1/blocked-senders {handle, label?}` blocks a phone number or address ahead of
  time: the handle is hashed at once (never stored), the label encrypted; → `201
  {senderKey, createdAt, label}`.
- **Capture.** Body adds `favorite` (device photos: saved without review) and `shared`
  (devices: the person sent this one on purpose, from the share sheet). Response adds
  `reason` (rule id) for `excluded`. Device and assistant tokens never get `duplicate`:
  they get the status (and category/quote) a first capture of the same words would get,
  without an `id`, and exclusions are decided before dedupe, so a capture-only key cannot
  test what is already kept. What an assistant adds, and what a device sends with
  `shared: true`, is person-chosen: if the detector would exclude it, it is kept whole in
  `maybe` instead. Assistant tokens always capture as
  `sourceType: agent`, labeled "{sourceLabel} · Added by {token label}"; devices may
  not send `manual` or `agent`; the session's `manual` is always saved. A photo whose
  text is not evidence becomes an image-only `maybe` instead of being excluded.
- **Block sender** removes every item already kept from that sender, not just one,
  unless the body is `{removeExisting: false}` (the web app's default choice, after a
  confirmation that names the sender and shows `GET /api/v1/items/:id/sender` →
  `{count, fromName}`). `POST /api/v1/me/inbound-address` gives a new inbound slug (the
  old address is rejected from then on) and answers the `/me` shape.
- **Addresses.** `DELETE /api/v1/addresses/:address` (a JSON body `{address}` also
  works); the account email cannot be removed. Envelope senders are compared after
  dropping `+tags` (and dots for Gmail), because Gmail auto-forwards as
  `you+caf_=…@gmail.com`.
- **Inbound.** A confirmation is recognised by the *envelope* sender's domain
  (google.com, microsoft.com/outlook.com/hotmail.com/live.com, apple.com/icloud.com)
  and a matching subject. Gmail's also needs the header From
  `forwarding-noreply@google.com` (google.com publishes DMARC p=reject, which Email
  Routing enforces), and only a link to `mail-settings.google.com`,
  `isolated.mail.google.com` or `mail.google.com` with a `/mail/vf-` path is kept.
  Outlook and iCloud send no confirmation link, so only a code is kept for them.
  `GET /inbound/confirmations?provider=` returns the newest one from the last 24 hours
  (optionally for one provider); older rows are pruned by the cron. Header From and
  envelope sender are not authenticated (ARCHITECTURE.md, trust boundary 3), so: mail
  counts as the person's own only when it is not an auto-forward (Gmail `+caf_`
  envelope, `X-Forwarded-To/For`), its header From is one of their addresses and
  matches the envelope sender; only then is a "Forwarded message" block followed.
  Mail the person writes themself is scored without a sender, and a photo attached to
  it is kept as an image item in `maybe`. In someone else's (auto-forwarded) mail a
  forwarded block is not followed: the outer sender is credited, the text stops at the
  block, and the item can be `maybe` at most. Auto-forwarded mail claiming to be from
  the person is excluded (`from_owner_unverified`). When Cloudflare's topmost
  `mx.cloudflare.net` (ARC-)Authentication-Results is present and shows neither SPF
  nor DKIM passing for the envelope domain, nothing from that message is saved without
  review. The raw `Date` header (not postal-mime's ISO string) gives the fallback zone
  for a forwarded date printed without one. Manual forwards dedupe on text (their
  Message-ID is new); auto-forwards on the original Message-ID. Mail carrying
  `X-Witness-Mail` (added to everything Witness sends) is ignored, so a filter
  cannot loop deliveries back in. Allowed mail is never bounced on an internal error.
- **Delivery.** Overlapping cron runs claim a rhythm with a compare-and-set on
  `next_run_at` before sending. Every send (cron and "Send one now") also claims the
  person's rhythm row (`delivery_claim`, `delivery_claim_until`, migration `0005`) in one
  conditional write before it picks an item, and lets go after recording the delivery, so
  two senders never pick and send the same thing at once; the one that finds a claim sends
  nothing (`in_progress`; a rhythm slot that meets a "Send one now" in flight counts as
  delivered). A claim left by a sender that died runs out after 2 minutes. A failed send is recorded and not retried until the
  next slot. "Send one now" says "You asked Witness to send this one." in place of
  the consent line. Preheaders are neutral ("From the rhythm you set in Witness."), and the
  plain-text part opens with a few neutral lines (and the crisis line) before the quote,
  so a preview built from text/plain never shows evidence. Delivery links: keep =
  feedback only; skip = `skip_next`; pause = 7 days; remove = the item and its image are
  deleted (as in the app); stop ("Stop these emails") = the rhythm is turned off; block
  ("Never save from them", only when the item has a sender key) = the sender is blocked
  and this item deleted, other items from them stay. Every delivery carries RFC 8058
  `List-Unsubscribe` (the stop link) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`;
  a POST with that body stops the rhythm without a confirm page (and is refused on any
  other link). An image-only delivery says "See it in Witness". Image-only HEIC items are
  never picked for email (most clients cannot show them); an item with words and a HEIC
  photo is emailed with the words and a "See the photo in Witness" link, never the HEIC.
  A pause, resume, or turning the rhythm off/on clears `skip_next`, and `nextAt` (rhythm
  and status) is the slot that will really be delivered (the one after a skipped slot). Saving the rhythm while a slot is
  due but not yet sent keeps that slot when the new schedule includes it.
- **Removing.** An image lives in R2 and its row in D1, which cannot change in one
  transaction, so every removal (Remove in the app, block sender, the delivery `remove` and
  `block` links, re-adding a removed item) deletes the images first and the rows after. If
  R2 fails, the rows are still there and the same removal can be tried again; it never
  leaves an image that nothing points at. `DELETE /api/v1/account` deletes the user's R2
  prefix, then every row in one batch that also writes a `media_cleanup` record, then
  sweeps the prefix once more for a capture that was under way. If R2 fails before the
  batch, nothing is deleted (try again); if it fails on the last sweep, the answer is still
  `{deleted: true}` and the cron sweeps the prefix every tick until a sweep succeeds at
  least an hour after the deletion, then drops the record.
- **Dev only:** `GET /api/v1/dev/outbox` exists when `MAILER=log` and `APP_URL` is
  localhost, and only answers requests to localhost. `MAILER=log` and a localhost
  `APP_URL` are local-only: every request to another host fails with a ConfigError
  (500), and the log mailer prints sign-in links only when local.

## 9. MCP (`POST /mcp`)

Stateless Streamable HTTP (JSON responses, no SSE required). Prefer the official
`@modelcontextprotocol/sdk` web-standard transport in stateless mode; a minimal
hand-rolled JSON-RPC implementation of `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`, `ping` is acceptable. Server name `muse-nexus-witness`.
Bearer `wit_agent_…` required; scope-checked per tool.

| Tool | Scope | Input | Returns |
|---|---|---|---|
| `witness_status` | status | — | counts, source health, rhythm (no content) |
| `witness_offer` | offer | — | `{offerId, available, suggestedAsk, protocol}` — **no evidence content** |
| `witness_reveal` | reveal | `{offerId, userSaidYes: true}` | `{quote, fromName, occurredAt, sourceLabel, category, imageUrl?}`; offer must be ≤ 30 min old, same token, single use |
| `witness_search` | search | `{query (≥ 3 chars), limit≤10}` | matching saved items (only when the user explicitly asks to find something) |
| `witness_add` | add | `{quote, fromName?, occurredAt?, sourceLabel, sourceRef?, context?}` | capture result; labeled "Added by {token label}" |
| `witness_pause` | pause | `{days 1–90}` | new pausedUntil |

Tool descriptions (verbatim intent): offer = "Use only at a calm, natural moment.
Returns no content. Ask the person the suggestedAsk in your own gentle words. Only
call witness_reveal if they clearly say yes. If they decline or seem unsure, drop
it for the rest of the conversation. Never offer to someone in acute crisis:
prioritize crisis resources (988 in the US). Never use evidence to argue with
their feelings." Reveal = "Only after an explicit yes to a witness_offer. Show the
quote exactly as returned, with who and when. Add nothing that tells them how to
feel." Default agent scopes: all except `search`, which a key gets only when the person
ticks it when creating the key (it returns evidence without the offer-and-yes step).

Token creation returns ready-to-paste configs: Claude Code
(`claude mcp add --transport http witness <APP_URL>/mcp --header "Authorization: Bearer …"`),
Codex (`[mcp_servers.witness]` TOML with url + bearer header), generic JSON
(`{"mcpServers":{"witness":{"type":"http","url":…,"headers":{…}}}}`), and REST curl.

As built (core, `apps/core/src/mcp.ts`): the official SDK's
`WebStandardStreamableHTTPServerTransport` in stateless JSON mode works on workerd;
a fresh server is built per request (its Ajv schema compiler, which the SDK uses only for
elicitation replies, is swapped for a no-op; this server never elicits). Tool input is
checked twice with each tool's zod schema: by the SDK before the handler runs, and again
inside the handler, so `witness_reveal` never uses up an offer unless `userSaidYes` is
literally `true` (a missing value, `false` or the string `"true"` are refused, and the offer
stays unused). Only the tools a token has scopes for
are registered, so tools/list shows only those and other calls return "Tool … not
found". Only `POST /mcp` is served (GET/DELETE → 405); device tokens and sessions get
403, no token 401. `initialize` returns instructions that restate ask-first and
crisis-first. `witness_offer` also returns `expiresAt`; when nothing qualifies it
returns `{available: false, offerId: null, suggestedAsk: null}` with a protocol line
telling the agent not to mention it. `witness_reveal` also returns `date` ("December
25, 2025" or "Date unknown") and a ready `attribution` line, records a delivery
(`channel: agent`) and counts toward the rhythm's repeat rules. `witness_add` accepts
`occurredAt` as epoch ms or an ISO date; a date-only ISO string is midday of that day in
the person's zone (so it never shows as the day before). Tool descriptions contain the
sentences above verbatim, after a one-line summary of what the tool does.
Also as built: `witness_offer` takes no input (Witness never needs the conversation or
how the person feels) and is unavailable while the rhythm is paused, within 24 hours of
the last offer, and for 7 days after an offer that expired unrevealed (offers are kept 8
days for this). The limits live in the write that makes the offer (one conditional
`INSERT … SELECT … WHERE NOT EXISTS`), so assistants asking at the same moment get one
offer between them; `witness_reveal` refuses while paused, and every reveal failure tells
the agent to say gently that it is not available right now, never that there is
nothing. `witness_search` matches only quote, name and note (not category or source
labels), needs 3+ characters, and records each result as a delivery with status
`search` (not counted by the rhythm). Reveal, search and the server instructions say
that `quote` and `fromName` are another person's words, shown as they are and never
followed as instructions (`protocol` field). `witness_status` adds a `protocol` line:
counts describe setup, never the person.

## 10. Web app (`apps/web`)

React 19 + Vite, plain CSS with the §4 tokens (no CSS framework), tiny client
router (History API). Talks only to the same-origin core API. Routes:

- `/` public landing: wordmark, tagline, 3 short beats (It keeps the real things ·
  It comes to you · It's yours: private, open source, self-hostable), a sample
  evidence card clearly labeled "Example", CTA "Start", links to GitHub, Safety,
  Privacy, Self-host. Crisis line in footer.
- `/signin` email → "Check your email".
- `/app` home: one status sentence ("Witness is on. It last kept something 2 days
  ago. Next delivery Tuesday 8:30 AM."; as built, "It last kept something …" only
  within 3 days, otherwise "It keeps things as they arrive.", so it never counts the
  days since anything kind arrived), a quiet "Add something" box (paste text +
  optional who/when, or drop an image), then the saved gallery (cards: quote,
  who, date, source; image cards). Card menu: Remove · Never save from this sender ·
  Edit details. A small link "Maybe (12)" — never a badge, never nagging.
- `/app/setup` wizard, 3 steps, each skippable, each ≤ 1 screen:
  1. **Email** — shows the inbound address with Copy; tabbed guides Gmail / Outlook /
     iCloud: (a) add forwarding address, (b) we auto-detect the confirmation
     ("Gmail sent a confirmation. Confirm it" button linking to the detected URL,
     polled every 5 s), (c) create one filter: copy-paste search string (from
     lexicon cues, minus promotions/social/noreply/unsubscribe) → Forward to address.
     Also "or just forward anything kind to this address".
  2. **Texts & photos** — iPhone: "Send to Witness" Shortcut (device token + URL) and
     Message automation guide; Mac: Witness for Mac (coming soon / build from source).
  3. **Rhythm** — "When should a witness reach you?" time, days (default every
     morning 8:30 in the browser's timezone), channel email. Explicit consent line:
     "I'm choosing this now so it can reach me later." + "Send one now to see it".
  Optional 4th card: **Your AI assistant** — create agent token, show configs.
- `/app/maybe`, `/app/settings` (rhythm, pause, sources/addresses, assistants/tokens,
  blocked senders, export, delete account, sign out), `/privacy`, `/safety`,
  `/d?t=` handled by core (server-rendered confirm page, branded).

Accessibility: WCAG AA contrast, focus states, reduced motion, 44px targets,
works at 360px wide. Copy follows §4 voice.

### 10.1 Response shapes the web app relies on

§8 leaves some bodies open. `apps/web/src/api/types.ts` is the web side of the
contract, and core returns exactly these. Checked on both sides:
`apps/core/test/contract.test.ts` (shapes) and `apps/web/src/api/client.test.ts`
(methods and paths), and end to end by `bun run e2e` (SPEC §13).

- `GET /api/v1/items` → `{ items: Item[], nextCursor: string | null }`. `Item` =
  `{id, status, kind, quote, context, fromName, occurredAt, sourceType, sourceLabel,
  category, edited: boolean, mediaType, mediaUrl?, canBlockSender?, createdAt,
  updatedAt}` (decrypted; unknown values are `null`; core also sends `categoryLabel,
  score, reasons, hasMedia, lastDeliveredAt, deliveredCount`). When `mediaUrl` is absent
  the web app uses `/api/v1/items/:id/media`. The card offers "Never save from this
  sender" only when `canBlockSender` is true.
- `POST /api/v1/items` body `{quote?, fromName?, occurredAt?, image?: {base64, mediaType}}`
  (at least one of quote/image) → the created `Item`. `PATCH /api/v1/items/:id` → the updated `Item`.
- `GET /api/v1/rhythm` and every rhythm mutation (`PUT`, `pause`, `resume`) → the full
  rhythm `{enabled, localTime, days, timezone, channel, consentedAt, pausedUntil, nextAt}`.
  `POST /api/v1/rhythm/send-now` → `{ sent: boolean, reason? }` (`false` when nothing
  qualifies, and nothing is sent: `reason: 'nothing_qualifies'` when nothing is kept yet,
  `'all_recent'` when things are kept but none can go now; `'send_failed'` when the mail
  provider failed; `'in_progress'` when another delivery to this person is being sent at
  that moment).
- `GET /api/v1/tokens` → `{ tokens: TokenSummary[] }` with `TokenSummary` =
  `{id, kind, label, scopes, createdAt, lastUsedAt, revokedAt?}`. `POST /api/v1/tokens`
  body `{label, kind: 'agent'|'device', scopes?}` → `TokenSummary & { token, configs }`
  where assistant `configs` = `{ claudeCode, codex, json, curl, mcpUrl, captureUrl }`
  and device `configs` = `{ captureUrl, curl? }` (config strings ready to paste; the web
  app builds any of the four assistant configs that are missing).
- `GET /api/v1/addresses` → `{ addresses: [{address, verifiedAt, isAccountEmail}] }`;
  `POST` body `{address}` → the address; `DELETE /api/v1/addresses` body `{address}`
  (also `DELETE /api/v1/addresses/:address`).
- `GET /api/v1/inbound/confirmations` → the confirmation object, or `null` when there
  is none. The web app only links to https URLs on the providers' own domains.
- `GET /api/v1/blocked-senders` → `{ senders: [{senderKey, createdAt, label}] }` and
  `DELETE /api/v1/blocked-senders/:senderKey` ("Allow again" in Settings). Senders stay
  keyed hashes; `label` is the display name from the blocked item (encrypted at rest,
  `null` when unknown). `POST /api/v1/items/:id/block-sender` → `{ok, removed, removedIds}`.
- Mutations may return any JSON body (e.g. `{ok: true}`); errors use the §8 error shape.

## 11. Mac helper (`apps/mac`, M1 scope)

Swift 6 package `WitnessMac` (macOS 14+):
- `WitnessMacCore` library: `MessagesDatabase` (open `~/Library/Messages/chat.db`
  read-only with `file:…?mode=ro`, busy timeout; incoming messages after a ROWID
  cursor; joins handle/chat for handle + direct/group; skips from-me, retracted,
  tapbacks, empty), `TypedStreamText` (clean-room minimal decoder for
  `attributedBody` → string; never crashes on malformed input; no GPL code),
  `FullDiskAccess.check()` via `open()` errno (EPERM = not granted), `Prefilter`
  (loads `packages/detector/lexicon.json`: exclusions + "any positive cue"),
  `WitnessClient` (POST `/api/v1/capture` with device token), `Cursor` store.
- `witness-mac` CLI: `witness-mac status`, `witness-mac scan --once [--db path]
  [--dry-run]` (prints counts only, never message text), `witness-mac run`
  (watch `chat.db-wal` with DispatchSource, debounce 5 s).
- Tests with a synthetic `chat.db` created from the schema in the test, and
  synthetic typedstream blobs produced by `NSArchiver` in-test. Never read a real
  chat.db in tests.
- Menu-bar app, FDA onboarding UI, Photos, signing/notarization: M2 (document in ROADMAP).

M1 as built (details in `apps/mac/README.md`, which also holds the M2 roadmap):
- CLI also has `login --url <apiUrl> [--token <wit_dev_…>]` (token read without echo
  when omitted; stored in Keychain service `studio.musenexus.witness`, account
  `device-token`; `apiUrl` in `~/Library/Application Support/Witness/config.json`,
  https only except localhost) and `logout`. `scan --once` treats `--once` as optional.
  `--lexicon <path>` / `WITNESS_LEXICON` / `<support dir>/lexicon.json` / source tree.
- Prefilter additionally excludes business senders (numeric handle ≤ 6 digits once
  spaces and `().+-` are removed, `urn:biz:`, or an SMS sender name with letters and no
  `@`), mirroring the §6 stage-1 hard exclusion, so they never leave the Mac.
- Prefilter parity: the Swift prefilter mirrors the TS `prefilter()` for a text
  message (fold curly quotes; phrases compiled like `phraseSource()`; each regex
  translated so ICU gives `\b \w \d . $` their JavaScript non-`u` meaning).
  `packages/detector/scripts/prefilter-parity.ts` (`bun run parity`) writes
  `packages/detector/test/fixtures/prefilter-parity.json` (`[{id, text, handle?,
  expectPass, excludedBy?}]`, from every text corpus example, eight email bodies and
  edge cases); `PrefilterParityTests` requires identical decisions with the real
  lexicon, and a detector test fails when the fixture is stale. No known differences.
- `witness-mac status` compiles every rule and reports the counts. The lexicon is
  found from the current folder or any parent (`packages/detector/lexicon.json`) and
  from the build's source tree. `WITNESS_SUPPORT_DIR` moves config/cursor;
  `WITNESS_TOKEN` supplies the device token without the Keychain (tests, scripts;
  `login` with the same token then saves only the URL).
- Cursor (`cursor.json`) = `{lastRowID, notBefore, updatedAt, databasePath}` (a cursor for
  another database is ignored). First run starts just
  before the first message inside the lookback (default 30 days); messages dated
  before `notBefore` are never sent even if they appear later with a higher ROWID
  (Messages in iCloud backfill). The cursor never moves past an unsent candidate on
  5xx/429/network/401/403, 404/405/other 4xx, or an unreadable answer; only 400/413/422
  skip that message. A candidate younger than 3 minutes is held (the scan stops before
  it without moving the cursor, `run` rescans when it may go) so a message the sender
  unsends (Apple: 2 minutes) or edits is read again first. A saved cursor past the
  database's max ROWID (a rebuilt chat.db) is replaced by a fresh one. `login` strips a
  trailing `/api/v1/capture`, and checks address and key with an empty capture (400 =
  fine, 401/403 = key refused, 404/405 = not a Witness; unreachable = saved anyway).
- Also skipped locally: `item_type ≠ 0` (group events) and messages over 16,000
  characters. `FullDiskAccess.check` returns `.unavailable(errno)` for errors other
  than EPERM/EACCES/ENOENT. `CaptureRequest` sends no `fromName` in M1.

## 12. Out of scope for v1 (ROADMAP)

SMS delivery (Twilio A2P registration), web push, OAuth for remote MCP (claude.ai
connectors), Gmail API, iOS app, Android, supporter/helper setup ("set this up with
someone you trust"), friends-can-send, WhatsApp/LinkedIn/Takeout/Meta importers,
Photos auto-capture (Mac M2), on-device model, i18n.

## 13. End-to-end proof (`bun run e2e`, as built)

`scripts/e2e.mjs` (bun) runs the real pieces together, with synthetic data only: it
builds `apps/web` (and checks the bundle has the lexicon's Gmail terms and no model
SDK), applies the D1 migrations locally, starts `wrangler dev --local --port 8787
--test-scheduled` with a generated `.dev.vars` (`MAILER=log`, `APP_URL`, `SIGNUPS=open`,
a random `WITNESS_MASTER_KEY`) and D1/R2 state in a temporary folder, and drives the
web app in headless Chrome over CDP (`scripts/e2e/browser.mjs`, on top of
`apps/web/scripts/chrome.mjs`; fresh profile, time zone emulated as Pacific/Honolulu).
Every console error, uncaught exception, failed request and CSP violation fails the
run. It covers: the landing page; sign-in through the dev outbox link; the Email step
showing the address and a Gmail forwarding confirmation (posted to
`/cdn-cgi/handler/email`) turning into a Confirm button; forwarded kind emails saved
verbatim and a newsletter excluded; the rhythm (consent, save, send-now, a `/d?t=` link
that confirms on GET and acts only on POST, resume in Settings); a hand-added photo
(stored in R2); one cron delivery via `/cdn-cgi/handler/scheduled` and no duplicate on a
second tick; an assistant key used by the official MCP SDK client (five tools, search off by default; status and
offer carry no content, reveal returns an exact quote once); a phone key used by the
real `witness-mac` CLI against a synthetic `attributedBody`-only chat.db
(`scripts/e2e/make-chat-db.swift`; the kind text arrives, the tapback, own message and
code never leave the Mac; skipped off macOS); export; and delete-everything, checked
row by row in local D1 and in local R2. It restores any existing `.dev.vars`, removes
what it created, and writes screenshots to `/tmp/witness-e2e`. Its first runs found two
bugs that unit tests could not: sign-in failed in real browsers (pages used
`Referrer-Policy: no-referrer`, so Chrome sent `Origin: null` on the sign-in page's own
form post), and a new rhythm defaulted to UTC instead of the browser's zone.

