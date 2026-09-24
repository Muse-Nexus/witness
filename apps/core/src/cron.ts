/** The 15-minute cron: rhythm delivery, then housekeeping. */
import { Keyring } from './crypto.js';
import { runDueRhythms, type CronReport } from './delivery.js';
import { config, type AppEnv } from './env.js';
import { createMailer } from './mail/index.js';
import { sweepMediaCleanup, sweepMediaKeys } from './media.js';
import { run } from './store/db.js';
import { pruneConfirmations } from './store/confirmations.js';
import { pruneRateLimits } from './store/ratelimit.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expired sign-in links, sessions, offers and confirmations are useless; old counters too. */
export async function housekeeping(db: D1Database, now: number): Promise<void> {
  await Promise.all([
    run(db.prepare('DELETE FROM magic_links WHERE expires_at < ?1').bind(now - DAY_MS)),
    run(db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now)),
    // Kept past the offer cooldown (a week's quiet after an unanswered one), then dropped.
    run(db.prepare('DELETE FROM offers WHERE expires_at < ?1').bind(now - 8 * DAY_MS)),
    pruneRateLimits(db, now - DAY_MS),
    pruneConfirmations(db, now),
  ]);
}

export async function runScheduled(env: AppEnv, now: number): Promise<CronReport> {
  const cfg = config(env);
  const report = await runDueRhythms({ env, cfg, keyring: Keyring.fromSecret(env.WITNESS_MASTER_KEY), mailer: createMailer(env, cfg), now });
  await housekeeping(env.DB, now);
  // Images of deleted accounts and removed items that the deletion itself could not finish.
  const cleanup = await sweepMediaCleanup(env, now);
  const removedImages = await sweepMediaKeys(env);
  console.log(JSON.stringify({ event: 'cron', ...report, mediaCleanup: cleanup, removedImages }));
  return report;
}
