# ▍MUSE NEXUS · Witness for Mac

**Witness.** *A witness to your life.*

Witness for Mac is the Messages collector for
[Muse Nexus Witness](../../README.md). It watches the Messages app on your Mac
for the kind things people text you (the thank-you, the "proud of you", the
"you made my day") and passes those, one message at a time, to your Witness.
Your Witness then decides what to keep and brings one back on the rhythm you
chose.

You set it up once. After that it needs nothing from you.

This is milestone 1: a Swift library and a command-line tool (`witness-mac`).
A menu-bar app with guided setup comes next (see [Roadmap](#roadmap-m2)).

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

The first scan looks back 30 days (change it with `--lookback-days`), so a
lifetime of history is never uploaded without you choosing it.

## Privacy

- **Only candidate messages leave your Mac.** For each one it sends the text
  of that single message, the sender's phone number or email, when it was
  sent, the service (iMessage, SMS or RCS), whether it was a direct or group
  conversation, and Messages' own ID for it (so the server can skip
  duplicates). Never whole threads, never attachments, never your own
  messages, never your contacts.
- **Everything else stays on your Mac.** Messages without a positive cue, and
  anything excluded, are not sent in any form, not even as counts.
- **Read-only.** Witness opens `chat.db` in read-only mode and cannot change it.
- **Nothing is printed.** `witness-mac` prints counts and settings only. It
  never shows message text, and never shows your device token.
- **What it stores locally:** the server address in
  `~/Library/Application Support/Witness/config.json`, the scan position (a row
  number and two dates) in `cursor.json` next to it, and the device token in
  your login Keychain (service `studio.musenexus.witness`, this Mac only, never
  synced).
- On your Witness, evidence is encrypted at rest and you can remove any item,
  block a sender, export or delete everything. See [Privacy](../../docs/PRIVACY.md).

## Build and run from source

You need macOS 14 or later and Xcode 16 or later (Swift 6).

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

macOS protects `chat.db`, so Witness needs Full Disk Access.

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
turns it down with 400, so nothing is added): a refused key or an address that
is not a Witness is reported and nothing is saved; if the server cannot be
reached right now, the sign-in is saved and the next scan tries again.

After a rebuild, macOS may ask whether `witness-mac` can use the saved token in
your Keychain. Choose **Always Allow**.

### 3. Point it at the lexicon

When run from this repository, `witness-mac` finds
`packages/detector/lexicon.json` on its own: it looks in the current folder and
every folder above it, then in the checkout it was built from. If you copied the
binary elsewhere, either pass `--lexicon <path>`, set `WITNESS_LEXICON=<path>`,
or copy the file to `~/Library/Application Support/Witness/lexicon.json`.
`witness-mac status` compiles every rule and says how many did, so a pattern
the Mac cannot read shows up there rather than on the first scan.

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

#### Keep it running in the background (optional)

Until the menu-bar app arrives, a LaunchAgent can keep `run` going. Grant Full
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

## Commands

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

Environment variables, mostly for tests and scripts:

| Variable | Effect |
| --- | --- |
| `WITNESS_LEXICON` | `lexicon.json` to use when `--lexicon` is not given |
| `WITNESS_SUPPORT_DIR` | Folder for `config.json` and `cursor.json` instead of `~/Library/Application Support/Witness` |
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
| Capture client with timeouts and backoff (retries 5xx, 429 and network errors; never other 4xx) | `WitnessClient.swift` |
| Scan loop, cursor (atomic JSON) and the 30-day lookback | `MessageScanner.swift`, `CursorStore.swift` |
| `chat.db-wal` watcher with debounce and safety timer | `ChatDatabaseWatcher.swift` |
| Config, Keychain token store | `Config.swift`, `TokenStore.swift` |
| CLI parsing and commands | `CLICommand.swift`, `CLIRunner.swift`, `Sources/witness-mac/` |

A few decisions worth knowing:

- **The cursor only moves past a message once it is dealt with.** If your
  Witness cannot be reached, or the address answers like something other than
  Witness (404, 405, an answer that is not Witness's JSON), the scan stops and
  the next one resumes at the first unsent candidate. Only a message the server
  read and turned down (400, 413, 422) is skipped so it cannot block the rest.
- **New messages wait three minutes.** Messages lets a sender unsend a text for
  two minutes (and edit it). A candidate younger than three minutes is not sent
  yet: the scan stops before it, `run` looks again when it may go, and by then
  an unsent message is skipped and an edited one is sent as it now reads.
- **A rebuilt `chat.db` starts again.** If the saved cursor is past the newest
  row (Messages deleted and resynced, or a backup restored), the cursor starts
  fresh from the lookback instead of skipping everything new.
- **Late history is ignored.** Messages in iCloud can add years-old messages
  with new row numbers. Anything dated before the first scan's lookback window
  is never sent.
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
truncated and mutated input. Network calls go to a mock transport and the
Keychain is replaced with an in-memory store. Tests never read a real
`chat.db`, and never touch your Keychain.

## Roadmap (M2)

- **Menu-bar app** that starts at login, with a one-screen onboarding: a button
  that opens the Full Disk Access page, and a check that notices when access
  is granted.
- **Photos:** favorites and screenshots, read with PhotoKit, with on-device
  text recognition (Vision) so a screenshot of a kind message can be kept.
  Favorites from this Mac count as trusted and are saved directly.
- **Names on device:** optional Contacts lookup so a kept message shows who
  sent it, without the address book ever leaving the Mac.
- **Signing and notarization** (Developer ID, hardened runtime) and a
  downloadable build, so nobody has to build from source.
- **Bundled lexicon** as a package resource, and quiet updates to it.

## Getting help

If you are in crisis, call or text 988 (US) or visit
[findahelpline.com](https://findahelpline.com). Witness is not treatment.

Made by Muse Nexus in Hawaiʻi · Open source (MIT)
