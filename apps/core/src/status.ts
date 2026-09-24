/** Status for the web app, agents and devices: counts and health only, never content. */
import { itemCounts } from './store/items.js';
import { sourceHealth, type SourceHealth } from './store/events.js';
import { effectiveNextAt } from './delivery.js';
import { getRhythm } from './store/rhythm.js';

export interface StatusSummary {
  saved: number;
  maybe: number;
  lastCapturedAt: number | null;
  sources: SourceHealth[];
  rhythm: { enabled: boolean; nextAt: number | null; pausedUntil: number | null };
}

export async function statusSummary(db: D1Database, userId: string, now: number): Promise<StatusSummary> {
  const [counts, sources, rhythm] = await Promise.all([
    itemCounts(db, userId),
    sourceHealth(db, userId, now),
    getRhythm(db, userId, 'UTC', now),
  ]);
  const paused = rhythm.paused_until !== null && rhythm.paused_until > now;
  return {
    saved: counts.saved,
    maybe: counts.maybe,
    lastCapturedAt: counts.lastCapturedAt,
    sources,
    rhythm: {
      enabled: rhythm.enabled === 1,
      nextAt: effectiveNextAt(rhythm),
      pausedUntil: paused ? rhythm.paused_until : null,
    },
  };
}
