import { describe, expect, it } from 'vitest';
import { ALL_DAYS, nextRunAt, selectItem, zonedParts, zonedTimeToUtc, type Selectable } from '../src/rhythm.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe('next_run_at', () => {
  it('Pacific/Honolulu (no DST): 08:30 HST is always 18:30 UTC', () => {
    const schedule = { localTime: '08:30', days: ALL_DAYS, timeZone: 'Pacific/Honolulu' };
    expect(nextRunAt(schedule, utc(2026, 3, 7, 12))).toBe(utc(2026, 3, 7, 18, 30));
    expect(nextRunAt(schedule, utc(2026, 3, 7, 18, 30))).toBe(utc(2026, 3, 8, 18, 30));
    expect(nextRunAt(schedule, utc(2026, 11, 1, 12))).toBe(utc(2026, 11, 1, 18, 30));
  });

  it('America/New_York across the March DST change keeps 08:30 local', () => {
    const schedule = { localTime: '08:30', days: ALL_DAYS, timeZone: 'America/New_York' };
    // Saturday Mar 7, 2026 is still EST (UTC-5).
    expect(nextRunAt(schedule, utc(2026, 3, 7, 12))).toBe(utc(2026, 3, 7, 13, 30));
    // DST starts Sunday Mar 8 at 02:00; 08:30 EDT is 12:30 UTC.
    expect(nextRunAt(schedule, utc(2026, 3, 7, 13, 30))).toBe(utc(2026, 3, 8, 12, 30));
    expect(nextRunAt(schedule, utc(2026, 3, 8, 12, 30))).toBe(utc(2026, 3, 9, 12, 30));
  });

  it('America/New_York across the November DST change', () => {
    const schedule = { localTime: '08:30', days: ALL_DAYS, timeZone: 'America/New_York' };
    expect(nextRunAt(schedule, utc(2026, 10, 31, 13))).toBe(utc(2026, 11, 1, 13, 30)); // EST again: UTC-5
    expect(nextRunAt(schedule, utc(2026, 10, 30, 13))).toBe(utc(2026, 10, 31, 12, 30)); // still EDT
  });

  it('a local time that does not exist runs just after the gap; a repeated one runs the first time', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')).toBe(utc(2026, 3, 8, 7, 30)); // 03:30 EDT
    expect(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York')).toBe(utc(2026, 11, 1, 5, 30)); // 01:30 EDT
    const gap = nextRunAt({ localTime: '02:30', days: ['sun'], timeZone: 'America/New_York' }, utc(2026, 3, 7));
    expect(zonedParts(gap!, 'America/New_York')).toMatchObject({ day: 8, hour: 3, minute: 30 });
  });

  it('honors the chosen days', () => {
    // Weekdays only; from Friday evening in Honolulu the next is Monday.
    const schedule = { localTime: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const, timeZone: 'Pacific/Honolulu' };
    const next = nextRunAt(schedule, utc(2026, 9, 26, 5)); // Fri Sep 25, 19:00 HST
    expect(zonedParts(next!, 'Pacific/Honolulu')).toMatchObject({ weekday: 'mon', day: 28, hour: 7, minute: 0 });
  });

  it('returns null for a schedule that never fires', () => {
    expect(nextRunAt({ localTime: '08:30', days: [], timeZone: 'UTC' }, 0)).toBeNull();
    expect(nextRunAt({ localTime: '25:00', days: ALL_DAYS, timeZone: 'UTC' }, 0)).toBeNull();
    expect(nextRunAt({ localTime: '08:30', days: ALL_DAYS, timeZone: 'Nowhere/City' }, 0)).toBeNull();
  });
});

describe('selectItem', () => {
  const now = utc(2026, 9, 24, 18, 30); // Sep 24, 2026 08:30 in Honolulu
  const tz = 'Pacific/Honolulu';
  const item = (over: Partial<Selectable> & { id: string }): Selectable => ({
    category: 'gratitude',
    sender_key: null,
    occurred_at: null,
    created_at: utc(2026, 1, 1),
    last_delivered_at: null,
    delivered_count: 0,
    ...over,
  });

  it('prefers "on this day" from an earlier year', () => {
    const items = [
      item({ id: 'old-never', created_at: utc(2025, 1, 1) }),
      item({ id: 'anniversary', occurred_at: utc(2024, 9, 24, 20), created_at: utc(2026, 5, 1), delivered_count: 1, last_delivered_at: utc(2025, 6, 1) }),
    ];
    expect(selectItem(items, null, now, tz)).toBe('anniversary');
  });

  it('skips "on this day" delivered within 300 days', () => {
    const items = [
      item({ id: 'anniversary', occurred_at: utc(2024, 9, 24, 20), delivered_count: 1, last_delivered_at: now - 100 * DAY }),
      item({ id: 'never', created_at: utc(2026, 2, 1) }),
    ];
    expect(selectItem(items, null, now, tz)).toBe('never');
  });

  it('then never delivered, oldest first', () => {
    const items = [item({ id: 'newer', created_at: utc(2026, 3, 1) }), item({ id: 'older', created_at: utc(2026, 2, 1) })];
    expect(selectItem(items, null, now, tz)).toBe('older');
  });

  it('then least recently delivered, never within 30 days', () => {
    const items = [
      item({ id: 'recent', delivered_count: 1, last_delivered_at: now - 5 * DAY }),
      item({ id: 'long-ago', delivered_count: 2, last_delivered_at: now - 90 * DAY }),
      item({ id: 'a-while', delivered_count: 1, last_delivered_at: now - 40 * DAY }),
    ];
    expect(selectItem(items, null, now, tz)).toBe('long-ago');
    expect(selectItem([items[0]!], null, now, tz)).toBeNull();
  });

  it('avoids the previous category and sender when it can', () => {
    const items = [
      item({ id: 'same', created_at: utc(2026, 1, 1), category: 'pride', sender_key: 'k1' }),
      item({ id: 'same-sender', created_at: utc(2026, 1, 2), category: 'love', sender_key: 'k1' }),
      item({ id: 'different', created_at: utc(2026, 1, 3), category: 'care', sender_key: 'k2' }),
    ];
    expect(selectItem(items, { category: 'pride', sender_key: 'k1' }, now, tz)).toBe('different');
    expect(selectItem([items[0]!], { category: 'pride', sender_key: 'k1' }, now, tz)).toBe('same');
  });

  it('returns null when nothing is saved', () => {
    expect(selectItem([], null, now, tz)).toBeNull();
  });
});
