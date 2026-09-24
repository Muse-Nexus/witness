/** Evidence items. Text columns ending in _ct are ciphertext; this module never sees plaintext. */
import { all, first, run, type ItemKind, type ItemStatus, type SourceType } from './db.js';

export interface ItemRow {
  id: string;
  user_id: string;
  status: ItemStatus;
  kind: ItemKind;
  quote_ct: string | null;
  context_ct: string | null;
  from_name_ct: string | null;
  occurred_at: number | null;
  source_type: SourceType;
  source_label: string;
  dedupe_key: string;
  /** Keyed hash of the normalized text alone (null for image-only items). */
  text_key: string | null;
  sender_key: string | null;
  category: string;
  score: number | null;
  reasons: string | null;
  media_key: string | null;
  media_type: string | null;
  edited: number;
  created_at: number;
  updated_at: number;
  last_delivered_at: number | null;
  delivered_count: number;
}

/** The gallery sorts by when something happened, or when it was kept if that is unknown. */
export const SORT_EXPR = 'COALESCE(occurred_at, created_at)';

/**
 * Stores an item, only while its account exists: a capture that was already under way when
 * the account was deleted writes nothing (the check and the insert are one statement).
 * False when the account is gone.
 */
export async function insertItem(db: D1Database, row: ItemRow): Promise<boolean> {
  const inserted = await run(
    db
      .prepare(
        `INSERT INTO items (id, user_id, status, kind, quote_ct, context_ct, from_name_ct, occurred_at, source_type,
           source_label, dedupe_key, sender_key, category, score, reasons, media_key, media_type, edited,
           created_at, updated_at, last_delivered_at, delivered_count, text_key)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
         WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
      )
      .bind(
        row.id,
        row.user_id,
        row.status,
        row.kind,
        row.quote_ct,
        row.context_ct,
        row.from_name_ct,
        row.occurred_at,
        row.source_type,
        row.source_label,
        row.dedupe_key,
        row.sender_key,
        row.category,
        row.score,
        row.reasons,
        row.media_key,
        row.media_type,
        row.edited,
        row.created_at,
        row.updated_at,
        row.last_delivered_at,
        row.delivered_count,
        row.text_key,
      ),
  );
  return inserted > 0;
}

export function getItem(db: D1Database, userId: string, itemId: string): Promise<ItemRow | null> {
  return first<ItemRow>(db.prepare('SELECT * FROM items WHERE user_id = ?1 AND id = ?2').bind(userId, itemId));
}

/**
 * For signed media links, which carry only the item id: the verified signature
 * is the capability, and this lookup establishes the owner.
 */
export function getItemBySignedLink(db: D1Database, itemId: string): Promise<ItemRow | null> {
  return first<ItemRow>(db.prepare('SELECT * FROM items WHERE id = ?1').bind(itemId));
}

/** The item already kept under any of these dedupe keys (the keyed form, or an older plain one). */
export function findByDedupeKeys(db: D1Database, userId: string, keys: readonly string[]): Promise<Pick<ItemRow, 'id' | 'status' | 'media_key'> | null> {
  const wanted = [...new Set(keys)].slice(0, 4);
  const placeholders = wanted.map((_, i) => `?${i + 2}`).join(', ');
  return first(db.prepare(`SELECT id, status, media_key FROM items WHERE user_id = ?1 AND dedupe_key IN (${placeholders}) LIMIT 1`).bind(userId, ...wanted));
}

/** How close in time the same words must arrive by two paths to count as one message. */
export const CROSS_PATH_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * The same words kept by another path around the same time: a capture with no source id
 * (the iPhone Shortcut) and one with an id (the Mac helper's message GUID, an email's
 * Message-ID). Two captures that both carry their own ids stay separate, since the same
 * words from two people, or on two days, are two messages. An item without a source id
 * has dedupe_key = text_key.
 */
export async function crossPathDuplicate(
  db: D1Database,
  userId: string,
  input: { textKey: string; hasSourceRef: boolean; at: number },
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM items WHERE user_id = ?1 AND text_key = ?2
           AND ABS(COALESCE(occurred_at, created_at) - ?3) < ?4
           AND (?5 = 0 OR dedupe_key = text_key)
         LIMIT 1`,
      )
      .bind(userId, input.textKey, input.at, CROSS_PATH_WINDOW_MS, input.hasSourceRef ? 1 : 0),
  );
  return row !== null;
}

export interface ListCursor {
  sort: number;
  id: string;
}

/** A page of rows, newest first, strictly after `cursor` when given. */
export function listItems(
  db: D1Database,
  userId: string,
  status: 'saved' | 'maybe',
  cursor: ListCursor | null,
  limit: number,
): Promise<ItemRow[]> {
  if (!cursor) {
    return all<ItemRow>(
      db
        .prepare(`SELECT * FROM items WHERE user_id = ?1 AND status = ?2 ORDER BY ${SORT_EXPR} DESC, id DESC LIMIT ?3`)
        .bind(userId, status, limit),
    );
  }
  return all<ItemRow>(
    db
      .prepare(
        `SELECT * FROM items WHERE user_id = ?1 AND status = ?2
           AND (${SORT_EXPR} < ?3 OR (${SORT_EXPR} = ?3 AND id < ?4))
         ORDER BY ${SORT_EXPR} DESC, id DESC LIMIT ?5`,
      )
      .bind(userId, status, cursor.sort, cursor.id, limit),
  );
}

