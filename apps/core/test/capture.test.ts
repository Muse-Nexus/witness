import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { dedupeKey } from '@witness/detector';
import { MAX_TEXT_CHARS, capture } from '../src/capture.js';
import { base64Encode } from '../src/crypto.js';
import { config } from '../src/env.js';
import worker from '../src/index.js';
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

  it('never keeps a threat, even one the person chose to send in (only their own hand-added words skip that rule)', async () => {
    const { session, device } = await deviceSession();
    const threat = "I love you. Answer me or I'm coming over tonight.";
    expect(await captureAs(device, { sourceType: 'text', text: threat, shared: true })).toMatchObject({
      status: 'excluded',
      reason: expect.stringMatching(/^harm:/),
    });
    // Also when another rule would exclude it first (a business sender id, here).
    expect(await captureAs(device, { sourceType: 'text', text: threat, fromHandle: 'ALERTS', shared: true })).toMatchObject({
      status: 'excluded',
      reason: expect.stringMatching(/^harm:/),
    });
    const assistant = await createToken(session, 'agent', ['add']);
    expect(await captureAs(assistant, { sourceType: 'agent', text: threat, sourceLabel: 'Chat' })).toMatchObject({
      status: 'excluded',
      reason: expect.stringMatching(/^harm:/),
    });
    const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(kept?.n).toBe(0);
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

describe('the same words, from whom and when (no source id)', () => {
  const BIRTHDAY = 'Happy birthday, love you';
  const DAY = 24 * 60 * 60 * 1000;
  const count = async (session: Session) =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>())!.n;
  const direct = (session: Session, input: Parameters<typeof capture>[2], now = Date.now()) =>
    capture({ env: testEnv, cfg: config(testEnv), keyring: keyring(), now }, session.userId, input);

  it('keeps the same words from two people as two items, and tells the phone "kept" both times', async () => {
    const { session, device } = await deviceSession();
    const at = Date.UTC(2026, 5, 14, 18);
    const mom = await captureAs(device, { sourceType: 'text', text: BIRTHDAY, fromName: 'Mom', fromHandle: '+15555550170', occurredAt: at, shared: true });
    const sister = await captureAs(device, { sourceType: 'text', text: BIRTHDAY, fromName: 'Jess', fromHandle: '+15555550171', occurredAt: at, shared: true });
    expect([mom.status, sister.status]).toEqual(['maybe', 'maybe']);
    expect(mom.id && sister.id && mom.id !== sister.id).toBe(true);
    // Two people known only by name (an assistant adding them) are two people too.
    const assistant = await createToken(session, 'agent', ['add']);
    await captureAs(assistant, { sourceType: 'agent', text: BIRTHDAY, fromName: 'Aunt Mae', occurredAt: at });
    await captureAs(assistant, { sourceType: 'agent', text: BIRTHDAY, fromName: 'Uncle Kai', occurredAt: at });
    expect(await count(session)).toBe(4);
  });

  it('keeps the same words from the same person on two birthdays as two items', async () => {
    const { session, device } = await deviceSession();
    const from = { fromName: 'Mom', fromHandle: '+15555550170' };
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: Date.UTC(2025, 5, 14, 18), shared: true });
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: Date.UTC(2026, 5, 14, 18), shared: true });
    expect(await count(session)).toBe(2);
    // With no date at all (the iPhone share sheet), the day it arrived tells them apart.
    const now = Date.UTC(2026, 8, 24, 20);
    expect((await direct(session, { sourceType: 'text', text: 'I love you, kiddo.', personChosen: true }, now)).id).toBeTruthy();
    expect((await direct(session, { sourceType: 'text', text: 'I love you, kiddo.', personChosen: true }, now + 365 * DAY)).id).toBeTruthy();
    expect(await count(session)).toBe(4);
  });

  it('keeps one item for the same words from the same person on the same local day', async () => {
    const { session, device } = await deviceSession();
    const from = { fromName: 'Mom', fromHandle: '+15555550170' };
    const at = Date.UTC(2026, 5, 14, 18);
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at, shared: true });
    const again = await captureAs(device, { sourceType: 'text', text: `  ${BIRTHDAY.toUpperCase()} `, ...from, occurredAt: at + 60_000, shared: true });
    // The phone hears what a first capture would get, and nothing is stored twice.
    expect(again).toMatchObject({ status: 'maybe' });
    expect(again.id).toBeUndefined();
    // Shared twice from the share sheet on the same day, with nobody named.
    const now = Date.UTC(2026, 8, 24, 20);
    await direct(session, { sourceType: 'text', text: 'You are my favorite person.', personChosen: true, neutralDuplicates: true }, now);
    await direct(session, { sourceType: 'text', text: 'You are my favorite person.', personChosen: true, neutralDuplicates: true }, now + 60 * 60 * 1000);
    expect(await count(session)).toBe(2);
    // The person's own session still hears "duplicate".
    const own = await call('/api/v1/capture', asUser(session, { method: 'POST', body: { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at } }));
    expect(((await own.json()) as CaptureResponse).status).toBe('duplicate');
  });

  it('counts days in the person\'s own time zone', async () => {
    const { session, device } = await deviceSession();
    expect((await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { timezone: 'Pacific/Honolulu' } }))).status).toBe(200);
    const from = { fromName: 'Mom', fromHandle: '+15555550170' };
    // 11 PM and 11:30 PM on June 14 in Honolulu: different days in UTC, one day there.
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: Date.UTC(2026, 5, 15, 9), shared: true });
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: Date.UTC(2026, 5, 15, 9, 30), shared: true });
    expect(await count(session)).toBe(1);
    // 12:30 AM on June 15 there is the next day: the same UTC day as the first, but a new day for them.
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: Date.UTC(2026, 5, 15, 10, 30), shared: true });
    expect(await count(session)).toBe(2);
  });

  it('still matches items kept under the older keys, only for the same sender on the same day', async () => {
    const { session, device } = await deviceSession();
    const from = { fromName: 'Mom', fromHandle: '+15555550170' };
    const at = Date.UTC(2026, 5, 14, 18);
    const first = await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at, shared: true });
    // As a row kept before this change: keyed on the words alone (dedupe_key = text_key).
    await env.DB.prepare('UPDATE items SET dedupe_key = text_key WHERE id = ?1').bind(first.id).run();
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at + 60_000, shared: true });
    expect(await count(session)).toBe(1);
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, fromName: 'Jess', fromHandle: '+15555550171', occurredAt: at, shared: true });
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at + 365 * DAY, shared: true });
    expect(await count(session)).toBe(3);
    // And one kept before keyed dedupe (a plain SHA-256 of the words, no text_key), by name only.
    const assistant = await createToken(session, 'agent', ['add']);
    const byName = await captureAs(assistant, { sourceType: 'agent', text: 'Proud of you always.', fromName: 'Aunt Mae', occurredAt: at });
    await env.DB.prepare('UPDATE items SET dedupe_key = ?2, text_key = NULL WHERE id = ?1').bind(byName.id, await dedupeKey('agent', { sourceRef: null, text: 'Proud of you always.' })).run();
    const own = await call('/api/v1/capture', asUser(session, { method: 'POST', body: { sourceType: 'agent', text: 'Proud of you always.', fromName: 'aunt  mae', occurredAt: at } }));
    expect(((await own.json()) as CaptureResponse).status).toBe('duplicate');
    await captureAs(assistant, { sourceType: 'agent', text: 'Proud of you always.', fromName: 'Uncle Kai', occurredAt: at });
    expect(await count(session)).toBe(5);
  });

  it('merges two paths only for the same sender, or when one side does not say who', async () => {
    const { session, device } = await deviceSession();
    const phone = await createToken(session, 'device', ['capture'], 'iPhone');
    const now = Date.now();
    const words = 'So proud of you for finishing the marathon, you inspire me.';
    // A share from the phone with a sender named (a future "who said this") and the Mac's copy from someone else.
    await captureAs(phone, { sourceType: 'text', text: words, fromHandle: '+15555550180', occurredAt: now, shared: true });
    await captureAs(device, { sourceType: 'text', text: words, fromHandle: '+15555550181', sourceRef: 'guid-x', occurredAt: now, threadKind: 'direct' });
    expect(await count(session)).toBe(2);
    // The same sender by the other path is one message.
    await captureAs(device, { sourceType: 'text', text: words, fromHandle: '+1 555 555 0180', sourceRef: 'guid-y', occurredAt: now, threadKind: 'direct' });
    expect(await count(session)).toBe(2);
    // Two people known only by name are not merged either.
    const assistant = await createToken(session, 'agent', ['add']);
    const named = 'Thank you for driving me to every appointment this spring, you are a lifesaver.';
    await captureAs(assistant, { sourceType: 'agent', text: named, fromName: 'Aunt Mae', sourceRef: 'chat-1', occurredAt: now });
    await captureAs(assistant, { sourceType: 'agent', text: named, fromName: 'Uncle Kai', occurredAt: now });
    expect(await count(session)).toBe(4);
    await captureAs(assistant, { sourceType: 'agent', text: named, fromName: 'aunt mae', occurredAt: now });
    expect(await count(session)).toBe(4);
  });

  it('lets a phone share that says nobody merge with one copy of the message, never with everyone\'s same words', async () => {
    const { session, device: mac } = await deviceSession();
    const phone = await createToken(session, 'device', ['capture'], 'iPhone');
    // On the birthday, the iPhone shortcut shares Mom's words: no sender, no date, no id.
    const shared = await captureAs(phone, { sourceType: 'text', text: BIRTHDAY, sourceLabel: 'iPhone', shared: true });
    // Later the Mac, asleep until now, syncs Mom's message, then Dad's and an aunt's same words.
    const at = Date.now();
    for (const [guid, handle] of [['guid-m', '+15555550170'], ['guid-d', '+15555550171'], ['guid-a', '+15555550172']] as const) {
      await captureAs(mac, { sourceType: 'text', text: BIRTHDAY, fromHandle: handle, sourceRef: guid, occurredAt: at, threadKind: 'direct' });
    }
    // Mom's copy merged into the share, which now says it is hers; Dad's and the aunt's are their own.
    expect(await count(session)).toBe(3);
    const share = await env.DB.prepare('SELECT sender_key FROM items WHERE user_id = ?1 AND id = ?2').bind(session.userId, shared.id).first<{ sender_key: string | null }>();
    expect(share?.sender_key).toBe(await keyring().senderKeyFor(session.userId, '+15555550170'));
  });

  it('lets a phone share take in one Mac copy only: later messages with their own ids stay their own', async () => {
    const { session } = await deviceSession();
    const HOUR = 60 * 60 * 1000;
    const t0 = Date.UTC(2026, 8, 24, 18);
    // The iPhone share sheet sends Mom's words: no sender, no date, no id.
    await direct(session, { sourceType: 'text', text: BIRTHDAY, personChosen: true, neutralDuplicates: true }, t0);
    // The Mac syncs three messages from Mom with the same words, each with its own id.
    const fromMac = (guid: string, occurredAt: number) =>
      ({ sourceType: 'text', text: BIRTHDAY, fromHandle: '+15555550170', sourceRef: guid, occurredAt, threadKind: 'direct', neutralDuplicates: true }) as const;
    await direct(session, fromMac('guid-1', t0 - HOUR), t0 + HOUR);
    expect(await count(session)).toBe(1);
    await direct(session, fromMac('guid-2', t0 + 9 * HOUR), t0 + 10 * HOUR);
    await direct(session, fromMac('guid-3', t0 + 33 * HOUR), t0 + 34 * HOUR);
    // The share and its one copy are one item; the other two messages are their own.
    expect(await count(session)).toBe(3);
    // A copy the Mac sends again is still known, by its own id.
    await direct(session, fromMac('guid-1', t0 - HOUR), t0 + 40 * HOUR);
    await direct(session, fromMac('guid-2', t0 + 9 * HOUR), t0 + 40 * HOUR);
    expect(await count(session)).toBe(3);
    // And the same share again that day is still the one message.
    await direct(session, { sourceType: 'text', text: BIRTHDAY, personChosen: true, neutralDuplicates: true }, t0 + 2 * HOUR);
    expect(await count(session)).toBe(3);
  });

  it('keeps one item for a share kept again after a zone change, even once it says who said it', async () => {
    const { session } = await deviceSession();
    const HOUR = 60 * 60 * 1000;
    // 5 AM on September 24 in UTC, where a new account starts: 10 PM on September 23 in Los Angeles.
    const t0 = Date.UTC(2026, 8, 24, 5);
    const share = (text: string) => ({ sourceType: 'text', text, personChosen: true, neutralDuplicates: true }) as const;
    // A share the Mac's copy of Mom's message then says is hers.
    await direct(session, share(BIRTHDAY), t0);
    await direct(session, { sourceType: 'text', text: BIRTHDAY, fromHandle: '+15555550170', sourceRef: 'guid-m', occurredAt: t0 - HOUR, threadKind: 'direct' }, t0 + 60_000);
    // A share the person says who said it for, in the web app.
    const named = await direct(session, share('You are the best mom in the world.'), t0);
    expect((await call(`/api/v1/items/${named.id}`, asUser(session, { method: 'PATCH', body: { fromName: 'Mom' } }))).status).toBe(200);
    // A share kept before keys said who and when, that a Mac copy then says is Dad's.
    const older = await direct(session, share('Thank you for everything this year.'), t0);
    await env.DB.prepare('UPDATE items SET dedupe_key = text_key WHERE id = ?1').bind(older.id).run();
    await direct(session, { sourceType: 'text', text: 'Thank you for everything this year.', fromHandle: '+15555550171', sourceRef: 'guid-d', occurredAt: t0 - HOUR, threadKind: 'direct' }, t0 + 60_000);
    expect(await count(session)).toBe(3);

    // The person sets their time zone, and an hour later shares the same three messages again.
    expect((await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { timezone: 'America/Los_Angeles' } }))).status).toBe(200);
    await direct(session, share(BIRTHDAY), t0 + HOUR);
    await direct(session, share('You are the best mom in the world.'), t0 + HOUR);
    await direct(session, share('Thank you for everything this year.'), t0 + HOUR);
    expect(await count(session)).toBe(3);
  });

  it('keeps a phone share the person named apart from a Mac copy that has only a handle', async () => {
    const { session, device: mac } = await deviceSession();
    const phone = await createToken(session, 'device', ['capture'], 'iPhone');
    const shared = await captureAs(phone, { sourceType: 'text', text: BIRTHDAY, sourceLabel: 'iPhone', shared: true });
    // "Who said it", filled in from the web app: a name, no handle.
    expect((await call(`/api/v1/items/${shared.id}`, asUser(session, { method: 'PATCH', body: { fromName: 'Mom' } }))).status).toBe(200);
    // The Mac sends a handle and no name. That could be Mom or Dad: a name cannot be matched to a
    // handle, so the copies stay apart rather than crediting "Mom" to whoever arrived first.
    const at = Date.now();
    await captureAs(mac, { sourceType: 'text', text: BIRTHDAY, fromHandle: '+15555550171', sourceRef: 'guid-d', occurredAt: at, threadKind: 'direct' });
    expect(await count(session)).toBe(2);
    await captureAs(mac, { sourceType: 'text', text: BIRTHDAY, fromHandle: '+15555550170', sourceRef: 'guid-m', occurredAt: at, threadKind: 'direct' });
    expect(await count(session)).toBe(3);
    const listed = async (status: string) => ((await (await call(`/api/v1/items?status=${status}`, asUser(session))).json()) as { items: { id: string; fromName: string | null }[] }).items;
    const item = [...(await listed('saved')), ...(await listed('maybe'))].find((i) => i.id === shared.id);
    expect(item?.fromName).toBe('Mom');
  });

  it('keeps one item for a message kept again after the person changes time zone', async () => {
    const { session, device } = await deviceSession();
    const from = { fromName: 'Dana Reyes', fromHandle: 'dana@example.com' };
    // 9 PM on September 23 in Los Angeles: already September 24 in UTC, where a new account starts.
    const at = Date.UTC(2026, 8, 24, 4);
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at, shared: true });
    expect((await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { timezone: 'America/Los_Angeles' } }))).status).toBe(200);
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: at, shared: true });
    expect(await count(session)).toBe(1);
    // Days are counted in the zone the person has now: 1 PM on September 23 there is the same day.
    await captureAs(device, { sourceType: 'text', text: BIRTHDAY, ...from, occurredAt: Date.UTC(2026, 8, 23, 20), shared: true });
    expect(await count(session)).toBe(1);
    // An assistant's add, kept again after moving back to UTC.
    const assistant = await createToken(session, 'agent', ['add']);
    const mae = { sourceType: 'agent', text: 'Proud of you always.', fromName: 'Aunt Mae', occurredAt: Date.UTC(2026, 8, 24, 3) };
    await captureAs(assistant, mae);
    expect((await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { timezone: 'UTC' } }))).status).toBe(200);
    await captureAs(assistant, mae);
    expect(await count(session)).toBe(2);
  });
});

