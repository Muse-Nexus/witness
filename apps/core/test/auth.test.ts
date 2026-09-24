import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import type { AppEnv } from '../src/env.js';
import { MAGIC_LINK_TTL_MS, maskedEmail, rateLimitAddress } from '../src/http/routes/auth.js';
import worker from '../src/index.js';
import {
  ORIGIN,
  asUser,
  call,
  consumeLink,
  createToken,
  outbox,
  randomTestIp,
  requestLink,
  requestLinkWithCookie,
  signIn,
  testEnv,
  uniqueEmail,
  visibleText,
  withBearer,
} from './helpers.js';

describe('magic-link sign-in', () => {
  it('signs in with a link, sets the session cookie, and creates the account once', async () => {
    const email = uniqueEmail('jordan');
    const { token, preauth } = await requestLinkWithCookie(email);

    // The link itself only renders a page; scanners that prefetch it do not use it up.
    // In the browser that asked for it, the page submits itself.
    const page = await call(`/auth/callback?token=${token}`, { headers: { Cookie: preauth } });
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('Continue to Witness');
    expect(html).toContain(".submit();");
    expect(visibleText(html)).not.toContain('!');

    const res = await call('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: preauth },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/app/setup');
    const cookie = res.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(/wit_session=wit_sess_[A-Za-z0-9_-]{43}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=2592000/);

    const session = `wit_session=${/wit_session=([^;]+)/.exec(cookie)![1]}`;
    const me = await call('/api/v1/me', { headers: { Cookie: session } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { email: string; inboundAddress: string; timezone: string };
    expect(body.email).toBe(email);
    expect(body.inboundAddress).toMatch(/^witness\+[a-z0-9]{10}@in\.example\.com$/);

    // Second sign-in goes to /app, and the same account.
    const again = await consumeLink(await requestLink(email));
    expect(again.headers.get('Location')).toBe('/app');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?1').bind(email).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('uses each link once', async () => {
    const token = await requestLink(uniqueEmail());
    expect((await consumeLink(token)).status).toBe(303);
    const second = await consumeLink(token);
    expect(second.status).toBe(400);
    const words = visibleText(await second.text());
    expect(words).toContain(`This link was already used or has expired. Each sign-in link works once, for ${MAGIC_LINK_TTL_MS / 60_000} minutes. You can ask for a new one.`);
    expect(words).toContain('Get a new link');
  });

  it('says in the sign-in email that the link works once, and for how long', async () => {
    const email = uniqueEmail();
    await requestLink(email);
    const [mail] = (await outbox()).filter((m) => m.to === email && m.kind === 'magic_link');
    expect(mail!.text).toContain(`It works once, for the next ${MAGIC_LINK_TTL_MS / 60_000} minutes.`);
  });

  it('refuses an expired link', async () => {
    const email = uniqueEmail();
    const token = await requestLink(email);
    await env.DB.prepare('UPDATE magic_links SET expires_at = 1 WHERE email = ?1').bind(email).run();
    expect((await consumeLink(token)).status).toBe(400);
  });

  it('lets the callback page post itself with a real Origin (no no-referrer policy)', async () => {
    // Under "no-referrer" Chrome sends `Origin: null` on the page's own form post, and the
    // callback (rightly) refuses that, so nobody could sign in. Found by the e2e test.
    const token = await requestLink(uniqueEmail());
    const page = await call(`/auth/callback?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Referrer-Policy')).toBe('strict-origin');
    const html = await page.text();
    expect(html).toContain('<meta name="referrer" content="strict-origin">');
    expect(html).not.toContain('no-referrer');
    const nullOrigin = await call('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(nullOrigin.status).toBe(400);
    expect((await consumeLink(token)).status).toBe(303);
  });

  it('refuses a cross-site POST to the callback', async () => {
    const token = await requestLink(uniqueEmail());
    const res = await call('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('answers 200 for any address and never reveals whether it exists', async () => {
    const res = await call('/api/v1/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '2001:db8::a1' },
      body: JSON.stringify({ email: uniqueEmail('nobody') }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('never signs a browser into an account it did not ask for without saying whose it is', async () => {
    // Someone requests a link for their own account and sends it to another person.
    const attacker = uniqueEmail('mallory');
    const victim = await signIn();
    const token = await requestLink(attacker);

    const page = await call(`/auth/callback?token=${token}`, { headers: { Cookie: victim.cookie } });
    const html = await page.text();
    expect(html).not.toContain('.submit();');
    expect(visibleText(html)).toContain(`Continue as ${maskedEmail(attacker)}?`);
    expect(visibleText(html)).not.toContain(attacker);

    // A same-origin post without that click (or the asking browser's cookie) changes nothing.
    const silent = await call('/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: victim.cookie },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
    expect(silent.status).toBe(200);
    expect(silent.headers.get('Set-Cookie') ?? '').not.toContain('wit_session=');
    const still = (await (await call('/api/v1/me', { headers: { Cookie: victim.cookie } })).json()) as { email: string };
    expect(still.email).toBe(victim.email);
    // The link is still unused: only an explicit "Continue as …" uses it.
    expect((await consumeLink(token)).status).toBe(303);
  });

  it('groups IPv6 visitors by /64 and keeps rate-limit keys keyed', async () => {
    expect(rateLimitAddress('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddress('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateLimitAddress('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(rateLimitAddress('198.51.100.7')).toBe('198.51.100.7');

    const email = uniqueEmail();
    // Rotating addresses inside one /64 does not dodge the limit.
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i += 1) {
      const res = await call('/api/v1/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `2001:db8:77:${i % 2}::${i.toString(16)}` },
        body: JSON.stringify({ email }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const keys = await env.DB.prepare("SELECT key FROM rate_limits WHERE key LIKE 'auth-start%'").all<{ key: string }>();
    const plain = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('198.51.100.7'));
    const plainHex = [...new Uint8Array(plain)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(keys.results.some((k) => k.key.includes(plainHex))).toBe(false);
  });

  it('limits sign-in mail to one address, however many visitors ask', async () => {
    const email = uniqueEmail('flooded');
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i += 1) {
      const res = await call('/api/v1/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `2001:db8:${(100 + i).toString(16)}:1::1` },
        body: JSON.stringify({ email }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('rate-limits auth/start per address and visitor', async () => {
    const email = uniqueEmail();
    const send = () =>
      call('/api/v1/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '2001:db8::b2' },
        body: JSON.stringify({ email }),
      });
    for (let i = 0; i < 5; i += 1) expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
  });

  it('rejects a malformed email with a uniform JSON error', async () => {
    const res = await call('/api/v1/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nope' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_request');
    expect(typeof body.error.message).toBe('string');
  });

  it('logs out', async () => {
    const session = await signIn();
    expect((await call('/api/v1/auth/logout', asUser(session, { method: 'POST' }))).status).toBe(200);
    expect((await call('/api/v1/me', asUser(session))).status).toBe(401);
  });
});

describe('invite-only sign-ups', () => {
  const inviteOnly = (allowed: string): AppEnv => ({ ...testEnv, SIGNUPS: 'invite', ALLOWED_EMAILS: allowed });

  /** A request to the Worker with other settings, waiting for its background work (the sign-in mail). */
  async function fetchWith(settings: AppEnv, path: string, init: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(new URL(path, ORIGIN), init), settings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('answers an invited and an uninvited address the same way, and sends a link only to the invited one', async () => {
    const invited = uniqueEmail('invited');
    const stranger = uniqueEmail('stranger');
    const start = (email: string) =>
      fetchWith(inviteOnly(invited), '/api/v1/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomTestIp() },
        body: JSON.stringify({ email }),
      });
    const a = await start(invited);
    const b = await start(stranger);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual(await b.json());
    // The same pre-auth cookie either way; only its random value differs.
    const cookieShape = (res: Response) => (res.headers.get('Set-Cookie') ?? '').replace(/wit_pre=[^;]+/, 'wit_pre=…');
    expect(cookieShape(a)).toBe(cookieShape(b));
    const mail = await outbox();
    expect(mail.filter((m) => m.to === invited && m.kind === 'magic_link')).toHaveLength(1);
    expect(mail.filter((m) => m.to === stranger)).toHaveLength(0);
  });

  it('tells the person holding a link, plainly, when their address is not on the invite list', async () => {
    // The only way here: the invite list changed after this link was sent to its own inbox.
    const token = await requestLink(uniqueEmail('dropped'));
    const res = await fetchWith(inviteOnly(''), '/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
      body: new URLSearchParams({ token, confirm: '1' }).toString(),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Set-Cookie') ?? '').not.toContain('wit_session=');
    const words = visibleText(await res.text());
    expect(words).toContain(
      'Witness is invite-only for now Your email is not on the invite list yet. If you were expecting an invite, ask the person who invited you.',
    );
    expect(words).not.toContain('!');
  });
});

describe('CSRF and session rules', () => {
  it('rejects a mutating cookie request without the CSRF header', async () => {
    const session = await signIn();
    const res = await call('/api/v1/me', {
      method: 'PATCH',
      headers: { Cookie: session.cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Jordan' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('csrf');
  });

  it('rejects a mutating cookie request from another origin', async () => {
    const session = await signIn();
    const res = await call('/api/v1/me', {
      method: 'PATCH',
      headers: { Cookie: session.cookie, Origin: 'https://evil.example', 'X-Witness-CSRF': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Jordan' }),
    });
    expect(res.status).toBe(403);
  });

  it('accepts a same-origin mutation with the CSRF header', async () => {
    const session = await signIn();
    const res = await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { displayName: 'Jordan', timezone: 'Pacific/Honolulu' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ displayName: 'Jordan', timezone: 'Pacific/Honolulu' });
    const bad = await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { timezone: 'Mars/Olympus' } }));
    expect(bad.status).toBe(400);
  });

  it('requires a session for session-only routes', async () => {
    expect((await call('/api/v1/items')).status).toBe(401);
    const res = await call('/api/v1/status');
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });
});

describe('tokens', () => {
  it('stores only a hash, returns the secret once with MCP configs, and can be revoked', async () => {
    const session = await signIn();
    const res = await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { kind: 'agent', label: 'Claude' } }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      label: string;
      scopes: string[];
      token: string;
      configs: { claudeCode: string; codex: string; json: string; curl: string };
    };
    const secret = body.token;
    expect(secret).toMatch(/^wit_agent_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ kind: 'agent', label: 'Claude', lastUsedAt: null, revokedAt: null });
    // Search is opt-in: it hands over evidence without the offer-and-yes step.
    expect(body.scopes).toEqual(['status', 'offer', 'reveal', 'add', 'pause']);
    expect(body.configs.claudeCode).toBe(`claude mcp add --transport http witness ${ORIGIN}/mcp --header "Authorization: Bearer ${secret}"`);
    expect(body.configs.codex).toContain('[mcp_servers.witness]');
    expect(JSON.parse(body.configs.json)).toEqual({
      mcpServers: { witness: { type: 'http', url: `${ORIGIN}/mcp`, headers: { Authorization: `Bearer ${secret}` } } },
    });

    const row = await env.DB.prepare('SELECT token_hash FROM tokens WHERE id = ?1').bind(body.id).first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(await env.DB.prepare('SELECT * FROM tokens').all());
    expect(dump).not.toContain(secret);

    const list = (await (await call('/api/v1/tokens', asUser(session))).json()) as { tokens: { id: string }[] };
    expect(JSON.stringify(list)).not.toContain(secret);

    expect((await call('/api/v1/status', withBearer(secret))).status).toBe(200);
    expect((await call(`/api/v1/tokens/${body.id}`, asUser(session, { method: 'DELETE' }))).status).toBe(200);
    expect((await call('/api/v1/status', withBearer(secret))).status).toBe(401);
  });

  it('keeps session and magic-link secrets hashed at rest', async () => {
    const session = await signIn();
    const secret = session.cookie.split('=')[1]!;
    const sessions = JSON.stringify(await env.DB.prepare('SELECT * FROM sessions').all());
    expect(sessions).not.toContain(secret);
    const links = JSON.stringify(await env.DB.prepare('SELECT * FROM magic_links').all());
    expect(links).not.toContain('wit_link_');
  });

  it('enforces token scopes on REST routes', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    const agentNoPause = await createToken(session, 'agent', ['status']);
    expect((await call('/api/v1/items', withBearer(device))).status).toBe(403);
    expect((await call('/api/v1/rhythm/pause', withBearer(agentNoPause, { method: 'POST', body: { days: 3 } }))).status).toBe(403);
    expect((await call('/api/v1/status', withBearer(agentNoPause))).status).toBe(200);
    const unknownScope = await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { kind: 'device', label: 'x', scopes: ['reveal'] } }));
    expect(unknownScope.status).toBe(400);
    expect((await call('/api/v1/status', withBearer('wit_agent_notarealtoken'))).status).toBe(401);
  });
});

describe('local-only settings never serve the public', () => {
  it('fails closed on any other host while MAILER=log or APP_URL is localhost, and keeps the outbox local', async () => {
    const remote = await exports.default.fetch(new Request('https://muse-nexus-witness.someone.workers.dev/api/v1/dev/outbox'));
    expect(remote.status).toBe(500);
    const start = await exports.default.fetch(
      new Request('https://muse-nexus-witness.someone.workers.dev/api/v1/auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: uniqueEmail() }),
      }),
    );
    expect(start.status).toBe(500);
    // Locally it still works.
    expect(Array.isArray(await outbox())).toBe(true);
  });
});
