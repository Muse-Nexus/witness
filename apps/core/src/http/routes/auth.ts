/**
 * Sign-in by magic link.
 *
 * POST /api/v1/auth/start always answers 200 (it never reveals whether an
 * account exists) and sends the mail in the background so timing does not
 * reveal it either.
 *
 * The link opens GET /auth/callback. Only the POST consumes the link: mail
 * scanners that prefetch links (GET, no JavaScript) cannot use it up before the
 * person does. The link is tied to the browser that asked for it by a short-lived
 * pre-auth cookie: there, the page submits itself; anywhere else (another device,
 * or a link someone else sent) it first asks "Continue as a•••@example.com?", so a
 * link cannot quietly sign someone into an account that is not theirs.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashToken, newToken, randomBytes, base64UrlEncode, sha256Hex } from '../../crypto.js';
import { appLink } from '../../env.js';
import { createMailer } from '../../mail/index.js';
import { consumeMagicLink, createMagicLink, createSession, deleteSession, peekMagicLink } from '../../store/auth.js';
import { hitRateLimit } from '../../store/ratelimit.js';
import { createUser, getUserByEmail } from '../../store/users.js';
import { renderMagicLinkEmail } from '../../templates/email.js';
import { SESSION_TTL_MS, clearSessionCookie, isSameOrigin, requireSession, setSessionCookie } from '../auth.js';
import type { AppContext, HonoEnv } from '../context.js';
import { rateLimited } from '../errors.js';
import { jsonBody } from '../middleware.js';
import { htmlPage } from '../pages.js';

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^wit_link_[A-Za-z0-9_-]{43}$/;

const StartBody = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });

/** The pre-auth cookie that ties a sign-in link to the browser that asked for it. */
export const PREAUTH_COOKIE = 'wit_pre';

/**
 * The visitor's address for rate limits. IPv6 is grouped by /64, the block one household
 * or phone gets, so rotating addresses inside it does not dodge the limit.
 */
export function clientIp(c: AppContext): string {
  return rateLimitAddress(c.req.header('cf-connecting-ip') ?? 'unknown');
}

export function rateLimitAddress(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** "a•••@example.com": enough to recognise your own address, not to read someone else's. */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

function mayCreateAccount(c: AppContext, email: string): boolean {
  const cfg = c.get('cfg');
  return cfg.signups === 'open' || cfg.allowedEmails.has(email);
}

// ---------------------------------------------------------------------------
// JSON API: /api/v1/auth/*
// ---------------------------------------------------------------------------

export const authApi = new Hono<HonoEnv>();

authApi.post('/start', async (c) => {
  const { email } = await jsonBody(c, StartBody);
  const db = c.env.DB;
  const now = c.get('now');
  const ip = clientIp(c);

  // Keys are keyed hashes (an IPv4 address cannot be brute-forced back out of a counter).
  const keyring = c.get('keyring');
  const limits = [
    { key: `auth-start:${await keyring.rateLimitKeyFor(`pair|${ip}|${email}`)}`, limit: 5, windowMs: 15 * 60 * 1000 },
    { key: `auth-start-ip:${await keyring.rateLimitKeyFor(`ip|${ip}`)}`, limit: 30, windowMs: 60 * 60 * 1000 },
    // However many addresses a sender uses, one inbox gets only so many sign-in mails.
    { key: `auth-start-email-h:${await keyring.rateLimitKeyFor(`email|${email}`)}`, limit: 5, windowMs: 60 * 60 * 1000 },
    { key: `auth-start-email-d:${await keyring.rateLimitKeyFor(`email|${email}`)}`, limit: 20, windowMs: 24 * 60 * 60 * 1000 },
  ];
  for (const l of limits) {
    const hit = await hitRateLimit(db, { ...l, now });
    if (!hit.allowed) throw rateLimited(hit.retryAfterMs / 1000);
  }

  // Tie the link to this browser: it signs in here at once, and asks first anywhere else.
  const nonce = base64UrlEncode(randomBytes(32));
  const nonceHash = await sha256Hex(nonce);
  setCookie(c, PREAUTH_COOKIE, nonce, {
    httpOnly: true,
    secure: c.get('cfg').secureCookies,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: Math.floor(MAGIC_LINK_TTL_MS / 1000),
  });

  const cfg = c.get('cfg');
  const send = async () => {
    const existing = await getUserByEmail(db, email);
    if (!existing && !mayCreateAccount(c, email)) {
      // Content-free, so an operator can see why no link arrived (for example ALLOWED_EMAILS
      // is empty); the answer to the visitor stays the same either way.
      console.log(JSON.stringify({ event: 'auth.signup_not_allowed', signups: cfg.signups }));
      return;
    }
    const token = newToken('wit_link_');
    await createMagicLink(db, { tokenHash: await hashToken(token), email, expiresAt: now + MAGIC_LINK_TTL_MS, nonceHash });
    const link = appLink(cfg, `/auth/callback?token=${token}`);
    const mail = renderMagicLinkEmail({ link, minutes: MAGIC_LINK_TTL_MS / 60000 });
    await createMailer(c.env, cfg).send({ kind: 'magic_link', to: email, ...mail, devLink: link });
  };
  c.executionCtx.waitUntil(
    send().catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'auth.mail_failed', error: error instanceof Error ? error.message : 'unknown' }));
    }),
  );
  return c.json({ ok: true });
});

