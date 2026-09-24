/**
 * Uniform JSON errors: `{ "error": { "code": string, "message": string } }` (SPEC §8).
 * Messages are written for people: plain, calm, no blame.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export const unauthorized = (message = 'Sign in to continue.') =>
  new ApiError(401, 'unauthorized', message, { 'WWW-Authenticate': 'Bearer realm="witness"' });

export const forbidden = (message = 'This is not allowed with the current sign-in.') => new ApiError(403, 'forbidden', message);

export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);

export const badRequest = (message: string, code = 'invalid_request') => new ApiError(400, code, message);

export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError(429, 'rate_limited', 'Too many requests. Try again in a little while.', {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });
