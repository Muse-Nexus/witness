import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dedupeKey } from '@witness/detector';
import { MAX_TEXT_CHARS, capture } from '../src/capture.js';
import { base64Encode } from '../src/crypto.js';
import { config } from '../src/env.js';
import { PNG_1X1, addManual, asUser, call, createToken, keyring, signIn, testEnv, withBearer, type Session } from './helpers.js';

interface CaptureResponse {
  status: string;
  id?: string;
  category?: string;
  quote?: string;
  reason?: string;
}

async function captureAs(token: string, body: Record<string, unknown>): Promise<CaptureResponse> {
  const res = await call('/api/v1/capture', withBearer(token, { method: 'POST', body }));
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as CaptureResponse;
}

const KIND_TEXT = "I'm so proud of you. Seriously. You showed up every single day for this.";

async function deviceSession(): Promise<{ session: Session; device: string }> {
  const session = await signIn();
  return { session, device: await createToken(session, 'device') };
}

describe('POST /api/v1/capture', () => {
  it('saves clear evidence, keeping an exact quote', async () => {
    const { device } = await deviceSession();
    const result = await captureAs(device, {
      sourceType: 'text',
      text: KIND_TEXT,
      fromName: 'Dana Reyes',
      fromHandle: '+15555550101',
      threadKind: 'direct',
      sourceLabel: 'iMessage',
      sourceRef: 'msg-1',
    });
    expect(result.status).toBe('saved');
    expect(result.category).toBe('pride');
    expect(KIND_TEXT).toContain(result.quote!);
  });

  it('puts uncertain finds in maybe', async () => {
    const { device } = await deviceSession();
    const result = await captureAs(device, {
      sourceType: 'text',
      text: 'Love you, kiddo. Call me after your exam.',
      fromName: 'Dad',
      fromHandle: '+15555550125',
      threadKind: 'direct',
    });
    expect(result.status).toBe('maybe');
    expect(result.id).toBeTruthy();
  });

  it('excludes non-evidence and stores nothing but a status event', async () => {
    const { session, device } = await deviceSession();
    const result = await captureAs(device, {
      sourceType: 'text',
      text: 'Your verification code is 482913. Do not share it.',
      fromHandle: '+15555550140',
    });
    expect(result.status).toBe('excluded');
    expect(result.id).toBeUndefined();
    const items = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(items?.n).toBe(0);
    const events = await env.DB.prepare('SELECT outcome, reason FROM inbound_events WHERE user_id = ?1').bind(session.userId).all();
    expect(events.results).toEqual([{ outcome: 'excluded', reason: expect.any(String) }]);
  });

  it('keeps each message once, by source id and by text', async () => {
    const { session, device } = await deviceSession();
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>())!.n;
    const body = { sourceType: 'text', text: KIND_TEXT, fromHandle: '+15555550101', threadKind: 'direct', sourceRef: 'msg-dup' };
    expect((await captureAs(device, body)).status).toBe('saved');
    expect(await count()).toBe(1);
    // A device is answered the way a first capture would be, and nothing is stored twice.
    const again = await captureAs(device, body);
    expect(again).toMatchObject({ status: 'saved' });
    expect(again.id).toBeUndefined();
    expect(await count()).toBe(1);
    const noRef = { sourceType: 'text', text: 'Thank you for driving me to the airport at 5am. You are a lifesaver.', threadKind: 'direct' };
    expect((await captureAs(device, noRef)).status).toBe('saved');
    await captureAs(device, { ...noRef, text: '  thank you for driving me to the airport at 5am.   You are a lifesaver.' });
    expect(await count()).toBe(2);
    // The person's own session still hears "duplicate".
    const own = await call('/api/v1/capture', asUser(session, { method: 'POST', body }));
    expect(((await own.json()) as CaptureResponse).status).toBe('duplicate');
  });

  it('never lets a capture-only key test whether a message is already kept', async () => {
    const { session, device } = await deviceSession();
    await captureAs(device, { sourceType: 'text', text: KIND_TEXT, threadKind: 'direct' });
    const probe = await captureAs(device, { sourceType: 'text', text: KIND_TEXT.toUpperCase(), threadKind: 'direct' });
    const fresh = await captureAs(device, { sourceType: 'text', text: 'I am so proud of you. You showed up every day for this and it shows.', threadKind: 'direct' });
    expect(probe.status).toBe(fresh.status);
    expect(Object.keys(probe).sort()).toEqual(['category', 'quote', 'status']);
    // A probe forced to be excluded (a short-code sender) answers the same whether or not the words are kept.
    const forcedKept = await captureAs(device, { sourceType: 'text', text: KIND_TEXT, fromHandle: '12345' });
    const forcedNew = await captureAs(device, { sourceType: 'text', text: 'Never sent before, synthetic.', fromHandle: '12345' });
    expect(forcedKept).toEqual({ status: 'excluded', reason: 'short_code' });
    expect(forcedNew).toEqual({ status: 'excluded', reason: 'short_code' });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('keys dedupe per person with the server key, not a plain hash of the words', async () => {
    const a = await deviceSession();
    const b = await deviceSession();
    const text = 'Love you so much, so proud of you.';
    await captureAs(a.device, { sourceType: 'text', text, threadKind: 'direct' });
    await captureAs(b.device, { sourceType: 'text', text, threadKind: 'direct' });
    const rows = await env.DB.prepare('SELECT user_id, dedupe_key FROM items WHERE user_id IN (?1, ?2)').bind(a.session.userId, b.session.userId).all<{ user_id: string; dedupe_key: string }>();
    expect(rows.results).toHaveLength(2);
    const plain = await dedupeKey('text', { sourceRef: null, text });
    for (const row of rows.results) expect(row.dedupe_key).not.toBe(plain);
    expect(rows.results[0]!.dedupe_key).not.toBe(rows.results[1]!.dedupe_key);
  });

  it('still recognises an item stored under the older plain key', async () => {
    const { session, device } = await deviceSession();
    const text = 'Thank you for the soup when I was sick, you are the kindest.';
    const created = await captureAs(device, { sourceType: 'text', text, threadKind: 'direct' });
    await env.DB.prepare('UPDATE items SET dedupe_key = ?2, text_key = NULL WHERE id = ?1').bind(created.id, await dedupeKey('text', { sourceRef: null, text })).run();
    const own = await call('/api/v1/capture', asUser(session, { method: 'POST', body: { sourceType: 'text', text, threadKind: 'direct' } }));
    expect(((await own.json()) as CaptureResponse).status).toBe('duplicate');
  });

  it('keeps the same words once when they arrive by two paths at the same time', async () => {
    const { session, device } = await deviceSession();
    const phone = await createToken(session, 'device', ['capture'], 'iPhone');
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>())!.n;
    const now = Date.now();
    // Mac helper (message id) first, then the iPhone automation (no id).
    const words = 'So proud of you for finishing the marathon, you inspire me.';
    await captureAs(device, { sourceType: 'text', text: words, fromHandle: '+15555550140', sourceRef: 'guid-a', occurredAt: now, threadKind: 'direct' });
    await captureAs(phone, { sourceType: 'text', text: words });
    expect(await count()).toBe(1);
    // The other way round.
    const other = 'Thank you for being there for me all year, I could not have done it without you.';
    await captureAs(phone, { sourceType: 'text', text: other });
    await captureAs(device, { sourceType: 'text', text: other, fromHandle: '+15555550141', sourceRef: 'guid-b', occurredAt: now, threadKind: 'direct' });
    expect(await count()).toBe(2);
    // Two messages that each have their own id stay two, even with the same words.
    await captureAs(device, { sourceType: 'text', text: words, fromHandle: '+15555550142', sourceRef: 'guid-c', occurredAt: now, threadKind: 'direct' });
    expect(await count()).toBe(3);
    // And the same words days apart are two messages.
    await captureAs(device, { sourceType: 'text', text: other, fromHandle: '+15555550141', sourceRef: 'guid-d', occurredAt: now - 5 * 24 * 60 * 60 * 1000, threadKind: 'direct' });
    expect(await count()).toBe(4);
  });

  it('keeps what the person chose to share, in maybe when the detector would not', async () => {
    const { session, device } = await deviceSession();
    for (const text of ["I'm glad you exist.", 'Your laugh is my favorite sound.']) {
      const shared = await captureAs(device, { sourceType: 'text', text, shared: true });
      expect(shared).toMatchObject({ status: 'maybe', quote: text });
    }
    // An automation (not shared on purpose) still goes through the detector alone.
    expect((await captureAs(device, { sourceType: 'text', text: 'You showed up when nobody else did.' })).status).toBe('excluded');
    const assistant = await createToken(session, 'agent', ['add']);
    const added = await captureAs(assistant, { sourceType: 'agent', text: 'You sat with me at the hospital all night. I won\'t forget it.', sourceLabel: 'Chat' });
    expect(added).toMatchObject({ status: 'maybe', quote: "You sat with me at the hospital all night. I won't forget it." });
  });

  it('lets the person add back words that sit in the old hidden "removed" state', async () => {
    const session = await signIn();
    const id = await addManual(session, { quote: 'You make every room warmer, thank you.' });
    await env.DB.prepare("UPDATE items SET status = 'removed' WHERE id = ?1").bind(id).run();
    const res = await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: 'You make every room warmer, thank you.' } }));
    expect(res.status).toBe(201);
    const rows = await env.DB.prepare('SELECT status FROM items WHERE user_id = ?1').bind(session.userId).all<{ status: string }>();
    expect(rows.results).toEqual([{ status: 'saved' }]);
  });

  it('never saves from a blocked sender', async () => {
    const { session, device } = await deviceSession();
    const first = await captureAs(device, { sourceType: 'text', text: KIND_TEXT, fromHandle: '+1 555 555 0107', threadKind: 'direct' });
    expect(first.status).toBe('saved');
    const block = await call(`/api/v1/items/${first.id}/block-sender`, asUser(session, { method: 'POST' }));
    expect(block.status).toBe(200);
    expect(await block.json()).toEqual({ ok: true, removed: 1, removedIds: [first.id] });
    // Same person, differently formatted number.
    const again = await captureAs(device, { sourceType: 'text', text: 'Thank you so much for everything you did.', fromHandle: '555-555-0107', threadKind: 'direct' });
    expect(again.status).toBe('blocked');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('keeps no plaintext evidence in D1 rows', async () => {
    const { session, device } = await deviceSession();
    await captureAs(device, {
      sourceType: 'text',
      text: KIND_TEXT,
      fromName: 'Dana Reyes',
      fromHandle: '+15555550101',
      threadKind: 'direct',
    });
    await addManual(session, { quote: 'You are the kindest neighbor on Maple Street.', fromName: 'Priya Natarajan', context: 'Card left on the porch' });

    const rows = await env.DB.prepare('SELECT * FROM items WHERE user_id = ?1').bind(session.userId).all();
    expect(rows.results).toHaveLength(2);
    const dump = JSON.stringify(rows.results) + JSON.stringify((await env.DB.prepare('SELECT * FROM inbound_events WHERE user_id = ?1').bind(session.userId).all()).results);
    // `reasons` holds lexicon rule ids (by design, SPEC §5), so check words only the messages contain.
    for (const secret of ['Seriously', 'showed up', 'single day', 'Dana', 'Reyes', '5555550101', 'kindest', 'Maple', 'Priya', 'porch']) {
      expect(dump).not.toContain(secret);
    }
    for (const row of rows.results as { quote_ct: string; from_name_ct: string; sender_key: string | null }[]) {
      expect(row.quote_ct).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
      expect(row.from_name_ct).toMatch(/^v1\./);
    }
  });

  it('encrypts media in R2 and serves it decrypted to the owner only', async () => {
    const { session, device } = await deviceSession();
    const result = await captureAs(device, { sourceType: 'photo', image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' } });
    expect(result.status).toBe('maybe'); // an image with no words waits for review

    const object = await env.MEDIA.get(`u/${session.userId}/${result.id}`);
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object!.arrayBuffer());
    expect(stored.length).toBe(12 + PNG_1X1.length + 16);
    expect(stored.slice(12, 16)).not.toEqual(PNG_1X1.slice(0, 4));
    expect(object!.httpMetadata?.contentType).toBe('application/octet-stream');
    expect(await keyring().openMedia(session.userId, stored)).toEqual(PNG_1X1);

    const media = await call(`/api/v1/items/${result.id}/media`, asUser(session));
    expect(media.status).toBe(200);
    expect(media.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(PNG_1X1);

    const stranger = await signIn();
    expect((await call(`/api/v1/items/${result.id}/media`, asUser(stranger))).status).toBe(404);
    expect((await call(`/api/v1/items/${result.id}/media`)).status).toBe(401);
    expect((await call(`/api/v1/items/${result.id}/media?sig=1.abc`)).status).toBe(403);
  });

  it('saves favorite photos from a device, and rejects files that are not images', async () => {
    const { device } = await deviceSession();
    const fav = await captureAs(device, { sourceType: 'photo', favorite: true, image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' } });
    expect(fav.status).toBe('saved');
    const res = await call(
      '/api/v1/capture',
      withBearer(device, { method: 'POST', body: { sourceType: 'photo', image: { base64: btoa('<html>not an image</html>'), mediaType: 'image/png' } } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_image');
  });

  it('labels assistant captures and never lets a device claim a manual add', async () => {
    const session = await signIn();
    const agent = await createToken(session, 'agent', undefined, 'Claude');
    const device = await createToken(session, 'device');
    const byAgent = await captureAs(agent, { sourceType: 'manual', text: 'Thank you so much for covering my shift. You saved me.', sourceLabel: 'Slack' });
    expect(byAgent.status).not.toBe('excluded');
    const row = await env.DB.prepare('SELECT source_type, source_label FROM items WHERE id = ?1').bind(byAgent.id).first();
    expect(row).toEqual({ source_type: 'agent', source_label: 'Slack · Added by Claude' });

    const res = await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { sourceType: 'manual', text: 'anything' } }));
    expect(res.status).toBe(400);
  });

  it('runs pasted email through extraction before detecting', async () => {
    const { device } = await deviceSession();
    const text = [
      'Hi Jordan,',
      '',
      'Thank you for everything you did for my family this year. I could not have gotten through it without you.',
      '',
      'Grace',
      '',
      'On Sun, Sep 14, 2026 at 8:11 PM Jordan Lee <jordan@example.com> wrote:',
      '> Thinking of you all.',
    ].join('\n');
    const result = await captureAs(device, { sourceType: 'email', text, fromName: 'Grace Okafor', fromHandle: 'grace.okafor@example.com', subject: 'thank you' });
    expect(['saved', 'maybe']).toContain(result.status);
    expect(result.quote).not.toContain('Thinking of you all');
  });
});

describe('items API', () => {
  it('lists newest first with a cursor, searches, edits, removes and deletes', async () => {
    const session = await signIn();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await addManual(session, { quote: `Note number ${i}: thank you, truly.`, fromName: i === 2 ? 'Keanu Kahale' : 'Sam', occurredAt: Date.UTC(2026, 0, 1 + i) }));
    }
    const page1 = (await (await call('/api/v1/items?limit=2', asUser(session))).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page1.items.map((i) => i.id)).toEqual([ids[4], ids[3]]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await (await call(`/api/v1/items?limit=2&cursor=${page1.nextCursor}`, asUser(session))).json()) as { items: { id: string }[]; nextCursor: string };
    expect(page2.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    const page3 = (await (await call(`/api/v1/items?limit=2&cursor=${page2.nextCursor}`, asUser(session))).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page3.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(page3.nextCursor).toBeNull();

    const search = (await (await call('/api/v1/items?q=keanu', asUser(session))).json()) as { items: { id: string; fromName: string; quote: string }[] };
    expect(search.items).toHaveLength(1);
    expect(search.items[0]).toMatchObject({ id: ids[2], fromName: 'Keanu Kahale' });

    const edited = await call(`/api/v1/items/${ids[0]}`, asUser(session, { method: 'PATCH', body: { quote: 'Note number 0: thank you.', category: 'gratitude', fromName: null } }));
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ quote: 'Note number 0: thank you.', edited: true, category: 'gratitude', fromName: null });

    // There is no hidden "removed" state: removing is a delete.
    expect((await call(`/api/v1/items/${ids[1]}`, asUser(session, { method: 'PATCH', body: { status: 'removed' } }))).status).toBe(400);
    expect((await call(`/api/v1/items/${ids[1]}`, asUser(session, { method: 'DELETE' }))).status).toBe(200);
    expect((await call(`/api/v1/items/${ids[3]}`, asUser(session, { method: 'DELETE' }))).status).toBe(200);
    const remaining = (await (await call('/api/v1/items?limit=50', asUser(session))).json()) as { items: { id: string }[] };
    expect(remaining.items.map((i) => i.id).sort()).toEqual([ids[0], ids[2], ids[4]].sort());

    const stranger = await signIn();
    expect((await call(`/api/v1/items/${ids[4]}`, asUser(stranger, { method: 'DELETE' }))).status).toBe(404);
  });

  it('reports status as counts only', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'You made my whole week, thank you.' });
    const status = (await (await call('/api/v1/status', asUser(session))).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ saved: 1, maybe: 0, rhythm: { enabled: false, nextAt: null, pausedUntil: null } });
    expect(status.sources).toEqual([{ type: 'manual', lastAt: expect.any(Number), count7d: 1 }]);
    expect(JSON.stringify(status)).not.toContain('week');
  });
});

