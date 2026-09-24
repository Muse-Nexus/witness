# iPhone: send texts and screenshots to Witness

An iPhone app cannot read your Messages in the background, so Witness uses
Apple's Shortcuts app instead. There are two ready-made shortcuts, each added
in one tap:

1. **Send to Witness**, for text. When someone sends you something kind, share
   it to Witness, or copy it and run the shortcut.
2. **Send image to Witness**, for screenshots and photos.

Optional **message automations** can also send incoming messages that contain a
few cue words, with no taps at all.

If you have a Mac, [Witness for Mac](mac.md) can pick up texts automatically
instead.

> Written in September 2026 for iOS 18 and later. The shortcut files are built
> and signed by `scripts/shortcuts/build.mjs`, which opens each signed file
> again to check what it sends, and the end-to-end test sends exactly that
> request to a real Witness. **We have not yet added or run them on an iPhone.**
> Apple also changes Shortcuts labels from time to time. Steps marked
> **Not verified** are ones we could not confirm on a device.

## Add the shortcuts

You need a **phone key**. It starts with `wit_dev_`, is shown once, and can add
things to Witness but never read them.

1. On your iPhone, open Witness in Safari and go to **Set up → Texts & photos**.
2. Tap **Create a phone key**, then **Copy**.
3. Next to **Send to Witness**, tap **Add to iPhone**.
   (Not verified: whether Safari opens Shortcuts straight away or first asks to
   download the file. If it downloads, tap **Download**, then open the file from
   the downloads button in the address bar, or from **Files → Downloads**.)
4. Shortcuts shows the shortcut and what it does. Tap **Add Shortcut**, then
   paste your key when it asks.
   (Not verified: the exact button labels on every iOS version.)
5. Do the same for **Send image to Witness**. The same key works for both.

The first time each shortcut runs, Shortcuts may ask whether it may connect to
your Witness. Choose **Allow** (or **Always Allow**, so it does not ask again).
(Not verified: the wording of this prompt.)

On a Mac with Shortcuts (macOS 12 or later), the same **Add to iPhone** buttons
add the shortcuts on the Mac. With iCloud on, Shortcuts can sync them to your
iPhone. (Not verified.)

