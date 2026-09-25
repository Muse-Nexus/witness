import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../../api/client';
import { createMockApi } from '../../api/mock';
import { App } from '../../app/App';
import { callsTo, renderApp } from '../../test/render';

/** Pretend this browser is in Honolulu, whatever zone the test machine is in. */
function inHonolulu() {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...original.call(this), timeZone: 'Pacific/Honolulu' };
  });
}

describe('Setup wizard', () => {
  it('walks email → texts & photos → rhythm → assistant, each skippable', async () => {
    renderApp('/app/setup');
    expect(await screen.findByRole('heading', { name: 'Forward the kind ones.' })).toBeInTheDocument();
    expect(screen.getByText('witness+k7m2q9x4pd@in.witness.example.com')).toBeInTheDocument();
    expect(screen.getByText(/-category:promotions/)).toBeInTheDocument();
    expect(screen.getByText('Forward kind emails here whenever you like.', { exact: false })).toBeInTheDocument();
    // Forwarding only catches new mail, and the page says so.
    expect(screen.getByText(/catches new mail from now on/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Next: texts & photos/ }));
    expect(await screen.findByRole('heading', { name: 'Texts and photos.' })).toBeInTheDocument();
    expect(window.location.search).toBe('?step=texts');

    fireEvent.click(screen.getByRole('link', { name: 'Skip for now' }));
    expect(await screen.findByRole('heading', { name: 'When should Witness email you?' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: /Next: your AI assistant/ }));
    expect(await screen.findByRole('heading', { name: 'Let your AI assistant ask first.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Done/ })).toHaveAttribute('href', '/app');
  });

  it('switches mail guides with tabs', async () => {
    renderApp('/app/setup?step=email');
    await screen.findByRole('heading', { name: 'Forward the kind ones.' });
    fireEvent.click(screen.getByRole('tab', { name: 'Outlook' }));
    expect(screen.getByRole('tab', { name: 'Outlook' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Subject or body includes/)).toBeInTheDocument();
  });

  it('shows the detected Gmail confirmation as a button', async () => {
    renderApp('/app/setup?step=email', { confirmationAfterPolls: 1 });
    expect(await screen.findByText('Gmail sent a confirmation.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Confirm it/ })).toHaveAttribute(
      'href',
      'https://mail-settings.google.com/mail/vf-example-confirmation',
    );
  });

  it('never shows another provider\'s confirmation under Gmail, and keeps checking for a newer one', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null });
    mock.state.confirmation = { provider: 'outlook', code: '55512345', receivedAt: Date.now() };
    window.history.replaceState(null, '', '/app/setup?step=email');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App client={createClient(mock.fetch)} />);
      await screen.findByRole('heading', { name: 'Forward the kind ones.' });
      await waitFor(() => expect(callsTo(mock, 'GET', '/api/v1/inbound/confirmations').length).toBeGreaterThan(0));
      expect(screen.queryByText(/sent a confirmation/)).toBeNull();
      expect(callsTo(mock, 'GET', '/api/v1/inbound/confirmations')[0]?.path).toContain('provider=gmail');

      mock.state.confirmation = { provider: 'gmail', url: 'https://mail-settings.google.com/mail/vf-first', receivedAt: Date.now() };
      await vi.advanceTimersByTimeAsync(6000);
      expect(await screen.findByRole('link', { name: /Confirm it/ })).toHaveAttribute('href', 'https://mail-settings.google.com/mail/vf-first');

      // A second confirmation (another account, a retry) replaces the first while the page is open.
      mock.state.confirmation = { provider: 'gmail', url: 'https://mail-settings.google.com/mail/vf-second', receivedAt: Date.now() + 1000 };
      await vi.advanceTimersByTimeAsync(6000);
      await waitFor(() =>
        expect(screen.getByRole('link', { name: /Confirm it/ })).toHaveAttribute('href', 'https://mail-settings.google.com/mail/vf-second'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('needs explicit consent, then saves the rhythm you chose', async () => {
    const { mock } = renderApp('/app/setup?step=rhythm', { seed: false });
    await screen.findByRole('heading', { name: 'When should Witness email you?' });
    const turnOn = await screen.findByRole('button', { name: 'Turn on emails' });

    fireEvent.click(turnOn);
    expect(screen.getByRole('alert')).toHaveTextContent('Check the box above to show you chose this.');
    expect(callsTo(mock, 'PUT', '/api/v1/rhythm')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '07:15' } });
    fireEvent.click(screen.getByLabelText('Sunday'));
    fireEvent.click(screen.getByLabelText('Saturday'));
    fireEvent.click(screen.getByLabelText("I'm choosing this now, so Witness can email me on these days."));
    fireEvent.click(turnOn);

    await waitFor(() => expect(callsTo(mock, 'PUT', '/api/v1/rhythm')).toHaveLength(1));
    const [call] = callsTo(mock, 'PUT', '/api/v1/rhythm');
    expect(call?.body).toEqual({
      enabled: true,
      localTime: '07:15',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      channel: 'email',
    });
    // Nothing is kept yet, and Witness sends nothing until something is, so it does not promise an email.
    expect(await screen.findByText(/Saved\. Once Witness keeps something, it will email you at 7:15 AM on weekdays\./)).toBeInTheDocument();
    expect(mock.state.rhythm.consentedAt).not.toBeNull();
  });

  it('says when the first email comes once something is kept', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null });
    mock.state.rhythm = { ...mock.state.rhythm, enabled: false };
    window.history.replaceState(null, '', '/app/setup?step=rhythm');
    render(<App client={createClient(mock.fetch)} />);
    fireEvent.click(await screen.findByLabelText("I'm choosing this now, so Witness can email me on these days."));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on emails' }));
    expect(await screen.findByText(/^Saved\. Witness will email you at /)).toBeInTheDocument();
  });

  it('shows when Witness hears from email while the page is open, without a reload', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null, seed: false });
    window.history.replaceState(null, '', '/app/setup?step=email');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App client={createClient(mock.fetch)} />);
      expect(await screen.findByText(/Witness has not heard from your email yet\./)).toBeInTheDocument();
      // A forwarded email that was not kept (a newsletter) still shows forwarding works.
      mock.state.arrivals.push({ type: 'email', at: Date.now() });
      await vi.advanceTimersByTimeAsync(6000);
      expect(await screen.findByText('Witness last heard from your email just now.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a new rhythm in the browser time zone, not the account default (UTC)', async () => {
    inHonolulu();
    const { mock } = renderApp('/app/setup?step=rhythm', { seed: false });
    expect(mock.state.me.timezone).toBe('UTC');
    expect(await screen.findByLabelText('Time zone')).toHaveValue('Pacific/Honolulu');
    fireEvent.click(screen.getByLabelText("I'm choosing this now, so Witness can email me on these days."));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on emails' }));
    await waitFor(() => expect(callsTo(mock, 'PUT', '/api/v1/rhythm')).toHaveLength(1));
    expect(callsTo(mock, 'PUT', '/api/v1/rhythm')[0]?.body).toMatchObject({ timezone: 'Pacific/Honolulu' });
    expect(mock.state.me.timezone).toBe('Pacific/Honolulu');
  });

  it('keeps the zone of a rhythm the person already chose', async () => {
    inHonolulu();
    const mock = createMockApi({ confirmationAfterPolls: null });
    mock.state.rhythm = { ...mock.state.rhythm, timezone: 'Europe/Lisbon' };
    window.history.replaceState(null, '', '/app/setup?step=rhythm');
    render(<App client={createClient(mock.fetch)} />);
    await waitFor(() => expect(screen.getByLabelText('Time zone')).toHaveValue('Europe/Lisbon'));
  });

  it('sends one now, and says so plainly when there is nothing yet', async () => {
    const { mock } = renderApp('/app/setup?step=rhythm', { seed: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Send one now to see it' }));
    expect(await screen.findByText(/Once Witness keeps something, you can send one here\. To try it now, add something kind by hand on Home/)).toBeInTheDocument();
    expect(callsTo(mock, 'POST', '/api/v1/rhythm/send-now')).toHaveLength(1);
  });

  it('says one is already on its way when another delivery is being sent at that moment', async () => {
    const mock = createMockApi({ confirmationAfterPolls: null });
    const fetcher: typeof mock.fetch = async (input, init) => {
      if (String(input).endsWith('/api/v1/rhythm/send-now')) {
        return new Response(JSON.stringify({ sent: false, reason: 'in_progress' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return mock.fetch(input, init);
    };
    window.history.replaceState(null, '', '/app/setup?step=rhythm');
    render(<App client={createClient(fetcher)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send one now to see it' }));
    expect(await screen.findByText('One is already on its way. It can take a minute to arrive.')).toBeInTheDocument();
    expect(screen.queryByText(/you can send one here/)).toBeNull();
  });

  it('never says there is nothing when things are kept but were just sent', async () => {
    const { mock } = renderApp('/app/setup?step=rhythm');
    const button = await screen.findByRole('button', { name: 'Send one now to see it' });
    // Send each saved sample once, then press again.
    const saved = mock.state.items.filter((i) => i.status === 'saved').length;
    for (let i = 0; i < saved; i += 1) {
      fireEvent.click(button);
      await screen.findByText(/One is on its way/);
      await waitFor(() => expect(button).not.toBeDisabled());
    }
    fireEvent.click(button);
    expect(await screen.findByText('Nothing is ready to send right now. Witness waits a while before sending the same thing again.')).toBeInTheDocument();
    expect(screen.queryByText(/you can send one here/)).toBeNull();
  });

    it('creates a capture-only device key', async () => {
    const { mock } = renderApp('/app/setup?step=texts');
    fireEvent.click(await screen.findByRole('button', { name: 'Create a device key' }));
    expect(await screen.findByText(/It can only add things, never read them/)).toBeInTheDocument();
    const [call] = callsTo(mock, 'POST', '/api/v1/tokens');
    expect(call?.body).toEqual({ label: 'iPhone', kind: 'device', scopes: ['capture'] });
    expect(screen.getByText(/^wit_dev_/)).toBeInTheDocument();
  });
});
