/**
 * Authentication (SPEC §8):
 * - web app: session cookie `wit_session` (HttpOnly, Secure, SameSite=Lax, 30 days);
 *   mutating requests must also send `X-Witness-CSRF: 1` and a same-origin `Origin`.
 * - agents and devices: `Authorization: Bearer wit_agent_…|wit_dev_…`, scope-checked per route.
 */
import type { MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { hashToken } from '../crypto.js';
import type { Config } from '../env.js';
import { extendSession, findSession } from '../store/auth.js';
import { findActiveToken, parseScopes, touchToken, type AgentScope, type DeviceScope } from '../store/tokens.js';
import type { AppContext, HonoEnv } from './context.js';
import { ApiError, forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'wit_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How old a session's last renewal must be before a request renews it again. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
export const CSRF_HEADER = 'X-Witness-CSRF';

export function setSessionCookie(c: AppContext, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.get('cfg').secureCookies,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: c.get('cfg').secureCookies });
}

/** Resolves who is calling, if anyone. Routes decide what they require. */
export const authenticate: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const header = c.req.header('authorization');
  if (header !== undefined) {
    const match = /^Bearer\s+(wit_(?:agent|dev)_[A-Za-z0-9_-]{43})\s*$/.exec(header);
    if (!match) throw unauthorized('That token is not valid.');
    const row = await findActiveToken(c.env.DB, await hashToken(match[1]!));
    if (!row) throw unauthorized('That token is not valid or was revoked.');
    c.set('auth', { kind: 'token', userId: row.user_id, tokenId: row.id, tokenKind: row.kind, label: row.label, scopes: parseScopes(row.scopes) });
    c.executionCtx.waitUntil(touchToken(c.env.DB, row.user_id, row.id, c.get('now')).catch(() => undefined));
  } else {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie && cookie.startsWith('wit_sess_')) {
      const sessionHash = await hashToken(cookie);
      const now = c.get('now');
      const session = await findSession(c.env.DB, sessionHash, now);
      if (session) {
        c.set('auth', { kind: 'session', userId: session.user_id, sessionHash });
        // Sliding: someone who opens Witness at least once a month never has to sign in again.
        // Renewed at most once a day, so most requests do not write.
        if (session.expires_at - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
          if (await extendSession(c.env.DB, session.user_id, sessionHash, now, now + SESSION_TTL_MS)) setSessionCookie(c, cookie);
        }
      }
    }
  }
  await next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSameOrigin(c: AppContext, cfg: Config): boolean {
  const origin = c.req.header('origin');
  if (!origin) return false;
  return origin === new URL(c.req.url).origin || origin === cfg.appOrigin;
}

export interface Requirement {
  /** Allow the web app's session cookie. */
  session?: boolean;
  /** Allow agent tokens with this scope. */
  agent?: AgentScope;
  /** Allow device tokens with this scope. */
  device?: DeviceScope;
}

export function requireAuth(requirement: Requirement): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (!auth) throw unauthorized();
    if (auth.kind === 'session') {
      if (!requirement.session) throw forbidden('This needs an assistant or device token.');
      if (!SAFE_METHODS.has(c.req.method)) {
        if (c.req.header(CSRF_HEADER) !== '1' || !isSameOrigin(c, c.get('cfg'))) {
          throw new ApiError(403, 'csrf', 'This request was blocked because it did not come from Witness itself.');
        }
      }
    } else {
      const scope = auth.tokenKind === 'agent' ? requirement.agent : requirement.device;
      if (!scope) throw forbidden(`This is not available to ${auth.tokenKind === 'agent' ? 'assistant' : 'device'} tokens.`);
      if (!(auth.scopes as string[]).includes(scope)) throw forbidden(`This token does not have the "${scope}" permission.`);
    }
    await next();
  };
}

export const requireSession = requireAuth({ session: true });
