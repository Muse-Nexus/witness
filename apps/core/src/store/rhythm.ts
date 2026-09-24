/** The delivery rhythm a person chose. One row per user. */
import { all, first, run } from './db.js';

export interface RhythmRow {
  user_id: string;
  enabled: number;
  channel: string;
  local_time: string;
  days: string;
  timezone: string;
  paused_until: number | null;
  skip_next: number;
  next_run_at: number | null;
  consented_at: number | null;
  updated_at: number | null;
  /** Who is sending a delivery right now (migration 0005), and until when the claim holds. */
  delivery_claim?: string | null;
  delivery_claim_until?: number | null;
}

export async function getRhythm(db: D1Database, userId: string, fallbackTimezone: string, now: number): Promise<RhythmRow> {
  const row = await first<RhythmRow>(db.prepare('SELECT * FROM rhythms WHERE user_id = ?1').bind(userId));
  if (row) return row;
  await run(
    db
      .prepare('INSERT INTO rhythms (user_id, enabled, timezone, updated_at) VALUES (?1, 0, ?2, ?3) ON CONFLICT DO NOTHING')
      .bind(userId, fallbackTimezone, now),
  );
  const created = await first<RhythmRow>(db.prepare('SELECT * FROM rhythms WHERE user_id = ?1').bind(userId));
  if (!created) throw new Error('rhythm row missing');
  return created;
}

export async function saveRhythm(
  db: D1Database,
  row: Pick<RhythmRow, 'user_id' | 'enabled' | 'channel' | 'local_time' | 'days' | 'timezone' | 'next_run_at' | 'consented_at' | 'skip_next'>,
  now: number,
): Promise<void> {
  await run(
    db
      .prepare(
        `UPDATE rhythms SET enabled = ?2, channel = ?3, local_time = ?4, days = ?5, timezone = ?6,
           next_run_at = ?7, consented_at = ?8, skip_next = ?10, updated_at = ?9
         WHERE user_id = ?1`,
      )
      .bind(row.user_id, row.enabled, row.channel, row.local_time, row.days, row.timezone, row.next_run_at, row.consented_at, now, row.skip_next),
  );
}

/**
 * Starts or ends a break. Either way a pending "Not today" is dropped: the break
 * covers it, and after a break the first delivery should arrive when Witness says it will.
 */
export async function setPause(db: D1Database, userId: string, pausedUntil: number | null, nextRunAt: number | null, now: number): Promise<void> {
  await run(
    db
      .prepare('UPDATE rhythms SET paused_until = ?2, next_run_at = ?3, skip_next = 0, updated_at = ?4 WHERE user_id = ?1')
      .bind(userId, pausedUntil, nextRunAt, now),
  );
}

/** "Stop these emails": the rhythm is off until the person turns it back on. */
export async function stopRhythm(db: D1Database, userId: string, now: number): Promise<void> {
  await run(
    db.prepare('UPDATE rhythms SET enabled = 0, next_run_at = NULL, skip_next = 0, updated_at = ?2 WHERE user_id = ?1').bind(userId, now),
  );
}

export async function setSkipNext(db: D1Database, userId: string, skip: boolean, now: number): Promise<void> {
  await run(db.prepare('UPDATE rhythms SET skip_next = ?2, updated_at = ?3 WHERE user_id = ?1').bind(userId, skip ? 1 : 0, now));
}

export function dueRhythms(db: D1Database, now: number, limit: number): Promise<RhythmRow[]> {
  return all<RhythmRow>(
    db
      .prepare('SELECT * FROM rhythms WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1 ORDER BY next_run_at LIMIT ?2')
      .bind(now, limit),
  );
}

/**
 * Moves next_run_at forward only if nobody else has since (compare-and-set),
 * so overlapping cron runs never deliver twice. Also clears skip_next when asked.
 */
export async function claimRun(
  db: D1Database,
  userId: string,
  expectedNext: number,
  newNext: number | null,
  clearSkip: boolean,
  now: number,
): Promise<boolean> {
  const changed = await run(
    db
      .prepare(
        `UPDATE rhythms SET next_run_at = ?3, skip_next = CASE WHEN ?4 = 1 THEN 0 ELSE skip_next END, updated_at = ?5
         WHERE user_id = ?1 AND next_run_at = ?2`,
      )
      .bind(userId, expectedNext, newNext, clearSkip ? 1 : 0, now),
  );
  return changed > 0;
}

/** Longer than any send takes; a claim left by a sender that died runs out after this. */
export const DELIVERY_CLAIM_MS = 2 * 60 * 1000;

/**
 * Claims the right to send this person one delivery now: one conditional write, so of two
 * senders (the cron, "Send one now") at the same moment only one gets it. The rhythm row
 * must exist (getRhythm creates it).
 */
export async function claimDelivery(db: D1Database, userId: string, claimId: string, now: number): Promise<boolean> {
  const changed = await run(
    db
      .prepare(
        `UPDATE rhythms SET delivery_claim = ?2, delivery_claim_until = ?3
         WHERE user_id = ?1 AND (delivery_claim_until IS NULL OR delivery_claim_until <= ?4)`,
      )
      .bind(userId, claimId, now + DELIVERY_CLAIM_MS, now),
  );
  return changed > 0;
}

/** Lets go of a claim, only if it is still this sender's. */
export async function releaseDelivery(db: D1Database, userId: string, claimId: string): Promise<void> {
  await run(
    db
      .prepare('UPDATE rhythms SET delivery_claim = NULL, delivery_claim_until = NULL WHERE user_id = ?1 AND delivery_claim = ?2')
      .bind(userId, claimId),
  );
}
