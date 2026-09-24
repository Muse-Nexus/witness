import { Hono } from 'hono';
import { deleteAccount, exportStream } from '../../account.js';
import { readOutbox } from '../../mail/log.js';
import { getUserById } from '../../store/users.js';
import { clearSessionCookie, requireSession } from '../auth.js';
import { requireUser, type HonoEnv } from '../context.js';
import { notFound } from '../errors.js';
import { isLocalhost } from '../../env.js';

export const accountApi = new Hono<HonoEnv>();

accountApi.get('/export', requireSession, async (c) => {
  const user = await getUserById(c.env.DB, requireUser(c).userId);
  if (!user) throw notFound();
  const now = c.get('now');
  const day = new Date(now).toISOString().slice(0, 10);
  return new Response(exportStream(c.env, c.get('cfg'), c.get('keyring'), user, now), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="witness-${day}.witness-export.json"`,
      'Cache-Control': 'no-store',
    },
  });
});

accountApi.delete('/account', requireSession, async (c) => {
  const user = await getUserById(c.env.DB, requireUser(c).userId);
  if (!user) throw notFound();
  await deleteAccount(c.env, user);
  clearSessionCookie(c);
  return c.json({ deleted: true });
});

/** Local development only (MAILER=log on localhost, asked from localhost): what would have been emailed. */
accountApi.get('/dev/outbox', (c) => {
  if (!c.get('cfg').devOutbox || !isLocalhost(new URL(c.req.url))) throw notFound();
  return c.json({ messages: readOutbox() });
});
