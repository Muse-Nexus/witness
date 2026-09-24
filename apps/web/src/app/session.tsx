import { useContext, useEffect, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useApi } from '../api/context';
import { AppPage } from '../components/Layout';
import { useResource } from '../lib/useResource';
import { navigate } from './router';

import { SessionContext, type Session } from './sessionContext';

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <RequireSession>');
  return session;
}

/** Gate for /app pages. Sends signed-out visitors to sign in. */
export function RequireSession({ children }: { children: ReactNode }) {
  const api = useApi();
  const me = useResource(() => api.me());
  const unauthorized = me.error instanceof ApiError && me.error.isUnauthorized;

  useEffect(() => {
    if (unauthorized) navigate('/signin', { replace: true });
  }, [unauthorized]);

  if (me.data) {
    return <SessionContext.Provider value={{ me: me.data, refresh: me.reload }}>{children}</SessionContext.Provider>;
  }
  if (me.error && !unauthorized) {
    return (
      <AppPage className="container narrow page-message">
        <h1 className="display-sm">Witness could not be reached.</h1>
        <p className="lede">Your things are safe. Check your connection and try again.</p>
        <button type="button" className="btn btn--ghost" onClick={() => void me.reload()}>
          Try again
        </button>
      </AppPage>
    );
  }
  return (
    <AppPage className="container narrow page-message">
      <p className="loading" role="status">
        Opening Witness…
      </p>
    </AppPage>
  );
}
