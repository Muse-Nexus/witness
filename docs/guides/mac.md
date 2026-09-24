# Witness for Mac: pick up texts automatically

If your iPhone texts also arrive in Messages on your Mac, Witness for Mac can
notice kind ones as they come in and send just those messages to Witness. No
taps, no shortcuts.

**Status: M2, a menu-bar app.** Witness for Mac is a small app that lives in
your menu bar, with a short setup. There is no public download yet: for now
you build it from source (below), which takes a few minutes. Photos favorites
and screenshots come in M3 (see the [roadmap](../../ROADMAP.md)). The
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
- The menu bar shows **how it is doing**: connected or not, whether it can
  read Messages, and when it last checked. It never shows message text or who
  sent anything, and it does not count what it sent.

## Requirements

- macOS 14 or later.
- Messages on this Mac signed in with the Apple Account your texts arrive on,
  with **Messages in iCloud** or text message forwarding turned on, so texts
  appear here.
- A Witness **phone key**: in Witness, open **Setup → Texts & photos** and
  choose **Create a phone key**. The same kind of key works for the Mac. It
  starts with `wit_dev_` and can only send things to Witness, never read them.
  It is shown once, so keep the page open until you have pasted it.
- To build it: Xcode 16 or later (Swift 6).

## Get the app

```sh
git clone https://github.com/Muse-Nexus/witness.git
cd witness/apps/mac
scripts/build-app.sh
```

This makes `.build/Witness-0.2.0.dmg`. Open it and drag **Witness** into
**Applications**, then open Witness from Applications. (Keep it in
Applications: Full Disk Access and start at login are tied to where the app
is.)

An app you build yourself opens on your Mac without a warning. Without a
Developer ID of your own, the script signs it for this Mac only, and says so.

## Set it up

Witness appears in the menu bar as an opening quotation mark, and a setup
window opens. Each step can be skipped and done later from **Settings…** in
the menu.

1. **Connect to your Witness.** The address is filled in
   (`https://witness.musenexus.studio`; change it if you host your own). Paste
   your phone key and choose **Check and save**. Witness checks the address and
   key before saving anything, and keeps the key in your Keychain, for that
   address only. If Witness cannot be reached just then, nothing is saved:
   choose **Check and save** again when you are online. If you do not have a
   key yet, **Open Witness to make a key** takes you to the right page.
2. **Let Witness read Messages.** Messages keeps your texts in a protected
   file, so macOS asks you to allow Full Disk Access:
   1. Choose **Open System Settings**. It opens **Privacy & Security → Full
      Disk Access**.
   2. Turn on **Witness**. If it is not in the list, drag the Witness icon
      from the setup window into the list (or select **+** and choose it in
      Applications).
   3. Back in the setup window, a check mark appears when access works. If
      macOS asks to quit and reopen Witness, or the screen offers **Relaunch
      Witness**, do that: macOS applies the change when the app opens again.
3. **Show who said it (optional).** Witness can look up the sender in your
   Contacts so a kept message shows their name. Your contacts stay on this
   Mac: only the name of the person who sent a kept message goes with it.
   macOS gives an app all of your contacts or none.
4. **Start with your Mac.** Turn on **Open Witness at login** if you want it
   to keep running after a restart. It is off unless you turn it on. If macOS
   asks you to approve it, **Allow it in System Settings** opens the right
   page.
5. **How far back to look.** The first check looks at the past 30 days. You
   can choose 7 or 90 instead. Older messages stay on your Mac.

Close the window, and Witness starts checking. It checks a few seconds after
new messages arrive, and every 10 minutes.

## Day to day

Click the quotation mark in the menu bar to see how it is doing:

- **Check now** looks for new messages right away.
- **Pause** stops it until you choose **Resume**, even after a restart.
- **Open Witness** opens your Witness in the browser.
- **Settings…** opens any setup step again.

If Witness pauses by itself, the menu says why and offers the fix:

- **The key was not accepted** (for example, you revoked it in Witness
  Settings): choose **Add a key** and paste a new one. Nothing is skipped.
- **Witness can't read Messages** (Full Disk Access was turned off): choose
  **Turn on Messages access**. It resumes by itself once access is back.

If the menu says **The key is for a different address**, the saved address
changed after the key was saved, so Witness sends nothing. Choose **Add a
key** and save a key for the address you want.

## Stopping

Choose **Pause**, or **Quit Witness** in the menu. To stop for good, revoke
the key in Witness under **Settings → Assistants and devices**, turn off Full
Disk Access (and Contacts, if you allowed it) for Witness in System Settings,
and move Witness from Applications to the Trash. Its settings are in
`~/Library/Application Support/Witness`, and its key is in your login
Keychain as `studio.musenexus.witness`.

## Prefer Terminal?

The command-line tool `witness-mac` is still there, for scripts and servers.
See [apps/mac/README.md](../../apps/mac/README.md#the-command-line-tool). Use
the app or the command-line tool on one Mac, not both at once.

## For contributors

The package is `apps/mac` (Swift 6): the `WitnessMacCore` library, the
`WitnessMenuBar` app and the `witness-mac` tool. Tests build a synthetic
Messages database and synthetic message blobs in the test itself, and use
made-up contact cards. Never point tests or examples at a real Messages
database or address book. Run `swift test` in `apps/mac`.

If you are in crisis, call or text 988 (US) or visit
[findahelpline.com](https://findahelpline.com). Witness is not treatment.
