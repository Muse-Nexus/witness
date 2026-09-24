/**
 * Environment and configuration. `Env` is generated from wrangler.jsonc by
 * `bun run types` (worker-configuration.d.ts); this file adds the optional
 * secrets and turns the string vars into a typed config.
 */

export type AppEnv = Omit<Env, 'EMAIL'> & {
  /** Optional: self-hosters using Resend or the log mailer may remove the binding. */
  EMAIL?: SendEmail;
  RESEND_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

export type MailerKind = 'log' | 'cloudflare' | 'resend';
export type InboundAddressStyle = 'plus' | 'local';

export interface Config {
  appUrl: URL;
  /** Origin of APP_URL, e.g. "https://witness.example.com". */
  appOrigin: string;
  inboundDomain: string;
  /** `plus`: INBOUND_PLUS_USER+<slug>@domain (one routing rule). `local`: <slug>@domain (catch-all). */
  inboundAddressStyle: InboundAddressStyle;
  /** The mailbox that carries plus addresses, e.g. "witness". */
  inboundPlusUser: string;
  mailFrom: { email: string; name: string };
  mailer: MailerKind;
  signups: 'open' | 'invite';
  allowedEmails: ReadonlySet<string>;
  judge: 'none' | 'anthropic';
  model: string;
  /** Cookies get `Secure` everywhere except plain-http localhost development. */
  secureCookies: boolean;
  /** GET /api/v1/dev/outbox exists only for the log mailer on localhost. */
  devOutbox: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalhost(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

/** Parses `Name <addr@example.com>` or a bare address. */
export function parseMailbox(value: string): { email: string; name: string } {
  const angle = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (angle) return { name: (angle[1] ?? '').replace(/^"|"$/g, '').trim(), email: angle[2]!.trim() };
  const bare = value.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) return { name: '', email: bare };
  throw new ConfigError('MAIL_FROM must be an email address, optionally with a display name');
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, name: string): T {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new ConfigError(`${name} must be one of: ${allowed.join(', ')}`);
}

/** The mailbox name for plus addresses: lowercase letters, digits, dots, dashes, underscores; no "+". */
function plusUser(value: string | undefined): string {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return 'witness';
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(v)) throw new ConfigError('INBOUND_PLUS_USER must be a plain mailbox name such as "witness" (letters, digits, . _ -)');
  return v;
}

/** A person's Witness address, in the configured style (SPEC §8, "Inbound email"). */
export function inboundAddressFor(cfg: Config, slug: string): string {
  return cfg.inboundAddressStyle === 'plus' ? `${cfg.inboundPlusUser}+${slug}@${cfg.inboundDomain}` : `${slug}@${cfg.inboundDomain}`;
}

/**
 * The slug an inbound recipient addresses, in either style, whatever the configured one:
 * `<plusUser>+<slug>[+tag]@domain` or `<slug>[+tag]@domain`. Null for anything else.
 */
export function inboundSlugOf(cfg: Config, recipient: string): string | null {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || address.slice(at + 1) !== cfg.inboundDomain) return null;
  const local = address.slice(0, at);
  const plusPrefix = `${cfg.inboundPlusUser}+`;
  const candidate = local.startsWith(plusPrefix) ? local.slice(plusPrefix.length).split('+')[0]! : local.split('+')[0]!;
  return /^[a-z0-9]{10}$/.test(candidate) ? candidate : null;
}

export function config(env: AppEnv): Config {
  let appUrl: URL;
  try {
    appUrl = new URL(env.APP_URL);
  } catch {
    throw new ConfigError('APP_URL must be an absolute URL');
  }
  const mailer = oneOf(env.MAILER, ['log', 'cloudflare', 'resend'] as const, 'log', 'MAILER');
  const judgeRequested = oneOf(env.WITNESS_JUDGE, ['none', 'anthropic'] as const, 'none', 'WITNESS_JUDGE');
  const local = isLocalhost(appUrl);
  return {
    appUrl,
    appOrigin: appUrl.origin,
    inboundDomain: (env.INBOUND_DOMAIN ?? '').trim().toLowerCase(),
    inboundAddressStyle: oneOf(env.INBOUND_ADDRESS_STYLE, ['plus', 'local'] as const, 'plus', 'INBOUND_ADDRESS_STYLE'),
    inboundPlusUser: plusUser(env.INBOUND_PLUS_USER),
    mailFrom: parseMailbox(env.MAIL_FROM),
    mailer,
    signups: oneOf(env.SIGNUPS, ['open', 'invite'] as const, 'invite', 'SIGNUPS'),
    allowedEmails: new Set(
      (env.ALLOWED_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    // The model stage only runs with a key; without one the rules verdict stands.
    judge: judgeRequested === 'anthropic' && env.ANTHROPIC_API_KEY ? 'anthropic' : 'none',
    model: (env.WITNESS_MODEL ?? '').trim() || 'claude-haiku-4-5',
    secureCookies: !(local && appUrl.protocol === 'http:'),
    devOutbox: mailer === 'log' && local,
  };
}

/**
 * Local-development settings must never serve the public: MAILER=log prints sign-in links
 * and keeps mail in a readable outbox, and a localhost APP_URL turns off Secure cookies and
 * points every emailed link at localhost. On any other host this throws, so a deployment
 * that still has them fails closed instead of leaking sign-in links.
 */
export function assertServesHost(cfg: Config, requestUrl: URL): void {
  if (isLocalhost(requestUrl)) return;
  if (cfg.mailer === 'log') {
    throw new ConfigError('MAILER=log is for local development only. Set MAILER to cloudflare or resend before serving this host.');
  }
  if (isLocalhost(cfg.appUrl)) {
    throw new ConfigError('APP_URL still points at localhost. Set it to this deployment\'s https address.');
  }
}

/** Absolute URL on this deployment. */
export function appLink(cfg: Config, path: string): string {
  return new URL(path, cfg.appUrl).toString();
}
