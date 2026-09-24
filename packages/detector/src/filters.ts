/**
 * Cheap prefilters built from the lexicon, for places that only need to know
 * "could this be evidence?" before sending it anywhere: the Gmail filter the
 * setup wizard shows, and the Mac helper's prefilter (whose Swift twin reads the
 * same lexicon.json and should agree with `prefilter` below).
 */
import { defaultLexicon, type Lexicon } from './lexicon.js';
import { exclusionFor } from './rules.js';
import { foldForMatch, hasMatch } from './text.js';
import type { Candidate } from './types.js';

// The Gmail filter lives in its own module so the web app can import it alone
// (`@witness/detector/gmail`); it is re-exported here for everyone else.
export { GMAIL_FILTER_SUFFIX, gmailFilterQuery, gmailFilterTerms, plainCues, type GmailTermSource } from './gmail.js';

/** Every literal cue phrase in the lexicon, lowercased and de-duplicated. */
export function cueTerms(lexicon: Lexicon = defaultLexicon()): string[] {
  const seen = new Set<string>();
  for (const entry of Object.values(lexicon.data.categories)) {
    for (const phrase of entry?.phrases ?? []) seen.add(phrase.p.trim().toLowerCase());
  }
  return [...seen].sort();
}

export interface PrefilterResult {
  /** Stage 1 exclusion rule id, or null. */
  excludedBy: string | null;
  /** True when any category phrase or pattern matches the text or subject. */
  hasCue: boolean;
}

/**
 * Stage 1 exclusions plus "does any cue match at all". This is the reference
 * behavior for collectors that forward candidates to the core.
 */
export function prefilter(c: Candidate, lexicon: Lexicon = defaultLexicon()): PrefilterResult {
  const excludedBy = exclusionFor(c, lexicon);
  if (excludedBy) return { excludedBy, hasCue: false };
  const text = foldForMatch(c.text ?? '');
  const subject = foldForMatch(c.subject ?? '');
  const hasCue = lexicon.cues.some((cue) => hasMatch(cue.re, text) || (subject.length > 0 && hasMatch(cue.re, subject)));
  return { excludedBy: null, hasCue };
}
