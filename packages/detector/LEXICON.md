# lexicon.json

`lexicon.json` is the data behind the Witness detector: the phrases and patterns
that suggest someone said something kind to you, the words that cancel or
qualify them, and the senders and messages that are never evidence. It is data,
not code, so three consumers share one file:

- **The TypeScript detector** (`src/`) uses all of it to score a message.
- **The Swift Mac helper** uses the hard exclusions plus "does any cue match" as a
  cheap prefilter before sending a message to the server (soft exclusions are
  skipped: the server weighs them against the words). `prefilter()` in
  `src/filters.ts` is the reference behavior, and it matches: the Mac translates
  each regex so ICU reads `\b`, `\w`, `\d`, `.` and `$` the way JavaScript
  (no `u` flag) does, and `bun run parity` writes
  `test/fixtures/prefilter-parity.json`, which the Swift tests check decision by
  decision against the real lexicon. After changing lexicon.json, run
  `bun run parity` (the detector tests fail while the fixture is stale), then
  `swift test` in `apps/mac`.
- **The setup wizard** turns `gmailFilterTerms` into the Gmail filter string
  (`gmailFilterQuery()` from `@witness/detector/gmail`, imported by the web app).
  Keep these to phrases aimed at the reader ("proud of you", "here for you").
  Single words and plain "thank you" or "congratulations" match receipts,
  support replies and newsletters; on a real inbox they buried the few kind
  notes under hundreds of them. The exclusions after the phrases
  (`GMAIL_FILTER_SUFFIX`) keep out sent mail, auto-replies, bulk and billing mail.
  Try any change in Gmail's search box before committing it.

You can tune it without touching code. Please read "Tuning safely" first.

## How matching works

These rules hold for every consumer.

1. **Folding.** Before matching, curly apostrophes (U+2018, U+2019, U+02BC)
   become `'` and curly double quotes (U+201C, U+201D) become `"`. Nothing else
   changes, so offsets still point into the original text.
2. **Case-insensitive.** Everything matches without regard to case.
3. **Phrases** (`"p"`) are literal. A phrase matches whole words at its edges,
   any run of whitespace matches a space, an apostrophe is optional
   (`can't` matches `cant`), and a hyphen matches a hyphen, a space or nothing
   (`well-deserved` matches `well deserved`). `phraseSource()` in
   `src/lexicon.ts` is the exact compilation.
4. **Patterns** (`"re"`) are regular expressions that must behave the same in
   JavaScript (flags `gi`, no `u`) and ICU (`NSRegularExpression`). The
   validator rejects anything that is not portable:
   - no lookbehind `(?<=` `(?<!`, no named groups, no inline flags `(?i)`, no
     atomic groups `(?>`, no possessive quantifiers `a++`;
   - no `\p{...}`, `\u{...}`, `\A`, `\z`, `\Q...\E` or other engine-specific escapes;
   - no nested `[` or `&&` or `--` inside a character class;
   - no emoji inside `[...]` and no quantifier right after an emoji (JS without
     `u` sees half a character). Write emoji as an alternation: `(🙄|😒)`;
   - a literal `{` or `}` must be escaped;
   - a group may not repeat without bound (`(so |really )*`, `(...)+`, `(...){2,}`):
     it rescans the chain from every word of a long message. Use `{0,4}`;
   - it must compile and must not match the empty string.

   Lookahead `(?=` `(?!`, non-capturing groups, `\b`, `\s`, `\d` and back
   references are fine. `^` and `$` anchor the whole text (no multiline flag).
   Patterns use a single literal space between words.

## Schema (version 1)