describe('what the person chose to keep', () => {
  const NEUTRAL = 'picking up the kids today';

  it('keeps shared neutral words in maybe, unsorted, and never delivers or saves them', async () => {
    const { session, device } = await deviceSession();
    const shared = await captureAs(device, { sourceType: 'text', text: NEUTRAL, sourceLabel: 'iPhone', shared: true });
    expect(shared).toMatchObject({ status: 'maybe', quote: NEUTRAL });
    expect(shared.category).toBeUndefined();
    // Even a model judge that calls it evidence cannot lift a rules exclusion to saved.
    const judge = { judge: async () => ({ isEvidence: true, directedAtRecipient: true, category: 'love' as const, quote: 'the kids', confidence: 1 }) };
    const judged = await capture(
      { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now(), judge },
      session.userId,
      { sourceType: 'text', text: 'grabbing milk on the way home', personChosen: true },
    );
    expect(judged.status).toBe('maybe');
    const rows = await env.DB.prepare('SELECT status, category FROM items WHERE user_id = ?1').bind(session.userId).all<{ status: string; category: string }>();
    expect(rows.results).toEqual([
      { status: 'maybe', category: '' },
      { status: 'maybe', category: '' },
    ]);
    // Maybe is never delivered: "Send one now" has nothing to send, and says nothing is kept yet.
    const sent = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await sent.json()).toEqual({ sent: false, reason: 'nothing_qualifies' });
    // A shared message the detector would save is saved.
    expect((await captureAs(device, { sourceType: 'text', text: KIND_TEXT, shared: true })).status).toBe('saved');
  });

  it('leaves the kind blank for what nothing sorted, and never calls it Other', async () => {
    const session = await signIn();
    const unsorted = await addManual(session, { quote: 'The note you left on my car this morning.' });
    const chosen = await addManual(session, { quote: 'The note you left on my desk this morning.', category: 'care' });
    const scored = await addManual(session, { quote: 'Thank you so much for everything, I could not have done it without you.' });
    const list = (await (await call('/api/v1/items?limit=10', asUser(session))).json()) as { items: { id: string; status: string; category: string; categoryLabel: string }[] };
    const byId = Object.fromEntries(list.items.map((i) => [i.id, i]));
    // Stored as not sorted; on the wire still a valid category, with the flag that says so.
    const stored = await env.DB.prepare('SELECT category FROM items WHERE id = ?1').bind(unsorted).first<{ category: string }>();
    expect(stored?.category).toBe('');
    expect(byId[unsorted]).toMatchObject({ status: 'saved', category: 'other', categoryLabel: '', categoryKnown: false });
    expect(byId[chosen]).toMatchObject({ category: 'care', categoryLabel: 'Care', categoryKnown: true });
    expect(byId[scored]).toMatchObject({ category: 'gratitude', categoryLabel: 'Gratitude', categoryKnown: true });
    // The person can still sort it later.
    const patched = await call(`/api/v1/items/${unsorted}`, asUser(session, { method: 'PATCH', body: { category: 'love' } }));
    expect(await patched.json()).toMatchObject({ category: 'love', categoryLabel: 'Love', categoryKnown: true });
  });
});

