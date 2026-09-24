import { CATEGORIES } from '@witness/detector';
import { Hono } from 'hono';
import { z } from 'zod';
import { MAX_TEXT_CHARS, TOO_LONG_MESSAGE, capture } from '../../capture.js';
import { base64UrlDecode, base64UrlEncode, verifyMediaQuery } from '../../crypto.js';
import { OccurredAtMs } from '../../dates.js';
import { itemMatches, toApiItem, type ApiItem } from '../../items.js';
import { getMedia, removeItems } from '../../media.js';
import { blockSender } from '../../store/senders.js';
import {
  getItem,
  getItemBySignedLink,
  itemsFromSender,
  listItems,
  updateItem,
  type ItemPatch,
  type ListCursor,
} from '../../store/items.js';
import { requireSession } from '../auth.js';
import { requireUser, type AppContext, type HonoEnv } from '../context.js';
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../errors.js';
import { jsonBody, parseWith } from '../middleware.js';
import { ImageInput, decodeImage } from './capture.js';

export const itemsApi = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const ListQuery = z.object({
  status: z.enum(['saved', 'maybe']).default('saved'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
  q: z.string().trim().max(200).optional(),
});

function encodeCursor(cursor: ListCursor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify([cursor.sort, cursor.id])));
}

function decodeCursor(value: string): ListCursor {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
    if (Array.isArray(parsed) && typeof parsed[0] === 'number' && typeof parsed[1] === 'string') return { sort: parsed[0], id: parsed[1] };
  } catch {
    // fall through
  }
  throw badRequest('That cursor is not valid.');
}

/** Encrypted text cannot be searched in SQL, so a search decrypts page by page, up to a bound per request. */
const SEARCH_SCAN_LIMIT = 2000;

const sortKey = (row: { occurred_at: number | null; created_at: number; id: string }): ListCursor => ({
  sort: row.occurred_at ?? row.created_at,
  id: row.id,
});

itemsApi.get('/', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const query = parseWith(ListQuery, c.req.query());
  const keyring = c.get('keyring');
  const db = c.env.DB;
  const start = query.cursor ? decodeCursor(query.cursor) : null;

  if (!query.q) {
    // One extra row tells whether another page exists.
    const rows = await listItems(db, userId, query.status, start, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return c.json({
      items: await Promise.all(page.map((row) => toApiItem(row, keyring))),
      nextCursor: rows.length > query.limit && last ? encodeCursor(sortKey(last)) : null,
    });
  }

  const items: ApiItem[] = [];
  let cursor = start;
  let more = true;
  let scanned = 0;
  while (more && items.length < query.limit && scanned < SEARCH_SCAN_LIMIT) {
    const rows = await listItems(db, userId, query.status, cursor, 100);
    more = rows.length === 100;
    for (const row of rows) {
      scanned += 1;
      cursor = sortKey(row);
      const item = await toApiItem(row, keyring);
      if (itemMatches(item, query.q)) items.push(item);
      if (items.length >= query.limit) {
        more = true;
        break;
      }
    }
  }
  return c.json({ items, nextCursor: more && cursor ? encodeCursor(cursor) : null });
});

// ---------------------------------------------------------------------------
// Manual add
// ---------------------------------------------------------------------------

const ManualAdd = z
  .object({
    quote: z.string().max(MAX_TEXT_CHARS, TOO_LONG_MESSAGE).optional(),
    fromName: z.string().trim().max(200).optional(),
    occurredAt: OccurredAtMs.optional(),
    sourceLabel: z.string().trim().max(80).optional(),
    context: z.string().max(2000).optional(),
    category: z.enum(CATEGORIES).optional(),
    image: ImageInput.optional(),
  })
  .refine((b) => (b.quote?.trim() ?? '') !== '' || b.image, { message: 'Add some words or an image.' });

itemsApi.post('/', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const body = await jsonBody(c, ManualAdd);
  const deps = { env: c.env, cfg: c.get('cfg'), keyring: c.get('keyring'), now: c.get('now') };
  const result = await capture(deps, userId, {
    sourceType: 'manual',
    manual: true,
    text: body.quote ?? null,
    fromName: body.fromName ?? null,
    occurredAt: body.occurredAt ?? null,
    sourceLabel: body.sourceLabel ?? null,
    context: body.context ?? null,
    image: body.image ? decodeImage(body.image) : null,
    ...(body.category ? { category: body.category } : {}),
  });
  // The person's own add is always saved; the one other outcome is "already here".
  if (!result.id) throw conflict('duplicate', 'That one is already in your Witness.');
  const row = await getItem(c.env.DB, userId, result.id);
  if (!row) throw notFound();
  return c.json(await toApiItem(row, deps.keyring), 201);
});

