/**
 * The parity fixture the Swift Mac helper tests against must match what the
 * reference prefilter decides today. If this fails, run `bun run parity` and
 * commit the fixture (then `swift test` in apps/mac).
 */
import { describe, expect, it } from 'vitest';
import { parseCorpus } from './corpus-support.js';
import { buildParityCases, formatParityFixture } from './parity-support.js';

const files = import.meta.glob<string>('../corpus/*.jsonl', { query: '?raw', import: 'default', eager: true });
const fixture = Object.values(import.meta.glob<string>('./fixtures/prefilter-parity.json', { query: '?raw', import: 'default', eager: true }))[0];

describe('prefilter parity fixture', () => {
  const examples = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, raw]) => parseCorpus(raw, path.split('/').pop()!));
  const cases = buildParityCases(examples);

  it('is up to date with lexicon.json and the corpus (bun run parity)', () => {
    expect(fixture).toBe(formatParityFixture(cases));
  });

  it('covers every text message, some emails and both outcomes', () => {
    expect(cases.length).toBeGreaterThan(150);
    expect(cases.some((c) => c.id.startsWith('e-') || c.id.startsWith('em'))).toBe(true);
    expect(cases.filter((c) => c.expectPass).length).toBeGreaterThan(40);
    expect(cases.filter((c) => !c.expectPass).length).toBeGreaterThan(40);
  });
});
