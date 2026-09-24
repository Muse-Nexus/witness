import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace the data locally, e.g. after a successful mutation. */
  set: (update: T | ((current: T | undefined) => T)) => void;
}

/** Loads once on mount (and when `key` changes). Small on purpose: this app has few screens. */
export function useResource<T>(load: () => Promise<T>, key: unknown = null): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await loadRef.current();
      if (mine === generation.current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (mine === generation.current) setError(err);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload, key]);

  const set = useCallback((update: T | ((current: T | undefined) => T)) => {
    setData((current) =>
      typeof update === 'function' ? (update as (c: T | undefined) => T)(current) : update,
    );
  }, []);

  return { data, error, loading, reload, set };
}
