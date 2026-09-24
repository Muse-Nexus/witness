import { Hono } from 'hono';
import { z } from 'zod';
import { sha256Hex } from '../../crypto.js';
import { computeNextRun, effectiveNextAt, sendOne } from '../../delivery.js';
import { createMailer } from '../../mail/index.js';
import { ALL_DAYS, isValidTimeZone, parseDays, parseLocalTime } from '../../rhythm.js';
import { hitRateLimit } from '../../store/ratelimit.js';
import { getRhythm, saveRhythm, setPause, type RhythmRow } from '../../store/rhythm.js';
import { getUserById, updateUser } from '../../store/users.js';
import { requireAuth, requireSession } from '../auth.js';
import { requireUser, type AppContext, type HonoEnv } from '../context.js';
import { notFound, rateLimited } from '../errors.js';
import { jsonBody } from '../middleware.js';

export const rhythmApi = new Hono<HonoEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;

export function rhythmJson(row: RhythmRow, now: number) {
  return {
    enabled: row.enabled === 1,
    channel: row.channel,
    localTime: row.local_time,
    days: parseDays(row.days),
    timezone: row.timezone,
    pausedUntil: row.paused_until !== null && row.paused_until > now ? row.paused_until : null,
    skipNext: row.skip_next === 1,
    // When the next one really arrives: after a "Not today", the slot after the skipped one.
    nextAt: effectiveNextAt(row),
    consentedAt: row.consented_at,
  };
}

async function currentRhythm(c: AppContext): Promise<RhythmRow> {
  const { userId } = requireUser(c);
  const user = await getUserById(c.env.DB, userId);
  if (!user) throw notFound();
  return getRhythm(c.env.DB, userId, user.timezone, c.get('now'));
}

const PutRhythm = z
  .object({
    enabled: z.boolean(),
    localTime: z.string().refine((v) => parseLocalTime(v) !== null, 'Use 24-hour HH:MM.').optional(),
    days: z.array(z.enum(ALL_DAYS as [string, ...string[]])).min(1).max(7).optional(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown time zone.').optional(),
    channel: z.literal('email').optional(),
  })
  .strict();

rhythmApi.get('/', requireSession, async (c) => c.json(rhythmJson(await currentRhythm(c), c.get('now'))));

rhythmApi.put('/', requireSession, async (c) => {
  const body = await jsonBody(c, PutRhythm);
  const now = c.get('now');
  const current = await currentRhythm(c);
  const next: RhythmRow = {
    ...current,
    enabled: body.enabled ? 1 : 0,
    channel: body.channel ?? current.channel,
    local_time: body.localTime ?? current.local_time,
    days: body.days ? ALL_DAYS.filter((d) => body.days!.includes(d)).join(',') : current.days,
    timezone: body.timezone ?? current.timezone,
    // Turning it on is the consent moment; keep the original date while it stays on.
    consented_at: body.enabled ? (current.enabled === 1 && current.consented_at !== null ? current.consented_at : now) : current.consented_at,
  };
  const scheduleChanged =
    next.enabled !== current.enabled ||
    next.local_time !== current.local_time ||
    next.days !== current.days ||
    next.timezone !== current.timezone;
  const dueNow = current.enabled === 1 && next.enabled === 1 && current.next_run_at !== null && current.next_run_at <= now;
  if (dueNow && !scheduleChanged) {
    // Saving without changes between the scheduled time and the next cron tick keeps that
    // delivery; it has not gone out yet.
    next.next_run_at = current.next_run_at;
  } else if (dueNow) {
    // A slot that is due but not sent still counts if the new schedule includes it.
    next.next_run_at = computeNextRun(next, current.next_run_at! - 1);
  } else {
    next.next_run_at = computeNextRun(next, now);
  }
  // Turning the rhythm off or on starts fresh: an old "Not today" never swallows the first one.
  if (next.enabled !== current.enabled) next.skip_next = 0;
  await saveRhythm(c.env.DB, next, now);
  // The zone someone picks for their rhythm is the best word on where they are; dates in
  // assistant reveals and new rhythms use the account's zone, which starts as UTC.
  if (body.timezone) {
    const user = await getUserById(c.env.DB, current.user_id);
    if (user && user.timezone !== body.timezone) await updateUser(c.env.DB, user.id, { timezone: body.timezone });
  }
  return c.json(rhythmJson(next, now));
});

const PauseBody = z.object({ days: z.number().int().min(1).max(90) }).strict();

rhythmApi.post('/pause', requireAuth({ session: true, agent: 'pause' }), async (c) => {
  const { days } = await jsonBody(c, PauseBody);
  const now = c.get('now');
  const current = await currentRhythm(c);
  const pausedUntil = now + days * DAY_MS;
  const nextRun = computeNextRun({ ...current, paused_until: pausedUntil }, now);
  await setPause(c.env.DB, current.user_id, pausedUntil, nextRun, now);
  return c.json(rhythmJson({ ...current, paused_until: pausedUntil, next_run_at: nextRun, skip_next: 0 }, now));
});

rhythmApi.post('/resume', requireSession, async (c) => {
  const now = c.get('now');
  const current = await currentRhythm(c);
  const nextRun = computeNextRun({ ...current, paused_until: null }, now);
  await setPause(c.env.DB, current.user_id, null, nextRun, now);
  return c.json(rhythmJson({ ...current, paused_until: null, next_run_at: nextRun, skip_next: 0 }, now));
});

/** "Send one now to see it". Answers `{ sent: false }` when nothing qualifies, and sends nothing. */
rhythmApi.post('/send-now', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const now = c.get('now');
  const limit = await hitRateLimit(c.env.DB, { key: `send-now:${await sha256Hex(userId)}`, limit: 5, windowMs: 60 * 60 * 1000, now });
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs / 1000);
  const user = await getUserById(c.env.DB, userId);
  if (!user) throw notFound();
  const rhythm = await getRhythm(c.env.DB, userId, user.timezone, now);
  const cfg = c.get('cfg');
  const result = await sendOne({ env: c.env, cfg, keyring: c.get('keyring'), mailer: createMailer(c.env, cfg), now }, user, rhythm, 'send-now');
  return c.json(result.sent ? { sent: true } : { sent: false, reason: result.reason });
});
