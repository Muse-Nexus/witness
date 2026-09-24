/**
 * Rhythm delivery (SPEC §8): the cron picks due rhythms, claims each one, picks
 * one saved item, and sends one email. If nothing qualifies, nothing is sent.
 * Also the delivery-link actions (keep, skip, pause, remove).
 */
import { signDeliveryToken, signMediaQuery, type DeliveryAction, type Keyring } from './crypto.js';
import { appLink, type AppEnv, type Config } from './env.js';
import { WITNESS_MAIL_HEADER, type Mailer } from './mail/index.js';
import { nextRunAt, parseDays, selectItem } from './rhythm.js';
import { newId } from './store/db.js';
import { createDelivery, previousDelivered, setDeliveryStatus, setFeedback, type DeliveryRow } from './store/deliveries.js';
import { removeItems } from './media.js';
import { blockSender } from './store/senders.js';
import { emailCanShow, getItem, markDelivered, selectionCandidates } from './store/items.js';
import {
  claimDelivery,
  claimRun,
  dueRhythms,
  getRhythm,
  releaseDelivery,
  setPause,
  setSkipNext,
  stopRhythm,
  type RhythmRow,
} from './store/rhythm.js';
import { getUserById, type UserRow } from './store/users.js';
import { attribution, formatLongDate, formatWeekday } from './templates/brand.js';
import { renderDeliveryEmail } from './templates/email.js';