authApi.post('/logout', requireSession, async (c) => {
  const auth = c.get('auth');
  if (auth?.kind === 'session') await deleteSession(c.env.DB, auth.userId, auth.sessionHash);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pages: /auth/callback
// ---------------------------------------------------------------------------

export const authPages = new Hono<HonoEnv>();

function expiredLinkPage(c: AppContext) {
  return htmlPage(
    c,
    {
      title: 'Sign-in link expired',
      eyebrow: 'Sign in',
      heading: 'This sign-in link has expired',
      paragraphs: ['Links work once, for 15 minutes. You can ask for a new one.'],
      links: [{ href: '/signin', label: 'Get a new link' }],
    },
    400,
  );
}

/** True when this browser holds the pre-auth cookie the link was made for. */
async function sameBrowser(c: AppContext, nonceHash: string | null): Promise<boolean> {
  const nonce = getCookie(c, PREAUTH_COOKIE);
  return !!nonce && !!nonceHash && (await sha256Hex(nonce)) === nonceHash;
}

/** Opened somewhere other than where it was asked for: say whose account this is, and wait for a click. */
function confirmAccountPage(c: AppContext, token: string, email: string) {
  const who = maskedEmail(email);
  return htmlPage(c, {
    title: 'Sign in',
    eyebrow: 'Sign in',
    heading: `Continue as ${who}?`,
    paragraphs: [
      `This link signs you in to Witness as ${who}. Continue only if that is your email address and you asked for this link.`,
      'If it is not, close this page. Nothing changes.',
    ],
    form: { action: '/auth/callback', button: `Continue as ${who}`, hidden: { token, confirm: '1' } },
  });
}

authPages.get('/callback', async (c) => {
  const token = c.req.query('token') ?? '';
  if (!TOKEN_PATTERN.test(token)) return expiredLinkPage(c);
  const link = await peekMagicLink(c.env.DB, await hashToken(token), c.get('now'));
  if (!link) return expiredLinkPage(c);
  if (!(await sameBrowser(c, link.nonce_hash))) return confirmAccountPage(c, token, link.email);
  return htmlPage(c, {
    title: 'Signing in',
    eyebrow: 'Sign in',
    heading: 'Signing you in',
    paragraphs: ['One moment. If nothing happens, continue below.'],
    form: { action: '/auth/callback', button: 'Continue to Witness', hidden: { token }, autoSubmit: true },
  });
});

authPages.post('/callback', async (c) => {
  // Browsers always send Origin on a cross-site POST, so a missing one is a same-origin form.
  if (c.req.header('origin') !== undefined && !isSameOrigin(c, c.get('cfg'))) return expiredLinkPage(c);
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token : '';
  if (!TOKEN_PATTERN.test(token)) return expiredLinkPage(c);

  const db = c.env.DB;
  const now = c.get('now');
  const tokenHash = await hashToken(token);
  const link = await peekMagicLink(db, tokenHash, now);
  if (!link) return expiredLinkPage(c);
  // Only the browser that asked, or a person who read whose account it is and chose to go on.
  if (form.confirm !== '1' && !(await sameBrowser(c, link.nonce_hash))) return confirmAccountPage(c, token, link.email);
  const email = await consumeMagicLink(db, tokenHash, now);
  if (!email) return expiredLinkPage(c);
  deleteCookie(c, PREAUTH_COOKIE, { path: '/auth', secure: c.get('cfg').secureCookies });

  let user = await getUserByEmail(db, email);
  let firstSignIn = false;
  if (!user) {
    if (!mayCreateAccount(c, email)) {
      return htmlPage(
        c,
        {
          title: 'Invitation needed',
          eyebrow: 'Sign in',
          heading: 'This Witness is invite-only',
          paragraphs: ['The person who runs this Witness has not added your email yet.'],
        },
        403,
      );
    }
    user = await createUser(db, { email, timezone: 'UTC', now });
    firstSignIn = true;
  }

  const session = newToken('wit_sess_');
  await createSession(db, { idHash: await hashToken(session), userId: user.id, now, expiresAt: now + SESSION_TTL_MS });
  setSessionCookie(c, session);
  return c.redirect(firstSignIn ? '/app/setup' : '/app', 303);
});

