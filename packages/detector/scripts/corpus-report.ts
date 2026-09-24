/**
 * Tuning aid: lists every tuning-corpus example whose decision differs from its
 * label, with score, caveats, quote and the reasons behind it.
 *
 *   bun run corpus          disagreements + summary for the tuning corpus
 *   bun run corpus --all    every example, not just disagreements
 *   bun run corpus --holdout  summary only for corpus/holdout.jsonl
 *
 * The holdout never shows individual examples: it exists to catch overfitting,
 * so it must not be tuned on (see LEXICON.md).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { detect } from '../src/index.js';
import { evaluate, formatSummary, parseCorpus } from '../test/corpus-support.js';

const dir = new URL('../corpus/', import.meta.url);
const holdout = process.argv.includes('--holdout');
const all = process.argv.includes('--all');

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (f === 'holdout.jsonl') === holdout);
const examples = files.flatMap((f) => parseCorpus(readFileSync(new URL(f, dir), 'utf8'), f));
const { rows, metrics } = evaluate(examples, (c) => detect(c));

if (!holdout) {
  for (const { example, candidate, verdict } of rows) {
    if (!all && verdict.decision === example.expect) continue;
    console.log(
      `${example.id} (${example.file}) expected ${example.expect}, got ${verdict.decision}` +
        ` score=${verdict.score} category=${verdict.category}/${example.category ?? '-'}` +
        (verdict.caveats.length ? ` caveats=${verdict.caveats.join(',')}` : ''),
    );
    console.log(`  text:  ${JSON.stringify(candidate.text.slice(0, 200))}`);
    if (verdict.quote) console.log(`  quote: ${JSON.stringify(verdict.quote)}`);
    console.log(`  ${verdict.reasons.map((r) => `${r.rule}:${r.weight}`).join('  ')}`);
  }
}
console.log(formatSummary(holdout ? 'holdout' : 'tuning corpus', metrics));
