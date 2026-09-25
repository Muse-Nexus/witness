import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClient } from '../api/client';
import { createMockApi, type MockApi, type MockOptions } from '../api/mock';
import { App } from '../app/App';
import { callsTo, renderApp } from '../test/render';

async function cardFor(quote: string) {
  const text = await screen.findByText(quote);
  return text.closest('article') as HTMLElement;
}

const SWIM = 'Thank you for teaching Mateo to swim. He talks about you every night at dinner.';

/** Home with `count` extra kept notes that sort ahead of the sample ones. SYNTHETIC data only. */
function homeWithNotes(count: number, options: MockOptions = {}): MockApi {
  const mock = createMockApi({ confirmationAfterPolls: null, ...options });
  const base = mock.state.items.find((i) => i.id === 'itm_dad')!;
  const now = Date.now();
  for (let n = 0; n < count; n += 1) {
    mock.state.items.push({ ...base, id: `itm_note_${n}`, quote: `A zebracorn note, number ${n}.`, fromName: 'Robin', occurredAt: now - n, createdAt: now - n });
  }
  window.history.replaceState(null, '', '/app');
  render(<App client={createClient(mock.fetch)} />);
  return mock;
}

async function search(words: string) {
  fireEvent.change(screen.getByLabelText('Find something you kept'), { target: { value: words } });
  fireEvent.click(screen.getByRole('button', { name: 'Find' }));
}

