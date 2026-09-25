import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import type { SourceType } from '../../api/types';
import { relativeAgo } from '../../lib/format';
import { useResource } from '../../lib/useResource';

/** How often the line looks again while the page is in view, so a check shows up without a reload. */
export const HEARD_FROM_POLL_MS = 5000;

/**
 * A quiet "is it working?" line for a setup step: when Witness last heard from this
 * source, or that it has not yet, with one way to check. It counts nothing and never
 * reaches out; it is only shown here, where the person is already setting things up.
 */
export function HeardFrom({ types, what, check }: { types: SourceType[]; what: string; check: string }) {
  const api = useApi();
  const status = useResource(() => api.status());
  const [now, setNow] = useState(() => Date.now());
  const { reload } = status;

  // The line says how to check, so it looks again every few seconds while the page is in view.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void reload().then(() => setNow(Date.now()));
    }, HEARD_FROM_POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (!status.data) return null;
  const times = status.data.sources.filter((s) => types.includes(s.type) && s.lastAt != null).map((s) => s.lastAt as number);
  const last = times.length ? Math.max(...times) : null;
  return (
    <p className="step__aside heard-from" role="status">
      {last != null ? `Witness last heard from ${what} ${relativeAgo(last, now)}.` : `Witness has not heard from ${what} yet. ${check}`}
    </p>
  );
}
