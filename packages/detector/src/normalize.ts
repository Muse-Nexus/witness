/**
 * Dedupe helpers (SPEC §5): normalizedText = lowercase, collapse whitespace, trim.
 */

export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * dedupe_key = hex SHA-256 of `sourceType + ":" + (sourceRef || normalizedText)`.
 * Uses crypto.subtle, available in Workers, browsers and Node 20+.
 */
export async function dedupeKey(sourceType: string, input: { sourceRef?: string | null; text: string }): Promise<string> {
  const basis = input.sourceRef ? input.sourceRef : normalizeForDedupe(input.text);
  const bytes = new TextEncoder().encode(`${sourceType}:${basis}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
