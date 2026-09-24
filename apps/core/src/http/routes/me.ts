import { Hono } from 'hono';
import { z } from 'zod';
import { isValidTimeZone } from '../../rhythm.js';
import { statusSummary } from '../../status.js';
import { getUserById, rotateInboundSlug, updateUser, type UserRow } from '../../store/users.js';
import { inboundAddressFor, type Config } from '../../env.js';
import { requireAuth, requireSession } from '../auth.js';
import { requireUser, type HonoEnv } from '../context.js';
import { notFound } from '../errors.js';
import { jsonBody } from '../middleware.js';

export const meApi = new Hono<HonoEnv>();

export function inboundAddress(user: UserRow, cfg: Config): string {
  return inboundAddressFor(cfg, user.inbound_slug);
}

function meJson(user: UserRow, cfg: Config) {
  return {
    email: user.email,
    displayName: user.display_name,
    timezone: user.timezone,
    inboundAddress: inboundAddress(user, cfg),
    createdAt: user.created_at,
  };
}

const PatchMe = z
  .object({
    displayName: z.string().trim().max(80).nullable().optional(),
    timezone: z.string().refine(isValidTimeZone, 'Unknown time zone.').optional(),
  })
  .strict();

meApi.get('/me', requireSession, async (c) => {
  const user = await getUserById(c.env.DB, requireUser(c).userId);
  if (!user) throw notFound();
  return c.json(meJson(user, c.get('cfg')));
});

meApi.patch('/me', requireSession, async (c) => {
  const { userId } = requireUser(c);
  const body = await jsonBody(c, PatchMe);
  await updateUser(c.env.DB, userId, {
    ...(body.displayName !== undefined ? { displayName: body.displayName === '' ? null : body.displayName } : {}),
    ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
  });
  const user = await getUserById(c.env.DB, userId);
  if (!user) throw notFound();
  return c.json(meJson(user, c.get('cfg')));
});

/**
 * A new Witness address, for when the old one was shared or seen by someone it should not
 * have been. Mail to the old address is turned away from then on.
 */
meApi.post('/me/inbound-address', requireSession, async (c) => {
  const { userId } = requireUser(c);
  await rotateInboundSlug(c.env.DB, userId);
  const user = await getUserById(c.env.DB, userId);
  if (!user) throw notFound();
  return c.json(meJson(user, c.get('cfg')));
});

meApi.get('/status', requireAuth({ session: true, agent: 'status', device: 'status' }), async (c) => {
  return c.json(await statusSummary(c.env.DB, requireUser(c).userId, c.get('now')));
});
