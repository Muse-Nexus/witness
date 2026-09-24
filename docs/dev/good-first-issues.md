# Good first issues

Ready-to-post issues for new contributors. Each one is self-contained, has
clear acceptance criteria, and names the files involved. Maintainers copy
these into GitHub issues; if you want to pick one up before it is posted, open
an issue (a Question is fine) that links here. The labels named below are
listed in [`.github/labels.yml`](../../.github/labels.yml).

Every issue follows the same ground rules:

- Read [Safety](../SAFETY.md) first. Verbatim only, no invented meaning.
- **Synthetic data only.** Fictional names, `example.com` addresses and
  `555-01xx` phone numbers. Never real exports, messages, photos or screenshots.
- Run `bun run check` (and `swift test` in `apps/mac` for Swift changes) before
  opening a pull request.

Some paths below belong to parts of v1 still being built. If a path does not
exist yet when you start, ask in the issue.

---

## 1. WhatsApp chat export importer

**Labels:** `good first issue`, `help wanted`, `source`, `importer`

**Context.** WhatsApp can export a chat as a `.txt` file. Many kind messages
live there. An importer that reads the export locally and sends individual
messages to the capture API would let people bring them into Witness once.

**Acceptance criteria**

- A small command-line script that reads a WhatsApp `.txt` export (iOS and
  Android formats, which differ in date layout).
- Asks for the person's own display name and skips their messages.
- Sends one message per request to `POST /api/v1/capture` with
  `sourceType: "import"`, `sourceLabel: "WhatsApp"`, `occurredAt` when the date
  parses, and a stable `sourceRef` (a hash of date, sender and text).
- A `--dry-run` flag that prints counts only, never message text.
- Media placeholder lines such as "image omitted" are skipped.
- Tests with synthetic exports in both formats.

