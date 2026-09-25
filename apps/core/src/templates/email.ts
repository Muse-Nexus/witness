/**
 * Transactional emails in the Muse Nexus brand. Table-based HTML with inline
 * styles so Gmail, Apple Mail and Outlook render the same thing; Fraunces
 * where it is installed, Georgia everywhere else. No web fonts, tracking pixels
 * or other remote resources are loaded (a font request would tell a third party
 * when a delivery was opened). Every email also has a plain-text part.
 *
 * Subjects and preheaders never contain evidence: an inbox list or a lock
 * screen shows only neutral words.
 */
import { CRISIS_LINE, EMAIL_COLORS as C, SANS, SERIF, escapeHtml, escapeMultiline } from './brand.js';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Hidden preview text, padded so the body never leaks into the inbox preview. */
function preheader(text: string): string {
  const pad = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(text)}${pad}</div>`;
}

function wordmark(): string {
  return `<tr><td class="pad" style="padding:8px 32px 24px 32px;">
  <div style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:0.22em;text-transform:uppercase;color:${C.muted};"><span style="color:${C.coral};">&#9613;</span>&nbsp;Muse Nexus</div>
  <div style="font-family:${SERIF};font-size:30px;line-height:36px;color:${C.cream};">Witness<span style="color:${C.coral};">.</span></div>
</td></tr>`;
}

function shell(input: { title: string; preheader: string; rows: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(input.title)}</title>
<style>
  body { margin: 0; padding: 0; background: ${C.ink}; }
  a { color: ${C.cream}; }
  @media (max-width: 520px) {
    .pad { padding-left: 20px !important; padding-right: 20px !important; }
    .quote { font-size: 25px !important; line-height: 34px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.ink};">
${preheader(input.preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ink}" style="background:${C.ink};">
<tr><td align="center" style="padding:32px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;">
${wordmark()}
${input.rows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

function hairline(): string {
  return `<tr><td class="pad" style="padding:0 32px;"><div style="height:1px;line-height:1px;font-size:1px;background:${C.hairline};">&nbsp;</div></td></tr>`;
}

function footerRow(lines: string[]): string {
  return `<tr><td class="pad" style="padding:24px 32px 8px 32px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.faint};">${lines
    .map((l) => `<p style="margin:0 0 10px 0;">${l}</p>`)
    .join('')}</td></tr>`;
}

/** The same words as CRISIS_LINE. On a phone, "call" and "text" open the dialer and messages with 988. */
const crisisHtml = () => {
  const a = (href: string, label: string) => `<a href="${href}" style="color:${C.muted};">${label}</a>`;
  return `If you are in crisis, ${a('tel:988', 'call')} or ${a('sms:988', 'text')} 988 (US) or visit ${a('https://findahelpline.com', 'findahelpline.com')}.`;
};

// ---------------------------------------------------------------------------
// Sign-in link
// ---------------------------------------------------------------------------

export function renderMagicLinkEmail(input: { link: string; minutes: number }): RenderedEmail {
  const subject = 'Your sign-in link for Witness';
  const intro = `Here is your link to sign in to Witness. It works once, for the next ${input.minutes} minutes.`;
  const ignore = 'If you did not ask for this, you can ignore this email. Nothing changes.';
  const rows = `${hairline()}
<tr><td class="pad" style="padding:32px 32px 8px 32px;font-family:${SANS};font-size:16px;line-height:25px;color:${C.cream};">
  <p style="margin:0 0 24px 0;">${escapeHtml(intro)}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${C.coral}" style="border-radius:999px;background:${C.coral};">
      <a href="${escapeHtml(input.link)}" style="display:inline-block;padding:13px 28px;font-family:${SANS};font-size:16px;font-weight:600;line-height:20px;color:${C.ink};text-decoration:none;border-radius:999px;">Sign in to Witness</a>
    </td>
  </tr></table>
  <p style="margin:24px 0 0 0;font-size:13px;line-height:20px;color:${C.muted};">Or paste this link into your browser:<br><span style="word-break:break-all;color:${C.cream};">${escapeHtml(input.link)}</span></p>
  <p style="margin:24px 0 0 0;font-size:14px;line-height:22px;color:${C.muted};">${escapeHtml(ignore)}</p>
