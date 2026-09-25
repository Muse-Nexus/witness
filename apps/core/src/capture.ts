/**
 * One capture pipeline for REST, MCP and inbound email (SPEC §8):
 * blocked sender -> dedupe -> detector (+ optional model judge) -> encrypt -> store.
 *
 * Dedupe keys are keyed per user (SPEC §7, "witness:dedupe:v1"). Words with no source id
 * are keyed on who said them and the person's local day too, so the same words from two
 * people, or on two days, are two items; the same words from the same sender arriving by
 * two paths around the same time count once. Token callers (devices and
 * assistants) are never told "duplicate": they hear what the detector made of their
 * text, so a leaked capture-only key cannot test whether a message is already kept.
 *
 * Excluded captures store nothing but an inbound_events row. Nothing here logs
 * or returns message text beyond the kept quote.
 */
import {
  CATEGORIES,
  MAX_TEXT_CHARS,
  anthropicJudge,
  dedupeKey,
  normalizeForDedupe,
  detect,
  detectWithModel,
  extractEmailEvidence,
  type Candidate,
  type Category,
  type Channel,
  type ModelJudge,
  type Verdict,
} from '@witness/detector';
import { sha256Hex, type Keyring } from './crypto.js';
import { showableDate } from './dates.js';
import type { AppEnv, Config } from './env.js';
import { discardMedia, putMedia, removeItems, type ImageType } from './media.js';
import { isUniqueViolation, newId, type EventOutcome, type ItemKind, type ItemStatus, type SourceType } from './store/db.js';
import { recordEvent } from './store/events.js';
import { isValidTimeZone, zonedParts } from './rhythm.js';
import {
  SAID_KEY_PREFIX,
  crossPathCandidates,
  fillSender,
  findByDedupeKeys,
  insertItem,
  itemsByOlderKeys,
  keepUnderSourceKey,
  sayingsNear,
  type ItemRow,
  type SayingRow,
} from './store/items.js';
import { isBlocked } from './store/senders.js';
import { AccountGone, getUserById } from './store/users.js';

export interface CaptureInput {
  sourceType: SourceType;
  text?: string | null;
  subject?: string | null;
  fromName?: string | null;
  fromHandle?: string | null;
  occurredAt?: number | null;
  sourceRef?: string | null;
  sourceLabel?: string | null;
  threadKind?: 'direct' | 'group';
  /** Optional note kept with the item (manual adds, agents). */
  context?: string | null;
  /** Lowercased email headers, for the detector's header exclusions. */
  headers?: Record<string, string>;
  /** Email text already went through extractEmailEvidence (inbound mail does this itself). */
  emailExtracted?: boolean;
  image?: { bytes: Uint8Array; type: ImageType } | null;
  /** Session owner's own add: always saved, whole text kept as the quote. */
  manual?: boolean;
  /** Image from a source the person marked trusted (v1: Photos favorites from the Mac helper). */
  trustedImage?: boolean;
  /**
   * The text was read out of the attached image on the person's device (OCR: the iPhone
   * shortcut's "Extract Text from Image"), not typed or copied. It is scored as `ocr` by the
   * rules alone (never sent to the model judge: it is everything on the screen), a kept quote
   * is labeled "Text read from the image", always kept with the image, and waits in maybe
   * (the read-out text does not say whose message bubble each line was in, so it may be the
   * person's own words), and when the words are not evidence the image is kept alone (never
   * the whole read-out text).
   */
  textFromImage?: boolean;
  /** Never saved without review: a verdict that would save lands in maybe instead. */
  reviewOnly?: boolean;
  /**
   * The person chose to keep this (an assistant add they asked for, a share-sheet send, a
   * message they forwarded to their Witness address themself): never thrown away as "not
   * evidence". It is saved only when the detector itself says save; anything else waits in
   * maybe (what the detector would exclude is kept whole, or as the image alone), except
   * violence, threats, self-harm and goodbyes (a `harm:` exclusion), which are never kept.
   * Maybe is never delivered or offered (SPEC §8, "Person-chosen").
   */
  personChosen?: boolean;
  /**
   * The caller is a device or assistant token: a duplicate is answered like a new capture
   * (the detector's status, no id), so the answer never reveals what is already kept.
   */
  neutralDuplicates?: boolean;
  /** Category chosen by the person (manual adds). */
  category?: Category;
  /** Only the start of the source was read (an email's HTML past its limit): kept from nothing. */
  truncatedSource?: boolean;
}

