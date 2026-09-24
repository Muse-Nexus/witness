import type { ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import { ApiProvider } from '../api/context';
import { Home } from '../pages/Home';
import { Landing } from '../pages/Landing';
import { Maybe } from '../pages/Maybe';
import { NotFound } from '../pages/NotFound';
import { Privacy } from '../pages/Privacy';
import { Safety } from '../pages/Safety';
import { Settings } from '../pages/Settings';
import { CheckEmail, SignIn } from '../pages/SignIn';
import { Setup } from '../pages/setup/Setup';
import { Routes, type Route } from './router';
import { RequireSession } from './session';

const signedIn = (page: ReactNode) => () => <RequireSession>{page}</RequireSession>;

export const ROUTES: Route[] = [
  { path: '/', render: () => <Landing /> },
  { path: '/signin', render: () => <SignIn /> },
  { path: '/check-email', render: () => <CheckEmail /> },
  { path: '/privacy', render: () => <Privacy /> },
  { path: '/safety', render: () => <Safety /> },
  { path: '/app', render: signedIn(<Home />) },
  { path: '/app/maybe', render: signedIn(<Maybe />) },
  { path: '/app/setup', render: signedIn(<Setup />) },
  { path: '/app/settings', render: signedIn(<Settings />) },
];

export function App({ client }: { client: ApiClient }) {
  return (
    <ApiProvider client={client}>
      <Routes routes={ROUTES} fallback={<NotFound />} />
    </ApiProvider>
  );
}
