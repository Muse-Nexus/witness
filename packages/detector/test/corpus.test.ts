/**
 * Corpus gates (SPEC §6). corpus/holdout.jsonl was written and committed before
 * any lexicon existed and is never used for tuning; everything else in
 * corpus/*.jsonl is the tuning set.
 */
import { describe, expect, it } from 'vitest';
import { detect } from '../src/rules.js';
import { evaluate, formatSummary, parseCorpus, type CorpusExample } from './corpus-support.js';

const files = import.meta.glob<string>('../corpus/*.jsonl', { query: '?raw', import: 'default', eager: true });

const byFile = Object.entries(files).map(([path, raw]) => {
  const file = path.split('/').pop()!;
  return { file, examples: parseCorpus(raw, file) };
});
const tuning: CorpusExample[] = byFile.filter((f) => f.file !== 'holdout.jsonl').flatMap((f) => f.examples);
const holdout: CorpusExample[] = byFile.find((f) => f.file === 'holdout.jsonl')?.examples ?? [];

describe('corpus', () => {
  it('is large, varied and well formed', () => {
    expect(tuning.length).toBeGreaterThanOrEqual(220);
    expect(holdout.length).toBeGreaterThanOrEqual(40);
    const all = [...tuning, ...holdout];
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    for (const channel of ['text', 'email', 'ocr', 'agent'] as const) {
      expect(all.filter((e) => e.channel === channel).length, channel).toBeGreaterThanOrEqual(10);
    }
    expect(all.filter((e) => e.hard).length).toBeGreaterThanOrEqual(60);
    expect(all.filter((e) => e.channel === 'email' && e.headers).length).toBeGreaterThanOrEqual(5);
  });

  it('uses fictional contact details only', () => {
    for (const e of [...tuning, ...holdout]) {
      const handle = e.from?.handle ?? '';
      if (handle.includes('@')) {
        expect(handle, e.id).toMatch(/@([a-z0-9-]+\.)*example\.(com|org|net|edu|gov|io)$|@(linkedin\.com|google\.com)$/);
      } else if (/^\+1\d{10}$/.test(handle)) {
        expect(handle, e.id).toMatch(/^\+1555555\d{4}$/);
      }
    }
  });
});

describe.each([
  { name: 'tuning corpus', examples: tuning, precision: 0.97 },
  { name: 'holdout', examples: holdout, precision: 0.95 },
])('$name gates', ({ name, examples, precision }) => {
  const { rows, metrics } = evaluate(examples, (c) => detect(c));

  it('prints a confusion summary', () => {
    console.log(formatSummary(name, metrics));
    expect(metrics.total).toBe(examples.length);
  });

  it(`save precision >= ${precision}`, () => {
    expect(metrics.savePrecision, `false saves: ${metrics.falseSaves.join(', ')}`).toBeGreaterThanOrEqual(precision);
  });

  it('recall of positives (save or maybe) >= 0.9', () => {
    expect(metrics.positiveRecall, `missed: ${metrics.missedPositives.join(', ')}`).toBeGreaterThanOrEqual(0.9);
  });

  it('never saves a hard negative', () => {
    expect(metrics.hardNegativeSaves).toEqual([]);
  });

  it('always quotes verbatim from the candidate text', () => {
    for (const { example, candidate, verdict } of rows) {
      if (verdict.decision === 'exclude') {
        expect(verdict.quote, example.id).toBe('');
        continue;
      }
      expect(verdict.quote.length, example.id).toBeGreaterThan(0);
      expect(candidate.text.slice(verdict.quoteStart, verdict.quoteEnd), example.id).toBe(verdict.quote);
    }
  });
});
