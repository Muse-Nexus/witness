import { describe, expect, it } from 'vitest';
import { createMockApi } from './mock';
import type { Item, Status } from './types';

/** The mock answers as core does, so pages tested against it hold against the real API. */
describe('the mock API keeps core\'s contract', () => {
  const call = async <T,>(mock: ReturnType<typeof createMockApi>, path: string, init: RequestInit = {}): Promise<T> =>
    (await (await mock.fetch(path, { headers: { 'Content-Type': 'application/json', 'X-Witness-CSRF': '1' }, ...init })).json()) as T;

  it('counts the saved items an email can show, as /status does', async () => {
    const mock = createMockApi();
    const status = await call<Status>(mock, '/api/v1/status');
    const showable = mock.state.items.filter((i) => i.status === 'saved' && !(i.kind === 'image' && i.mediaType === 'image/heic'));
    expect(status.deliverable).toBe(showable.length);
    mock.state.items.push({ ...mock.state.items.find((i) => i.status === 'saved')!, id: 'itm_heic', kind: 'image', quote: null, mediaType: 'image/heic' });
    expect((await call<Status>(mock, '/api/v1/status')).deliverable).toBe(showable.length);
  });

  it('searches the words, the name, the note, the source label and the kind a card shows', async () => {
    const mock = createMockApi();
    const base = mock.state.items.find((i) => i.status === 'saved')!;
    const item: Item = { ...base, id: 'itm_search', quote: 'Plain words.', fromName: 'Jo', context: 'from the recital', sourceLabel: 'Postcard', category: 'recovery', categoryKnown: true };
    mock.state.items = [item];
    const found = async (q: string) => (await call<{ items: Item[] }>(mock, `/api/v1/items?q=${encodeURIComponent(q)}`)).items.map((i) => i.id);
    for (const q of ['plain', 'jo', 'recital', 'postcard', 'recovery']) expect(await found(q), q).toEqual(['itm_search']);
    // Not sorted: no kind is shown, so none is searched.
    mock.state.items = [{ ...item, categoryKnown: false, category: 'other' }];
    expect(await found('recovery')).toEqual([]);
    expect(await found('other')).toEqual([]);
  });

  it('puts an item back to unsorted with category: null', async () => {
    const mock = createMockApi();
    const item = mock.state.items.find((i) => i.status === 'saved')!;
    const unsorted = await call<Item>(mock, `/api/v1/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ category: null }) });
    expect(unsorted).toMatchObject({ category: 'other', categoryKnown: false });
    const sorted = await call<Item>(mock, `/api/v1/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ category: 'care' }) });
    expect(sorted).toMatchObject({ category: 'care', categoryKnown: true });
  });
});
