/**
 * Development mailer. Prints one line per message (kind and a masked
 * recipient, never the body, because a delivery body is evidence) and keeps
 * the last messages in memory for GET /api/v1/dev/outbox.
 *
 * The outbox is per isolate and exists only when MAILER=log on localhost. A sign-in
 * link is printed only then too: on any other host it would land in persisted logs,
 * where anyone who can read them could sign in as that person.
 */
import type { Mailer, OutgoingMail } from './types.js';

export interface OutboxEntry extends OutgoingMail {
  id: string;
  sentAt: number;
}

const MAX_OUTBOX = 50;
const outbox: OutboxEntry[] = [];

export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** `local`: MAILER=log with a localhost APP_URL (cfg.devOutbox). Only then are messages kept or links printed. */
export function logMailer(local: boolean): Mailer {
  return {
    async send(mail) {
      const entry: OutboxEntry = { ...mail, id: crypto.randomUUID(), sentAt: Date.now() };
      if (local) {
        outbox.unshift(entry);
        outbox.length = Math.min(outbox.length, MAX_OUTBOX);
      }
      const line: Record<string, string> = { event: 'mail.log', kind: mail.kind, to: maskEmail(mail.to) };
      // Sign-in links are not evidence; printing them is what makes local sign-in work without a mail server.
      if (local && mail.devLink) line.link = mail.devLink;
      console.log(JSON.stringify(line));
      return { id: entry.id };
    },
  };
}

export function readOutbox(): readonly OutboxEntry[] {
  return outbox;
}

export function clearOutbox(): void {
  outbox.length = 0;
}
