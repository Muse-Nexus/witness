/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
import { MailError, type Mailer } from './types.js';

export function resendMailer(apiKey: string, from: { email: string; name: string }, fetcher: typeof fetch = fetch): Mailer {
  const fromHeader = from.name ? `${from.name} <${from.email}>` : from.email;
  return {
    async send(mail) {
      const response = await fetcher('https://api.resend.com/emails', {
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
      });
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
