/**
 * Rhythm math and selection (SPEC §8, "Rhythm delivery"). Pure functions: no I/O.
 *
 * Times are computed in the rhythm's IANA time zone with Intl.DateTimeFormat,
 * so daylight-saving changes move the UTC instant and keep the local time.
 * A local time that does not exist (spring forward) runs at the same wall-clock
 * distance after the gap (02:30 becomes 03:30); a local time that happens twice
 * (fall back) runs the first time. This matches Temporal's "compatible" rule.
 */
import { showableDate } from './dates.js';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const ALL_DAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
}

export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values.year!;
  const month = values.month!;
  const day = values.day!;
  return {
    year,
    month,
    day,
    hour: values.hour! % 24,
    minute: values.minute!,
    second: values.second!,
    weekday: WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!,
  };
}

/** Offset of the zone from UTC at `instant`, in ms (east positive). */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of a local wall-clock time in `timeZone`, with "compatible" disambiguation. */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const matches = (t: number) => {
    const p = zonedParts(t, timeZone);
    return p.year === local.year && p.month === local.month && p.day === local.day && p.hour === local.hour && p.minute === local.minute;
  };
  const candidates = [wall - before, wall - after].filter(matches).sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0]!; // unique, or the earlier of two (fall back)
  return wall - before; // in a gap (spring forward): shift past it
}

export interface Schedule {
  localTime: string; // "HH:MM", 24-hour
  days: readonly Weekday[];
  timeZone: string;
}

export function parseLocalTime(value: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export function parseDays(value: string): Weekday[] {
  const wanted = new Set(value.split(',').map((d) => d.trim().toLowerCase()));
  return ALL_DAYS.filter((d) => wanted.has(d));
}

/** The first scheduled instant strictly after `after`, or null if the schedule never fires. */
export function nextRunAt(schedule: Schedule, after: number): number | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time || schedule.days.length === 0 || !isValidTimeZone(schedule.timeZone)) return null;
  const days = new Set(schedule.days);
  const today = zonedParts(after, schedule.timeZone);
  // Walk local calendar days; 9 covers a full week plus a DST shift at either end.
  for (let i = 0; i < 9; i += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const weekday = WEEKDAYS[date.getUTCDay()]!;
    if (!days.has(weekday)) continue;
    const at = zonedTimeToUtc(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: time.hour, minute: time.minute },
      schedule.timeZone,
    );
    if (at > after) return at;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface Selectable {
  id: string;
  category: string;
  sender_key: string | null;
  occurred_at: number | null;
  created_at: number;
  last_delivered_at: number | null;
  delivered_count: number;
}

export const ON_THIS_DAY_GAP_MS = 300 * DAY_MS;
export const REPEAT_GAP_MS = 30 * DAY_MS;

/**
 * Picks one saved item, or null when nothing qualifies (then nothing is sent):
 * 1. "on this day": same month and day in an earlier year, not delivered in 300 days;
 * 2. else never delivered, oldest first;
 * 3. else least recently delivered, skipping anything delivered in the last 30 days.
 * Within a tier, prefer a different category and sender than the previous delivery.
 */
export function selectItem(
  items: readonly Selectable[],
  previous: { category: string; sender_key: string | null } | null,
  now: number,
  timeZone: string,
): string | null {
  const today = zonedParts(now, timeZone);

  const onThisDay = items
    .filter((i) => {
      // A date that cannot be shown is unknown: the item can still come in the other tiers.
      const at = showableDate(i.occurred_at);
      if (at === null) return false;
      if (i.last_delivered_at !== null && now - i.last_delivered_at < ON_THIS_DAY_GAP_MS) return false;
      const p = zonedParts(at, timeZone);
      return p.month === today.month && p.day === today.day && p.year < today.year;
    })
    .sort((a, b) => (a.occurred_at ?? 0) - (b.occurred_at ?? 0));

  const neverDelivered = items
    .filter((i) => i.delivered_count === 0 && i.last_delivered_at === null)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  const leastRecent = items
    .filter((i) => i.last_delivered_at !== null && now - i.last_delivered_at >= REPEAT_GAP_MS)
    .sort((a, b) => (a.last_delivered_at ?? 0) - (b.last_delivered_at ?? 0) || a.id.localeCompare(b.id));

  const varied = (i: Selectable) =>
    !previous || (i.category !== previous.category && (i.sender_key === null || i.sender_key !== previous.sender_key));

  for (const tier of [onThisDay, neverDelivered, leastRecent]) {
    if (tier.length === 0) continue;
    return (tier.find(varied) ?? tier[0]!).id;
  }
  return null;
}
