// Vite's import.meta.glob, used by the corpus test to load corpus/*.jsonl
// without Node-specific APIs.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, T>;
}
