/** Image validation and encrypted storage in R2 (key `u/<user_id>/<item_id>`). */
import type { Keyring } from './crypto.js';

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

/** Deletes every object under the user's prefix. */
export async function deleteAllMedia(bucket: R2Bucket, userId: string): Promise<number> {
  const prefix = userMediaPrefix(userId);
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
