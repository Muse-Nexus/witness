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
    throw badRequest(issue ? plainIssue(issue, value) : 'That request is not one Witness can read.');
  }
  return result.data;
}

/** zod's own wording ("Invalid option: expected one of …"), as opposed to a sentence a schema wrote itself. */
const LIBRARY_WORDING = /^(Invalid (input|option|string|number|value)|Too (big|small)|Expected\b|Unrecognized\b)/;

const EXPECTED: Readonly<Record<string, string>> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
};

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}

/**
 * One validation problem as a plain sentence that names the field and what it takes:
 * "sourceType is required: one of text, email, …", "occurredAt must be a whole number.",
 * "fromName can be up to 200 characters." A sentence the schema wrote itself is kept as is.
 */
export function plainIssue(issue: z.core.$ZodIssue, body: unknown): string {
  const field = issue.path.map(String).join('.');
  if (!LIBRARY_WORDING.test(issue.message)) return issue.message;
  if (!field) return 'Send a JSON object, for example {"sourceType": "text", "text": "…"}.';
  const missing = valueAt(body, issue.path) === undefined;
  switch (issue.code) {
    case 'invalid_type':
      return missing ? `${field} is required.` : `${field} must be ${EXPECTED[issue.expected] ?? issue.expected}.`;
    case 'invalid_value': {
      const values = issue.values.map(String).join(', ');
      return missing ? `${field} is required: one of ${values}.` : `${field} must be one of ${values}.`;
    }
    case 'too_big':
      return issue.origin === 'string'
        ? `${field} can be up to ${Number(issue.maximum).toLocaleString('en-US')} characters.`
        : `${field} can be at most ${Number(issue.maximum).toLocaleString('en-US')}.`;
    case 'too_small':
      if (issue.origin === 'string') return Number(issue.minimum) <= 1 ? `${field} cannot be empty.` : `${field} needs at least ${issue.minimum} characters.`;
      return `${field} must be at least ${Number(issue.minimum).toLocaleString('en-US')}.`;
    case 'invalid_format':
      return `${field} is not a valid ${issue.format}.`;
    default:
      return `${field}: ${issue.message}`;
  }
}
