import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

// A tiny History API router. Witness has a handful of routes and no nesting, so this is
// all it needs: a location store, path matching, links, and focus/scroll on navigation.

export interface Location {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
}

const NAVIGATE_EVENT = 'witness:navigate';

let cached: Location | null = null;

function readLocation(): Location {
  const { pathname, search, hash } = window.location;
  const state: unknown = window.history.state;
  if (
    cached &&
    cached.pathname === pathname &&
    cached.search === search &&
    cached.hash === hash &&
    cached.state === state
  ) {
    return cached;
  }
  cached = { pathname, search, hash, state };
  return cached;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

export interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export function navigate(to: string, options: NavigateOptions = {}): void {
  const url = new URL(to, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const target = `${url.pathname}${url.search}${url.hash}`;
  const state = options.state ?? null;
  if (options.replace) window.history.replaceState(state, '', target);
  else window.history.pushState(state, '', target);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, readLocation, readLocation);
}

export function useSearchParam(name: string): string | null {
  const { search } = useLocation();
  return new URLSearchParams(search).get(name);
}

export type Params = Record<string, string>;

/** Matches "/app/items/:id" style patterns. Trailing slashes are ignored. */
export function matchPath(pattern: string, pathname: string): Params | null {
  const clean = (p: string) => p.replace(/\/+$/, '') || '/';
  const want = clean(pattern).split('/');
  const have = clean(pathname).split('/');
  if (want.length !== have.length) return null;
  const params: Params = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const h = have[i] as string;
    if (w.startsWith(':')) {
      if (!h) return null;
      params[w.slice(1)] = decodeURIComponent(h);
    } else if (w !== h) {
      return null;
    }
  }
  return params;
}

export interface Route {
  path: string;
  render: (params: Params) => ReactNode;
}

export function Routes({ routes, fallback }: { routes: Route[]; fallback: ReactNode }) {
  // `search` too: the setup steps are /app/setup?step=…, and moving between them is a page change.
  const { pathname, hash, search } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    // Leave the initial load alone; on later navigations behave like a page change:
    // back to the top, and focus the main landmark so screen readers announce the new page.
    if (first.current) {
      first.current = false;
      return;
    }
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
      return;
    }
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [pathname, hash, search]);

  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params) return <>{route.render(params)}</>;
  }
  return <>{fallback}</>;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
}

export function Link({ to, replace, onClick, target, children, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (!isPlainLeftClick(event) || (target && target !== '_self')) return;
    const url = new URL(to, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(to, { replace });
  }
  return (
    <a href={to} onClick={handleClick} target={target} {...rest}>
      {children}
    </a>
  );
}

/** For `useEffect`-driven redirects. */
export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}
