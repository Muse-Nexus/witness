/**
 * "Never save from" list for Settings (SPEC §10.1). Senders stay keyed hashes;
 * the label is the display name from the item that was blocked, decrypted here.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { blockSender, listBlockedSenders, unblockSender } from '../../store/senders.js';
import { requireSession } from '../auth.js';
import { requireUser, type HonoEnv } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { jsonBody, parseWith } from '../middleware.js';

export const sendersApi = new Hono<HonoEnv>();

const SenderKey = z.string().regex(/^[0-9a-f]{64}$/, 'That is not a sender key.');

sendersApi.get('/', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const keyring = c.get('keyring');
  const rows = await listBlockedSenders(c.env.DB, userId);
  const senders = await Promise.all(
    rows.map(async (r) => ({ senderKey: r.sender_key, createdAt: r.created_at, label: await keyring.decryptOptional(userId, r.label_ct) })),
  );
  return c.json({ senders });
});

/**
 * Block a sender before anything from them arrives (a phone number or email address).
 * The handle is hashed at once and never stored; the optional label is encrypted.
 */
const BlockHandle = z.object({ handle: z.string().trim().min(3).max(320), label: z.string().trim().max(200).optional() }).strict();

sendersApi.post('/', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const body = await jsonBody(c, BlockHandle);
  const keyring = c.get('keyring');
  const senderKey = await keyring.senderKeyFor(userId, body.handle);
  if (!senderKey) throw badRequest('Enter a phone number or an email address.', 'invalid_handle');
  await blockSender(c.env.DB, userId, senderKey, c.get('now'), await keyring.encryptOptional(userId, body.label));
  return c.json({ senderKey, createdAt: c.get('now'), label: body.label?.trim() || null }, 201);
});

sendersApi.delete('/:senderKey', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const senderKey = parseWith(SenderKey, c.req.param('senderKey'));
  if (!(await unblockSender(c.env.DB, userId, senderKey))) throw notFound('That sender is not on the list.');
  return c.json({ ok: true });
});
