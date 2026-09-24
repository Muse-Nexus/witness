import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { callsTo, renderApp } from '../test/render';

function section(name: string) {
  return screen.getByRole('region', { name });
}

describe('Settings', () => {
  it('only deletes everything after the phrase is typed', async () => {
    const { mock } = renderApp('/app/settings');
    await screen.findByRole('heading', { name: 'Settings.' });
    const button = screen.getByRole('button', { name: 'Delete everything' });
    const input = screen.getByLabelText(/to confirm/);
    expect(button).toBeDisabled();

    fireEvent.change(input, { target: { value: 'delete' } });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(callsTo(mock, 'DELETE', '/api/v1/account')).toHaveLength(0);

    fireEvent.change(input, { target: { value: 'delete everything' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(await screen.findByRole('heading', { name: 'Everything is deleted.' })).toBeInTheDocument();
    const [call] = callsTo(mock, 'DELETE', '/api/v1/account');
    expect(call?.headers['x-witness-csrf']).toBe('1');
    expect(mock.state.items).toHaveLength(0);
  });

  it('pauses for a week and can resume', async () => {
    const { mock } = renderApp('/app/settings');
    await screen.findByRole('heading', { name: 'Settings.' });
    const pause = section('Pause');
    fireEvent.click(await within(pause).findByRole('button', { name: 'Pause for a week' }));
    await waitFor(() => expect(callsTo(mock, 'POST', '/api/v1/rhythm/pause')).toHaveLength(1));
    expect(callsTo(mock, 'POST', '/api/v1/rhythm/pause')[0]?.body).toEqual({ days: 7 });

    fireEvent.click(await within(pause).findByRole('button', { name: 'Resume now' }));
    await waitFor(() => expect(callsTo(mock, 'POST', '/api/v1/rhythm/resume')).toHaveLength(1));
  });

  it('disconnects a key only after a second, explicit tap', async () => {
    const { mock } = renderApp('/app/settings');
    const assistants = await screen.findByRole('region', { name: 'Assistants and devices' });
    await within(assistants).findByText('Claude Code', { selector: '.row__title' });
    fireEvent.click(within(assistants).getByRole('button', { name: 'Disconnect Claude Code' }));
    expect(callsTo(mock, 'DELETE', '/api/v1/tokens/tok_claude')).toHaveLength(0);
    expect(within(assistants).getByText('It stops working right away.')).toBeInTheDocument();

    const confirm = within(assistants).getAllByRole('button', { name: 'Disconnect Claude Code' });
    fireEvent.click(confirm[0]!);
    await waitFor(() => expect(within(assistants).queryByText('Claude Code', { selector: '.row__title' })).not.toBeInTheDocument());
    expect(callsTo(mock, 'DELETE', '/api/v1/tokens/tok_claude')).toHaveLength(1);
  });

  it('lists forwarding addresses and never-save senders', async () => {
    const { mock } = renderApp('/app/settings');
    const email = await screen.findByRole('region', { name: 'Email' });
    expect(await within(email).findByText('you@work.example.com', { selector: '.row__main' })).toBeInTheDocument();
    fireEvent.click(within(email).getByRole('button', { name: 'Remove you@work.example.com' }));
    await waitFor(() => expect(within(email).queryByText('you@work.example.com', { selector: '.row__main' })).not.toBeInTheDocument());
    expect(callsTo(mock, 'DELETE', '/api/v1/addresses')[0]?.body).toEqual({ address: 'you@work.example.com' });

    const blocked = section('Never save from');
    fireEvent.click(await within(blocked).findByRole('button', { name: 'Allow Tom R. again' }));
    await waitFor(() => expect(callsTo(mock, 'DELETE', '/api/v1/blocked-senders/snd_3f9a')).toHaveLength(1));
  });

  it('gives a new Witness address after a second, explicit tap', async () => {
    const { mock } = renderApp('/app/settings');
    const email = await screen.findByRole('region', { name: 'Email' });
    const before = mock.state.me.inboundAddress;
    fireEvent.click(within(email).getByRole('button', { name: 'Get a new address' }));
    expect(callsTo(mock, 'POST', '/api/v1/me/inbound-address')).toHaveLength(0);
    expect(within(email).getByText(/The old address stops working right away/)).toBeInTheDocument();
    fireEvent.click(within(email).getByRole('button', { name: 'Get a new address' }));
    await waitFor(() => expect(callsTo(mock, 'POST', '/api/v1/me/inbound-address')).toHaveLength(1));
    await waitFor(() => expect(within(email).queryByText(before)).toBeNull());
    expect(within(email).getByText(mock.state.me.inboundAddress)).toBeInTheDocument();
  });

  it('never saves from a number ahead of time, says it does not block them, and says Allow again brings nothing back', async () => {
    const { mock } = renderApp('/app/settings');
    await screen.findByRole('heading', { name: 'Settings.' });
    const blocked = section('Never save from');
    expect(blocked).toHaveTextContent('Allowing someone again does not bring back anything that was removed.');
    expect(blocked).toHaveTextContent('This does not block them.');
    fireEvent.change(await within(blocked).findByLabelText('Never save from a phone number or email address'), { target: { value: '+1 555 555 0199' } });
    fireEvent.change(within(blocked).getByLabelText(/A name for it here/), { target: { value: 'Ex' } });
    fireEvent.click(within(blocked).getByRole('button', { name: 'Never save from them' }));
    await waitFor(() => expect(callsTo(mock, 'POST', '/api/v1/blocked-senders')).toHaveLength(1));
    expect(callsTo(mock, 'POST', '/api/v1/blocked-senders')[0]?.body).toEqual({ handle: '+1 555 555 0199', label: 'Ex' });
    expect(await within(blocked).findByText('Ex', { selector: '.row__title' })).toBeInTheDocument();
  });

  it('offers the export as a same-origin download and signs out', async () => {
    const { mock } = renderApp('/app/settings');
    await screen.findByRole('heading', { name: 'Settings.' });
    expect(screen.getByRole('link', { name: 'Download everything' })).toHaveAttribute('href', '/api/v1/export');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(callsTo(mock, 'POST', '/api/v1/auth/logout')).toHaveLength(1);
  });
});