```jsonc
{
  "version": 1,
  "language": "en",
  // Regex for a second-person reference. A cue in a sentence with "you" is aimed at the reader.
  "secondPerson": "\\b(you|your|...)\\b",

  // Cues, per category (love, care, pride, gratitude, trust, belonging, accomplishment, recovery).
  "categories": {
    "gratitude": {
      "phrases":  [ { "p": "thank you so much", "w": 0.4, "implicit": true } ],
      "patterns": [ { "id": "couldnt_without_you", "re": "...", "w": 0.7 } ]
    }
  },

  // Added once each when they match anywhere, only if there is evidence. Capped by context.maxBoost.
  "boosters": [ { "id": "heart", "re": "(❤️|💕|<3)", "w": 0.08 } ],

  "dampeners": {
    "negation": ["not", "never", "don't", "no longer"],   // phrases, compiled like cue phrases
    "negationWindow": 3,                                   // words looked at before a cue
    "negationExceptions": ["can't believe", "not gonna lie"], // start with a negation word but do not negate
    "boilerplate":   [ { "id": "thanks_in_advance", "re": "..." } ],
    "transactional": [ { "id": "love_our_customers", "re": "..." } ],
    "notDirected":   [ { "id": "congrats_to_someone", "re": "..." } ],
    "sarcasm":       [ { "id": "eye_roll", "re": "(🙄|😒)" } ],
    "apology":       [ { "id": "sorry_i_hurt", "re": "..." } ],
    "rejection":     [ { "id": "not_moving_forward", "re": "..." } ],
    "coercion":      [ { "id": "you_owe_me", "re": "..." } ],     // optional
    "harm":          [ { "id": "self_harm", "re": "..." } ],      // optional
    "payment":       [ { "id": "person_paid", "re": "..." } ]     // optional
  },

  "exclusions": {
    // tested against "<name> <handle>". "soft": true marks a business-sounding signal
    // that a person's own mail can carry too (see "Hard and soft exclusions").
    "senderPatterns":  [ { "id": "noreply", "re": "..." }, { "id": "business_mailbox", "re": "...", "soft": true } ],
    "subjectPatterns": [ { "id": "order_status", "re": "...", "soft": true } ],
    "bodyPatterns":    [ { "id": "otp", "re": "..." } ],
    // Header names are lowercase. "*" = present; a list = value equals one of them;
    // {"not": [...]} = value is anything except these.
    "headers": { "list-unsubscribe": "*", "precedence": ["bulk", "list", "junk"], "auto-submitted": { "not": ["no"] } }
  },

  // Optional scoring knobs; defaults live in src/lexicon.ts (DEFAULT_CONTEXT).
  "context": {
    "directThread": 0.05,      // added for a one-to-one thread
    "groupThreadFactor": 0.8,  // multiplies the score in a group thread
    "undirectedFactor": 0.6,   // multiplies cue weights when no cue is aimed at the reader
    "supportFactor": 0.6,      // how much supporting cues add to the strongest one
    "maxBoost": 0.2,           // cap on the sum of boosters
    "subjectFactor": 0.5       // multiplies cues found only in an email subject
  },

  "gmailFilterTerms": ["\"proud of you\"", "\"love you\"", "\"here for you\""]
}
```

Field notes:

- **`w`** is in (0, 1]. Ids match `^[a-z0-9_]+$` and are unique within their list.
  A phrase's rule id is derived from its text (`gratitude/phrase:thank_you_so_much`),
  a pattern's from its `id` (`gratitude/couldnt_without_you`). Rule ids end up in
  stored `reasons`, never message text.
- **`implicit: true`** marks cues that address the reader even without "you":
  "congrats", "thanks", "well deserved", "happy birthday". Everything else needs a
  "you" in the cue or its sentence, or it counts as not directed.
- **Longest match wins.** A cue inside a longer cue is ignored, so
  "can't thank you enough" is scored once and "thank you" inside it is neither
  scored nor negation-checked. Use this to make a specific phrase override a
  generic one ("love you all" is weaker than "love you").
- **Neutralizing dampeners** (`boilerplate`, `transactional`, `notDirected`,
  `sarcasm`) cancel any cue they overlap: "thanks" inside "thanks in advance",
  "congrats" inside "congrats on your purchase", "congrats" inside "congrats to
  Priya", "thanks" inside "thanks for nothing". A `notDirected` match does not
  cancel a cue that itself contains "you".
- **Qualifying dampeners** (`sarcasm`, `apology`, `rejection`, `transactional`,
  `boilerplate`, `coercion`) add a caveat when they match anywhere and some evidence survives.
- **`coercion`** (optional) is control, guilt, insults, surveillance and love with
  conditions next to kind words: "you're nothing without me", "you owe me", "I need
  your location", "love you but you're a disappointment". It raises the blocking
  `coercion` caveat, and the quote keeps every coercive sentence in the message, so
  "I love you. You owe me." is never kept as a clean "I love you."
