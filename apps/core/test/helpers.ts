/** Test helpers. All people, addresses and messages here are fictional (example.com, 555-01xx). */
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { Keyring } from '../src/crypto.js';
import type { AppEnv } from '../src/env.js';

export const ORIGIN = 'http://localhost:8787';
export const testEnv: AppEnv = env;

export function keyring(): Keyring {
  return Keyring.fromSecret(env.WITNESS_MASTER_KEY);
}

let visitor = 0;

/** A fresh address from the IPv6 documentation range (2001:db8::/32), in its own /64 (rate limits group by /64). */
export function randomTestIp(): string {
  visitor += 1;
  return `2001:db8:${crypto.randomUUID().slice(0, 4)}:${visitor.toString(16)}::1`;
}

export function uniqueEmail(prefix = 'person'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(new URL(path, ORIGIN), init));
}

export interface Session {
  email: string;
  cookie: string;
  userId: string;
}

/** Headers for a cookie-authenticated request, including the CSRF header and Origin for mutations. */
export function asUser(session: Session, init: { method?: string; body?: unknown } = {}): RequestInit {
  const headers: Record<string, string> = { Cookie: session.cookie };
  if (init.method && init.method !== 'GET') {
    headers['X-Witness-CSRF'] = '1';
    headers.Origin = ORIGIN;
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) };
}

export function withBearer(token: string, init: { method?: string; body?: unknown } = {}): RequestInit {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) };
}

interface OutboxMessage {
  kind: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export async function outbox(): Promise<OutboxMessage[]> {
  const res = await call('/api/v1/dev/outbox');
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: OutboxMessage[] }).messages;
}

/** Waits for background work (the sign-in mail is sent from waitUntil). */
export async function waitForMail(to: string, kind: string, count = 1): Promise<OutboxMessage[]> {
  for (let i = 0; i < 100; i += 1) {
    const found = (await outbox()).filter((m) => m.to === to && m.kind === kind);
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${kind} mail for ${to}`);
}

/** Asks for a sign-in link; also returns the pre-auth cookie that ties it to this "browser". */
export async function requestLinkWithCookie(email: string): Promise<{ token: string; preauth: string }> {
  const before = (await outbox()).filter((m) => m.to === email && m.kind === 'magic_link').length;
  const res = await call('/api/v1/auth/start', {
    method: 'POST',
    // Each test sign-in looks like a different visitor, so the per-IP limit stays out of the way.
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomTestIp() },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  const preauth = /wit_pre=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1];
  if (!preauth) throw new Error('no pre-auth cookie');
  const [latest] = await waitForMail(email, 'magic_link', before + 1);
  const token = /token=(wit_link_[A-Za-z0-9_-]+)/.exec(latest!.text)?.[1];
  if (!token) throw new Error('no token in sign-in mail');
  return { token, preauth: `wit_pre=${preauth}` };
}

export async function requestLink(email: string): Promise<string> {
  return (await requestLinkWithCookie(email)).token;
}

/** Uses a link the way a person does from another device: after reading whose account it is ("Continue as …"). */
export async function consumeLink(token: string, extra: Record<string, string> = { confirm: '1' }): Promise<Response> {
  return call('/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams({ token, ...extra }).toString(),
    redirect: 'manual',
  });
}

export async function signIn(email = uniqueEmail()): Promise<Session> {
  const token = await requestLink(email);
  const res = await consumeLink(token);
  expect(res.status).toBe(303);
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  const value = /wit_session=([^;]+)/.exec(setCookie)?.[1];
  if (!value) throw new Error('no session cookie');
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  return { email, cookie: `wit_session=${value}`, userId: row!.id };
}

export async function createToken(session: Session, kind: 'agent' | 'device', scopes?: string[], label = 'Test assistant'): Promise<string> {
  const res = await call('/api/v1/tokens', asUser(session, { method: 'POST', body: { kind, label, ...(scopes ? { scopes } : {}) } }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

export async function addManual(session: Session, body: Record<string, unknown>): Promise<string> {
  const res = await call('/api/v1/items', asUser(session, { method: 'POST', body }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** The words a person would read on a rendered page or email (no markup, styles or scripts). */
export function visibleText(html: string): string {
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/</g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A tiny valid PNG (1x1, synthetic). */
export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
