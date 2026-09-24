import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT,
  DEFAULT_LEXICON_DATA,
  LexiconError,
  defaultLexicon,
  loadLexicon,
  phraseSource,
  portabilityProblem,
  validateLexicon,
} from '../src/lexicon.js';
import { detect } from '../src/rules.js';
import type { LexiconData } from '../src/types.js';

const clone = (): LexiconData => structuredClone(DEFAULT_LEXICON_DATA) as LexiconData;

describe('bundled lexicon.json', () => {
  it('is valid and portable', () => {
    expect(validateLexicon(DEFAULT_LEXICON_DATA)).toEqual([]);
  });

  it('covers every category except other', () => {
    const data = DEFAULT_LEXICON_DATA as LexiconData;
    for (const category of ['love', 'care', 'pride', 'gratitude', 'trust', 'belonging', 'accomplishment', 'recovery'] as const) {
      const entry = data.categories[category];
      expect(entry, category).toBeDefined();
      expect(entry!.phrases.length + entry!.patterns.length, category).toBeGreaterThan(5);
    }
  });

  it('compiles once and caches', () => {
    expect(defaultLexicon()).toBe(defaultLexicon());
    expect(defaultLexicon().cues.length).toBeGreaterThan(200);
  });

  it('has gmail filter terms', () => {
    expect((DEFAULT_LEXICON_DATA as LexiconData).gmailFilterTerms.length).toBeGreaterThan(10);
  });
});

describe('portabilityProblem', () => {
  it.each([
    ['\\bthank(s| you)\\b'],
    ["couldn'?t have (done|made) it without you"],
    ['(?:so )?proud of (you|u)'],
    ['congrats to (?!you\\b)'],
    ['[0-9]{4,8}'],
    ['(🙄|😒)'],
    ['\\u2019s'],
    ['a{2,}'],
    ['[a-z]+ (so |really ){0,4}proud'],
  ])('accepts %s', (source) => {
    expect(portabilityProblem(source)).toBeNull();
  });

  it.each([
    ['(?<=thank )you', /lookbehind/],
    ['(?<!not )proud', /lookbehind/],
    ['(?<name>you)', /named groups/],
    ['(?i)you', /not portable/],
    ['(?>atomic)', /not portable/],
    ['you++', /possessive/],
    ['\\p{L}+', /not portable/],
    ['\\u{1F600}', /4 hex/],
    ['[🙄😒]', /emoji/],
    ['[a-z&&[^aeiou]]', /nested|ICU/],
    ['😂+', /emoji/],
    ['a*', /empty string/],
    ['(unclosed', /does not compile/],
    ['[abc', /unterminated/],
    ['a{', /quantifier/],
    ['\\Qliteral\\E', /not portable/],
    ['', /empty/],
    ['(so |really )*proud', /backtrack/],
    ['([a-z]+\\.)+com', /backtrack/],
    ['(ha){2,}', /backtrack/],
  ])('rejects %s', (source, reason) => {
    expect(portabilityProblem(source)).toMatch(reason);
  });
});

describe('phraseSource', () => {
  const matches = (phrase: string, text: string): boolean => new RegExp(phraseSource(phrase), 'i').test(text);

  it('matches whole words, case-insensitively', () => {
    expect(matches('proud of you', 'So PROUD of you!')).toBe(true);
    expect(matches('ily', 'family dinner')).toBe(false);
  });

  it('treats apostrophes as optional and any whitespace as a space', () => {
    expect(matches("can't thank you enough", 'cant thank you\nenough')).toBe(true);
    expect(matches("you're hired", 'youre hired')).toBe(true);
  });

  it('lets a hyphen match a hyphen, a space or nothing', () => {
    expect(matches('well-deserved', 'so well deserved')).toBe(true);
    expect(matches('well-deserved', 'welldeserved')).toBe(true);
  });

  it('escapes regex metacharacters', () => {
    expect(matches('thanks (again)', 'thanks (again)')).toBe(true);
    expect(portabilityProblem(phraseSource('a+b? [c]'))).toBeNull();
  });
});

