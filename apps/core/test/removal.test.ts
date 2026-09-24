/**
 * Removing is safe to try again. An image lives in R2 and its row in D1; the two cannot
 * be deleted in one transaction, so a failure in between must never leave an encrypted
 * image behind that nothing points at (and that a retry could no longer find).
 */
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteAccount } from '../src/account.js';
import { base64Encode } from '../src/crypto.js';
import { runScheduled } from '../src/cron.js';
import { getUserById } from '../src/store/users.js';
import { PNG_1X1, addManual, asUser, call, createToken, outbox, signIn, testEnv, type Session } from './helpers.js';

const HOUR = 60 * 60 * 1000;

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** R2 deletes fail (an outage) until the test ends or `restore` runs. */
function failImageDeletes(): void {
  const bucket = env.MEDIA as unknown as { delete: R2Bucket['delete'] };
  const original = bucket.delete;
  bucket.delete = async () => {
    throw new Error('R2 is unavailable (test)');
  };
  restore = () => {
    bucket.delete = original;
  };
}

function healImageDeletes(): void {
  restore?.();
  restore = null;
}

async function imagesOf(session: Session): Promise<number> {
  return (await env.MEDIA.list({ prefix: `u/${session.userId}/` })).objects.length;
}

async function rowCount(session: Session): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
  return row?.n ?? 0;
}

const photo = { image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' } };

describe('removing is safe to try again', () => {
  it('DELETE /items/:id keeps the item when its image cannot be deleted, and a retry removes both', async () => {
    const session = await signIn();
    const id = await addManual(session, { ...photo, quote: 'Thank you for the photo from the reunion.' });
    expect(await imagesOf(session)).toBe(1);

    failImageDeletes();
    const failed = await call(`/api/v1/items/${id}`, asUser(session, { method: 'DELETE' }));
    expect(failed.status).toBe(500);
    // Still there, so the person (or the app) can simply try again.
    expect(await rowCount(session)).toBe(1);

    healImageDeletes();
    const retried = await call(`/api/v1/items/${id}`, asUser(session, { method: 'DELETE' }));
    expect(retried.status).toBe(200);
    expect(await rowCount(session)).toBe(0);
    expect(await imagesOf(session)).toBe(0);
  });

  it('blocking a sender can be tried again when images cannot be deleted', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    const capture = (text: string) =>
      call('/api/v1/capture', {
        method: 'POST',
        headers: { Authorization: `Bearer ${device}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'photo', text, fromName: 'Kai', fromHandle: '+15555550142', favorite: true, ...photo }),
      });
    const first = (await (await capture('I am so proud of you, thank you for everything.')).json()) as { id: string };
    await capture('You mean the world to me, thank you for being there.');
    expect(await imagesOf(session)).toBe(2);

    failImageDeletes();
    expect((await call(`/api/v1/items/${first.id}/block-sender`, asUser(session, { method: 'POST' }))).status).toBe(500);
    expect(await rowCount(session)).toBe(2);

    healImageDeletes();
    const retried = await call(`/api/v1/items/${first.id}/block-sender`, asUser(session, { method: 'POST' }));
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ ok: true, removed: 2 });
    expect(await rowCount(session)).toBe(0);
    expect(await imagesOf(session)).toBe(0);
  });

  it('"Remove this one" in a delivery can be pressed again after a failure', async () => {
    const session = await signIn();
    await addManual(session, photo);
    const rhythm = (await (await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, timezone: 'Pacific/Honolulu' } }))).json()) as {
      nextAt: number;
    };
    await runScheduled(testEnv, rhythm.nextAt + 1000);
    const [email] = (await outbox()).filter((m) => m.to === session.email && m.kind === 'delivery');
    const link = /Remove this one: (\S+)/.exec(email!.text)![1]!;
    const post = () =>
      call('/d', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ t: new URL(link).searchParams.get('t')! }).toString(),
      });

    failImageDeletes();
    expect((await post()).status).toBe(500);
    expect(await rowCount(session)).toBe(1);

    healImageDeletes();
    const retried = await post();
    expect(retried.status).toBe(200);
    expect(await retried.text()).toContain('It is deleted from Witness');
    expect(await rowCount(session)).toBe(0);
    expect(await imagesOf(session)).toBe(0);
  });

  it('deleting an account leaves no image behind, even when R2 fails after the rows are gone', async () => {
    const session = await signIn();
    await addManual(session, photo);
    const user = (await getUserById(env.DB, session.userId))!;

    // R2 fails before anything is deleted: nothing is, and the person can try again.
    failImageDeletes();
    await expect(deleteAccount(testEnv, user, Date.now())).rejects.toThrow();
    expect(await getUserById(env.DB, session.userId)).not.toBeNull();
    expect(await imagesOf(session)).toBe(1);
    healImageDeletes();

    // An image written while the account is being deleted (a capture already under way),
    // and R2 failing on the final sweep: the rows are gone and the answer is still "deleted",
    // because a durable cleanup record is left for the cron to finish.
    const bucket = env.MEDIA as unknown as { list: R2Bucket['list'] };
    const originalList = bucket.list;
    let lists = 0;
    bucket.list = async (options?: R2ListOptions) => {
      lists += 1;
      if (lists === 2) {
        await env.MEDIA.put(`u/${session.userId}/late-capture`, new Uint8Array([1, 2, 3]));
        failImageDeletes();
      }
      return originalList.call(env.MEDIA, options);
    };
    const now = Date.now();
    try {
      await deleteAccount(testEnv, user, now);
    } finally {
      bucket.list = originalList;
      healImageDeletes();
    }
    expect(await getUserById(env.DB, session.userId)).toBeNull();
    expect(await imagesOf(session)).toBe(1);
    const pending = await env.DB.prepare('SELECT prefix FROM media_cleanup WHERE prefix = ?1').bind(`u/${session.userId}/`).first();
    expect(pending).toEqual({ prefix: `u/${session.userId}/` });

    // The next cron tick finishes the job, and keeps sweeping for an hour in case another
    // late write lands.
    await runScheduled(testEnv, now + 15 * 60 * 1000);
    expect(await imagesOf(session)).toBe(0);
    expect(await env.DB.prepare('SELECT prefix FROM media_cleanup WHERE prefix = ?1').bind(`u/${session.userId}/`).first()).not.toBeNull();
    await runScheduled(testEnv, now + 2 * HOUR);
    expect(await env.DB.prepare('SELECT prefix FROM media_cleanup WHERE prefix = ?1').bind(`u/${session.userId}/`).first()).toBeNull();
  });

  it('DELETE /account answers "deleted" once the rows are gone, whatever R2 does next', async () => {
    const session = await signIn();
    await addManual(session, photo);
    const bucket = env.MEDIA as unknown as { list: R2Bucket['list'] };
    const originalList = bucket.list;
    let lists = 0;
    bucket.list = async (options?: R2ListOptions) => {
      lists += 1;
      if (lists === 2) {
        await env.MEDIA.put(`u/${session.userId}/late-capture`, new Uint8Array([1, 2, 3]));
        failImageDeletes();
      }
      return originalList.call(env.MEDIA, options);
    };
    try {
      const res = await call('/api/v1/account', asUser(session, { method: 'DELETE' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
    } finally {
      bucket.list = originalList;
      healImageDeletes();
    }
    expect(await getUserById(env.DB, session.userId)).toBeNull();
    expect(await imagesOf(session)).toBe(1);
    await runScheduled(testEnv, Date.now());
    expect(await imagesOf(session)).toBe(0);
  });
});
