/** Status for the web app, agents and devices: counts and health only, never content. */
import { emailCanShow, itemCounts, selectionCandidates } from './store/items.js';
import { sourceHealth, type SourceHealth } from './store/events.js';
import { deliveringTick, effectiveNextAt, scheduleOf } from './delivery.js';
import { nextRunAt, selectItem } from './rhythm.js';
import { getRhythm, type RhythmRow } from './store/rhythm.js';

export interface StatusSummary {
  saved: number;
  maybe: number;
  /** Saved items an email can show. With none, no email goes, so no next one is promised. */
  deliverable: number;
  lastCapturedAt: number | null;
  sources: SourceHealth[];
  rhythm: { enabled: boolean; nextAt: number | null; pausedUntil: number | null };
}

/**
 * Runs looked at before giving up. Something an email can show always qualifies within the
 * 30 days Witness waits before sending a thing again (REPEAT_GAP_MS), which is 31 daily runs
 * or 5 weekly ones.
 */
const MAX_RUNS = 64;

/**
 * The first scheduled run that would send something, or null. A run sends nothing when
 * everything an email can show went out in the last 30 days (never an empty-handed message),
 * so the promise is the first run after that, never the next slot. Picks as delivery does,
 * at the cron tick that delivers each run (08:15 for an 08:10 slot), and promises the slot.
 */
async function nextSendingRun(db: D1Database, userId: string, rhythm: RhythmRow): Promise<number | null> {
  let at = effectiveNextAt(rhythm);
  if (at === null) return null;
  const candidates = (await selectionCandidates(db, userId)).filter(emailCanShow);
  if (candidates.length === 0) return null;
  const schedule = scheduleOf(rhythm);
  for (let i = 0; i < MAX_RUNS && at !== null; i += 1) {
    if (selectItem(candidates, null, deliveringTick(at), rhythm.timezone) !== null) return at;
    at = nextRunAt(schedule, at);
  }
  return null;
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
    deliverable: counts.deliverable,
    lastCapturedAt: counts.lastCapturedAt,
    sources,
    rhythm: {
      enabled: rhythm.enabled === 1,
      // A run with nothing an email can show, or only things sent in the last 30 days, sends nothing.
      nextAt: counts.deliverable > 0 ? await nextSendingRun(db, userId, rhythm) : null,
      pausedUntil: paused ? rhythm.paused_until : null,
    },
  };
}
