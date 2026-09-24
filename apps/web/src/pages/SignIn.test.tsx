import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('sends signed-out visitors from the app to sign in', async () => {
    renderApp('/app', { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in with your email.' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/signin');
  });
});
