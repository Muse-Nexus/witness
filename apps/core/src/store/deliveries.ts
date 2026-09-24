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
 * True while no new offer may be made: within a day of the last one, or within a week of
 * one that expired unrevealed. Offers are kept long enough for this (see cron housekeeping).
 */
export async function offerCooldown(db: D1Database, userId: string, now: number): Promise<boolean> {
  const last = await first<{ created_at: number; expires_at: number; revealed_at: number | null }>(
    db.prepare('SELECT created_at, expires_at, revealed_at FROM offers WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1').bind(userId),
  );
  if (!last) return false;
  if (now - last.created_at < OFFER_GAP_MS) return true;
  return last.revealed_at === null && last.expires_at <= now && now - last.expires_at < OFFER_DECLINE_QUIET_MS;
}

export async function createOffer(
  db: D1Database,
  input: { userId: string; tokenId: string; itemId: string; now: number },
): Promise<{ id: string; expiresAt: number }> {
  const id = newId();
  const expiresAt = input.now + OFFER_TTL_MS;
  await run(
    db
      .prepare('INSERT INTO offers (id, user_id, token_id, item_id, created_at, expires_at, revealed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)')
      .bind(id, input.userId, input.tokenId, input.itemId, input.now, expiresAt),
  );
  return { id, expiresAt };
}

/**
 * Single use, same token, not expired: all checked in one conditional write so
 * two concurrent reveals cannot both succeed. Returns the item id, or null.
 */
export async function consumeOffer(
  db: D1Database,
  input: { userId: string; tokenId: string; offerId: string; now: number },
): Promise<string | null> {
  const row = await first<{ item_id: string }>(
    db
      .prepare(
        `UPDATE offers SET revealed_at = ?4
         WHERE id = ?3 AND user_id = ?1 AND token_id = ?2 AND revealed_at IS NULL AND expires_at > ?4
         RETURNING item_id`,
      )
      .bind(input.userId, input.tokenId, input.offerId, input.now),
  );
  return row?.item_id ?? null;
}
