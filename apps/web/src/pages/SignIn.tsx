import { useId, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import { navigate, useLocation } from '../app/router';
import { Eyebrow } from '../components/Brand';
import { PublicPage } from '../components/Layout';
import { useResource } from '../lib/useResource';
import { useTitle } from '../lib/useTitle';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether sign-ups are invite-only, from the public config. It never says whether a
 * particular address is invited; the check-email page reads the same either way.
 */
function useSignups(): 'open' | 'invite' | null {
  const api = useApi();
  const config = useResource(() => api.config());
  return config.data?.signups ?? null;
}

function NewHere({ signups }: { signups: 'open' | 'invite' | null }) {
  if (signups === 'invite') {
    return (
      <p className="fine-print">
        New here? Witness is invite-only for now. If your email has been invited, the same link creates your account.
      </p>
    );
  }
  if (signups === 'open') {
    return <p className="fine-print">New here? The same link creates your account. It is free and open source.</p>;
  }
  return null;
}

export function SignIn() {
  useTitle('Sign in');
  const api = useApi();
  const id = useId();
  const signups = useSignups();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setError('That does not look like an email address yet.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.startSignIn(address);
      // Passed in history state, not the URL, so the address stays out of logs and referrers.
      navigate('/check-email', { state: { email: address } });
    } catch {
      setError('The request could not be confirmed. Try again in a moment.');
      setBusy(false);
    }
  }

  return (
    <PublicPage className="container narrow auth">
      <Eyebrow>Sign in</Eyebrow>
      <h1 className="display-sm">Sign in with your email.</h1>
      <p className="lede">Use an email link to sign in. There is no password to remember.</p>
      <form className="auth__form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={`${id}-email`}>Email</label>
          <input
            id={`${id}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            required
          />
        </div>
        {error && (
          <p id={`${id}-error`} className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Sending…' : 'Send the link'}
        </button>
      </form>
      <NewHere signups={signups} />
    </PublicPage>
  );
}

export function CheckEmail() {
  useTitle('Check your email');
  const api = useApi();
  const { state } = useLocation();
  const email = (state as { email?: unknown } | null)?.email;
  const address = typeof email === 'string' ? email : null;
  const [resent, setResent] = useState<'idle' | 'requested' | 'failed'>('idle');
  const signups = useSignups();

  async function resend() {
    if (!address) return;
    try {
      await api.startSignIn(address);
      setResent('requested');
    } catch {
      setResent('failed');
    }
  }

  return (
    <PublicPage className="container narrow auth">
      <Eyebrow>Sign in</Eyebrow>
      <h1 className="display-sm">Check your email.</h1>
      <p className="lede">
        {address ? (
          <>
            If <strong>{address}</strong> has access, check its inbox for a sign-in link. Open the link on this device to sign in.
          </>
        ) : (
          'If your email address has access, check its inbox for a sign-in link. Open the link on this device to sign in.'
        )}
      </p>
      <p className="fine-print">
        The link works once, for 15 minutes. If it does not arrive in a few minutes, look in spam.
        {signups === 'invite' &&
          ' While Witness is invite-only, links go to existing accounts and invited addresses. If you do not already have an account or an invitation, you need an invitation first.'}
      </p>
      <div className="button-row">
        {address && (
          <button type="button" className="btn btn--ghost" onClick={() => void resend()}>
            Send another link
          </button>
        )}
        <button type="button" className="btn btn--quiet" onClick={() => navigate('/signin')}>
          Use a different email
        </button>
      </div>
      <p className="form-status" role="status">
        {resent === 'requested'
          ? 'Another link was requested. Check your email if this address has access.'
          : resent === 'failed'
            ? 'The request could not be confirmed. Try again in a moment.'
            : ''}
      </p>
    </PublicPage>
  );
}
