import { newInboundSlug } from '../crypto.js';
import { first, isUniqueViolation, newId, run } from './db.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  inbound_slug: string;
  timezone: string;
  created_at: number;
}

/** A write for an account that was deleted while the request was under way: nothing was kept. */
export class AccountGone extends Error {
  override name = 'AccountGone';
  constructor() {
    super('This account no longer exists.');
  }
}

export function getUserById(db: D1Database, userId: string): Promise<UserRow | null> {
  return first<UserRow>(db.prepare('SELECT * FROM users WHERE id = ?1').bind(userId));
}

export function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return first<UserRow>(db.prepare('SELECT * FROM users WHERE email = ?1').bind(email.toLowerCase()));
}

export function getUserBySlug(db: D1Database, slug: string): Promise<UserRow | null> {
  return first<UserRow>(db.prepare('SELECT * FROM users WHERE inbound_slug = ?1').bind(slug.toLowerCase()));
}

/**
 * Creates the account, allows the account email as an inbound sender, and
 * creates the (disabled) rhythm row. Retries on the rare slug collision.
 */
export async function createUser(db: D1Database, input: { email: string; timezone: string; now: number }): Promise<UserRow> {
  const email = input.email.toLowerCase();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const user: UserRow = {
      id: newId(),
      email,
      display_name: null,
      inbound_slug: newInboundSlug(),
      timezone: input.timezone,
      created_at: input.now,
    };
    try {
      await db.batch([
        db
          .prepare('INSERT INTO users (id, email, display_name, inbound_slug, timezone, created_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)')
          .bind(user.id, user.email, user.inbound_slug, user.timezone, user.created_at),
        db.prepare('INSERT INTO user_addresses (user_id, address, verified_at) VALUES (?1, ?2, ?3)').bind(user.id, email, input.now),
        db
          .prepare('INSERT INTO rhythms (user_id, enabled, timezone, updated_at) VALUES (?1, 0, ?2, ?3)')
          .bind(user.id, user.timezone, input.now),
      ]);
      return user;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two first sign-ins racing for the same email: the other one won.
      const existing = await getUserByEmail(db, email);
      if (existing) return existing;
    }
  }
  throw new Error('could not allocate an inbound address');
}

/** A new private inbound address; the old one stops working at once. Retries on the rare collision. */
export async function rotateInboundSlug(db: D1Database, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = newInboundSlug();
    try {
      await run(db.prepare('UPDATE users SET inbound_slug = ?2 WHERE id = ?1').bind(userId, slug));
      return slug;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error('could not allocate an inbound address');
}

export async function updateUser(
  db: D1Database,
  userId: string,
  patch: { displayName?: string | null; timezone?: string },
): Promise<void> {
  if (patch.displayName !== undefined) {
    await run(db.prepare('UPDATE users SET display_name = ?2 WHERE id = ?1').bind(userId, patch.displayName));
  }
  if (patch.timezone !== undefined) {
    await run(db.prepare('UPDATE users SET timezone = ?2 WHERE id = ?1').bind(userId, patch.timezone));
  }
}
