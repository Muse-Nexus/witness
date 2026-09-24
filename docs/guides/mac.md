# Witness for Mac: pick up texts automatically

If your iPhone texts also arrive in Messages on your Mac, Witness for Mac can
notice kind ones as they come in and send just those messages to Witness. No
taps, no shortcuts.

**Status: M1, build from source.** Today Witness for Mac is a command-line tool
for people comfortable with Terminal. A menu-bar app with a guided setup,
Photos favorites and screenshots, and a signed download are planned for M2
(see the [roadmap](../../ROADMAP.md)). Until then, the
[iPhone Shortcut](iphone.md) needs no Mac at all.

## What it does, and what it doesn't

- It opens your Messages database **read-only**. It never changes, sends, or
  deletes anything in Messages.
- It looks only at **incoming** messages, after the last one it checked. It
  skips your own messages, reactions, retracted and empty messages. A new
  message waits three minutes before it is sent, so a text the sender unsends
  (Apple allows two minutes) is never kept.
- A local prefilter, using the same word lists as the Witness detector, drops
  anything that is clearly not evidence (codes, business senders, and messages
  with no kind cue at all) before anything leaves your Mac.
- It sends each remaining message on its own, never whole conversations, to
  Witness, where the full detector decides.
- Its output shows **counts only**, never message text.

## Requirements

- macOS 14 or later.
- Messages on this Mac signed in with the Apple Account your texts arrive on,
  with **Messages in iCloud** or text message forwarding turned on, so texts
  appear here.
- Swift 6 (install Xcode or run `xcode-select --install`).
- A Witness **device token**: in Witness, open **Setup → Texts & photos** and
  choose **Create a phone key** (the same kind of key works for the Mac; it is
  labeled "iPhone" in Settings). It starts with `wit_dev_` and can only send
  things to Witness, not read them. `witness-mac login` accepts the address
  shown next to it, and checks both before saving them.

## Build

```sh
git clone https://github.com/Muse-Nexus/proof-gallery.git witness
cd witness/apps/mac
swift build -c release
```

The tool is at `.build/release/witness-mac`. Set the Witness URL and your
device token as described in `apps/mac/README.md`.

## Give it Full Disk Access

macOS protects the Messages database, so the program that runs `witness-mac`
needs Full Disk Access.

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Turn on the app you run it from, such as **Terminal**. If it isn't listed,
   select **+** and add it.
3. Quit and reopen that app.

Full Disk Access applies to everything run from that app, which is a broad
permission. The planned M2 menu-bar app is meant to hold it for itself alone.

`witness-mac status` checks whether access is granted.

## Run

```sh
./.build/release/witness-mac status                 # checks Full Disk Access and setup
./.build/release/witness-mac scan --once --dry-run  # counts only, sends nothing
./.build/release/witness-mac scan --once            # sends candidates once
./.build/release/witness-mac run                    # keeps watching for new messages
```

Start with `--dry-run`. It prints how many messages it looked at and how many
would be sent, without sending anything or printing any text.

`run` watches for new messages and checks a few seconds after they arrive.
It runs while its Terminal window is open. Starting automatically at login
comes with the M2 menu-bar app.

## Stopping

Press Control-C, revoke the device token in Witness under **Settings**, and
turn off Full Disk Access for the app you used.

## For contributors

The package is `apps/mac` (Swift 6, `WitnessMacCore` plus the `witness-mac`
tool). Tests build a synthetic Messages database and synthetic message blobs
in the test itself. Never point tests or examples at a real Messages database.
Run `swift test` in `apps/mac`.
