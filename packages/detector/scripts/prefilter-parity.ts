/**
 * Writes test/fixtures/prefilter-parity.json: the reference prefilter decision
 * for every text-channel corpus message, a few email bodies and some edge
 * cases. The Swift Mac helper's tests load it with the real lexicon.json and
 * must reach the same pass/exclude decision for every case.
 *
 *   bun run parity          (from packages/detector)
 *
 * Run it after changing lexicon.json or the prefilter; the detector tests fail
 * while the fixture is stale.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseCorpus } from '../test/corpus-support.js';
import { buildParityCases, formatParityFixture } from '../test/parity-support.js';

const dir = new URL('../corpus/', import.meta.url);
const examples = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()
  .flatMap((f) => parseCorpus(readFileSync(new URL(f, dir), 'utf8'), f));
const cases = buildParityCases(examples);
const out = new URL('../test/fixtures/prefilter-parity.json', import.meta.url);
writeFileSync(out, formatParityFixture(cases));
const passing = cases.filter((c) => c.expectPass).length;
console.log(`Wrote ${cases.length} cases (${passing} pass, ${cases.length - passing} stay on the Mac) to test/fixtures/prefilter-parity.json`);
