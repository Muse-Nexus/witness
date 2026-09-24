/**
 * Muse Nexus brand primitives shared by emails and server-rendered pages
 * (docs/dev/SPEC.md §4). Email clients do not support oklch() or custom
 * properties, so emails use the nearest hex values.
 */
import { showableDate } from '../dates.js';

export const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,ital,wght@9..144,0,400;9..144,0,500;9..144,1,400&family=Inter:wght@400;500;600&display=swap';

export const CRISIS_LINE = 'If you are in crisis, call or text 988 (US) or visit findahelpline.com.';
export const STUDIO_FOOTER = 'Made by Muse Nexus in Hawaiʻi · Open source (MIT)';

/** Hex approximations of the §4 palette for email. */
export const EMAIL_COLORS = {
  ink: '#000000',
  cream: '#F7F2E8',
  coral: '#F9706A', // oklch(71% .17 25)
  muted: '#A6A29A', // cream at ~68% on ink
  faint: '#8A867F', // cream at ~55% on ink
  hairline: '#232220', // cream at 14% on ink
} as const;

export const SERIF = "Fraunces, Georgia, 'Times New Roman', serif";
export const SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Escaped text with line breaks kept. */
export function escapeMultiline(value: string): string {
  return escapeHtml(value.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

/** "September 24, 2026" in the given zone. */
export function formatLongDate(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(instant));
}

/** "Tuesday" in the given zone. */
export function formatWeekday(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(new Date(instant));
}

/** Attribution line under a quote: "— Dana · March 3, 2026 · Text message". */
export function attribution(input: { fromName: string | null; occurredAt: number | null; sourceLabel: string; timeZone: string }): string {
  const who = input.fromName?.trim() || 'Someone';
  const at = showableDate(input.occurredAt);
  const when = at !== null ? formatLongDate(at, input.timeZone) : 'Date unknown';
  return `— ${who} · ${when} · ${input.sourceLabel}`;
}
