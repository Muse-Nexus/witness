/**
 * OAuth 2.1 for the remote MCP server (SPEC §9), so apps that only connect through
 * OAuth (the claude.ai and Claude apps, and other MCP clients) can add Witness
 * without anyone pasting a key.
 *
 * - Discovery: RFC 9728 protected-resource metadata and RFC 8414 server metadata.
 * - Apps register themselves (RFC 7591). Public clients only, PKCE S256 required.
 * - /oauth/authorize shows the signed-in person which app is asking and where it
 *   will send them back, and waits for their click. Not signed in: sign in first,
 *   then this page again.
 * - /oauth/token trades a one-use code (10 minutes) for an ordinary assistant key
 *   with the default assistant permissions. Search is never granted this way: it
 *   hands over what was kept without the ask-first step, so it stays a choice made
 *   in Settings. The key shows in Settings → Assistants and devices, labelled with
 *   the app's name, and is disconnected there like any other.
 */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { base64UrlEncode, hashToken, newToken } from '../../crypto.js';
import { appLink, type Config } from '../../env.js';
import { clientRedirectUris, consumeCode, createClient, createCode, getClient, type OAuthClientRow } from '../../store/oauth.js';
import { hitRateLimit } from '../../store/ratelimit.js';
import { DEFAULT_AGENT_SCOPES, createToken, listTokens } from '../../store/tokens.js';
import { isSameOrigin } from '../auth.js';
import type { AppContext, HonoEnv } from '../context.js';
import { htmlPage } from '../pages.js';
import { clientIp } from './auth.js';

export const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
/** Where a person who must sign in first comes back to. Path only; read once by the sign-in callback. */
export const OAUTH_RETURN_COOKIE = 'wit_oauth_return';
const RETURN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS = 50;
const CODE_PATTERN = /^wit_oac_[A-Za-z0-9_-]{43}$/;

/** The scopes an app can be given here. Search is left out on purpose (see the header). */
export const OAUTH_SCOPES = DEFAULT_AGENT_SCOPES;

export function protectedResourceMetadataUrl(cfg: Config): string {
  return appLink(cfg, '/.well-known/oauth-protected-resource');
}

/** The value /mcp sends with a 401, so a client can find out how to connect (RFC 9728 §5.1). */
export function mcpChallenge(cfg: Config): string {
  return `Bearer realm="witness", resource_metadata="${protectedResourceMetadataUrl(cfg)}"`;
}

/** CORS for the discovery, registration and token endpoints: browser-based MCP clients call them directly. */
function allowAnyOrigin(c: AppContext): void {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  c.header('Access-Control-Max-Age', '86400');
}

function oauthError(c: AppContext, status: 400 | 401 | 429, error: string, description: string): Response {
  allowAnyOrigin(c);
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
}

// ---------------------------------------------------------------------------
// Discovery: /.well-known/*
// ---------------------------------------------------------------------------

export const oauthWellKnown = new Hono<HonoEnv>();

oauthWellKnown.options('*', (c) => {
  allowAnyOrigin(c);
  return c.body(null, 204);
});

const resourceMetadata = (c: AppContext) => {
  const cfg = c.get('cfg');
  allowAnyOrigin(c);
  return c.json({
    resource: appLink(cfg, '/mcp'),
    authorization_servers: [cfg.appOrigin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Muse Nexus Witness',
  });
};
oauthWellKnown.get('/oauth-protected-resource', resourceMetadata);
oauthWellKnown.get('/oauth-protected-resource/mcp', resourceMetadata);

const serverMetadata = (c: AppContext) => {
  const cfg = c.get('cfg');
  allowAnyOrigin(c);
  return c.json({
    issuer: cfg.appOrigin,
    authorization_endpoint: appLink(cfg, '/oauth/authorize'),
    token_endpoint: appLink(cfg, '/oauth/token'),
    registration_endpoint: appLink(cfg, '/oauth/register'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
  });
};
oauthWellKnown.get('/oauth-authorization-server', serverMetadata);
oauthWellKnown.get('/oauth-authorization-server/mcp', serverMetadata);

// ---------------------------------------------------------------------------
// /oauth/register, /oauth/authorize, /oauth/token
// ---------------------------------------------------------------------------

export const oauthRoutes = new Hono<HonoEnv>();

oauthRoutes.options('/register', (c) => {
  allowAnyOrigin(c);
  return c.body(null, 204);
});
oauthRoutes.options('/token', (c) => {
  allowAnyOrigin(c);
  return c.body(null, 204);
});

/**
 * A redirect URI an app may register: https anywhere, or plain http only on this
 * computer (desktop clients listen on a local port). Never a fragment.
 */
export function acceptableRedirect(uri: string): boolean {
  if (uri.length > 512) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== '' || uri.includes('#')) return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

/** An app's own name, as it gave it: one plain line, short. Shown as text, never as markup. */
function cleanName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 60);
  return name || 'An AI app';
}

