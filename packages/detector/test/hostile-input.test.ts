import { describe, expect, it } from 'vitest';
import { extractEmailEvidence, htmlToText, MAX_HTML_CHARS, parseAddress, parseMailDate } from '../src/email.js';
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

  it.each([
    ['reply intros in every language', Array.from({ length: 4000 }, (_, i) => `${'>'.repeat(i % 5)}${['On', 'El', 'Le', 'Am', 'Em'][i % 5]} ${'schrieb wrote escribió a écrit '.repeat(12)}:`).join('\n')],
    ['header labels that never finish a block', Array.from({ length: 20_000 }, () => 'De: a\nEnviado: b\nVon: c').join('\n')],
    ['a thread quoted many levels deep', Array.from({ length: 3000 }, (_, i) => `${'>'.repeat(i)} On Fri, Sep 5, 2026 at 9:00 AM R <r${i}@example.com> wrote:`).join('\n')],
  ])('extractEmailEvidence: %s', (_label, text) => {
    const { ms } = timed(() => extractEmailEvidence({ text, subject: 'Fwd: x', from: { address: 'sam@example.com' }, headers: {}, isOwnerAddress: () => false }));
    expect(ms).toBeLessThan(1000);
  });

  // Every line shaped like "From:" is read as a header, forward marker or not, so its value must
  // be cheap to find: a pattern like `(.*?)\s*$` took 31 s on one HTML-only mail like the first.
  it.each([
    ['one HTML header value with a long run of em spaces', { html: `<p>From: a${'\u2003'.repeat(MAX_HTML_CHARS - 100)}b</p>` }],
    ['header values with long runs of spaces', { text: Array.from({ length: 100 }, () => `From: a${' '.repeat(4000)}b\nSent: c${' '.repeat(4000)}d`).join('\n') }],
    ['bold header values with long runs of stars', { text: Array.from({ length: 50 }, () => `*From:* a${'*'.repeat(8000)}b`).join('\n') }],
    ['a line with a long run of spaces inside it', { text: `Thank you ${' '.repeat(BIG)} so much.` }],
    // Normalizing reorders runs of combining marks, which is quadratic: only short strings are normalized.
    ['a "From:" line of combining marks', { text: `From: a${'\u0301\u0323'.repeat(BIG / 2)}b\nSent: today` }],
    ['an "On … wrote:" line of combining marks', { text: `Hi\nOn Fri, Sep 5, 2026 ${'\u0301\u0323'.repeat(BIG / 2)}\nwrote:\n> hello` }],
    ['many small hidden blocks and comments', { html: `<p>hi</p>${'<style>a</style>x<!--c-->'.repeat(Math.floor(MAX_HTML_CHARS / 26))}` }],
    ['an HTML name of combining marks', { html: `<p>From: ${'\u0301\u0323'.repeat(MAX_HTML_CHARS / 4)} &lt;a@example.com&gt;</p><p>Sent: today</p>` }],
  ])('extractEmailEvidence: %s', (_label, body) => {
    for (const followForwards of [true, false]) {
      const { ms } = timed(() => extractEmailEvidence({ ...body, subject: 'Fwd: x', from: { address: 'sam@example.com' }, headers: {}, followForwards, isOwnerAddress: () => false }));
      expect(ms).toBeLessThan(1000);
    }
  });

  it('htmlToText: many nested blockquotes with intros', () => {
    const { ms } = timed(() => htmlToText('<p>x:</p><blockquote>'.repeat(BIG / 30)));
    expect(ms).toBeLessThan(500);
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
