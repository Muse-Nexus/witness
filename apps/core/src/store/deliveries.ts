/** Deliveries (rhythm emails and agent reveals) and agent offers. */
import { first, newId, run } from './db.js';

export interface DeliveryRow {
  id: string;
  user_id: string;
  item_id: string | null;
  channel: string;
  sent_at: number;
  status: string;
  feedback: string | null;
}

export async function createDelivery(
  db: D1Database,
  input: { id?: string; userId: string; itemId: string; channel: 'email' | 'agent'; status: 'sending' | 'sent' | 'search'; now: number },
): Promise<string> {
  const id = input.id ?? newId();
  await run(
    db
      .prepare('INSERT INTO deliveries (id, user_id, item_id, channel, sent_at, status, feedback) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)')
      .bind(id, input.userId, input.itemId, input.channel, input.now, input.status),
  );
  return id;
}

export async function setDeliveryStatus(db: D1Database, userId: string, deliveryId: string, status: 'sent' | 'failed'): Promise<void> {
  await run(db.prepare('UPDATE deliveries SET status = ?3 WHERE user_id = ?1 AND id = ?2').bind(userId, deliveryId, status));
}

/** Looked up from a signed link, which carries only the delivery id: this establishes the user. */
export function getDelivery(db: D1Database, deliveryId: string): Promise<DeliveryRow | null> {
  return first<DeliveryRow>(db.prepare('SELECT * FROM deliveries WHERE id = ?1').bind(deliveryId));
}

export async function setFeedback(db: D1Database, userId: string, deliveryId: string, feedback: string): Promise<void> {
  await run(db.prepare('UPDATE deliveries SET feedback = ?3 WHERE user_id = ?1 AND id = ?2').bind(userId, deliveryId, feedback));
}

/** Category and sender of the last thing delivered, to avoid repeating them back to back. */
export function previousDelivered(db: D1Database, userId: string): Promise<{ category: string; sender_key: string | null } | null> {
  return first(
    db
      .prepare(
        `SELECT i.category AS category, i.sender_key AS sender_key
         FROM deliveries d JOIN items i ON i.id = d.item_id AND i.user_id = d.user_id
         WHERE d.user_id = ?1 AND d.status = 'sent'
         ORDER BY d.sent_at DESC LIMIT 1`,
      )
      .bind(userId),
  );
}

// ---------------------------------------------------------------------------
// Offers (MCP ask-first flow)
// ---------------------------------------------------------------------------

export const OFFER_TTL_MS = 30 * 60 * 1000;
/** At most one assistant offer a day. */
export const OFFER_GAP_MS = 24 * 60 * 60 * 1000;
/** An offer that expired without a reveal counts as a no; nothing is offered for a week after. */
export const OFFER_DECLINE_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The rule for "no new offer now", as SQL over the person's latest offer: within a day of
 * it, or within a week of it expiring unrevealed. Placeholders: user id, now, gap, quiet.
 * Offers are kept long enough for this (see cron housekeeping).
 */
function cooldownSql(user: string, now: string, gap: string, quiet: string): string {
  return `SELECT 1 FROM (SELECT created_at, expires_at, revealed_at FROM offers WHERE user_id = ${user} ORDER BY created_at DESC LIMIT 1) AS latest
          WHERE ${now} - latest.created_at < ${gap}
             OR (latest.revealed_at IS NULL AND latest.expires_at <= ${now} AND ${now} - latest.expires_at < ${quiet})`;
}

/** True while no new offer may be made. A quick early answer; createOffer enforces it. */
export async function offerCooldown(db: D1Database, userId: string, now: number): Promise<boolean> {
  const row = await first<{ blocked: number }>(
    db.prepare(`SELECT EXISTS (${cooldownSql('?1', '?2', '?3', '?4')}) AS blocked`).bind(userId, now, OFFER_GAP_MS, OFFER_DECLINE_QUIET_MS),
  );
  return row?.blocked === 1;
}

/**
 * Makes an offer only if the limits allow one at this moment, in a single conditional write:
 * two assistants asking at once cannot both get an offer. Null when none may be made.
 */
export async function createOffer(
  db: D1Database,
  input: { userId: string; tokenId: string; itemId: string; now: number },
): Promise<{ id: string; expiresAt: number } | null> {
  const id = newId();
  const expiresAt = input.now + OFFER_TTL_MS;
  const created = await run(
    db
      .prepare(
        `INSERT INTO offers (id, user_id, token_id, item_id, created_at, expires_at, revealed_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL
         WHERE NOT EXISTS (${cooldownSql('?2', '?5', '?7', '?8')})`,
      )
      .bind(id, input.userId, input.tokenId, input.itemId, input.now, expiresAt, OFFER_GAP_MS, OFFER_DECLINE_QUIET_MS),
  );
  return created > 0 ? { id, expiresAt } : null;
}

/**
 * Single use, same token, not expired: all checked in one conditional write so
 * two concurrent reveals cannot both succeed. Null when no offer was used; otherwise the
 * offered item's id, which is null when that item has been removed since.
 */
export async function consumeOffer(
  db: D1Database,
  input: { userId: string; tokenId: string; offerId: string; now: number },
): Promise<{ itemId: string | null } | null> {
  const row = await first<{ item_id: string | null }>(
    db
      .prepare(
        `UPDATE offers SET revealed_at = ?4
         WHERE id = ?3 AND user_id = ?1 AND token_id = ?2 AND revealed_at IS NULL AND expires_at > ?4
         RETURNING item_id`,
      )
      .bind(input.userId, input.tokenId, input.offerId, input.now),
  );
  return row ? { itemId: row.item_id } : null;
}
