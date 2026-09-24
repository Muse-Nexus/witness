import { describe, expect, it } from 'vitest';
import {
  DELIVERY_LINK_TTL_MS,
  LASTING_LINK_TTL_MS,
  Keyring,
  base64Encode,
  base64UrlDecode,
  newInboundSlug,
  newToken,
  normalizeHandle,
  signDeliveryToken,
  signMediaQuery,
  verifyDeliveryToken,
  verifyMediaQuery,
} from '../src/crypto.js';
import { ConfigError } from '../src/env.js';
import { keyring } from './helpers.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

describe('text encryption (SPEC §7)', () => {
  it('uses the v1.<iv>.<ciphertext> format and round-trips', async () => {
    const k = keyring();
    const ct = await k.encryptText(USER_A, 'You showed up for me every day.');
    const parts = ct.split('.');
    expect(parts[0]).toBe('v1');
    expect(base64UrlDecode(parts[1]!)).toHaveLength(12);
    // 31 bytes of text + 16-byte GCM tag
    expect(base64UrlDecode(parts[2]!)).toHaveLength(31 + 16);
    expect(ct).not.toContain('showed up');
    expect(await k.decryptText(USER_A, ct)).toBe('You showed up for me every day.');
  });

  it('uses a fresh IV every time', async () => {
    const k = keyring();
    expect(await k.encryptText(USER_A, 'same')).not.toBe(await k.encryptText(USER_A, 'same'));
  });

  it("cannot decrypt one user's data with another user's key", async () => {
    const k = keyring();
    const ct = await k.encryptText(USER_A, 'private');
    await expect(k.decryptText(USER_B, ct)).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const k = keyring();
    const ct = await k.encryptText(USER_A, 'private');
    const [v, iv, body] = ct.split('.') as [string, string, string];
    const flipped = body.slice(0, -2) + (body.endsWith('A') ? 'B' : 'A') + body.slice(-1);
    await expect(k.decryptText(USER_A, `${v}.${iv}.${flipped}`)).rejects.toThrow();
  });

  it('seals media as iv || ciphertext and opens it', async () => {
    const k = keyring();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const sealed = await k.sealMedia(USER_A, bytes);
    expect(sealed.length).toBe(12 + 5 + 16);
    expect(await k.openMedia(USER_A, sealed)).toEqual(bytes);
    await expect(k.openMedia(USER_B, sealed)).rejects.toThrow();
  });
});

describe('master key', () => {
  it('requires 32 base64 bytes', () => {
    expect(() => Keyring.fromSecret(undefined)).toThrow(ConfigError);
    expect(() => Keyring.fromSecret(base64Encode(new Uint8Array(16)))).toThrow(/32 bytes/);
    expect(() => Keyring.fromSecret('%%%')).toThrow(ConfigError);
  });
});

describe('sender keys', () => {
  it('are stable HMACs of the normalized handle, per user', async () => {
    const k = keyring();
    const a = await k.senderKeyFor(USER_A, '+1 (555) 555-0101');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await k.senderKeyFor(USER_A, '555-555-0101')).toBe(a);
    expect(await k.senderKeyFor(USER_A, 'tel:+15555550101')).toBe(a);
    expect(await k.senderKeyFor(USER_B, '+15555550101')).not.toBe(a);
    expect(await k.senderKeyFor(USER_A, 'Sam.Rivera@Example.com')).toBe(await k.senderKeyFor(USER_A, 'sam.rivera@example.com'));
    expect(await k.senderKeyFor(USER_A, '   ')).toBeNull();
  });

  it('normalizes phone numbers and emails', () => {
    expect(normalizeHandle('+1 555 555 0102')).toBe('+15555550102');
    expect(normalizeHandle('15555550102')).toBe('+15555550102');
    expect(normalizeHandle('mailto:Dana@Example.com')).toBe('dana@example.com');
  });
});

describe('tokens and slugs', () => {
  it('prefixes 32 random bytes', () => {
    expect(newToken('wit_agent_')).toMatch(/^wit_agent_[A-Za-z0-9_-]{43}$/);
    expect(newToken('wit_dev_')).toMatch(/^wit_dev_[A-Za-z0-9_-]{43}$/);
    expect(newToken('wit_sess_')).not.toBe(newToken('wit_sess_'));
  });

  it('makes 10-character inbound slugs', () => {
    for (let i = 0; i < 50; i += 1) expect(newInboundSlug()).toMatch(/^[a-z0-9]{10}$/);
  });
});

describe('signed delivery links', () => {
  const now = Date.UTC(2026, 8, 1, 12);

  it('verify within 14 days and name the action', async () => {
    const k = keyring();
    const token = await signDeliveryToken(k, 'delivery-1', 'skip', now);
    expect(await verifyDeliveryToken(k, token, now + 1000)).toEqual({ ok: true, deliveryId: 'delivery-1', action: 'skip', exp: now + DELIVERY_LINK_TTL_MS });
  });

  it('keep stop and pause links working for a year', async () => {
    const k = keyring();
    for (const action of ['stop', 'pause'] as const) {
      const token = await signDeliveryToken(k, 'delivery-1', action, now);
      expect(await verifyDeliveryToken(k, token, now + 200 * 24 * 60 * 60 * 1000)).toMatchObject({ ok: true, action, exp: now + LASTING_LINK_TTL_MS });
    }
  });

  it('expire after 14 days', async () => {
    const k = keyring();
    const token = await signDeliveryToken(k, 'delivery-1', 'keep', now);
    expect(await verifyDeliveryToken(k, token, now + DELIVERY_LINK_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('reject a changed action, id or expiry', async () => {
    const k = keyring();
    const token = await signDeliveryToken(k, 'delivery-1', 'keep', now);
    const [id, , exp, sig] = token.split('.');
    expect((await verifyDeliveryToken(k, `${id}.remove.${exp}.${sig}`, now)).ok).toBe(false);
    expect((await verifyDeliveryToken(k, `delivery-2.keep.${exp}.${sig}`, now)).ok).toBe(false);
    expect((await verifyDeliveryToken(k, `${id}.keep.${Number(exp) + 1}.${sig}`, now)).ok).toBe(false);
    expect(await verifyDeliveryToken(k, 'garbage', now)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('sign media URLs per item', async () => {
    const k = keyring();
    const sig = await signMediaQuery(k, 'item-1', 60_000, now);
    expect(await verifyMediaQuery(k, 'item-1', sig, now)).toBe(true);
    expect(await verifyMediaQuery(k, 'item-2', sig, now)).toBe(false);
    expect(await verifyMediaQuery(k, 'item-1', sig, now + 60_001)).toBe(false);
  });
});