// ---------------------------------------------------------------------------
// Edit, remove, delete, block
// ---------------------------------------------------------------------------

const PatchItem = z
  .object({
    // Removing deletes (DELETE /items/:id); there is no hidden "removed" state to move an item into.
    status: z.enum(['saved', 'maybe']).optional(),
    category: z.enum(CATEGORIES).optional(),
    fromName: z.string().trim().max(200).nullable().optional(),
    occurredAt: OccurredAtMs.nullable().optional(),
    quote: z.string().trim().min(1).max(MAX_TEXT_CHARS, TOO_LONG_MESSAGE).optional(),
  })
  .strict();

async function ownItem(c: AppContext, itemId: string) {
  const row = await getItem(c.env.DB, requireUser(c).userId, itemId);
  if (!row) throw notFound('That item is not in your Witness.');
  return row;
}

itemsApi.patch('/:id', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const row = await ownItem(c, c.req.param('id'));
  const body = await jsonBody(c, PatchItem);
  const keyring = c.get('keyring');
  const patch: ItemPatch = {};
  if (body.status) patch.status = body.status;
  if (body.category) patch.category = body.category;
  if (body.fromName !== undefined) patch.from_name_ct = await keyring.encryptOptional(userId, body.fromName);
  if (body.occurredAt !== undefined) patch.occurred_at = body.occurredAt;
  if (body.quote !== undefined) {
    patch.quote_ct = await keyring.encryptText(userId, body.quote);
    patch.edited = 1;
  }
  await updateItem(c.env.DB, userId, row.id, patch, c.get('now'));
  const updated = await getItem(c.env.DB, userId, row.id);
  if (!updated) throw notFound();
  return c.json(await toApiItem(updated, keyring));
});

itemsApi.delete('/:id', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const row = await ownItem(c, c.req.param('id'));
  await removeItems(c.env, userId, [row]);
  return c.json({ ok: true });
});

/** How many kept things came from this item's sender (this one included), before blocking them. */
itemsApi.get('/:id/sender', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const row = await ownItem(c, c.req.param('id'));
  if (!row.sender_key) throw conflict('no_sender', 'Witness does not know who sent this one, so it cannot block them.');
  const fromSender = await itemsFromSender(c.env.DB, userId, row.sender_key);
  return c.json({ count: fromSender.length, fromName: await c.get('keyring').decryptOptional(userId, row.from_name_ct) });
});

const BlockBody = z.object({ removeExisting: z.boolean().optional() }).strict();

/**
 * Never save from this sender again. With `removeExisting` (the default, for older
 * clients) everything already kept from them is deleted too; `false` keeps it.
 */
itemsApi.post('/:id/block-sender', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const row = await ownItem(c, c.req.param('id'));
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest('That is not valid JSON.');
    }
  }
  const body = parseWith(BlockBody, raw);
  if (!row.sender_key) throw conflict('no_sender', 'Witness does not know who sent this one, so it cannot block them.');
  // The display name from this item becomes the label in Settings ("Allow again"). Same user key, so the ciphertext is reused as is.
  await blockSender(c.env.DB, userId, row.sender_key, c.get('now'), row.from_name_ct);
  if (body.removeExisting === false) return c.json({ ok: true, removed: 0, removedIds: [] });
  const fromSender = await itemsFromSender(c.env.DB, userId, row.sender_key);
  await removeItems(c.env, userId, fromSender);
  return c.json({ ok: true, removed: fromSender.length, removedIds: fromSender.map((i) => i.id) });
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

itemsApi.get('/:id/media', async (c) => {
  const itemId = c.req.param('id');
  const sig = c.req.query('sig');
  const keyring = c.get('keyring');
  let row;
  if (sig !== undefined) {
    if (!(await verifyMediaQuery(keyring, itemId, sig, c.get('now')))) throw new ApiError(403, 'link_expired', 'This image link has expired.');
    row = await getItemBySignedLink(c.env.DB, itemId);
  } else {
    const auth = c.get('auth');
    if (!auth || auth.kind !== 'session') throw unauthorized();
    row = await getItem(c.env.DB, auth.userId, itemId);
  }
  if (!row || !row.media_key || !row.media_type || row.status === 'removed') throw notFound('No image here.');
  const bytes = await getMedia(c.env.MEDIA, keyring, row.user_id, row.media_key);
  if (!bytes) throw notFound('No image here.');
  return new Response(bytes, {
    headers: {
      'Content-Type': row.media_type,
      'Content-Disposition': 'inline',
      'Cache-Control': sig !== undefined ? 'private, max-age=86400' : 'private, no-store',
      // Mail clients load signed images from another origin.
      'Cross-Origin-Resource-Policy': sig !== undefined ? 'cross-origin' : 'same-origin',
    },
  });
});
