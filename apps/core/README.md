# Muse Nexus Witness: core

The Cloudflare Worker behind Muse Nexus Witness. One Worker does four jobs:

- **REST API** for the web app, devices (Mac helper, iPhone Shortcut) and assistants
- **MCP server** at `/mcp`, so an AI assistant can offer a piece of evidence and show it only after a clear yes
- **Inbound email** through Cloudflare Email Routing (forward kind messages to your Witness address)
- **Cron** every 15 minutes to deliver the rhythm the person chose

It also serves the web app (`apps/web/dist`) as static assets. The contract is
[`docs/dev/SPEC.md`](../../docs/dev/SPEC.md) §5, §7, §8 and §9.

## Local development

```sh
bun install                       # at the repo root
cd apps/core
cp .dev.vars.example .dev.vars    # then put a real key in it: openssl rand -base64 32
echo 'SIGNUPS=open' >> .dev.vars  # the default is invite-only
bun run db:migrate:local
bun run --filter @witness/web build   # or create apps/web/dist/index.html by hand
bun run dev                       # http://localhost:8787
```

With `MAILER=log` (the default) nothing is emailed. Each message is kept in
memory and one line is printed per message: the sign-in link for sign-in mail,
never the body of a delivery. While `APP_URL` is on localhost you can read the
messages at `GET /api/v1/dev/outbox`.

Sign in locally:

```sh
curl -X POST localhost:8787/api/v1/auth/start -H 'Content-Type: application/json' -d '{"email":"jordan@example.com"}'
# open the printed /auth/callback link in a browser
```

### Running the email and cron handlers locally

`wrangler dev` exposes test endpoints for the non-HTTP handlers:

```sh
# Inbound email: the raw message is the body; envelope sender and recipient are query params.
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=jordan@example.com&to=<slug>@in.example.com' \
  --data-binary @message.eml

# The cron (rhythm delivery and housekeeping).
curl 'http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*'
```

The envelope sender has to be on the account's allowed list (the sign-in email
is added automatically). A `.eml` file is plain RFC 822 text: headers, a blank
line, then the body. Use made-up people and example.com addresses.

## Tests

```sh
bun run test        # vitest 4 + @cloudflare/vitest-pool-workers (real workerd, D1 and R2)
bun run typecheck
```

Migrations are applied to the test D1 database by `test/setup.ts`. Every var is
pinned in `vitest.config.ts`, so a local `.dev.vars` never changes what the tests
see. All test data is synthetic.

After changing `wrangler.jsonc`, regenerate the `Env` type with `bun run types`.

## Configuration

Vars live in `wrangler.jsonc`; secrets are set with `npx wrangler secret put NAME`
(or `.dev.vars` locally).

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `WITNESS_MASTER_KEY` | secret, required | | 32 random bytes, base64. Encrypts everything. Losing or changing it makes stored items unreadable. |
| `APP_URL` | var | `http://localhost:8787` | Public origin, used in email links and MCP configs |
| `INBOUND_DOMAIN` | var | `in.example.com` | Domain of the personal inbound addresses |
| `INBOUND_ADDRESS_STYLE` | var | `plus` | `plus`: addresses are `INBOUND_PLUS_USER+<slug>@INBOUND_DOMAIN` (one Email Routing rule, subaddressing on). `local`: `<slug>@INBOUND_DOMAIN` (catch-all). Both forms are always accepted. |
| `INBOUND_PLUS_USER` | var | `witness` | Mailbox name for plus addresses |
| `MAIL_FROM` | var | `Witness <witness@example.com>` | Sender of sign-in and delivery mail |
| `MAILER` | var | `log` | `log`, `cloudflare` (send_email binding) or `resend` |
| `SIGNUPS` | var | `invite` | `open`, or `invite` (only `ALLOWED_EMAILS` can create an account) |
| `ALLOWED_EMAILS` | var | empty | Comma-separated, for `invite` |
| `WITNESS_JUDGE` | var | `none` | `anthropic` sends borderline finds to a small model (needs the key) |
| `WITNESS_MODEL` | var | `claude-haiku-4-5` | Model for the judge |
| `RESEND_API_KEY` | secret, optional | | For `MAILER=resend` |
| `ANTHROPIC_API_KEY` | secret, optional | | For `WITNESS_JUDGE=anthropic` |

