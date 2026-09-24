/** Image validation and encrypted storage in R2 (key `u/<user_id>/<item_id>`). */
import type { Keyring } from './crypto.js';
import type { AppEnv } from './env.js';
import { all, run } from './store/db.js';
import { deleteItems, type ItemRow } from './store/items.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export function mediaKey(userId: string, itemId: string): string {
  return `u/${userId}/${itemId}`;
}

export function userMediaPrefix(userId: string): string {
  return `u/${userId}/`;
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** The image type from the file's first bytes, or null when it is not one we accept. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(ascii(bytes, 8, 12))) {
    return 'image/heic';
  }
  return null;
}

export async function putMedia(bucket: R2Bucket, keyring: Keyring, userId: string, itemId: string, bytes: Uint8Array, type: ImageType): Promise<string> {
  const key = mediaKey(userId, itemId);
  // The stored content type is deliberately opaque: the object is ciphertext.
  await bucket.put(key, await keyring.sealMedia(userId, bytes), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { enc: 'v1', type },
  });
  return key;
}

export async function getMedia(bucket: R2Bucket, keyring: Keyring, userId: string, key: string): Promise<Uint8Array | null> {
  // Keys are always derived from the owner's id; refuse anything else.
  if (!key.startsWith(userMediaPrefix(userId))) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  return keyring.openMedia(userId, new Uint8Array(await object.arrayBuffer()));
}

export async function deleteMedia(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length > 0) await bucket.delete(batch);
  }
}

const ITEM_KEY = /^u\/[^/]+\/[^/]+$/;

/** Records an image key for deletion. */
function mediaKeyRecord(db: D1Database, key: string, now: number): D1PreparedStatement {
  return db.prepare('INSERT INTO media_cleanup_keys (key, created_at) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING').bind(key, now);
}

/** Deletes recorded images from R2, then their records. False when R2 failed: the cron tries again. */
async function deleteRecordedMedia(env: Pick<AppEnv, 'DB' | 'MEDIA'>, keys: readonly string[]): Promise<boolean> {
  if (keys.length === 0) return true;
  try {
    await deleteMedia(env.MEDIA, keys);
    await env.DB.batch(keys.map((key) => env.DB.prepare('DELETE FROM media_cleanup_keys WHERE key = ?1').bind(key)));
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'media.delete_deferred', error: error instanceof Error ? error.name : 'unknown' }));
    return false;
  }
}

/**
 * Deletes items and their images. The rows go first, in one batch that also records every
 * image key they pointed at, so a row never points at a missing image: a delivery could
 * otherwise go out with nothing in it. Then the images and their records. If D1 fails,
 * nothing changed and the removal can be tried again. If R2 fails, the items are already
 * gone from Witness (the answer is still "removed"), and the cron deletes the images from
 * the records.
 */
export async function removeItems(
  env: Pick<AppEnv, 'DB' | 'MEDIA'>,
  userId: string,
  rows: readonly Pick<ItemRow, 'id' | 'media_key'>[],
  now = Date.now(),
): Promise<void> {
  if (rows.length === 0) return;
  const prefix = userMediaPrefix(userId);
  const keys = [...new Set(rows.flatMap((r) => (r.media_key?.startsWith(prefix) ? [r.media_key] : [])))];
  await deleteItems(
    env.DB,
    userId,
    rows.map((r) => r.id),
    keys.map((key) => mediaKeyRecord(env.DB, key, now)),
  );
  await deleteRecordedMedia(env, keys);
}

/**
 * Deletes an image that no row points at (a capture whose row could not be written). If R2
 * fails, the key is recorded and the cron deletes it.
 */
export async function discardMedia(env: Pick<AppEnv, 'DB' | 'MEDIA'>, key: string, now: number): Promise<void> {
  try {
    await env.MEDIA.delete(key);
  } catch {
    await run(mediaKeyRecord(env.DB, key, now));
  }
}

/** Cron: deletes the images that removing items could not (R2 failed at the time). */
export async function sweepMediaKeys(env: Pick<AppEnv, 'DB' | 'MEDIA'>, limit = 500): Promise<{ deleted: number; failed: number }> {
  const rows = await all<{ key: string }>(env.DB.prepare('SELECT key FROM media_cleanup_keys ORDER BY created_at LIMIT ?1').bind(limit));
  // Only item keys are ever recorded; anything else is dropped, never passed to R2.
  const strays = rows.filter((r) => !ITEM_KEY.test(r.key)).map((r) => r.key);
  if (strays.length > 0) await env.DB.batch(strays.map((key) => env.DB.prepare('DELETE FROM media_cleanup_keys WHERE key = ?1').bind(key)));
  const keys = rows.map((r) => r.key).filter((key) => ITEM_KEY.test(key));
  const done = await deleteRecordedMedia(env, keys);
  return done ? { deleted: keys.length, failed: 0 } : { deleted: 0, failed: keys.length };
}

const USER_PREFIX = /^u\/[^/]+\/$/;

/** Deletes every object under one user's prefix. Refuses anything but `u/<user_id>/`. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  if (!USER_PREFIX.test(prefix)) throw new Error('refusing to delete outside one user prefix');
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = listing.objects.map((o) => o.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** Deletes every object under the user's prefix. */
export function deleteAllMedia(bucket: R2Bucket, userId: string): Promise<number> {
  return deletePrefix(bucket, userMediaPrefix(userId));
}

/** How long the cron keeps sweeping a deleted account's prefix, for writes that were already under way. */
export const MEDIA_CLEANUP_SWEEP_MS = 60 * 60 * 1000;

/** The statement that records a prefix to sweep; run it in the same batch as the row deletes. */
export function mediaCleanupRecord(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO media_cleanup (prefix, created_at) VALUES (?1, ?2) ON CONFLICT (prefix) DO UPDATE SET created_at = excluded.created_at')
    .bind(userMediaPrefix(userId), now);
}

/**
 * Cron: finishes deleting the images of deleted accounts. A record goes once a sweep
 * succeeds an hour or more after the account was deleted; a failed sweep is tried again on
 * the next tick.
 */
export async function sweepMediaCleanup(env: Pick<AppEnv, 'DB' | 'MEDIA'>, now: number, limit = 50): Promise<{ swept: number; failed: number }> {
  const rows = await all<{ prefix: string; created_at: number }>(
    env.DB.prepare('SELECT prefix, created_at FROM media_cleanup ORDER BY created_at LIMIT ?1').bind(limit),
  );
  let swept = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deletePrefix(env.MEDIA, row.prefix);
      swept += 1;
      if (row.created_at <= now - MEDIA_CLEANUP_SWEEP_MS) {
        await run(env.DB.prepare('DELETE FROM media_cleanup WHERE prefix = ?1 AND created_at = ?2').bind(row.prefix, row.created_at));
      }
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ event: 'media_cleanup.failed', error: error instanceof Error ? error.name : 'unknown' }));
    }
  }
  return { swept, failed };
}
