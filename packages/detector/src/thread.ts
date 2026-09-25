/**
 * What to keep from a thread the owner forwarded (SPEC §8, "Inbound email").
 *
 * The message they forwarded comes first, as always. When it holds nothing worth keeping
 * ("Got them, thanks."), an earlier message in the same thread from someone else may: a
 * middle forwarder's note, or a message quoted in its history. It is credited to whoever
 * wrote it, never to the owner, and dated as the thread dates it (or not at all). One
 * message is kept from any email. When the forwarded message is the owner's own
 * (`fromOwner`), its words are never kept: only the thread's can be.
 *
 * Words the rules cannot read at all (no cue: "Ana talked about you the whole way home") are
 * not nothing: the person chose to forward them, and they are kept whole in maybe. They give
 * way only to a message the rules are sure of, or one that speaks to the person ("You were so
 * good with the kids today."), never to a thanks that does not ("Thanks so much for sending
 * these over"). A short line with no cue ("Got it.") and one whose only cue is weak ("Got them,
 * thanks.") give way to any message worth keeping, and so do words quoted whole with ">"
 * (iPhone and Apple Mail forwards), which are never kept for being chosen.
 */
import type { EmailEvidence } from './email.js';
import { defaultLexicon, type Lexicon } from './lexicon.js';
import { detect } from './rules.js';
import { foldForMatch, hasMatch } from './text.js';
import { MAX_TEXT_CHARS, type Verdict } from './types.js';

/**
 * The evidence to capture. `fromThread` marks words taken from the thread rather than the
 * forwarded message. `fromOwner` stays only when nothing else was found: then the words are the
 * owner's own, and nothing should be kept.
 */
export type ThreadPick = Omit<EmailEvidence, 'thread'> & { fromThread?: true };

/** "Got it.", "Will do, thanks": at most this many words, a reply with no cue is only an acknowledgment. */
const SHORT_REPLY_WORDS = 3;

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export function pickFromThread(evidence: EmailEvidence, lexicon?: Lexicon): ThreadPick {
  const { thread, ...latest } = evidence;
  if (!thread?.length || latest.truncated || latest.text.length > MAX_TEXT_CHARS) return latest;
  const verdictOf = (text: string, from: { name?: string; handle?: string } | undefined) =>
    text.trim() === '' || text.length > MAX_TEXT_CHARS
      ? null
      : detect(
          {
            text,
            channel: 'email',
            ...(latest.subject ? { subject: latest.subject } : {}),
            ...(from ? { from } : {}),
            headers: latest.headers,
          },
          lexicon,
        );
  const forwarded = latest.fromOwner ? null : verdictOf(latest.text, latest.from);
  // The owner's own message is never theirs to keep, however kind; the thread may hold someone else's.
  if (forwarded && forwarded.decision !== 'exclude') return latest;
  // Words the rules found no cue in at all, more than a short acknowledgment, and kept whole in
  // maybe as the person's choice (never words quoted whole with ">": whose they are is uncertain).
  const unread =
    forwarded !== null &&
    forwarded.excludedBy === 'no_cue' &&
    latest.quotedOnly !== true &&
    wordCount(latest.text) > SHORT_REPLY_WORDS;
  const secondPerson = (lexicon ?? defaultLexicon()).secondPerson;
  // What takes the place of unread words: a message the rules are sure of, or one whose kept
  // words speak to the person. A thanks that never says "you" may be as routine as they are.
  const outweighsUnread = (verdict: Verdict): boolean => verdict.decision === 'save' || hasMatch(secondPerson, foldForMatch(verdict.quote));
  for (const message of thread) {
    const verdict = verdictOf(message.text, message.from);
    if (!verdict || verdict.decision === 'exclude' || (unread && !outweighsUnread(verdict))) continue;
    const { occurredAt: _forwardedDate, fromOwner: _ownersOwn, ...rest } = latest;
    return {
      ...rest,
      text: message.text,
      from: message.from,
      ...(message.occurredAt !== undefined ? { occurredAt: message.occurredAt } : {}),
      fromThread: true,
    };
  }
  return latest;
}