Bindings: `DB` (D1), `MEDIA` (R2), `ASSETS` (the web app), `EMAIL` (send_email;
only used with `MAILER=cloudflare`, and the `MAIL_FROM` domain must be onboarded
with `npx wrangler email sending enable <domain>`).

## Self-hosting

```sh
npx wrangler d1 create witness            # paste the id into wrangler.jsonc
npx wrangler r2 bucket create witness-media
npx wrangler secret put WITNESS_MASTER_KEY
bun run db:migrate:remote
bun run --filter @witness/web build && npx wrangler deploy
```

Then, in the Cloudflare dashboard (Email Routing), route `witness@<INBOUND_DOMAIN>`
to this Worker with subaddressing on (the default `plus` style), or the domain's
catch-all for `INBOUND_ADDRESS_STYLE=local` (docs/SELF_HOSTING.md, step 5), and set
`APP_URL`, `INBOUND_DOMAIN`, `MAIL_FROM` and `MAILER` for your deployment. Workers Paid is recommended: the free plan's
CPU limit is tight for the detector on long emails and for a busy cron.

## API

All JSON errors look like `{ "error": { "code": "…", "message": "…" } }`.

**Auth.** The web app uses the `wit_session` cookie (HttpOnly, SameSite=Lax, 30
days); every mutating cookie request must also send `X-Witness-CSRF: 1` and a
same-origin `Origin`. Assistants and devices send `Authorization: Bearer
wit_agent_…` or `wit_dev_…`, checked against the token's scopes.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /api/v1/auth/start` `{email}` | none | Sends a sign-in link. Always `200 {ok:true}`. Rate-limited per visitor and address. |
| `GET /auth/callback?token=` | none | Page that submits itself to the POST below (link scanners cannot use the link up) |
| `POST /auth/callback` (form `token`) | none | Uses the link, creates the account on first sign-in, sets the cookie, redirects to `/app` or `/app/setup` |
| `POST /api/v1/auth/logout` | session | |
| `GET /api/v1/me` · `PATCH` `{displayName?, timezone?}` | session | `{email, displayName, timezone, inboundAddress, createdAt}` |
| `GET /api/v1/status` | session, agent/device `status` | Counts and source health only |
| `GET /api/v1/items?status=saved\|maybe&limit=&cursor=&q=` | session | `{items, nextCursor}`, newest first by when it happened |
| `POST /api/v1/items` `{quote?, image?, fromName?, occurredAt?, sourceLabel?, context?, category?}` | session | Manual add, always saved. `201` the item; `409 duplicate` when that text was already added |
| `PATCH /api/v1/items/:id` `{status?, category?, fromName?, occurredAt?, quote?}` | session | The updated item. Editing the quote marks it `edited` |
| `DELETE /api/v1/items/:id` | session | Deletes the row and its image |
| `POST /api/v1/items/:id/block-sender` | session | Never save from this sender; removes everything kept from them. `{ok, removed, removedIds}` |
| `GET /api/v1/blocked-senders` · `DELETE /:senderKey` | session | `{senders: [{senderKey, createdAt, label}]}`; DELETE is "Allow again" |
| `GET /api/v1/items/:id/media` | session, or `?sig=` | The decrypted image |
| `POST /api/v1/capture` | session, device `capture`, agent `add` | See below |
| `GET /api/v1/rhythm` · `PUT` `{enabled, localTime?, days?, timezone?, channel?}` | session | The full rhythm (also from pause/resume). Turning it on records consent |
| `POST /api/v1/rhythm/pause` `{days: 1–90}` | session, agent `pause` | |
| `POST /api/v1/rhythm/resume` | session | |
| `POST /api/v1/rhythm/send-now` | session | `{sent:true}` or `{sent:false, reason: nothing_qualifies \| all_recent \| send_failed}`; sends nothing when nothing qualifies |
| `GET /api/v1/tokens` · `POST` `{kind, label, scopes?}` · `DELETE /:id` | session | `POST` → `201 {id, kind, label, scopes, createdAt, lastUsedAt, revokedAt, token, configs}`: the plaintext `token` once, plus ready-to-paste configs. Device tokens default to `capture` + `status` |
| `GET /api/v1/addresses` · `POST {address}` · `DELETE /:address` (or `DELETE` with `{address}`) | session | Allowed inbound envelope senders. `POST` → the address |
| `GET /api/v1/inbound/confirmations` | session | Latest forwarding confirmation `{provider, url?, code?, receivedAt}`, or `null` |
| `GET /api/v1/export` | session | Streamed JSON of everything, decrypted, images as base64 |
| `DELETE /api/v1/account` | session | Deletes every row and object for the account |
| `GET /api/v1/dev/outbox` | none | Only with `MAILER=log` on localhost |
| `GET /d?t=` · `POST /d` (form field `t`) | signed link | Delivery actions (keep, skip, pause, remove, stop, block): GET shows a confirm button, only POST acts. One-click `List-Unsubscribe` posts to the stop link |
| `POST /mcp` | agent token | MCP, stateless, JSON responses |

