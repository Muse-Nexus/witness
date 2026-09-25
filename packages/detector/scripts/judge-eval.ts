/**
 * Measures the optional model judge against the rules alone, over the tuning corpus and the
 * holdout, with the real Anthropic API. Opt-in and never run in CI: it needs a key and costs
 * a little (only borderline examples reach the judge).
 *
 *   ANTHROPIC_API_KEY=… bun run judge-eval            one run
 *   ANTHROPIC_API_KEY=… bun run judge-eval --runs 3   repeat, since answers vary a little
 *
 * The holdout prints summaries only, never examples, so it is never tuned on (LEXICON.md).
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

for (const holdout of [false, true]) {
  const name = holdout ? 'holdout' : 'tuning corpus';
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && (f === 'holdout.jsonl') === holdout);
  const examples = files.flatMap((f) => parseCorpus(readFileSync(new URL(f, dir), 'utf8'), f));
  const rules = evaluate(examples, (c) => detect(c));
  console.log(formatSummary(`${name}, rules alone`, rules.metrics));
  for (let run = 1; run <= runs; run += 1) {
    // evaluate() is synchronous: work out the judged verdicts first, a few at a time.
    const judged: Verdict[] = new Array(rules.rows.length);
    const queue = rules.rows.map((row, i) => ({ row, i }));
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) judged[job.i] = await detectWithModel(job.row.candidate, judge);
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    let next = 0;
    const withJudge = evaluate(examples, () => judged[next++]!);
    console.log(formatSummary(`${name}, rules + judge (run ${run})`, withJudge.metrics));
  }
}
