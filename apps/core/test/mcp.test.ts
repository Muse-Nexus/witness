import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, TOOL_DESCRIPTIONS, UNTRUSTED_WORDS } from '../src/mcp.js';
import { ORIGIN, addManual, asUser, call, createToken, signIn, withBearer } from './helpers.js';

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', ORIGIN), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => exports.default.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'witness-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function data(result: unknown): Record<string, unknown> {
  const r = result as CallToolResult;
  expect(r.isError).toBeFalsy();
  return r.structuredContent as Record<string, unknown>;
}

function errorText(result: unknown): string {
  const r = result as CallToolResult;
  expect(r.isError).toBe(true);
  const first = r.content[0];
  return first && first.type === 'text' ? first.text : '';
}

async function setup(scopes?: string[]) {
  const session = await signIn();
  await addManual(session, { quote: 'You held the whole family together this year. Thank you.', fromName: 'Aunty Leilani', occurredAt: Date.UTC(2025, 11, 25) });
  const token = await createToken(session, 'agent', scopes, 'Claude');
  return { session, token, client: await connect(token) };
}

describe('MCP', () => {
  it('initializes and lists tools with ask-first descriptions', async () => {
    const { client } = await setup();
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toContain('988');
    expect(client.getInstructions()).toContain(UNTRUSTED_WORDS);
    const { tools } = await client.listTools();
    // Search hands over evidence without an offer, so a new key does not get it unless the person turns it on.
    expect(tools.map((t) => t.name).sort()).toEqual(['witness_add', 'witness_offer', 'witness_pause', 'witness_reveal', 'witness_status']);
    const offer = tools.find((t) => t.name === 'witness_offer')!;
    for (const phrase of [
      'Use only at a calm, natural moment.',
      'Returns no content.',
      'Ask the person the suggestedAsk in your own gentle words.',
      'Only call witness_reveal if they clearly say yes.',
      'If they decline or seem unsure, drop it for the rest of the conversation.',
      'Never offer to someone in acute crisis: prioritize crisis resources (988 in the US).',
      'Never use evidence to argue with their feelings.',
    ]) {
      expect(offer.description).toContain(phrase);
    }
    const reveal = tools.find((t) => t.name === 'witness_reveal')!;
    expect(reveal.description).toBe(TOOL_DESCRIPTIONS.witness_reveal);
    expect(reveal.description).toContain('Only after an explicit yes to a witness_offer. Show the quote exactly as returned, with who and when. Add nothing that tells them how to feel.');
    await client.ping();
    await client.close();
  });

  it('offers without content, then reveals the exact quote after a yes', async () => {
    const { session, client } = await setup();
    const offer = data(await client.callTool({ name: 'witness_offer', arguments: {} }));
    expect(offer).toMatchObject({ available: true, suggestedAsk: expect.any(String), offerId: expect.any(String) });
    expect(JSON.stringify(offer)).not.toContain('Leilani');
    expect(JSON.stringify(offer)).not.toContain('family');

    const revealed = data(await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.offerId, userSaidYes: true } }));
    expect(revealed).toMatchObject({
      quote: 'You held the whole family together this year. Thank you.',
      fromName: 'Aunty Leilani',
      occurredAt: Date.UTC(2025, 11, 25),
      sourceLabel: 'Added by you',
      category: expect.any(String),
    });
    expect(revealed.attribution).toMatch(/^— Aunty Leilani · December \d{1,2}, 2025 · Added by you$/);
    expect(revealed.protocol).toBe(UNTRUSTED_WORDS);

    const delivery = await env.DB.prepare("SELECT channel FROM deliveries WHERE user_id = ?1 AND channel = 'agent'").bind(session.userId).first();
    expect(delivery).toEqual({ channel: 'agent' });
    await client.close();
  });

  it('refuses a reveal without an offer, twice, too late, or from another token', async () => {
    const { session, client } = await setup();
    expect(errorText(await client.callTool({ name: 'witness_reveal', arguments: { offerId: crypto.randomUUID(), userSaidYes: true } }))).toContain('cannot be revealed');

    // Two offers up front, while the item is still unsent (the first is moved back a day,
    // past the one-offer-a-day limit).
    const offer = data(await client.callTool({ name: 'witness_offer', arguments: {} }));
    await env.DB.prepare('UPDATE offers SET created_at = created_at - 90000000 WHERE id = ?1').bind(offer.offerId).run();
    const late = data(await client.callTool({ name: 'witness_offer', arguments: {} }));
    expect(late.available).toBe(true);

    // userSaidYes must be literally true.
    expect(errorText(await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.offerId, userSaidYes: false } }))).toMatch(/userSaidYes|Invalid/);

    // Another assistant token cannot use this offer.
    const other = await connect(await createToken(session, 'agent', undefined, 'Other assistant'));
    expect(errorText(await other.callTool({ name: 'witness_reveal', arguments: { offerId: offer.offerId, userSaidYes: true } }))).toContain('cannot be revealed');

    // Single use.
    data(await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.offerId, userSaidYes: true } }));
    expect(errorText(await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.offerId, userSaidYes: true } }))).toContain('cannot be revealed');

    // Older than 30 minutes.
    await env.DB.prepare('UPDATE offers SET expires_at = ?2 WHERE id = ?1').bind(late.offerId, Date.now() - 1).run();
    const tooLate = errorText(await client.callTool({ name: 'witness_reveal', arguments: { offerId: late.offerId, userSaidYes: true } }));
    expect(tooLate).toContain('cannot be revealed');
    // After a yes, the assistant is given gentle words, never "there is nothing".
    expect(tooLate).toContain('not available right now');
    expect(tooLate).toContain('Do not say there is nothing');
    expect(tooLate).not.toContain('connection');
    await client.close();
    await other.close();
  });

  it('never offers or reveals while the person has asked for a break', async () => {
    const { session, client } = await setup();
    const offer = data(await client.callTool({ name: 'witness_offer', arguments: {} }));
    const paused = await call('/api/v1/rhythm/pause', asUser(session, { method: 'POST', body: { days: 7 } }));
    expect(paused.status).toBe(200);
    // A later conversation, with a fresh connection.
    const later = await connect(await createToken(session, 'agent', undefined, 'Later'));
    expect(data(await later.callTool({ name: 'witness_offer', arguments: {} }))).toMatchObject({ available: false, offerId: null, suggestedAsk: null });
    // An offer made just before the pause cannot be revealed during it either.
    expect(errorText(await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.offerId, userSaidYes: true } }))).toContain('paused');
    const deliveries = await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(deliveries?.n).toBe(0);
    await client.close();
    await later.close();
  });

  it('offers at most once a day, and stays quiet for a week after an unanswered offer', async () => {
    const { session, client } = await setup();
    const first = data(await client.callTool({ name: 'witness_offer', arguments: {} }));
    expect(first.available).toBe(true);
    // Every new conversation asks again: the answer stays no for the rest of the day.
    for (let i = 0; i < 3; i += 1) {
      const fresh = await connect(await createToken(session, 'agent', undefined, `Session ${i}`));
      expect(data(await fresh.callTool({ name: 'witness_offer', arguments: {} }))).toMatchObject({ available: false, offerId: null });
      await fresh.close();
    }
    const offers = await env.DB.prepare('SELECT COUNT(*) AS n FROM offers WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(offers?.n).toBe(1);

    // Two days later, the unanswered offer (expired, never revealed) still counts as a no.
    const day = 24 * 60 * 60 * 1000;
    await env.DB.prepare('UPDATE offers SET created_at = created_at - ?2, expires_at = expires_at - ?2 WHERE id = ?1').bind(first.offerId, 2 * day).run();
    expect(data(await client.callTool({ name: 'witness_offer', arguments: {} })).available).toBe(false);
    // After a week it may ask again.
    await env.DB.prepare('UPDATE offers SET created_at = created_at - ?2, expires_at = expires_at - ?2 WHERE id = ?1').bind(first.offerId, 6 * day).run();
    expect(data(await client.callTool({ name: 'witness_offer', arguments: {} })).available).toBe(true);
    await client.close();
  });

  it('offers nothing, silently, when nothing qualifies', async () => {
    const session = await signIn();
    const client = await connect(await createToken(session, 'agent'));
    const offer = data(await client.callTool({ name: 'witness_offer', arguments: {} }));
    expect(offer).toMatchObject({ available: false, offerId: null, suggestedAsk: null });
    const offers = await env.DB.prepare('SELECT COUNT(*) AS n FROM offers WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(offers?.n).toBe(0);
    await client.close();
  });

  it('enforces scopes: only permitted tools are listed or callable', async () => {
    const { client } = await setup(['status']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['witness_status']);
    const status = data(await client.callTool({ name: 'witness_status', arguments: {} }));
    expect(status).toMatchObject({ saved: 1, maybe: 0, protocol: expect.stringContaining('Never tell them they have nothing') });
    expect(JSON.stringify(status)).not.toContain('family');
    expect(errorText(await client.callTool({ name: 'witness_offer', arguments: {} }))).toContain('not found');
    expect(errorText(await client.callTool({ name: 'witness_reveal', arguments: { offerId: crypto.randomUUID(), userSaidYes: true } }))).toContain('not found');
    await client.close();
  });

  it('only accepts assistant tokens over POST', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    expect((await call('/mcp', { method: 'POST', headers, body: JSON.stringify(init) })).status).toBe(401);
    expect((await call('/mcp', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${device}` }, body: JSON.stringify(init) })).status).toBe(403);
    expect((await call('/mcp', { headers: { Authorization: `Bearer ${device}` } })).status).toBe(405);
    expect((await call('/mcp', withBearer(await createToken(session, 'agent'), { method: 'GET' }))).status).toBe(405);
  });

  it('adds, searches and pauses', async () => {
    const { session, client } = await setup(['status', 'offer', 'reveal', 'search', 'add', 'pause']);
    const added = data(
      await client.callTool({
        name: 'witness_add',
        arguments: { quote: 'Thank you so much for mentoring me. You changed the way I see my own work.', fromName: 'Ren', sourceLabel: 'Slack', occurredAt: '2026-08-02' },
      }),
    );
    expect(['saved', 'maybe']).toContain(added.status);
    const row = await env.DB.prepare('SELECT source_type, source_label, occurred_at FROM items WHERE id = ?1').bind(added.id).first();
    // A calendar date is kept at midday in the person's zone (UTC here), so it never slips a day.
    expect(row).toEqual({ source_type: 'agent', source_label: 'Slack · Added by Claude', occurred_at: Date.UTC(2026, 7, 2, 12) });

    const found = data(await client.callTool({ name: 'witness_search', arguments: { query: 'leilani' } }));
    expect(found.results).toHaveLength(1);
    expect((found.results as { quote: string }[])[0]!.quote).toBe('You held the whole family together this year. Thank you.');
    expect(found.protocol).toBe(UNTRUSTED_WORDS);
    // What an assistant was shown is on record, without counting as a rhythm delivery.
    const shown = await env.DB.prepare("SELECT status FROM deliveries WHERE user_id = ?1 AND channel = 'agent'").bind(session.userId).all();
    expect(shown.results).toEqual([{ status: 'search' }]);

    const paused = data(await client.callTool({ name: 'witness_pause', arguments: { days: 3 } }));
    expect(paused.pausedUntil).toBeGreaterThan(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const rhythm = await env.DB.prepare('SELECT paused_until FROM rhythms WHERE user_id = ?1').bind(session.userId).first<{ paused_until: number }>();
    expect(rhythm?.paused_until).toBe(paused.pausedUntil);
    await client.close();
  });

  it('keeps search narrow: opt-in, three characters or more, and only words and names', async () => {
    const { client } = await setup(['search']);
    // One letter used to match every category label ("Love", "Care"...) and return everything.
    expect(errorText(await client.callTool({ name: 'witness_search', arguments: { query: 'e' } }))).toMatch(/query|Invalid|3/);
    expect(data(await client.callTool({ name: 'witness_search', arguments: { query: 'Gratitude' } })).results).toEqual([]);
    expect(data(await client.callTool({ name: 'witness_search', arguments: { query: 'Added by you' } })).results).toEqual([]);
    expect(data(await client.callTool({ name: 'witness_search', arguments: { query: 'family' } })).results).toHaveLength(1);
    await client.close();
  });

  it('keeps a date-only occurredAt on that calendar day in the person\'s zone', async () => {
    const { session, client } = await setup(['add', 'search']);
    const put = await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: false, timezone: 'Pacific/Honolulu' } }));
    expect(put.status).toBe(200);
    data(await client.callTool({ name: 'witness_add', arguments: { quote: 'Thank you for the card. I am so proud of you, truly.', fromName: 'Mom', sourceLabel: 'Card', occurredAt: '2026-08-02' } }));
    const found = data(await client.callTool({ name: 'witness_search', arguments: { query: 'the card' } }));
    expect((found.results as { date: string }[])[0]?.date).toBe('August 2, 2026');
    expect(errorText(await client.callTool({ name: 'witness_add', arguments: { quote: 'Thank you so much, truly.', sourceLabel: 'Card', occurredAt: '2026-02-31' } }))).toContain('occurredAt');
    await client.close();
  });

  it('gives a new assistant key search only when the person asks for it', async () => {
    const session = await signIn();
    const res = await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { kind: 'agent', label: 'Claude' } }));
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(['status', 'offer', 'reveal', 'add', 'pause']);
    const withSearch = await call(
      '/api/v1/tokens',
      asUser(session, { method: 'POST', body: { kind: 'agent', label: 'Claude', scopes: ['status', 'offer', 'reveal', 'search', 'add', 'pause'] } }),
    );
    expect(((await withSearch.json()) as { scopes: string[] }).scopes).toContain('search');
  });
});

