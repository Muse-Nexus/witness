import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render';

describe('Privacy page', () => {
  it('does not overclaim: the server holds the keys, so it says this is not end-to-end', async () => {
    renderApp('/privacy', { signedIn: false });
    expect(await screen.findByText(/This is not end-to-end encryption\./)).toBeInTheDocument();
    expect(screen.queryByText(/yours alone/)).toBeNull();
  });

  it('says whether the AI check is on for this Witness', async () => {
    renderApp('/privacy', { signedIn: false });
    expect(await screen.findByText(/On this Witness, the AI check is off\./)).toBeInTheDocument();
    expect(screen.getByText(/It never sees images, or the words your iPhone reads in a screenshot you share\./)).toBeInTheDocument();
  });

  it('says so when the AI check is on', async () => {
    renderApp('/privacy', { signedIn: false, aiCheck: true });
    expect(await screen.findByText(/On this Witness, the AI check is on\./)).toBeInTheDocument();
  });
});
