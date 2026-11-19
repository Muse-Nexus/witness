/** OAuth apps and one-use authorization codes (SPEC §9). Only hashes of codes are stored. */
import { first, newId, run } from './db.js';

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  created_at: number;
}

export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: number;
  used_at: number | null;
}

export async function createClient(db: D1Database, input: { name: string; redirectUris: string[]; now: number }): Promise<OAuthClientRow> {
  const row: OAuthClientRow = {
    client_id: `wit_client_${newId()}`,
    client_name: input.name,
    redirect_uris: JSON.stringify(input.redirectUris),
    created_at: input.now,
  };
  await run(
    db
      .prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(row.client_id, row.client_name, row.redirect_uris, row.created_at),
  );
  return row;
}

export function getClient(db: D1Database, clientId: string): Promise<OAuthClientRow | null> {
  return first<OAuthClientRow>(db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?1').bind(clientId));
}

export function clientRedirectUris(row: OAuthClientRow): string[] {
  try {
    const value: unknown = JSON.parse(row.redirect_uris);
    return Array.isArray(value) ? value.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export async function createCode(
  db: D1Database,
  input: { codeHash: string; clientId: string; userId: string; redirectUri: string; codeChallenge: string; scopes: string[]; expiresAt: number },
): Promise<void> {
  await run(
    db
      .prepare(
        'INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(input.codeHash, input.clientId, input.userId, input.redirectUri, input.codeChallenge, JSON.stringify(input.scopes), input.expiresAt),
  );
}

/**
 * Uses a code up and returns it, atomically: a code works once, before it expires. A second
 * try (a replay) gets null, whatever else it sends.
 */
export function consumeCode(db: D1Database, codeHash: string, now: number): Promise<OAuthCodeRow | null> {
  return first<OAuthCodeRow>(
    db
      .prepare('UPDATE oauth_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING *')
      .bind(codeHash, now),
  );
}
