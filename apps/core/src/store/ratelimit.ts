/** Fixed-window counters in D1. Keys are hashes chosen by the caller; no emails or IPs in plaintext. */
import { first, run } from './db.js';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

export async function hitRateLimit(
  db: D1Database,
  input: { key: string; limit: number; windowMs: number; now: number },
): Promise<RateLimitResult> {
  const windowStart = Math.floor(input.now / input.windowMs) * input.windowMs;
  const row = await first<{ count: number }>(
    db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
           window_start = excluded.window_start
         RETURNING count`,
      )
      .bind(input.key, windowStart),
  );
  const count = row?.count ?? 1;
  return { allowed: count <= input.limit, count, retryAfterMs: windowStart + input.windowMs - input.now };
}

export async function pruneRateLimits(db: D1Database, olderThan: number): Promise<void> {
  await run(db.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(olderThan));
}
