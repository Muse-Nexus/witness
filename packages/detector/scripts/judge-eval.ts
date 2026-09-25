/**
 * Measures the optional model judge against the rules alone, over the tuning corpus and the
 * holdout, with the real Anthropic API. Opt-in and never run in CI: it needs a key and costs
 * a little (only borderline examples reach the judge).
 *
 *   ANTHROPIC_API_KEY=… bun run judge-eval                       the tuning corpus, one run
 *   ANTHROPIC_API_KEY=… bun run judge-eval --runs 3              repeat, since answers vary a little
 *   ANTHROPIC_API_KEY=… bun run judge-eval --holdout --runs 3    the final check, once a change is chosen
 *
 * The holdout is scored only on request and never shows examples, so it is not tuned on
 * (LEXICON.md). Screenshot text (channel "ocr") keeps its rules verdict, as in production,
 * where words read from an image never reach the judge (apps/core/src/capture.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { detect } from '../src/index.js';
import { anthropicJudge, detectWithModel, type ModelJudge } from '../src/model.js';
import type { Verdict } from '../src/types.js';
import { evaluate, formatSummary, parseCorpus } from '../test/corpus-support.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY to run the judge evaluation.');
  process.exit(2);
}
const runsArg = process.argv.indexOf('--runs');
const runs = runsArg >= 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 1) : 1;
const judge: ModelJudge = anthropicJudge({ apiKey, timeoutMs: 30_000, maxRetries: 2 });
const dir = new URL('../corpus/', import.meta.url);
const holdout = process.argv.includes('--holdout');

{
  const name = holdout ? 'holdout' : 'tuning corpus';
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (f === 'holdout.jsonl') === holdout);
  const examples = files.flatMap((f) => parseCorpus(readFileSync(new URL(f, dir), 'utf8'), f));
  const rules = evaluate(examples, (c) => detect(c));
  console.log(formatSummary(`${name}, rules alone`, rules.metrics));
  for (let run = 1; run <= runs; run += 1) {
    const judged = await judgeAll(rules.rows);
    console.log(formatSummary(`${name}, rules + judge (run ${run})`, score(examples, judged)));
  }
}

/**
 * The judged verdict for every row, a few at a time (evaluate() is synchronous, so this comes
 * first). This and score() are functions so each run gets fresh state: under Bun 1.2,
 * closures made inside the loop body kept the first run's bindings, and a second run crashed.
 */
async function judgeAll(rows: ReturnType<typeof evaluate>['rows']): Promise<Verdict[]> {
  const judged: Verdict[] = new Array(rows.length);
  const queue = rows.map((row, i) => ({ row, i }));
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const c = job.row.candidate;
      judged[job.i] = c.channel === 'ocr' ? job.row.verdict : await detectWithModel(c, judge);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return judged;
}

/** The corpus metrics for verdicts already worked out, in corpus order. */
function score(examples: Parameters<typeof evaluate>[0], judged: readonly Verdict[]): ReturnType<typeof evaluate>['metrics'] {
  let next = 0;
  return evaluate(examples, () => judged[next++]!).metrics;
}
