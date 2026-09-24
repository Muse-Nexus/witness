/**
 * Export everything (decrypted, media as base64) and delete everything
 * (D1 rows and R2 objects). Both always work (SPEC §2).
 */
import { base64Encode, type Keyring } from './crypto.js';
import { inboundAddressFor, type AppEnv, type Config } from './env.js';
import { toApiItem } from './items.js';
import { MEDIA_CLEANUP_SWEEP_MS, deleteAllMedia, deletePrefix, getMedia, mediaCleanupRecord } from './media.js';
import { listAddresses } from './store/addresses.js';
import { all, run } from './store/db.js';
import { exportPage } from './store/items.js';
import { getRhythm } from './store/rhythm.js';
import { listBlockedSenders } from './store/senders.js';
import { listTokens, tokenInfo } from './store/tokens.js';
import { getUserById, type UserRow } from './store/users.js';

export const EXPORT_FORMAT = 'muse-nexus-witness-export';

function streamOf(chunks: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}

/**
 * A streamed JSON document, one item at a time, so a large archive with many
 * images never has to fit in memory at once.
 */
export function exportStream(env: AppEnv, cfg: Config, keyring: Keyring, user: UserRow, now: number): ReadableStream<Uint8Array> {
  async function* chunks(): AsyncGenerator<string> {
    const db = env.DB;
    const [rhythm, addresses, tokens, blocked, deliveries] = await Promise.all([
      getRhythm(db, user.id, user.timezone, now),
      listAddresses(db, user.id),
      listTokens(db, user.id),
      listBlockedSenders(db, user.id),
      all<{ id: string; item_id: string | null; channel: string; sent_at: number; status: string; feedback: string | null }>(
        db.prepare('SELECT id, item_id, channel, sent_at, status, feedback FROM deliveries WHERE user_id = ?1 ORDER BY sent_at').bind(user.id),
      ),
    ]);
    const header = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: now,
      account: {
        email: user.email,
        displayName: user.display_name,
        timezone: user.timezone,
        inboundAddress: inboundAddressFor(cfg, user.inbound_slug),
        createdAt: user.created_at,
      },
      rhythm: {
        enabled: rhythm.enabled === 1,
        localTime: rhythm.local_time,
        days: rhythm.days.split(','),
        timezone: rhythm.timezone,
        pausedUntil: rhythm.paused_until,
        consentedAt: rhythm.consented_at,
      },
      addresses: addresses.map((a) => ({ address: a.address, verifiedAt: a.verified_at })),
      assistantsAndDevices: tokens.map(tokenInfo),
      // Keyed hashes plus the display name the person saw when they blocked them.
      blockedSenders: await Promise.all(
        blocked.map(async (b) => ({ senderKey: b.sender_key, label: await keyring.decryptOptional(user.id, b.label_ct), createdAt: b.created_at })),
      ),
      deliveries: deliveries.map((d) => ({ id: d.id, itemId: d.item_id, channel: d.channel, sentAt: d.sent_at, status: d.status, feedback: d.feedback })),
    };
    const head = JSON.stringify(header, null, 2);
    yield `${head.slice(0, -2)},\n  "items": [`;

    let after = '';
    let firstItem = true;
    for (;;) {
      const rows = await exportPage(db, user.id, after, 50);
      for (const row of rows) {
        const { mediaUrl: _omit, ...item } = await toApiItem(row, keyring);
        let media: { type: string; base64: string } | null = null;
        if (row.media_key && row.media_type) {
          const bytes = await getMedia(env.MEDIA, keyring, user.id, row.media_key);
          if (bytes) media = { type: row.media_type, base64: base64Encode(bytes) };
        }
        yield `${firstItem ? '\n' : ',\n'}    ${JSON.stringify({ ...item, media })}`;
        firstItem = false;
      }
      if (rows.length < 50) break;
      after = rows[rows.length - 1]!.id;
    }
    yield `${firstItem ? '' : '\n  '}]\n}\n`;
  }
  return streamOf(chunks());
}

/** Every table with a user_id column. */
const USER_TABLES = [
  'items',
  'blocked_senders',
  'rhythms',
  'deliveries',
  'offers',
  'inbound_events',
  'pending_confirmations',
  'tokens',
  'sessions',
  'user_addresses',
] as const;

/**
 * Deletes every row and object that belongs to the user.
 *
 * Images go first: if R2 fails there, nothing is deleted yet and the person can try again.
 * Then the rows, in one batch that also records the user's image prefix in media_cleanup.
 * Then one more sweep for anything a capture already under way wrote in between. If that
 * sweep fails, the account is still deleted (its rows are gone, so a retry could not even
 * sign in): the cron finishes the sweep from the record.
 *
 * A request that authenticated before the deletion can still write afterwards. Items and
 * inbound events are only inserted while the account exists (a late capture keeps nothing,
 * and deletes its image); for anything else, the cron removes the account's rows along with
 * its images for an hour (sweepDeletedAccounts).
 */
export async function deleteAccount(env: AppEnv, user: UserRow, now: number): Promise<{ mediaDeleted: number }> {
  let mediaDeleted = await deleteAllMedia(env.MEDIA, user.id);
  const db = env.DB;
  await db.batch([
    mediaCleanupRecord(db, user.id, now),
    ...USER_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?1`).bind(user.id)),
    db.prepare('DELETE FROM magic_links WHERE email = ?1').bind(user.email),
    db.prepare('DELETE FROM users WHERE id = ?1').bind(user.id),
  ]);
  try {
    mediaDeleted += await deleteAllMedia(env.MEDIA, user.id);
  } catch (error) {
    console.error(JSON.stringify({ event: 'account.media_sweep_deferred', error: error instanceof Error ? error.name : 'unknown' }));
  }
  return { mediaDeleted };
}

const DELETED_PREFIX = /^u\/([^/]+)\/$/;

/**
 * Cron: finishes deleting accounts. For an hour after a deletion, every tick removes any row a
 * request already under way wrote for the account after its rows were deleted (a rhythm row,
 * a delivery, a token), then sweeps its images; a failure is tried again on the next tick.
 * The record goes once a sweep succeeds an hour or more after the deletion. A record never
 * touches an account that exists (only a deletion writes one; any other is dropped as is).
 */
export async function sweepDeletedAccounts(env: Pick<AppEnv, 'DB' | 'MEDIA'>, now: number, limit = 50): Promise<{ swept: number; failed: number }> {
  const db = env.DB;
  const rows = await all<{ prefix: string; created_at: number }>(
    db.prepare('SELECT prefix, created_at FROM media_cleanup ORDER BY created_at LIMIT ?1').bind(limit),
  );
  const drop = (row: { prefix: string; created_at: number }) =>
    run(db.prepare('DELETE FROM media_cleanup WHERE prefix = ?1 AND created_at = ?2').bind(row.prefix, row.created_at));
  let swept = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const userId = DELETED_PREFIX.exec(row.prefix)?.[1];
      if (!userId || (await getUserById(db, userId))) {
        await drop(row);
        continue;
      }
      await db.batch(USER_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?1`).bind(userId)));
      await deletePrefix(env.MEDIA, row.prefix);
      swept += 1;
      if (row.created_at <= now - MEDIA_CLEANUP_SWEEP_MS) await drop(row);
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ event: 'account_cleanup.failed', error: error instanceof Error ? error.name : 'unknown' }));
    }
  }
  return { swept, failed };
}
