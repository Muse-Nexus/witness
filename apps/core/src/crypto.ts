/**
 * Encryption, hashing and signing (docs/dev/SPEC.md §7). WebCrypto only.
 *
 * - WITNESS_MASTER_KEY: 32 random bytes, base64.
 * - Per-user data key: HKDF-SHA256(master, salt = utf8(user_id), info = "witness:data:v1") -> AES-GCM-256.
 * - Text ciphertext: "v1.<base64url iv (12 bytes)>.<base64url ciphertext+tag>".
 * - Media: whole-object AES-GCM with the same per-user key, stored as iv (12 bytes) || ciphertext+tag.
 * - Sender key: hex HMAC-SHA256(HKDF(master, info = "witness:sender:v1"), user_id + ":" + normalizedHandle).
 * - Signed links: HMAC-SHA256(HKDF(master, info = "witness:link:v1"), payload), base64url.
 * - Dedupe keys: hex HMAC-SHA256(HKDF(master, info = "witness:dedupe:v1"), user_id + ":" + source_type + ":" + basis).
 * - Tokens: prefix + base64url(32 random bytes); only the SHA-256 hex is stored.
 *
 * HKDF for the sender and link keys uses an empty salt (the spec names only the info string).
 */
import { ConfigError } from './env.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new CryptoFormatError('not base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return base64Decode(padded);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export class CryptoFormatError extends Error {
  override name = 'CryptoFormatError';
}

// ---------------------------------------------------------------------------
// Random values, hashing, tokens
// ---------------------------------------------------------------------------

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export type TokenPrefix = 'wit_sess_' | 'wit_link_' | 'wit_agent_' | 'wit_dev_';

export function newToken(prefix: TokenPrefix): string {
  return prefix + base64UrlEncode(randomBytes(32));
}

