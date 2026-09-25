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

/** What a validation error calls the value itself (a path parameter), or shows as an example body. */
export interface ValueHint {
  /** The value's name, for a value that is not an object ("address", not the whole body). */
  name?: string;
  /** A body this route takes, shown when what was sent is not a JSON object at all. */
  example?: string;
}

/** Reads and validates a JSON body. Size limits are enforced separately by bodyLimit. */
export async function jsonBody<S extends z.ZodType>(c: AppContext, schema: S, hint: ValueHint = {}): Promise<z.infer<S>> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('The request body is not valid JSON.');
  }
  return parseWith(schema, raw, hint);
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, hint: ValueHint = {}): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(issue ? plainIssue(issue, value, hint) : UNREADABLE);
  }
  return result.data;
}

const UNREADABLE = 'That request is not one Witness can read.';

/** zod's own wording ("Invalid option: expected one of …"), as opposed to a sentence a schema wrote itself. */
const LIBRARY_WORDING = /^(Invalid\b|Too (big|small)|Expected\b|Unrecognized\b)/;

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

/** A field name as sent, quoted and cut short: it is the caller's own, and could be anything. */
const quotedKey = (key: string): string => JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}…` : key);

/**
 * One validation problem as a plain sentence that names the field and what it takes:
 * "sourceType is required: one of text, email, …", "occurredAt must be a whole number.",
 * "fromName can be up to 200 characters.", '"displayname" is not a field Witness takes
 * here.' A sentence the schema wrote itself is kept as is. Nothing here is about one route:
 * `hint` names a bare value or gives the route's own example body.
 */
export function plainIssue(issue: z.core.$ZodIssue, body: unknown, hint: ValueHint = {}): string {
  const field = issue.path.map(String).join('.') || hint.name || '';
  if (!LIBRARY_WORDING.test(issue.message)) return issue.message;
  if (issue.code === 'unrecognized_keys') {
    const prefix = issue.path.length > 0 ? `${issue.path.map(String).join('.')}.` : '';
    const keys = issue.keys.slice(0, 3).map((k) => quotedKey(prefix + k));
    const list = keys.join(', ') + (issue.keys.length > keys.length ? ', …' : '');
    return issue.keys.length === 1
      ? `${list} is not a field Witness takes here. Check its spelling, or leave it out.`
      : `${list} are not fields Witness takes here. Check their spelling, or leave them out.`;
  }
  if (!field) {
    const notAnObject = body === null || typeof body !== 'object' || Array.isArray(body);
    if (!notAnObject) return UNREADABLE;
    return hint.example ? `Send a JSON object, for example ${hint.example}.` : 'Send a JSON object.';
  }
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
