/**
 * GET /api/v1/config: how this Witness is run, so the web app's public pages can say so
 * (sign-in: whether sign-ups are invite-only; Privacy: whether the optional AI check is on).
 *
 * Public and content-free: the same answer for everyone, signed in or not. It is mounted
 * ahead of `authenticate`, so it never looks up a session or token, and it never says
 * anything about any person, including whether an address is invited.
 */
import { Hono } from 'hono';
import type { HonoEnv } from '../context.js';

export interface PublicConfig {
  signups: 'open' | 'invite';
  /** The optional model judge (SAFETY §8) runs here: configured and given a key. */
  aiCheck: boolean;
}

/** Short, so a changed setting shows within minutes. */
export const PUBLIC_CONFIG_MAX_AGE_S = 300;

export const configApi = new Hono<HonoEnv>();

configApi.get('/', (c) => {
  const cfg = c.get('cfg');
  const body: PublicConfig = { signups: cfg.signups, aiCheck: cfg.judge !== 'none' };
  c.header('Cache-Control', `public, max-age=${PUBLIC_CONFIG_MAX_AGE_S}`);
  return c.json(body);
});
