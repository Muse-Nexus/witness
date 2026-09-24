export type MailKind = 'magic_link' | 'delivery';

export interface OutgoingMail {
  kind: MailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Log mailer only: a link that is safe to print in local development (the sign-in link). */
  devLink?: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<{ id?: string }>;
}

export class MailError extends Error {
  override name = 'MailError';
}

/**
 * Header added to every message Witness sends, so a person's own forwarding
 * filter cannot loop a delivery back in as new evidence.
 */
export const WITNESS_MAIL_HEADER = 'X-Witness-Mail';
