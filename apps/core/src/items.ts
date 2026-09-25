/** Turning stored item rows into what people see: decrypted, with display labels. */
import { CATEGORY_LABELS, type Category } from '@witness/detector';
import type { Keyring } from './crypto.js';
import { showableDate } from './dates.js';
import type { ItemRow } from './store/items.js';

export interface ApiItem {
  id: string;
  status: ItemRow['status'];
  kind: ItemRow['kind'];
  quote: string | null;
  context: string | null;
  fromName: string | null;
  occurredAt: number | null;
  sourceType: ItemRow['source_type'];
  sourceLabel: string;
  /** Always one of the categories ("other" for an item nothing sorted), so every client can read it. */
  category: string;
  /** "" when nothing sorted the item. */
  categoryLabel: string;
  /**
   * False when nothing sorted it: the detector did not keep its words (or it has none) and the
   * person chose no kind. A client shows no kind for it rather than "Other".
   */
  categoryKnown: boolean;
  /** Detector score and rule ids (no text), so saving is never a mystery. */
  score: number | null;
  reasons: { rule: string; weight: number }[];
  hasMedia: boolean;
  mediaType: string | null;
  /** Same-origin URL for the decrypted image (session cookie auth). */
  mediaUrl: string | null;
  edited: boolean;
  canBlockSender: boolean;
  createdAt: number;
  updatedAt: number;
  lastDeliveredAt: number | null;
  deliveredCount: number;
}

function parseReasons(json: string | null): { rule: string; weight: number }[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (r): r is { rule: string; weight: number } => typeof r === 'object' && r !== null && typeof r.rule === 'string' && typeof r.weight === 'number',
    );
  } catch {
    return [];
  }
}

/** "" for an item nothing sorted (capture's UNSORTED): no kind is shown, rather than "Other". */
export function categoryLabel(category: string): string {
  if (category === '') return '';
  return CATEGORY_LABELS[category as Category] ?? CATEGORY_LABELS.other;
}

export async function toApiItem(row: ItemRow, keyring: Keyring): Promise<ApiItem> {
  const [quote, context, fromName] = await Promise.all([
    keyring.decryptOptional(row.user_id, row.quote_ct),
    keyring.decryptOptional(row.user_id, row.context_ct),
    keyring.decryptOptional(row.user_id, row.from_name_ct),
  ]);
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    quote,
    context,
    fromName,
    occurredAt: showableDate(row.occurred_at),
    sourceType: row.source_type,
    sourceLabel: row.source_label,
    category: row.category === '' ? 'other' : row.category,
    categoryLabel: categoryLabel(row.category),
    categoryKnown: row.category !== '',
    score: row.score,
    reasons: parseReasons(row.reasons),
    hasMedia: row.media_key !== null,
    mediaType: row.media_type,
    mediaUrl: row.media_key ? `/api/v1/items/${row.id}/media` : null,
    edited: row.edited === 1,
    canBlockSender: row.sender_key !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDeliveredAt: row.last_delivered_at,
    deliveredCount: row.delivered_count,
  };
}

/**
 * What an assistant's search looks at: the words, who said them and the note. Not the
 * category or source labels, so a one-letter query cannot sweep everything up.
 */
export function evidenceMatches(item: Pick<ApiItem, 'quote' | 'fromName' | 'context'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return false;
  return [item.quote, item.fromName, item.context].some((v) => v?.toLowerCase().includes(q));
}

/**
 * Case-insensitive match over what a card shows: the words, who said them and where they came
 * from. Never the kind label or the note (an email's subject line), which cards do not show, so a
 * search never returns things for a reason the person cannot see.
 */
export function itemMatches(item: Pick<ApiItem, 'quote' | 'fromName' | 'sourceLabel'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.quote, item.fromName, item.sourceLabel].some((v) => v?.toLowerCase().includes(q));
}
