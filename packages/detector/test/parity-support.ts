/**
 * The TS <-> Swift prefilter parity cases (SPEC §11). The Mac helper sees a
 * message's text and its sender handle, nothing else, so each case is exactly
 * that, run through the reference `prefilter()` as a text message:
 * `expectPass` = no exclusion and some cue matches.
 *
 * Built from every text-channel corpus example (not from-me: the Mac skips
 * those before the prefilter), a few email bodies (people's handles can be
 * email addresses in Messages), and edge cases for the places the two regex
 * engines or the folding could drift apart. All synthetic.
 */
import { prefilter } from '../src/filters.js';
import { toCandidate, type CorpusExample } from './corpus-support.js';

export interface ParityCase {
  id: string;
  text: string;
  handle?: string;
  expectPass: boolean;
  /** The reference exclusion rule, for reading a failure; the Swift test compares only `expectPass`. */
  excludedBy?: string;
}

/** Edge cases: folding, phrase compilation, sender rules and engine differences. */
export const EDGE_CASES: readonly { id: string; text: string; handle?: string }[] = [
  { id: 'edge-curly-apostrophe', text: 'I couldn’t have done it without you', handle: '+15555550180' },
  { id: 'edge-modifier-apostrophe', text: 'I couldnʼt have done it without you', handle: '+15555550180' },
  { id: 'edge-no-apostrophe', text: 'youre amazing and i couldnt have done it without you', handle: '+15555550180' },
  { id: 'edge-curly-double-quotes', text: 'She said “proud of you” and meant it', handle: '+15555550180' },
  { id: 'edge-hyphen-phrase', text: 'That promotion was well-deserved.', handle: '+15555550181' },
  { id: 'edge-hyphen-as-space', text: 'That promotion was well deserved.', handle: '+15555550181' },
  { id: 'edge-hyphen-closed', text: 'That promotion was welldeserved.', handle: '+15555550181' },
  { id: 'edge-whitespace-run', text: 'Thank   you\nso much', handle: '+15555550182' },
  { id: 'edge-glued-words', text: 'thankyou', handle: '+15555550182' },
  { id: 'edge-inside-word', text: 'Can you grab my glove your size?', handle: '+15555550182' },
  { id: 'edge-uppercase', text: 'PROUD OF YOU', handle: '+15555550183' },
  { id: 'edge-emoji-after', text: 'Thank you❤️', handle: '+15555550183' },
  { id: 'edge-emoji-only', text: '❤️❤️❤️', handle: '+15555550183' },
  { id: 'edge-accent-after', text: 'Thank youé', handle: '+15555550184' },
  { id: 'edge-accent-word', text: 'Merci, café tomorrow?', handle: '+15555550184' },
  { id: 'edge-short-code', text: 'Thank you so much for shopping with us', handle: '733' },
  { id: 'edge-short-code-plus', text: 'Thank you so much for shopping with us', handle: '+123456' },
  { id: 'edge-short-code-formatted', text: 'Thank you so much for shopping with us', handle: '(733) 12' },
  { id: 'edge-seven-digits', text: 'Thank you so much for coming', handle: '5550101' },
  { id: 'edge-business-chat', text: 'Thank you so much for shopping', handle: 'urn:biz:0000-example' },
  { id: 'edge-business-chat-upper', text: 'Thank you so much for shopping', handle: 'URN:BIZ:0000-example' },
  { id: 'edge-alphanumeric-sender', text: 'Thank you for banking with us', handle: 'BANKCO' },
  { id: 'edge-email-handle', text: 'Thank you so much for last night', handle: 'kai.lee@example.com' },
  { id: 'edge-noreply-handle', text: 'Thank you for your order', handle: 'no-reply@example.com' },
  { id: 'edge-notifications-handle', text: 'Thank you for your order', handle: 'notifications@example.com' },
  { id: 'edge-otp', text: 'Thank you. Your code is 123456', handle: '+15555550185' },
  { id: 'edge-otp-passcode', text: 'Your passcode: 99887766', handle: '+15555550185' },
  { id: 'edge-no-handle', text: 'You made my day', handle: undefined },
  { id: 'edge-empty', text: '', handle: '+15555550186' },
  { id: 'edge-ordinary', text: 'Running late, see you at 6', handle: '+15555550186' },
];

/** How many email bodies to include (the first ones by id, for a stable fixture). */
export const EMAIL_CASES = 8;

function caseFor(id: string, text: string, handle: string | undefined): ParityCase {
  const result = prefilter({ text, channel: 'text', ...(handle ? { from: { handle } } : {}) });
  return {
    id,
    text,
    ...(handle ? { handle } : {}),
    expectPass: result.excludedBy === null && result.hasCue,
    ...(result.excludedBy ? { excludedBy: result.excludedBy } : {}),
  };
}

export function buildParityCases(examples: readonly CorpusExample[]): ParityCase[] {
  const sorted = [...examples].sort((a, b) => a.id.localeCompare(b.id));
  const texts = sorted
    .filter((e) => e.channel === 'text' && !e.from?.isMe)
    .map((e) => caseFor(e.id, e.text, e.from?.handle));
  const emails = sorted
    .filter((e) => e.channel === 'email' && !e.from?.isMe)
    .slice(0, EMAIL_CASES)
    .map((e) => {
      const candidate = toCandidate(e);
      return caseFor(e.id, candidate.text, candidate.from?.handle ?? e.from?.handle);
    });
  const edges = EDGE_CASES.map((e) => caseFor(e.id, e.text, e.handle));
  return [...texts, ...emails, ...edges];
}

/** The fixture file's text: stable, one case per line, easy to diff. */
export function formatParityFixture(cases: readonly ParityCase[]): string {
  return `[\n${cases.map((c) => `  ${JSON.stringify(c)}`).join(',\n')}\n]\n`;
}
