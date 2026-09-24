/** GET /api/v1/config: public, content-free, and the same answer whoever asks. All people here are fictional. */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/env.js';
import { PUBLIC_CONFIG_MAX_AGE_S } from '../src/http/routes/config.js';
import worker from '../src/index.js';
import { ORIGIN, asUser, call, createToken, signIn, testEnv, uniqueEmail, withBearer } from './helpers.js';

/** GET /api/v1/config from a Worker run with other settings. */
async function configWith(vars: Partial<AppEnv>, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(new URL('/api/v1/config', ORIGIN), init), { ...testEnv, ...vars }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('public config', () => {
  it('answers signed out, with a short cache and the usual API headers', async () => {
    const res = await call('/api/v1/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signups: 'open', aiCheck: false });
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${PUBLIC_CONFIG_MAX_AGE_S}`);
    expect(PUBLIC_CONFIG_MAX_AGE_S).toBeLessThanOrEqual(300);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    // No cookies set, and no CORS: other sites still cannot read the API.
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('says whether sign-ups are open or invite-only', async () => {
    expect(await (await configWith({ SIGNUPS: 'open' })).json()).toMatchObject({ signups: 'open' });
    expect(await (await configWith({ SIGNUPS: 'invite' })).json()).toMatchObject({ signups: 'invite' });
    // Unset means invite-only, as the config itself defaults.
    expect(await (await configWith({ SIGNUPS: '' })).json()).toMatchObject({ signups: 'invite' });
  });

  it('says the AI check is on only when the judge really runs', async () => {
    expect(await (await configWith({ WITNESS_JUDGE: 'none' })).json()).toMatchObject({ aiCheck: false });
    expect(await (await configWith({ WITNESS_JUDGE: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real' })).json()).toMatchObject({ aiCheck: true });
    // Asked for, but with no key the judge never runs.
    expect(await (await configWith({ WITNESS_JUDGE: 'anthropic', ANTHROPIC_API_KEY: '' })).json()).toMatchObject({ aiCheck: false });
  });

  it('says nothing else: not who is asking, not who is invited, not how the server is set up', async () => {
    const invited = uniqueEmail('invited');
    const settings: Partial<AppEnv> = { SIGNUPS: 'invite', ALLOWED_EMAILS: invited, WITNESS_JUDGE: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real' };
    const anonymous = await configWith(settings);
    const body = await anonymous.text();
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(['aiCheck', 'signups']);
    for (const secret of [invited, 'example.com', 'sk-test', 'claude', 'localhost', 'witness@']) expect(body).not.toContain(secret);

    // Signed in, with a device key, or with a key that does not work: the same bytes, and no lookup of who it is.
    const session = await signIn();
    const device = await createToken(session, 'device');
    for (const init of [asUser(session), withBearer(device), withBearer('wit_agent_notarealtoken')]) {
      const res = await configWith(settings, init);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
      expect(res.headers.get('Set-Cookie')).toBeNull();
    }
  });

  it('is read-only: other methods find nothing there', async () => {
    const session = await signIn();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call('/api/v1/config', asUser(session, { method, body: { signups: 'open' } }));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    }
  });
});
