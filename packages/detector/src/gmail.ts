/**
 * The Gmail filter the setup wizard shows, built from `gmailFilterTerms` in
 * lexicon.json (SPEC §6). This module is the narrow entry point
 * `@witness/detector/gmail`: it reads only that one list and has no compiled
 * lexicon and no model code, so the web app can bundle it without the rest of
 * the detector (or the Anthropic SDK).
 */
import { gmailFilterTerms as lexiconTerms } from '../lexicon.json';

/** The cue terms from lexicon.json, as Gmail search terms (quoted phrases or single words). */
export const gmailFilterTerms: readonly string[] = lexiconTerms;

/** Appended to every Gmail filter: skip tabs and senders that are never people. */
export const GMAIL_FILTER_SUFFIX =
  '-category:promotions -category:social -category:updates -from:(noreply OR no-reply OR notifications) -unsubscribe';

/** Anything that carries filter terms: a plain list, or a loaded Lexicon (`lexicon.data.gmailFilterTerms`). */
export type GmailTermSource = readonly string[] | { readonly data: { readonly gmailFilterTerms: readonly string[] } };

function termsOf(source: GmailTermSource): string[] {
  const list = Array.isArray(source) ? (source as readonly string[]) : (source as { data: { gmailFilterTerms: readonly string[] } }).data.gmailFilterTerms;
  return list.map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * The Gmail search string for "Has the words" in a Gmail filter, e.g.
 * `("thank you" OR "proud of you" OR congrats) -category:promotions ...`.
 */
export function gmailFilterQuery(source: GmailTermSource = gmailFilterTerms): string {
  return `(${termsOf(source).join(' OR ')}) ${GMAIL_FILTER_SUFFIX}`;
}

/**
 * The multi-word cues as plain phrases (no quotes), for mail apps whose rules
 * take one phrase at a time (Outlook, iCloud). Single words are left out: on
 * their own they match too much.
 */
export function plainCues(source: GmailTermSource = gmailFilterTerms, max = 6): string[] {
  return termsOf(source)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.includes(' '))
    .slice(0, max);
}
