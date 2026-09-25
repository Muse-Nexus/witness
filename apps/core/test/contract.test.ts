/**
 * The web app's half of the contract (SPEC §10.1, apps/web/src/api/types.ts).
 * Every endpoint the web client calls is exercised here with the shape it expects.
 * All people and messages are fictional.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ORIGIN, PNG_1X1, asUser, call, createToken, signIn, withBearer } from './helpers.js';

const ITEM_KEYS = [
  'id',
  'status',
  'kind',
  'quote',
  'context',
  'fromName',
  'occurredAt',
  'sourceType',
  'sourceLabel',
  'category',
  'categoryKnown',
  'edited',
  'mediaType',
  'mediaUrl',
  'createdAt',
  'updatedAt',
];

function expectItem(value: unknown) {
  expect(value).toBeTypeOf('object');
  for (const key of ITEM_KEYS) expect(value).toHaveProperty(key);
  const item = value as Record<string, unknown>;
  expect(typeof item.edited).toBe('boolean');
  expect(['saved', 'maybe', 'removed']).toContain(item.status);
  // Always a category the web app can show (an item nothing sorted says so in categoryKnown).
  expect(['love', 'care', 'pride', 'gratitude', 'trust', 'belonging', 'accomplishment', 'recovery', 'other']).toContain(item.category);
  expect(typeof item.categoryKnown).toBe('boolean');
}

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

describe('web contract: items', () => {
  it('POST /items answers 201 with the created Item; a repeat is a 409 duplicate', async () => {
    const session = await signIn();
    const created = await json<Record<string, unknown>>(
      await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: 'You made the whole week lighter.', fromName: 'Rin', occurredAt: Date.UTC(2026, 2, 3) } })),
      201,
    );
    expectItem(created);
    expect(created).toMatchObject({ status: 'saved', kind: 'text', quote: 'You made the whole week lighter.', fromName: 'Rin', sourceType: 'manual', edited: false, mediaType: null });

    const again = await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: 'You made the whole week lighter.', fromName: 'Rin', occurredAt: Date.UTC(2026, 2, 3) } }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('duplicate');
    // The same words from someone else are their own item.
    expect((await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: 'You made the whole week lighter.', fromName: 'Ari', occurredAt: Date.UTC(2026, 2, 3) } }))).status).toBe(201);

    const image = await json<Record<string, unknown>>(
      await call('/api/v1/items', asUser(session, { method: 'POST', body: { image: { base64: btoa(String.fromCharCode(...PNG_1X1)), mediaType: 'image/png' } } })),
      201,
    );
    expectItem(image);
    expect(image).toMatchObject({ kind: 'image', mediaType: 'image/png', mediaUrl: `/api/v1/items/${image.id as string}/media` });
  });

  it('GET /items is {items, nextCursor}; PATCH answers with the updated Item', async () => {
    const session = await signIn();
    const created = await json<{ id: string }>(await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: 'Thank you for the soup.' } })), 201);
    const page = await json<{ items: unknown[]; nextCursor: string | null }>(await call('/api/v1/items?status=saved&limit=30', asUser(session)));
    expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor']);
    expect(page.nextCursor).toBeNull();
    expectItem(page.items[0]);
    const patched = await json<Record<string, unknown>>(await call(`/api/v1/items/${created.id}`, asUser(session, { method: 'PATCH', body: { fromName: 'Ana' } })));
    expectItem(patched);
    expect(patched).toMatchObject({ id: created.id, fromName: 'Ana' });
    // Manual items have no sender, so the card hides "Never save from this sender".
    expect(patched.canBlockSender).toBe(false);
  });
});

describe('web contract: blocked senders', () => {
  it('lists blocked senders with a label and lets the person allow them again', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    const kind = { sourceType: 'text', text: 'Thank you so much for being there for me this week. You mean the world to me.', fromHandle: '+15555550123', fromName: 'Noa K.', threadKind: 'direct' };
    const first = await json<{ status: string; id: string }>(await call('/api/v1/capture', withBearer(device, { method: 'POST', body: kind })), 201);
    expect(first.status).toBe('saved');

    expect(await json(await call('/api/v1/blocked-senders', asUser(session)))).toEqual({ senders: [] });
    const blocked = await json<{ removedIds: string[] }>(await call(`/api/v1/items/${first.id}/block-sender`, asUser(session, { method: 'POST' })));
    expect(blocked.removedIds).toEqual([first.id]);

    const list = await json<{ senders: { senderKey: string; createdAt: number; label: string | null }[] }>(await call('/api/v1/blocked-senders', asUser(session)));
    expect(list.senders).toEqual([{ senderKey: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: expect.any(Number), label: 'Noa K.' }]);
    // The label is stored encrypted, never as plaintext.
    const raw = JSON.stringify(await env.DB.prepare('SELECT * FROM blocked_senders WHERE user_id = ?1').bind(session.userId).all());
    expect(raw).not.toContain('Noa');

    const exported = await json<{ blockedSenders: { label: string | null }[] }>(await call('/api/v1/export', asUser(session)));
    expect(exported.blockedSenders).toEqual([{ senderKey: list.senders[0]!.senderKey, label: 'Noa K.', createdAt: expect.any(Number) }]);

    const blockedAgain = await json<{ status: string }>(await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { ...kind, text: 'Thank you so much for showing up for me today. I am so grateful for you.' } })));
    expect(blockedAgain.status).toBe('blocked');

    const key = list.senders[0]!.senderKey;
    expect(await json(await call(`/api/v1/blocked-senders/${key}`, asUser(session, { method: 'DELETE' })))).toEqual({ ok: true });
    expect((await call(`/api/v1/blocked-senders/${key}`, asUser(session, { method: 'DELETE' }))).status).toBe(404);
    expect((await call('/api/v1/blocked-senders/not-a-key', asUser(session, { method: 'DELETE' }))).status).toBe(400);
    expect(await json(await call('/api/v1/blocked-senders', asUser(session)))).toEqual({ senders: [] });
    const allowed = await json<{ status: string }>(await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { ...kind, text: 'Thank you so much for showing up for me today. I am so grateful for you.' } })), 201);
    expect(allowed.status).toBe('saved');
  });

  it('needs a session', async () => {
    expect((await call('/api/v1/blocked-senders')).status).toBe(401);
  });
});

describe('web contract: tokens', () => {
  it('creates an assistant token as TokenSummary + token + the four configs', async () => {
    const session = await signIn();
    const created = await json<Record<string, unknown> & { token: string; configs: Record<string, string> }>(
      await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { label: 'My assistant', kind: 'agent' } })),
      201,
    );
    expect(created).toMatchObject({ id: expect.any(String), kind: 'agent', label: 'My assistant', createdAt: expect.any(Number), lastUsedAt: null, revokedAt: null });
    expect(created.token).toMatch(/^wit_agent_/);
    for (const key of ['claudeCode', 'codex', 'json', 'curl']) expect(created.configs[key]).toContain(created.token);
    // The curl check reads counts only; it never adds anything.
    expect(created.configs.curl).toBe(`curl -s ${ORIGIN}/api/v1/status \\\n  -H "Authorization: Bearer ${created.token}"`);
    expect((await call('/api/v1/status', withBearer(created.token))).status).toBe(200);

    const list = await json<{ tokens: Record<string, unknown>[] }>(await call('/api/v1/tokens', asUser(session)));
    expect(list.tokens).toHaveLength(1);
    expect(Object.keys(list.tokens[0]!).sort()).toEqual(['createdAt', 'id', 'kind', 'label', 'lastUsedAt', 'revokedAt', 'scopes'].sort());
    expect(JSON.stringify(list)).not.toContain(created.token);
  });

  it('gives an assistant key a status curl check only when it may read status', async () => {
    const session = await signIn();
    const addOnly = await json<{ scopes: string[]; token: string; configs: Record<string, string> }>(
      await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { label: 'ChorOS', kind: 'agent', scopes: ['add'] } })),
      201,
    );
    expect(addOnly.scopes).toEqual(['add']);
    expect(Object.keys(addOnly.configs).sort()).toEqual(['captureUrl', 'claudeCode', 'codex', 'json', 'mcpUrl']);
    for (const key of ['claudeCode', 'codex', 'json']) expect(addOnly.configs[key]).toContain(addOnly.token);
    // What a status check would have met.
    expect((await call('/api/v1/status', withBearer(addOnly.token))).status).toBe(403);

    const withStatus = await json<{ token: string; configs: Record<string, string> }>(
      await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { label: 'Checker', kind: 'agent', scopes: ['add', 'status'] } })),
      201,
    );
    expect(withStatus.configs.curl).toBe(`curl -s ${ORIGIN}/api/v1/status \\\n  -H "Authorization: Bearer ${withStatus.token}"`);
    expect((await call('/api/v1/status', withBearer(withStatus.token))).status).toBe(200);
  });

  it('gives device tokens capture and status by default, and a status curl check', async () => {
    const session = await signIn();
    const created = await json<{ kind: string; scopes: string[]; token: string; configs: Record<string, string> }>(
      await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { label: 'iPhone', kind: 'device' } })),
      201,
    );
    expect(created.kind).toBe('device');
    expect(created.scopes).toEqual(['capture', 'status']);
    expect(created.token).toMatch(/^wit_dev_/);
    expect(created.configs).toEqual({
      captureUrl: `${ORIGIN}/api/v1/capture`,
      curl: `curl -s ${ORIGIN}/api/v1/status \\\n  -H "Authorization: Bearer ${created.token}"`,
    });
    expect((await call('/api/v1/status', withBearer(created.token))).status).toBe(200);
    // A capture-only key (the iPhone shortcut's) gets no status check to paste.
    const captureOnly = await json<{ scopes: string[]; configs: Record<string, string> }>(
      await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { label: 'iPhone', kind: 'device', scopes: ['capture'] } })),
      201,
    );
    expect(captureOnly.scopes).toEqual(['capture']);
    expect(captureOnly.configs).toEqual({ captureUrl: `${ORIGIN}/api/v1/capture` });
    // A device token is not an MCP token.
    expect((await call('/mcp', withBearer(created.token, { method: 'POST', body: {} }))).status).toBe(403);
  });
});

describe('web contract: rhythm, addresses, confirmations, account', () => {
  it('rhythm reads and mutations all answer with the full rhythm; send-now is {sent}', async () => {
    const session = await signIn();
    const fields = ['enabled', 'localTime', 'days', 'timezone', 'channel', 'consentedAt', 'pausedUntil', 'nextAt'];
    const initial = await json<Record<string, unknown>>(await call('/api/v1/rhythm', asUser(session)));
    for (const f of fields) expect(initial).toHaveProperty(f);
    expect(initial.enabled).toBe(false);

    const saved = await json<Record<string, unknown>>(
      await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, localTime: '07:45', days: ['mon', 'wed'], timezone: 'Pacific/Honolulu', channel: 'email' } })),
    );
    expect(saved).toMatchObject({ enabled: true, localTime: '07:45', days: ['mon', 'wed'], timezone: 'Pacific/Honolulu', channel: 'email', consentedAt: expect.any(Number), nextAt: expect.any(Number), pausedUntil: null });
    // The zone picked for the rhythm becomes the account's zone (it starts as UTC).
    expect(((await json<{ timezone: string }>(await call('/api/v1/me', asUser(session))))).timezone).toBe('Pacific/Honolulu');
    const paused = await json<Record<string, unknown>>(await call('/api/v1/rhythm/pause', asUser(session, { method: 'POST', body: { days: 7 } })));
    for (const f of fields) expect(paused).toHaveProperty(f);
    expect(paused.pausedUntil).toEqual(expect.any(Number));
    const resumed = await json<Record<string, unknown>>(await call('/api/v1/rhythm/resume', asUser(session, { method: 'POST' })));
    expect(resumed.pausedUntil).toBeNull();

    // Nothing kept yet: nothing is sent, and the answer says so without a message.
    const empty = await json<{ sent: boolean }>(await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' })));
    expect(empty.sent).toBe(false);
  });

  it('confirmations are null until one arrives; addresses answer as the web expects', async () => {
    const session = await signIn();
    expect(await json(await call('/api/v1/inbound/confirmations', asUser(session)))).toBeNull();
    const added = await json<{ address: string; verifiedAt: number }>(await call('/api/v1/addresses', asUser(session, { method: 'POST', body: { address: 'me@work.example.org' } })), 201);
    expect(added).toMatchObject({ address: 'me@work.example.org', verifiedAt: expect.any(Number) });
    // The web client removes with a JSON body.
    expect((await call('/api/v1/addresses', asUser(session, { method: 'DELETE', body: { address: 'me@work.example.org' } }))).status).toBe(200);
    const list = await json<{ addresses: { address: string; verifiedAt: number | null }[] }>(await call('/api/v1/addresses', asUser(session)));
    expect(list.addresses.map((a) => a.address)).toEqual([session.email]);
  });

  it('me and status have the fields the home page reads', async () => {
    const session = await signIn();
    const me = await json<Record<string, unknown>>(await call('/api/v1/me', asUser(session)));
    expect(Object.keys(me).sort()).toEqual(['createdAt', 'displayName', 'email', 'inboundAddress', 'timezone']);
    const status = await json<Record<string, unknown>>(await call('/api/v1/status', asUser(session)));
    expect(status).toMatchObject({ saved: 0, maybe: 0, lastCapturedAt: null, sources: [], rhythm: { enabled: false, nextAt: null, pausedUntil: null } });
  });
});