describe('blocking a sender ahead of time', () => {
  it('hashes the handle at once and never saves from it, however it is written', async () => {
    const session = await signIn();
    const res = await call('/api/v1/blocked-senders', asUser(session, { method: 'POST', body: { handle: '(555) 555-0188', label: 'Ex' } }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { senderKey: string; label: string };
    expect(created.label).toBe('Ex');
    const row = await env.DB.prepare('SELECT * FROM blocked_senders WHERE user_id = ?1').bind(session.userId).first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain('0188');
    const device = await createToken(session, 'device');
    const result = await captureAs(device, { sourceType: 'text', text: 'I love you so much, I miss you.', fromHandle: '+1 555 555 0188', threadKind: 'direct' });
    expect(result.status).toBe('blocked');
    const list = (await (await call('/api/v1/blocked-senders', asUser(session))).json()) as { senders: { label: string }[] };
    expect(list.senders.map((s) => s.label)).toEqual(['Ex']);
    expect((await call('/api/v1/blocked-senders', asUser(session, { method: 'POST', body: { handle: '  ' } }))).status).toBe(400);
  });
});

describe('never save from this sender, with care', () => {
  it('says how many things came from them first, and can keep what is already here', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    const from = { fromName: 'Aunty Mele', fromHandle: '+15555550166', threadKind: 'direct' };
    const first = await captureAs(device, { sourceType: 'text', text: 'I am so proud of you, truly, you mean the world to me.', sourceRef: 'm-1', ...from });
    await captureAs(device, { sourceType: 'text', text: 'Thank you so much for everything, I love you so much.', sourceRef: 'm-2', ...from });
    const count = await call(`/api/v1/items/${first.id}/sender`, asUser(session));
    expect(await count.json()).toEqual({ count: 2, fromName: 'Aunty Mele' });

    const kept = await call(`/api/v1/items/${first.id}/block-sender`, asUser(session, { method: 'POST', body: { removeExisting: false } }));
    expect(await kept.json()).toEqual({ ok: true, removed: 0, removedIds: [] });
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(rows?.n).toBe(2);
    expect((await captureAs(device, { sourceType: 'text', text: 'So proud of you, always.', ...from })).status).toBe('blocked');
  });

  it('gives a new Witness address and turns the old one away', async () => {
    const session = await signIn();
    const before = ((await (await call('/api/v1/me', asUser(session))).json()) as { inboundAddress: string }).inboundAddress;
    const res = await call('/api/v1/me/inbound-address', asUser(session, { method: 'POST' }));
    expect(res.status).toBe(200);
    const after = ((await res.json()) as { inboundAddress: string }).inboundAddress;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^witness\+[a-z0-9]{10}@in\.example\.com$/);
    const { handleInboundEmail } = await import('../src/inbound-email.js');
    const rejected: string[] = [];
    const bytes = new TextEncoder().encode('Subject: hi\r\n\r\nI am so proud of you.');
    const message = {
      from: session.email,
      to: before,
      headers: new Headers({ subject: 'hi' }),
      raw: new Response(bytes).body!,
      rawSize: bytes.length,
      setReject: (r: string) => rejected.push(r),
    } as unknown as ForwardableEmailMessage;
    await handleInboundEmail(message, env);
    expect(rejected).toEqual(['Unknown recipient']);
  });
});