describe('validateLexicon', () => {
  it('reports bad weights, ids, categories and headers', () => {
    const data = clone() as unknown as Record<string, any>;
    data.categories.love.phrases.push({ p: 'hello', w: 2 });
    data.categories.love.patterns.push({ id: 'Bad Id', re: 'x', w: 0.5 });
    data.categories.pride.patterns.push({ id: 'dup', re: 'a', w: 0.5 }, { id: 'dup', re: 'b', w: 0.5 });
    data.categories.joy = { phrases: [], patterns: [] };
    data.exclusions.headers['List-Id'] = '*';
    data.exclusions.headers['x-bad'] = 42;
    data.context = { groupThreadFactor: 3, nope: 0.1 };
    const problems = validateLexicon(data);
    expect(problems.join('\n')).toMatch(/"w" must be in \(0, 1\]/);
    expect(problems.join('\n')).toMatch(/"id" must match/);
    expect(problems.join('\n')).toMatch(/duplicate id dup/);
    expect(problems.join('\n')).toMatch(/categories\.joy: unknown category/);
    expect(problems.join('\n')).toMatch(/must be lowercase/);
    expect(problems.join('\n')).toMatch(/x-bad/);
    expect(problems.join('\n')).toMatch(/context\.groupThreadFactor/);
    expect(problems.join('\n')).toMatch(/context\.nope: unknown key/);
  });

  it('reports non-portable regexes with their location', () => {
    const data = clone();
    data.dampeners.sarcasm.push({ id: 'bad', re: '(?<=oh )great' });
    expect(validateLexicon(data)).toEqual([expect.stringMatching(/dampeners\.sarcasm\[\d+\] bad: lookbehind/)]);
  });

  it('rejects a non-object', () => {
    expect(validateLexicon(null)).toEqual(['lexicon must be a JSON object']);
  });
});

describe('loadLexicon', () => {
  it('throws LexiconError listing every problem', () => {
    const data = clone();
    data.version = 2 as 1;
    data.dampeners.negationWindow = 0;
    expect(() => loadLexicon(data)).toThrow(LexiconError);
    try {
      loadLexicon(data);
    } catch (error) {
      expect((error as LexiconError).problems).toContain('version must be 1');
    }
  });

  it('fills in context defaults', () => {
    const data = clone();
    delete data.context;
    expect(loadLexicon(data).context).toEqual(DEFAULT_CONTEXT);
  });

  it('lets a custom lexicon drive detect()', () => {
    const data = clone();
    data.categories.gratitude!.phrases.push({ p: 'mahalo nui loa', w: 0.9, implicit: true });
    const custom = loadLexicon(data);
    const text = 'Mahalo nui loa for the lei.';
    expect(detect({ text, channel: 'text' }).decision).toBe('exclude');
    const verdict = detect({ text, channel: 'text' }, custom);
    expect(verdict.decision).toBe('save');
    expect(verdict.reasons.map((r) => r.rule)).toContain('gratitude/phrase:mahalo_nui_loa');
  });
});

describe('optional coercion and harm lists', () => {
  it('validates them like the other dampener lists', async () => {
    const { validateLexicon, DEFAULT_LEXICON_DATA } = await import('../src/lexicon.js');
    const data = structuredClone(DEFAULT_LEXICON_DATA) as { dampeners: Record<string, unknown> };
    expect(validateLexicon(data)).toEqual([]);
    data.dampeners.harm = 'kill';
    data.dampeners.coercion = [{ id: 'bad id', re: '(?<=x)y' }];
    const problems = validateLexicon(data);
    expect(problems.some((p) => p.startsWith('dampeners.harm'))).toBe(true);
    expect(problems.some((p) => p.startsWith('dampeners.coercion'))).toBe(true);
  });
});
