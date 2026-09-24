# Safety

Witness exists for the days when your mind tells a story that isn't true. It
keeps concrete evidence of being loved, cared for, trusted, and capable, in
other people's exact words, and brings it back in ways you agreed to.

It is a support tool, not treatment. Because it reaches people on hard days,
these rules outrank convenience, engagement, and cleverness. A feature or
contribution that weakens them is out of scope, however helpful it looks.

## 1. Verbatim only

- Evidence is the other person's exact words, or the original image. Witness
  never paraphrases, summarizes, generates, translates, or "improves" it.
- Preserve the exact quote, the date, and where it came from (the source).
  If a date or a name is unknown, it stays unknown. Deliveries say
  "Date unknown" or "Someone" rather than guessing.
- If you edit a quote yourself, Witness marks the item as edited.
- An image can be the evidence on its own. Witness does not caption it, guess
  who is in it, or explain what it means.

## 2. Never argue with pain

Evidence is there to be found, not used against how you feel.

- Never say "but look how lucky you are", or anything like it.
- Never present evidence as proof that suffering is not real.
- Never rank a person's worth. No scores, levels, streaks, or badges.
- No guilt, urgency, cheerleading, or exclamation marks in product copy.
- Never tell the person how to feel. A delivery shows the quote, who, when, and
  where it came from. Nothing else.
- Never manufacture meaning. No invented stories, lessons, relationships,
  identities, or emotional conclusions.

## 3. Reach out only by consent

Witness contacts you in exactly two ways:

1. **The rhythm you set.** You choose the days and time while you are doing
   well. Witness records when you chose it, and every delivery says so. Each
   delivery has quiet links to skip the next one, pause for a week, remove that
   item, never save from that sender, or change the rhythm. Stopping takes one
   step: "Stop these emails" in any delivery, or your mail app's own
   Unsubscribe button, with no sign-in. Stop and pause links keep working in
   old emails.
2. **An assistant offer you accept.** An AI assistant connected over MCP may
   ask whether you would like to see something. The offer itself contains no
   evidence. The assistant can reveal one item only after you clearly say yes,
   only once, and only within 30 minutes. If you decline or seem unsure, the
   assistant is told to drop it for the rest of the conversation. Witness
   itself allows at most one offer a day, none for a week after an offer that
   went unanswered, and none while you have paused Witness.

   Search is separate and off by default: an assistant key can search what
   you kept only if you turned that on for it, and only when you ask it to
   find something. Witness cannot see the conversation, so "when you ask" is
   up to the assistant; turning search on is trusting it with that.

Witness never reaches out because of an inferred mood or detected distress. It
does not try to detect mood at all. It never messages anyone other than you.

## 4. Crisis first

- Every delivery and the app footer include a crisis line: in the US,
  call or text 988; elsewhere, [findahelpline.com](https://findahelpline.com).
- Assistant tool descriptions tell assistants to prioritize crisis resources
  and never to offer evidence to someone in acute crisis.

## 5. Never an empty-handed message

If there is nothing suitable to deliver, Witness sends nothing. It never tells
anyone they have "no proof", and it never sends a message just to say it has
nothing.

## 6. Automatic saving without nagging

- Saving is automatic so that nobody has to do anything on a hard day.
  Precision comes before recall: only clear evidence is saved automatically.
- Uncertain finds go to a "maybe" pile. Nobody has to look at it, and nothing
  in it is ever emailed. It is shown as a quiet link with no number, never a
  badge, count, alert, or reminder.
- Removing anything takes one tap. "Never save from this sender" asks once
  first, because it can take away a lot: it names the sender, says how many
  things are kept from them, and keeps those unless you choose to remove them.
  It works from a delivery email and from Settings too, before anything
  arrives.

## 7. Other people's words

Witness keeps words other people sent to you.

- Keep only the evidence (the message it came from), never whole threads.
- Support "never save from this sender", and delete on request.
- Show evidence only to the person it was sent to. There are no public
  galleries and no sharing features in v1.

## 8. What models may and may not do

Witness works without any AI model. An operator can turn on an optional model
judge for borderline cases. When it is on:

- It sees only the text of messages the rules already scored as borderline.
  It never sees images, or the text a phone reads out of one.
- It may only **classify** the text and **select a span**. It never writes
  words that anyone reads.
- Code checks that the returned span is an exact substring of the original.
  If it is not, the rules' span is used instead.
- It can never turn a rules exclusion into a save. It saves only when it is
  confident the text is evidence aimed at you.
- If it errors, the rules' verdict stands.
- It is never used to judge mood, risk, or worth.

## 9. Writing for Witness

Product copy is calm, plain, warm, and in the second person, with short
sentences. No therapy-speak, no "you've got this", no exclamation marks. Every
example, fixture, screenshot, and issue uses synthetic data with fictional
names.

People may read Witness on their worst day, so one idea gets one name. In the
app, in emails, and in the setup guides, use these words. Specs and code can
keep their technical names (evidence, rhythm, delivery, offer, token).

| Say | For | Not |
|---|---|---|
| Witness | the product, and only the product | "your Witness" for the account, "a witness" for an email |
| something you kept; **Kept** | a message or photo Witness holds on to, in the sender's exact words | evidence, proof, receipts, item |
| **Maybe** | things Witness was not sure about; never emailed, and nobody has to look | a count, "review", "pending" |
| your schedule; when Witness emails you | the days and time you chose | rhythm |
| Witness email | an email with one thing you kept | delivery, "your witness" |
| Skip the next one · Pause · Stop these emails | the ways to hold off | "Not today" |
| Never save from | stop keeping new things from a sender (they can still reach you) | block |
| Remove · Delete everything | one thing, for good · the whole account | |
| Download everything | the export | JSON (except in brackets) |
| your Witness email address | where you forward kind email | "Witness address" alone |
| Witness web address | the site, such as witness.musenexus.studio | "address" alone |
| assistant key · device key · Disconnect | access for one AI assistant or device, and taking it away | token, phone key, revoke |
| asks first | an AI assistant asking before it shows you anything | offer, reveal |
| encrypted when stored, not end-to-end | how things are protected | "yours alone", "private" with no caveat |

## Raising a concern

If you see Witness break one of these rules, please open an issue using
synthetic examples only, or write to hello@musenexus.studio. Safety reports are
prioritized like security reports.