describe('text longer than Witness reads', () => {
  const filler = ' We talked about the bus schedule and the weather.';

  it('refuses capture text over the limit instead of cutting it, and keeps nothing', async () => {
    const { session, device } = await deviceSession();
    const long = `${KIND_TEXT}${filler.repeat(Math.ceil(MAX_TEXT_CHARS / filler.length))}`;
    expect(long.length).toBeGreaterThan(MAX_TEXT_CHARS);
    const res = await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { sourceType: 'text', text: long, fromHandle: '+15555550101', threadKind: 'direct' } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('20,000');
    const agent = await createToken(session, 'agent');
    expect((await call('/api/v1/capture', withBearer(agent, { method: 'POST', body: { sourceType: 'agent', text: long } }))).status).toBe(400);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(count?.n).toBe(0);
    // Up to the limit is read whole.
    const atLimit = long.slice(0, MAX_TEXT_CHARS);
    expect((await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { sourceType: 'text', text: atLimit, fromHandle: '+15555550101', threadKind: 'direct' } }))).status).toBeLessThan(300);
  });

  it('refuses a hand-added quote or edit over the limit', async () => {
    const session = await signIn();
    const long = 'x'.repeat(MAX_TEXT_CHARS + 1);
    const add = await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: long } }));
    expect(add.status).toBe(400);
    expect(((await add.json()) as { error: { message: string } }).error.message).toContain('20,000');
    const id = await addManual(session, { quote: 'Thank you for the flowers.' });
    expect((await call(`/api/v1/items/${id}`, asUser(session, { method: 'PATCH', body: { quote: long } }))).status).toBe(400);
  });

  it('excludes email whose words run past the limit, whatever comes after the kind part', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    // Kind words first, and past the limit words that would change the verdict.
    const long = `${KIND_TEXT}${filler.repeat(Math.ceil(MAX_TEXT_CHARS / filler.length))} If you leave, you will regret it.`;
    const result = await capture(
      { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now() },
      session.userId,
      { sourceType: 'email', text: long, fromName: 'Rowan', fromHandle: 'rowan@example.com', emailExtracted: true },
    );
    expect(result).toEqual({ status: 'excluded', reason: 'too_long' });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(count?.n).toBe(0);
    const event = await env.DB.prepare('SELECT outcome, reason FROM inbound_events WHERE user_id = ?1').bind(session.userId).first();
    expect(event).toEqual({ outcome: 'excluded', reason: 'too_long' });

    // A subject is read whole or not at all, too: it is scored, and kept as the context.
    const longSubject = await capture(
      { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now() },
      session.userId,
      { sourceType: 'email', text: KIND_TEXT, subject: `thank you ${'so '.repeat(200)}much`, fromHandle: 'rowan@example.com', emailExtracted: true },
    );
    expect(longSubject).toEqual({ status: 'excluded', reason: 'too_long' });
    const tooLongSubject = await call(
      '/api/v1/capture',
      withBearer(device, { method: 'POST', body: { sourceType: 'email', text: KIND_TEXT, subject: 'x'.repeat(501) } }),
    );
    expect(tooLongSubject.status).toBe(400);
  });
});
