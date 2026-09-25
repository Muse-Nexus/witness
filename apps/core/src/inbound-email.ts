/**
 * Inbound email (SPEC §8, "Inbound email"). Mail to a person's Witness address
 * arrives through Cloudflare Email Routing: INBOUND_PLUS_USER+<slug>@INBOUND_DOMAIN
 * (one routing rule, subaddressing on) or <slug>@INBOUND_DOMAIN (catch-all).
 *
 * 1. Unknown recipient -> reject.
 * 2. Known forwarding-confirmation sender (Gmail, Outlook, iCloud) -> keep the
 *    confirmation link/code (encrypted) so the web app can show a Confirm button.
 * 3. Envelope sender not on the person's allowed list -> reject, saying where to add it.
 * 4. Otherwise: parse, pull out the original sender's words, and capture.
 *
 * Who wrote a message is not authenticated here: Email Routing hands the Worker
 * no SPF/DKIM verdict it can rely on, and the header From is whatever the sender
 * typed. So nothing an unverified claim unlocks skips review: a photo in the
 * owner's own mail lands in maybe, a "Forwarded message" block is followed only
 * in mail the owner wrote (not in an auto-forward of someone else's mail), and
 * mail that Cloudflare's own authentication result marks as not aligned with its
 * envelope sender is never saved without review. docs/ARCHITECTURE.md, trust
 * boundary 3, has the residual risk.
 *
 * Nothing here logs message content.
 */
import { extractEmailEvidence, htmlToText, pickFromThread } from '@witness/detector';
import PostalMime, { type Email } from 'postal-mime';
import { capture, createJudge, type CaptureResult } from './capture.js';
import { Keyring } from './crypto.js';
import { config, inboundSlugOf, type AppEnv } from './env.js';
import { WITNESS_MAIL_HEADER } from './mail/index.js';
import { MAX_IMAGE_BYTES, sniffImageType } from './media.js';
import { canonicalAddress, isAllowedSender, listAddresses } from './store/addresses.js';
import { upsertConfirmation } from './store/confirmations.js';
import { recordEvent } from './store/events.js';
import { getUserBySlug, type UserRow } from './store/users.js';

export const MAX_INBOUND_BYTES = 30 * 1024 * 1024;

/**
 * The bounce a sender gets when their address is not on the person's list. It names
 * no one and nothing about the account, and stays plain ASCII: SMTP reply text is
 * US-ASCII (RFC 5321), so an arrow or curly quote could arrive garbled.
 */
export const UNKNOWN_SENDER_REJECT = "This address can't send to your Witness. Add it in Witness > Settings > Email.";

export type InboundOutcome =
  | { outcome: 'rejected'; reason: 'unknown_recipient' | 'unknown_sender' | 'too_large' }
  | { outcome: 'confirmation'; provider: ConfirmationProviderId }
  | { outcome: 'captured'; result: CaptureResult }
  | { outcome: 'ignored'; reason: string };

// ---------------------------------------------------------------------------
// Forwarding confirmations
// ---------------------------------------------------------------------------

export type ConfirmationProviderId = 'gmail' | 'outlook' | 'icloud';

interface ConfirmationProvider {
  id: ConfirmationProviderId;
  /** Envelope sender domains (the SMTP MAIL FROM; bounce addresses may use a subdomain). */
  domains: readonly string[];
  /**
   * The header From the provider's confirmation comes from, when it is fixed. Cloudflare
   * enforces the sender domain's DMARC policy on the header From, and google.com
   * publishes p=reject, so this cannot be spoofed through Email Routing.
   */
  headerFrom?: string;
  /**
   * Exact https hosts and a path prefix a confirmation link must have, or null when the
   * provider sends no confirmation link (only a code is kept). A spoofed message can
   * therefore never put a page anyone can write behind a trusted "Confirm it" button.
   */
  link: { hosts: readonly string[]; pathPrefix: string } | null;
  subject: RegExp;
}

/** Gmail's forwarding confirmation links (`/mail/vf-…`) on its own settings hosts. Mirrored in apps/web/src/lib/confirmation.ts. */
export const GMAIL_CONFIRMATION_HOSTS = ['mail-settings.google.com', 'isolated.mail.google.com', 'mail.google.com'] as const;

