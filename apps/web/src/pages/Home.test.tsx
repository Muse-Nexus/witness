import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClient } from '../api/client';
import { createMockApi } from '../api/mock';
import { App } from '../app/App';
import { callsTo, renderApp } from '../test/render';

async function cardFor(quote: string) {
  const text = await screen.findByText(quote);
  return text.closest('article') as HTMLElement;
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
    fireEvent.click(within(card).getByRole('button', { name: 'Options for the message from Dad' }));
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
