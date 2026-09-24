import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppContext, HonoEnv } from './context.js';
import { ApiError, badRequest } from './errors.js';

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Headers for every response this Worker renders itself (JSON, pages, media).
 * Static web-app files are served by the assets layer and carry their own headers.
 */
export const securityHeaders: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', API_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  // Links carry tokens; never leak them to other sites. Pages set their own
  // (origin-only) policy so their form posts carry a real Origin.
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'no-referrer');
  // Signed media links set their own policy so mail clients can load the image.
  if (!h.has('Cross-Origin-Resource-Policy')) h.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  if (new URL(c.req.url).protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
};

/** Reads and validates a JSON body. Size limits are enforced separately by bodyLimit. */
export async function jsonBody<S extends z.ZodType>(c: AppContext, schema: S): Promise<z.infer<S>> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
  return parseWith(schema, raw);
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${where}${issue?.message ?? 'Invalid request.'}`);
  }
  return result.data;
}
