/** Allowed inbound senders, and the latest detected forwarding confirmation. */
import { Hono } from 'hono';
import { z } from 'zod';
import { addAddress, listAddresses, removeAddress } from '../../store/addresses.js';
import { latestConfirmation } from '../../store/confirmations.js';
import { getUserById } from '../../store/users.js';
import { requireSession } from '../auth.js';
import { requireUser, type AppContext, type HonoEnv } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { jsonBody, parseWith } from '../middleware.js';

export const addressesApi = new Hono<HonoEnv>();

const MAX_ADDRESSES = 20;
const Address = z.string().trim().toLowerCase().pipe(z.email().max(254));

async function addressList(c: AppContext) {
  const { userId } = requireUser(c);
  const [user, rows] = await Promise.all([getUserById(c.env.DB, userId), listAddresses(c.env.DB, userId)]);
  return rows.map((r) => ({ address: r.address, verifiedAt: r.verified_at, isAccountEmail: r.address === user?.email }));
}

addressesApi.get('/', requireSession, async (c) => c.json({ addresses: await addressList(c) }));

addressesApi.post('/', requireSession, async (c) => {
  const { address } = await jsonBody(c, z.object({ address: Address }).strict());
  const { userId } = requireUser(c);
  if ((await listAddresses(c.env.DB, userId)).length >= MAX_ADDRESSES) throw badRequest('That is the most addresses Witness keeps for one account.');
  // Added by the signed-in owner, so it counts as verified in v1.
  await addAddress(c.env.DB, userId, address, c.get('now'));
  // The address as stored (SPEC §10.1: POST answers with the address, GET with the list).
  const added = (await addressList(c)).find((a) => a.address === address);
  if (!added) throw notFound();
  return c.json(added, 201);
});

async function remove(c: AppContext, raw: string) {
  const address = parseWith(Address, raw, { name: 'address' });
  const { userId } = requireUser(c);
  const user = await getUserById(c.env.DB, userId);
  if (user?.email === address) throw conflict('account_email', 'Your account email always stays on the list.');
  if (!(await removeAddress(c.env.DB, userId, address))) throw notFound('That address is not on the list.');
  return c.json({ addresses: await addressList(c) });
}

addressesApi.delete('/:address', requireSession, (c) => remove(c, c.req.param('address')));

addressesApi.delete('/', requireSession, async (c) => {
  const { address } = await jsonBody(c, z.object({ address: z.string() }).strict());
  return remove(c, address);
});

export const inboundApi = new Hono<HonoEnv>();

const ConfirmationQuery = z.object({ provider: z.enum(['gmail', 'outlook', 'icloud']).optional() });

/**
 * `{ provider, url?, code?, receivedAt }` for the newest confirmation from the last
 * day (optionally for one provider), or `null`. The web app polls this per tab.
 */
inboundApi.get('/confirmations', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const { provider } = parseWith(ConfirmationQuery, c.req.query());
  const row = await latestConfirmation(c.env.DB, userId, c.get('now'), provider);
  if (!row) return c.json(null);
  const keyring = c.get('keyring');
  const [url, code] = await Promise.all([keyring.decryptOptional(userId, row.url_ct), keyring.decryptOptional(userId, row.code_ct)]);
  return c.json({ provider: row.provider, ...(url ? { url } : {}), ...(code ? { code } : {}), receivedAt: row.received_at });
});
