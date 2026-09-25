/**
 * What to keep from a thread the owner forwarded (SPEC §8, "Inbound email").
 *
 * The message they forwarded comes first, as always. When it holds nothing worth keeping
 * ("Got them, thanks."), an earlier message in the same thread from someone else may: a
 * middle forwarder's note, or a message quoted in its history. It is credited to whoever
 * wrote it, never to the owner, and dated as the thread dates it (or not at all). One
 * message is kept from any email.
 */
import type { EmailEvidence } from './email.js';
import type { Lexicon } from './lexicon.js';
import { detect } from './rules.js';
import { MAX_TEXT_CHARS } from './types.js';

/** The evidence to capture. `fromThread` marks words taken from the thread rather than the forwarded message. */
export type ThreadPick = Omit<EmailEvidence, 'thread'> & { fromThread?: true };

export function pickFromThread(evidence: EmailEvidence, lexicon?: Lexicon): ThreadPick {
  const { thread, ...latest } = evidence;
  if (!thread?.length || latest.truncated || latest.text.length > MAX_TEXT_CHARS) return latest;
  const worthKeeping = (text: string, from: { name?: string; handle?: string } | undefined): boolean =>
    text.trim() !== '' &&
    text.length <= MAX_TEXT_CHARS &&
    detect(
      {
        text,
        channel: 'email',
        ...(latest.subject ? { subject: latest.subject } : {}),
        ...(from ? { from } : {}),
        headers: latest.headers,
      },
      lexicon,
    ).decision !== 'exclude';
  if (worthKeeping(latest.text, latest.from)) return latest;
  for (const message of thread) {
    if (!worthKeeping(message.text, message.from)) continue;
    const { occurredAt: _forwardedDate, ...rest } = latest;
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
