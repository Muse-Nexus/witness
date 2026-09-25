/**
 * Turns a raw inbound email into the evidence the detector should look at:
 * the original sender's own words, without the forwarder's note, quoted reply
 * history or signatures.
 *
 * Handles manual forwards from Gmail, Outlook (desktop, web, older
 * "-----Original Message-----" style), Apple Mail and Thunderbird. When a
 * message was forwarded several times, the innermost (original) message wins.
 * Quote and forward headers are read in English, Spanish, French, German and
 * Portuguese, so the owner's own quoted words are never read as the replier's.
 * No dependencies: HTML is reduced to text with a small tag stripper, and quoted
 * HTML (<blockquote>) reads as "> " lines, the way a text part shows it.
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
  /**
   * Whether an address is one of the owner's. Given only for mail the owner sent in themself
   * (with `followForwards`): then the other messages of a thread they forwarded are returned
   * in `thread`, each credited to its own author, and the owner's own are left out.
   */
  isOwnerAddress?: (address: string) => boolean;
}

/** One message of a forwarded thread, other than the one `text` holds. */
export interface EmailThreadMessage {
  /** That message's own words, without its quoted history or signature. */
  text: string;
  /** Who wrote it, as the thread shows it. Always an address: a message nobody can place is left out. */
  from: { name?: string; handle: string };
  /** When the thread says it was written. Unknown stays unknown: never the time it was forwarded. */
  occurredAt?: number;
}

