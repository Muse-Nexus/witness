import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { base64UrlEncode, randomBytes } from '../crypto.js';
import { PAGE_REFERRER_POLICY, pageCsp, renderPage, type PageInput } from '../templates/pages.js';
import type { AppContext } from './context.js';

/** Renders a branded page with a fresh CSP nonce. */
export function htmlPage(c: AppContext, input: Omit<PageInput, 'nonce'>, status: ContentfulStatusCode = 200): Response {
  const nonce = base64UrlEncode(randomBytes(16));
  c.header('Content-Security-Policy', pageCsp(nonce));
  c.header('Cache-Control', 'no-store');
  // Not "no-referrer": with it, browsers send `Origin: null` when these pages submit
  // their own form (sign-in, delivery actions), and the sign-in POST refuses a missing
  // same-site Origin. "strict-origin" still never sends a path or query (tokens) anywhere.
  c.header('Referrer-Policy', PAGE_REFERRER_POLICY);
  return c.html(renderPage({ ...input, nonce }), status);
}
