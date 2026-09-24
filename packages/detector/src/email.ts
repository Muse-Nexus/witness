/**
 * Turns a raw inbound email into the evidence the detector should look at:
 * the original sender's own words, without the forwarder's note, quoted reply
 * history or signatures.
 *
 * Handles manual forwards from Gmail, Outlook (desktop, web, older
 * "-----Original Message-----" style), Apple Mail and Thunderbird. When a
 * message was forwarded several times, the innermost (original) message wins.
 * No dependencies: HTML is reduced to text with a small tag stripper.
 */

export interface RawEmail {
  text?: string;
  html?: string;
  subject?: string;
  from?: { name?: string; address?: string };
  date?: string;
  headers: Record<string, string>;
  /**
   * Walk into "Forwarded message" blocks and credit their sender and date (the
   * default). Set false for mail the owner did not write themself: a block in
   * someone else's mail is only their claim, so it is not followed.
   */
  followForwards?: boolean;
}

export interface EmailEvidence {
  text: string;
  subject?: string;
  from?: { name?: string; handle?: string };
  occurredAt?: number;
  forwarded: boolean;
  /** A forwarded-message block was present but not followed (`followForwards: false`). */
  unfollowedForward?: boolean;
  headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', hearts: '♥',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', zwnj: '‌', zwj: '‍',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS = 'p|div|li|ul|ol|tr|table|h[1-6]|blockquote|section|article|header|footer|pre|dd|dt';

/** Far more than any message worth keeping; past this, HTML is cut before it is read. */
export const MAX_HTML_CHARS = 200_000;

const HIDDEN_BLOCK = /<(head|style|script|title|template)\b/;

/**
 * Drops comments and <head>/<style>/<script>/<title>/<template> blocks with a
 * forward-only scan: an unclosed one hides the rest of the document, as it does
 * in a browser. Regexes like `<style>[\s\S]*?</style>` rescan to the end for
 * every unclosed tag, which is quadratic on crafted mail.
 */
function dropHiddenBlocks(html: string): string {
  // Searched on the original string (no toLowerCase, which can change lengths), case-insensitively.
  const opener = new RegExp(HIDDEN_BLOCK.source, 'gi');
  let out = '';
  let at = 0;
  while (at < html.length) {
    const comment = html.indexOf('<!--', at);
    opener.lastIndex = at;
    const block = opener.exec(html);
    const blockAt = block ? block.index : -1;
    if (comment < 0 && blockAt < 0) break;
    if (comment >= 0 && (blockAt < 0 || comment < blockAt)) {
      out += html.slice(at, comment);
      const end = html.indexOf('-->', comment + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    out += html.slice(at, blockAt);
    const closer = new RegExp(`</${block![1]}`, 'gi');
    closer.lastIndex = blockAt + block![0].length;
    const close = closer.exec(html);
    if (!close) {
      at = html.length;
      break;
    }
    const gt = html.indexOf('>', close.index);
    at = gt < 0 ? html.length : gt + 1;
  }
  return out + html.slice(at);
}

function isTagStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '/' || c === '!' || c === '?';
}

/**
 * Removes the remaining tags in one linear pass. An unclosed tag stops at the next "<",
 * never at the end of the message. A "<" that is not a tag opener (such as "<3") is kept,
 * unless removing a tag would put it in front of a letter, where it could re-form a tag.
 */
function stripTags(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const c = html[i]!;
    if (c === '<' && i + 1 < n && isTagStart(html[i + 1]!)) {
      let j = i + 1;
      while (j < n && html[j] !== '>' && html[j] !== '<') j++;
      i = j < n && html[j] === '>' ? j + 1 : j;
      continue;
    }
    if (isTagStart(c) && out[out.length - 1] === '<') out.pop();
    out.push(c);
    i++;
  }
  return out.join('');
}

export function htmlToText(html: string): string {
  // Tag patterns stop at the next "<" ([^<>]), so an unclosed tag costs only the
  // distance to the next one, never a scan to the end of the message.
  let s = dropHiddenBlocks(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html)
    .replace(/<br\s*\/?>/gi, '\n')
    // Outlook draws a rule above the header of the message it forwards or quotes.
    .replace(/<hr\b[^<>]*>/gi, '\n________________________________\n')
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^<>]*>`, 'gi'), '\n');
  s = decodeEntities(stripTags(s))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ');
  return s
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Addresses and dates
// ---------------------------------------------------------------------------

const MAX_ADDRESS_CHARS = 1000;
const MAX_DATE_CHARS = 256;

/** Splits "Name <addr>" style values at the last `open` when the value ends with `close`. */
function splitTrailing(v: string, open: string, close: string, ignoreCase: boolean): [string, string] | undefined {
  if (!v.endsWith(close)) return undefined;
  const at = (ignoreCase ? v.toLowerCase() : v).lastIndexOf(ignoreCase ? open.toLowerCase() : open);
  if (at < 0) return undefined;
  const inner = v.slice(at + open.length, v.length - close.length);
  if (inner === '' || inner.includes(close)) return undefined;
  return [v.slice(0, at).trim(), inner];
}

function trimQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === '"' || s[start] === "'")) start++;
  while (end > start && (s[end - 1] === '"' || s[end - 1] === "'")) end--;
  return s.slice(start, end);
}

export function parseAddress(value: string | undefined): { name?: string; handle?: string } | undefined {
  if (!value) return undefined;
  // Header values are short; the cap keeps a hostile one cheap. Parsing below uses
  // index lookups rather than backtracking patterns, so it is linear in any case.
  const v = value.slice(0, MAX_ADDRESS_CHARS).replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  if (!v) return undefined;
  let name: string | undefined;
  let handle: string | undefined;
  const bracket = splitTrailing(v, '[mailto:', ']', true);
  const angle = bracket ? undefined : splitTrailing(v, '<', '>', false);
  if (bracket) {
    [name, handle] = bracket;
  } else if (angle) {
    [name, handle] = angle;
  } else if (/^[^\s@]+@[^\s@]+$/.test(v)) {
    handle = v;
  } else {
    name = v;
  }
  name = name === undefined ? undefined : trimQuotes(name).trim() || undefined;
  handle = handle?.replace(/^mailto:/i, '').trim().toLowerCase() || undefined;
  if (!name && !handle) return undefined;
  return { ...(name ? { name } : {}), ...(handle ? { handle } : {}) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Offsets in minutes east of UTC for abbreviations mail clients print. Ambiguous ones (IST, CST in Asia) are left out. */
const ZONES: Record<string, number> = {
  utc: 0, gmt: 0, z: 0, ut: 0,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
  akst: -540, akdt: -480, hst: -600, bst: 60, cet: 60, cest: 120, eet: 120, eest: 180,
  aest: 600, aedt: 660, jst: 540, nzst: 720, nzdt: 780,
};

/** Numeric UTC offset (minutes) from a date string such as "... -0700", or undefined. */
export function offsetMinutesOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = /\d{1,2}:\d{2}/.exec(value);
  const after = time ? value.slice(time.index + time[0].length) : value;
  const numeric = /([+-])(\d{2}):?(\d{2})\b/.exec(after);
  if (numeric) {
    const minutes = Number(numeric[2]) * 60 + Number(numeric[3]);
    return numeric[1] === '-' ? -minutes : minutes;
  }
  for (const token of after.toLowerCase().split(/[^a-z]+/)) {
    if (token && token in ZONES) return ZONES[token];
  }
  return undefined;
}

/**
 * Parses the date formats mail clients print: RFC 2822, ISO 8601, Gmail
 * ("Tue, Sep 16, 2026 at 7:45 PM"), Apple Mail ("September 16, 2026 at
 * 7:45:12 PM PDT") and Outlook ("Monday, September 22, 2026 9:14 AM").
 * A date without a zone uses `fallbackOffset` (minutes east of UTC), else UTC.
 * Returns undefined rather than guessing.
 */
export function parseMailDate(value: string | undefined, fallbackOffset?: number): number | undefined {
  if (!value) return undefined;
  const raw = value.trim().slice(0, MAX_DATE_CHARS);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
    const iso = Date.parse(raw);
    return Number.isFinite(iso) ? iso : undefined;
  }

  const s = raw.replace(/\([^()]*\)/g, ' ').replace(/\bat\b/gi, ' ').replace(/,/g, ' ');
  const timeMatch = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(s);
  const datePart = timeMatch ? s.slice(0, timeMatch.index) + ' ' + s.slice(timeMatch.index + timeMatch[0].length) : s;

  let month = -1;
  let day = -1;
  let year = -1;
  for (const token of datePart.split(/\s+/)) {
    const lower = token.toLowerCase().replace(/\.$/, '');
    if (month < 0 && /^[a-z]{3,9}$/.test(lower)) {
      const index = MONTHS.indexOf(lower.slice(0, 3));
      if (index >= 0 && (lower.length === 3 || lower === 'sept' || MONTH_NAMES[index] === lower)) {
        month = index;
        continue;
      }
    }
    if (/^\d{4}$/.test(lower) && year < 0) year = Number(lower);
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(lower) && day < 0) day = parseInt(lower, 10);
  }
  if (month < 0 || day < 1 || day > 31 || year < 1970 || year > 2200) return undefined;

  let hour = 12;
  let minute = 0;
  let second = 0;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    second = timeMatch[3] ? Number(timeMatch[3]) : 0;
    const meridiem = timeMatch[4]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return undefined;
      if (meridiem === 'pm' && hour !== 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
    }
    if (hour > 23 || minute > 59 || second > 60) return undefined;
  }

  const utc = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(utc);
  if (check.getUTCDate() !== day) return undefined; // e.g. Feb 31
  const offset = offsetMinutesOf(raw) ?? fallbackOffset ?? 0;
  return utc - offset * 60_000;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
];

// ---------------------------------------------------------------------------
// Forwarded blocks, quoted replies, signatures
// ---------------------------------------------------------------------------

const unquoteLine = (line: string): string => line.replace(/^[\s>]*/, '');

const STRONG_FORWARD = [
  /^-{3,}\s*Forwarded message\s*-{3,}\s*$/i, // Gmail
  /^Begin forwarded message:\s*$/i, // Apple Mail
  /^-{3,}\s*Forwarded Message\s*-{3,}\s*$/i, // Thunderbird
];
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}\s*$/i;
const OUTLOOK_RULE = /^_{10,}\s*$/;
const HEADER_LINE = /^\**(From|Date|Sent|Subject|To|Cc|Bcc|Reply-To)\**\s*:\s*\**\s*(.*?)\s*$/i;

interface HeaderBlock {
  fields: Record<string, string>;
  /** Index of the first body line after the header block. */
  bodyStart: number;
}

function parseHeaderBlock(lines: readonly string[], start: number): HeaderBlock | null {
  let i = start;
  while (i < lines.length && unquoteLine(lines[i]!).trim() === '') i += 1;
  const fields: Record<string, string> = {};
  let last: string | null = null;
  for (; i < lines.length; i += 1) {
    const line = unquoteLine(lines[i]!);
    if (line.trim() === '') break;
    const m = HEADER_LINE.exec(line.trim());
    if (m) {
      last = m[1]!.toLowerCase();
      fields[last] = m[2]!.replace(/\*+$/, '').trim();
    } else if (last === 'to' || last === 'cc' || last === 'bcc') {
      fields[last] = `${fields[last]} ${line.trim()}`; // wrapped recipient list
    } else {
      break;
    }
  }
  if (!fields.from) return null;
  return { fields, bodyStart: i };
}

/** True when line `i` starts an Outlook-style header block ("From:" then "Sent:"/"Date:" soon after). */
function isOutlookHeaderStart(lines: readonly string[], i: number): boolean {
  if (!/^\**From\**\s*:/i.test(unquoteLine(lines[i]!).trim())) return false;
  for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
    if (/^\**(Sent|Date)\**\s*:/i.test(unquoteLine(lines[j]!).trim())) return true;
  }
  return false;
}

const isBlank = (lines: readonly string[], from: number, to: number): boolean =>
  lines.slice(from, to).every((l) => unquoteLine(l).trim() === '');

/**
 * Finds the first forwarded-message header. Strong markers ("Forwarded
 * message", "Begin forwarded message:") always count. Outlook-style blocks
 * are also used for replies, so they count only when `weakAllowed` (the subject
 * says "Fwd"/"FW") or nothing but blank lines comes before them.
 */
function findForward(lines: readonly string[], weakAllowed: boolean): HeaderBlock | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = unquoteLine(lines[i]!).trim();
    if (STRONG_FORWARD.some((re) => re.test(line))) {
      return parseHeaderBlock(lines, i + 1) ?? { fields: {}, bodyStart: i + 1 };
    }
    const weakMarker = ORIGINAL_MESSAGE.test(line) || (OUTLOOK_RULE.test(line) && isOutlookHeaderStart(lines, nextNonBlank(lines, i + 1)));
    const bareHeader = !weakMarker && isOutlookHeaderStart(lines, i);
    if (weakMarker || bareHeader) {
      if (!weakAllowed && !isBlank(lines, 0, i)) return null; // a reply, not a forward
      return parseHeaderBlock(lines, weakMarker ? i + 1 : i);
    }
  }
  return null;
}

function nextNonBlank(lines: readonly string[], from: number): number {
  let i = from;
  while (i < lines.length - 1 && unquoteLine(lines[i]!).trim() === '') i += 1;
  return Math.min(i, lines.length - 1);
}

const REPLY_INTRO = /^On\b.{0,300}\bwrote:\s*$/i;

/** Index of the first "On <date>, <name> wrote:" line (possibly wrapped), or -1. */
function replyIntroIndex(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = unquoteLine(lines[i]!).trim();
    if (REPLY_INTRO.test(line)) return i;
    // Gmail wraps long "On ... wrote:" lines.
    if (/^On\b/i.test(line) && !/[.!?]$/.test(line)) {
      const next = unquoteLine(lines[i + 1] ?? '').trim();
      const after = unquoteLine(lines[i + 2] ?? '').trim();
      if (REPLY_INTRO.test(`${line} ${next}`) || REPLY_INTRO.test(`${line} ${next} ${after}`)) return i;
    }
  }
  return -1;
}

/** Index of the first line of quoted reply history, or -1. */
function replyHistoryStart(lines: readonly string[]): number {
  const intro = replyIntroIndex(lines);
  for (let i = 0; i < lines.length; i += 1) {
    if (i === intro) return i;
    const line = lines[i]!.trim();
    if (ORIGINAL_MESSAGE.test(line)) return i;
    if (OUTLOOK_RULE.test(line) && i + 1 < lines.length && isOutlookHeaderStart(lines, nextNonBlank(lines, i + 1))) return i;
    if (isOutlookHeaderStart(lines, i) && i > 0) return i;
  }
  return -1;
}

const MOBILE_SIGNOFF =
  /^(sent from my [\w ]{2,40}|sent from (yahoo mail|outlook|mail|gmail|aol|proton ?mail)\b.{0,40}|sent (via|with) .{2,50}|get outlook for (ios|android)\b.{0,20}|sent from mail for windows.{0,20})$/i;

function stripSignature(lines: string[]): string[] {
  const delimiter = lines.findIndex((l) => /^--\s?$/.test(l));
  let out = delimiter >= 0 ? lines.slice(0, delimiter) : lines;
  const signoff = out.findIndex((l) => MOBILE_SIGNOFF.test(l.trim()));
  if (signoff >= 0) {
    const after = out.slice(signoff + 1).filter((l) => l.trim() !== '').length;
    // A sign-off near the end ends the message; one mid-message is just dropped.
    out = after <= 4 ? out.slice(0, signoff) : out.filter((_, i) => i !== signoff);
  }
  return out;
}

function stripQuotedLines(lines: string[]): string[] {
  const unquoted = lines.filter((l) => !/^\s*>/.test(l));
  if (unquoted.some((l) => l.trim() !== '')) return unquoted;
  // Everything is quoted (some clients quote forwarded text): keep it, unquoted.
  return lines.map((l) => l.replace(/^\s*(>\s?)+/, ''));
}

const tidy = (lines: readonly string[]): string =>
  lines
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripSubjectPrefixes = (subject: string): string =>
  subject.replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, '').trim();

// ---------------------------------------------------------------------------
// extractEmailEvidence
// ---------------------------------------------------------------------------

export function extractEmailEvidence(raw: RawEmail): EmailEvidence {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers ?? {})) headers[k.toLowerCase()] = String(v);

  const plain = raw.text && raw.text.trim() !== '' ? raw.text : raw.html ? htmlToText(raw.html) : '';
  let lines = plain.replace(/\r\n?/g, '\n').split('\n');

  const outerSubject = raw.subject ?? headers.subject;
  const outerDate = raw.date ?? headers.date;
  let forwarded = false;
  let fields: Record<string, string> = {};

  // Walk into nested forwards; the innermost message is the original.
  let weakAllowed = /^\s*(fwd?|fw)\s*:/i.test(outerSubject ?? '');
  const follow = raw.followForwards !== false;
  let unfollowedForward = false;
  for (let depth = 0; depth < 8; depth += 1) {
    // A forward marker inside quoted reply history belongs to the history.
    const intro = replyIntroIndex(lines);
    const block = findForward(intro >= 0 ? lines.slice(0, intro) : lines, weakAllowed);
    if (!block) break;
    if (!follow) {
      // Someone else's mail with a "forwarded" block inside: their own words end where it starts.
      unfollowedForward = true;
      const marker = lines.findIndex((l, i) => i < block.bodyStart && (STRONG_FORWARD.some((re) => re.test(unquoteLine(l).trim())) || ORIGINAL_MESSAGE.test(unquoteLine(l).trim()) || OUTLOOK_RULE.test(unquoteLine(l).trim()) || HEADER_LINE.test(unquoteLine(l).trim())));
      lines = lines.slice(0, marker >= 0 ? marker : block.bodyStart);
      break;
    }
    forwarded = true;
    if (Object.keys(block.fields).length > 0) fields = block.fields;
    lines = lines.slice(block.bodyStart);
    weakAllowed = /^\s*(fwd?|fw)\s*:/i.test(block.fields.subject ?? '');
  }

  const history = replyHistoryStart(lines);
  if (history >= 0) lines = lines.slice(0, history);
  lines = stripSignature(stripQuotedLines(lines));
  const text = tidy(lines);

  let from: EmailEvidence['from'];
  let occurredAt: number | undefined;
  let subject: string | undefined;
  if (forwarded) {
    from = parseAddress(fields.from);
    occurredAt = parseMailDate(fields.date ?? fields.sent, offsetMinutesOf(outerDate));
    subject = fields.subject !== undefined ? stripSubjectPrefixes(fields.subject) : outerSubject ? stripSubjectPrefixes(outerSubject) : undefined;
  } else {
    const name = raw.from?.name?.trim();
    const address = raw.from?.address?.trim().toLowerCase();
    from = raw.from ? { ...(name ? { name } : {}), ...(address ? { handle: address } : {}) } : parseAddress(headers.from);
    if (from && !from.name && !from.handle) from = undefined;
    occurredAt = parseMailDate(outerDate);
    subject = outerSubject;
  }

  return {
    text,
    ...(subject !== undefined && subject !== '' ? { subject } : {}),
    ...(from ? { from } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    forwarded,
    ...(unfollowedForward ? { unfollowedForward } : {}),
    headers,
  };
}
