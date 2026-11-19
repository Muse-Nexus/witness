/** OAuth for the remote MCP server (SPEC §9). Every app, address and person here is fictional. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { base64UrlEncode } from '../src/crypto.js';
import { acceptableRedirect } from '../src/http/routes/oauth.js';
import { ORIGIN, asUser, call, consumeLink, randomTestIp, requestLinkWithCookie, signIn, uniqueEmail, visibleText, type Session } from './helpers.js';

const REDIRECT = 'https://app.example.com/oauth/callback';

async function register(body: Record<string, unknown> = { client_name: 'Example Assistant', redirect_uris: [REDIRECT] }): Promise<Response> {
  return call('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomTestIp() },
    body: JSON.stringify(body),
  });
}

async function newClient(): Promise<string> {
  const res = await register();
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    ...extra,
  }).toString();
}

/** Clicks Connect on the consent page as the signed-in person. */
async function approve(session: Session, clientId: string, challenge: string, extra: Record<string, string> = {}): Promise<Response> {
  return call('/oauth/authorize', {
    method: 'POST',
    headers: { Cookie: session.cookie, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: authorizeQuery(clientId, challenge, extra),
    redirect: 'manual',
  });
}

async function exchange(fields: Record<string, string>): Promise<Response> {
  return call('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', ...fields }).toString(),
  });
}

async function codeFor(session: Session, clientId: string, challenge: string): Promise<string> {
  const res = await approve(session, clientId, challenge);
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get('Location')!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('state-123');
  return location.searchParams.get('code')!;
}