describe('text read from a screenshot on the phone', () => {
  const SCREENSHOT_TEXT = "9:41\nMaya\niMessage\nToday 7:12 PM\nI just want you to know I'm so proud of you. You've come so far this year.\nDelivered";
  const png = { base64: base64Encode(PNG_1X1), mediaType: 'image/heic' };

  it('quotes the words read from the image, keeps the image with them, and says they were read from it', async () => {
    const { session, device } = await deviceSession();
    const result = await captureAs(device, { sourceType: 'screenshot', sourceLabel: 'iPhone', shared: true, text: SCREENSHOT_TEXT, textFromImage: true, image: png });
    // Waits in maybe for the person: the phone cannot say whose bubble the words were in.
    expect(result.status).toBe('maybe');
    expect(SCREENSHOT_TEXT).toContain(result.quote!);
    expect(result.quote).toContain('so proud of you');
    const [item] = ((await (await call('/api/v1/items?status=maybe', asUser(session))).json()) as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({ kind: 'mixed', hasMedia: true, mediaType: 'image/png', sourceType: 'screenshot', sourceLabel: 'iPhone · Text read from the image' });
  });

  it('never saves or delivers words read from a screenshot before the person keeps them: they may be the person\'s own', async () => {
    const { session, device } = await deviceSession();
    // The person's own reply and the friend's answer, read as one text.
    const own = "9:41\nThank you so much, you're the best friend anyone could ask for\nnp!";
    const result = await captureAs(device, { sourceType: 'screenshot', sourceLabel: 'iPhone', shared: true, text: own, textFromImage: true, image: png });
    expect(result.status).toBe('maybe');
    const sent = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await sent.json()).toEqual({ sent: false, reason: 'nothing_qualifies' });
  });

  it('never sends words read from a screenshot to the model judge', async () => {
    const session = await signIn();
    const calls: string[] = [];
    const judge = {
      judge: async (c: { text: string }) => {
        calls.push(c.text);
        return { isEvidence: false, directedAtRecipient: false, category: 'other' as const, quote: '', confidence: 1 };
      },
    };
    const deps = { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now(), judge };
    const onScreen = '9:41\nSam\nThank you for listening last night. It meant a lot.\nRiley Park: are you still at 42 Elm St? Call 555-0142\nDelivered';
    // Typed or copied, borderline words go to the judge (when it is on).
    await capture(deps, session.userId, { sourceType: 'text', text: 'Thank you for listening last night. It meant a lot.', personChosen: true });
    expect(calls).toHaveLength(1);
    // Read off a screen, they are everything on it: other people's names and numbers too.
    const result = await capture(deps, session.userId, { sourceType: 'screenshot', text: onScreen, textFromImage: true, image: { bytes: PNG_1X1, type: 'image/png' }, personChosen: true });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe('maybe');
  });

  it('keeps the image alone when the words read from it are not evidence', async () => {
    const { session, device } = await deviceSession();
    const result = await captureAs(device, { sourceType: 'screenshot', sourceLabel: 'iPhone', shared: true, text: 'Parking\nZone B\nLevel 3', textFromImage: true, image: png });
    expect(result).toMatchObject({ status: 'maybe' });
    expect(result.quote).toBeUndefined();
    const [item] = ((await (await call('/api/v1/items?status=maybe', asUser(session))).json()) as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({ kind: 'image', quote: null, sourceLabel: 'iPhone', category: 'other', categoryKnown: false });
    // Nothing read from the image at all: the image, as before.
    expect((await captureAs(device, { sourceType: 'screenshot', sourceLabel: 'iPhone', shared: true, text: '', textFromImage: true, image: png })).status).toBe('maybe');
  });

  it('keeps the image alone when more text was read from it than Witness reads', async () => {
    const { session, device } = await deviceSession();
    const long = `I am so proud of you. ${'Page after page of a long document. '.repeat(Math.ceil(MAX_TEXT_CHARS / 30))}`;
    expect(long.length).toBeGreaterThan(MAX_TEXT_CHARS);
    const result = await captureAs(device, { sourceType: 'screenshot', sourceLabel: 'iPhone', shared: true, text: long, textFromImage: true, image: png });
    expect(result.status).toBe('maybe');
    expect(result.quote).toBeUndefined();
    const [item] = ((await (await call('/api/v1/items?status=maybe', asUser(session))).json()) as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({ kind: 'image', quote: null, hasMedia: true });
    // Without an image, over the limit is still refused.
    const res = await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { sourceType: 'text', text: long } }));
    expect(res.status).toBe(400);
  });

  it('tells two screenshots apart by the image, even when the phone read the same words in both', async () => {
    const { session, device } = await deviceSession();
    const other = { base64: base64Encode(PNG_1X1.map((b, i) => (i === PNG_1X1.length - 1 ? b ^ 1 : b))), mediaType: 'image/png' };
    for (const image of [png, other, png]) {
      await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { sourceType: 'screenshot', shared: true, text: '9:41\nWi-Fi', textFromImage: true, image } }));
    }
    // The same screenshot twice is one; a different one with the same read-out words is its own.
    const rows = await env.DB.prepare('SELECT text_key FROM items WHERE user_id = ?1').bind(session.userId).all<{ text_key: string | null }>();
    expect(rows.results).toHaveLength(2);
    // And the words read from an image never merge with the same words sent as text.
    expect(rows.results.every((r) => r.text_key === null)).toBe(true);
  });

  it('needs the image the text was read from', async () => {
    const { device } = await deviceSession();
    const res = await call('/api/v1/capture', withBearer(device, { method: 'POST', body: { sourceType: 'screenshot', text: SCREENSHOT_TEXT, textFromImage: true } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('textFromImage needs the image the text was read from.');
  });
});

describe('capture API errors in plain words', () => {
  it.each([
    [{}, 'sourceType is required: one of text, email, photo, screenshot, import.'],
    [{ sourceType: 'sms', text: 'hi' }, 'sourceType must be one of text, email, photo, screenshot, import.'],
    [{ sourceType: 'text', text: 5 }, 'text must be text.'],
    [{ sourceType: 'text', text: 'hi', occurredAt: '2026-09-24' }, 'occurredAt must be a number.'],
    [{ sourceType: 'text', text: 'hi', occurredAt: 1.5 }, 'occurredAt must be a whole number.'],
    [{ sourceType: 'text', text: 'hi', shared: 'true' }, 'shared must be true or false.'],
    [{ sourceType: 'text', text: 'hi', threadKind: 'dm' }, 'threadKind must be one of direct, group.'],
    [{ sourceType: 'text', text: 'hi', fromName: 'x'.repeat(201) }, 'fromName can be up to 200 characters.'],
    [{ sourceType: 'photo', image: {} }, 'image.base64 is required.'],
    [{ sourceType: 'photo', image: { base64: 'AAAA', mediaType: 'image/bmp' } }, 'image.mediaType must be one of image/jpeg, image/png, image/webp, image/heic, image/gif.'],
    [[], 'Send a JSON object, for example {"sourceType": "text", "text": "…"}.'],
  ])('%j', async (body, message) => {
    const { device } = await deviceSession();
    const res = await call('/api/v1/capture', withBearer(device, { method: 'POST', body }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({ code: 'invalid_request', message });
  });
});

describe('API errors on every route', () => {
  const messageOf = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;

  it('names a field a route does not take, and never points at the capture API', async () => {
    const session = await signIn();
    const typo = await call('/api/v1/me', asUser(session, { method: 'PATCH', body: { displayname: 'x' } }));
    expect(typo.status).toBe(400);
    expect(await messageOf(typo)).toBe('"displayname" is not a field Witness takes here. Check its spelling, or leave it out.');
    const id = await addManual(session, { quote: 'The note you left on my car this morning.' });
    const two = await call(`/api/v1/items/${id}`, asUser(session, { method: 'PATCH', body: { note: 'x', tag: 'y' } }));
    expect(await messageOf(two)).toBe('"note", "tag" are not fields Witness takes here. Check their spelling, or leave them out.');
    const list = await call('/api/v1/me', asUser(session, { method: 'PATCH', body: [] }));
    expect(await messageOf(list)).toBe('Send a JSON object.');
    const address = await call('/api/v1/addresses/not-an-address', asUser(session, { method: 'DELETE' }));
    expect(await messageOf(address)).toBe('address is not a valid email.');
  });
});

describe('items API', () => {
  it('searches only what a card shows: never the kind or the note', async () => {
    const session = await signIn();
    const id = await addManual(session, { quote: 'Thank you for the ride home.', context: 'Congrats on the launch' });
    expect((await call(`/api/v1/items/${id}`, asUser(session, { method: 'PATCH', body: { category: 'gratitude' } }))).status).toBe(200);
    const find = async (q: string) =>
      ((await (await call(`/api/v1/items?q=${q}`, asUser(session))).json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(await find('ride')).toEqual([id]);
    // Filed under Gratitude, with "launch" in its note: neither word is on the card.
    expect(await find('gratitude')).toEqual([]);
    expect(await find('launch')).toEqual([]);
  });

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

  it('puts an item back to unsorted, and search never finds an item by its kind', async () => {
    const session = await signIn();
    const filed = await addManual(session, { quote: 'Thank you for the soup when I was sick.', category: 'love' });
    // Cards do not show the kind, so search does not match it.
    const found = (await (await call('/api/v1/items?q=love', asUser(session))).json()) as { items: { id: string }[] };
    expect(found.items).toHaveLength(0);

    const unsorted = await call(`/api/v1/items/${filed}`, asUser(session, { method: 'PATCH', body: { category: null } }));
    expect(unsorted.status).toBe(200);
    expect(await unsorted.json()).toMatchObject({ categoryKnown: false, categoryLabel: '' });
    expect(((await (await call('/api/v1/items?q=love', asUser(session))).json()) as { items: unknown[] }).items).toHaveLength(0);
    const sorted = await call(`/api/v1/items/${filed}`, asUser(session, { method: 'PATCH', body: { category: 'care' } }));
    expect(await sorted.json()).toMatchObject({ category: 'care', categoryKnown: true });
  });

  it('promises no next email when nothing saved can go by email', async () => {
    const session = await signIn();
    await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, timezone: 'Pacific/Honolulu' } }));
    // An image-only HEIC photo: most mail apps cannot show it, so no email would carry it.
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1heic')]);
    await addManual(session, { image: { base64: base64Encode(heic), mediaType: 'image/heic' } });
    const photoOnly = (await (await call('/api/v1/status', asUser(session))).json()) as { saved: number; deliverable: number; rhythm: { enabled: boolean; nextAt: number | null } };
    expect(photoOnly).toMatchObject({ saved: 1, deliverable: 0, rhythm: { enabled: true, nextAt: null } });
    // Words that can go: now the next email is real.
    await addManual(session, { quote: 'You made my whole week, thank you.' });
    const withWords = (await (await call('/api/v1/status', asUser(session))).json()) as { deliverable: number; rhythm: { nextAt: number | null } };
    expect(withWords.deliverable).toBe(1);
    expect(withWords.rhythm.nextAt).toEqual(expect.any(Number));
  });

  it('promises the first run that will send, never one that finds everything sent in the last 30 days', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const session = await signIn();
    await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, localTime: '08:30', timezone: 'Pacific/Honolulu' } }));
    await addManual(session, { quote: 'You made my whole week, thank you.' });
    const status = async () => (await (await call('/api/v1/status', asUser(session))).json()) as { deliverable: number; rhythm: { nextAt: number | null } };
    const deliveries = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE user_id = ?1 AND status = ?2').bind(session.userId, 'sent').first<{ n: number }>())!.n;
    const tomorrow = (await status()).rhythm.nextAt!;

    expect(await (await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }))).json()).toEqual({ sent: true });
    expect(await (await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }))).json()).toEqual({ sent: false, reason: 'all_recent' });
    const sentAt = (await env.DB.prepare('SELECT last_delivered_at AS at FROM items WHERE user_id = ?1').bind(session.userId).first<{ at: number }>())!.at;

    // The one thing kept went out just now, so tomorrow's run would send nothing. The promise is
    // the first run after the 30 days Witness waits before sending something again.
    const promised = await status();
    expect(promised.deliverable).toBe(1);
    expect(promised.rhythm.nextAt).toBeGreaterThan(tomorrow);
    expect(promised.rhythm.nextAt).toBeGreaterThanOrEqual(sentAt + 30 * DAY);
    expect(promised.rhythm.nextAt).toBeLessThanOrEqual(sentAt + 31 * DAY);

    // The runs in between send nothing; the promised one sends.
    const runAt = async (at: number) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: at, cron: '*/15 * * * *' }), testEnv, ctx);
      await waitOnExecutionContext(ctx);
    };
    await runAt(tomorrow + 1000);
    expect(await deliveries()).toBe(1);
    expect((await status()).rhythm.nextAt).toBe(promised.rhythm.nextAt);
    await runAt(promised.rhythm.nextAt! + 1000);
    expect(await deliveries()).toBe(2);
  });

  it('promises the run as the quarter-hour cron tick that delivers it will pick, for a time between ticks', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const QUARTER = 15 * 60 * 1000;
    const session = await signIn();
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, localTime: '08:10', days, timezone: 'Pacific/Honolulu' } }));
    await addManual(session, { quote: 'You made my whole week, thank you.' });
    const status = async () => (await (await call('/api/v1/status', asUser(session))).json()) as { rhythm: { nextAt: number | null } };
    const deliveries = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE user_id = ?1 AND status = ?2').bind(session.userId, 'sent').first<{ n: number }>())!.n;
    // The cron runs every quarter hour, at its scheduled time: an 08:10 slot goes out at 08:15.
    const tick = (slot: number) => Math.ceil(slot / QUARTER) * QUARTER;
    const runAt = async (at: number) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: at, cron: '*/15 * * * *' }), testEnv, ctx);
      await waitOnExecutionContext(ctx);
    };

    const first = (await status()).rhythm.nextAt!;
    await runAt(tick(first));
    expect(await deliveries()).toBe(1);

    // Thirty days on, the 08:15 tick is exactly 30 days after the first email: that run sends,
    // and it is the one promised (Honolulu keeps no daylight time, so a day is 24 hours).
    const promised = (await status()).rhythm.nextAt!;
    expect(promised).toBe(first + 30 * DAY);
    await runAt(tick(promised - DAY));
    expect(await deliveries()).toBe(1);
    await runAt(tick(promised));
    expect(await deliveries()).toBe(2);
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
