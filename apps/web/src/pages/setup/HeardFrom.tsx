import { useMemo } from 'react';
import { useApi } from '../../api/context';
import type { SourceType } from '../../api/types';
import { relativeAgo } from '../../lib/format';
import { useResource } from '../../lib/useResource';

/**
 * A quiet "is it working?" line for a setup step: when Witness last heard from this
 * source, or that it has not yet, with one way to check. It counts nothing and never
 * reaches out; it is only shown here, where the person is already setting things up.
 */
export function HeardFrom({ types, what, check }: { types: SourceType[]; what: string; check: string }) {
  const api = useApi();
  const status = useResource(() => api.status());
  const now = useMemo(() => Date.now(), []);
  if (!status.data) return null;
  const times = status.data.sources.filter((s) => types.includes(s.type) && s.lastAt != null).map((s) => s.lastAt as number);
  const last = times.length ? Math.max(...times) : null;
  return (
    <p className="step__aside heard-from" role="status">
      {last != null ? `Witness last heard from ${what} ${relativeAgo(last, now)}.` : `Witness has not heard from ${what} yet. ${check}`}
    </p>
  );
}
