/** Envelope senders allowed to deliver inbound mail for a user. */
import { all, run } from './db.js';

export interface AddressRow {
  user_id: string;
  address: string;
  verified_at: number | null;
}

/**
 * Canonical form for comparing envelope senders. Gmail forwards with a
 * `+caf_=...` subaddress and ignores dots, so both are dropped for Gmail; for
 * everyone else only the `+tag` is dropped.
 */
export function canonicalAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at <= 0) return a;
  let local = a.slice(0, at);
  let domain = a.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export function listAddresses(db: D1Database, userId: string): Promise<AddressRow[]> {
  return all<AddressRow>(db.prepare('SELECT * FROM user_addresses WHERE user_id = ?1 ORDER BY address').bind(userId));
}

export async function addAddress(db: D1Database, userId: string, address: string, now: number): Promise<void> {
  await run(
    db
      .prepare(
        `INSERT INTO user_addresses (user_id, address, verified_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id, address) DO UPDATE SET verified_at = COALESCE(user_addresses.verified_at, excluded.verified_at)`,
      )
      .bind(userId, address.trim().toLowerCase(), now),
  );
}

export async function removeAddress(db: D1Database, userId: string, address: string): Promise<boolean> {
  const changed = await run(
    db.prepare('DELETE FROM user_addresses WHERE user_id = ?1 AND address = ?2').bind(userId, address.trim().toLowerCase()),
  );
  return changed > 0;
}

/** True when `sender` matches one of the user's verified addresses. */
export async function isAllowedSender(db: D1Database, userId: string, sender: string): Promise<boolean> {
  const wanted = canonicalAddress(sender);
  const rows = await listAddresses(db, userId);
  return rows.some((r) => r.verified_at !== null && canonicalAddress(r.address) === wanted);
}
