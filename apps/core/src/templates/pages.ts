/**
 * Small server-rendered pages: delivery-link confirmations (/d?t=) and the
 * sign-in hand-off (/auth/callback). Dark by default, light when the device
 * asks for it. Inline style and script carry a per-response CSP nonce.
 */
import { FONTS_HREF, STUDIO_FOOTER, escapeHtml } from './brand.js';

/** Origin only, never a path or query (links carry tokens), and a real Origin on form posts. */
export const PAGE_REFERRER_POLICY = 'strict-origin';

export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${nonce}'`,
    "img-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const STYLES = `
:root {
  --bg: oklch(0% 0 0);
  --fg: oklch(96.5% .016 90);
  --coral: oklch(71% .17 25);
  --on-coral: oklch(8% 0 0);
  --muted: color-mix(in oklab, var(--fg) 70%, var(--bg));
  --hairline: color-mix(in oklab, var(--fg) 14%, transparent);
  color-scheme: dark light;
}
@media (prefers-color-scheme: light) {
  :root { --bg: oklch(96.5% .016 90); --fg: oklch(0% 0 0); --coral: #ad4238; --on-coral: #f7f0e3; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 400 17px/1.6 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 48px 24px 40px; min-height: 100vh; display: flex; flex-direction: column; }
.mark { display: flex; flex-direction: column; gap: 2px; margin-bottom: 40px; }
.eyebrow { font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: var(--muted); margin: 0; }
.cursor { color: var(--coral); margin-right: .4em; }
.word { font-family: Fraunces, Georgia, serif; font-size: 30px; line-height: 1.1; }
.dot { color: var(--coral); }
section { border-top: 1px solid var(--hairline); padding-top: 32px; flex: 1; }
h1 { font-family: Fraunces, Georgia, serif; font-weight: 400; font-size: 34px; line-height: 1.2; margin: 12px 0 16px; }
p { margin: 0 0 16px; }
.muted { color: var(--muted); }
form { margin: 28px 0 8px; }
button, .button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 26px;
  border: 0; border-radius: 999px; background: var(--coral); color: var(--on-coral);
  font: 600 16px/1 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  text-decoration: none; cursor: pointer;
}
a { color: var(--fg); text-underline-offset: 3px; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--coral); outline-offset: 3px; }
.links { margin-top: 24px; }
.links a { display: inline-block; min-height: 44px; line-height: 44px; }
footer { border-top: 1px solid var(--hairline); margin-top: 48px; padding-top: 20px; font-size: 13px; color: var(--muted); }
footer p { margin: 0 0 8px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

export interface PageInput {
  nonce: string;
  title: string;
  eyebrow: string;
  heading: string;
  paragraphs: string[];
  /** A POST form with one button. `hidden` fields are added as hidden inputs. */
  form?: { action: string; button: string; hidden?: Record<string, string>; autoSubmit?: boolean };
  links?: { href: string; label: string }[];
}

export function renderPage(input: PageInput): string {
  const form = input.form
    ? `<form method="post" action="${escapeHtml(input.form.action)}" id="primary">
  ${Object.entries(input.form.hidden ?? {})
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n  ')}
  <button type="submit">${escapeHtml(input.form.button)}</button>
</form>`
    : '';
  const autoSubmit = input.form?.autoSubmit
    ? `<script nonce="${input.nonce}">document.getElementById('primary').submit();</script>`
    : '';
  const links = input.links?.length
    ? `<p class="links">${input.links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join(' &middot; ')}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="${PAGE_REFERRER_POLICY}">
<title>${escapeHtml(input.title)} · Muse Nexus Witness</title>
<link rel="stylesheet" href="${FONTS_HREF}">
<style nonce="${input.nonce}">${STYLES}</style>
</head>
<body>
<main>
  <header class="mark" aria-label="Muse Nexus Witness">
    <p class="eyebrow">Muse Nexus</p>
    <span class="word">Witness<span class="dot">.</span></span>
  </header>
  <section>
    <p class="eyebrow"><span class="cursor" aria-hidden="true">&#9613;</span>${escapeHtml(input.eyebrow)}</p>
    <h1>${escapeHtml(input.heading)}</h1>
    ${input.paragraphs.map((p) => `<p class="muted">${escapeHtml(p)}</p>`).join('\n    ')}
    ${form}
    ${links}
  </section>
  <footer>
    <p>If you are in crisis, call or text <a href="tel:988">988</a> (US) or visit <a href="https://findahelpline.com">findahelpline.com</a>.</p>
    <p>${escapeHtml(STUDIO_FOOTER)}</p>
  </footer>
</main>
${autoSubmit}
</body>
</html>`;
}