export type CaptureStatus = 'saved' | 'maybe' | 'excluded' | 'duplicate' | 'blocked';

export interface CaptureResult {
  status: CaptureStatus;
  id?: string;
  /** Left out when nothing sorted it: the detector did not keep the words and the person chose no kind. */
  category?: Category;
  quote?: string;
  /** Rule id for excluded captures (never message text). */
  reason?: string;
}

export interface CaptureDeps {
  env: AppEnv;
  cfg: Config;
  keyring: Keyring;
  now: number;
  judge?: ModelJudge | null;
}

export { MAX_TEXT_CHARS };
/** What the API says when text runs past MAX_TEXT_CHARS. */
export const TOO_LONG_MESSAGE = `That is longer than Witness keeps. Text can be up to ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`;
/** An email subject is read, and kept as the item's context, whole or not at all. */
export const MAX_SUBJECT_CHARS = 500;
const MAX_LABEL_CHARS = 80;
/** Added to the source label of a quote read out of an image, so it never passes for typed words. */
export const TEXT_FROM_IMAGE_LABEL = 'Text read from the image';
/**
 * The stored category of an item nothing sorted: the detector did not keep its words (or it
 * has none) and the person chose no kind. Shown as no kind at all, never as "Other".
 */
export const UNSORTED = '';

const CHANNEL_BY_SOURCE: Record<SourceType, Channel> = {
  email: 'email',
  text: 'text',
  photo: 'ocr',
  screenshot: 'ocr',
  manual: 'manual',
  agent: 'agent',
  import: 'text',
};

export const DEFAULT_SOURCE_LABELS: Record<SourceType, string> = {
  email: 'Email',
  text: 'Text message',
  photo: 'Photo',
  screenshot: 'Screenshot',
  manual: 'Added by you',
  agent: 'Added by an assistant',
  import: 'Import',
};

/** The model judge, when WITNESS_JUDGE=anthropic and a key is set. */
export function createJudge(env: AppEnv, cfg: Config): ModelJudge | null {
  if (cfg.judge !== 'anthropic' || !env.ANTHROPIC_API_KEY) return null;
  return anthropicJudge({ apiKey: env.ANTHROPIC_API_KEY, model: cfg.model });
}

function clean(value: string | null | undefined, max: number): string | undefined {
  const v = value?.replace(/\u0000/g, '').trim();
  return v ? v.slice(0, max) : undefined;
}

