/**
 * Delivery-email links: /d?t=<signed token>. The token is in the query string, which
 * request logs redact (a path is logged as is); the confirm page posts it back in the
 * form body. GET only shows a confirm button (mail scanners prefetch links); POST does
 * the thing. A mail client's one-click unsubscribe (RFC 8058) posts
 * `List-Unsubscribe=One-Click` to the stop link, which stops the rhythm at once.
 * New emails carry no "keep" link; one in an older email still opens, and says there is
 * nothing to change.
 */
import { Hono } from 'hono';
import { verifyDeliveryToken, type DeliveryAction } from '../../crypto.js';
import { applyDeliveryAction, type ActionOutcome } from '../../delivery.js';
import { getDelivery, type DeliveryRow } from '../../store/deliveries.js';
import { getItem, itemsFromSender } from '../../store/items.js';
import { formatLongDate } from '../../templates/brand.js';
import type { AppContext, HonoEnv } from '../context.js';
import { htmlPage } from '../pages.js';

export const deliveryPages = new Hono<HonoEnv>();

const OPEN_WITNESS = { href: '/app', label: 'Open Witness' };
const OPEN_LINKS = [OPEN_WITNESS, { href: '/app/settings', label: 'Change your schedule' }];
/** A plain way out of "Never save from": it changes nothing. */
const KEEP_SAVING = { href: '/app', label: 'Keep saving from them' };

/** These pages are about your Witness emails, except "Never save from", which is about a person. */
const eyebrowFor = (action: DeliveryAction) => (action === 'block' ? 'Never save from' : 'Your Witness emails');

/**
 * What each link asks before it acts. `keep` has nothing to ask: emails no longer carry
 * that link (it changed nothing), and one in an older email only says so, with no button.
 */
const CONFIRM: Record<DeliveryAction, { heading: string; paragraph: string; button?: string }> = {
  keep: {
    heading: 'Nothing to change.',
    paragraph: 'Your Witness emails continue as planned.',
  },
  skip: {
    heading: 'Skip the next one?',
    paragraph: 'Witness will skip your next email, then carry on as usual.',
    button: 'Skip the next one',
  },
  pause: {
    heading: 'Pause for a week?',
    // A pause holds emails and assistant offers (mcp.ts); saving goes on. Worded to stay true
    // when the emails were already stopped: then nothing starts again afterwards.
    paragraph:
      'Witness will not email you for a week, and AI assistants will not ask to show you anything. It still keeps what arrives. After the week, Witness goes back to your schedule.',
    button: 'Pause for a week',
  },
  remove: {
    heading: 'Remove this from Witness?',
    paragraph: 'It is deleted from Witness for good, with any photo. Everything else stays as it is.',
    button: 'Remove it',
  },
  stop: {
    heading: 'Stop these emails?',
    paragraph: 'Witness will not email you again until you turn emails back on in Settings. Everything you kept stays.',
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
      return { heading: CONFIRM.keep.heading, paragraph: CONFIRM.keep.paragraph };
    case 'skip':
      return { heading: 'The next one is skipped.', paragraph: 'After that, your emails continue as planned.' };
    case 'pause':
      return {
        heading: `Paused until ${formatLongDate(outcome.pausedUntil, outcome.timeZone)}.`,
        paragraph: 'Witness still keeps what arrives. You can resume or change this any time in Witness.',
      };
    case 'remove':
      return { heading: 'Removed.', paragraph: 'It is deleted from Witness and will not be sent again.' };
    case 'stop':
      return { heading: 'Stopped.', paragraph: 'No more Witness emails will come. You can turn them back on in Settings any time.' };
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
      // Durations match DELIVERY_LINK_TTL_MS and LASTING_LINK_TTL_MS (crypto.ts); a test holds them together.
      // "Try": the newest email can be older than two weeks too, when emails were paused or stopped.
      paragraphs: [
        'Links in Witness emails work for two weeks. Stop and pause links work for a year. Try the links in your newest Witness email, or sign in to change or stop your emails.',
      ],
      links: OPEN_LINKS,
    },
    expired ? 410 : 400,
  );
}

/**
 * Who sent the item in this delivery: the name Witness has for them, as the app shows it on a
 * card (or null), and how many other things are kept from them. Null when Witness does not
 * know who sent it, or the item is gone.
 */
async function aboutSender(c: AppContext, delivery: DeliveryRow): Promise<{ name: string | null; others: number } | null> {
  if (!delivery.item_id) return null;
  const item = await getItem(c.env.DB, delivery.user_id, delivery.item_id);
  if (!item?.sender_key) return null;
  const [name, fromThem] = await Promise.all([
    c.get('keyring').decryptOptional(delivery.user_id, item.from_name_ct),
    itemsFromSender(c.env.DB, delivery.user_id, item.sender_key),
  ]);
  return { name: name?.trim() || null, others: fromThem.filter((row) => row.id !== item.id).length };
}

/** SAFETY §6: "Never save from" says how many things are kept from them, and that those stay. */
function blockParagraph(others: number): string {
  const rest =
    others === 0
      ? 'Nothing else is kept from them.'
      : others === 1
        ? 'The one other thing kept from them stays until you remove it in Witness.'
        : `The ${others} other things kept from them stay until you remove them in Witness.`;
  return `Witness will not keep anything new from them, and this one is deleted. ${rest}`;
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
  // "Never save from" says who it is about (SAFETY §6) when Witness knows. Only the heading
  // names them: the page title, which tabs and browser history keep, stays neutral.
  const sender = resolved.action === 'block' ? await aboutSender(c, resolved.delivery) : null;
  return htmlPage(c, {
    title: copy.heading,
    eyebrow: eyebrowFor(resolved.action),
    heading: sender?.name ? `Never save from ${sender.name}?` : copy.heading,
    paragraphs: [sender ? blockParagraph(sender.others) : copy.paragraph],
    form: copy.button ? { action: '/d', button: copy.button, hidden: { t: token } } : undefined,
    links: resolved.action === 'block' ? [KEEP_SAVING] : OPEN_LINKS,
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
  return htmlPage(c, {
    title: copy.heading,
    eyebrow: eyebrowFor(outcome.action),
    heading: copy.heading,
    paragraphs: [copy.paragraph],
    links: outcome.action === 'block' ? [OPEN_WITNESS] : OPEN_LINKS,
  });
});

// The old /d/<token> form put the token in the path, where logs keep it. Nothing acts on it.
deliveryPages.all('/*', (c) => linkProblem(c, false));
