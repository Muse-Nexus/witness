import { cleanup, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { rememberReturn, takeReturn } from '../app/returnTo';
import { callsTo, renderApp } from '../test/render';

describe('Sign in', () => {
  it('posts the email with the CSRF header, then asks you to check your email', async () => {
    const { mock } = renderApp('/signin', { signedIn: false });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  reader@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));

    expect(await screen.findByRole('heading', { name: 'Check your email.' })).toBeInTheDocument();
    const [call] = callsTo(mock, 'POST', '/api/v1/auth/start');
    expect(call?.body).toEqual({ email: 'reader@example.com' });
    expect(call?.headers['x-witness-csrf']).toBe('1');
    expect(screen.getByText('reader@example.com')).toBeInTheDocument();
    // The address travels in history state, never in the URL.
    expect(window.location.pathname + window.location.search).toBe('/check-email');
  });

  it('does not send anything for an address that is not one yet', () => {
    const { mock } = renderApp('/signin', { signedIn: false });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That does not look like an email address yet.');
    expect(callsTo(mock, 'POST', '/api/v1/auth/start')).toHaveLength(0);
  });

  it('says plainly when sign-ups are invite-only', async () => {
    renderApp('/signin', { signedIn: false });
    expect(await screen.findByText(/Witness is invite-only for now/)).toBeInTheDocument();
    expect(screen.queryByText(/It is free and open source/)).toBeNull();
  });

  it('says the same link creates an account when sign-ups are open', async () => {
    renderApp('/signin', { signedIn: false, signups: 'open' });
    expect(await screen.findByText('New here? The same link creates your account. It is free and open source.')).toBeInTheDocument();
    expect(screen.queryByText(/invite-only/)).toBeNull();
  });

  it('gives the real link lifetime, and reads the same for any address while invite-only', async () => {
    renderApp('/signin', { signedIn: false });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anyone@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    await screen.findByRole('heading', { name: 'Check your email.' });
    expect(await screen.findByText(/The link works once, for 15 minutes, in this browser\./)).toHaveTextContent(
      'While Witness is invite-only, links go only to invited addresses.',
    );
  });

  it('sends signed-out visitors from the app to sign in', async () => {
    renderApp('/app', { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in with your email.' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/signin');
  });

  it('brings a signed-out visitor back to the page they opened, once they sign in', async () => {
    // Witness for Mac's "Open Witness to make a key", in a browser that is not signed in.
    renderApp('/app/setup?step=texts', { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in with your email.' })).toBeInTheDocument();
    cleanup();

    // The sign-in link signs them in, and the server sends the new session to /app.
    renderApp('/app');
    expect(await screen.findByRole('heading', { name: 'Texts and photos.' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/app/setup?step=texts');
    cleanup();

    // Only once: the next visit to /app stays there.
    renderApp('/app');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe('/app');
  });

  it('keeps only the page and its setup step, and only while a sign-in link works', () => {
    const now = Date.now();
    rememberReturn('/app/settings', '?q=words+someone+said', now);
    expect(takeReturn(now + 1000)).toBe('/app/settings');
    expect(takeReturn(now + 1000)).toBeNull();

    rememberReturn('/app/setup', '?step=texts', now);
    expect(takeReturn(now + 16 * 60 * 1000)).toBeNull();

    rememberReturn('/app', '', now);
    expect(takeReturn(now)).toBeNull();

    localStorage.setItem('witness.returnTo', JSON.stringify({ to: '//elsewhere.example/app/setup', at: now }));
    expect(takeReturn(now)).toBeNull();
  });
});
