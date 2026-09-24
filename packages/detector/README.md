# @witness/detector

The "is this evidence?" detector for Muse Nexus Witness. Given a text, email,
screenshot text or agent capture, it decides whether to **save** it, put it in
**maybe**, or **exclude** it, and picks the exact words to keep. It never
writes or rewrites evidence: the quote is always a verbatim substring.

Contract: `docs/dev/SPEC.md` §6. Lexicon format and tuning: [LEXICON.md](LEXICON.md).

```ts
import { detect, detectWithModel, anthropicJudge, extractEmailEvidence, CATEGORY_LABELS } from '@witness/detector';

const verdict = detect({
  text: "Thank you for sitting with me last night. I couldn't have gotten through it without you.",
  channel: 'text',
  threadKind: 'direct',
  from: { name: 'Dana', handle: '+15555550101' },
});
// { decision: 'save', category: 'gratitude', quote: "...", caveats: [], reasons: [...], engine: 'rules' }
```

## Pieces

| Module | What it does |
|---|---|
| `rules.ts` | Stage 1 hard exclusions, stage 2 lexicon scoring, caveats, verbatim span selection. Pure and synchronous. |
| `lexicon.ts` | Loads, validates and compiles `lexicon.json`; rejects regexes that would behave differently in Swift. |
| `model.ts` | Optional stage 3: a small model (default `claude-haiku-4-5`) looks at borderline maybes only. It can promote to save when confident and its quote is an exact substring; it never demotes, and any error leaves the rules verdict standing. |
| `email.ts` | `extractEmailEvidence`: finds the original sender, date and words inside Gmail, Outlook and Apple Mail forwards, and strips quoted replies and signatures. HTML fallback without dependencies. |
| `gmail.ts` | `gmailFilterTerms`, `gmailFilterQuery()` and `plainCues()` for the setup wizard. Exported alone as `@witness/detector/gmail` (imports only lexicon.json), which is what the web app bundles. |
| `filters.ts` | `cueTerms()` and `prefilter()`, the reference for collectors; re-exports the Gmail helpers. |
| `normalize.ts` | `normalizeForDedupe` and `dedupeKey` (SPEC §5). |

## The model stage

The rules alone are the default and cost nothing. With `WITNESS_JUDGE=anthropic`
and an API key, borderline maybes (score 0.35 to 0.75, without an apology,
rejection, sales or sarcasm caveat) go to the model:

```ts
const judge = process.env.ANTHROPIC_API_KEY ? anthropicJudge({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const verdict = await detectWithModel(candidate, judge);
```

The request is small: a short fixed system prompt, `max_tokens: 400`,
JSON-schema output, no extended thinking. SPEC §6 estimates about a dollar a
month per active person on Haiku 4.5. The model classifies and points at words;
code checks that those words are really in the message.

## Checks

```sh
bun run typecheck
bun run test      # unit tests + corpus gates (precision, recall, hard negatives)
```

All names, numbers and addresses in tests and the corpus are fictional.