/** Tokens are stored as SHA-256 hex only. Lookups are by hash, so no secret comparison happens in code. */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Unguessable inbound address local part: 10 lowercase letters and digits (~51 bits). */
export function newInboundSlug(): string {
  let out = '';
  while (out.length < 10) {
    for (const b of randomBytes(16)) {
      // 252 = 7 * 36: reject the tail so every character is equally likely.
      if (b < 252 && out.length < 10) out += SLUG_ALPHABET[b % 36];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyring
// ---------------------------------------------------------------------------

const DATA_INFO = 'witness:data:v1';
const SENDER_INFO = 'witness:sender:v1';
const LINK_INFO = 'witness:link:v1';
const DEDUPE_INFO = 'witness:dedupe:v1';
const RATE_LIMIT_INFO = 'witness:ratelimit:v1';
const IV_BYTES = 12;

/**
 * Derived keys are pure functions of the master secret, so caching them across
 * requests is safe and saves a few WebCrypto calls per request.
 */
const keyringCache = new Map<string, Keyring>();

export class Keyring {
  private readonly dataKeys = new Map<string, Promise<CryptoKey>>();
  private senderKeyPromise: Promise<CryptoKey> | undefined;
  private linkKeyPromise: Promise<CryptoKey> | undefined;
  private dedupeKeyPromise: Promise<CryptoKey> | undefined;
  private rateLimitKeyPromise: Promise<CryptoKey> | undefined;

  private constructor(private readonly master: Promise<CryptoKey>) {}

  static fromSecret(secret: string | undefined): Keyring {
    if (!secret) throw new ConfigError('WITNESS_MASTER_KEY is not set');
    const cached = keyringCache.get(secret);
    if (cached) return cached;
    let raw: Uint8Array;
    try {
      raw = base64Decode(secret.trim());
    } catch {
      throw new ConfigError('WITNESS_MASTER_KEY must be base64');
    }
    if (raw.length !== 32) throw new ConfigError('WITNESS_MASTER_KEY must be 32 bytes');
    const master = crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const keyring = new Keyring(master);
    keyringCache.set(secret, keyring);
    return keyring;
  }

  private async derive(salt: Uint8Array, info: string, algorithm: SubtleCryptoImportKeyAlgorithm, usages: string[]): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) },
      await this.master,
      algorithm,
      false,
      usages,
    );
  }

  private dataKey(userId: string): Promise<CryptoKey> {
    let key = this.dataKeys.get(userId);
    if (!key) {
      key = this.derive(encoder.encode(userId), DATA_INFO, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
      if (this.dataKeys.size > 1000) this.dataKeys.clear();
      this.dataKeys.set(userId, key);
    }
    return key;
  }

  private senderKey(): Promise<CryptoKey> {
    this.senderKeyPromise ??= this.derive(new Uint8Array(0), SENDER_INFO, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
    return this.senderKeyPromise;
  }

  private linkKey(): Promise<CryptoKey> {
    this.linkKeyPromise ??= this.derive(new Uint8Array(0), LINK_INFO, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);
    return this.linkKeyPromise;
  }

  async encryptBytes(userId: string, plaintext: Uint8Array): Promise<{ iv: Uint8Array; sealed: Uint8Array }> {
    const iv = randomBytes(IV_BYTES);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.dataKey(userId), plaintext));
    return { iv, sealed };
  }

  async encryptText(userId: string, plaintext: string): Promise<string> {
    const { iv, sealed } = await this.encryptBytes(userId, encoder.encode(plaintext));
    return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(sealed)}`;
  }

  async decryptText(userId: string, ciphertext: string): Promise<string> {
    const parts = ciphertext.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new CryptoFormatError('unknown ciphertext format');
    const iv = base64UrlDecode(parts[1]!);
    if (iv.length !== IV_BYTES) throw new CryptoFormatError('bad iv');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await this.dataKey(userId), base64UrlDecode(parts[2]!));
    return decoder.decode(plain);
  }

  /** Nullable convenience for optional columns. */
  async encryptOptional(userId: string, plaintext: string | null | undefined): Promise<string | null> {
    return plaintext === null || plaintext === undefined || plaintext === '' ? null : this.encryptText(userId, plaintext);
  }

  async decryptOptional(userId: string, ciphertext: string | null | undefined): Promise<string | null> {
    return ciphertext ? this.decryptText(userId, ciphertext) : null;
  }

  /** Media object body: iv || ciphertext+tag. */
  async sealMedia(userId: string, bytes: Uint8Array): Promise<Uint8Array> {
    const { iv, sealed } = await this.encryptBytes(userId, bytes);
    const out = new Uint8Array(IV_BYTES + sealed.length);
    out.set(iv, 0);
    out.set(sealed, IV_BYTES);
    return out;
  }

  async openMedia(userId: string, body: Uint8Array): Promise<Uint8Array> {
    if (body.length <= IV_BYTES) throw new CryptoFormatError('media object too short');
    const iv = body.subarray(0, IV_BYTES);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await this.dataKey(userId), body.subarray(IV_BYTES));
    return new Uint8Array(plain);
  }

  /** HMAC of the normalized sender handle, used for "never save from this sender". */
  async senderKeyFor(userId: string, handle: string): Promise<string | null> {
    const normalized = normalizeHandle(handle);
    if (!normalized) return null;
    const mac = await crypto.subtle.sign('HMAC', await this.senderKey(), encoder.encode(`${userId}:${normalized}`));
    return toHex(new Uint8Array(mac));
  }

  /**
   * Keyed, per-user dedupe key. Unlike a plain hash of the text, a database copy without
   * the master key cannot be used to confirm a guessed message, and the same words give
   * different keys for different people.
   */
  async dedupeKeyFor(userId: string, sourceType: string, basis: string): Promise<string> {
    this.dedupeKeyPromise ??= this.derive(new Uint8Array(0), DEDUPE_INFO, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', await this.dedupeKeyPromise, encoder.encode(`${userId}:${sourceType}:${basis}`));
    return toHex(new Uint8Array(mac));
  }

  /** Keyed hash for rate-limit counters: an IPv4 address cannot be brute-forced back out of it. */
  async rateLimitKeyFor(value: string): Promise<string> {
    this.rateLimitKeyPromise ??= this.derive(new Uint8Array(0), RATE_LIMIT_INFO, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', await this.rateLimitKeyPromise, encoder.encode(value));
    return toHex(new Uint8Array(mac));
  }

  async signLink(payload: string): Promise<string> {
    const mac = await crypto.subtle.sign('HMAC', await this.linkKey(), encoder.encode(payload));
    return base64UrlEncode(new Uint8Array(mac));
  }

  /** Constant-time verification (crypto.subtle.verify). */
  async verifyLink(payload: string, signature: string): Promise<boolean> {
    let sig: Uint8Array;
    try {
      sig = base64UrlDecode(signature);
    } catch {
      return false;
    }
    if (sig.length !== 32) return false;
    return crypto.subtle.verify('HMAC', await this.linkKey(), sig, encoder.encode(payload));
  }
}

// ---------------------------------------------------------------------------
// Sender handles
// ---------------------------------------------------------------------------

/**
 * Normalizes an email address or phone number so the same person maps to the
 * same sender key across sources. Phone numbers keep digits only, with a
 * leading "+"; 10-digit numbers are assumed to be North American (+1).
 */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase().replace(/^mailto:|^tel:/, '');
  if (!h) return '';
  if (h.includes('@')) return h;
  if (/^[+\d\s().-]+$/.test(h)) {
    const digits = h.replace(/\D/g, '');
    if (!digits) return '';
    if (h.startsWith('+')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return digits;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Signed links
// ---------------------------------------------------------------------------

export const DELIVERY_ACTIONS = ['keep', 'skip', 'pause', 'remove', 'stop', 'block'] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];

export const DELIVERY_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Stopping or pausing must work from any old email, so those links last a year. */
export const LASTING_LINK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function deliveryLinkTtl(action: DeliveryAction): number {
  return action === 'stop' || action === 'pause' ? LASTING_LINK_TTL_MS : DELIVERY_LINK_TTL_MS;
}

/**
 * `<deliveryId>.<action>.<exp>.<sig>`, carried as `/d?t=…` (a query string, which request
 * logs redact) and posted back in the form body. The signed payload is
 * `deliveryId.action.exp` (exp in ms).
 */
export async function signDeliveryToken(keyring: Keyring, deliveryId: string, action: DeliveryAction, now: number): Promise<string> {
  const exp = now + deliveryLinkTtl(action);
  const payload = `${deliveryId}.${action}.${exp}`;
  return `${payload}.${await keyring.signLink(payload)}`;
}

export type DeliveryTokenCheck =
  | { ok: true; deliveryId: string; action: DeliveryAction; exp: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export async function verifyDeliveryToken(keyring: Keyring, token: string, now: number): Promise<DeliveryTokenCheck> {
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [deliveryId, action, expRaw, sig] = parts as [string, string, string, string];
  if (!/^[A-Za-z0-9-]{1,64}$/.test(deliveryId) || !/^\d{1,16}$/.test(expRaw)) return { ok: false, reason: 'malformed' };
  if (!(DELIVERY_ACTIONS as readonly string[]).includes(action)) return { ok: false, reason: 'malformed' };
  if (!(await keyring.verifyLink(`${deliveryId}.${action}.${expRaw}`, sig))) return { ok: false, reason: 'bad_signature' };
  const exp = Number(expRaw);
  if (exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, deliveryId, action: action as DeliveryAction, exp };
}

/** `?sig=<exp>.<mac>` for GET /api/v1/items/:id/media; the signed payload is `itemId.media.exp`. */
export async function signMediaQuery(keyring: Keyring, itemId: string, ttlMs: number, now: number): Promise<string> {
  const exp = now + ttlMs;
  return `${exp}.${await keyring.signLink(`${itemId}.media.${exp}`)}`;
}

export async function verifyMediaQuery(keyring: Keyring, itemId: string, sig: string, now: number): Promise<boolean> {
  const dot = sig.indexOf('.');
  if (dot <= 0) return false;
  const expRaw = sig.slice(0, dot);
  if (!/^\d{1,16}$/.test(expRaw) || Number(expRaw) <= now) return false;
  return keyring.verifyLink(`${itemId}.media.${expRaw}`, sig.slice(dot + 1));
}
