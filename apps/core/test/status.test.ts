import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { recordEvent } from '../src/store/events.js';
import { asUser, call, signIn } from './helpers.js';

async function sources(session: Awaited<ReturnType<typeof signIn>>) {
  const res = await call('/api/v1/status', asUser(session));
  return ((await res.json()) as { sources: { type: string; count7d: number }[] }).sources;
}

describe('status sources', () => {
  it('count what arrived, kept or not, but not a forwarding confirmation or rejected mail', async () => {
    const session = await signIn();
    const now = Date.now();
    // A forwarding confirmation proves the address, not that anything is forwarded yet: setup
    // must not say Witness heard from this email.
    await recordEvent(env.DB, { userId: session.userId, sourceType: 'email', outcome: 'confirmation', now });
    await recordEvent(env.DB, { userId: session.userId, sourceType: 'email', outcome: 'rejected', reason: 'too_large', now });
    expect(await sources(session)).toEqual([]);

    // A newsletter that was not kept still shows the forwarding works.
    await recordEvent(env.DB, { userId: session.userId, sourceType: 'email', outcome: 'excluded', reason: 'bulk', now });
    expect(await sources(session)).toEqual([{ type: 'email', lastAt: now, count7d: 1 }]);
  });
});