describe('discovery', () => {
  it('points an MCP client from a 401 to the metadata, and the metadata to the endpoints', async () => {
    const res = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);

    const bad = await call('/mcp', { method: 'POST', headers: { Authorization: 'Bearer wit_agent_nope', 'Content-Type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('WWW-Authenticate')).toContain('resource_metadata=');

    const resource = (await (await call('/.well-known/oauth-protected-resource')).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(`${ORIGIN}/mcp`);
    expect(resource.authorization_servers).toEqual([ORIGIN]);

    const server = await call('/.well-known/oauth-authorization-server');
    expect(server.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const meta = (await server.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(meta.scopes_supported).not.toContain('search');
  });
});

describe('registration', () => {
  it('accepts https and local http redirects, and refuses the rest', async () => {
    expect(acceptableRedirect('https://app.example.com/cb')).toBe(true);
    expect(acceptableRedirect('http://localhost:6274/cb')).toBe(true);
    expect(acceptableRedirect('http://127.0.0.1:9000/cb')).toBe(true);
    expect(acceptableRedirect('http://app.example.com/cb')).toBe(false);
    expect(acceptableRedirect('https://app.example.com/cb#x')).toBe(false);
    expect(acceptableRedirect('javascript:alert(1)')).toBe(false);
    expect(acceptableRedirect('https://user:pw@app.example.com/cb')).toBe(false);

    expect((await register({ redirect_uris: ['http://app.example.com/cb'] })).status).toBe(400);
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
  });

  it('keeps an app name to one plain line', async () => {
    const res = await register({ client_name: 'Example‮\u0000 App\n<b>', redirect_uris: [REDIRECT] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { client_name: string }).client_name).toBe('Example App<b>');
  });
});

describe('authorize and token', () => {
  it('asks a signed-out person to sign in, then brings them back to decide', async () => {
    const clientId = await newClient();
    const { challenge } = await pkce();
    const page = await call(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`);
    expect(page.status).toBe(200);
    expect(visibleText(await page.text())).toContain('Sign in to Witness first.');
    const returnCookie = /wit_oauth_return=([^;]+)/.exec(page.headers.get('Set-Cookie') ?? '')?.[1];
    expect(returnCookie).toBeDefined();

    const email = uniqueEmail();
    const { token, preauth } = await requestLinkWithCookie(email);
    const res = await call('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: `${preauth}; wit_oauth_return=${returnCookie}` },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`);
  });

  it('never sends a signed-in person anywhere but a connect page', async () => {
    const res = await consumeLink((await requestLinkWithCookie(uniqueEmail())).token, { confirm: '1' });
    expect(res.headers.get('Location')).toBe('/app/setup');
    const { token, preauth } = await requestLinkWithCookie(uniqueEmail());
    const evil = await call('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: `${preauth}; wit_oauth_return=https://evil.example.com/` },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(evil.headers.get('Location')).toBe('/app/setup');
  });

  it('shows who is asking and where it sends you back, and connects only on a click', async () => {
    const session = await signIn();
    const clientId = await newClient();
    const { verifier, challenge } = await pkce();
    const page = await call(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`, asUser(session));
    const text = visibleText(await page.text());
    expect(text).toContain('Let “Example Assistant” use your Witness?');
    expect(text).toContain('app.example.com');
    expect(text).toContain('It cannot search what you kept.');

    const code = await codeFor(session, clientId, challenge);
    const res = await exchange({ code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; scope: string };
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^wit_agent_/);
    expect(body.scope.split(' ')).not.toContain('search');

    // It is an ordinary assistant key: listed in Settings by the app's name, and it works on /mcp.
    const list = (await (await call('/api/v1/tokens', asUser(session))).json()) as { tokens: { label: string; scopes: string[] }[] };
    expect(list.tokens.map((t) => t.label)).toContain('Example Assistant (connected app)');
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', ORIGIN), {
      requestInit: { headers: { Authorization: `Bearer ${body.access_token}` } },
      fetch: (url, init) => exports.default.fetch(new Request(url, init)),
    });
    const client = new Client({ name: 'oauth-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('witness_offer');
    expect(tools).not.toContain('witness_search');
    await client.close();

    // A code works once.
    expect((await exchange({ code, code_verifier: verifier, client_id: clientId })).status).toBe(400);
  });

  it('refuses a wrong verifier, another app, or another redirect, and uses the code up anyway', async () => {
    const session = await signIn();
    const clientId = await newClient();
    const otherClient = await newClient();
    const { verifier, challenge } = await pkce();

    const wrongVerifier = await codeFor(session, clientId, challenge);
    expect((await exchange({ code: wrongVerifier, code_verifier: (await pkce()).verifier })).status).toBe(400);
    expect((await exchange({ code: wrongVerifier, code_verifier: verifier })).status).toBe(400);

    const wrongClient = await codeFor(session, clientId, challenge);
    const res = await exchange({ code: wrongClient, code_verifier: verifier, client_id: otherClient });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');

    const wrongRedirect = await codeFor(session, clientId, challenge);
    expect((await exchange({ code: wrongRedirect, code_verifier: verifier, redirect_uri: 'https://app.example.com/other' })).status).toBe(400);
  });

  it('never redirects to an address the app did not register, and needs PKCE', async () => {
    const session = await signIn();
    const clientId = await newClient();
    const { challenge } = await pkce();
    const page = await call(`/oauth/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: 'https://evil.example.com/cb' })}`, asUser(session));
    expect(page.status).toBe(400);
    expect(page.headers.get('Location')).toBeNull();

    const unknown = await call(`/oauth/authorize?${authorizeQuery('wit_client_nope', challenge)}`, asUser(session));
    expect(unknown.status).toBe(400);

    const plain = await call(`/oauth/authorize?${authorizeQuery(clientId, challenge, { code_challenge_method: 'plain' })}`, { ...asUser(session), redirect: 'manual' });
    expect(plain.status).toBe(303);
    expect(new URL(plain.headers.get('Location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a Connect click posted from another site, or without a sign-in', async () => {
    const session = await signIn();
    const clientId = await newClient();
    const { challenge } = await pkce();
    const crossSite = await call('/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: session.cookie, Origin: 'https://evil.example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: authorizeQuery(clientId, challenge),
      redirect: 'manual',
    });
    expect(crossSite.status).toBe(400);
    const signedOut = await call('/oauth/authorize', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: authorizeQuery(clientId, challenge),
      redirect: 'manual',
    });
    expect(signedOut.status).toBe(400);
    const codes = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });
});

describe('sessions', () => {
  it('renews a session that is being used, and never one that ran out', async () => {
    const session = await signIn();
    const hash = /wit_session=([^;]+)/.exec(session.cookie)![1]!;
    const { hashToken } = await import('../src/crypto.js');
    const idHash = await hashToken(hash);
    const soon = Date.now() + 2 * 24 * 60 * 60 * 1000;
    await env.DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id_hash = ?1').bind(idHash, soon).run();
    const res = await call('/api/v1/me', asUser(session));
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie') ?? '').toContain('wit_session=');
    const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?1').bind(idHash).first<{ expires_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

    // A fresh session is not rewritten on every request.
    const again = await call('/api/v1/me', asUser(session));
    expect(again.headers.get('Set-Cookie')).toBeNull();

    await env.DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id_hash = ?1').bind(idHash, Date.now() - 1000).run();
    expect((await call('/api/v1/me', asUser(session))).status).toBe(401);
  });
});
