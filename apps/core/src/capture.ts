/**
 * One capture pipeline for REST, MCP and inbound email (SPEC §8):
 * blocked sender -> dedupe -> detector (+ optional model judge) -> encrypt -> store.
 *
 * Dedupe keys are keyed per user (SPEC §7, "witness:dedupe:v1"), and the same words
 * arriving by two paths around the same time count once. Token callers (devices and
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
import { crossPathDuplicate, findByDedupeKeys, insertItem, type ItemRow } from './store/items.js';
import { isBlocked } from './store/senders.js';
import { AccountGone } from './store/users.js';

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
  /** Never saved without review: a verdict that would save lands in maybe instead. */
  reviewOnly?: boolean;
  /**
   * The person chose to keep this (an assistant add they asked for, a share-sheet send, mail
   * they forwarded or wrote to their Witness address themself): never thrown away as "not
   * evidence". What the detector would exclude is kept, whole, in maybe, except violence,
   * threats, self-harm and goodbyes (a `harm:` exclusion), which are never kept.
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

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
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

  // 2. Dedupe. Image-only captures without a source id dedupe on the image bytes.
  const sourceRef = clean(input.sourceRef, 500);
  const normalizedText = hasText ? normalizeForDedupe(text) : null;
  const dedupeBasis = sourceRef ?? normalizedText ?? `image:${await sha256Hex(image!.bytes)}`;
  const key = await keyring.dedupeKeyFor(userId, input.sourceType, dedupeBasis);
  const textKey = normalizedText !== null ? await keyring.dedupeKeyFor(userId, input.sourceType, normalizedText) : null;
  // Rows written before keyed dedupe carry a plain SHA-256; match those too.
  const legacyKey = await dedupeKey(input.sourceType, { sourceRef: sourceRef ?? null, text: hasText ? text : dedupeBasis });
  let duplicate = false;
  const existing = await findByDedupeKeys(db, userId, [key, legacyKey]);
  if (existing && input.manual && existing.status === 'removed') {
    // Removed from a delivery before removing meant deleting: the person is adding it back.
    await removeItems(env, userId, [existing], now);
  } else if (existing) {
    duplicate = true;
  } else if (textKey && (await crossPathDuplicate(db, userId, { textKey, hasSourceRef: sourceRef !== undefined, at: occurredAt ?? now }))) {
    duplicate = true;
  }
  if (duplicate && !input.neutralDuplicates) {
    await event('duplicate');
    return { status: 'duplicate' };
  }

  // 3. Decide.
  let status: ItemStatus;
  let quote = '';
  let verdict: Verdict | null = null;
  let category: Category = input.category ?? 'other';
  if (hasText) {
    const candidate: Candidate = {
      text,
      channel: CHANNEL_BY_SOURCE[input.sourceType],
      ...(subject ? { subject } : {}),
      ...(fromName || fromHandle ? { from: { ...(fromName ? { name: fromName } : {}), ...(fromHandle ? { handle: fromHandle } : {}) } } : {}),
      ...(headers ? { headers } : {}),
      ...(input.threadKind ? { threadKind: input.threadKind } : {}),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
    };
    verdict = deps.judge && !input.manual ? await detectWithModel(candidate, deps.judge) : detect(candidate);
    if (!input.category) category = verdict.category;
  }

  if (input.manual) {
    status = 'saved';
    quote = text.trim();
  } else if (verdict && verdict.decision !== 'exclude') {
    status = verdict.decision === 'save' && !input.reviewOnly ? 'saved' : 'maybe';
    quote = verdict.quote;
  } else if (image && (!verdict || input.sourceType === 'photo')) {
    // A photo is worth keeping even when its text (a sign, a menu) is not evidence.
    status = input.trustedImage ? 'saved' : 'maybe';
    quote = '';
  } else if (input.personChosen && hasText && !verdict?.excludedBy?.startsWith('harm:')) {
    // The person asked for this to be kept: it waits in maybe, whole, rather than being dropped.
    // Violence, threats, self-harm and goodbyes are the exception: they are never evidence, and
    // only words the person adds by hand themself skip that rule.
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
    return { status, category: isCategory(category) ? category : 'other', ...(quote ? { quote } : {}) };
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
    source_label: clean(input.sourceLabel, MAX_LABEL_CHARS) ?? DEFAULT_SOURCE_LABELS[input.sourceType],
    dedupe_key: key,
    text_key: textKey,
    sender_key: senderKey,
    category: isCategory(category) ? category : 'other',
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
    if (input.neutralDuplicates) return { status, category: row.category as Category, ...(quote ? { quote } : {}) };
    return { status: 'duplicate' };
  }
  if (!stored) {
    // The account was deleted while this capture was under way: keep nothing, image included.
    if (mediaKeyValue) await discardMedia(env, mediaKeyValue, now);
    throw new AccountGone();
  }
  await event(status);
  return { status, id, category: row.category as Category, ...(quote ? { quote } : {}) };
}