export interface DeliveryDeps {
  env: AppEnv;
  cfg: Config;
  keyring: Keyring;
  mailer: Mailer;
  now: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const EMAIL_IMAGE_TTL_MS = 7 * DAY_MS;
export const PAUSE_A_WEEK_DAYS = 7;

export function scheduleOf(rhythm: RhythmRow) {
  return { localTime: rhythm.local_time, days: parseDays(rhythm.days), timeZone: rhythm.timezone };
}

/** The next run for a rhythm, respecting a pause that is still in effect. */
export function computeNextRun(rhythm: Pick<RhythmRow, 'enabled' | 'local_time' | 'days' | 'timezone' | 'paused_until'>, now: number): number | null {
  if (rhythm.enabled !== 1) return null;
  const from = rhythm.paused_until !== null && rhythm.paused_until > now ? rhythm.paused_until : now;
  return nextRunAt({ localTime: rhythm.local_time, days: parseDays(rhythm.days), timeZone: rhythm.timezone }, from);
}

/**
 * When the next delivery will actually arrive: the scheduled slot, or the one after it
 * when the person asked to skip the next one.
 */
export function effectiveNextAt(rhythm: Pick<RhythmRow, 'enabled' | 'local_time' | 'days' | 'timezone' | 'next_run_at' | 'skip_next'>): number | null {
  if (rhythm.enabled !== 1 || rhythm.next_run_at === null) return null;
  return rhythm.skip_next === 1 ? nextRunAt(scheduleOf(rhythm as RhythmRow), rhythm.next_run_at) : rhythm.next_run_at;
}

/**
 * `nothing_qualifies`: nothing is kept yet. `all_recent`: things are kept, but each was
 * sent recently (or cannot be shown in an email), so Witness waits before repeating.
 * `in_progress`: another delivery to this person is being sent at this moment.
 */
export type SendResult =
  | { sent: true; deliveryId: string; itemId: string }
  | { sent: false; reason: 'nothing_qualifies' | 'all_recent' | 'send_failed' | 'in_progress' };

/**
 * Picks one item and emails it. `mode` only changes the footer: a rhythm
 * delivery names the day the person chose it; "send one now" says they asked.
 *
 * Every caller goes through here, and here each send first claims the person's rhythm row:
 * while one delivery is being picked, sent and recorded, another sender for the same
 * person (the cron, a second "Send one now") steps back with `in_progress` instead of
 * picking the same item and sending it twice.
 */
export async function sendOne(deps: DeliveryDeps, user: UserRow, rhythm: RhythmRow, mode: 'rhythm' | 'send-now'): Promise<SendResult> {
  const db = deps.env.DB;
  const claimId = newId();
  if (!(await claimDelivery(db, user.id, claimId, deps.now))) return { sent: false, reason: 'in_progress' };
  try {
    return await sendClaimed(deps, user, rhythm, mode);
  } finally {
    await releaseDelivery(db, user.id, claimId);
  }
}

async function sendClaimed(deps: DeliveryDeps, user: UserRow, rhythm: RhythmRow, mode: 'rhythm' | 'send-now'): Promise<SendResult> {
  const { env, cfg, keyring, mailer, now } = deps;
  const db = env.DB;
  const timeZone = rhythm.timezone;

  const [saved, previous] = await Promise.all([selectionCandidates(db, user.id), previousDelivered(db, user.id)]);
  const candidates = saved.filter(emailCanShow);
  const itemId = selectItem(candidates, previous, now, timeZone);
  if (!itemId) return { sent: false, reason: saved.length === 0 ? 'nothing_qualifies' : 'all_recent' };
  const item = await getItem(db, user.id, itemId);
  if (!item) return { sent: false, reason: 'nothing_qualifies' };

  const [quote, fromName] = await Promise.all([
    keyring.decryptOptional(user.id, item.quote_ct),
    keyring.decryptOptional(user.id, item.from_name_ct),
  ]);

  const deliveryId = newId();
  // The token rides in the query string, which request logs redact (a path would be logged).
  const actionLink = async (action: DeliveryAction) =>
    appLink(cfg, `/d?t=${encodeURIComponent(await signDeliveryToken(keyring, deliveryId, action, now))}`);
  const [keep, skip, pause, remove, stop] = await Promise.all((['keep', 'skip', 'pause', 'remove', 'stop'] as const).map(actionLink));
  // "Never save from this sender" only when Witness knows who sent it.
  const block = item.sender_key ? await actionLink('block') : null;
  // The photo is kept as it came, and most mail apps cannot draw HEIC: for a HEIC photo the
  // words go by email and the photo stays one tap away in Witness (an image-only HEIC item is
  // never picked for email at all).
  const emailImage = item.media_key !== null && item.media_type !== 'image/heic';
  const imageUrl = emailImage
    ? appLink(cfg, `/api/v1/items/${item.id}/media?sig=${await signMediaQuery(keyring, item.id, EMAIL_IMAGE_TTL_MS, now)}`)
    : null;

  const email = renderDeliveryEmail({
    weekday: formatWeekday(now, timeZone),
    quote: quote ?? '',
    attribution: attribution({ fromName, occurredAt: item.occurred_at, sourceLabel: item.source_label, timeZone }),
    imageUrl,
    photoInWitness: item.media_key !== null && !emailImage,
    links: { keep: keep!, skip: skip!, pause: pause!, remove: remove!, stop: stop!, block, open: appLink(cfg, '/app'), settings: appLink(cfg, '/app/settings') },
    chosenOn: mode === 'rhythm' && rhythm.consented_at !== null ? formatLongDate(rhythm.consented_at, timeZone) : null,
  });

  await createDelivery(db, { id: deliveryId, userId: user.id, itemId: item.id, channel: 'email', status: 'sending', now });
  try {
    await mailer.send({
      kind: 'delivery',
      to: user.email,
      ...email,
      headers: {
        [WITNESS_MAIL_HEADER]: 'delivery',
        // The mail client's own Unsubscribe button stops the rhythm in one step (RFC 8058).
        'List-Unsubscribe': `<${stop!}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (error) {
    await setDeliveryStatus(db, user.id, deliveryId, 'failed');
    console.error(JSON.stringify({ event: 'delivery.failed', error: error instanceof Error ? error.name : 'unknown' }));
    return { sent: false, reason: 'send_failed' };
  }
  await Promise.all([setDeliveryStatus(db, user.id, deliveryId, 'sent'), markDelivered(db, user.id, item.id, now)]);
  return { sent: true, deliveryId, itemId: item.id };
}

export interface CronReport {
  due: number;
  sent: number;
  skipped: number;
  paused: number;
  nothing: number;
  /** Another delivery to that person was being sent at the same moment ("Send one now"). */
  busy: number;
  failed: number;
}

/** Processes rhythms whose next_run_at has passed. Safe to run concurrently: each run is claimed first. */
export async function runDueRhythms(deps: DeliveryDeps, limit = 200): Promise<CronReport> {
  const { env, now } = deps;
  const db = env.DB;
  const report: CronReport = { due: 0, sent: 0, skipped: 0, paused: 0, nothing: 0, busy: 0, failed: 0 };
  const rows = await dueRhythms(db, now, limit);
  report.due = rows.length;

  for (const rhythm of rows) {
    const expected = rhythm.next_run_at!;
    const schedule = scheduleOf(rhythm);
    try {
      if (rhythm.paused_until !== null && rhythm.paused_until > now) {
        // The break covers any "Not today" too; the first delivery after it arrives as planned.
        if (await claimRun(db, rhythm.user_id, expected, nextRunAt(schedule, rhythm.paused_until), true, now)) report.paused += 1;
        continue;
      }
      const next = nextRunAt(schedule, now);
      if (rhythm.skip_next === 1) {
        if (await claimRun(db, rhythm.user_id, expected, next, true, now)) report.skipped += 1;
        continue;
      }
      if (!(await claimRun(db, rhythm.user_id, expected, next, false, now))) continue;
      const user = await getUserById(db, rhythm.user_id);
      if (!user) continue;
      const result = await sendOne(deps, user, rhythm, 'rhythm');
      // A slot that meets a delivery already on its way (the person pressed "Send one now" at
      // that moment) counts as delivered: one email, not two.
      if (result.sent) report.sent += 1;
      else if (result.reason === 'send_failed') report.failed += 1;
      else if (result.reason === 'in_progress') report.busy += 1;
      else report.nothing += 1;
    } catch (error) {
      report.failed += 1;
      console.error(JSON.stringify({ event: 'rhythm.error', error: error instanceof Error ? error.name : 'unknown' }));
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Delivery-link actions
// ---------------------------------------------------------------------------

export type ActionOutcome =
  | { action: 'keep' }
  | { action: 'skip' }
  | { action: 'pause'; pausedUntil: number; timeZone: string }
  | { action: 'remove' }
  | { action: 'stop' }
  | { action: 'block'; blocked: boolean };

export async function applyDeliveryAction(deps: Omit<DeliveryDeps, 'mailer'>, delivery: DeliveryRow, action: DeliveryAction): Promise<ActionOutcome> {
  const { env, now } = deps;
  const db = env.DB;
  const userId = delivery.user_id;
  await setFeedback(db, userId, delivery.id, action);
  switch (action) {
    case 'keep':
      return { action };
    case 'skip':
      await setSkipNext(db, userId, true, now);
      return { action };
    case 'pause': {
      const rhythm = await getRhythm(db, userId, 'UTC', now);
      const pausedUntil = now + PAUSE_A_WEEK_DAYS * DAY_MS;
      await setPause(db, userId, pausedUntil, computeNextRun({ ...rhythm, paused_until: pausedUntil }, now), now);
      return { action, pausedUntil, timeZone: rhythm.timezone };
    }
    case 'remove': {
      // Remove means deleted: the words, the image and the row, as Remove in the app does.
      const item = delivery.item_id ? await getItem(db, userId, delivery.item_id) : null;
      if (item) await removeItems(env, userId, [item]);
      return { action };
    }
    case 'stop':
      await stopRhythm(db, userId, now);
      return { action };
    case 'block': {
      // Stops new saves from this sender and removes this one; what else is kept stays,
      // and can be removed in the app.
      const item = delivery.item_id ? await getItem(db, userId, delivery.item_id) : null;
      if (!item?.sender_key) return { action, blocked: false };
      await blockSender(db, userId, item.sender_key, now, item.from_name_ct);
      await removeItems(env, userId, [item]);
      return { action, blocked: true };
    }
  }
}