describe('Home', () => {
  it('shows the status sentence and saved items from the API', async () => {
    renderApp('/app');
    expect(await screen.findByText('Witness is on.')).toBeInTheDocument();
    expect(await screen.findByText('Proud of you, kid. Always have been.')).toBeInTheDocument();
    expect(screen.getByText('Thank you for teaching Mateo to swim. He talks about you every night at dinner.')).toBeInTheDocument();
    // Unknown people and dates stay unknown.
    const unknown = await cardFor("I don't say it enough. I love you, and I'm so glad you're my sister.");
    expect(unknown).toHaveTextContent('— Someone');
    expect(unknown).toHaveTextContent('Date unknown');
    // Maybe is a quiet link, not a badge, and carries no number (SAFETY §6).
    const maybe = screen.getByRole('link', { name: 'Maybe: things Witness was not sure about' });
    expect(maybe).toHaveAttribute('href', '/app/maybe');
    expect(maybe.textContent).not.toMatch(/\d/);
  });

  it('finds something kept by a few words or a name, and shows everything again', async () => {
    const { mock } = renderApp('/app');
    await cardFor('Proud of you, kid. Always have been.');
    fireEvent.change(screen.getByLabelText('Find something you kept'), { target: { value: 'swim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    // The search results replace the list: the card that does not match goes, the one that does stays.
    await waitFor(() => expect(screen.queryByText('Proud of you, kid. Always have been.')).toBeNull());
    expect(screen.getByText('Thank you for teaching Mateo to swim. He talks about you every night at dinner.')).toBeInTheDocument();
    expect(callsTo(mock, 'GET', '/api/v1/items').at(-1)?.path).toContain('q=swim');

    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await screen.findByText('Proud of you, kid. Always have been.')).toBeInTheDocument();
  });

  it('reads on past requests that found nothing, the way core searches a bounded number at a time', async () => {
    // Each request reads one thing, and three notes come before the one that matches.
    const mock = homeWithNotes(4, { searchScanLimit: 1 });
    await cardFor('A zebracorn note, number 0.');
    await search('number 3');
    // The results replace the list (note 3 was in it too), so wait for the list to go first.
    await waitFor(() => expect(screen.queryByText('A zebracorn note, number 0.')).toBeNull());
    expect(screen.getByText('A zebracorn note, number 3.')).toBeInTheDocument();
    expect(screen.queryByText(/No match/)).toBeNull();
    expect(callsTo(mock, 'GET', '/api/v1/items').filter((c) => c.path.includes('q=number')).length).toBe(4);
  });

  it('never calls it a miss while there is more to read, and can look further back', async () => {
    // Ten requests read only the ten newest notes, so the match (the twelfth) is not reached yet.
    homeWithNotes(12, { searchScanLimit: 1 });
    await cardFor('A zebracorn note, number 0.');
    await search('number 11');
    expect(await screen.findByText('No match yet for “number 11”.')).toBeInTheDocument();
    expect(screen.queryByText('No match for “number 11”.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Look further back' }));
    expect(await screen.findByText('A zebracorn note, number 11.')).toBeInTheDocument();
  });

  it('shows more matches a page at a time', async () => {
    homeWithNotes(35);
    await cardFor('A zebracorn note, number 0.');
    await search('zebracorn');
    await waitFor(() => expect(screen.queryByText(SWIM)).toBeNull());
    expect(screen.queryByText('A zebracorn note, number 34.')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('A zebracorn note, number 34.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('keeps a change made in the results when showing everything again, and keeps focus in the search box', async () => {
    renderApp('/app');
    await cardFor(SWIM);
    await search('swim');
    await waitFor(() => expect(screen.queryByText('Proud of you, kid. Always have been.')).toBeNull());
    expect(await screen.findByText('Showing what matches “swim”.')).toBeInTheDocument();
    const card = await cardFor(SWIM);
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Edit details' }));
    fireEvent.change(within(card).getByLabelText('Who said it'), { target: { value: 'Rosa A.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).getByText('— Rosa A.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await screen.findByText('Proud of you, kid. Always have been.')).toBeInTheDocument();
    expect(within(await cardFor(SWIM)).getByText('— Rosa A.')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('Find something you kept'));
    expect(screen.getByText('Showing everything you kept.')).toBeInTheDocument();
  });

  it('lets "Show everything" win over a search still on its way', async () => {
    renderApp('/app', { latencyMs: 30 });
    await cardFor(SWIM);
    await search('swim');
    await waitFor(() => expect(screen.queryByText('Proud of you, kid. Always have been.')).toBeNull());
    await search('dad');
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    expect(await screen.findByText('Proud of you, kid. Always have been.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 120));
    // The late "dad" results did not replace the full list.
    expect(screen.getByText(SWIM)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show everything' })).toBeNull();
  });

  it('says a miss is about the search, with no count', async () => {
    renderApp('/app');
    await cardFor('Proud of you, kid. Always have been.');
    fireEvent.change(screen.getByLabelText('Find something you kept'), { target: { value: 'zeppelin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('No match for “zeppelin”.')).toBeInTheDocument();
    expect(screen.getByText('Try a name, or other words.')).toBeInTheDocument();
  });

  it('always shows whose Witness this is', async () => {
    const { mock } = renderApp('/app');
    await screen.findByText('Witness is on.');
    const header = screen.getByRole('banner');
    expect(within(header).getByText(mock.state.me.email)).toBeInTheDocument();
    expect(header).toHaveTextContent(`Signed in as ${mock.state.me.email}`);
  });

  it('removes an item in one tap from its menu, through the API', async () => {
    const { mock } = renderApp('/app');
    const card = await cardFor('Proud of you, kid. Always have been.');
    fireEvent.click(within(card).getByRole('button', { name: /^Options for “Proud of you, kid\. Always…” from Dad$/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('Proud of you, kid. Always have been.')).not.toBeInTheDocument());
    const [call] = callsTo(mock, 'DELETE', '/api/v1/items/itm_dad');
    expect(call?.headers['x-witness-csrf']).toBe('1');
    expect(mock.state.items.some((i) => i.id === 'itm_dad')).toBe(false);
    expect(screen.getByText('Removed for good.')).toBeVisible();
  });

  it('asks before stopping saving from a sender, and keeps what is here by default', async () => {
    const { mock } = renderApp('/app');
    const card = await cardFor('We picked your proposal because you listened better than anyone else we talked to.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Never save from this sender' }));
    // Nothing happens on the tap itself: a mis-tap never deletes anything.
    expect(callsTo(mock, 'POST', '/api/v1/items/itm_lena/block-sender')).toHaveLength(0);
    expect(within(card).getByText(/Never save from Lena/)).toBeInTheDocument();
    expect(await within(card).findByText(/This is the one thing kept from them/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Stop saving, keep what is here' }));
    await waitFor(() => expect(callsTo(mock, 'POST', '/api/v1/items/itm_lena/block-sender')).toHaveLength(1));
    expect(callsTo(mock, 'POST', '/api/v1/items/itm_lena/block-sender')[0]?.body).toEqual({ removeExisting: false });
    expect(screen.getByText(/We picked your proposal/)).toBeInTheDocument();
  });

  it('can cancel stopping saving from a sender', async () => {
    const { mock } = renderApp('/app');
    const card = await cardFor('We picked your proposal because you listened better than anyone else we talked to.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Never save from this sender' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByText(/Never save from Lena/)).toBeNull();
    expect(callsTo(mock, 'POST', '/api/v1/items/itm_lena/block-sender')).toHaveLength(0);
  });

  it('removes every card core reports for a blocked sender, not just the one tapped', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null });
    const lena = mock.state.items.find((i) => i.id === 'itm_lena')!;
    mock.state.items.push({ ...lena, id: 'itm_lena_2', quote: 'Thank you for the thoughtful review of our plan.' });
    window.history.replaceState(null, '', '/app');
    render(<App client={createClient(mock.fetch)} />);
    await screen.findByText('Thank you for the thoughtful review of our plan.');
    const card = await cardFor('We picked your proposal because you listened better than anyone else we talked to.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Never save from this sender' }));
    fireEvent.click(await within(card).findByRole('button', { name: 'Stop saving and remove all 2' }));
    await waitFor(() => expect(screen.queryByText(/We picked your proposal/)).not.toBeInTheDocument());
    expect(screen.queryByText('Thank you for the thoughtful review of our plan.')).not.toBeInTheDocument();
    expect(screen.getByText(/Removed 2 things/)).toBeInTheDocument();
  });

  it('keeps the edit form open, with what was typed, when a save fails', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null });
    const failing: typeof mock.fetch = async (input, init) =>
      init?.method === 'PATCH' ? new Response(JSON.stringify({ error: { code: 'internal', message: 'x' } }), { status: 500 }) : mock.fetch(input, init);
    window.history.replaceState(null, '', '/app');
    render(<App client={createClient(failing)} />);
    const card = await cardFor('Proud of you, kid. Always have been.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Edit details' }));
    fireEvent.change(within(card).getByLabelText('Who said it'), { target: { value: 'Dad (Frank)' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Your changes are still here');
    expect(within(card).getByLabelText('Who said it')).toHaveValue('Dad (Frank)');
  });

  it('sends only what changed, so an untouched date keeps its exact moment', async () => {
    const { mock } = renderApp('/app');
    const card = await cardFor('Proud of you, kid. Always have been.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Edit details' }));
    fireEvent.change(within(card).getByLabelText('Who said it'), { target: { value: 'Dad (Frank)' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo(mock, 'PATCH', '/api/v1/items/itm_dad')).toHaveLength(1));
    expect(callsTo(mock, 'PATCH', '/api/v1/items/itm_dad')[0]?.body).toEqual({ fromName: 'Dad (Frank)' });
  });

  it('edits details without touching the words', async () => {
    const { mock } = renderApp('/app');
    const card = await cardFor('Proud of you, kid. Always have been.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    fireEvent.click(within(card).getByRole('menuitem', { name: 'Edit details' }));
    fireEvent.change(within(card).getByLabelText('Who said it'), { target: { value: 'Dad (Frank)' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(within(card).getByText('— Dad (Frank)')).toBeInTheDocument());
    const [call] = callsTo(mock, 'PATCH', '/api/v1/items/itm_dad');
    expect(call?.body).toMatchObject({ fromName: 'Dad (Frank)' });
    expect(call?.body).not.toHaveProperty('quote');
  });

  it('starts an unsorted item on "Not sorted", and sends a label only when one is picked', async () => {
    const { mock } = renderApp('/app');
    await screen.findByText('Witness is on.');
    fireEvent.change(screen.getByLabelText('What they said, in their exact words'), { target: { value: 'You carried us this week.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    // The box empties once it is kept, so the words below are the card's, not the box's.
    await waitFor(() => expect(screen.getByLabelText('What they said, in their exact words')).toHaveValue(''));
    const card = await cardFor('You carried us this week.');
    const openEdit = () => {
      fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
      fireEvent.click(within(card).getByRole('menuitem', { name: 'Edit details' }));
    };

    openEdit();
    expect(within(card).getByLabelText("Label (Witness's guess)")).toHaveValue('');
    expect(within(card).getByRole('option', { name: 'Not sorted' })).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText('Who said it'), { target: { value: 'Noa' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).getByText('— Noa')).toBeInTheDocument());
    const [first] = mock.calls.filter((c) => c.method === 'PATCH');
    expect(first?.body).toEqual({ fromName: 'Noa' });

    openEdit();
    fireEvent.change(within(card).getByLabelText("Label (Witness's guess)"), { target: { value: 'gratitude' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(mock.calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ category: 'gratitude' });

    // Once it has a label, core cannot clear it, so "Not sorted" is no longer offered.
    await waitFor(() => expect(within(card).queryByRole('form', { name: 'Edit details' })).toBeNull());
    openEdit();
    expect(within(card).queryByRole('option', { name: 'Not sorted' })).toBeNull();
    expect(within(card).getByLabelText("Label (Witness's guess)")).toHaveValue('gratitude');
  });

  it('keeps something added by hand', async () => {
    const { mock } = renderApp('/app');
    await screen.findByText('Witness is on.');
    fireEvent.change(screen.getByLabelText('What they said, in their exact words'), {
      target: { value: 'Thank you for the soup. It was exactly what I needed.' },
    });
    fireEvent.change(screen.getByLabelText(/^Who/), { target: { value: 'Ilse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(await screen.findByText('Thank you for the soup. It was exactly what I needed.')).toBeInTheDocument();
    const [call] = callsTo(mock, 'POST', '/api/v1/items');
    expect(call?.body).toEqual({ quote: 'Thank you for the soup. It was exactly what I needed.', fromName: 'Ilse' });
    // Witness does not know who sent a hand-added quote, so there is no sender to block.
    const card = await cardFor('Thank you for the soup. It was exactly what I needed.');
    fireEvent.click(within(card).getByRole('button', { name: /Options/ }));
    expect(within(card).queryByRole('menuitem', { name: 'Never save from this sender' })).not.toBeInTheDocument();
    expect(within(card).getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument();
  });

  it('is gentle when nothing has been kept yet', async () => {
    renderApp('/app', { seed: false });
    expect(await screen.findByText('When something kind arrives, it will be kept here.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Maybe/ })).not.toBeInTheDocument();
  });
});

describe('Gallery paging', () => {
  it('puts an old hand-added item where it belongs, never twice after "Show more"', async () => {
    const { appendPage, insertSorted } = await import('./Home');
    const base = { status: 'saved', kind: 'text', quote: 'q', context: null, fromName: null, sourceType: 'manual', sourceLabel: 'Added by you', category: 'other', edited: false, mediaType: null, updatedAt: 0 } as const;
    const at = (id: string, when: number) => ({ ...base, id, occurredAt: when, createdAt: when });
    const page = { items: [at('a', 300), at('b', 200)], nextCursor: 'cursor' };
    // Older than everything loaded: left for "Show more", which brings it once.
    const old = at('old', 100);
    const afterAdd = insertSorted(page, old);
    expect(afterAdd.items.map((i) => i.id)).toEqual(['a', 'b']);
    const more = appendPage(afterAdd, { items: [at('c', 150), old], nextCursor: null });
    expect(more.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'old']);
    // A page that repeats something already shown adds it only once.
    expect(appendPage(more, { items: [old], nextCursor: null }).items.filter((i) => i.id === 'old')).toHaveLength(1);
    // Newer: in date order, at the right place.
    expect(insertSorted(page, at('mid', 250)).items.map((i) => i.id)).toEqual(['a', 'mid', 'b']);
  });
});

describe('Maybe', () => {
  it('reaches every item, a page at a time, not just the first 60', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null });
    const sample = mock.state.items.find((i) => i.status === 'maybe')!;
    for (let n = 0; n < 70; n += 1) mock.state.items.push({ ...sample, id: `itm_maybe_${n}`, quote: `Maybe number ${n}, synthetic.`, occurredAt: Date.UTC(2020, 0, 1) + n * 60_000, createdAt: Date.UTC(2020, 0, 1) + n * 60_000 });
    window.history.replaceState(null, '', '/app/maybe');
    render(<App client={createClient(mock.fetch)} />);
    await screen.findByText('Maybe number 69, synthetic.');
    expect(screen.queryByText('Maybe number 0, synthetic.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Maybe number 0, synthetic.')).toBeInTheDocument();
  });
});

describe('Photos a browser cannot show', () => {
  it('says so and offers the original instead of a broken image', async () => {
    const { fireEvent: fe } = await import('@testing-library/react');
    renderApp('/app');
    await screen.findByText('Witness is on.');
    const img = await waitFor(() => {
      const found = document.querySelector('.quote-card__media img');
      expect(found).not.toBeNull();
      return found!;
    });
    fe.error(img);
    expect(await screen.findByText(/This browser cannot show this photo/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download the original' })).toBeInTheDocument();
  });
});
