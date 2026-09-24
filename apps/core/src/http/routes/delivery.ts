/**
 * Delivery-email links: /d?t=<signed token>. The token is in the query string, which
 * request logs redact (a path is logged as is); the confirm page posts it back in the
 * form body. GET only shows a confirm button (mail scanners prefetch links); POST does
 * the thing. A mail client's one-click unsubscribe (RFC 8058) posts
 * `List-Unsubscribe=One-Click` to the stop link, which stops the rhythm at once.
 */
import { Hono } from 'hono';
import { verifyDeliveryToken, type DeliveryAction } from '../../crypto.js';
import { applyDeliveryAction, type ActionOutcome } from '../../delivery.js';
import { getDelivery, type DeliveryRow } from '../../store/deliveries.js';
import { formatLongDate } from '../../templates/brand.js';
import type { AppContext, HonoEnv } from '../context.js';
import { htmlPage } from '../pages.js';

export const deliveryPages = new Hono<HonoEnv>();

const OPEN_LINKS = [
  { href: '/app', label: 'Open Witness' },
  { href: '/app/settings', label: 'Rhythm settings' },
];

const CONFIRM: Record<DeliveryAction, { heading: string; paragraph: string; button: string }> = {
  keep: {
    heading: 'Keep them coming?',
    paragraph: 'Witness will keep to the rhythm you chose.',
    button: 'Keep them coming',
  },
  skip: {
    heading: 'Skip the next one?',
    paragraph: 'Witness will skip the next delivery, then carry on as usual.',
    button: 'Skip the next one',
  },
  pause: {
    heading: 'Pause for a week?',
    paragraph: 'Nothing will arrive for seven days, by email or from an assistant. After that, your rhythm picks up again.',
    button: 'Pause for a week',
  },
  remove: {
    heading: 'Remove this one?',
    paragraph: 'It is deleted from Witness for good, with its image. Everything else stays as it is.',
    button: 'Remove it',
  },
  stop: {
    heading: 'Stop these emails?',
    paragraph: 'Witness will not email you again until you turn the rhythm back on in Settings. Everything you kept stays.',
    button: 'Stop these emails',
  },
  block: {
    heading: 'Never save from this sender?',
    paragraph: 'Witness will not keep anything new from them, and this one is deleted. Anything else already kept from them stays until you remove it in Witness.',
    button: 'Never save from them',
  },
};

function resultCopy(outcome: ActionOutcome): { heading: string; paragraph: string } {
  switch (outcome.action) {
    case 'keep':
      return { heading: 'Witness will keep them coming.', paragraph: 'Nothing else changes.' };
    case 'skip':
      return { heading: 'The next one is skipped.', paragraph: 'After that, your rhythm carries on.' };
    case 'pause':
      return {
        heading: `Paused until ${formatLongDate(outcome.pausedUntil, outcome.timeZone)}.`,
        paragraph: 'You can resume or change this any time in Witness.',
      };
    case 'remove':
      return { heading: 'Removed.', paragraph: 'It is deleted from Witness and will not be sent again.' };
    case 'stop':
      return { heading: 'Stopped.', paragraph: 'No more emails will come. You can turn the rhythm back on in Settings any time.' };
    case 'block':
      return outcome.blocked
        ? { heading: 'Done.', paragraph: 'Witness will not save anything new from them.' }
        : { heading: 'Witness does not know who sent this one.', paragraph: 'You can remove it in Witness instead.' };
  }
}

function linkProblem(c: AppContext, expired: boolean) {
  return htmlPage(
    c,
    {
      title: expired ? 'Link expired' : 'Link not recognized',
      eyebrow: 'Witness',
      heading: expired ? 'This link has expired' : 'This link does not work',
      paragraphs: [
        'Most links in Witness emails work for two weeks; stop and pause links work for a year. You can change or stop your rhythm in Witness at any time.',
      ],
      links: OPEN_LINKS,
    },
    expired ? 410 : 400,
  );
}

async function resolve(c: AppContext, token: string): Promise<{ delivery: DeliveryRow; action: DeliveryAction } | Response> {
  const check = await verifyDeliveryToken(c.get('keyring'), token, c.get('now'));
  if (!check.ok) return linkProblem(c, check.reason === 'expired');
  const delivery = await getDelivery(c.env.DB, check.deliveryId);
  if (!delivery) return linkProblem(c, true);
  return { delivery, action: check.action };
}

deliveryPages.get('/', async (c) => {
  const token = c.req.query('t') ?? '';
  const resolved = await resolve(c, token);
  if (resolved instanceof Response) return resolved;
  const copy = CONFIRM[resolved.action];
  return htmlPage(c, {
    title: copy.heading,
    eyebrow: 'Your rhythm',
    heading: copy.heading,
    paragraphs: [copy.paragraph],
    form: { action: '/d', button: copy.button, hidden: { t: token } },
    links: OPEN_LINKS,
  });
});

deliveryPages.post('/', async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.t === 'string' ? form.t : (c.req.query('t') ?? '');
  const resolved = await resolve(c, token);
  if (resolved instanceof Response) return resolved;
  // One-click unsubscribe comes from the mail provider, only ever for the stop link.
  if (form['List-Unsubscribe'] !== undefined && resolved.action !== 'stop') return linkProblem(c, false);
  const outcome = await applyDeliveryAction(
    { env: c.env, cfg: c.get('cfg'), keyring: c.get('keyring'), now: c.get('now') },
    resolved.delivery,
    resolved.action,
  );
  const copy = resultCopy(outcome);
  return htmlPage(c, { title: copy.heading, eyebrow: 'Your rhythm', heading: copy.heading, paragraphs: [copy.paragraph], links: OPEN_LINKS });
});

// The old /d/<token> form put the token in the path, where logs keep it. Nothing acts on it.
deliveryPages.all('/*', (c) => linkProblem(c, false));
