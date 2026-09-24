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

/**
 * Appended to every Gmail filter. Tested against a real, busy inbox: without these the
 * cue phrases also catch support replies, receipts, billing notices, auto-replies,
 * blind-copied newsletters and the person's own sent mail. Gmail applies a filter to
 * each incoming message, so `-from:me` keeps the person's own words out.
 */
export const GMAIL_FILTER_SUFFIX = [
  '-from:me',
  '-to:undisclosed-recipients',
  '-unsubscribe',
  '-"out of office" -"out of the office" -"automatic reply" -"auto-reply"',
  '-"sign up" -"register" -"payment" -"invoice" -"receipt" -"your order" -"policy" -"discount" -"webinar"',
  '-from:(noreply OR no-reply OR no_reply OR donotreply OR do-not-reply OR notifications OR notification OR support OR billing OR receipts OR newsletter OR marketing OR mailer-daemon OR careers OR jobs OR recruiting OR talent OR info OR news)',
  '-category:promotions -category:social -category:updates -category:forums',
].join(' ');

/** Anything that carries filter terms: a plain list, or a loaded Lexicon (`lexicon.data.gmailFilterTerms`). */
export type GmailTermSource = readonly string[] | { readonly data: { readonly gmailFilterTerms: readonly string[] } };

function termsOf(source: GmailTermSource): string[] {
  const list = Array.isArray(source) ? (source as readonly string[]) : (source as { data: { gmailFilterTerms: readonly string[] } }).data.gmailFilterTerms;
  return list.map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * The Gmail search string for "Has the words" in a Gmail filter, e.g.
 * `("proud of you" OR "love you" OR ...) -from:me -unsubscribe ...`.
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
