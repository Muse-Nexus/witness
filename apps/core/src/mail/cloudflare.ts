/** Cloudflare Email Service through the send_email binding. The MAIL_FROM domain must be onboarded. */
import { MailError, type Mailer } from './types.js';

export function cloudflareMailer(binding: SendEmail, from: { email: string; name: string }): Mailer {
  return {
    async send(mail) {
      try {
        const result = await binding.send({
          to: mail.to,
          from: from.name ? { email: from.email, name: from.name } : from.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(mail.headers ? { headers: mail.headers } : {}),
        });
        return { id: result.messageId };
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
        throw new MailError(`send_email failed: ${code}`);
      }
    },
  };
}
