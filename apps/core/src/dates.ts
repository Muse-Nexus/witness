/**
 * When something happened, as epoch milliseconds. One rule for every way a date comes in
 * (REST, MCP, the web app): from 1970 up to the last instant a JavaScript Date can hold.
 * Past that, every date formatter throws, and one such row would stop every delivery.
 */
import { z } from 'zod';

/** The largest instant a Date can hold (±8.64e15 ms, ECMA-262 §21.4.1.1). */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/** An occurredAt given as epoch milliseconds. */
export const OccurredAtMs = z.number().int().min(0).max(MAX_DATE_MS);

/** Whether a date given as input may be kept (the same rule as OccurredAtMs). */
export function isAcceptedDate(ms: number): boolean {
  return Number.isInteger(ms) && ms >= 0 && ms <= MAX_DATE_MS;
}

/**
 * A stored date that can be formatted, or null ("Date unknown"). Reads go through this, so a
 * date that slipped in some other way shows as unknown instead of breaking what shows it.
 */
export function showableDate(ms: number | null | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}