### Capture

```json
{ "sourceType": "text", "text": "…", "fromName": "Sam", "fromHandle": "+15555550101",
  "occurredAt": 1727000000000, "sourceRef": "stable-id", "sourceLabel": "iMessage",
  "threadKind": "direct", "image": { "base64": "…", "mediaType": "image/jpeg" }, "favorite": false, "shared": false }
```

Returns `{status: saved|maybe|excluded|duplicate|blocked, id?, category?, quote?, reason?}`.
Device and assistant tokens never get `duplicate` (they get what a first capture of the
same words would get, without an `id`), so a capture key cannot test what is kept.
Assistant tokens always capture as `agent` and are labeled "Added by {token label}";
what they add is kept (in maybe at worst), never excluded. Devices cannot send `manual`
or `agent`. `favorite: true` on a device photo saves it without review; `shared: true`
(the iPhone share sheet) keeps the text in maybe when the detector would exclude it. Images up to 10 MB (JPEG, PNG, WebP, HEIC, GIF; the file's
own bytes decide the type). Text up to 20,000 characters and a subject up to 500: longer
gets `400`, and inbound email whose words run past the limit is excluded (`too_long`).
Nothing is ever cut to fit.

### MCP tools

`witness_status`, `witness_offer`, `witness_reveal`, `witness_search`,
`witness_add`, `witness_pause`. Only the tools a token has scopes for are listed.
The offer returns no content; a reveal needs the offer id from the same token,
within 30 minutes, once, with `userSaidYes: true`.

```sh
claude mcp add --transport http witness https://your-witness.example/mcp --header "Authorization: Bearer wit_agent_…"
```

## Privacy and safety notes

- Quotes, context, names, forwarding links and images are encrypted per user
  (AES-GCM, HKDF from the master key). D1 holds ciphertext, hashes and counts.
- Tokens (session, sign-in, assistant, device) are stored as SHA-256 hashes.
- Logs carry event names, outcomes and rule ids, never message text.
- `items.reasons` keeps the detector's rule ids (for example
  `pride/proud_of_you_strong`) so a save is explainable; these name lexicon cues,
  not message text.
- Every email Witness sends carries `X-Witness-Mail`, and inbound mail with it
  is ignored, so a forwarding filter cannot loop a delivery back in.
- Security headers (CSP, nosniff, `Referrer-Policy: no-referrer`,
  `frame-ancestors 'none'`) are set on everything the Worker renders. The web
  app's static files need their own headers (for example `apps/web/public/_headers`).
