// In-memory stand-in for the core REST API (SPEC §8), enabled with VITE_MOCK_API=1.
// It speaks HTTP-shaped requests and responses so the real typed client is exercised end to end,
// including the CSRF header check. SYNTHETIC data only.
import { buildAgentConfigs } from '../lib/agentConfigs';
import { CSRF_HEADER, type Fetcher } from './client';
import { sampleItems } from './mockData';
import type {
  BlockedSender,
  CreatedToken,
  ForwardingConfirmation,
  InboundAddress,
  Item,
  ItemPatch,
  Me,
  NewItem,
  NewToken,
  PublicConfig,
  Rhythm,
  RhythmSettings,
  Status,
  TokenSummary,
  Weekday,
} from './types';

const DAY = 86_400_000;
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockState {
  /** What `GET /api/v1/config` returns: how this Witness is run. */
  config: PublicConfig;
  signedIn: boolean;
  me: Me;
  items: Item[];
  rhythm: Rhythm;
  tokens: TokenSummary[];
  addresses: InboundAddress[];
  blocked: BlockedSender[];
  confirmation: ForwardingConfirmation | null;
  confirmationPolls: number;
  /** Things that arrived and were not kept (like a newsletter). Like core, they count for a source, not as kept. */
  arrivals: { type: 'email' | 'text' | 'photo'; at: number }[];
  deleted: boolean;
}

export interface MockOptions {
  /** Start with synthetic sample items, keys and settings (default true). */
  seed?: boolean;
  signedIn?: boolean;
  /** Artificial delay per request, to make loading states visible in dev. */
  latencyMs?: number;
  /** The forwarding confirmation appears after this many polls (default 3). `null` never. */
  confirmationAfterPolls?: number | null;
  now?: number;
  appUrl?: string;
  /** What `GET /api/v1/config` says about sign-ups (default 'invite', like the hosted preview). */
  signups?: PublicConfig['signups'];
  /** Whether the optional AI check is on (default false). */
  aiCheck?: boolean;
  /**
   * How many things one search request reads (core reads up to 2,000). A page can then come
   * back empty with a cursor, meaning "nothing in these, more to read". Default: no bound.
   */
  searchScanLimit?: number;
}