const RegisterBody = z.object({
  redirect_uris: z.array(z.string()).min(1).max(5),
  client_name: z.unknown().optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

oauthRoutes.post('/register', async (c) => {
  const now = c.get('now');
  const keyring = c.get('keyring');
  const hit = await hitRateLimit(c.env.DB, {
    key: `oauth-register:${await keyring.rateLimitKeyFor(`ip|${clientIp(c)}`)}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
    now,
  });
  if (!hit.allowed) return oauthError(c, 429, 'too_many_requests', 'Too many registrations. Try again in a little while.');

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return oauthError(c, 400, 'invalid_client_metadata', 'Send the registration as JSON.');
  }
  const parsed = RegisterBody.safeParse(raw);
  if (!parsed.success) return oauthError(c, 400, 'invalid_client_metadata', 'redirect_uris must be a list of one to five addresses.');
  const body = parsed.data;
  if (!body.redirect_uris.every(acceptableRedirect)) {
    return oauthError(c, 400, 'invalid_redirect_uri', 'Each redirect URI must be https, or http on localhost, with no fragment.');
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
    return oauthError(c, 400, 'invalid_client_metadata', 'Witness registers public clients only: token_endpoint_auth_method must be none.');
  }
  if (body.grant_types !== undefined && !body.grant_types.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    return oauthError(c, 400, 'invalid_client_metadata', 'Witness supports the authorization_code grant.');
  }

  const client = await createClient(c.env.DB, { name: cleanName(body.client_name), redirectUris: body.redirect_uris, now });
  allowAnyOrigin(c);
  return c.json(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: client.client_name,
      redirect_uris: clientRedirectUris(client),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
    201,
  );
});

interface AuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
}

type Checked = { ok: true; request: AuthorizeRequest } | { ok: false; page: Response } | { ok: false; redirect: Response };

/** "claude.ai": the one thing about where a person is sent back that they can recognise. */
function hostOf(uri: string): string {
  return new URL(uri).host;
}

function badRequestPage(c: AppContext, why: string): Response {
  return htmlPage(
    c,
    {
      title: 'Cannot connect',
      eyebrow: 'Connect an app',
      heading: 'This connection request cannot be used.',
      paragraphs: [why, 'Nothing was connected. Go back to the app and try connecting again.'],
    },
    400,
  );
}

function errorRedirect(c: AppContext, redirectUri: string, state: string | null, error: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state !== null) url.searchParams.set('state', state);
  return c.redirect(url.toString(), 303);
}

/**
 * Checks an authorization request. Problems with the app or its redirect are shown here,
 * never sent anywhere (an unknown redirect could be anyone's). Problems after that go back
 * to the app, as RFC 6749 §4.1.2.1 says.
 */
async function checkAuthorize(c: AppContext, params: Record<string, string | undefined>): Promise<Checked> {
  const clientId = params.client_id ?? '';
  const client = clientId.length > 0 && clientId.length <= 100 ? await getClient(c.env.DB, clientId) : null;
  if (!client) return { ok: false, page: badRequestPage(c, 'The app that sent you here is not one Witness knows.') };
  const registered = clientRedirectUris(client);
  const redirectUri = params.redirect_uri ?? (registered.length === 1 ? registered[0]! : '');
  if (!registered.includes(redirectUri)) return { ok: false, page: badRequestPage(c, 'The address it wants to send you back to is not the one it registered.') };

  const state = params.state !== undefined && params.state.length <= 1024 ? params.state : null;
  if (params.response_type !== 'code') return { ok: false, redirect: errorRedirect(c, redirectUri, state, 'unsupported_response_type') };
  const challenge = params.code_challenge ?? '';
  if (params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return { ok: false, redirect: errorRedirect(c, redirectUri, state, 'invalid_request') };
  }
  const cfg = c.get('cfg');
  const resource = params.resource;
  if (resource !== undefined && resource !== appLink(cfg, '/mcp') && resource !== cfg.appOrigin && resource !== `${cfg.appOrigin}/`) {
    return { ok: false, redirect: errorRedirect(c, redirectUri, state, 'invalid_target') };
  }
  return { ok: true, request: { client, redirectUri, state, codeChallenge: challenge } };
}

const AUTHORIZE_FIELDS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'] as const;

function pickFields(source: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of AUTHORIZE_FIELDS) {
    const value = source[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

oauthRoutes.get('/authorize', async (c) => {
  const params = pickFields(c.req.query());
  const checked = await checkAuthorize(c, params);
  if (!checked.ok) return 'page' in checked ? checked.page : checked.redirect;
  const { client, redirectUri, state } = checked.request;

  const auth = c.get('auth');
  if (!auth || auth.kind !== 'session') {
    const back = new URL(c.req.url);
    setCookie(c, OAUTH_RETURN_COOKIE, `${back.pathname}${back.search}`, {
      httpOnly: true,
      secure: c.get('cfg').secureCookies,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(RETURN_TTL_MS / 1000),
    });
    return htmlPage(c, {
      title: 'Sign in to connect',
      eyebrow: 'Connect an app',
      heading: 'Sign in to Witness first.',
      paragraphs: [
        `“${client.client_name}” wants to connect to your Witness. Sign in with your email, open the link on this device, and you will come back here to decide.`,
      ],
      links: [{ href: '/signin', label: 'Sign in' }],
    });
  }

  const hidden: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) if (value !== undefined) hidden[name] = value;
  hidden.redirect_uri = redirectUri;
  const cancel = new URL(redirectUri);
  cancel.searchParams.set('error', 'access_denied');
  if (state !== null) cancel.searchParams.set('state', state);
  return htmlPage(c, {
    title: 'Connect an app',
    eyebrow: 'Connect an app',
    heading: `Let “${client.client_name}” use your Witness?`,
    paragraphs: [
      `After this you go back to ${hostOf(redirectUri)}. The name above is the one the app gave itself: continue only if you started this from that app.`,
      'It can see whether things are arriving, ask you first before it shows you one thing you kept, keep something you ask it to keep, and pause Witness. It cannot search what you kept.',
      'You can disconnect it at any time in Settings, under Assistants and devices.',
    ],
    form: { action: '/oauth/authorize', button: 'Connect', hidden },
    links: [{ href: cancel.toString(), label: 'Not now' }],
  });
});

oauthRoutes.post('/authorize', async (c) => {
  // A real click on Witness's own page only: never a form posted from another site.
  if (!isSameOrigin(c, c.get('cfg'))) return badRequestPage(c, 'The request did not come from Witness itself.');
  const auth = c.get('auth');
  if (!auth || auth.kind !== 'session') return badRequestPage(c, 'You are not signed in to Witness on this device.');
  const params = pickFields(await c.req.parseBody());
  const checked = await checkAuthorize(c, params);
  if (!checked.ok) return 'page' in checked ? checked.page : checked.redirect;
  const { client, redirectUri, state, codeChallenge } = checked.request;

  const code = newToken('wit_oac_');
  await createCode(c.env.DB, {
    codeHash: await hashToken(code),
    clientId: client.client_id,
    userId: auth.userId,
    redirectUri,
    codeChallenge,
    scopes: [...OAUTH_SCOPES],
    expiresAt: c.get('now') + OAUTH_CODE_TTL_MS,
  });
  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (state !== null) back.searchParams.set('state', state);
  return c.redirect(back.toString(), 303);
});

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

oauthRoutes.post('/token', async (c) => {
  const type = c.req.header('content-type') ?? '';
  let form: Record<string, unknown>;
  try {
    form = /^application\/json\b/i.test(type) ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
  } catch {
    return oauthError(c, 400, 'invalid_request', 'The token request could not be read.');
  }
  const field = (name: string): string => (typeof form[name] === 'string' ? (form[name] as string) : '');
  if (field('grant_type') !== 'authorization_code') return oauthError(c, 400, 'unsupported_grant_type', 'Witness supports the authorization_code grant.');

  const code = field('code');
  const verifier = field('code_verifier');
  if (!CODE_PATTERN.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return oauthError(c, 400, 'invalid_grant', 'The code or code_verifier is not valid.');
  }
  const db = c.env.DB;
  const now = c.get('now');
  // Used up here whatever happens next, so a code that leaked can be tried only once.
  const row = await consumeCode(db, await hashToken(code), now);
  if (!row) return oauthError(c, 400, 'invalid_grant', 'This code was already used or has expired.');
  const clientId = field('client_id');
  if (clientId !== '' && clientId !== row.client_id) return oauthError(c, 400, 'invalid_grant', 'This code was issued to another app.');
  const redirectUri = field('redirect_uri');
  if (redirectUri !== '' && redirectUri !== row.redirect_uri) return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the one used to ask.');
  if ((await s256(verifier)) !== row.code_challenge) return oauthError(c, 400, 'invalid_grant', 'code_verifier does not match.');

  const client = await getClient(db, row.client_id);
  if (!client) return oauthError(c, 400, 'invalid_grant', 'The app that asked is no longer known.');
  if ((await listTokens(db, row.user_id)).length >= MAX_TOKENS) {
    return oauthError(c, 400, 'invalid_grant', 'This Witness has as many assistants and devices as it can hold. Disconnect one in Settings first.');
  }
  const scopes = [...OAUTH_SCOPES];
  const token = newToken('wit_agent_');
  await createToken(db, { userId: row.user_id, kind: 'agent', label: `${client.client_name} (connected app)`.slice(0, 60), tokenHash: await hashToken(token), scopes, now });
  allowAnyOrigin(c);
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({ access_token: token, token_type: 'Bearer', scope: scopes.join(' ') });
});

/** The path to come back to after signing in, if one was set and is still a connect page. Read once. */
export function takeOAuthReturn(c: AppContext): string | null {
  const value = getCookie(c, OAUTH_RETURN_COOKIE);
  if (value === undefined) return null;
  deleteCookie(c, OAUTH_RETURN_COOKIE, { path: '/', secure: c.get('cfg').secureCookies });
  return value.startsWith('/oauth/authorize?') && value.length <= 4096 ? value : null;
}