const PROVIDERS: readonly ConfirmationProvider[] = [
  {
    id: 'gmail',
    domains: ['google.com'],
    headerFrom: 'forwarding-noreply@google.com',
    link: { hosts: GMAIL_CONFIRMATION_HOSTS, pathPrefix: '/mail/vf-' },
    subject: /forwarding confirmation/i,
  },
  // Outlook and iCloud send no confirmation link for forwarding; at most a code is kept.
  {
    id: 'outlook',
    domains: ['microsoft.com', 'outlook.com', 'hotmail.com', 'live.com'],
    link: null,
    subject: /forward|verif|confirm/i,
  },
  {
    id: 'icloud',
    domains: ['apple.com', 'icloud.com'],
    link: null,
    subject: /forward|verif|confirm/i,
  },
];

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export function confirmationProviderFor(envelopeFrom: string, subject: string): ConfirmationProvider | null {
  const domain = domainOf(envelopeFrom);
  return (
    PROVIDERS.find((p) => p.domains.some((d) => domain === d || domain.endsWith(`.${d}`)) && p.subject.test(subject)) ?? null
  );
}

export function parseConfirmation(provider: ConfirmationProvider, subject: string, body: string): { url?: string; code?: string } {
  let url: string | undefined;
  if (provider.link) {
    for (const match of body.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
      try {
        const candidate = new URL(match[0].replace(/[.,;]+$/, ''));
        if (
          candidate.protocol === 'https:' &&
          candidate.port === '' &&
          candidate.username === '' &&
          candidate.password === '' &&
          provider.link.hosts.includes(candidate.hostname) &&
          candidate.pathname.startsWith(provider.link.pathPrefix)
        ) {
          url = candidate.toString();
          break;
        }
      } catch {
        // not a URL
      }
    }
  }
  const code =
    /confirmation code:?\s*(\d{4,12})/i.exec(body)?.[1] ??
    /\(#(\d{4,12})\)/.exec(subject)?.[1] ??
    /\bcode\b[^0-9\n]{0,24}(\d{4,10})\b/i.exec(body)?.[1];
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

// ---------------------------------------------------------------------------
// Who wrote it
// ---------------------------------------------------------------------------

/** Cloudflare Email Routing's authserv-id in the authentication results it stamps. */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

/**
 * Cloudflare's own SPF/DKIM result for this message, judged against the envelope
 * sender's domain: 'pass' when SPF passed for it or a DKIM signature from it (or its
 * parent domain) verified, 'fail' when Cloudflare's result shows neither, 'unknown'
 * when the Worker was given no result from Cloudflare.
 *
 * Only ever used to take trust away: a forged header saying "pass" gains nothing
 * over no header at all, because 'unknown' is treated exactly like 'pass'.
 */
export function envelopeAuthentication(headers: readonly { key: string; value: string }[], envelopeFrom: string): 'pass' | 'fail' | 'unknown' {
  const domain = domainOf(envelopeFrom);
  const aligned = (d: string | undefined) => !!d && (d === domain || domain.endsWith(`.${d}`));
  for (const h of headers) {
    const key = h.key.toLowerCase();
    if (key !== 'authentication-results' && key !== 'arc-authentication-results') continue;
    const parts = h.value.split(';').map((p) => p.trim().toLowerCase());
    const serv = parts[0]?.startsWith('i=') ? parts[1] : parts[0];
    if (serv?.split(/\s+/)[0] !== CLOUDFLARE_AUTHSERV_ID) continue;
    // The topmost result from Cloudflare is the one it added; anything below it came with the message.
    for (const part of parts) {
      const spf = /^spf=pass\b.*\bsmtp\.mailfrom=(?:[^@\s]*@)?([a-z0-9.-]+)/.exec(part);
      if (spf && aligned(spf[1])) return 'pass';
      const dkim = /^dkim=pass\b.*\bheader\.d=([a-z0-9.-]+)/.exec(part);
      if (dkim && aligned(dkim[1])) return 'pass';
    }
    return 'fail';
  }
  return 'unknown';
}

/**
 * Mail a provider forwarded automatically (a Gmail filter or "forward all mail"):
 * Gmail's `+caf_` envelope sender, or the X-Forwarded-To/For headers it adds.
 */
export function isAutoForward(envelopeFrom: string, headers: Record<string, string>): boolean {
  const local = envelopeFrom.slice(0, envelopeFrom.lastIndexOf('@')).toLowerCase();
  return local.includes('+caf_') || headers['x-forwarded-to'] !== undefined || headers['x-forwarded-for'] !== undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function headerMap(parsed: Email): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of parsed.headers) if (!(h.key in headers)) headers[h.key] = h.value;
  return headers;
}

function firstImage(parsed: Email): { bytes: Uint8Array; type: NonNullable<ReturnType<typeof sniffImageType>> } | null {
  for (const attachment of parsed.attachments) {
    if (!attachment.mimeType.toLowerCase().startsWith('image/')) continue;
    const content = attachment.content;
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    if (bytes.length > MAX_IMAGE_BYTES) continue;
    const type = sniffImageType(bytes);
    if (type) return { bytes, type };
  }
  return null;
}

async function isOwnersAddress(db: D1Database, userId: string, address: string | undefined): Promise<boolean> {
  if (!address) return false;
  const wanted = canonicalAddress(address);
  return (await listAddresses(db, userId)).some((a) => canonicalAddress(a.address) === wanted);
}

export async function handleInboundEmail(message: ForwardableEmailMessage, env: AppEnv, now = Date.now()): Promise<InboundOutcome> {
  const cfg = config(env);
  const db = env.DB;
  // Both address styles are accepted (plus and local), whichever one this deployment shows.
  const slug = inboundSlugOf(cfg, message.to);
  const user: UserRow | null = slug ? await getUserBySlug(db, slug) : null;
  if (!user) {
    message.setReject('Unknown recipient');
    return { outcome: 'rejected', reason: 'unknown_recipient' };
  }
  const event = (outcome: 'confirmation' | 'rejected' | 'excluded', reason: string | null) =>
    recordEvent(db, { userId: user.id, sourceType: 'email', outcome, reason, now });

  if (message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject('Message too large');
    await event('rejected', 'too_large');
    return { outcome: 'rejected', reason: 'too_large' };
  }

  const envelopeFrom = message.from.trim().toLowerCase();
  const allowed = await isAllowedSender(db, user.id, envelopeFrom);
  const keyring = Keyring.fromSecret(env.WITNESS_MASTER_KEY);

  if (!allowed) {
    const provider = confirmationProviderFor(envelopeFrom, message.headers.get('subject') ?? '');
    const parsed = provider ? await PostalMime.parse(await new Response(message.raw).arrayBuffer()) : null;
    const headerFromAddress = parsed?.from && 'address' in parsed.from ? (parsed.from.address ?? '').toLowerCase() : '';
    if (provider && parsed && (!provider.headerFrom || headerFromAddress === provider.headerFrom)) {
      const body = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : '');
      const found = parseConfirmation(provider, parsed.subject ?? '', body);
      if (found.url || found.code) {
        await upsertConfirmation(db, {
          user_id: user.id,
          provider: provider.id,
          url_ct: await keyring.encryptOptional(user.id, found.url),
          code_ct: await keyring.encryptOptional(user.id, found.code),
          received_at: now,
        });
        await event('confirmation', provider.id);
        return { outcome: 'confirmation', provider: provider.id };
      }
    }
    message.setReject(UNKNOWN_SENDER_REJECT);
    await event('rejected', 'unknown_sender');
    return { outcome: 'rejected', reason: 'unknown_sender' };
  }

  const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const headers = headerMap(parsed);
  const headerFrom = parsed.from && 'address' in parsed.from ? parsed.from : undefined;

  // A person's own forwarding filter must never loop Witness mail back in.
  if (headers[WITNESS_MAIL_HEADER.toLowerCase()] !== undefined || headerFrom?.address?.toLowerCase() === cfg.mailFrom.email.toLowerCase()) {
    await event('excluded', 'witness_mail');
    return { outcome: 'ignored', reason: 'witness_mail' };
  }

  // Cloudflare's own verdict, when it gave one: mail it could not tie to the envelope
  // sender's domain is never trusted to say who wrote it, and never saved unreviewed.
  const authentication = envelopeAuthentication(parsed.headers, envelopeFrom);
  const unauthenticated = authentication === 'fail';
  const autoForward = isAutoForward(envelopeFrom, headers);
  const headerFromAddress = headerFrom?.address?.trim().toLowerCase() || undefined;
  const fromOwner = await isOwnersAddress(db, user.id, headerFromAddress);
  // The owner wrote this themself: sent (not auto-forwarded) from their own address, with a
  // matching header From. Only then is a "Forwarded message" block inside taken at its word.
  const outerIsOwner = !unauthenticated && !autoForward && fromOwner && canonicalAddress(headerFromAddress!) === canonicalAddress(envelopeFrom);

  if (fromOwner && !outerIsOwner) {
    // Someone else's mail claiming to be from the owner (or the owner's own mail looping
    // through a filter): the owner's words are never evidence, and a claim is not proof.
    await event('excluded', 'from_owner_unverified');
    return { outcome: 'captured', result: { status: 'excluded', reason: 'from_owner_unverified' } };
  }

  // A thread the owner forwarded: an earlier message from someone else may be the evidence,
  // credited to whoever wrote it, never to the owner under any of their addresses.
  const ownerAddresses = outerIsOwner ? new Set((await listAddresses(db, user.id)).map((a) => canonicalAddress(a.address))) : null;
  const evidence = pickFromThread(extractEmailEvidence({
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(parsed.html ? { html: parsed.html } : {}),
    ...(parsed.subject ? { subject: parsed.subject } : {}),
    ...(headerFrom ? { from: { name: headerFrom.name, address: headerFrom.address ?? '' } } : {}),
    // The raw header, not postal-mime's ISO string: its UTC offset is the fallback zone for a
    // forwarded Gmail date printed without one.
    ...(headers.date ?? parsed.date ? { date: headers.date ?? parsed.date } : {}),
    headers,
    followForwards: outerIsOwner,
    ...(ownerAddresses ? { isOwnerAddress: (address: string) => ownerAddresses.has(canonicalAddress(address)) } : {}),
  }));
  const deps = { env, cfg, keyring, now, judge: createJudge(env, cfg) };
  const messageId = parsed.messageId?.trim() || null;

  // Written by the person themself (not a forward): a note or photo they chose to send in.
  const ownersOwn = outerIsOwner && !evidence.forwarded;
  if (ownersOwn) {
    const image = firstImage(parsed);
    if (image) {
      // The header From is not authenticated, so the photo waits in maybe for one tap
      // rather than going straight to what the rhythm delivers.
      const result = await capture(deps, user.id, { sourceType: 'photo', image, sourceLabel: 'Email', sourceRef: messageId });
      return { outcome: 'captured', result };
    }
  }

  const result = await capture(deps, user.id, {
    sourceType: 'email',
    emailExtracted: true,
    text: evidence.text,
    subject: evidence.subject ?? null,
    // The owner's own words are not evidence; what they paste in is scored without a sender.
    fromName: ownersOwn ? null : (evidence.from?.name ?? null),
    fromHandle: ownersOwn ? null : (evidence.from?.handle ?? null),
    // What the owner writes themself was sent now, not said now: its date is unknown.
    occurredAt: ownersOwn ? null : (evidence.occurredAt ?? null),
    headers: evidence.headers,
    // A manual forward has a new Message-ID; only an auto-forward keeps the original's.
    sourceRef: evidence.forwarded ? null : messageId,
    sourceLabel: 'Email',
    // A "forwarded" block inside someone else's mail, or mail Cloudflare could not tie to
    // its envelope sender, is set aside for a look instead of being saved outright.
    // An earlier message picked out of a forwarded thread waits in maybe too.
    reviewOnly: unauthenticated || evidence.unfollowedForward === true || evidence.fromThread === true,
    // A forward the person pressed and sent here themself, as Setup invites them to: saved
    // when the detector is sure, otherwise kept in maybe rather than dropped, like a
    // share-sheet send. Only someone else's words count: a note the person writes is their
    // own words, and a body that is nothing but ">" quotes may be quoted history, so both
    // go through the detector alone, as does mail a filter forwards automatically.
    personChosen: outerIsOwner && evidence.forwarded && evidence.quotedOnly !== true,
    truncatedSource: evidence.truncated === true,
  });
  return { outcome: 'captured', result };
}
