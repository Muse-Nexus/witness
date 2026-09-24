import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { base64Encode } from '../src/crypto.js';
import { PNG_1X1, addManual, asUser, call, createToken, signIn, withBearer } from './helpers.js';

const USER_TABLES = ['items', 'blocked_senders', 'rhythms', 'deliveries', 'offers', 'inbound_events', 'pending_confirmations', 'tokens', 'sessions', 'user_addresses'];

describe('export', () => {
  it('returns everything decrypted, with media as base64', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'You taught me how to be brave. Thank you, Mom.', fromName: 'Noa', occurredAt: Date.UTC(2024, 4, 12) });
    await addManual(session, { image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' }, fromName: 'Ikaika' });
    await createToken(session, 'agent', undefined, 'Claude');

    const res = await call('/api/v1/export', asUser(session));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="witness-\d{4}-\d{2}-\d{2}\.witness-export\.json"/);
    const archive = (await res.json()) as {
      format: string;
      account: { email: string; inboundAddress: string };
      items: { quote: string | null; fromName: string; media: { type: string; base64: string } | null }[];
      assistantsAndDevices: { label: string }[];
    };
    expect(archive.format).toBe('muse-nexus-witness-export');
    expect(archive.account.email).toBe(session.email);
    expect(archive.items).toHaveLength(2);
    const text = archive.items.find((i) => i.quote)!;
    expect(text).toMatchObject({ quote: 'You taught me how to be brave. Thank you, Mom.', fromName: 'Noa', media: null });
    const image = archive.items.find((i) => i.media)!;
    expect(image.media).toEqual({ type: 'image/png', base64: base64Encode(PNG_1X1) });
    expect(archive.assistantsAndDevices).toEqual([expect.objectContaining({ label: 'Claude' })]);
    expect(JSON.stringify(archive)).not.toContain('wit_agent_');
  });

  it('exports an empty account as valid JSON', async () => {
    const session = await signIn();
    const archive = (await (await call('/api/v1/export', asUser(session))).json()) as { items: unknown[] };
    expect(archive.items).toEqual([]);
  });
});

describe('delete account', () => {
  it('removes every D1 row and R2 object for the person, and nobody else', async () => {
    const bystander = await signIn();
    await addManual(bystander, { image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' } });

    const session = await signIn();
    await addManual(session, { quote: 'Thank you for everything this year.' });
    await addManual(session, { image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' } });
    const agent = await createToken(session, 'agent');
    await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, timezone: 'Pacific/Honolulu' } }));
    expect((await env.MEDIA.list({ prefix: `u/${session.userId}/` })).objects).toHaveLength(1);

    const res = await call('/api/v1/account', asUser(session, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(res.headers.get('Set-Cookie')).toMatch(/wit_session=;/);

    for (const table of USER_TABLES) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1`).bind(session.userId).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(session.userId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT email FROM magic_links WHERE email = ?1').bind(session.email).first()).toBeNull();
    expect((await env.MEDIA.list({ prefix: `u/${session.userId}/` })).objects).toHaveLength(0);

    expect((await call('/api/v1/me', asUser(session))).status).toBe(401);
    expect((await call('/api/v1/status', withBearer(agent))).status).toBe(401);

    // The bystander keeps everything.
    expect((await env.MEDIA.list({ prefix: `u/${bystander.userId}/` })).objects).toHaveLength(1);
    expect((await call('/api/v1/me', asUser(bystander))).status).toBe(200);
  });

  it('needs the CSRF header like every other cookie mutation', async () => {
    const session = await signIn();
    const res = await call('/api/v1/account', { method: 'DELETE', headers: { Cookie: session.cookie } });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(session.userId).first()).not.toBeNull();
  });
});

describe('addresses and dev outbox', () => {
  it('manages allowed senders and protects the account email', async () => {
    const session = await signIn();
    const add = await call('/api/v1/addresses', asUser(session, { method: 'POST', body: { address: 'Jordan.Work@Example.org' } }));
    expect(add.status).toBe(201);
    expect(await add.json()).toEqual({ address: 'jordan.work@example.org', verifiedAt: expect.any(Number), isAccountEmail: false });
    const list = (await (await call('/api/v1/addresses', asUser(session))).json()) as { addresses: { address: string; isAccountEmail: boolean }[] };
    expect(list.addresses.map((a) => a.address).sort()).toEqual([session.email, 'jordan.work@example.org'].sort());
    expect(list.addresses.find((a) => a.address === session.email)?.isAccountEmail).toBe(true);
    expect((await call(`/api/v1/addresses/${encodeURIComponent(session.email)}`, asUser(session, { method: 'DELETE' }))).status).toBe(409);
    expect((await call('/api/v1/addresses', asUser(session, { method: 'DELETE', body: { address: 'jordan.work@example.org' } }))).status).toBe(200);
  });

  it('serves the dev outbox only for the log mailer on localhost', async () => {
    expect((await call('/api/v1/dev/outbox')).status).toBe(200);
  });

  it('answers unknown API paths with a JSON 404', async () => {
    const res = await call('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });
});
