import type { Status } from '../api/types';

const DAY = 24 * 60 * 60 * 1000;
const LOCALE = 'en-US';

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function withZone(options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormatOptions {
  return timeZone ? { ...options, timeZone } : options;
}

/** "March 4, 2026", or "Date unknown" when Witness does not know. Unknown dates stay unknown. */
export function formatDate(ms: number | null | undefined, timeZone?: string): string {
  if (ms == null) return 'Date unknown';
  return new Intl.DateTimeFormat(
    LOCALE,
    withZone({ month: 'long', day: 'numeric', year: 'numeric' }, timeZone),
  ).format(ms);
}

/** "8:30 AM" */
export function formatTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(LOCALE, withZone({ hour: 'numeric', minute: '2-digit' }, timeZone)).format(ms);
}

/** "Friday, September 26" */
export function formatWeekdayDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(
    LOCALE,
    withZone({ weekday: 'long', month: 'long', day: 'numeric' }, timeZone),
  ).format(ms);
}

/** "08:30" → "8:30 AM" */
export function formatLocalTime(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${match[2]} ${suffix}`;
}

/** Days since the Unix epoch for the calendar date of `ms` in `timeZone`. */
function calendarDay(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat(
    LOCALE,
    withZone({ year: 'numeric', month: 'numeric', day: 'numeric' }, timeZone),
  ).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY);
}

/** "just now", "3 hours ago", "yesterday", "2 days ago", "3 weeks ago", "on March 4, 2026" */
export function relativeAgo(ms: number, now: number, timeZone?: string): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  const days = calendarDay(now, timeZone) - calendarDay(ms, timeZone);
  if (days <= 0) {
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  }
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `on ${formatDate(ms, timeZone)}`;
}

/** "today at 8:30 AM", "tomorrow at 8:30 AM", "Tuesday at 8:30 AM", "October 14 at 8:30 AM" */
export function formatUpcoming(ms: number, now: number, timeZone?: string): string {
  const days = calendarDay(ms, timeZone) - calendarDay(now, timeZone);
  const time = formatTime(ms, timeZone);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) {
    const weekday = new Intl.DateTimeFormat(LOCALE, withZone({ weekday: 'long' }, timeZone)).format(ms);
    return `${weekday} at ${time}`;
  }
  const date = new Intl.DateTimeFormat(LOCALE, withZone({ month: 'long', day: 'numeric' }, timeZone)).format(ms);
  return `${date} at ${time}`;
}

export interface StatusSentence {
  /** The lead sentence, shown brightest. */
  lead: string;
  rest: string[];
}

/**
 * The one status sentence on Home, e.g.
 * "Witness is on. Something new came in 2 days ago. Next email Tuesday at 8:30 AM."
 * Plain facts only: no counts to live up to, nothing to feel bad about. It never
 * promises an email that will not come: nothing is sent while nothing is kept.
 */
/** How recent "Something new came in …" must be to be said at all; older, it would read like a count of days without. */
export const RECENT_CAPTURE_MS = 3 * 24 * 60 * 60 * 1000;

export function statusSentence(status: Status, now: number, timeZone?: string): StatusSentence {
  const { rhythm } = status;
  const paused = rhythm.pausedUntil != null && rhythm.pausedUntil > now;
  const lead = paused
    ? `Witness is paused until ${formatWeekdayDate(rhythm.pausedUntil as number, timeZone)}.`
    : 'Witness is on.';

  const rest: string[] = [];
  // lastCapturedAt counts anything kept, Maybe included, so it says "came in", not "kept". A source
  // can hear something without keeping it (a newsletter), and Home lists that source beside this.
  const heardSomething = status.sources.some((s) => s.lastAt != null);
  if (status.lastCapturedAt == null) {
    rest.push(heardSomething ? 'Nothing kept yet.' : 'Nothing has come in yet.');
  } else {
    rest.push(
      now - status.lastCapturedAt <= RECENT_CAPTURE_MS
        ? `Something new came in ${relativeAgo(status.lastCapturedAt, now, timeZone)}.`
        : 'It keeps things as they arrive.',
    );
  }
  if (paused) {
    rest.push('It still keeps what arrives, and sends nothing until then.');
  } else if (!rhythm.enabled) {
    rest.push('Nothing is emailed until you choose when.');
  } else if (status.saved === 0) {
    rest.push(
      status.lastCapturedAt == null
        ? 'Your first email comes after Witness keeps something.'
        : 'Nothing kept yet, so your first email comes after Witness keeps something.',
    );
  } else if (rhythm.nextAt != null) {
    rest.push(`Next email ${formatUpcoming(rhythm.nextAt, now, timeZone)}.`);
  }
  return { lead, rest };
}

/** "2026-03-04" in the browser's zone, for <input type="date">. */
export function toDateInputValue(ms: number | null | undefined): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midday local time, so the calendar date survives any time-zone conversion. */
export function fromDateInputValue(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
}
