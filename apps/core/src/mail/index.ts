/**
 * Outbound mail. Three interchangeable mailers, chosen by the MAILER var:
 * - log:        prints a line (never the body) and keeps the message in an in-memory outbox (dev and tests)
 * - cloudflare: the send_email binding (Cloudflare Email Service)
 * - resend:     the Resend HTTP API (RESEND_API_KEY)
 */
import { config, type AppEnv, type Config } from '../env.js';
import { cloudflareMailer } from './cloudflare.js';
import { logMailer } from './log.js';
import { resendMailer } from './resend.js';
import { MailError, type Mailer } from './types.js';

export { MailError, WITNESS_MAIL_HEADER } from './types.js';
export type { MailKind, Mailer, OutgoingMail } from './types.js';

export function createMailer(env: AppEnv, cfg: Config = config(env)): Mailer {
  switch (cfg.mailer) {
    case 'cloudflare':
      if (!env.EMAIL) throw new MailError('MAILER is "cloudflare" but the EMAIL send_email binding is missing');
      return cloudflareMailer(env.EMAIL, cfg.mailFrom);
    case 'resend':
      if (!env.RESEND_API_KEY) throw new MailError('MAILER is "resend" but RESEND_API_KEY is not set');
      return resendMailer(env.RESEND_API_KEY, cfg.mailFrom);
    case 'log':
      return logMailer(cfg.devOutbox);
  }
}
