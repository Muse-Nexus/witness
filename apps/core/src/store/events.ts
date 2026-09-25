/** inbound_events: what arrived and what happened to it, for status only. Never content. */
import { all, newId, run, type EventOutcome } from './db.js';

/** Recorded only while the account exists: nothing is written for one deleted mid-request. */
export async function recordEvent(
  db: D1Database,
  input: { userId: string; sourceType: string; outcome: EventOutcome; reason?: string | null; now: number },
): Promise<void> {
  await run(
    db
      .prepare(
        `INSERT INTO inbound_events (id, user_id, received_at, source_type, outcome, reason)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
      )
      .bind(newId(), input.userId, input.now, input.sourceType, input.outcome, input.reason ?? null),
  );
}

export interface SourceHealth {
  type: string;
  lastAt: number;
  count7d: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per source: when something last arrived and how many arrived this week. Rejected mail is not a
 * working source, and a forwarding confirmation only shows the address works: setup still has
 * to send mail there, so it does not count as hearing from that email.
 */
export async function sourceHealth(db: D1Database, userId: string, now: number): Promise<SourceHealth[]> {
  const rows = await all<{ source_type: string; last_at: number; count7d: number }>(
    db
      .prepare(
        `SELECT source_type, MAX(received_at) AS last_at, SUM(received_at > ?2) AS count7d
         FROM inbound_events WHERE user_id = ?1 AND outcome NOT IN ('rejected', 'confirmation')
         GROUP BY source_type ORDER BY last_at DESC`,
      )
      .bind(userId, now - WEEK_MS),
  );
  return rows.map((r) => ({ type: r.source_type, lastAt: r.last_at, count7d: r.count7d ?? 0 }));
}