**Files.** A new workspace one level under `packages/`, for example
`packages/importer-whatsapp/` (the root `workspaces` list is `packages/*`, so a
deeper folder would not be built or tested by `bun run check`), and a
guide in `docs/guides/`. See
[adding a source](../ARCHITECTURE.md#adding-a-source).

---

## 2. LinkedIn recommendations importer

**Labels:** `good first issue`, `help wanted`, `source`, `importer`

**Context.** LinkedIn's data export includes the recommendations people wrote
for you, as a CSV. These are exactly the kind of words Witness keeps.

**Acceptance criteria**

- Reads the received-recommendations CSV from a LinkedIn data export. Confirm
  the file and column names against a fresh export, then write synthetic
  fixtures with the same headers.
- Sends each recommendation's text through the capture API with
  `sourceType: "import"`, `sourceLabel: "LinkedIn"`, the recommender's name as
  `fromName`, and the date when present.
- Skips recommendations that are not visible or accepted, if the export marks
  them.
- `--dry-run` prints counts only.
- Tests with a synthetic CSV, including quoted commas and line breaks inside
  the text.

**Files.** A new workspace one level under `packages/`, for example
`packages/importer-linkedin/`, and a
guide in `docs/guides/`.

---

## 3. Screenshots for the Outlook guide

**Labels:** `good first issue`, `documentation`, `help wanted`

**Context.** [The Outlook guide](../guides/email-outlook.md) is text only.
A few screenshots would make it easier to follow.

**Acceptance criteria**

- Screenshots of Settings → Mail → Rules, the condition, the action, and the
  saved rule, taken in a **new, empty test account** with a fictional name.
- No real names, addresses, messages or folders visible anywhere.
- Each image has alt text describing the step, and is cropped to what matters.
- Images compressed (PNG or WebP, ideally under 200 KB each) and stored
  in `docs/assets/guides/outlook/`.

**Files.** `docs/guides/email-outlook.md`, `docs/assets/guides/outlook/`.

---

## 4. Lexicon translations: Spanish, Portuguese, Tagalog, ʻŌlelo Hawaiʻi

**Labels:** `good first issue`, `help wanted`, `detector`, `i18n`

**Context.** The detector's word lists live in
`packages/detector/lexicon.json`, documented in `packages/detector/LEXICON.md`.
They are English only. A lexicon written by a native speaker is the first step
toward Witness working in another language.

**Acceptance criteria**

- One language per pull request, as a new lexicon file following the v1 schema
  with its `language` code set.
- Written or reviewed by a native speaker, not machine-translated alone.
  Include common informal and texting forms.
- Boilerplate and rejection phrases for that language (the local equivalents
  of "thanks in advance" and "unfortunately we will not be moving forward").
- At least 30 synthetic labeled examples in that language in
  `packages/detector/corpus/<language code>/` (a folder, not the top level:
  `corpus/*.jsonl` is the English tuning set, scored with the English lexicon,
  and examples in another language there would fail its recall gate).
- For ʻŌlelo Hawaiʻi, handle the ʻokina and kahakō, and note who reviewed it.
- The detector cannot load a second lexicon yet. Either include the loader and
  a corpus test for your language (with the same gates, run with your lexicon)
  in the same pull request, or land the loader first in its own pull request.
  The examples alone should not go in `corpus/` at the top level.

**Files.** `packages/detector/`.

---

## 5. More hard negatives for the detector corpus

**Labels:** `good first issue`, `detector`, `tests`

**Context.** Precision matters more than recall: a wrong auto-save on a hard
day is worse than a missed one. Hard negatives are messages that look kind but
are not evidence.

**Acceptance criteria**

- At least 25 new synthetic examples labeled `exclude` or `maybe` in
  `packages/detector/corpus/`, covering: sarcasm, "thanks in advance",
  receipts that say thank you, recruiter praise, rejection letters that open
  kindly, group-chat thanks aimed at someone else, apologies, and negations
  ("I'm not proud of you").
- The corpus gates still pass: save-precision at least 0.97, and zero
  hard-negative saves.
- If an example exposes a detector bug, open a separate issue describing it
  rather than tuning the lexicon in the same pull request.

**Files.** `packages/detector/corpus/*.jsonl`.

---

## 6. Accessibility audit of the web app

**Labels:** `good first issue`, `accessibility`, `web`

**Context.** People may use Witness when tired, distressed, on a small phone,
or with assistive technology. The target is WCAG 2.2 AA.

**Acceptance criteria**

- Audit the landing page, sign-in, setup, gallery, maybe pile and settings with
  a keyboard only, VoiceOver or NVDA, 200% zoom, a 360 px wide viewport, and
  reduced motion on.
- Check contrast of every text and control color in both dark and light themes.
- File what you find as a checklist in the issue, then fix small items
  (labels, focus order, focus styles, target sizes under 44 px) in pull
  requests.

**Files.** `apps/web/`.

---

## 7. Test the delivery email in dark and light mail apps

**Labels:** `good first issue`, `email`, `design`

**Context.** A delivery email shows one quote, large, in Fraunces or Georgia
italic. It has to look calm and readable in every mail app, in both themes.

**Acceptance criteria**

- Send the delivery template, with a synthetic quote, to test accounts in
  Gmail (web, iOS, Android), Apple Mail (macOS, iOS) and Outlook (web, new
  Windows app), in light and dark mode.
- Record what breaks: forced color inversion, font fallback, link colors,
  spacing, the image, the crisis-line footer.
- Fix what you can in the template without adding tracking pixels, remote
  fonts that leak opens, or anything that changes the words.
- Attach screenshots of synthetic content only.

**Files.** The delivery email template in `apps/core/`.

---

## 8. Research: capture on Windows and Android

**Labels:** `help wanted`, `research`, `source`

**Context.** Witness for Mac and the iPhone Shortcut cover Apple devices. We
do not yet know the best consent-respecting way to capture kind messages on
Android or Windows.

**Acceptance criteria**

- A short proposal in `docs/dev/` comparing options, for example Android share
  targets, Android automation apps, notification access, and Windows Phone
  Link, each with what it can see, what permissions it needs, and the privacy
  cost.
- A recommendation that fits the rules in [Safety](../SAFETY.md): capture only
  what the person chose, one message at a time, never whole conversations.
- No code required. No real message data in examples.

**Files.** A new file in `docs/dev/`.

---

## 9. Coverage-guided fuzzing for the typedstream decoder

**Labels:** `help wanted`, `mac`, `tests`

**Context.** Messages on macOS stores some message text in a binary
"typedstream" blob. Witness for Mac decodes it with a small clean-room decoder
that must never crash on malformed input. `TypedStreamTextTests` already runs
seeded random, truncated and mutated blobs on every `swift test`. The next step
is coverage-guided fuzzing, which finds inputs random bytes rarely reach.

**Acceptance criteria**

- A libFuzzer target (`swift build -Xswiftc -sanitize=fuzzer,address`) for
  `TypedStreamText`, outside the normal test run, with a short README on how
  to run it.
- A seed corpus generated from synthetic strings with `NSArchiver`, never
  from a real Messages database.
- Any crash it finds becomes a regular unit test with the minimized input.

**Files.** `apps/mac/` (a new fuzz target and folder).

---

## 10. First slice of the Mac menu-bar app

**Labels:** `help wanted`, `mac`, `M2`

**Context.** M2 turns Witness for Mac into a menu-bar app. A first slice can
be small and still useful.

**Acceptance criteria**

- A SwiftUI `MenuBarExtra` target that uses the existing core library to show
  status (Full Disk Access granted or not, last check time, counts sent) and
  Pause and Resume.
- Copy follows the voice in [Safety](../SAFETY.md): calm, plain, no
  exclamation marks, no counts that nag.
- No message text is ever displayed or logged.
- Discuss the design in the issue before building; this one is larger than
  most.

**Files.** `apps/mac/`.

---

## 11. A light social preview image

**Labels:** `good first issue`, `design`, `brand`

**Context.** Links to Witness unfurl with `apps/web/public/og.png` (1200 × 630,
dark), rendered from `apps/web/brand/og.html` by `apps/web/scripts/brand.mjs`
(`bun run brand` in `apps/web`). There is no light variant yet.

**Acceptance criteria**

- A light variant in `apps/web/brand/` (cream background, black text, the
  `MUSE NEXUS` eyebrow over `Witness.` in Fraunces with the light-mode coral
  period, and the tagline "A witness to your life."), rendered by the same
  script to a second file.
- Any sample quote is clearly labeled "Example" and is obviously fictional.
- Text is legible at small sizes. Files are optimized.
- Fonts used under their licenses (Fraunces and Inter are under the SIL Open
  Font License).

**Files.** `apps/web/brand/`, `apps/web/scripts/brand.mjs`, `apps/web/public/`.

---

## 12. Docs typos and clarity pass

**Labels:** `good first issue`, `documentation`

**Context.** Plain, short sentences matter here. People may read these guides
on a bad day.

**Acceptance criteria**

- Read the README and everything in `docs/` and `docs/guides/`. Fix typos,
  broken links, unclear steps and long sentences.
- Keep the voice: calm, plain, warm, second person, no exclamation marks.
- If a step in a guide no longer matches the provider's current screens, say
  which one and what you see now.

**Files.** `README.md`, `docs/**/*.md`.
