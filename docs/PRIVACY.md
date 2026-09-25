# Privacy

This page explains, in plain language, what Witness keeps, where it goes, and
who can read it. It describes the software as designed for v1, which is in
active development and not yet deployed. Whoever runs a Witness instance (Muse
Nexus for the hosted service, or you if you self-host) is called the
**operator** below.

## The short version

- Witness keeps evidence snippets, not your whole inbox or whole conversations.
- Evidence text and images are encrypted at rest with a key for each person.
- This is **not end-to-end encryption.** The operator's server holds the master
  key, so the service's code can decrypt your evidence to show it to you,
  deliver it, search it, and export it.
- No analytics on content, no ads, no selling data, no training on your data.
- You can export everything or delete everything at any time.
- If you want full control, you can run your own copy.

## What Witness stores

**About you:** your email address, an optional display name, your timezone,
your private inbound email address, any extra addresses you allow to forward
to it, and your rhythm settings (days, time, when you chose them).

**For each saved or "maybe" item:**

| Stored | Encrypted at rest |
|---|---|
| The quote (the evidence span, in the sender's exact words) | yes |
| Context from the same message | yes |
| The sender's display name | yes |
| An attached image | yes |
| A keyed hash of the sender's handle, used only for "never save from this sender" | hashed, not reversible without the server key |
| Two keyed hashes of the message (or its source id) and of its text, used only to avoid keeping the same thing twice | hashed with a key per person; a copy of the database without the server key cannot be used to check guessed words |
| Date it happened, source type and label (for example "Email"), category, detector score and rule names (no text), status, delivery dates and counts | no |

**Not stored:** messages the detector excludes. For those, Witness keeps only
a content-free record of the outcome (for example "excluded: newsletter") so
the setup page can show that a source is working. Witness never collects
whole email threads or whole text conversations. One exception is yours to
make: a screenshot or photo is kept as the whole image you send, so a
screenshot of a conversation keeps everyone's messages that are in it. Crop it
to the kind part first.

**Access tokens and sign-in links** are stored only as hashes.

## How encryption works, and its limits

Each person's data key is derived from a server-held master key. Evidence text
and images are encrypted with AES-GCM before they are written to the database
(Cloudflare D1) or file storage (Cloudflare R2).

This protects your evidence if the database or storage is exposed on its own,
for example a leaked backup without the key. It does not protect it from the
operator, or from anyone who gains control of the running service and its
master key. The server has to decrypt your evidence to put it in a delivery
email, show it in the app, search it, or hand it to an assistant you said yes
to. Choose an operator you trust, or run your own.

## What leaves your devices

- **Email:** only the messages your forwarding rule sends. Witness gives you a
  filter that forwards likely-kind messages, not your whole inbox.
- **iPhone:** only what you share to the Witness Shortcut, or messages that
  match the cue words in automations you set up.
- **Witness for Mac:** it reads your Messages database on your Mac. It sends
  the server only individual incoming messages that pass a local prefilter,
  one message at a time. It never sends your own messages or whole
  conversations. Its menu shows states only, and its command-line output shows
  counts, never message text. Its key is sent only to the Witness address it
  was saved for. If you turn on names, it reads your Contacts on the Mac and
  sends only the name you saved for the sender of a message it is already
  sending; your address book stays on the Mac.
- **AI assistants:** status and offer calls return no evidence. An item is sent
  to your assistant only after you say yes to an offer, or when you ask it to
  search (search is off for a new assistant key unless you turn it on). Witness
  never asks an assistant for your conversation and does not want it. From there, the assistant's provider handles it under that provider's
  terms.

## The optional model judge

By default no AI model is involved. An operator can turn on a model judge
(Anthropic's API, default model Claude Haiku) to help with borderline
messages. When it is on, the text of borderline messages, along with the
subject line and sender's display name if present, is sent to Anthropic for
classification. Images are never sent, and neither is the text your iPhone reads
out of a screenshot or photo you share: that is everything that was on the
screen, so the rules alone score it. Clear saves and clear exclusions never
reach the model. Anthropic handles that text under its agreement with the
operator.

Operators should tell their users whether the judge is on. If you self-host,
it stays off unless you set it up.

## Deliveries

A rhythm delivery is an email to you. It contains one quote, who sent it, when,
and the source, so it passes through the operator's mail sender and your own
email provider. The subject line never contains evidence. Images are shown
through a signed link that expires after 7 days.

## Service logs and other requests

- **Logs.** The service runs on Cloudflare Workers with Workers Logs turned on.
  For each request, Cloudflare keeps details such as the time, the path, the
  status and the network information it attaches (for example your IP address
  and rough location), for a few days (at the time of writing, 3 days on the
  free plan and 7 on paid plans). Tokens in links (sign-in, delivery and image
  links) are in the query string, which is removed from what is logged.
  Witness's own log lines name events and counts, never message text.
  Self-hosters control this with `observability` in `wrangler.jsonc`.
- **Fonts.** The web app and Witness's own pages load the Fraunces and Inter
  fonts from Google Fonts, so your browser asks Google for them, which tells
  Google your IP address and that you visited a Witness site (only the site's
  origin, never a page or a token). Emails load no fonts, images or pixels from
  anyone but the Witness image link for a delivery that has a picture.

## Export and delete

- **Export** downloads all your items as a JSON file, including images.
- **Remove** deletes one item and its image, whether you remove it in the app or from a
  delivery email. If image storage fails part-way, the item is already gone and Witness
  keeps deleting the image on its own until it is gone.
- **Delete account** deletes everything Witness holds for you: database rows
  and stored images. If image storage fails part-way, Witness keeps deleting
  your images on its own until they are gone.
- The operator's database has point-in-time recovery (Cloudflare D1 Time
  Travel), which keeps history for up to 30 days. Deleted data can remain in
  that history, with evidence still encrypted, until it ages out.

## Other people's words

Witness keeps things other people wrote to you. It keeps the message, never
the thread, and never shows it to anyone but you. You can stop saving from any
sender, and remove anything, at any time. If someone asks you to delete what
they wrote, you can.

## What Witness does not do

- No analytics or tracking on evidence content.
- No advertising, and no selling or sharing of data.
- No training of AI models on your data.
- No reading of your mailbox or accounts beyond what you forward or send.
- No contacting anyone but you.

## Run it yourself

Witness is open source under the MIT License. If you self-host, you are the
operator: the database, storage, master key, mail sender and model settings
are all yours. See [Self-hosting](SELF_HOSTING.md).

Questions: hello@musenexus.studio. Security reports: see
[SECURITY.md](../SECURITY.md).
