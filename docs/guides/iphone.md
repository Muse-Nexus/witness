# iPhone: send texts and screenshots to Witness

An iPhone app cannot read your Messages in the background, so Witness uses
Apple's Shortcuts app instead. There are two parts:

1. **A "Send to Witness" shortcut** in the share sheet. When someone sends you
   something kind, share it to Witness in two taps. This is the reliable part.
2. **Optional message automations** that send incoming messages containing a
   few cue words, with no taps at all.

If you have a Mac, [Witness for Mac](mac.md) can pick up texts automatically
instead.

You need your Witness URL and a **device token**. In Witness, open
**Setup → Texts & photos** and create a device token for this iPhone. It starts
with `wit_dev_` and is shown once, so keep the page open while you build the
shortcut. A device token can send things to Witness; it cannot read anything
back.

Below, `https://witness.example.com` stands for your Witness URL.

> Written for iOS 18 and later in September 2026, from Apple's documentation
> and independent guides. We have not yet tested every step on a device, and
> Apple changes Shortcuts labels from time to time. Steps marked
> **Not verified** are ones we could not confirm.

## Part 1: the "Send to Witness" shortcut (text)

1. Open **Shortcuts** and tap **+** to make a new shortcut. Name it
   `Send to Witness`.
2. Open the shortcut's details (tap its name at the top, or the **ⓘ** button,
   depending on your iOS version) and turn on **Show in Share Sheet**.
3. The shortcut now starts with **Receive … input from Share Sheet**. Tap the
   input types and choose only **Text**. Set **If there's no input** to
   **Get Clipboard**, so the shortcut also works on text you have copied.
   (Not verified: that **Get Clipboard** is offered there on every iOS version.
   If it isn't, the shortcut still works from the share sheet.)
4. Add the action **Get Contents of URL**. Set:
   - URL: `https://witness.example.com/api/v1/capture`
   - **Method**: `POST`
   - **Headers**: add `Authorization` with value `Bearer wit_dev_…` (your
     token), and `Content-Type` with value `application/json`.
   - **Request Body**: **JSON**, with these fields:

     | Key | Type | Value |
     |---|---|---|
     | `sourceType` | Text | `text` |
     | `text` | Text | the **Shortcut Input** variable |
     | `sourceLabel` | Text | `iPhone` |
     | `shared` | Boolean | `true` |

   `shared` tells Witness you chose this one yourself, so it is always kept:
   saved when the detector is sure, otherwise in "maybe". Leave it out of
   automations (Part 2).
5. Optional: add **Get Dictionary Value** for the key `status` from
   **Contents of URL**, then **Show Notification** with that value, so you see
   `saved` or `maybe`.

To use it:

- **From Messages:** touch and hold the message, tap **Copy**, then run
  **Send to Witness**. The quickest ways to run it are a Home Screen icon, the
  Shortcuts widget, the Action Button, or Back Tap (**Settings → Accessibility
  → Touch → Back Tap**).
- **From apps with a Share button** (Mail, Notes, a selected passage of text):
  tap **Share** and choose **Send to Witness**.

## Part 1b: screenshots and photos

Make a second shortcut, `Send image to Witness`, the same way, with these
differences:

1. In **Receive … input from Share Sheet**, choose only **Images**.
2. Before **Get Contents of URL**, add:
   - **Convert Image** to **JPEG**, so HEIC photos are converted.
   - **Resize Image** to a width of `2048`, to stay under Witness's 10 MB limit.
   - **Base64 Encode** the resized image, with **Line Breaks** set to
     **None**. (Not verified: the name of the line-break option.)
3. In the JSON body, set `sourceType` to `screenshot` (or `photo`), keep
   `sourceLabel` and `shared`, and add a field `image` of type **Dictionary** with:
   - `base64`: the **Base64 Encoded** variable
   - `mediaType`: `image/jpeg`

Images without text usually go to "maybe" so a person, not a guess, decides
what they mean. Nothing reminds you about them.

A screenshot is kept as the whole image you send. If it shows a conversation,
everyone's messages in it are kept too, so crop it to the kind part before you
share it (in the screenshot editor, drag the corners).

## Part 2: optional message automations

These run when a message arrives that contains a phrase you choose. They need
no taps, but they only see messages that contain those exact phrases.

1. In **Shortcuts**, open **Automation** and tap **+** (or **New Automation**).
2. Choose **Message**.
3. Choose the **Sender**s whose kind words you want kept, and set **Message
   Contains** to one phrase, for example `proud of you`. Choosing senders is
   safer than leaving it empty: an automation for anyone also sends a
   controlling "I love you" from someone you would rather not hear from.
4. Choose **Run Immediately**. You can turn off **Notify When Run**.
5. Tap **Next**, then **New Blank Automation**, and add **Get Contents of URL**
   as in Part 1, with `sourceLabel` set to `iPhone Messages` and without
   `shared`. For the `text` field, tap **Shortcut Input** and choose
   **Content**, so the message text is sent rather than the message object.
   Add a field `fromHandle` with **Shortcut Input → Sender**: with the sender
   included, "Never save from this sender" works for these texts (Witness keeps
   only a keyed hash of it).
6. Repeat for a few more phrases, such as `thank you`, `love you`,
   `so grateful`.

Witness's detector still decides. A message that merely contains "thank you"
("thank you for your order") is excluded and not stored.

What we could and could not confirm:

- **Confirmed by several independent guides** (Apple's own documentation does
  not cover it): the Message trigger offers **Sender** and **Message Contains**,
  and message automations can be set to **Run Immediately** without asking.
- **Reported, not verified**: at least one of **Sender** or **Message
  Contains** must be set, so an automation cannot send every message. Either
  way, set a phrase.
- **Not verified**: whether **Message Contains** is case-sensitive, and
  whether it accepts more than one phrase. We suggest one automation per
  phrase.
- **Not verified**: whether **Shortcut Input** offers the sender's name or
  number on every iOS version. If yours offers **Sender**, send it as
  `fromHandle` (and as `fromName` if it is a name). Without it, Witness cannot
  block that sender for you, so choose senders in step 3, or block their
  number ahead of time in **Settings → Never save from**.
- **Not verified**: whether automations run reliably while the iPhone is locked
  or in Low Power Mode.

## Privacy

The shortcut sends only what you share, and each automation sends only
messages containing its phrase. Nothing is sent from Witness to your iPhone.
Your device token lives inside the shortcut; if you share the shortcut with
anyone, remove the token first. To stop, delete the shortcut and automations
and revoke the token in Witness under **Settings**.

## Test it

Share a kind, made-up sentence such as `I'm so proud of you for finishing the
course.` to **Send to Witness**. **Setup → Texts & photos** shows when Witness
last received something.
