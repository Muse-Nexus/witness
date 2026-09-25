<p align="center"><sub><b>▍MUSE NEXUS</b></sub></p>
<h1 align="center">Witness.</h1>
<p align="center"><b>A witness to your life.</b></p>
<p align="center"><i>Witness quietly keeps the real, kind things people say and do for you, and emails you one on the days you choose.</i></p>

---

## Why it exists

Some days your mind tells a story that isn't true. On those days you are
unlikely to open an app and go looking for proof.

Witness keeps the receipts for you: the kind text, the thank-you email, the
photo with someone who loves you. It keeps them in the other person's exact
words, with who said it and when. Then it emails you one, on a schedule you
chose while you were doing well.

## How it works

1. **Connect once.** Forward email, add an iPhone Shortcut, run the Mac helper,
   or connect an AI assistant. After that, nothing needs your attention.
2. **It keeps the real things.** Witness checks each message against a public
   list of kind phrases, and keeps what is clearly kind, word for word. Anything
   it is not sure about waits quietly in Maybe, which is never emailed to you.
3. **It comes to you.** One thing you kept arrives by email, on your schedule.
   An AI assistant can ask first too, and shows it only after you say yes.
4. **It's yours.** Encrypted when stored (not end-to-end; see
   [Privacy](docs/PRIVACY.md)), open source, self-hostable. Download or delete
   everything at any time.

![Witness home screen in dark mode, showing synthetic example evidence](docs/assets/screens/home-desktop-dark.png)

## Status

v1 is new. An invite-only preview runs at
[witness.musenexus.studio](https://witness.musenexus.studio); open sign-ups come
later. Everything below runs end to end in the repository's automated test.

| Part | Status |
|---|---|
| Hosted core (Cloudflare Worker, D1, R2) | preview, invite-only |
| Web app | preview, invite-only |
| Email capture (Gmail, Outlook, iCloud forwarding) | preview; Gmail steps checked, Outlook and iCloud untested on real accounts |
| iPhone Shortcuts | signed, added in one tap from Setup; not yet tried on a device |
| Witness for Mac (texts) | M2: menu-bar app with guided setup, optional names and a choice of how far back to look. [Download 0.2.0](https://github.com/Muse-Nexus/witness/releases/tag/mac-v0.2.0) (signed and notarized), or build it yourself |
| AI assistants via MCP | preview (Claude Code, Codex, any MCP client) |
| Text-message delivery, claude.ai connectors | planned |

See the [roadmap](ROADMAP.md) for what comes next.

## Quickstart

For development you need [Bun](https://bun.sh) 1.2.23 and
[Node.js](https://nodejs.org) 22 or later (Wrangler, which runs the Worker
locally, needs it).

```sh
git clone https://github.com/Muse-Nexus/witness.git
cd witness
bun install
bun run setup:dev   # once: a local key, MAILER=log and the local database
bun run dev         # then open http://localhost:8787
```

Sign-in links are printed in the terminal. Full deployment steps are in
[Self-hosting](docs/SELF_HOSTING.md). Guides for each source live in
[docs/guides](docs/guides/).

## Contribute

Witness is a mental-health support tool, so the product rules matter as much
as the code. Start with [Safety](docs/SAFETY.md), then
[Contributing](CONTRIBUTING.md) and the
[good first issues](docs/dev/good-first-issues.md). Use synthetic data only.

See also [Privacy](docs/PRIVACY.md), [Architecture](docs/ARCHITECTURE.md) and
[Security](SECURITY.md) for private vulnerability reports.

## If you are in crisis

Witness is not treatment and cannot help in an emergency. If you are in crisis,
call or text **988** in the US, or find a line near you at
[findahelpline.com](https://findahelpline.com).

## License

[MIT](LICENSE). Built by Muse Nexus (Mark Matthews) and contributors.
See [Notices](NOTICE.md).

<p align="center"><sub>Made by Muse Nexus in Hawaiʻi · Open source (MIT)</sub></p>
