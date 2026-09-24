import { describe, expect, it } from 'vitest';
import { GMAIL_FILTER_SUFFIX, cueTerms, gmailFilterQuery, prefilter } from '../src/filters.js';
import { DEFAULT_LEXICON_DATA, loadLexicon } from '../src/lexicon.js';
import { dedupeKey, normalizeForDedupe } from '../src/normalize.js';
import type { LexiconData } from '../src/types.js';

describe('gmailFilterQuery', () => {
  it('ORs the lexicon terms and excludes non-people', () => {
    const query = gmailFilterQuery();
    expect(query.startsWith('("proud of you" OR "love you" OR "miss you"')).toBe(true);
    expect(query.endsWith(GMAIL_FILTER_SUFFIX)).toBe(true);
    expect(query).toContain('-category:promotions -category:social -category:updates -category:forums');
    expect(query).toContain('-from:(noreply OR no-reply OR no_reply OR donotreply OR do-not-reply');
    for (const term of (DEFAULT_LEXICON_DATA as LexiconData).gmailFilterTerms) expect(query).toContain(term);
  });

  it('keeps out the mail that buried the kind notes when tried on a real inbox', () => {
    const query = gmailFilterQuery();
    // The person's own sent mail, blind-copied newsletters, auto-replies and bulk mail.
    for (const exclusion of ['-from:me', '-to:undisclosed-recipients', '-unsubscribe', '-"out of office"', '-"automatic reply"']) {
      expect(query).toContain(exclusion);
    }
    // Receipts, billing and support replies say "thank you" and "congratulations" all day.
    for (const noise of ['-"payment"', '-"invoice"', '-"receipt"', '-"your order"', '-"policy"', 'support', 'billing']) expect(query).toContain(noise);
    const terms = (DEFAULT_LEXICON_DATA as LexiconData).gmailFilterTerms;
    for (const tooBroad of ['"thank you"', 'congrats', 'congratulations', '"inspire"', '"offer you"', '"doing better"']) {
      expect(terms).not.toContain(tooBroad);
    }
    // Every cue is a phrase aimed at the reader, never a single word.
    for (const term of terms) expect(term).toMatch(/^"[^"]+ [^"]+"$/);
  });

  it('stays within what a Gmail filter accepts', () => {
    expect(gmailFilterQuery().length).toBeLessThan(1500);
  });

  it('uses a custom lexicon', () => {
    const data = structuredClone(DEFAULT_LEXICON_DATA) as LexiconData;
    data.gmailFilterTerms = ['"mahalo"', 'aloha'];
    expect(gmailFilterQuery(loadLexicon(data))).toBe(`("mahalo" OR aloha) ${GMAIL_FILTER_SUFFIX}`);
  });
});

describe('@witness/detector/gmail', () => {
  it('builds the same query from the plain term list as from the loaded lexicon', async () => {
    const gmail = await import('../src/gmail.js');
    expect(gmail.gmailFilterTerms).toEqual((DEFAULT_LEXICON_DATA as LexiconData).gmailFilterTerms);
    expect(gmail.gmailFilterQuery()).toBe(gmailFilterQuery());
    expect(gmail.gmailFilterQuery(['"mahalo"', ' ', 'aloha'])).toBe(`("mahalo" OR aloha) ${GMAIL_FILTER_SUFFIX}`);
  });

  it('offers plain multi-word phrases for other mail apps', async () => {
    const { plainCues } = await import('../src/gmail.js');
    expect(plainCues(['"thank you"', 'congrats', '"proud of you"'])).toEqual(['thank you', 'proud of you']);
    expect(plainCues().length).toBe(6);
    expect(plainCues().every((c) => c.includes(' ') && !c.includes('"'))).toBe(true);
  });

  it('imports nothing but lexicon.json, so a browser bundle stays small', async () => {
    const source = Object.values(import.meta.glob<string>('../src/gmail.ts', { eager: true, query: '?raw', import: 'default' }))[0]!;
    const imports = [...source.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../lexicon.json']);
  });
});

describe('cueTerms', () => {
  it('returns unique, lowercase, sorted phrases', () => {
    const terms = cueTerms();
    expect(terms).toContain('proud of you');
    expect(terms).toContain('thank you');
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.every((t) => t === t.toLowerCase())).toBe(true);
    expect([...terms].sort()).toEqual(terms);
  });
});

describe('prefilter', () => {
  it('reports stage 1 exclusions', () => {
    expect(prefilter({ text: 'Your code is 123456', channel: 'text', from: { handle: '+15555550101' } })).toEqual({
      excludedBy: 'body:otp',
      hasCue: false,
    });
  });

  it('reports whether any cue matches, before dampening', () => {
    expect(prefilter({ text: 'Thanks in advance!', channel: 'text' }).hasCue).toBe(true);
    expect(prefilter({ text: 'see you at 7', channel: 'text' }).hasCue).toBe(false);
    expect(prefilter({ text: 'details inside', subject: 'Congratulations!', channel: 'email' }).hasCue).toBe(true);
  });
});

describe('dedupe', () => {
  it('normalizes as the SPEC says: lowercase, collapse whitespace, trim', () => {
    expect(normalizeForDedupe('  I am SO\n\tproud   of you ')).toBe('i am so proud of you');
  });

  it('hashes source type plus source ref, or the normalized text', async () => {
    expect(await dedupeKey('text', { text: '  Hello\nWORLD ' })).toBe(
      '1b5e019ac95efa328c17ceaf33b02fa94b8c21e7d7ed3c33b517eefd2c62c743',
    );
    expect(await dedupeKey('email', { sourceRef: '<abc@example.com>', text: 'ignored' })).toBe(
      '53bb4568975adc212974ae19e92b1cfd0b94ec4c603fcc1642549403395d98dc',
    );
  });
});
