/**
 * Where a signed-out visitor was going, kept while they sign in, so the page they asked for is
 * the one they land on: Witness for Mac's "Open Witness to make a key" opens the Texts step,
 * and a person whose browser is not signed in should still end up there.
 *
 * The sign-in link comes back through email and the server, which always send a new session
 * to /app (or /app/setup the first time), so the page is kept in this browser until then. Only
 * the page and its setup step are kept, never a search or anything else from the address, and
 * only for as long as a sign-in link works.
 */

const KEY = 'witness.returnTo';
/** As long as a sign-in link works (MAGIC_LINK_TTL_MS in core). */
const TTL_MS = 15 * 60 * 1000;
/** Pages worth coming back to. /app itself is where a new session lands anyway. */
const PAGES = new Set(['/app/maybe', '/app/setup', '/app/settings']);
const STEP = /^[a-z]{1,20}$/;

/** The page and setup step of `pathname` + `search`, or null when it is not worth keeping. */
export function returnPath(pathname: string, search: string): string | null {
  const page = pathname.replace(/\/+$/, '');
  if (!PAGES.has(page)) return null;
  const step = new URLSearchParams(search).get('step');
  return step && STEP.test(step) ? `${page}?step=${step}` : page;
}

/** Keeps the page a signed-out visitor opened, to go back to once they sign in. */
export function rememberReturn(pathname: string, search: string, now = Date.now()): void {
  const to = returnPath(pathname, search);
  try {
    if (to) localStorage.setItem(KEY, JSON.stringify({ to, at: now }));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage is off in this browser: they land on the usual page after signing in.
  }
}

/** The page kept by `rememberReturn`, once, if it is still fresh. */
export function takeReturn(now = Date.now()): string | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as { to?: unknown; at?: unknown };
    if (typeof kept.to !== 'string' || typeof kept.at !== 'number' || now - kept.at > TTL_MS || now < kept.at) return null;
    const url = new URL(kept.to, 'https://witness.invalid');
    return returnPath(url.pathname, url.search) === kept.to ? kept.to : null;
  } catch {
    return null;
  }
}
