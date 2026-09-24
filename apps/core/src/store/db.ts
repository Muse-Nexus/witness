/**
 * Small typed helpers over D1, plus the shared row and enum types.
 * Every query in store/ takes the owning user_id and filters on it.
 */

export type SourceType = 'email' | 'text' | 'photo' | 'screenshot' | 'manual' | 'agent' | 'import';
export const SOURCE_TYPES: readonly SourceType[] = ['email', 'text', 'photo', 'screenshot', 'manual', 'agent', 'import'];

export type ItemStatus = 'saved' | 'maybe' | 'removed';
export type ItemKind = 'text' | 'image' | 'mixed';
export type EventOutcome = 'saved' | 'maybe' | 'excluded' | 'duplicate' | 'confirmation' | 'rejected';

export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const { results } = await stmt.all<T>();
  return results;
}

/** Number of rows a write changed. */
export async function run(stmt: D1PreparedStatement): Promise<number> {
  const result = await stmt.run();
  return result.meta.changes ?? 0;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export function newId(): string {
  return crypto.randomUUID();
}
