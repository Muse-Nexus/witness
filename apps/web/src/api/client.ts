import type {
  BlockSenderResult,
  SenderCount,
  BlockedSender,
  CreatedToken,
  ForwardingConfirmation,
  InboundAddress,
  Item,
  ItemPage,
  ItemPatch,
  ItemQuery,
  Me,
  MePatch,
  NewItem,
  NewToken,
  PublicConfig,
  Rhythm,
  RhythmSettings,
  SendNowResult,
  Status,
  TokenSummary,
} from './types';

export * from './types';

/** The subset of `fetch` the client needs. Swapped for the in-memory mock in dev and tests. */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export const EXPORT_PATH = '/api/v1/export';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const CSRF_HEADER = 'X-Witness-CSRF';

export function mediaUrlFor(item: Pick<Item, 'id' | 'mediaType' | 'mediaUrl'>): string | null {
  if (!item.mediaType) return null;
  return item.mediaUrl ?? `/api/v1/items/${encodeURIComponent(item.id)}/media`;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorFrom(status: number, body: unknown): ApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : `http_${status}`;
  const message =
    typeof error?.message === 'string' ? error.message : 'That did not go through. Try again in a moment.';
  return new ApiError(status, code, message);
}

export function createClient(fetcher: Fetcher = (input, init) => fetch(input, init)) {
  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Core rejects cookie-authenticated mutations without this header (SPEC §8).
    if (method !== 'GET') headers[CSRF_HEADER] = '1';
    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetcher(path, init);
    } catch {
      throw new ApiError(0, 'network', 'Witness could not be reached. Check your connection and try again.');
    }
    const data = await readBody(res);
    if (!res.ok) throw errorFrom(res.status, data);
    return data as T;
  }

  return {
    // Auth
    startSignIn: (email: string) => request<unknown>('POST', '/api/v1/auth/start', { email }),
    /** Public and content-free: whether sign-ups are open, and whether the AI check is on. */
    config: () => request<PublicConfig>('GET', '/api/v1/config'),
    signOut: () => request<unknown>('POST', '/api/v1/auth/logout'),

    // Account
    me: () => request<Me>('GET', '/api/v1/me'),
    updateMe: (patch: MePatch) => request<Me>('PATCH', '/api/v1/me', patch),
    /** A new Witness address; the old one stops working at once. */
    newInboundAddress: () => request<Me>('POST', '/api/v1/me/inbound-address'),
    status: () => request<Status>('GET', '/api/v1/status'),

    // Items
    listItems: (query: ItemQuery = {}) =>
      request<ItemPage>(
        'GET',
        `/api/v1/items${queryString({ status: query.status, cursor: query.cursor, limit: query.limit, q: query.q })}`,
      ),
    addItem: (item: NewItem) => request<Item>('POST', '/api/v1/items', item),
    updateItem: (id: string, patch: ItemPatch) =>
      request<Item>('PATCH', `/api/v1/items/${encodeURIComponent(id)}`, patch),
    deleteItem: (id: string) => request<unknown>('DELETE', `/api/v1/items/${encodeURIComponent(id)}`),
    /** `removeExisting: false` stops new saves and keeps what is already here. */
    blockSender: async (id: string, options: { removeExisting?: boolean } = {}): Promise<BlockSenderResult> =>
      (await request<BlockSenderResult | null>(
        'POST',
        `/api/v1/items/${encodeURIComponent(id)}/block-sender`,
        options.removeExisting === undefined ? undefined : { removeExisting: options.removeExisting },
      )) ?? {},
    senderCount: (id: string) => request<SenderCount>('GET', `/api/v1/items/${encodeURIComponent(id)}/sender`),

    // Rhythm
    rhythm: () => request<Rhythm>('GET', '/api/v1/rhythm'),
    saveRhythm: (settings: RhythmSettings) => request<Rhythm>('PUT', '/api/v1/rhythm', settings),
    pause: (days: number) => request<Rhythm>('POST', '/api/v1/rhythm/pause', { days }),
    resume: () => request<Rhythm>('POST', '/api/v1/rhythm/resume'),
    sendNow: () => request<SendNowResult>('POST', '/api/v1/rhythm/send-now'),

    // Assistants and devices
    tokens: async () => (await request<{ tokens: TokenSummary[] }>('GET', '/api/v1/tokens')).tokens,
    createToken: (input: NewToken) => request<CreatedToken>('POST', '/api/v1/tokens', input),
    revokeToken: (id: string) => request<unknown>('DELETE', `/api/v1/tokens/${encodeURIComponent(id)}`),

    // Inbound email
    addresses: async () =>
      (await request<{ addresses: InboundAddress[] }>('GET', '/api/v1/addresses')).addresses,
    addAddress: (address: string) => request<InboundAddress>('POST', '/api/v1/addresses', { address }),
    removeAddress: (address: string) => request<unknown>('DELETE', '/api/v1/addresses', { address }),
    /** The newest forwarding confirmation from the last day, for one provider when given. */
    latestConfirmation: async (provider?: ForwardingConfirmation['provider']): Promise<ForwardingConfirmation | null> => {
      const body = await request<ForwardingConfirmation | { confirmation: null } | null>(
        'GET',
        `/api/v1/inbound/confirmations${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`,
      );
      return body && 'provider' in body ? body : null;
    },

    // Never save from
    blockedSenders: async () =>
      (await request<{ senders: BlockedSender[] }>('GET', '/api/v1/blocked-senders')).senders,
    /** Block a phone number or address before anything from it arrives. */
    blockHandle: (handle: string, label?: string) =>
      request<BlockedSender>('POST', '/api/v1/blocked-senders', { handle, ...(label ? { label } : {}) }),
    unblockSender: (senderKey: string) =>
      request<unknown>('DELETE', `/api/v1/blocked-senders/${encodeURIComponent(senderKey)}`),

    // Your data
    deleteAccount: () => request<unknown>('DELETE', '/api/v1/account'),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
