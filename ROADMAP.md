# Roadmap

Witness grows in milestones. Every milestone keeps the same rules: verbatim
evidence only, reaching out only by consent, crisis first, and synthetic data
in everything public (see [Safety](docs/SAFETY.md)). There are no dates here;
things ship when they are safe.

**Help wanted** marks places where outside help would make a real difference.
Starter tasks are in [good first issues](docs/dev/good-first-issues.md).

## M1: the core loop (in development)

The smallest version that works on a hard day without asking anything of you.

- Hosted core on Cloudflare (Worker, D1, R2), self-hostable with Wrangler.
- Magic-link sign-in, a three-step setup, the gallery, the maybe pile,
  settings, export, and delete-everything.
- Email capture by forwarding from Gmail, Outlook and iCloud, with automatic
  detection of Gmail's forwarding confirmation.
- The evidence detector: exclusions, a data-driven lexicon, verbatim span
  selection, a labeled synthetic corpus with precision gates, and an optional
  model judge for borderline cases.
- Rhythm delivery by email, with one-tap skip, pause and remove.
- iPhone: a "Send to Witness" Shortcut and optional message automations.
- Witness for Mac, M1: a command-line collector for Messages, built from
  source.
- MCP for AI assistants (ask-first offers) and a REST API.

Help wanted: email template testing across mail apps, accessibility review of
the web app, and more hard negatives for the detector corpus.

## M2: Witness for Mac, for everyone (in source)

- A menu-bar app with a calm, skippable setup: paste your phone key (checked
  before it is saved), Full Disk Access with a live check and a relaunch when
  macOS needs one, start at login (off unless you turn it on), and how far
  back the first check looks. Pause and resume, and counts only in the menu.
- Names on device: an optional Contacts lookup, so a kept message shows who
  sent it without the address book leaving the Mac.
- A signed disk image (Developer ID, hardened runtime), built by
  `apps/mac/scripts/build-app.sh`, notarized when a stored notary profile is
  available.
- Still to come: a published download on the releases page.

Help wanted: testing on different macOS versions, and accessibility review of
the menu-bar panel and setup window.

## M3: more ways in and out

- Witness for Mac: Photos favorites (the original image, saved directly) and
  screenshots (read on the Mac with on-device text recognition), each behind
  its own switch and off by default, asking for Photos access only when one
  is turned on.
- Delivery by text message (requires carrier registration) and web push.
- OAuth for the remote MCP server, so Witness can be added as a connector in
  the claude.ai apps.
- Supporter setup: set Witness up together with someone you trust, with your
  consent at every step.
- Friends can send: people you choose can send kind words straight to your
  Witness. You approve who can send, and you can turn it off at any time.

Help wanted: Photos framework experience, SMS deliverability and compliance
experience, OAuth for MCP, and careful design review of the consent flows.

## Importers

One-off imports from exports people already have. Each runs locally and sends
single messages through the capture API.

- WhatsApp chat exports.
- LinkedIn recommendations.
- Google Takeout (selected mail, Chat).
- Meta (Messenger, Instagram) data downloads.

Help wanted: each importer is a self-contained project. See
[adding a source](docs/ARCHITECTURE.md#adding-a-source).

## Languages

- Translated interface text.
- Detector lexicons for other languages, written and reviewed by native
  speakers, with their own synthetic corpora.
- Local crisis lines alongside 988 and findahelpline.com.

Help wanted: native speakers for Spanish, Portuguese, Tagalog and ʻŌlelo
Hawaiʻi to start, and anyone who can review tone. Warmth does not always
survive translation.

## Later

- An on-device model, so borderline messages never leave the device.
- Android and Windows capture.
- An iOS app.

Ideas are welcome as an issue (Feature idea or Source idea). Proposals that weaken the safety rules, such
as mood detection, streaks, or public sharing, are out of scope.
