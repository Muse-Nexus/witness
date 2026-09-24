import { describe, expect, it } from 'vitest';
import { htmlToText, parseAddress, parseMailDate } from '../src/email.js';
import { slugify } from '../src/lexicon.js';

// Inbound mail is attacker-controlled. These parsers must stay linear on crafted input
// (CodeQL js/polynomial-redos) and must never leave a tag that could re-form.

const BIG = 200_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe('hostile input stays cheap', () => {
  it.each([
    ['many spaces before [mailto:', ' '.repeat(BIG) + '[mailto:\\'.repeat(2000)],
    ['many "<=" with no closing', '<' + '<='.repeat(BIG / 2)],
    ['many quotes', '"'.repeat(BIG) + 'x'],
  ])('parseAddress: %s', (_label, input) => {
    const { ms } = timed(() => parseAddress(input));
    expect(ms).toBeLessThan(250);
  });

  it('parseMailDate: many unclosed "("', () => {
    const { value, ms } = timed(() => parseMailDate('('.repeat(BIG) + ' Sep 16 2026'));
    expect(ms).toBeLessThan(250);
    expect(value === undefined || Number.isFinite(value)).toBe(true);
  });

  it('slugify: many underscores and separators', () => {
    const { value, ms } = timed(() => slugify('_'.repeat(BIG) + 'thank you' + '-'.repeat(BIG)));
    expect(ms).toBeLessThan(250);
    expect(value).toBe('thank_you');
  });

  it('htmlToText never leaves a tag that can re-form', () => {
    const out = htmlToText('<<script>script>alert(1)<</script>/script><p>Thank you, truly.</p>');
    expect(out).not.toMatch(/<[a-z!/?]/i);
    expect(out).toContain('Thank you, truly.');
  });

  it('htmlToText keeps a literal "<" from the text', () => {
    expect(htmlToText('<p>I &lt;3 you</p>')).toBe('I <3 you');
  });
});

describe('addresses still parse the same way', () => {
  it.each([
    ['Sam Rivera <sam@example.com>', { name: 'Sam Rivera', handle: 'sam@example.com' }],
    ['"Sam Rivera" <Sam@Example.com>', { name: 'Sam Rivera', handle: 'sam@example.com' }],
    ["'Sam' <sam@example.com>", { name: 'Sam', handle: 'sam@example.com' }],
    ['Sam Rivera [mailto:sam@example.com]', { name: 'Sam Rivera', handle: 'sam@example.com' }],
    ['*Sam Rivera* [MAILTO:sam@example.com]', { name: 'Sam Rivera', handle: 'sam@example.com' }],
    ['<sam@example.com>', { handle: 'sam@example.com' }],
    ['sam@example.com', { handle: 'sam@example.com' }],
    ['Sam Rivera', { name: 'Sam Rivera' }],
    ['A <b> <sam@example.com>', { name: 'A <b>', handle: 'sam@example.com' }],
  ])('%s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });
});