/** The person's calendar day for an instant ("2026-09-24"), in their own time zone. */
export function calendarDay(instant: number, timeZone: string): string {
  const p = zonedParts(instant, isValidTimeZone(timeZone) ? timeZone : 'UTC');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Who said something, for dedupe: their sender key, else their name, else nobody known. */
function speakerOf(senderKey: string | null, fromName: string | null | undefined): string {
  if (senderKey) return `k:${senderKey}`;
  const name = fromName ? normalizeForDedupe(fromName) : '';
  return name ? `n:${name}` : '-';
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** The category for an answer: only when something sorted it. */
function sorted(category: string): { category?: Category } {
  return isCategory(category) ? { category } : {};
}

function sourceLabelFor(input: CaptureInput, quote: string): string {
  const label = clean(input.sourceLabel, MAX_LABEL_CHARS) ?? DEFAULT_SOURCE_LABELS[input.sourceType];
  return input.textFromImage && quote ? `${label} · ${TEXT_FROM_IMAGE_LABEL}` : label;
}

/**
 * For the two-path merge: senders that could be one person. Two handles are compared, else
 * two names. A copy that says nothing about who said it (a phone share with no name) could be
 * anyone's, so it merges, and the merge fills in who said it (fillSender). A name on one side
 * and only a handle on the other cannot be compared: they stay two items, because crediting a
 * name to the wrong handle would block, or delete, the wrong person's words.
 */
function couldBeSameSender(a: { senderKey: string | null; name: string | null }, b: { senderKey: string | null; name: string | null }): boolean {
  if (a.senderKey && b.senderKey) return a.senderKey === b.senderKey;
  const nameA = a.name ? normalizeForDedupe(a.name) : '';
  const nameB = b.name ? normalizeForDedupe(b.name) : '';
  if (nameA !== '' && nameB !== '') return nameA === nameB;
  return (!a.senderKey && nameA === '') || (!b.senderKey && nameB === '');
}

/** "2026-09-24" moved by whole days. */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/**
 * Whether an item kept under an older key is this same saying: same sender, same local day.
 * The sender is the one its key was made with, when that can be told: a share that said nobody
 * may since have been told who said it (a Mac copy's handle, a name set in the app), and it is
 * still the share it was. `keyedAsSaid` holds this saying's keys on the days either side of
 * `said.day`, the only days a key made in another time zone can hold.
 */
async function sameSaying(
  keyring: Keyring,
  userId: string,
  row: SayingRow,
  said: { speaker: string; day: string; timeZone: string },
  keyedAsSaid: ReadonlySet<string>,
): Promise<boolean> {
  if (calendarDay(row.occurred_at ?? row.created_at, said.timeZone) !== said.day) return false;
  if (keyedAsSaid.has(row.dedupe_key)) return true;
  const name = row.sender_key ? null : await keyring.decryptOptional(userId, row.from_name_ct);
  return speakerOf(row.sender_key, name) === said.speaker;
}

export async function capture(deps: CaptureDeps, userId: string, input: CaptureInput): Promise<CaptureResult> {
  const { env, keyring, now } = deps;
  const db = env.DB;
  const event = (outcome: EventOutcome, reason?: string) =>
    recordEvent(db, { userId, sourceType: input.sourceType, outcome, reason: reason ?? null, now });

  let text = (input.text ?? '').replace(/\u0000/g, '');
  let subject = input.subject?.replace(/\u0000/g, '').trim() || undefined;
  let fromName = clean(input.fromName, 200);
  let fromHandle = clean(input.fromHandle, 320);
  let occurredAt = input.occurredAt ?? undefined;
  let headers = input.headers;

  // Email pasted or sent over REST gets the same treatment inbound mail gets.
  if (input.sourceType === 'email' && !input.emailExtracted && text.trim() !== '') {
    const extracted = extractEmailEvidence({
      text,
      ...(subject ? { subject } : {}),
      ...(fromName || fromHandle ? { from: { ...(fromName ? { name: fromName } : {}), ...(fromHandle ? { address: fromHandle } : {}) } } : {}),
      headers: headers ?? {},
    });
    text = extracted.text;
    subject = extracted.subject ?? subject;
    fromName = extracted.from?.name ?? fromName;
    fromHandle = extracted.from?.handle ?? fromHandle;
    occurredAt = occurredAt ?? extracted.occurredAt;
    headers = extracted.headers;
  }
  // The API checks the dates it is given; this also covers dates read out of mail. One that
  // no formatter can show is kept as unknown, never stored to break what shows it later.
  occurredAt = showableDate(occurredAt) ?? undefined;
  // Never cut to fit: a verdict on the start of a message could keep words whose ending
  // (a threat, a "but") was never read. The API refuses longer text; mail is excluded.
  if (text.length > MAX_TEXT_CHARS || (subject?.length ?? 0) > MAX_SUBJECT_CHARS || input.truncatedSource) {
    await event('excluded', 'too_long');
    return { status: 'excluded', reason: 'too_long' };
  }
  const hasText = text.trim() !== '';
  const image = input.image ?? null;
  if (!hasText && !image) {
    await event('excluded', 'empty');
    return { status: 'excluded', reason: 'empty' };
  }

  // 1. "Never save from this sender".
  const senderKey = fromHandle ? await keyring.senderKeyFor(userId, fromHandle) : null;
  if (senderKey && (await isBlocked(db, userId, senderKey))) {
    await event('excluded', 'blocked_sender');
    return { status: 'blocked' };
  }

  // 2. Dedupe. With a source id, on the id. Words without one, on the words, who said them
  // and the person's local day (SAID_KEY_PREFIX): the same words from two people, or on two
  // birthdays, are two items. Image-only captures without a source id, on the image bytes.
  // Text read out of an image dedupes on the image: two screenshots that read the same (a
  // clock, a label) are two, and it never merges with the same words sent as text.
  const byImage = !hasText || (input.textFromImage === true && image !== null);
  const sourceRef = clean(input.sourceRef, 500);
  const normalizedText = hasText && !byImage ? normalizeForDedupe(text) : null;
  const textKey = normalizedText !== null ? await keyring.dedupeKeyFor(userId, input.sourceType, normalizedText) : null;
  const imageBasis = byImage ? `image:${await sha256Hex(image!.bytes)}` : null;
  let said: { speaker: string; day: string; timeZone: string } | null = null;
  let key: string;
  if (sourceRef) {
    key = await keyring.dedupeKeyFor(userId, input.sourceType, sourceRef);
  } else if (normalizedText !== null) {
    const timeZone = (await getUserById(db, userId))?.timezone ?? 'UTC';
    said = { speaker: speakerOf(senderKey, fromName), day: calendarDay(occurredAt ?? now, timeZone), timeZone };
    key = SAID_KEY_PREFIX + (await keyring.dedupeKeyFor(userId, input.sourceType, `said|${said.speaker}|${said.day}|${normalizedText}`));
  } else {
    key = await keyring.dedupeKeyFor(userId, input.sourceType, imageBasis!);
  }
  // Rows written before keyed dedupe carry a plain SHA-256; match those too.
  const legacyKey = await dedupeKey(input.sourceType, { sourceRef: sourceRef ?? null, text: imageBasis ?? text });
  let duplicate = false;
  let existing: Pick<ItemRow, 'id' | 'status' | 'media_key'> | null = await findByDedupeKeys(db, userId, said ? [key] : [key, legacyKey]);
  if (!existing && said) {
    // Kept before who and when were part of the key (under the words alone), or keyed on a
    // day in the time zone the person had then: the same saying only when it is the same
    // sender on the same local day, counted in the zone they have now.
    const older = [...(await itemsByOlderKeys(db, userId, [textKey!, legacyKey])), ...(await sayingsNear(db, userId, { textKey: textKey!, at: occurredAt ?? now }))];
    const keyedAsSaid = new Set<string>();
    if (older.length > 0) {
      for (const day of [shiftDay(said.day, -1), shiftDay(said.day, 1)]) {
        keyedAsSaid.add(SAID_KEY_PREFIX + (await keyring.dedupeKeyFor(userId, input.sourceType, `said|${said.speaker}|${day}|${normalizedText}`)));
      }
    }
    for (const row of older) {
      if (await sameSaying(keyring, userId, row, said, keyedAsSaid)) {
        existing = row;
        break;
      }
    }
  }
  if (existing && input.manual && existing.status === 'removed') {
    // Removed from a delivery before removing meant deleting: the person is adding it back.
    await removeItems(env, userId, [existing], now);
  } else if (existing) {
    duplicate = true;
  } else if (textKey) {
    // The same words by the other path around the same time, unless the senders differ.
    for (const row of await crossPathCandidates(db, userId, { textKey, hasSourceRef: sourceRef !== undefined, at: occurredAt ?? now })) {
      const name = await keyring.decryptOptional(userId, row.from_name_ct);
      if (couldBeSameSender({ senderKey, name: fromName ?? null }, { senderKey: row.sender_key, name })) {
        duplicate = true;
        // This copy may say who the kept one does not (the Mac's handle for a phone share).
        await fillSender(db, userId, row.id, {
          senderKey: row.sender_key ? null : senderKey,
          fromNameCt: row.sender_key || name ? null : await keyring.encryptOptional(userId, fromName),
        });
        // A kept item with no id takes in one copy that has one, and is kept under that id from
        // now on: the next message with its own id is its own item.
        if (sourceRef) await keepUnderSourceKey(db, userId, row.id, row.dedupe_key, key);
        break;
      }
    }
  }
  if (duplicate && !input.neutralDuplicates) {
    await event('duplicate');
    return { status: 'duplicate' };
  }

  // 3. Decide.
  let status: ItemStatus;
  let quote = '';
  let verdict: Verdict | null = null;
  let category: Category | typeof UNSORTED = input.category ?? UNSORTED;
  if (hasText) {
    const candidate: Candidate = {
      text,
      channel: input.textFromImage ? 'ocr' : CHANNEL_BY_SOURCE[input.sourceType],
      ...(subject ? { subject } : {}),
      ...(fromName || fromHandle ? { from: { ...(fromName ? { name: fromName } : {}), ...(fromHandle ? { handle: fromHandle } : {}) } } : {}),
      ...(headers ? { headers } : {}),
      ...(input.threadKind ? { threadKind: input.threadKind } : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    };
    // Text read out of an image is whatever was on the screen (other people's messages, names,
    // numbers): the rules score it here, and it never goes to the model judge.
    verdict = deps.judge && !input.manual && !input.textFromImage ? await detectWithModel(candidate, deps.judge) : detect(candidate);
    // The detector's kind only when it kept the words: "Other" would be a guess.
    if (!input.category && verdict.decision !== 'exclude') category = verdict.category;
  }

  if (input.manual) {
    status = 'saved';
    quote = text.trim();
  } else if (verdict && verdict.decision !== 'exclude') {
    // Words read out of a screenshot always wait for the person: the phone reads every bubble
    // as one text, so the quote may be the person's own reply rather than the other person's.
    status = verdict.decision === 'save' && !input.reviewOnly && !input.textFromImage ? 'saved' : 'maybe';
    quote = verdict.quote;
  } else if (image && (!verdict || input.sourceType === 'photo' || (input.textFromImage && !verdict.excludedBy?.startsWith('harm:')))) {
    // A photo is worth keeping even when its text (a sign, a menu) is not evidence, and a
    // screenshot whose read-out text is not evidence is kept as the image the person sent.
    status = input.trustedImage ? 'saved' : 'maybe';
    quote = '';
  } else if (input.personChosen && hasText && !verdict?.excludedBy?.startsWith('harm:')) {
    // The person asked for this to be kept: it waits in maybe, whole, rather than being
    // dropped. Never saved: the detector did not say save. Violence, threats, self-harm and
    // goodbyes are the exception: they are never evidence, and only words the person adds by
    // hand themself skip that rule.
    status = 'maybe';
    quote = text.trim();
  } else {
    const reason = verdict?.excludedBy ?? 'below_threshold';
    await event(duplicate ? 'duplicate' : 'excluded', duplicate ? undefined : reason);
    return { status: 'excluded', reason };
  }

  if (duplicate) {
    // Same answer as a first capture of these words, minus an id: nothing is stored twice,
    // and nothing is revealed about what was already there.
    await event('duplicate');
    return { status, ...sorted(category), ...(quote ? { quote } : {}) };
  }

  // 4. Encrypt and store. Media first, so a row never points at a missing object.
  const id = newId();
  const kind: ItemKind = image ? (quote ? 'mixed' : 'image') : 'text';
  let mediaKeyValue: string | null = null;
  if (image) mediaKeyValue = await putMedia(env.MEDIA, keyring, userId, id, image.bytes, image.type);

  const row: ItemRow = {
    id,
    user_id: userId,
    status,
    kind,
    quote_ct: await keyring.encryptOptional(userId, quote),
    context_ct: await keyring.encryptOptional(userId, clean(input.context, 2000) ?? (input.sourceType === 'email' ? subject : undefined)),
    from_name_ct: await keyring.encryptOptional(userId, fromName),
    occurred_at: occurredAt ?? null,
    source_type: input.sourceType,
    source_label: sourceLabelFor(input, quote),
    dedupe_key: key,
    text_key: textKey,
    sender_key: senderKey,
    category: isCategory(category) ? category : UNSORTED,
    score: verdict ? Math.round(verdict.score * 1000) / 1000 : input.manual ? 1 : null,
    reasons: verdict ? JSON.stringify(verdict.reasons.map((r) => ({ rule: r.rule, weight: Math.round(r.weight * 1000) / 1000 }))) : null,
    media_key: mediaKeyValue,
    media_type: image ? image.type : null,
    edited: 0,
    created_at: now,
    updated_at: now,
    last_delivered_at: null,
    delivered_count: 0,
  };
  let stored: boolean;
  try {
    stored = await insertItem(db, row);
  } catch (error) {
    if (mediaKeyValue) await discardMedia(env, mediaKeyValue, now);
    if (!isUniqueViolation(error)) throw error;
    await event('duplicate');
    if (input.neutralDuplicates) return { status, ...sorted(row.category), ...(quote ? { quote } : {}) };
    return { status: 'duplicate' };
  }
  if (!stored) {
    // The account was deleted while this capture was under way: keep nothing, image included.
    if (mediaKeyValue) await discardMedia(env, mediaKeyValue, now);
    throw new AccountGone();
  }
  await event(status);
  return { status, id, ...sorted(row.category), ...(quote ? { quote } : {}) };
}