- **`harm`** (optional) is violence, threats, self-harm and farewell warnings ("I only
  hit you because", "answer me or I'm coming over", "I won't be around much longer").
  Any match excludes the whole message (`excludedBy: "harm:<id>"`), whatever kind
  words sit beside it. Manual adds are the one exception: the person chose them.
  Nothing else the person chooses (a share-sheet send, an assistant add, mail they
  forward themself) rescues a `harm` match.
- **`payment`** (optional) is a person paying the reader: "sending the last $300 for
  the website", "paid invoice #12", "Payment sent!", a payment note "for the mural".
  Being paid for your work is evidence, so it is kept, but it raises the `payment`
  caveat and a verdict that would save becomes `maybe`: the person confirms it. It
  does not lower the maybe floor, so "sending you $20 for my half" with a bare
  "thanks" stays excluded. The cue itself is `trust/paid_for_work` (someone paying
  for a named piece of work). Receipts, bills, subscriptions, order confirmations
  and a payment processor's own mail never reach this: stage 1 and `transactional`
  exclude them.
  The Mac prefilter ignores `coercion`, `harm` and `payment`; the server decides.
- **`negationExceptions`** also holds idioms where the negation word is the praise:
  "never gave up", "never let me down", "never left my side", "never judged",
  "never doubted". Cues for them live in `gratitude/never_gave_up_on_me`.

### Hard and soft exclusions

Exclusion rules come in two tiers.

- **Hard** (the default): bulk and automated mail, which is never evidence whatever it
  says. List headers, `auto-submitted`, no-reply/notification/newsletter senders,
  platform mail, one-time codes, unsubscribe and automated footers, marketing,
  prize spam, cold sales ("book a free call"), calendar invitations. A hard rule
  excludes the message before any scoring.
- **Soft** (`"soft": true`): business-sounding signals that a person's own mail can
  carry too. A client writing from info@, a colleague whose signature has a privacy
  policy link, a friend's subject "Your application", a note about "ticket #58213",
  a recruiter's own hire. A soft rule excludes the message only when its body has no
  live cue of weight ≥ 0.5 aimed at the reader (`SOFT_EXCLUSION_RESCUE_WEIGHT`), or
  when something in it is selling (`transactional`). Otherwise the message is held
  in maybe with the blocking `business_signal` caveat, never saved, and the model
  judge cannot overrule that.

Write exclusion rules on structure, not on single words, so they do not fire on
ordinary kind mail: a "code" needs digits right after it (or after "is" or ":"), a
"gift card" needs a win or a claim, an organization name ends in its org word
("Acme Support", not "Dana (support group)"), "sale" and "promo" need their
marketing context ("flash sale", not "congrats on the sale"), and "is hiring"
never matches "is hiring you". `exclusionFor()` returns the first hard rule that
applies, `softExclusionFor()` the first soft one.

The Gmail filter is stricter than the soft tier on purpose: `GMAIL_FILTER_SUFFIX`
keeps support@, info@, billing, invoice and receipt mail from being forwarded
automatically at all. The soft tier is for mail that reaches Witness another way,
most often a message the person forwards by hand.

## How a message is scored

1. **Hard exclusions** (`exclude`): any `harm` match first (so the reason is always
   `harm:<id>` when one is there); then from the owner; short codes, `urn:biz`, SMS
   sender ids; excluded headers; hard sender, subject and body patterns. Manual adds
   are never excluded. Soft patterns are
   checked here but decided after scoring (see "Hard and soft exclusions").
2. **Cues.** Every phrase and pattern match, longest first. Cues overlapped by a
   neutralizing dampener are cancelled; cues with a negation word within
   `negationWindow` words before them in the same clause are negated (a comma,
   semicolon, dash, "but", "though" or "however" ends the clause). In a pasted
   chat, lines that start with `You:` or `Me:` are the owner's own words and do not count.
3. **Score.** Each rule counts once. The strongest cue sets the level and the
   others add a share of what is left:
   `score = top + (1 - top) * supportFactor * (1 - Π(1 - w_other))`, plus
   boosters (capped) and `directThread`, times `groupThreadFactor` in a group.
   Cue weights are multiplied by `undirectedFactor` when no cue is aimed at the reader.
4. **Caveats** qualify surviving evidence: `possible_sarcasm`, `negated`,
   `apology`, `rejection`, `transactional`, `not_directed`, `coercion`,
   `business_signal` block auto-save; `boilerplate` is informational.
   `group_message` and `payment` never force maybe, but never allow a save either.
5. **Decision.** `save` when score ≥ 0.75 and no blocking caveat. `maybe` when
   score ≥ 0.35, or when a blocking caveat is present and score ≥ 0.25.
   Otherwise `exclude`. A save in a group thread, or with `payment`, becomes `maybe`.
6. **Quote.** The sentence with the strongest cue, plus up to two neighboring
   sentences that also carry cues, plus any sentence next to it that holds a
   negation, sarcasm, apology or rejection (the quote never cuts those away), plus
   every sentence anywhere in the message that holds a `coercion` match.
   Narration ("My sister texted:"), speaker labels ("Nadia:") and wrapping
   quotation marks are trimmed. The quote is always an exact substring.

### What a weight means

| Weight | Meaning | Example |
|---|---|---|
| ≥ 0.68 | Clear evidence on its own, in any channel | "so proud of you", "you mean the world to me", "couldn't have done it without you" |
| 0.6 – 0.67 | Clear in a direct text; needs a little support in an email | "I appreciate you", "you have such a good heart" |
| 0.4 – 0.55 | Supporting; saves only alongside other cues | "love you", "thank you for volunteering", "congrats" |
| < 0.4 | Weak; never more than maybe on its own | "thanks", "great job", "happy birthday" |

In a direct text a single directed cue scores about `w + 0.13` (second-person
booster plus direct thread), so 0.62 is the lowest weight that saves alone
there. In an email, OCR or agent capture it scores about `w + 0.08`.

### Policies encoded here

- A bare "love you" closing an everyday text goes to maybe, not save.
- Praise for someone else ("proud of my son", "congrats to Priya") is not the reader's evidence.
- A group chat can still hold evidence, but the "you" may be someone else, so a
  group message is never saved automatically: it waits in maybe.
- Real praise inside a rejection, an apology for hurting you, a breakup, sarcasm
  (with or without an emoji: "said no one ever", "can't wait to watch you fail")
  and backhanded praise ("didn't think you'd pull it off") are never auto-saved.
- A person paying you for your work is evidence (trust), kept in maybe, never
  saved automatically. An order, receipt, bill, subscription, loyalty message or a
  payment processor's own mail is never evidence, however warm.
- A business-sounding sender or subject never throws away strong words aimed at
  you; it holds them in maybe instead. Bulk and automated mail is always excluded.
- Praise does not need a stock phrase: "you were the calmest person in the room",
  "nobody explains this better than you", "we picked your proposal", "your hard
  work did not go unnoticed". Most of these wait in maybe on their own and save
  with support.
- Control, guilt, insults and conditional love are never auto-saved, and the quote
  keeps them. Violence, threats, self-harm and goodbyes are never evidence at all.

## Tuning safely

The corpus in `corpus/*.jsonl` is the safety net. Every change to this file
must keep the gates in `test/corpus.test.ts` green:

- save precision ≥ 0.97 on the tuning corpus, ≥ 0.95 on the holdout;
- recall of positives (decided save or maybe) ≥ 0.9;
- zero saves of hard negatives (`"hard": true`);
- every kept verdict quotes an exact substring;
- no misattribution: a kept quote never comes from quoted history (`>` lines,
  anything under an "On … wrote:" line) or the owner's own words.

Workflow:

1. **Write the example first.** Add the message you want handled to the right
   file (`text`, `email`, `ocr`, `agent` or `hard-negatives`), labeled the way
   an ordinary person would judge it. Label `save` only when it is clearly kind
   evidence aimed at the recipient. Use fictional names, `example.com`
   addresses and `+1555555xxxx` numbers only.
2. **Change the lexicon.** Prefer a specific pattern over a broad one, and an
   allowlist over a wildcard: an open `most [a-z]+` also matches "most
   self-centered".
3. **Attack your own change.** For every broader pattern, add hard negatives
   that would fool it (advice that looks like a recommendation, a negative
   superlative, a present-tense "can't sleep without you").
4. **Run** `bun run test` from `packages/detector` (the gates). `bun run corpus`
   lists every tuning example that disagrees with its label, with its score,
   caveats, quote and reasons; `bun run corpus --holdout` prints the holdout
   summary only.
5. **Never tune on the holdout.** `corpus/holdout.jsonl` was written and
   committed before any lexicon existed. Do not add phrases taken from it and
   do not relabel it. If it fails, find the general category you missed, add
   new examples of that category to the tuning files, and fix it there.

### Holdout record

- First look, after tuning on the tuning corpus only: save precision 94.4%
  (17/18), recall 95.2%, no hard-negative saves. The one false save was
  backhanded praise ("didn't think you'd pull it off, but you did. proud of you").
- Fix: a general backhanded-praise dampener (`backhanded_doubt`, `for_once`,
  `i_guess`), tuned on three new hard negatives in `hard-negatives.jsonl`
  (n-054 to n-056), not on the holdout example.
- Second look: save precision 100% (17/17), recall 95.2%.

The same author wrote the holdout and the lexicon, so it is a check against
overfitting, not a fully independent test. New holdout examples written by
someone else are welcome.
