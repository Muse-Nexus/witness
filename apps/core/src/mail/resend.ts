/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
import { MailError, type Mailer } from './types.js';

/** A send that takes longer is given up, well inside a delivery claim (store/rhythm.ts). */
export const RESEND_TIMEOUT_MS = 30_000;

export function resendMailer(
  apiKey: string,
  from: { email: string; name: string },
  fetcher: typeof fetch = fetch,
  timeoutMs = RESEND_TIMEOUT_MS,
): Mailer {
  const fromHeader = from.name ? `${from.name} <${from.email}>` : from.email;
  return {
    async send(mail) {
      let response: Response;
      try {
        response = await fetcher('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromHeader,
            to: [mail.to],
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            ...(mail.headers ? { headers: mail.headers } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new MailError('resend failed: timeout');
        throw error;
      }
      if (!response.ok) {
        // The error body can echo the request; only the status is kept.
        await response.body?.cancel();
        throw new MailError(`resend failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as { id?: string };
      return body.id ? { id: body.id } : {};
    },
  };
}
