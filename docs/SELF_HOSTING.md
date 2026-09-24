# Self-hosting Witness

Witness runs as one Cloudflare Worker with a D1 database, an R2 bucket for
images, Email Routing for inbound mail, and a cron trigger for deliveries.
Running your own copy means the database, storage, master key and mail are all
yours.

> v1 is in active development. These steps describe the intended deployment.
> If a step does not match what you see, please open an issue.

## What you need

- A Cloudflare account, with a domain using Cloudflare DNS.
- [Bun](https://bun.sh) 1.2.23, [Node.js](https://nodejs.org) 22 or later
  (Wrangler needs it), and `openssl`.
- For outbound mail, one of:
  - Cloudflare Email Sending (in beta at the time of writing; requires the
    Workers Paid plan to send to any address), or
  - a [Resend](https://resend.com) account.
- Optional: an Anthropic API key, if you want the model judge.

Wrangler, Cloudflare's CLI, is installed as a dev dependency of `apps/core`.
Run the commands below from `apps/core` with `bunx wrangler …`, after
`bun install` at the repository root.

## Local development

```sh
bun install
bun run setup:dev
bun run dev
```

`bun run setup:dev` writes `apps/core/.dev.vars` (a random local master key,
`MAILER=log`, `APP_URL=http://localhost:8787` and `SIGNUPS=open`, so any
address can sign up on your machine) and applies the local database
migrations. To do it by hand instead:

```sh
cd apps/core
cat > .dev.vars <<EOF
WITNESS_MASTER_KEY=$(openssl rand -base64 32)
MAILER=log
APP_URL=http://localhost:8787
SIGNUPS=open
EOF
bun run db:migrate:local
cd ../..
```

`bun run dev` builds the web app and starts the Worker locally with
`wrangler dev`, usually at `http://localhost:8787`. With `MAILER=log`, outgoing
mail, including sign-in links, is written to the terminal instead of being
sent, and kept at `http://localhost:8787/api/v1/dev/outbox`. `.dev.vars` is
ignored by git; never commit it. Without `SIGNUPS=open`, the deployed default
(`invite`) applies, and an address not in `ALLOWED_EMAILS` gets no link (the
terminal shows `auth.signup_not_allowed`).

Trigger the delivery cron by hand:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

Send a synthetic inbound email to the local `email()` handler. Use the
inbound address the app shows you, and a `from` address that belongs to your
local account:

```sh
cat > synthetic.eml <<'EOF'
From: Riley Example <riley@example.com>
To: you@example.com
Subject: Thank you
Message-ID: <synthetic-1@example.com>
Date: Tue, 01 Sep 2026 09:00:00 -1000
Content-Type: text/plain; charset=utf-8

Thank you for helping me move last weekend. I could not have done it
without you.
EOF
curl --request POST 'http://localhost:8787/cdn-cgi/local/email' \
  --url-query 'from=you@example.com' \
  --url-query 'to=YOUR-INBOUND-ADDRESS' \
  --data-binary @synthetic.eml
```

## 1. Create the database and bucket

```sh
cd apps/core
bunx wrangler login
bunx wrangler d1 create witness
bunx wrangler r2 bucket create witness-media
```

`d1 create` prints a `database_id`. Put it in the D1 entry of
`apps/core/wrangler.jsonc`.

## 2. Configure

Set these `vars` in `apps/core/wrangler.jsonc`:

| Variable | Example | Meaning |
|---|---|---|
| `APP_URL` | `https://witness.example.com` | Public URL of your instance |
| `INBOUND_DOMAIN` | `example.net` | Domain for personal inbound addresses (see step 5) |
| `INBOUND_ADDRESS_STYLE` | `plus` or `local` | `plus` (default): `witness+<slug>@INBOUND_DOMAIN`, one routing rule. `local`: `<slug>@INBOUND_DOMAIN`, needs a catch-all |
| `INBOUND_PLUS_USER` | `witness` | The mailbox before the `+` in plus addresses |
| `MAIL_FROM` | `witness@example.com` | Sender address for deliveries and sign-in links |
| `MAILER` | `cloudflare` or `resend` | How outbound mail is sent. `log` is for local development only: it prints sign-in links, so the Worker refuses to serve any host but localhost while it is set |
| `SIGNUPS` | `invite` or `open` | `invite` allows only `ALLOWED_EMAILS` to sign up |
| `ALLOWED_EMAILS` | `you@example.com,friend@example.com` | Used when `SIGNUPS` is `invite` |
| `WITNESS_JUDGE` | `none` or `anthropic` | Optional model judge; defaults to `none` |
| `WITNESS_MODEL` | `claude-haiku-4-5` | Model for the judge |

For a personal instance, use `SIGNUPS=invite`.

Set `APP_URL` and `MAILER` **before the first deploy**. The shipped
`APP_URL=http://localhost:8787` and `MAILER=log` are local-only: while either is
set, the deployed Worker answers every API, sign-in and delivery-link request
with an error instead of serving the public. If you do not know your
`workers.dev` address yet, deploy once (it will refuse requests), read the
address from the deploy output, set `APP_URL`, and deploy again.

Keep your edits to `wrangler.jsonc` in a commit of your own (see
[Updating](#updating)), so pulling a new release never fights with them.

## 3. Set secrets

Generate a master key and store it as a secret:

```sh
openssl rand -base64 32
bunx wrangler secret put WITNESS_MASTER_KEY
```

Paste the generated value when prompted. **Keep a copy of this key somewhere
safe and offline, such as a password manager.** Every person's data key is
derived from it. If you lose it, stored evidence cannot be decrypted. v1 has
no key rotation, so changing it makes existing evidence unreadable.

Optional secrets:

```sh
bunx wrangler secret put RESEND_API_KEY      # when MAILER=resend
bunx wrangler secret put ANTHROPIC_API_KEY   # when WITNESS_JUDGE=anthropic
```

## 4. Create the tables and deploy

```sh
bunx wrangler d1 migrations apply witness --remote
cd ../..
bun run build
bun run --filter @witness/core deploy
```

`witness` here is the database name from step 1.

### Custom domain

Add a custom domain to `apps/core/wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "witness.example.com", "custom_domain": true }]
```

Or, in the Cloudflare dashboard, open your Worker, then **Settings → Domains &
Routes → Add → Custom domain**. Set `APP_URL` to match and deploy again.

### iPhone shortcuts

The ready-made shortcuts in `apps/web/public/shortcuts/` send to
`witness.musenexus.studio`, so **Setup → Texts & photos** offers them only
there. Your users can build the shortcut by hand (the steps are in Setup, under
**Build it yourself**), or you can make ready-made ones for your Witness on a
Mac signed in to iCloud, then build and deploy again:

```sh
bun run shortcuts --app-url https://witness.example.com
```

This writes and signs both shortcuts, checks the signed files, and records your
URL in `apps/web/src/lib/shortcuts.json` so Setup offers them. Apple's signing
certificate lasts about a year; the command prints its end date. Run it again
before then. See [the iPhone guide](guides/iphone.md#make-ready-made-shortcuts-for-your-own-witness).

## 5. Inbound email

Each person gets an unguessable personal address. Witness can show it in one of
two styles, set with `INBOUND_ADDRESS_STYLE`. Whichever you choose, Witness
**accepts mail at both forms**, so you can switch later without breaking an
address someone already forwards to.

| Style | Address looks like | What Email Routing needs |
|---|---|---|
| `plus` (default) | `witness+k3v9q2m7xa@example.net` | One rule for `witness@example.net` → your Worker, and **subaddressing** on |
| `local` | `k3v9q2m7xa@example.net` | The **catch-all** rule → your Worker |

`INBOUND_PLUS_USER` (default `witness`) is the part before the `+`. Use
`plus` unless you know a catch-all works for your domain: it needs a single
rule, and it works on a subdomain.

Enabling Email Routing changes the MX records of the domain it runs on. **Do
not enable it on a domain whose mail you already receive elsewhere**, or that
mail will stop arriving in your current inbox. Use a domain that receives no
other mail (for example `example.net`), or a subdomain (for example
`in.example.com`: in **Email Routing → Settings → Subdomains**, add it; this
adds MX records to the subdomain only. Afterwards, check that your apex
domain's MX records are unchanged).

In the dashboard, go to **Compute → Email Service → Email Routing** (older
dashboards: your domain, then **Email → Email Routing**) and turn it on for the
domain. Cloudflare adds the MX and SPF records. Then set `INBOUND_DOMAIN` to
that domain (or subdomain) and follow one of these:

**Plus addresses (`INBOUND_ADDRESS_STYLE=plus`, the default).**

1. In **Email Routing → Settings**, turn on **Subaddressing**, so that
   `witness+anything@…` is matched by the rule for `witness@…`.
2. Under **Routing Rules**, create a custom address `witness@in.example.com`
   (your `INBOUND_PLUS_USER` at your `INBOUND_DOMAIN`) with the action **Send
   to a Worker**, and choose your Witness Worker. Or with Wrangler, where the
   first argument is the zone and the last is the `name` from
   `apps/core/wrangler.jsonc`:

   ```sh
   bunx wrangler email routing rules create example.com \
     --match-type literal --match-field to --match-value witness@in.example.com \
     --action-type worker --action-value YOUR-WORKER-NAME
   ```

**Local addresses (`INBOUND_ADDRESS_STYLE=local`).**

1. Under **Routing Rules**, set the **Catch-all** rule to **Send to a Worker**
   and choose your Witness Worker. Or with Wrangler:

   ```sh
   bunx wrangler email routing rules update example.net catch-all \
     --action-type worker --action-value YOUR-WORKER-NAME
   ```

   Not verified: Cloudflare documents catch-all rules at the zone level, and the
   dashboard may not offer a separate catch-all for a subdomain. On a subdomain,
   use plus addresses.

**Check it.** Sign in, copy your address from **Setup → Email**, and send it a
short test message from your account email. It should show up in Witness (or
in the Worker's logs as an `inbound` event) within a minute. If it does not,
look at Email Routing's activity log: a message dropped there never reached the
Worker.

Witness accepts inbound mail only when the SMTP envelope sender is an address
the person has added in Witness. Forwarding confirmations from Gmail and other
providers are recognized and shown in setup.

## 6. Outbound email

**Cloudflare Email Sending.** Onboard your sending domain, add the binding,
and set `MAILER=cloudflare`:

```sh
bunx wrangler email sending enable example.com
```

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

Cloudflare adds SPF and DKIM records. Add a DMARC record as well for better
deliverability. Cloudflare's docs note that sending only to verified
destination addresses in your own account is free on all plans, which can suit
a single-person instance; sending to other addresses needs Workers Paid. Check
Cloudflare's current plans before relying on either.

**Resend.** Verify your sending domain in Resend, set the `RESEND_API_KEY`
secret, and set `MAILER=resend`.

Either way, `MAIL_FROM` must use the verified domain.

## 7. Deliveries (cron)

Deliveries run from a cron trigger every 15 minutes, in `apps/core/wrangler.jsonc`:

```jsonc
"triggers": { "crons": ["*/15 * * * *"] }
```

Cron triggers run in UTC. Each person's delivery time is computed in their own
timezone.

## 8. Optional model judge

Set `WITNESS_JUDGE=anthropic` and the `ANTHROPIC_API_KEY` secret. Only
borderline messages are sent to the model, and it may only classify text and
pick an exact quote (see [Safety](SAFETY.md)). As a rough estimate, at about 30
borderline messages a day, one active person costs around a dollar a month with
the default model. Tell the people who use your instance that it is on (see
[Privacy](PRIVACY.md)).

## Backups

D1 keeps point-in-time history (Time Travel) automatically: 30 days on Workers
Paid, 7 days on Workers Free.

```sh
bunx wrangler d1 time-travel info witness
bunx wrangler d1 time-travel restore witness --timestamp=2026-09-01T00:00:00Z
```

A restore overwrites the database in place and prints a bookmark you can use to
undo it. For an off-platform copy:

```sh
bunx wrangler d1 export witness --remote --output=witness-backup.sql
```

Evidence text in the export is still encrypted and unreadable without the
master key; dates, categories and other metadata are not. Store the key
separately from the backup, and keep the backup private. Time Travel does not cover R2.
If you need image backups, copy the bucket with an S3-compatible tool.

## Updating

Your `wrangler.jsonc` (database id, `vars`, routes) differs from the one in the
repository, and releases change that file too (for example
`compatibility_date`). Keep your settings in a commit on a branch of your own,
and rebase it onto each release:

```sh
# once, after configuring:
git switch -c my-witness
git commit -am "My Witness settings"

# each update:
git pull --rebase origin main
```

If the rebase stops on `apps/core/wrangler.jsonc`, keep your values (ids,
`vars`, routes) and take the release's other lines, then `git add` it and
`git rebase --continue`. Then:

```sh
bun install --frozen-lockfile
cd apps/core
bunx wrangler d1 migrations apply witness --remote
cd ../..
bun run build
bun run --filter @witness/core deploy
```

Migrations run before the new code is deployed, so each migration must work
with the previous release's code.

## Checklist

- [ ] Master key saved somewhere safe and offline.
- [ ] `SIGNUPS=invite` unless you mean to run a public instance.
- [ ] Two-factor authentication on your Cloudflare account.
- [ ] Inbound mail tested with a synthetic message.
- [ ] A delivery tested with **Send one now** in the app.
- [ ] Your users told whether the model judge is on.
