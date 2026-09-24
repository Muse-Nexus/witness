import { useEffect } from 'react';

const BRAND = 'Muse Nexus Witness';

export function useTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${title} · ${BRAND}` : `${BRAND} · A witness to your life.`;
  }, [title]);
}
