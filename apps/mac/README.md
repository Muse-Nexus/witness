# ▍MUSE NEXUS · Witness for Mac

**Witness.** *A witness to your life.*

Witness for Mac is the Messages collector for
[Muse Nexus Witness](../../README.md). It watches the Messages app on your Mac
for the kind things people text you (the thank-you, the "proud of you", the
"you made my day") and passes those, one message at a time, to your Witness.
Your Witness then decides what to keep and brings one back on the rhythm you
chose.

You set it up once. After that it needs nothing from you.

This is milestone 2 (version 0.2.0): a menu-bar app, **Witness.app**, with a
guided setup, on top of the same Swift library and command-line tool
(`witness-mac`) as milestone 1. Photos come next (see [Roadmap](#roadmap-m3)).
The step-by-step guide for people is [docs/guides/mac.md](../../docs/guides/mac.md).

## What it does

1. Reads new rows from `~/Library/Messages/chat.db`, strictly read-only.
2. Sets aside what is not a message someone sent you: your own messages,
   tapbacks, unsent messages, group events and attachments with no words.
3. Runs a small on-device prefilter built from the shared
   [`lexicon.json`](../../packages/detector/LEXICON.md):
   - **excludes** one-time codes, short codes, Business Chat and SMS sender
     names (such as "BANKCO"), and no-reply senders;
   - **passes** a message only if it has a positive cue (a thank-you, pride,
     love, care, congratulations and so on).
4. Sends each passing message to your Witness at `POST /api/v1/capture`, where
   the full detector makes the real decision.
5. Remembers where it stopped, so each message is considered once.

The first check looks back 30 days (7 or 90 in the app's setup, or
`--lookback-days` for the CLI), so a lifetime of history is never uploaded
without you choosing it.

## The menu-bar app

`Witness.app` lives in the menu bar (no Dock icon). Its panel shows states
only:

- whether it is connected to your Witness, and whether it can read Messages
  (Full Disk Access);
- when it last checked;
- **Check now**, **Pause** / **Resume** (kept across restarts), **Open
  Witness**, **Settings…** and **Quit**;
- the crisis line.

It never shows message text or who sent anything, and it keeps no tally of
what was sent: a "0 this week" next to the crisis line would read as a verdict
on a hard week ([SAFETY](../../docs/SAFETY.md) §2, §5, §6). The counts of each
check go to the unified log, for troubleshooting.

### Setup, one step per screen

The first time it opens, a short setup walks through five steps. Each one can
be skipped and done later from **Settings…**, which opens the same screens
with a list on the side.

1. **Your Witness.** The address (filled in with
   `https://witness.musenexus.studio`) and your phone key, pasted from Witness
   (**Setup → Texts & photos → Create a phone key**; it starts with `wit_dev_`).
   The app checks both with `GET /api/v1/status` (counts only) before saving
   them. A capture-only key cannot read status (403), so for that one it checks
   with an empty capture instead, which a Witness always turns down with 400
   and never saves. The key is saved only after that check succeeds: a refused
   key (401), an address that is not a Witness, a name that does not resolve
   or a certificate this Mac does not trust is reported and nothing is saved,
   and if Witness cannot be reached just now, nothing is saved either (choose
   **Check and save** again later). The key goes into your login Keychain, the
   same item `witness-mac` uses, together with the address it was checked
   against.
2. **Messages access.** Why Full Disk Access is needed, in plain words, a
   button that opens **Privacy & Security → Full Disk Access**, and an icon
   you can drag into the list. The screen checks once a second and shows a
   check mark the moment access works. macOS applies a new grant only after
   the app reopens, so if access is still off a few seconds after you opened
   System Settings, it offers **Relaunch Witness**.
3. **Names (optional).** Contacts access, so a kept message can show who sent
   it. See [Names](#names).
4. **Start at login.** A switch, off by default (`SMAppService.mainApp`). If
   macOS wants your approval, the screen says so and opens **Login Items**.
5. **First check.** How far back to look the first time: 7, 30 (default) or
   90 days.

Witness starts checking only once setup is finished or its window is closed,
so the first check uses the lookback you chose.

### In the background

The app runs the same scanner as the CLI (`CollectorEngine` wraps
`MessageScanner`, `ChatDatabaseWatcher`, `CursorStore` and `WitnessClient`):
a check a few seconds after Messages writes, every 10 minutes as a safety net,
and when you choose **Check now**.

- **Pause** stops sending at once, even in the middle of a check or while a
  send waits to retry; the message it was about to send waits for **Resume**. The pause is saved, so it lasts
  across restarts.
- **A refused key.** If Witness answers 401 or 403 (for example, the key was
  revoked in Settings), the app pauses and says, plainly, to add a new key.
  Nothing is skipped; it picks up where it stopped once a new key is saved.
- **The key goes only where it was saved for.** If `config.json` names a
  different address than the one the key was saved with (the file is easy to
  edit, the Keychain is not), nothing is sent, and the panel offers **Add a
  key** to save a key for the new address.
- **Full Disk Access turned off.** If macOS stops letting it read Messages
  (`open(2)` fails with `EPERM`), the app pauses and points to the Messages
  access step. It resumes by itself once Messages can be read again.
- It logs counts and states only (unified log, subsystem
  `studio.musenexus.witness.mac`), never message text, senders or names.

### Names

Names are off until you turn them on in step 3. With names on:

- the app asks macOS for Contacts access (macOS gives all of your contacts or
  none) and reads only names, phone numbers and email addresses;
- it keeps a lookup table in memory only, and reads Contacts again when they
  change (`CNContactStoreDidChange`);
- two numbers that both carry a country code must be the same number
  (`+44 20 7946 0123` never matches `+1 207 946 0123`); when one of them was
  saved without a country code, the last ten digits are compared (so
  `+1 206 555 0101` and `(206) 555-0101` match); email addresses are compared
  without case;
- turning names off takes effect at the next message, even in the middle of a
  check, and Contacts is not read again;
- when a message is being sent anyway, the sender's name from your card goes
  with it as `fromName`. If a number or address matches more than one card,
  no name is sent: an unknown name stays unknown.

The rest of your address book never leaves the Mac.

## Privacy

- **Only candidate messages leave your Mac.** For each one it sends the text
  of that single message, the sender's phone number or email, when it was
  sent, the service (iMessage, SMS or RCS), whether it was a direct or group
  conversation, and Messages' own ID for it (so the server can skip
  duplicates). With names on, it also sends the name you saved for that
  sender. Never whole threads, never attachments, never your own messages,
  never your address book.
- **Everything else stays on your Mac.** Messages without a positive cue, and
  anything excluded, are not sent in any form, not even as counts.
- **Read-only.** Witness opens `chat.db` in read-only mode and cannot change it.
- **Nothing is printed or shown.** The app and `witness-mac` show counts and
  settings only. They never show message text, and never show your key.
- **What it stores locally,** in `~/Library/Application Support/Witness`: the
  server address (`config.json`), the scan position, a row number and two
  dates (`cursor.json`), the app's settings, pause and setup progress
  (`app-state.json`), and the time of the last check (`activity.json`). The
  key is in your login Keychain (service `studio.musenexus.witness`, this Mac
  only, never synced), with the address it is for.
- On your Witness, evidence is encrypted at rest and you can remove any item,
  block a sender, export or delete everything. See [Privacy](../../docs/PRIVACY.md).

## Build the app

You need macOS 14 or later and Xcode 16 or later (Swift 6).

```sh
cd apps/mac
scripts/build-app.sh          # .build/Witness.app and .build/Witness-0.2.0.dmg
scripts/build-app.sh --lint   # only check App/Info.plist and App/Witness.entitlements
```

The script:

1. lints `App/Info.plist` (bundle id `studio.musenexus.witness.mac`, version
   from `WitnessMacVersion.current`, `LSUIElement`, a plain
   `NSContactsUsageDescription`, no Photos usage yet) and
   `App/Witness.entitlements` (not sandboxed, Contacts only);
2. builds `WitnessMenuBar` for release, universal (arm64 and x86_64) when it
   can;
3. assembles `Witness.app` with the lexicon from `packages/detector` and an
   icon drawn by `scripts/make-icon.swift` (a coral opening quote on ink),
   strips the binary (`strip -S -x`), and stops if any path from the building
   Mac is left in it (`/Users/…`, the checkout, or the debug map), so a
   download never carries the builder's user name or folders;
4. signs with hardened runtime, using the **Developer ID Application**
   identity for team `KT5VZW5S7K` from your login keychain when there is one
   (`WITNESS_TEAM_ID` or `WITNESS_SIGN_IDENTITY` choose another), and ad hoc
   otherwise, which it says (an ad-hoc build runs on the Mac that built it
   only);
5. packages a disk image with the app and an `Applications` link, signs it,
   and writes its SHA-256 next to it.

It is not sandboxed on purpose: Full Disk Access is granted to this exact
app, and the App Sandbox would not let it read Messages.

**Notarization** runs only with a notarytool profile you stored earlier
(`xcrun notarytool store-credentials`, which asks for the credentials itself):
`scripts/build-app.sh --notarize <profile>`, or set `WITNESS_NOTARY_PROFILE`.
It submits the disk image, waits, fetches Apple's log, staples the ticket, and
checks the result with `spctl`. The script never asks for, prints or stores a
password.

For development, `swift run WitnessMenuBar` runs the app unbundled (names and
start at login need the real bundle). A debug build honours
`WITNESS_SUPPORT_DIR`, `WITNESS_TOKEN` and `WITNESS_LEXICON`, and accepts
`http://localhost`. A release build ignores all of them and accepts `https://`
only: Witness.app holds Full Disk Access, and any program could start it with
extra environment variables. A debug build can also draw its own screens to
PNG files with made-up data, for docs: `WITNESS_SNAPSHOT_DIR=<folder>
.build/debug/WitnessMenuBar`. It runs in a scratch folder it creates, with no
key and no real Messages or Contacts, so it never touches your settings. That
mode is not in release builds.

## The command-line tool

`witness-mac` is still here, for scripts, servers and people who prefer
Terminal. Use the app or the CLI on one Mac, not both at once: they share the
same settings and scan position.

```sh
cd apps/mac
swift build -c release
swift test                      # optional: runs against synthetic data only
.build/release/witness-mac --help
```

To use it from anywhere, copy the binary somewhere on your `PATH`:

```sh
mkdir -p ~/bin && cp .build/release/witness-mac ~/bin/
```

### 1. Give it Full Disk Access

macOS protects `chat.db`, so the CLI needs Full Disk Access too.

1. Open **System Settings › Privacy & Security › Full Disk Access**. This opens
   the right page directly:
   `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"`
2. Turn it on for the app that runs `witness-mac`:
   - running it by hand: your terminal app (Terminal, iTerm, …), then quit and
     reopen that app;
   - running it in the background (below): the `witness-mac` binary itself.
     Click **+**, press **⌘⇧G**, and enter its path.
3. Check with `witness-mac status`. "Messages access" should say `granted`.

Witness checks access by actually opening the file, because macOS reports that
`chat.db` exists even when it cannot be read.

### 2. Sign in with a device token

In Witness, create a device token for this Mac (setup step **Texts & photos**,
or **Settings**). It starts with `wit_dev_`. Then:

```sh
witness-mac login --url https://your-witness.example.com
# paste the token when asked; it is not shown or saved in your shell history
```

`--token <wit_dev_…>` also works for scripts. `witness-mac logout` removes the
token. The address must use `https://` (plain `http://` is only accepted for
`localhost` while developing). The capture address the phone-key screen shows
(`…/api/v1/capture`) works too; the path is dropped. Before saving anything,
`login` checks the address and key with an empty capture (a Witness always
turns it down with 400, so nothing is added): a refused key, an address that
is not a Witness, a name that does not resolve or an untrusted certificate is
reported and nothing is saved; if the server cannot be reached right now,
nothing is saved and it exits with `75`, so run it again when you are online.

The token is saved together with the address it was checked against, and is
sent only there: if `config.json` later names another address, `scan` and
`run` stop with `78` until you run `login` again. A token saved by version 0.1
has no address with it, so run `login` once after updating.

After a rebuild, macOS may ask whether `witness-mac` can use the saved token in
your Keychain. Choose **Always Allow**.

### 3. Point it at the lexicon

When run from this repository, `witness-mac` finds
`packages/detector/lexicon.json` on its own: it looks in the current folder and
every folder above it, then (debug builds only) in the checkout it was built
from. If you copied the binary elsewhere, either pass `--lexicon <path>`, set `WITNESS_LEXICON=<path>`,
or copy the file to `~/Library/Application Support/Witness/lexicon.json`.
`witness-mac status` compiles every rule and says how many did, so a pattern
the Mac cannot read shows up there rather than on the first scan. (The app
carries its own copy inside `Witness.app`.)

### 4. Try it, then leave it running

```sh
witness-mac scan --once --dry-run   # counts only, sends nothing, saves nothing
witness-mac scan --once             # one real pass
witness-mac run                     # keep watching
```

`run` scans at startup, a few seconds after Messages writes anything new (it
watches `chat.db-wal` and waits for 5 quiet seconds), and every 10 minutes as a
safety net. Control-C stops it. Output looks like this:

```
9/24/2026, 8:30:12 AM  scanned 6 · skipped 3 · excluded 1 · no cue 1 · candidates 1 · sent 1
```

The menu-bar app is the simplest way to keep it running. If you would rather
use the CLI in the background, a LaunchAgent can keep `run` going: grant Full
Disk Access to the binary itself (step 1), then save this as
`~/Library/LaunchAgents/studio.musenexus.witness.plist`, replacing `/Users/you`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>studio.musenexus.witness</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/bin/witness-mac</string>
    <string>run</string>
    <string>--lexicon</string>
    <string>/Users/you/Library/Application Support/Witness/lexicon.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>600</integer>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/witness-mac.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/witness-mac.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/studio.musenexus.witness.plist
```

The log holds counts only, never message text.

### Commands

| Command | What it does |
| --- | --- |
| `witness-mac status [--db <path>] [--lexicon <path>]` | Full Disk Access, server, token (present or not), scan position, lexicon. |
| `witness-mac login --url <server> [--token <wit_dev_…>]` | Saves the server address and the device token. |
| `witness-mac logout` | Removes the device token from the Keychain. |
| `witness-mac scan --once [--dry-run] [--db <path>] [--lexicon <path>] [--lookback-days <n>]` | One pass. `--dry-run` sends nothing and does not move the scan position. |
| `witness-mac run [--db <path>] [--lexicon <path>] [--lookback-days <n>]` | Keeps watching Messages. |

Exit codes follow `sysexits(3)`: `64` usage, `66` no Messages database, `75`
server unavailable (the next scan resumes where this one stopped), `77` no Full
Disk Access or the token was refused, `78` not signed in or no lexicon.

Environment variables, for tests and scripts. A debug build of the app reads
all three too; the released app ignores them:

| Variable | Effect |
| --- | --- |
| `WITNESS_LEXICON` | `lexicon.json` to use when `--lexicon` is not given |
| `WITNESS_SUPPORT_DIR` | Folder for `config.json`, `cursor.json` and the app's files instead of `~/Library/Application Support/Witness` |
| `WITNESS_TOKEN` | Device token to use instead of the Keychain. The Keychain is then never read or written: `login` with the same token saves only the server address, and `logout` has nothing to remove. The end-to-end test (`bun run e2e`) runs the real CLI this way, so it never touches your Keychain or settings. Prefer the Keychain for everyday use: environment variables can end up in shell history and process listings. |

## How it works

| Piece | File |
| --- | --- |
| Read-only SQLite over the system `libsqlite3` | `Sources/WitnessMacCore/ReadOnlySQLite.swift` |
| `chat.db` reader: incoming messages after a `ROWID` cursor, joined with `handle` and `chat` (style 43 group, 45 direct); optional columns detected with `PRAGMA table_info` | `MessagesDatabase.swift` |
| Apple-epoch dates (nanoseconds, or seconds on old databases) to Unix milliseconds | `AppleTime.swift` |
| `attributedBody` decoder for messages whose `text` column is empty | `TypedStreamText.swift` |
| Full Disk Access check via `open(2)` and `errno` | `FullDiskAccess.swift` |
| Lexicon model and on-device prefilter (`NSRegularExpression`, case-insensitive; mirrors the TypeScript `prefilter()`) | `Lexicon.swift`, `Prefilter.swift` |
| Capture client with timeouts and backoff (retries 5xx, 429 and network errors; never other 4xx); status check and key verification | `WitnessClient.swift` |
| Scan loop, cursor (atomic JSON) and the lookback | `MessageScanner.swift`, `CursorStore.swift` |
| `chat.db-wal` watcher with debounce and safety timer | `ChatDatabaseWatcher.swift` |
| Config, Keychain token store | `Config.swift`, `TokenStore.swift` |
| Contacts names: handle normalization, lookup table, cache refreshed on change | `ContactsResolver.swift` |
| Setup state machine (no UI), server check and save, Full Disk Access step, login item state | `SetupFlow.swift` |
| App settings, pause and counts on disk | `AppState.swift` |
| Background engine for the app: watching, pause and resume, 401 and `EPERM` handling, status | `CollectorEngine.swift` |
| CLI parsing and commands | `CLICommand.swift`, `CLIRunner.swift`, `Sources/witness-mac/` |
| Menu-bar app (SwiftUI `MenuBarExtra`, setup window, Muse Nexus styling) | `Sources/WitnessMenuBar/` |
| Bundle metadata, entitlements, build and icon scripts | `App/`, `scripts/` |

A few decisions worth knowing:

- **The cursor only moves past a message once it is dealt with.** If your
  Witness cannot be reached, or the address answers like something other than
  Witness (404, 405, an answer that is not Witness's JSON), the scan stops and
  the next one resumes at the first unsent candidate. Only a message the server
  read and turned down (400, 413, 422) is skipped so it cannot block the rest.
- **New messages wait three minutes.** Messages lets a sender unsend a text for
  two minutes (and edit it). A candidate younger than three minutes is not sent
  yet: the scan stops before it, and Witness looks again when it may go. By
  then an unsent message is skipped and an edited one is sent as it now reads.
- **A rebuilt `chat.db` starts again.** If the saved cursor is past the newest
  row (Messages deleted and resynced, or a backup restored), the cursor starts
  fresh from the lookback instead of skipping everything new.
- **Late history is ignored.** Messages in iCloud can add years-old messages
  with new row numbers. Anything dated before the first scan's lookback window
  is never sent.
- **The UI has no logic worth testing on its own.** Everything the app decides
  (the setup steps, the server check, when to pause, the counts) lives in
  `WitnessMacCore` and is tested there; the SwiftUI target only shows it.
- **`attributedBody` decoding is clean-room.** `TypedStreamText` was written
  from first principles by archiving strings with `NSArchiver` and reading the
  bytes. It reads only as far as the first string, bounds-checks every read,
  and returns nothing rather than guessing on anything it does not recognise.
  No code from other typedstream projects was consulted or used.
- **The prefilter agrees with the TypeScript reference.** It folds curly
  quotes, compiles phrases exactly like `phraseSource()` (whole words, any
  whitespace, optional apostrophes, "-" = hyphen, space or nothing), applies the
  same handle rules, and translates each regex so ICU behaves like JavaScript's
  non-Unicode mode (`\b`, `\w`, `\d` ASCII-only, `.` and `$` as in JavaScript).
  `PrefilterParityTests` runs the real `lexicon.json` over
  `packages/detector/test/fixtures/prefilter-parity.json` (every synthetic text
  message in the detector corpus, some email bodies and edge cases, written by
  `bun run parity` in `packages/detector`) and requires the same pass or stay
  decision for every case. There are no known differences.
- **No dependencies.** Only Apple frameworks and the system SQLite.

### Tests

`swift test` builds a synthetic `chat.db` from the real schema in a temporary
directory, with fictional rows only (`555-01xx` numbers, `example.com`
addresses): text rows, `attributedBody`-only rows, messages from you, tapbacks,
unsent messages, group and direct chats, short codes and one-time codes.
`attributedBody` blobs are produced in the test with `NSArchiver`, including
emoji, CJK and 70,000-byte messages, and the decoder is fuzzed with random,
truncated and mutated input. Network calls go to a mock transport, the
Keychain is replaced with an in-memory store, and Contacts with in-memory
cards. The M2 tests cover the names lookup and its cache, the setup state
machine, the server check (status, capture-only keys, refused keys, and
nothing saved for an unreachable, unknown or untrusted address), the key tied
to its address (a changed `config.json` stops sending), a release app ignoring
its environment, pause and resume across restarts (in the middle of a check,
and while a send waits to retry), names turned off mid-check, numbers with
different country codes, the lookback choices, 401 and `EPERM` handling, the
product voice (no exclamation marks), and the bundle's `Info.plist` and
entitlements, including `build-app.sh --lint`. Tests
never read a real `chat.db` or your Contacts, and never touch your Keychain.

## Roadmap (M3)

- **Photos:** favorites and screenshots, each behind its own switch, off by
  default, with Photos access asked for only when one is turned on. Favorites
  are sent as the original image (HEIC kept as is) with `favorite: true`, so
  Witness saves them directly. Screenshots are read on the Mac with Vision
  text recognition, and only the text goes through the same prefilter.
- **A published download**, notarized, with quiet updates to the app and the
  lexicon.

## Getting help

If you are in crisis, call or text 988 (US) or visit
[findahelpline.com](https://findahelpline.com). Witness is not treatment.

Made by Muse Nexus in Hawaiʻi · Open source (MIT)