export interface EmailEvidence {
  text: string;
  subject?: string;
  from?: { name?: string; handle?: string };
  occurredAt?: number;
  forwarded: boolean;
  /** A forwarded-message block was present but not followed (`followForwards: false`). */
  unfollowedForward?: boolean;
  /**
   * Only the start of the message was read: it had no text part and its HTML ran past
   * MAX_HTML_CHARS. Nothing should be kept from it, since the rest was never read.
   */
  truncated?: boolean;
  /**
   * Every line of the words was quoted with ">", and `text` is those lines unquoted. Some
   * clients quote forwarded text this way, but it can just as well be quoted history (the
   * owner's own words, say), so who wrote it is uncertain: nothing that trusts the
   * person's choice should keep it on that basis alone.
   */
  quotedOnly?: boolean;
  headers: Record<string, string>;
  /**
   * Only with `isOwnerAddress`: the forwarded message is the owner's own (one of their
   * addresses, or their name). Its words are theirs, so they are never evidence.
   */
  fromOwner?: boolean;
  /**
   * Only with `isOwnerAddress`, for a forward the owner sent: the thread's other messages
   * from someone other than the owner (a middle forwarder's note, then the quoted history,
   * newest first). `pickFromThread` chooses among them.
   */
  thread?: EmailThreadMessage[];
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

const BLOCK_TAGS = 'p|div|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|pre|dd|dt';

/**
 * Where a <blockquote> opens and closes, each on a line of its own while the HTML is read.
 * NUL never survives into the text (it is dropped from the HTML first), so these cannot be
 * forged by a message.
 */
const QUOTE_OPEN = '\u0000quote+';
const QUOTE_CLOSE = '\u0000quote-';
/** Deeper quotes read as this many ">" marks: far past any real thread, and it keeps crafted nesting linear. */
const MAX_QUOTE_MARKS = 16;

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
  // Each search result is kept until `at` passes it, and a search that found nothing is never
  // run again: rescanning to the end on every pass is quadratic on many small blocks.
  let comment = -2;
  let block: RegExpExecArray | null = null;
  let blockAt = -2;
  while (at < html.length) {
    if (comment !== -1 && comment < at) comment = html.indexOf('<!--', at);
    if (blockAt !== -1 && blockAt < at) {
      opener.lastIndex = at;
      block = opener.exec(html);
      blockAt = block ? block.index : -1;
    }
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
  let s = dropHiddenBlocks((html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html).replace(/\u0000/g, ''))
    .replace(/<br\s*\/?>/gi, '\n')
    // Outlook draws a rule above the header of the message it forwards or quotes.
    .replace(/<hr\b[^<>]*>/gi, '\n________________________________\n')
    // Quoted history (Gmail's blockquote.gmail_quote, Apple Mail's blockquote type="cite").
    .replace(/<blockquote\b[^<>]*>/gi, `\n${QUOTE_OPEN}\n`)
    .replace(/<\/blockquote\s*>/gi, `\n${QUOTE_CLOSE}\n`)
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^<>]*>`, 'gi'), '\n');
  s = decodeEntities(stripTags(s))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ');
  // Each line inside a blockquote reads as quoted, one ">" per level, so quoted words are
  // handled exactly as in a text part: never read as the sender's own.
  let depth = 0;
  const lines: string[] = [];
  let lastWords = -1; // index of the last line with words in it
  const marks = () => '>'.repeat(Math.min(depth, MAX_QUOTE_MARKS));
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (line === QUOTE_OPEN) {
      depth += 1;
      // The line just before a quote that ends in ":" introduces it ("Il giorno … ha scritto:",
      // Gmail's gmail_attr): it belongs to the quote, in whatever language it is written.
      const intro = lastWords >= 0 ? lines[lastWords]! : '';
      if (intro.endsWith(':') && !intro.startsWith(marks())) {
        lines[lastWords] = `${marks()} ${intro.replace(/^>+ /, '')}`;
      }
    } else if (line === QUOTE_CLOSE) {
      depth = Math.max(0, depth - 1);
    } else {
      if (line !== '') lastWords = lines.length;
      lines.push(depth > 0 && line !== '' ? `${marks()} ${line}` : line);
    }
  }
  return lines
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
    if (token && Object.hasOwn(ZONES, token)) return ZONES[token];
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
  // "9:00 PM", and Spanish or Portuguese "9:00 p. m.".
  const timeMatch = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|[ap]\.\s?m\.?)?(?![a-z])/i.exec(s);
  const datePart = timeMatch ? s.slice(0, timeMatch.index) + ' ' + s.slice(timeMatch.index + timeMatch[0].length) : s;

  let month = -1;
  let monthWord = '';
  let months = 0;
  let unreadWords = 0;
  let day = -1;
  let year = -1;
  for (const token of datePart.split(/\s+/)) {
    const lower = token.toLowerCase().replace(/\.$/, '');
    if (/^[a-z]{3,9}$/.test(lower)) {
      const index = MONTHS.indexOf(lower.slice(0, 3));
      if (index >= 0 && (lower.length === 3 || lower === 'sept' || MONTH_NAMES[index] === lower)) {
        months += 1;
        if (month < 0) {
          month = index;
          monthWord = lower;
        }
        continue;
      }
    }
    // A word that is not an English month, weekday or zone ("déc", "dic", "juin", "janv").
    if (/^\p{L}{3,}$/u.test(lower) && !WEEKDAYS.has(lower) && !Object.hasOwn(ZONES, lower)) unreadWords += 1;
    if (/^\d{4}$/.test(lower) && year < 0) year = Number(lower);
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(lower) && day < 0) day = parseInt(lower, 10);
  }
  // Two words that read as months ("mar, 1 sept 2026" is a Spanish Tuesday): no guess.
  if (months > 1) return undefined;
  // "mar" is Tuesday in Spanish, French and Italian too. Beside a word that is not English
  // ("mar. 1 déc. 2026", "mar, 1 dic 2026") it is the weekday, and the month is one this
  // cannot read: unknown, never March.
  if (monthWord === 'mar' && unreadWords > 0) return undefined;
  if (month < 0 || day < 1 || day > 31 || year < 1970 || year > 2200) return undefined;

  let hour = 12;
  let minute = 0;
  let second = 0;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    second = timeMatch[3] ? Number(timeMatch[3]) : 0;
    const meridiem = timeMatch[4]?.toLowerCase().replace(/[.\s]/g, '');
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

/** English weekdays, as mail clients print them: with the months and zones, the only words in an English date. */
const WEEKDAYS: ReadonlySet<string> = new Set([
  'mon', 'tue', 'tues', 'wed', 'weds', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// ---------------------------------------------------------------------------
// Forwarded blocks, quoted replies, signatures
// ---------------------------------------------------------------------------

const unquoteLine = (line: string): string => line.replace(/^[\s>]*/, '');
/** One level of "> " quoting off, so a quoted message reads at its own level. */
const unquoteOnce = (line: string): string => line.replace(/^\s*>\s?/, '');

const STRONG_FORWARD = [
  /^-{3,}\s*Forwarded message\s*-{3,}\s*$/i, // Gmail
  /^-{3,}\s*(Mensaje reenviado|Message transféré|Weitergeleitete Nachricht|Mensagem encaminhada)\s*-{3,}\s*$/i, // Gmail in Spanish, French, German, Portuguese
  /^Begin forwarded message:\s*$/i, // Apple Mail
  /^Anfang der weitergeleiteten Nachricht\s*:\s*$/i, // Apple Mail in German
  /^-{3,}\s*Forwarded Message\s*-{3,}\s*$/i, // Thunderbird
];
const ORIGINAL_MESSAGE = /^-{2,}\s*(Original Message|Mensaje original|Message d'origine|Ursprüngliche Nachricht|Mensagem original)\s*-{2,}\s*$/i;
const OUTLOOK_RULE = /^_{10,}\s*$/;
/** Subject prefixes for a forward: English, Spanish (RV), French (TR), German (WG), Portuguese (ENC). */
const FORWARD_SUBJECT = /^\s*(fwd?|fw|rv|tr|wg|enc)\s*:/i;

type HeaderField = 'from' | 'date' | 'sent' | 'subject' | 'to' | 'cc' | 'bcc' | 'reply-to';

/**
 * The labels mail clients print over a quoted or forwarded message, in English, Spanish,
 * French, German and Portuguese ("De:", "Enviado:", "Envoyé :", "Von:", "Gesendet:"…).
 */
const HEADER_LABELS: Readonly<Record<string, HeaderField>> = {
  from: 'from', de: 'from', von: 'from',
  date: 'date', fecha: 'date', datum: 'date', data: 'date',
  sent: 'sent', enviado: 'sent', enviada: 'sent', envoyé: 'sent', gesendet: 'sent',
  subject: 'subject', asunto: 'subject', objet: 'subject', betreff: 'subject', assunto: 'subject',
  to: 'to', para: 'to', à: 'to', an: 'to',
  cc: 'cc', bcc: 'bcc', cco: 'bcc', cci: 'bcc',
  'reply-to': 'reply-to',
};
const HEADER_LABEL_SHAPE = /^\**[^\s:*]{1,16}\**\s*:/;
/**
 * The label and colon only. The value is the rest of the line, trimmed by hand: a pattern that
 * has to find the end of the line (`(.*?)\s*$`) backtracks quadratically on a long run of
 * spaces, and every line that starts like "From:" is read this way.
 */
const HEADER_LABEL = /^\**([a-zà-ÿ-]{1,12})\**\s*:/i;

const isSpaceOrStar = (c: string): boolean => c === '*' || /\s/.test(c);

/**
 * NFC for the short strings it matters for (labels, intros, names). Normalizing reorders runs of
 * combining marks, which is quadratic on a hostile line, so anything longer is left as it is.
 */
const MAX_NFC_CHARS = 512;
const nfc = (s: string): string => (s.length <= MAX_NFC_CHARS ? s.normalize('NFC') : s);

/** `s` without the spaces and bold marks ("*") at either end, in one linear pass. */
function trimSpacesAndStars(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSpaceOrStar(s[start]!)) start += 1;
  while (end > start && isSpaceOrStar(s[end - 1]!)) end -= 1;
  return s.slice(start, end);
}

/** "From: …", "De : …", "*Von:* …" as a header field and its value, or null. */
function headerLine(line: string): { field: HeaderField; value: string } | null {
  const trimmed = line.trim();
  if (!HEADER_LABEL_SHAPE.test(trimmed)) return null; // cheap test before normalizing a long line
  const normalized = nfc(trimmed);
  const m = HEADER_LABEL.exec(normalized) ?? HEADER_LABEL.exec(trimmed.slice(0, 40).normalize('NFC'));
  const field = m ? HEADER_LABELS[m[1]!.toLowerCase()] : undefined;
  if (!field) return null;
  const colon = normalized.indexOf(':');
  return { field, value: trimSpacesAndStars(normalized.slice(colon + 1)) };
}

interface HeaderBlock {
  fields: Record<string, string>;
  /** Index of the line that opens the block (a marker, a rule, or the first header). */
  markerAt: number;
  /** Index of the first body line after the header block. */
  bodyStart: number;
}

function parseHeaderBlock(lines: readonly string[], start: number, markerAt = start): HeaderBlock | null {
  let i = start;
  while (i < lines.length && unquoteLine(lines[i]!).trim() === '') i += 1;
  const fields: Record<string, string> = {};
  let last: HeaderField | null = null;
  for (; i < lines.length; i += 1) {
    const line = unquoteLine(lines[i]!);
    if (line.trim() === '') break;
    const header = headerLine(line);
    if (header) {
      last = header.field;
      fields[last] = header.value;
    } else if (last === 'to' || last === 'cc' || last === 'bcc') {
      fields[last] = `${fields[last]} ${line.trim()}`; // wrapped recipient list
    } else {
      break;
    }
  }
  if (!fields.from) return null;
  return { fields, markerAt, bodyStart: i };
}

/** True when line `i` starts an Outlook-style header block ("From:" then "Sent:"/"Date:" soon after, in any language above). */
function isOutlookHeaderStart(lines: readonly string[], i: number): boolean {
  if (headerLine(unquoteLine(lines[i]!))?.field !== 'from') return false;
  for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
    const field = headerLine(unquoteLine(lines[j]!))?.field;
    if (field === 'sent' || field === 'date') return true;
  }
  return false;
}

const isBlank = (lines: readonly string[], from: number, to: number): boolean =>
  lines.slice(from, to).every((l) => unquoteLine(l).trim() === '');

/**
 * Finds the first forwarded-message header. Strong markers ("Forwarded
 * message", "Begin forwarded message:") always count. Outlook-style blocks
 * are also used for replies, so they count only when `weakAllowed` (the subject
 * says "Fwd"/"FW"/"RV"/"TR"/"WG"/"ENC") or nothing but blank lines comes before them.
 */
function findForward(lines: readonly string[], weakAllowed: boolean): HeaderBlock | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = unquoteLine(lines[i]!).trim();
    if (STRONG_FORWARD.some((re) => re.test(line))) {
      return parseHeaderBlock(lines, i + 1, i) ?? { fields: {}, markerAt: i, bodyStart: i + 1 };
    }
    const weakMarker = ORIGINAL_MESSAGE.test(line) || (OUTLOOK_RULE.test(line) && isOutlookHeaderStart(lines, nextNonBlank(lines, i + 1)));
    const bareHeader = !weakMarker && isOutlookHeaderStart(lines, i);
    if (weakMarker || bareHeader) {
      if (!weakAllowed && !isBlank(lines, 0, i)) return null; // a reply, not a forward
      return parseHeaderBlock(lines, weakMarker ? i + 1 : i, i);
    }
  }
  return null;
}

function nextNonBlank(lines: readonly string[], from: number): number {
  let i = from;
  while (i < lines.length - 1 && unquoteLine(lines[i]!).trim() === '') i += 1;
  return Math.min(i, lines.length - 1);
}

/**
 * The line a mail client puts over a quoted reply, in English, Spanish, French, German and
 * Portuguese: "On … wrote:", "El … escribió:", "Le … a écrit :", "Am … schrieb …:",
 * "Em … escreveu:". An opener, a closing phrase at the very end, and at most
 * MAX_INTRO_CHARS in all: each test is linear, whatever a line holds.
 */
const REPLY_INTROS: readonly (readonly [RegExp, RegExp])[] = [
  [/^On\b/i, /\bwrote:\s*$/i],
  [/^El\b/i, /\bescribió\s*:\s*$/i],
  [/^Le\b/i, /\ba\s+écrit\s*:\s*$/i],
  [/^Am\b/i, /\bschrieb\b[^:]*:\s*$/i],
  [/^Em\b/i, /\bescreveu\s*:\s*$/i],
];
const MAX_INTRO_CHARS = 400;
const REPLY_INTRO_OPENER = /^(On|El|Le|Am|Em)\b/i;
const isReplyIntro = (raw: string): boolean => {
  if (raw.length > MAX_INTRO_CHARS) return false; // checked before normalizing, which is quadratic on hostile marks
  const line = raw.normalize('NFC');
  return /:\s*$/.test(line) && REPLY_INTROS.some(([opener, closer]) => opener.test(line) && closer.test(line));
};

/**
 * How many lines the reply intro at line `i` takes (Gmail wraps long ones), or 0 when there is
 * none. An intro that starts on a later line is never joined to the words above it ("On Monday
 * I will ask Sam <sam@…>" over "On 9/5/26 9:00 AM, Mark wrote:"), so the author of a quote is
 * never read from someone's own line.
 */
function introAt(lines: readonly string[], i: number): number {
  const line = unquoteLine(lines[i]!).trim();
  if (!REPLY_INTRO_OPENER.test(line)) return 0;
  if (isReplyIntro(line)) return 1;
  // A wrapped intro starts with its date ("On Fri, Sep 5, 2026 at…"): a line with no digit is
  // someone's own sentence ("On Monday I will ask Sam <sam@…>"), never joined to the intro below.
  if (/[.!?]$/.test(line) || !/\d/.test(line)) return 0;
  const next = unquoteLine(lines[i + 1] ?? '').trim();
  if (next === '' || isReplyIntro(next)) return 0;
  if (isReplyIntro(`${line} ${next}`)) return 2;
  const after = unquoteLine(lines[i + 2] ?? '').trim();
  if (after === '' || isReplyIntro(after) || isReplyIntro(`${next} ${after}`)) return 0;
  return isReplyIntro(`${line} ${next} ${after}`) ? 3 : 0;
}

/** Index of the first "On <date>, <name> wrote:" line (possibly wrapped, in any language above), or -1. */
function replyIntroIndex(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i += 1) if (introAt(lines, i) > 0) return i;
  return -1;
}

/**
 * Index of the first line of quoted reply history, or -1. A bare header block on the very
 * first line is a forward's header in a message's own body (findForward reads it there), but
 * inside a quoted message (`atStart`) it is that message's history: a message that quotes
 * another with no words of its own (Outlook for Mac draws no rule) has nothing before it.
 */
function replyHistoryStart(lines: readonly string[], atStart = false): number {
  const intro = replyIntroIndex(lines);
  for (let i = 0; i < lines.length; i += 1) {
    if (i === intro) return i;
    const line = lines[i]!.trim();
    if (ORIGINAL_MESSAGE.test(line)) return i;
    if (OUTLOOK_RULE.test(line) && i + 1 < lines.length && isOutlookHeaderStart(lines, nextNonBlank(lines, i + 1))) return i;
    if ((i > 0 || atStart) && isOutlookHeaderStart(lines, i)) return i;
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

/** How many ">" marks quote a line (spaces between them aside). */
function quoteDepth(line: string): number {
  let depth = 0;
  for (const c of line) {
    if (c === '>') depth += 1;
    else if (c !== ' ' && c !== '\t') break;
  }
  return depth;
}

/**
 * A message's own lines. `base` is the quote level its forwarded header sat at (Apple Mail's
 * HTML puts a whole forward, header and all, one level in): its own words are at that level,
 * and anything deeper is its quoted history, whatever language introduced it. When nothing is
 * left at its own level the message has no words of its own (a photo-only reply), and nothing
 * is kept: never the history, which is where the owner's own words would be.
 */
function stripQuotedLines(lines: string[], base = 0): string[] {
  const unquote = (l: string) => l.replace(/^\s*(>\s?)+/, '');
  if (base > 0) return lines.filter((l) => unquoteLine(l).trim() === '' || quoteDepth(l) === base).map(unquote);
  const unquoted = lines.filter((l) => !/^\s*>/.test(l));
  if (unquoted.some((l) => l.trim() !== '')) return unquoted;
  // Everything is quoted, with no header to say at what level (some clients quote a message
  // they pass on): keep the outermost level. If that opens with a line ending in ":", it is an
  // intro in a language this does not read ("Il giorno … ha scritto:"), so all of it is history.
  let top = Infinity;
  for (const l of lines) if (unquoteLine(l).trim() !== '') top = Math.min(top, quoteDepth(l));
  const outer = lines.filter((l) => unquoteLine(l).trim() === '' || quoteDepth(l) === top).map(unquote);
  const first = outer.find((l) => l.trim() !== '');
  return first !== undefined && /:\s*$/.test(first) ? [] : outer;
}

/** `line` without spaces and tabs at its end, by hand: `/[ \t]+$/` is quadratic on a long run of them. */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return line.slice(0, end);
}

const tidy = (lines: readonly string[]): string =>
  lines
    .map(trimLineEnd)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripSubjectPrefixes = (subject: string): string =>
  subject.replace(/^\s*((fwd?|fw|re|rv|tr|wg|aw|enc|res)\s*:\s*)+/i, '').trim();

// ---------------------------------------------------------------------------
// The rest of a thread the owner forwarded
// ---------------------------------------------------------------------------

/** A quoted message's own words: up to its own quoted history, without quoted lines or a signature. */
function ownWords(lines: string[]): string {
  const history = replyHistoryStart(lines, true);
  return tidy(stripSignature(stripQuotedLines(history >= 0 ? lines.slice(0, history) : lines)));
}

type Author = { name?: string; handle?: string } | undefined;

/**
 * A display name as the words in it, for telling whether two names are one person: case,
 * punctuation, quotes and initials aside ("Mark D. Matthews", "Matthews, Mark", "mark matthews").
 */
function nameWords(name: string): string[] {
  return [...new Set(nfc(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))].sort();
}

/**
 * The same words (initials, case, punctuation and order aside). A name with an extra word is
 * someone else: "Ann Matthews" is not "Mary Ann Matthews", and a relative is never the owner.
 */
function sameName(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * A mailing list that rewrites the sender ("'Rosa Vega' via Parents <parents@…>", as Google
 * Groups and DMARC-minded lists do) shows its own address, not the author's.
 */
const LIST_REWRITTEN = /\svia\s+\S/; // lower-case "via": a surname "Via" is a person

/** Who counts as the owner in a thread they forwarded. */
interface Owner {
  /** The thread shows this author is the owner: one of their addresses, or their name. */
  is(from: Author): boolean;
  /** A message from this author is left out: the owner's, or one nobody can place by its own address. */
  leavesOut(from: Author): boolean;
  /**
   * The author is the owner by what the owner's own mail says: the address they forwarded from,
   * a registered address, or the name on their mail. Never by an address read out of the thread.
   */
  isForSure(from: Author): boolean;
  /** The one person the forwarded message was sent to: the owner, under whatever address. */
  receivedAs(block: Record<string, string>): void;
}

function ownerOf(raw: RawEmail, isOwnerAddress: (address: string) => boolean): Owner {
  const ownWordsOfName = raw.from?.name ? nameWords(raw.from.name) : [];
  const names: string[][] = ownWordsOfName.length > 0 ? [ownWordsOfName] : [];
  const own = raw.from?.address?.toLowerCase();
  // Addresses the thread shows the owner received mail at (receivedAs): good enough to leave the
  // owner's quoted words out of a thread, never to throw away the forwarded message itself.
  const received = new Set<string>();
  const byName = (from: Author): boolean => {
    if (!from?.name) return false;
    // "'Mark Matthews' via Parents" is Mark Matthews, as far as a name tells.
    const via = LIST_REWRITTEN.exec(from.name);
    const words = nameWords(via ? from.name.slice(0, via.index) : from.name);
    return names.some((owner) => sameName(owner, words));
  };
  const isForSure = (from: Author): boolean => {
    const handle = from?.handle?.toLowerCase();
    if (handle && (handle === own || isOwnerAddress(handle))) return true;
    return byName(from);
  };
  const is = (from: Author): boolean => isForSure(from) || (!!from?.handle && received.has(from.handle.toLowerCase()));
  return {
    is,
    isForSure,
    leavesOut: (from) => !from?.handle || (!!from.name && LIST_REWRITTEN.test(from.name)) || is(from),
    receivedAs: (block) => {
      // Only a message sent to one address, with no copies, and not to its own sender (a list, or
      // mail sent to oneself with everyone blind-copied), shows where the owner received it.
      const to = block.to;
      if (!to || to.split('@').length !== 2 || block.cc || block.bcc) return;
      const author = parseAddress(block.from);
      const recipient = parseAddress(to);
      if (!recipient?.handle || recipient.handle === author?.handle?.toLowerCase()) return;
      if (author?.name && LIST_REWRITTEN.test(author.name)) return;
      received.add(recipient.handle);
    },
  };
}

function threadMessage(owner: Owner, text: string, from: Author, occurredAt: number | undefined): EmailThreadMessage | null {
  if (!text || !from?.handle || owner.leavesOut(from)) return null;
  return {
    text,
    from: { ...(from.name ? { name: from.name } : {}), handle: from.handle },
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

/**
 * A date as someone's mail client printed it. `zone` is the printer's UTC offset (undefined:
 * UTC), or null when their zone is unknown: then a date that does not carry its own zone has
 * an unknown time, and is left unknown rather than read in someone else's zone.
 */
function printedDate(value: string | undefined, zone: number | null | undefined): number | undefined {
  if (zone === null && offsetMinutesOf(value) === undefined) return undefined;
  return parseMailDate(value, zone ?? undefined);
}

const INTRO_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|[ap]\.\s?m\.?|uhr)(?![a-z]))?/gi;

function lastMatch(s: string, re: RegExp): { index: number; groups: string[] } | null {
  let last: RegExpMatchArray | null = null;
  for (const m of s.matchAll(re)) last = m;
  return last ? { index: last.index ?? 0, groups: [...last] } : null;
}

/**
 * Who wrote a quoted message and when, from its intro ("On Fri, Sep 5, 2026 at 9:00 AM Rosa
 * Vega <rosa@example.com> wrote:"). No address, no author: the message is not credited.
 */
function introAuthor(intro: string, zone: number | null | undefined): { from?: { name?: string; handle: string }; occurredAt?: number } {
  const body = nfc(intro).replace(REPLY_INTRO_OPENER, '');
  const angle = lastMatch(body, /<\s*(?:mailto:)?([^\s<>@]+@[^\s<>]+?)\s*>/gi);
  const bare = angle ? null : lastMatch(body, /[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+\.[a-z]{2,}/gi);
  const address = angle ?? bare;
  if (!address) return {};
  const handle = (angle ? angle.groups[1]! : bare!.groups[0]!).toLowerCase();
  const before = body.slice(0, address.index);
  // The name follows the time ("… 9:00 AM Rosa Vega <…>", "… 09:00 Uhr schrieb Rosa Vega <…>"),
  // or the last comma when there is no time.
  const time = lastMatch(before, INTRO_TIME);
  const cut = time ? time.index + time.groups[0]!.length : before.lastIndexOf(',');
  const name = cut >= 0
    ? before.slice(cut).replace(/^[\s,]*(schrieb\s+)?/i, '').replace(/[\s,(]+$/, '').replace(/^["'“]+|["'”]+$/g, '').trim()
    : '';
  const occurredAt = cut > 0 ? printedDate(before.slice(0, cut), zone) : undefined;
  return {
    from: { ...(name && name.length <= 120 && !name.includes('@') ? { name } : {}), handle },
    ...(occurredAt !== undefined ? { occurredAt } : {}),
  };
}

/**
 * The author, date and first body line of the quoted message that starts at line `start`.
 * `zone`: that of the client that printed the intro or header (see printedDate).
 */
function quotedHead(lines: readonly string[], start: number, zone: number | null | undefined) {
  const span = introAt(lines, start);
  if (span > 0) {
    const intro = lines.slice(start, start + span).map((l) => unquoteLine(l).trim()).join(' ');
    return { ...introAuthor(intro, zone), bodyStart: start + span };
  }
  const line = unquoteLine(lines[start]!).trim();
  const block = parseHeaderBlock(lines, ORIGINAL_MESSAGE.test(line) || OUTLOOK_RULE.test(line) ? start + 1 : start);
  if (!block) return null;
  const from = parseAddress(block.fields.from);
  const occurredAt = printedDate(block.fields.sent ?? block.fields.date, zone);
  return { ...(from ? { from } : {}), ...(occurredAt !== undefined ? { occurredAt } : {}), bodyStart: block.bodyStart };
}

/**
 * The messages quoted under the forwarded one, newest first, each credited to its own author.
 * Each intro (or header) was printed by the client of whoever wrote the message it sits in
 * (`printer` for the first), and `zoneOf` says what zone that is.
 */
function historyMessages(owner: Owner, history: string[], printer: Author, zoneOf: (printer: Author) => number | null | undefined): EmailThreadMessage[] {
  const found: EmailThreadMessage[] = [];
  let rest = history;
  let printedBy = printer;
  for (let depth = 0; depth < 8; depth += 1) {
    const start = replyHistoryStart(rest, true);
    if (start < 0) break;
    const head = quotedHead(rest, start, zoneOf(printedBy));
    if (!head) break;
    const body = rest.slice(head.bodyStart).map(unquoteOnce);
    const message = threadMessage(owner, ownWords(body), head.from, head.occurredAt);
    if (message) found.push(message);
    printedBy = head.from;
    rest = body;
  }
  return found;
}

// ---------------------------------------------------------------------------
// extractEmailEvidence
// ---------------------------------------------------------------------------

export function extractEmailEvidence(raw: RawEmail): EmailEvidence {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.headers ?? {})) headers[k.toLowerCase()] = String(v);

  const hasTextPart = Boolean(raw.text && raw.text.trim() !== '');
  const plain = hasTextPart ? raw.text! : raw.html ? htmlToText(raw.html) : '';
  const truncated = !hasTextPart && raw.html !== undefined && raw.html.length > MAX_HTML_CHARS;
  let lines = plain.replace(/\r\n?/g, '\n').split('\n');

  const outerSubject = raw.subject ?? headers.subject;
  const outerDate = raw.date ?? headers.date;
  const fallbackOffset = offsetMinutesOf(outerDate);
  let forwarded = false;
  let fields: Record<string, string> = {};

  // Walk into nested forwards; the innermost message is the original.
  let weakAllowed = FORWARD_SUBJECT.test(outerSubject ?? '');
  const follow = raw.followForwards !== false;
  // For a forward the owner sent: the thread's other messages, credited to their own authors.
  const owner = follow && raw.isOwnerAddress ? ownerOf(raw, raw.isOwnerAddress) : null;
  const notes: EmailThreadMessage[] = [];
  // A date printed without a zone is read in the owner's zone (the outer Date's) only when the
  // owner's own mail client printed it; one printed by someone else's has an unknown time.
  const zoneOf = (printer: Author): number | null | undefined => (owner?.is(printer) ? fallbackOffset : null);
  // Whose client printed the header in `fields`: the owner's for the first forwarded block,
  // then, for each block inside it, whoever forwarded that block on.
  let fieldsPrintedBy: Author;
  let unfollowedForward = false;
  let forwardDepth = 0;
  for (let depth = 0; depth < 8; depth += 1) {
    // A forward marker inside quoted reply history belongs to the history.
    const intro = replyIntroIndex(lines);
    const block = findForward(intro >= 0 ? lines.slice(0, intro) : lines, weakAllowed);
    if (!block) break;
    if (!follow) {
      // Someone else's mail with a "forwarded" block inside: their own words end where it starts.
      unfollowedForward = true;
      lines = lines.slice(0, block.markerAt);
      break;
    }
    // The forwarded message went to the owner, under whatever address, unless the owner wrote
    // it: then it went to someone else, who is not the owner.
    if (owner && !forwarded && !owner.is(parseAddress(block.fields.from))) owner.receivedAs(block.fields);
    // Words before a nested forward are the note of whoever sent the block we are in.
    if (owner && forwarded) {
      const note = threadMessage(owner, ownWords(lines.slice(0, block.markerAt)), parseAddress(fields.from), printedDate(fields.date ?? fields.sent, zoneOf(fieldsPrintedBy)));
      if (note) notes.push(note);
    }
    fieldsPrintedBy = forwarded ? parseAddress(fields.from) : { ...(raw.from?.name ? { name: raw.from.name } : {}), ...(raw.from?.address ? { handle: raw.from.address } : {}) };
    forwarded = true;
    // The forwarded message's own words sit at the level its header does.
    forwardDepth = quoteDepth(lines[block.markerAt] ?? '');
    // A block whose header cannot be read has no known author (never the one around it).
    fields = block.fields;
    lines = lines.slice(block.bodyStart);
    weakAllowed = FORWARD_SUBJECT.test(block.fields.subject ?? '');
  }

  const history = replyHistoryStart(lines);
  const thread = owner && forwarded ? [...notes, ...(history >= 0 ? historyMessages(owner, lines.slice(history), parseAddress(fields.from), zoneOf) : [])] : [];
  if (history >= 0) lines = lines.slice(0, history);
  const quotedOnly = lines.some((l) => l.trim() !== '') && lines.every((l) => l.trim() === '' || /^\s*>/.test(l));
  lines = stripSignature(stripQuotedLines(lines, forwardDepth));
  const text = tidy(lines);

  let from: EmailEvidence['from'];
  let occurredAt: number | undefined;
  let subject: string | undefined;
  if (forwarded) {
    from = parseAddress(fields.from);
    // No date in the forwarded header: unknown, never the time it was forwarded. In a thread
    // the owner forwarded, a header a middle forwarder's client printed without a zone is
    // not read in the owner's zone either.
    occurredAt = owner ? printedDate(fields.date ?? fields.sent, zoneOf(fieldsPrintedBy)) : parseMailDate(fields.date ?? fields.sent, fallbackOffset);
    subject = fields.subject !== undefined ? stripSubjectPrefixes(fields.subject) : outerSubject ? stripSubjectPrefixes(outerSubject) : undefined;
  } else {
    const name = raw.from?.name?.trim();
    const address = raw.from?.address?.trim().toLowerCase();
    from = raw.from ? { ...(name ? { name } : {}), ...(address ? { handle: address } : {}) } : parseAddress(headers.from);
    if (from && !from.name && !from.handle) from = undefined;
    occurredAt = parseMailDate(outerDate);
    subject = outerSubject;
  }

  // The owner forwarded a message they wrote themself: its words are theirs, never evidence.
  // Only what the owner's own mail says counts here: an address read out of the thread could be
  // a list's or the sender's own, and would throw that person's words away.
  const fromOwner = owner !== null && forwarded && owner.isForSure(from);

  return {
    text,
    ...(subject !== undefined && subject !== '' ? { subject } : {}),
    ...(from ? { from } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    forwarded,
    ...(fromOwner ? { fromOwner } : {}),
    ...(unfollowedForward ? { unfollowedForward } : {}),
    ...(truncated ? { truncated } : {}),
    ...(quotedOnly ? { quotedOnly } : {}),
    headers,
    ...(thread.length > 0 ? { thread } : {}),
  };
}
