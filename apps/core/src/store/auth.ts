/** Magic links and sessions. Only SHA-256 hashes of tokens are stored. */
import { first, run } from './db.js';

export async function createMagicLink(
  db: D1Database,
  input: { tokenHash: string; email: string; expiresAt: number; nonceHash?: string | null },
): Promise<void> {
  await run(
    db
      .prepare('INSERT INTO magic_links (token_hash, email, expires_at, used_at, nonce_hash) VALUES (?1, ?2, ?3, NULL, ?4)')
      .bind(input.tokenHash, input.email.toLowerCase(), input.expiresAt, input.nonceHash ?? null),
  );
}

/** A usable (unused, unexpired) link, without using it: who it signs in, and the browser it belongs to. */
export function peekMagicLink(db: D1Database, tokenHash: string, now: number): Promise<{ email: string; nonce_hash: string | null } | null> {
  return first(
    db.prepare('SELECT email, nonce_hash FROM magic_links WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2').bind(tokenHash, now),
  );
}

/** Marks the link used and returns its email, atomically. Null when unknown, used or expired. */
export async function consumeMagicLink(db: D1Database, tokenHash: string, now: number): Promise<string | null> {
  const row = await first<{ email: string }>(
    db
      .prepare('UPDATE magic_links SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING email')
      .bind(tokenHash, now),
  );
  return row?.email ?? null;
}

export async function createSession(
  db: D1Database,
  input: { idHash: string; userId: string; now: number; expiresAt: number },
): Promise<void> {
  await run(
    db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(input.idHash, input.userId, input.now, input.expiresAt),
  );
}

export async function findSessionUser(db: D1Database, idHash: string, now: number): Promise<string | null> {
  return (await findSession(db, idHash, now))?.user_id ?? null;
}

/** A live session: who it is, and when it runs out. */
export function findSession(db: D1Database, idHash: string, now: number): Promise<{ user_id: string; expires_at: number } | null> {
  return first<{ user_id: string; expires_at: number }>(
    db.prepare('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?1 AND expires_at > ?2').bind(idHash, now),
  );
}

/** Moves a live session's end later. Never revives one that has run out or was signed out. */
export async function extendSession(db: D1Database, userId: string, idHash: string, now: number, expiresAt: number): Promise<boolean> {
  const changed = await run(
    db
      .prepare('UPDATE sessions SET expires_at = ?4 WHERE id_hash = ?1 AND user_id = ?2 AND expires_at > ?3 AND expires_at < ?4')
      .bind(idHash, userId, now, expiresAt),
  );
  return changed > 0;
}

export async function deleteSession(db: D1Database, userId: string, idHash: string): Promise<void> {
  await run(db.prepare('DELETE FROM sessions WHERE id_hash = ?1 AND user_id = ?2').bind(idHash, userId));
}