export interface ItemPatch {
  status?: ItemStatus;
  category?: string;
  from_name_ct?: string | null;
  occurred_at?: number | null;
  quote_ct?: string;
  edited?: 1;
}

const PATCHABLE: ReadonlySet<string> = new Set(['status', 'category', 'from_name_ct', 'occurred_at', 'quote_ct', 'edited']);

export async function updateItem(db: D1Database, userId: string, itemId: string, patch: ItemPatch, now: number): Promise<boolean> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [column, value] of Object.entries(patch) as [keyof ItemPatch, string | number | null | undefined][]) {
    if (value === undefined || !PATCHABLE.has(column)) continue;
    values.push(value);
    sets.push(`${column} = ?${values.length + 3}`);
  }
  if (sets.length === 0) return (await getItem(db, userId, itemId)) !== null;
  const changed = await run(
    db
      .prepare(`UPDATE items SET ${sets.join(', ')}, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
      .bind(userId, itemId, now, ...values),
  );
  return changed > 0;
}

/**
 * Deletes item rows. Deliveries and offers keep their timing, without the item: the rhythm's
 * history, and the offer limits (one a day, a quiet week after an unanswered one), must not
 * start over because something was removed.
 */
export async function deleteItems(
  db: D1Database,
  userId: string,
  itemIds: readonly string[],
  /** More writes that must happen in the same batch (the records of their images). */
  also: readonly D1PreparedStatement[] = [],
): Promise<void> {
  if (itemIds.length === 0) return;
  const statements = itemIds.flatMap((id) => [
    db.prepare('DELETE FROM items WHERE user_id = ?1 AND id = ?2').bind(userId, id),
    db.prepare('UPDATE offers SET item_id = NULL WHERE user_id = ?1 AND item_id = ?2').bind(userId, id),
    db.prepare('UPDATE deliveries SET item_id = NULL WHERE user_id = ?1 AND item_id = ?2').bind(userId, id),
  ]);
  await db.batch([...statements, ...also]);
}

export function itemsFromSender(db: D1Database, userId: string, senderKey: string): Promise<Pick<ItemRow, 'id' | 'media_key'>[]> {
  return all(db.prepare('SELECT id, media_key FROM items WHERE user_id = ?1 AND sender_key = ?2').bind(userId, senderKey));
}

/** Metadata only (no ciphertext) for choosing what to deliver or offer. */
export interface SelectionRow {
  id: string;
  kind: string;
  media_type: string | null;
  category: string;
  sender_key: string | null;
  occurred_at: number | null;
  created_at: number;
  last_delivered_at: number | null;
  delivered_count: number;
}

export function selectionCandidates(db: D1Database, userId: string): Promise<SelectionRow[]> {
  return all<SelectionRow>(
    db
      .prepare(
        `SELECT id, kind, media_type, category, sender_key, occurred_at, created_at, last_delivered_at, delivered_count
         FROM items WHERE user_id = ?1 AND status = 'saved' ORDER BY created_at ASC, id ASC`,
      )
      .bind(userId),
  );
}

/**
 * Whether an email can show this item. Most mail clients (and Chrome, Firefox and Edge)
 * cannot draw HEIC, so an image-only HEIC item would arrive as an empty card.
 */
export function emailCanShow(row: Pick<SelectionRow, 'kind' | 'media_type'>): boolean {
  return !(row.kind === 'image' && row.media_type === 'image/heic');
}

export async function markDelivered(db: D1Database, userId: string, itemId: string, now: number): Promise<void> {
  await run(
    db
      .prepare('UPDATE items SET last_delivered_at = ?3, delivered_count = delivered_count + 1 WHERE user_id = ?1 AND id = ?2')
      .bind(userId, itemId, now),
  );
}

/**
 * Undoes markDelivered after a send that failed, so the item can come another time. Only
 * while the mark is still that send's: if something else delivered it since (an assistant's
 * reveal), that record stays.
 */
export async function unmarkDelivered(db: D1Database, userId: string, itemId: string, markedAt: number, previousAt: number | null): Promise<void> {
  await run(
    db
      .prepare(
        `UPDATE items SET last_delivered_at = ?4, delivered_count = MAX(delivered_count - 1, 0)
         WHERE user_id = ?1 AND id = ?2 AND last_delivered_at = ?3`,
      )
      .bind(userId, itemId, markedAt, previousAt),
  );
}

export async function itemCounts(db: D1Database, userId: string): Promise<{ saved: number; maybe: number; lastCapturedAt: number | null }> {
  const row = await first<{ saved: number | null; maybe: number | null; last: number | null }>(
    db
      .prepare(
        `SELECT SUM(status = 'saved') AS saved, SUM(status = 'maybe') AS maybe,
                MAX(CASE WHEN status IN ('saved', 'maybe') THEN created_at END) AS last
         FROM items WHERE user_id = ?1`,
      )
      .bind(userId),
  );
  return { saved: row?.saved ?? 0, maybe: row?.maybe ?? 0, lastCapturedAt: row?.last ?? null };
}

/** Every item for export, a page at a time, in a stable order. */
export function exportPage(db: D1Database, userId: string, afterId: string, limit: number): Promise<ItemRow[]> {
  return all<ItemRow>(
    db.prepare('SELECT * FROM items WHERE user_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3').bind(userId, afterId, limit),
  );
}
