/**
 * Export everything (decrypted, media as base64) and delete everything
 * (D1 rows and R2 objects). Both always work (SPEC §2).
 */
import { base64Encode, type Keyring } from './crypto.js';
import { inboundAddressFor, type AppEnv, type Config } from './env.js';
import { toApiItem } from './items.js';
import { deleteAllMedia, getMedia, mediaCleanupRecord } from './media.js';
import { listAddresses } from './store/addresses.js';
import { all } from './store/db.js';
import { exportPage } from './store/items.js';
import { getRhythm } from './store/rhythm.js';
import { listBlockedSenders } from './store/senders.js';
import { listTokens, tokenInfo } from './store/tokens.js';
import type { UserRow } from './store/users.js';

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
