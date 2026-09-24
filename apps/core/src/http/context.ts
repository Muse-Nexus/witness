import type { Context } from 'hono';
import { Keyring } from '../crypto.js';
import { assertServesHost, config, type AppEnv, type Config } from '../env.js';
import type { Scope, TokenKind } from '../store/tokens.js';

export type Auth =
  | { kind: 'session'; userId: string; sessionHash: string }
  | { kind: 'token'; userId: string; tokenId: string; tokenKind: TokenKind; label: string; scopes: Scope[] };

export interface HonoEnv {
  Bindings: AppEnv;
  Variables: {
    auth: Auth | undefined;
    cfg: Config;
    keyring: Keyring;
    now: number;
  };
}

export type AppContext = Context<HonoEnv>;

/** Per-request setup: parsed config, keyring and a single "now" for the whole request. */
export function initRequest(c: AppContext): void {
  const cfg = config(c.env);
  assertServesHost(cfg, new URL(c.req.url));
  c.set('cfg', cfg);
  c.set('keyring', Keyring.fromSecret(c.env.WITNESS_MASTER_KEY));
  c.set('now', Date.now());
}

export function requireUser(c: AppContext): Auth {
  const auth = c.get('auth');
  if (!auth) throw new Error('route is missing requireAuth');
  return auth;
}
