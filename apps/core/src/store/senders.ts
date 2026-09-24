/** "Never save from this sender": keyed by an HMAC of the handle, never the handle itself. */
import { all, first, run } from './db.js';

export interface BlockedSenderRow {
  user_id: string;
  sender_key: string;
  created_at: number;
  /** Encrypted display name from the item that was blocked (may be null). */
  label_ct: string | null;
}

export async function isBlocked(db: D1Database, userId: string, senderKey: string): Promise<boolean> {
  const row = await first<{ n: number }>(
    db.prepare('SELECT 1 AS n FROM blocked_senders WHERE user_id = ?1 AND sender_key = ?2').bind(userId, senderKey),
  );
  return row !== null;
}

export async function blockSender(db: D1Database, userId: string, senderKey: string, now: number, labelCt: string | null = null): Promise<void> {
  await run(
    db
      .prepare(
        `INSERT INTO blocked_senders (user_id, sender_key, created_at, label_ct) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (user_id, sender_key) DO UPDATE SET label_ct = COALESCE(blocked_senders.label_ct, excluded.label_ct)`,
      )
      .bind(userId, senderKey, now, labelCt),
  );
}

export function listBlockedSenders(db: D1Database, userId: string): Promise<BlockedSenderRow[]> {
  return all<BlockedSenderRow>(
    db.prepare('SELECT * FROM blocked_senders WHERE user_id = ?1 ORDER BY created_at DESC, sender_key').bind(userId),
  );
}

/** "Allow again". False when that sender was not blocked. */
export async function unblockSender(db: D1Database, userId: string, senderKey: string): Promise<boolean> {
  const changed = await run(db.prepare('DELETE FROM blocked_senders WHERE user_id = ?1 AND sender_key = ?2').bind(userId, senderKey));
  return changed > 0;
}