export interface MockApi {
  fetch: Fetcher;
  state: MockState;
  calls: MockCall[];
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const errorResponse = (status: number, code: string, message: string) => json(status, { error: { code, message } });

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

function nextRun(rhythm: RhythmSettings, now: number): number | null {
  if (!rhythm.enabled || rhythm.days.length === 0) return null;
  const [h, m] = rhythm.localTime.split(':').map(Number);
  for (let offset = 0; offset < 8; offset++) {
    const d = new Date(now + offset * DAY);
    d.setHours(h ?? 8, m ?? 30, 0, 0);
    const day = WEEKDAYS[d.getDay()] as Weekday;
    if (d.getTime() > now && rhythm.days.includes(day)) return d.getTime();
  }
  return null;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function initialState(options: Required<Pick<MockOptions, 'seed' | 'signedIn' | 'now'>>): MockState {
  const { seed, now } = options;
  const me: Me = {
    email: 'you@example.com',
    displayName: null,
    // Like core: a new account starts in UTC until the person picks a zone for their rhythm.
    timezone: seed ? browserZone() : 'UTC',
    inboundAddress: 'witness+k7m2q9x4pd@in.witness.example.com',
    createdAt: now - 40 * DAY,
  };
  const settings: RhythmSettings = {
    enabled: seed,
    localTime: '08:30',
    days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    timezone: me.timezone,
    channel: 'email',
  };
  return {
    // Like the hosted preview: invite-only, and no AI check.
    config: { signups: 'invite', aiCheck: false },
    signedIn: options.signedIn,
    me,
    items: seed ? sampleItems(now) : [],
    rhythm: { ...settings, consentedAt: seed ? now - 23 * DAY : null, pausedUntil: null, nextAt: nextRun(settings, now) },
    tokens: seed
      ? [
          { id: 'tok_claude', kind: 'agent', label: 'Claude Code', scopes: ['status', 'offer', 'reveal', 'search', 'add', 'pause'], createdAt: now - 14 * DAY, lastUsedAt: now - 3 * 3_600_000, revokedAt: null },
          { id: 'tok_iphone', kind: 'device', label: 'iPhone', scopes: ['capture'], createdAt: now - 21 * DAY, lastUsedAt: now - 5 * DAY, revokedAt: null },
        ]
      : [],
    addresses: [
      { address: me.email, verifiedAt: me.createdAt, isAccountEmail: true },
      ...(seed ? [{ address: 'you@work.example.com', verifiedAt: now - 30 * DAY, isAccountEmail: false }] : []),
    ],
    blocked: seed ? [{ senderKey: 'snd_3f9a', createdAt: now - 12 * DAY, label: 'Tom R.' }] : [],
    confirmation: null,
    confirmationPolls: 0,
    arrivals: [],
    deleted: false,
  };
}

function statusOf(state: MockState, now: number): Status {
  const saved = state.items.filter((i) => i.status === 'saved');
  const maybe = state.items.filter((i) => i.status === 'maybe');
  const sources = (['email', 'text', 'photo'] as const)
    .map((type) => {
      const times = [...state.items.filter((i) => i.sourceType === type).map((i) => i.createdAt), ...state.arrivals.filter((a) => a.type === type).map((a) => a.at)];
      const lastAt = times.length ? Math.max(...times) : null;
      return { type, lastAt, count7d: times.filter((t) => t > now - 7 * DAY).length };
    })
    .filter((s) => s.lastAt !== null);
  const last = state.items.length ? Math.max(...state.items.map((i) => i.createdAt)) : null;
  return {
    saved: saved.length,
    maybe: maybe.length,
    lastCapturedAt: last,
    sources,
    rhythm: { enabled: state.rhythm.enabled, nextAt: state.rhythm.nextAt ?? null, pausedUntil: state.rhythm.pausedUntil ?? null },
  };
}

export function createMockApi(options: MockOptions = {}): MockApi {
  const now = options.now ?? Date.now();
  const appUrl = options.appUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  const confirmAfter = options.confirmationAfterPolls === undefined ? 3 : options.confirmationAfterPolls;
  /** When "Send one now" last sent each item (core keeps this as last_delivered_at). */
  const sentAt = new Map<string, number>();
  const state = initialState({ seed: options.seed ?? true, signedIn: options.signedIn ?? true, now });
  if (options.signups) state.config.signups = options.signups;
  if (options.aiCheck != null) state.config.aiCheck = options.aiCheck;
  const calls: MockCall[] = [];

  function route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    const clock = Date.now();

    if (method === 'POST' && path === '/api/v1/auth/start') return json(200, { ok: true });
    if (method === 'GET' && path === '/api/v1/config') return json(200, state.config);
    if (!state.signedIn) return errorResponse(401, 'unauthorized', 'Sign in to continue.');

    if (path === '/api/v1/auth/logout' && method === 'POST') {
      state.signedIn = false;
      return json(200, { ok: true });
    }
    if (path === '/api/v1/me') {
      if (method === 'GET') return json(200, state.me);
      if (method === 'PATCH') {
        Object.assign(state.me, body as object);
        return json(200, state.me);
      }
    }
    if (path === '/api/v1/status' && method === 'GET') return json(200, statusOf(state, clock));

    if (path === '/api/v1/items') {
      if (method === 'GET') {
        const status = url.searchParams.get('status') ?? 'saved';
        const q = url.searchParams.get('q')?.toLowerCase();
        const limit = Number(url.searchParams.get('limit') ?? 30);
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const all = state.items
          .filter((i) => i.status === status)
          // Like core: newest first by when it happened, or when it was kept.
          .sort((a, b) => (b.occurredAt ?? b.createdAt) - (a.occurredAt ?? a.createdAt) || (a.id < b.id ? 1 : -1));
        if (!q) {
          const next = offset + limit < all.length ? String(offset + limit) : null;
          return json(200, { items: all.slice(offset, offset + limit), nextCursor: next });
        }
        // Like core: the words, the name, the email subject and where it came from, never the kind,
        // read a bounded number at a time, so a page can be empty with more still to read.
        const matches = (i: Item) => [i.quote, i.fromName, i.context, i.sourceLabel].some((v) => v?.toLowerCase().includes(q));
        const bound = options.searchScanLimit ?? Infinity;
        const found: Item[] = [];
        let at = offset;
        while (at < all.length && found.length < limit && at - offset < bound) {
          const item = all[at];
          if (item && matches(item)) found.push(item);
          at += 1;
        }
        return json(200, { items: found, nextCursor: at < all.length ? String(at) : null });
      }
      if (method === 'POST') {
        const input = body as NewItem;
        if (!input.quote && !input.image) return errorResponse(400, 'empty', 'Add some words or an image.');
        if (input.quote && state.items.some((i) => i.sourceType === 'manual' && i.quote?.trim().toLowerCase() === input.quote?.trim().toLowerCase())) {
          return errorResponse(409, 'duplicate', 'Witness already has that one.');
        }
        const kind = input.image ? (input.quote ? 'mixed' : 'image') : 'text';
        const created: Item = {
          id: randomId('itm_'),
          status: 'saved',
          kind,
          quote: input.quote ?? null,
          context: null,
          fromName: input.fromName ?? null,
          occurredAt: input.occurredAt ?? null,
          sourceType: 'manual',
          sourceLabel: 'Added by you',
          category: 'other',
          // Like core: a hand-add is not sorted until the person picks a label.
          categoryKnown: false,
          edited: false,
          mediaType: input.image?.mediaType ?? null,
          mediaUrl: input.image ? `data:${input.image.mediaType};base64,${input.image.base64}` : null,
          canBlockSender: false,
          createdAt: clock,
          updatedAt: clock,
        };
        state.items.unshift(created);
        return json(201, created);
      }
    }

    const itemMatch = /^\/api\/v1\/items\/([^/]+)(\/block-sender|\/sender)?$/.exec(path);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1] as string);
      const found = state.items.find((i) => i.id === id);
      if (!found) return errorResponse(404, 'not_found', 'That item is not here.');
      // Like core: the mock matches a sender by name and source.
      const fromSender = () => state.items.filter((i) => i.id === id || (found.fromName && i.fromName === found.fromName && i.sourceType === found.sourceType));
      if (itemMatch[2] === '/sender' && method === 'GET') {
        if (found.canBlockSender === false) return errorResponse(409, 'no_sender', 'Witness does not know who sent this one, so it cannot block them.');
        return json(200, { count: fromSender().length, fromName: found.fromName });
      }
      if (itemMatch[2] === '/block-sender' && method === 'POST') {
        if (found.canBlockSender === false) return errorResponse(409, 'no_sender', 'Witness does not know who sent this one, so it cannot block them.');
        state.blocked.push({ senderKey: randomId('snd_'), createdAt: clock, label: found.fromName });
        if ((body as { removeExisting?: boolean } | undefined)?.removeExisting === false) return json(200, { ok: true, removed: 0, removedIds: [] });
        const removedIds = fromSender().map((i) => i.id);
        state.items = state.items.filter((i) => !removedIds.includes(i.id));
        return json(200, { ok: true, removed: removedIds.length, removedIds });
      }
      if (method === 'PATCH') {
        const patch = body as ItemPatch;
        if (patch.quote !== undefined && patch.quote !== found.quote) found.edited = true;
        Object.assign(found, patch, { updatedAt: clock }, patch.category ? { categoryKnown: true } : {});
        return json(200, found);
      }
      if (method === 'DELETE') {
        state.items = state.items.filter((i) => i.id !== id);
        return json(200, { ok: true });
      }
    }

    if (path === '/api/v1/rhythm') {
      if (method === 'GET') return json(200, state.rhythm);
      if (method === 'PUT') {
        const settings = body as RhythmSettings;
        const consentedAt = settings.enabled && !state.rhythm.enabled ? clock : state.rhythm.consentedAt;
        state.rhythm = { ...state.rhythm, ...settings, consentedAt, nextAt: nextRun(settings, clock) };
        // Like core: the zone chosen for the rhythm becomes the account's zone.
        state.me.timezone = settings.timezone;
        return json(200, state.rhythm);
      }
    }
    if (path === '/api/v1/rhythm/pause' && method === 'POST') {
      const days = Number((body as { days?: unknown })?.days);
      if (!Number.isInteger(days) || days < 1 || days > 90) return errorResponse(400, 'invalid_days', 'Choose between 1 and 90 days.');
      state.rhythm = { ...state.rhythm, pausedUntil: clock + days * DAY };
      return json(200, state.rhythm);
    }
    if (path === '/api/v1/rhythm/resume' && method === 'POST') {
      state.rhythm = { ...state.rhythm, pausedUntil: null };
      return json(200, state.rhythm);
    }
    if (path === '/api/v1/rhythm/send-now' && method === 'POST') {
      // Like core: a saved item sent in the last 30 days waits before it is sent again.
      const saved = state.items.filter((i) => i.status === 'saved');
      const ready = saved.find((i) => clock - (sentAt.get(i.id) ?? -Infinity) >= 30 * DAY);
      if (ready) {
        sentAt.set(ready.id, clock);
        return json(200, { sent: true });
      }
      return json(200, { sent: false, reason: saved.length === 0 ? 'nothing_qualifies' : 'all_recent' });
    }

    if (path === '/api/v1/tokens') {
      if (method === 'GET') return json(200, { tokens: state.tokens.filter((t) => !t.revokedAt) });
      if (method === 'POST') {
        const input = body as NewToken;
        const token = `${input.kind === 'agent' ? 'wit_agent_' : 'wit_dev_'}${randomId('')}${randomId('')}`;
        const summary: TokenSummary = {
          id: randomId('tok_'),
          kind: input.kind,
          label: input.label,
          scopes: input.scopes ?? (input.kind === 'agent' ? ['status', 'offer', 'reveal', 'add', 'pause'] : ['capture', 'status']),
          createdAt: clock,
          lastUsedAt: null,
          revokedAt: null,
        };
        state.tokens.push(summary);
        const captureUrl = `${appUrl.replace(/\/+$/, '')}/api/v1/capture`;
        const agent = buildAgentConfigs(appUrl, token);
        // Same shape as core: assistants get the four configs, devices the capture address (+ a status check).
        const configs =
          input.kind === 'agent'
            ? { ...agent, mcpUrl: `${appUrl.replace(/\/+$/, '')}/mcp`, captureUrl }
            : summary.scopes.includes('status')
              ? { captureUrl, curl: agent.curl }
              : { captureUrl };
        const created: CreatedToken = { ...summary, token, configs };
        return json(201, created);
      }
    }
    const tokenMatch = /^\/api\/v1\/tokens\/([^/]+)$/.exec(path);
    if (tokenMatch && method === 'DELETE') {
      const id = decodeURIComponent(tokenMatch[1] as string);
      state.tokens = state.tokens.map((t) => (t.id === id ? { ...t, revokedAt: clock } : t));
      return json(200, { ok: true });
    }

    if (path === '/api/v1/addresses') {
      if (method === 'GET') return json(200, { addresses: state.addresses });
      const address = String((body as { address?: unknown })?.address ?? '').toLowerCase();
      if (method === 'POST') {
        const added = { address, verifiedAt: clock, isAccountEmail: address === state.me.email };
        state.addresses = [...state.addresses.filter((a) => a.address !== address), added];
        return json(201, added);
      }
      if (method === 'DELETE') {
        if (address === state.me.email) return errorResponse(409, 'account_email', 'Your account email always stays on the list.');
        state.addresses = state.addresses.filter((a) => a.address !== address);
        return json(200, { addresses: state.addresses });
      }
    }

    if (path === '/api/v1/inbound/confirmations' && method === 'GET') {
      state.confirmationPolls++;
      if (!state.confirmation && confirmAfter !== null && state.confirmationPolls >= confirmAfter) {
        state.confirmation = {
          provider: 'gmail',
          url: 'https://mail-settings.google.com/mail/vf-example-confirmation',
          code: '104729338',
          receivedAt: clock,
        };
      }
      const wanted = url.searchParams.get('provider');
      return json(200, state.confirmation && (!wanted || state.confirmation.provider === wanted) ? state.confirmation : null);
    }

    if (path === '/api/v1/blocked-senders' && method === 'GET') return json(200, { senders: state.blocked });
    if (path === '/api/v1/blocked-senders' && method === 'POST') {
      const { handle, label } = body as { handle?: string; label?: string };
      if (!handle || handle.trim().length < 3) return errorResponse(400, 'invalid_handle', 'Enter a phone number or an email address.');
      const added = { senderKey: randomId('snd_'), createdAt: clock, label: label?.trim() || null };
      state.blocked.push(added);
      return json(201, added);
    }
    if (path === '/api/v1/me/inbound-address' && method === 'POST') {
      state.me = { ...state.me, inboundAddress: `witness+${randomId('').replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(10, 'q')}@in.witness.example.com` };
      return json(200, state.me);
    }
    const blockedMatch = /^\/api\/v1\/blocked-senders\/([^/]+)$/.exec(path);
    if (blockedMatch && method === 'DELETE') {
      const key = decodeURIComponent(blockedMatch[1] as string);
      state.blocked = state.blocked.filter((b) => b.senderKey !== key);
      return json(200, { ok: true });
    }

    if (path === '/api/v1/export' && method === 'GET') {
      return json(200, { exportedAt: clock, me: state.me, items: state.items, rhythm: state.rhythm });
    }
    if (path === '/api/v1/account' && method === 'DELETE') {
      Object.assign(state, initialState({ seed: false, signedIn: false, now: clock }), { deleted: true });
      return json(200, { deleted: true });
    }

    return errorResponse(404, 'not_found', `No mock route for ${method} ${path}`);
  }

  const fetcher: Fetcher = async (input, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = new URL(input, 'http://mock.local');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body, headers });

    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    if (method !== 'GET' && headers[CSRF_HEADER.toLowerCase()] !== '1') {
      return errorResponse(403, 'csrf', 'Missing CSRF header.');
    }
    return route(method, url, body);
  };

  return { fetch: fetcher, state, calls };
}
