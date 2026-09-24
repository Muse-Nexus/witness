/** Agent and device tokens (bearer). Only the SHA-256 hash is stored. */
import { all, first, newId, run } from './db.js';

export const AGENT_SCOPES = ['status', 'offer', 'reveal', 'search', 'add', 'pause'] as const;
/**
 * What a new assistant key gets unless the person chooses otherwise. `search` hands over
 * evidence without the offer-and-yes step, so it is off unless they turn it on.
 */
export const DEFAULT_AGENT_SCOPES = ['status', 'offer', 'reveal', 'add', 'pause'] as const;
export const DEVICE_SCOPES = ['capture', 'status'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type DeviceScope = (typeof DEVICE_SCOPES)[number];
export type Scope = AgentScope | DeviceScope;
export type TokenKind = 'agent' | 'device';

export interface TokenRow {
  id: string;
  user_id: string;
  kind: TokenKind;
  label: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface TokenInfo {
  id: string;
  kind: TokenKind;
  label: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export function parseScopes(json: string): Scope[] {
  try {
    const value: unknown = JSON.parse(json);
    const known = new Set<string>([...AGENT_SCOPES, ...DEVICE_SCOPES]);
    return Array.isArray(value) ? value.filter((s): s is Scope => typeof s === 'string' && known.has(s)) : [];
  } catch {
    return [];
  }
}

export function tokenInfo(row: TokenRow): TokenInfo {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export async function createToken(
  db: D1Database,
  input: { userId: string; kind: TokenKind; label: string; tokenHash: string; scopes: Scope[]; now: number },
): Promise<TokenRow> {
  const row: TokenRow = {
    id: newId(),
    user_id: input.userId,
    kind: input.kind,
    label: input.label,
    token_hash: input.tokenHash,
    scopes: JSON.stringify(input.scopes),
    created_at: input.now,
    last_used_at: null,
    revoked_at: null,
  };
  await run(
    db
      .prepare('INSERT INTO tokens (id, user_id, kind, label, token_hash, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(row.id, row.user_id, row.kind, row.label, row.token_hash, row.scopes, row.created_at),
  );
  return row;
}

export function listTokens(db: D1Database, userId: string): Promise<TokenRow[]> {
  return all<TokenRow>(
    db.prepare('SELECT * FROM tokens WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC').bind(userId),
  );
}

export async function revokeToken(db: D1Database, userId: string, tokenId: string, now: number): Promise<boolean> {
  const changed = await run(
    db.prepare('UPDATE tokens SET revoked_at = ?3 WHERE id = ?2 AND user_id = ?1 AND revoked_at IS NULL').bind(userId, tokenId, now),
  );
  return changed > 0;
}

/** Looks a bearer token up by hash. This is the one query that starts without a user id: it establishes it. */
export function findActiveToken(db: D1Database, tokenHash: string): Promise<TokenRow | null> {
  return first<TokenRow>(db.prepare('SELECT * FROM tokens WHERE token_hash = ?1 AND revoked_at IS NULL').bind(tokenHash));
}

export async function touchToken(db: D1Database, userId: string, tokenId: string, now: number): Promise<void> {
  // Once a minute is plenty for "last used"; skip the write otherwise.
  await run(
    db
      .prepare('UPDATE tokens SET last_used_at = ?3 WHERE id = ?2 AND user_id = ?1 AND (last_used_at IS NULL OR last_used_at < ?3 - 60000)')
      .bind(userId, tokenId, now),
  );
}