</td></tr>
${footerRow([crisisHtml()])}`;
  const text = [
    'MUSE NEXUS',
    'Witness.',
    '',
    intro,
    '',
    input.link,
    '',
    ignore,
    '',
    CRISIS_LINE,
  ].join('\n');
  return { subject, html: shell({ title: subject, preheader: 'Your link to sign in to Witness.', rows }), text };
}

// ---------------------------------------------------------------------------
// Rhythm delivery
// ---------------------------------------------------------------------------

export interface DeliveryEmailInput {
  weekday: string; // "Tuesday"
  quote: string;
  attribution: string; // "— Dana · March 3, 2026 · Text message"
  imageUrl: string | null;
  /** The item has a photo mail apps cannot show (HEIC): link to it in Witness instead. */
  photoInWitness?: boolean;
  /**
   * `block` ("Never save from them") only when Witness knows who sent it. There is no "keep"
   * link: it changed nothing, yet read as if you had to click it to keep getting emails.
   * Keep links in older emails still open a page that says there is nothing to change.
   */
  links: { skip: string; pause: string; remove: string; stop: string; block: string | null; open: string; settings: string };
  /** "September 1, 2026", or null for a one-off the person asked for ("Send one now"). */
  chosenOn: string | null;
}

/** Shown in the inbox list and at the top of the plain-text part: neutral words only. */
const DELIVERY_OPENING = 'From the schedule you set in Witness.';
/** The same, for one the person asked for ("Send one now"): there may be no schedule yet. */
const SENT_NOW_OPENING = 'You asked Witness to send this one.';

/**
 * A line that looks blank. Inbox lists and lock screens build previews with whitespace
 * collapsed, so truly blank lines would not keep the quote out of them. These carry the
 * characters the HTML preheader pads with (combining grapheme joiner, zero-width non-joiner,
 * no-break space), which show as nothing and are not collapsed.
 */
const BLANK_LOOKING_LINE = '\u034F\u200C\u00A0'.repeat(20);

/**
 * First lines of the plain-text part: the opening line and the crisis line, then lines that
 * look blank, so a preview built from text/plain never reaches the quote.
 */
function deliveryTextOpening(opening: string): string[] {
  return ['MUSE NEXUS', 'Witness.', '', opening, '', CRISIS_LINE, ...Array<string>(5).fill(BLANK_LOOKING_LINE), ''];
}

export function renderDeliveryEmail(input: DeliveryEmailInput): RenderedEmail {
  const subject = `Something you kept, for ${input.weekday}`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:${C.cream};text-decoration:underline;text-underline-offset:3px;">${label}</a>`;
  const dot = `<span style="color:${C.faint};">&nbsp;&middot;&nbsp;</span>`;

  // An image-only delivery gets a way to see it if the mail client cannot show the picture
  // (image links last seven days, and some clients block images). A photo most mail apps
  // cannot draw (HEIC, kept as it came) is linked in Witness rather than embedded.
  const image = input.imageUrl
    ? `<tr><td class="pad" style="padding:0 32px 32px 32px;"><img src="${escapeHtml(input.imageUrl)}" alt="The image you kept" width="516" style="display:block;width:100%;max-width:516px;height:auto;border:0;border-radius:6px;">${
        input.quote ? '' : `<div style="margin-top:14px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.muted};">${link(input.links.open, 'See it in Witness')}</div>`
      }</td></tr>`
    : input.photoInWitness
      ? `<tr><td class="pad" style="padding:0 32px 32px 32px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.muted};">${link(input.links.open, 'See the photo in Witness')}</td></tr>`
      : '';

  const quoteBlock = input.quote
    ? `<div style="font-family:${SERIF};font-size:60px;line-height:44px;height:44px;color:${C.coral};">&ldquo;</div>
  <div class="quote" style="font-family:${SERIF};font-style:italic;font-weight:400;font-size:30px;line-height:40px;color:${C.cream};">${escapeMultiline(input.quote)}</div>`
    : '';

  const chosen = input.chosenOn
    ? `You chose this schedule on ${escapeHtml(input.chosenOn)}. ${link(input.links.settings, 'Change it any time')}, or ${link(input.links.stop, 'stop these emails')}.`
    : `You asked Witness to send this one. ${link(input.links.settings, 'Change your schedule any time')}, or ${link(input.links.stop, 'stop these emails')}.`;

  const rows = `${hairline()}
<tr><td class="pad" style="padding:40px 32px 28px 32px;">
  ${quoteBlock}
  <div style="margin-top:24px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.muted};">${escapeHtml(input.attribution)}</div>
</td></tr>
${image}
${hairline()}
<tr><td class="pad" style="padding:22px 32px;font-family:${SANS};font-size:14px;line-height:28px;color:${C.muted};">
  ${link(input.links.skip, 'Skip the next one')}${dot}${link(input.links.pause, 'Pause a week')}${dot}${link(input.links.remove, 'Remove this from Witness')}${
    input.links.block ? `${dot}${link(input.links.block, 'Never save from them')}` : ''
  }${dot}${link(input.links.open, 'Open Witness')}
</td></tr>
${hairline()}
${footerRow([chosen, crisisHtml()])}`;

  const opening = input.chosenOn ? DELIVERY_OPENING : SENT_NOW_OPENING;
  const textLines = deliveryTextOpening(opening);
  if (input.quote) textLines.push(`“${input.quote}”`, '');
  textLines.push(input.attribution, '');
  if (input.imageUrl) textLines.push(`Image: ${input.imageUrl}`, ...(input.quote ? [] : [`See it in Witness: ${input.links.open}`]), '');
  else if (input.photoInWitness) textLines.push(`See the photo in Witness: ${input.links.open}`, '');
  textLines.push(
    `Skip the next one: ${input.links.skip}`,
    `Pause a week: ${input.links.pause}`,
    `Remove this from Witness: ${input.links.remove}`,
    ...(input.links.block ? [`Never save from them: ${input.links.block}`] : []),
    `Open Witness: ${input.links.open}`,
    '',
    input.chosenOn
      ? `You chose this schedule on ${input.chosenOn}. Change it any time: ${input.links.settings}`
      : `You asked Witness to send this one. Change your schedule any time: ${input.links.settings}`,
    `Stop these emails: ${input.links.stop}`,
    CRISIS_LINE,
  );

  return {
    subject,
    html: shell({ title: subject, preheader: opening, rows }),
    text: textLines.join('\n'),
  };
}
