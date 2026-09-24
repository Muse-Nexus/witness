import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, mediaUrlFor, type Fetcher } from './client';

function recorder(response: () => Response) {
  const fetcher = vi.fn<Fetcher>(async () => response());
  return { fetcher, client: createClient(fetcher) };
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

describe('api client', () => {
  it('sends reads without the CSRF header, same-origin', async () => {
    const { fetcher, client } = recorder(ok({ email: 'you@example.com' }));
    await client.me();
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/v1/me');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-Witness-CSRF']).toBeUndefined();
  });

  it('marks every mutation with X-Witness-CSRF: 1 and a JSON body', async () => {
    const { fetcher, client } = recorder(ok({ ok: true }));
    await client.startSignIn('you@example.com');
    await client.deleteItem('itm 1');
    await client.saveRhythm({ enabled: true, localTime: '08:30', days: ['mon'], timezone: 'UTC', channel: 'email' });

    for (const [, init] of fetcher.mock.calls) {
      expect((init.headers as Record<string, string>)['X-Witness-CSRF']).toBe('1');
    }
    const [signInPath, signIn] = fetcher.mock.calls[0]!;
    expect(signInPath).toBe('/api/v1/auth/start');
    expect(JSON.parse(signIn.body as string)).toEqual({ email: 'you@example.com' });
    expect((signIn.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(fetcher.mock.calls[1]![0]).toBe('/api/v1/items/itm%201');
    expect(fetcher.mock.calls[2]![1].method).toBe('PUT');
  });

  it('builds item queries without empty params', async () => {
    const { fetcher, client } = recorder(ok({ items: [], nextCursor: null }));
    await client.listItems({ status: 'maybe', limit: 10, q: '' });
    expect(fetcher.mock.calls[0]![0]).toBe('/api/v1/items?status=maybe&limit=10');
  });

  it('turns error bodies into ApiError', async () => {
    const { client } = recorder(
      () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in to continue.' } }), { status: 401 }),
    );
    const error = await client.status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Sign in to continue.' });
    expect((error as ApiError).isUnauthorized).toBe(true);
  });

  it('reports network failures calmly', async () => {
    const client = createClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(client.me()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('treats an empty confirmation as none', async () => {
    const { client } = recorder(() => new Response('null', { status: 200 }));
    expect(await client.latestConfirmation()).toBeNull();
  });

  it('points image items at the media endpoint unless the item carries a URL', () => {
    expect(mediaUrlFor({ id: 'a/b', mediaType: 'image/png', mediaUrl: null })).toBe('/api/v1/items/a%2Fb/media');
    expect(mediaUrlFor({ id: 'a', mediaType: 'image/png', mediaUrl: 'data:x' })).toBe('data:x');
    expect(mediaUrlFor({ id: 'a', mediaType: null })).toBeNull();
  });

  // Every route here exists in apps/core with this method and path (apps/core/test/contract.test.ts
  // checks the response shapes). Keep the two lists in step.
  it('uses the methods and paths core serves', async () => {
    const { fetcher, client } = recorder(ok({ items: [], nextCursor: null, tokens: [], addresses: [], senders: [] }));
    const calls: [() => Promise<unknown>, string, string][] = [
      [() => client.startSignIn('you@example.com'), 'POST', '/api/v1/auth/start'],
      [() => client.signOut(), 'POST', '/api/v1/auth/logout'],
      [() => client.me(), 'GET', '/api/v1/me'],
      [() => client.updateMe({ displayName: 'Ana' }), 'PATCH', '/api/v1/me'],
      [() => client.status(), 'GET', '/api/v1/status'],
      [() => client.listItems({ status: 'saved' }), 'GET', '/api/v1/items?status=saved'],
      [() => client.addItem({ quote: 'Thank you.' }), 'POST', '/api/v1/items'],
      [() => client.updateItem('i1', { status: 'saved' }), 'PATCH', '/api/v1/items/i1'],
      [() => client.deleteItem('i1'), 'DELETE', '/api/v1/items/i1'],
      [() => client.blockSender('i1'), 'POST', '/api/v1/items/i1/block-sender'],
      [() => client.rhythm(), 'GET', '/api/v1/rhythm'],
      [() => client.saveRhythm({ enabled: false, localTime: '08:30', days: ['mon'], timezone: 'UTC', channel: 'email' }), 'PUT', '/api/v1/rhythm'],
      [() => client.pause(7), 'POST', '/api/v1/rhythm/pause'],
      [() => client.resume(), 'POST', '/api/v1/rhythm/resume'],
      [() => client.sendNow(), 'POST', '/api/v1/rhythm/send-now'],
      [() => client.tokens(), 'GET', '/api/v1/tokens'],
      [() => client.createToken({ label: 'x', kind: 'agent' }), 'POST', '/api/v1/tokens'],
      [() => client.revokeToken('t1'), 'DELETE', '/api/v1/tokens/t1'],
      [() => client.addresses(), 'GET', '/api/v1/addresses'],
      [() => client.addAddress('a@example.com'), 'POST', '/api/v1/addresses'],
      [() => client.removeAddress('a@example.com'), 'DELETE', '/api/v1/addresses'],
      [() => client.latestConfirmation(), 'GET', '/api/v1/inbound/confirmations'],
      [() => client.blockedSenders(), 'GET', '/api/v1/blocked-senders'],
      [() => client.unblockSender('abc'), 'DELETE', '/api/v1/blocked-senders/abc'],
      [() => client.deleteAccount(), 'DELETE', '/api/v1/account'],
    ];
    for (const [run, method, path] of calls) {
      fetcher.mockClear();
      await run();
      expect([fetcher.mock.calls[0]![1].method, fetcher.mock.calls[0]![0]]).toEqual([method, path]);
    }
  });

  it('reads the block-sender answer, and tolerates an empty body', async () => {
    const { client } = recorder(ok({ ok: true, removed: 2, removedIds: ['a', 'b'] }));
    expect(await client.blockSender('a')).toEqual({ ok: true, removed: 2, removedIds: ['a', 'b'] });
    const empty = createClient(async () => new Response('', { status: 200 }));
    expect(await empty.blockSender('a')).toEqual({});
  });
});