**Set up** offers the ready-made shortcuts only on the Witness they were built for
(`witness.musenexus.studio`). On a self-hosted Witness, ask whoever runs it to
[make ready-made ones](#make-ready-made-shortcuts-for-your-own-witness), or
[build them yourself](#build-them-yourself).

### What they do

You can read every action before you add a shortcut, and afterwards in the
Shortcuts app.

- **Send to Witness** takes text from the share sheet. Run on its own, it uses
  what you last copied. It sends that text, and nothing else, with
  `"sourceType": "text"`, `"sourceLabel": "iPhone"` and `"shared": true`.
- **Send image to Witness** takes images from the share sheet and sends each
  original file in its own request, Base64-encoded with no line breaks. It never converts or
  resizes the picture: Witness keeps it exactly as you send it, HEIC included,
  up to 10 MB. The request labels it `image/heic`; Witness reads the real type
  from the file itself, so a PNG screenshot is kept as a PNG.
- Both keep your phone key in a **Text** action at the top, set it as the
  variable `WitnessKey`, and use it only in the `Authorization: Bearer …`
  header of one request to `/api/v1/capture` on your Witness. Nothing is read
  back except the result.
- Each shows one notification: **Kept.**, **Kept in Maybe.**, or **This did not
  reach Witness. Try again in a moment, or check the phone key in this
  shortcut.**

`shared` tells Witness you chose this one yourself, so it is always kept: saved
when the detector is sure, otherwise in Maybe. Automations leave it out.

## Use them

- **From Messages:** touch and hold the message, tap **Copy**, then run
  **Send to Witness**. The quickest ways to run it are a Home Screen icon, the
  Shortcuts widget, the Action Button, or Back Tap (**Settings → Accessibility
  → Touch → Back Tap**).
- **From apps with a Share button** (Mail, Notes, a selected passage of text):
  tap **Share** and choose **Send to Witness**.
- **A screenshot:** tap the thumbnail after you take it, crop it to the kind
  part (drag the corners), then tap **Share** and choose **Send image to
  Witness**.
- **A photo:** in Photos, tap **Share** and choose **Send image to Witness**.
  If you share several, each one is sent on its own, with its own
  notification. (Not verified: that a HEIC photo from the library is sent as
  the original HEIC file rather than a converted copy.)

A screenshot is kept as the whole image you send. If it shows a conversation,
everyone's messages in it are kept too, so crop it to the kind part first.

Images without text usually go to Maybe so a person, not a guess, decides what
they mean. Nothing reminds you about them.

## Build them yourself

If your Witness has no ready-made shortcuts, or you would rather make every
step yourself, build them by hand. Below, `https://witness.example.com` stands
for your Witness URL; **Set up → Texts & photos** shows the exact address after
you create a phone key.

### Send to Witness (text)

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
     key), and `Content-Type` with value `application/json`.
   - **Request Body**: **JSON**, with these fields:

     | Key | Type | Value |
     |---|---|---|
     | `sourceType` | Text | `text` |
     | `text` | Text | the **Shortcut Input** variable |
     | `sourceLabel` | Text | `iPhone` |
     | `shared` | Boolean | `true` |

5. Optional: add **Get Dictionary Value** for the key `status` from
   **Contents of URL**, then **Show Notification** with that value, so you see
   `saved` or `maybe`.

### Send image to Witness

Make a second shortcut, `Send image to Witness`, the same way, with these
differences:

1. In **Receive … input from Share Sheet**, choose only **Images**.
2. Before **Get Contents of URL**, add **Base64 Encode** of the shortcut input,
   with **Line Breaks** set to **None**. (Not verified: the name of the
   line-break option.) Do not convert or resize the image.
3. In the JSON body, set `sourceType` to `screenshot` (or `photo`), keep
   `sourceLabel` and `shared`, and add a field `image` of type **Dictionary** with:
   - `base64`: the **Base64 Encoded** variable
   - `mediaType`: `image/heic`

## Optional: message automations

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
   as in [Build them yourself](#send-to-witness-text), with `sourceLabel` set to
   `iPhone Messages` and without `shared`. For the `text` field, tap **Shortcut
   Input** and choose **Content**, so the message text is sent rather than the
   message object. Add a field `fromHandle` with **Shortcut Input → Sender**:
   with the sender included, "Never save from this sender" works for these
   texts (Witness keeps only a keyed hash of it).
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

## Make ready-made shortcuts for your own Witness

The files in `apps/web/public/shortcuts/` send to `witness.musenexus.studio`.
To offer one-tap shortcuts on your own Witness, build and sign your own on a Mac
(macOS 12 or later, signed in to iCloud), then build and deploy the app again:

```sh
bun run shortcuts --app-url https://witness.example.com
```

The script writes both shortcuts as property lists, checks them with
`plutil -lint`, signs them with `shortcuts sign --mode anyone`, opens each
signed file again to check that it still sends the right request and holds no
key, and records your URL in `apps/web/src/lib/shortcuts.json` so Set up offers
them. The files hold no key: each one asks for it when it is added.

Apple's signing certificate lasts about a year, and the script prints its end
date. Run it again before then. (Not verified: whether iOS refuses a shortcut
file after its certificate ends.) To read the files without signing, use
`bun run shortcuts --unsigned --out /tmp/witness-shortcuts`.

## Privacy

The shortcuts send only what you share, and each automation sends only
messages containing its phrase. Nothing is sent from Witness to your iPhone
except the result of each send. Your phone key lives inside each shortcut, in
the Text action at the top; if you share a shortcut with anyone, remove the key
first. To stop, delete the shortcuts and automations and revoke the key in
Witness under **Settings**.

## Test it

Share a kind, made-up sentence such as `I'm so proud of you for finishing the
course.` to **Send to Witness**. You should see **Kept.** or **Kept in
Maybe.**, and the sentence appears in Witness, or in Maybe.
