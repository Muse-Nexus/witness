/** Detected mail-forwarding confirmations (Gmail and others). URL and code are encrypted. */
import { first, run } from './db.js';

export interface ConfirmationRow {
  user_id: string;
  provider: string;
  url_ct: string | null;
  code_ct: string | null;
  received_at: number;
}

export async function upsertConfirmation(db: D1Database, row: ConfirmationRow): Promise<void> {
  await run(
    db
      .prepare(
        `INSERT INTO pending_confirmations (user_id, provider, url_ct, code_ct, received_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id, provider) DO UPDATE SET url_ct = excluded.url_ct, code_ct = excluded.code_ct, received_at = excluded.received_at`,
      )
      .bind(row.user_id, row.provider, row.url_ct, row.code_ct, row.received_at),
  );
}

/** Confirmation links are for setting forwarding up now; after a day they are stale (and Gmail's expire). */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

/** The newest confirmation from the last day, for one provider or any. */
export function latestConfirmation(db: D1Database, userId: string, now: number, provider?: string): Promise<ConfirmationRow | null> {
  const since = now - CONFIRMATION_TTL_MS;
  return provider
    ? first<ConfirmationRow>(
        db
          .prepare('SELECT * FROM pending_confirmations WHERE user_id = ?1 AND provider = ?2 AND received_at > ?3 ORDER BY received_at DESC LIMIT 1')
          .bind(userId, provider, since),
      )
    : first<ConfirmationRow>(
        db.prepare('SELECT * FROM pending_confirmations WHERE user_id = ?1 AND received_at > ?2 ORDER BY received_at DESC LIMIT 1').bind(userId, since),
      );
}

export async function pruneConfirmations(db: D1Database, now: number): Promise<void> {
  await run(db.prepare('DELETE FROM pending_confirmations WHERE received_at < ?1').bind(now - CONFIRMATION_TTL_MS));
}
