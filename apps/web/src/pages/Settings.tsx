import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { EXPORT_PATH } from '../api/client';
import { useApi } from '../api/context';
import type { Rhythm, TokenSummary } from '../api/types';
import { Link, navigate } from '../app/router';
import { useSession } from '../app/session';
import { AssistantKey } from '../components/AssistantKey';
import { Eyebrow } from '../components/Brand';
import { CopyField } from '../components/Copy';
import { AppPage } from '../components/Layout';
import { RhythmForm, describeRhythm } from '../components/RhythmForm';
import { formatDate, formatWeekdayDate, relativeAgo } from '../lib/format';
import { useResource } from '../lib/useResource';
import { useTitle } from '../lib/useTitle';

export const DELETE_PHRASE = 'delete everything';

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="settings-section__label">
        <h2 id={`${id}-title`} className="settings-section__title">
          {title}
        </h2>
        {intro && <p className="settings-section__intro">{intro}</p>}
      </div>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function Feedback({ error, message }: { error: string | null; message: string | null }) {
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="form-status" role="status">
        {message}
      </p>
    </>
  );
}

function PauseControls({ rhythm, onChange }: { rhythm: Rhythm | undefined; onChange: (r: Rhythm) => void }) {
  const api = useApi();
  const id = useId();
  const [custom, setCustom] = useState('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const now = useMemo(() => Date.now(), []);
  const pausedUntil = rhythm?.pausedUntil != null && rhythm.pausedUntil > now ? rhythm.pausedUntil : null;

  async function run(action: () => Promise<Rhythm>, done: (r: Rhythm) => string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await action();
      onChange(next);
      setMessage(done(next));
    } catch {
      setError('That did not go through. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  const pause = (days: number) =>
    run(
      () => api.pause(days),
      (r) => (r.pausedUntil ? `Paused until ${formatWeekdayDate(r.pausedUntil)}.` : 'Paused.'),
    );

  if (pausedUntil) {
    return (
      <div className="stack-sm">
        <p className="settings-fact">Paused until {formatWeekdayDate(pausedUntil)}. Witness still keeps what arrives.</p>
        <div className="button-row">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run(() => api.resume(), () => 'Resumed.')}>
            Resume now
          </button>
        </div>
        <Feedback error={error} message={message} />
      </div>
    );
  }

  function onCustom(event: FormEvent) {
    event.preventDefault();
    const days = Number(custom);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      setError('Choose between 1 and 90 days.');
      return;
    }
    void pause(days);
  }

  return (
    <div className="stack-sm">
      <div className="button-row">
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void pause(1)}>
          Pause for a day
        </button>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void pause(7)}>
          Pause for a week
        </button>
      </div>
      <form className="inline-form inline-form--row" onSubmit={onCustom}>
        <div className="field field--short">
          <label htmlFor={`${id}-days`}>Or a number of days</label>
          <input id={`${id}-days`} type="number" min={1} max={90} inputMode="numeric" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--ghost" disabled={busy}>
          Pause
        </button>
      </form>
      <Feedback error={error} message={message} />
    </div>
  );
}

/** A new Witness address, for when the old one was shared or seen where it should not have been. */
function NewAddress() {
  const api = useApi();
  const { refresh } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      await api.newInboundAddress();
      await refresh();
      setConfirming(false);
      setMessage('Your new address is above. Update your forwarding rules to use it.');
    } catch {
      setError('The address was not changed. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-sm">
      {confirming ? (
        <div className="row__confirm">
          <span className="row__note">The old address stops working right away. Anything forwarded to it will be turned away.</span>
          <button type="button" className="btn btn--danger btn--small" disabled={busy} onClick={() => void rotate()}>
            Get a new address
          </button>
          <button type="button" className="btn btn--quiet btn--small" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--quiet btn--small" onClick={() => setConfirming(true)}>
          Get a new address
        </button>
      )}
      <Feedback error={error} message={message} />
    </div>
  );
}

function Addresses() {
  const api = useApi();
  const { me } = useSession();
  const id = useId();
  const list = useResource(() => api.addresses());
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    const value = address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError('That does not look like an email address yet.');
      return;
    }
    setError(null);
    try {
      const added = await api.addAddress(value);
      list.set((current) => [...(current ?? []).filter((a) => a.address !== added.address), added]);
      setAddress('');
      setMessage(`${added.address} can now forward to Witness.`);
    } catch {
      setError('That address was not added. Try again in a moment.');
    }
  }

  async function remove(value: string) {
    try {
      await api.removeAddress(value);
      list.set((current) => (current ?? []).filter((a) => a.address !== value));
      setMessage(`${value} removed.`);
    } catch {
      setError('That address was not removed. Try again in a moment.');
    }
  }

  return (
    <div className="stack">
      <CopyField label="Your Witness address" value={me.inboundAddress} />
      <p className="settings-fact">Keep it private. If someone it should not reach has seen it, get a new one.</p>
      <NewAddress />
      <div>
        <h3 className="settings-subhead">Addresses that can forward to it</h3>
        <ul className="rows">
          {(list.data ?? []).map((a) => (
            <li key={a.address} className="row">
              <span className="row__main">
                {a.address}
                {a.address === me.email && <span className="row__note"> · your sign-in email</span>}
              </span>
              {a.address !== me.email && (
                <button type="button" className="btn btn--quiet btn--small" aria-label={`Remove ${a.address}`} onClick={() => void remove(a.address)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <form className="inline-form inline-form--row" onSubmit={add}>
        <div className="field">
          <label htmlFor={`${id}-address`}>Add an address you forward from</label>
          <input id={`${id}-address`} type="email" autoComplete="email" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--ghost">
          Add
        </button>
      </form>
      <Feedback error={error} message={message} />
    </div>
  );
}

function TokenRow({ token, onRevoked }: { token: TokenSummary; onRevoked: (id: string) => void }) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useMemo(() => Date.now(), []);

  async function revoke() {
    setBusy(true);
    try {
      await api.revokeToken(token.id);
      onRevoked(token.id);
    } catch {
      setError('That key was not revoked. Try again in a moment.');
      setBusy(false);
    }
  }

  return (
    <li className="row row--token">
      <span className="row__main">
        <span className="row__title">{token.label}</span>
        <span className="row__note">
          {token.kind === 'agent' ? 'Assistant' : 'Device'} · added {formatDate(token.createdAt)} ·{' '}
          {token.lastUsedAt ? `last used ${relativeAgo(token.lastUsedAt, now)}` : 'not used yet'}
        </span>
      </span>
      {confirming ? (
        <span className="row__confirm">
          <span className="row__note">It stops working right away.</span>
          <button type="button" className="btn btn--danger btn--small" aria-label={`Revoke ${token.label}`} disabled={busy} onClick={() => void revoke()}>
            Revoke
          </button>
          <button type="button" className="btn btn--quiet btn--small" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="btn btn--quiet btn--small" aria-label={`Revoke ${token.label}`} onClick={() => setConfirming(true)}>
          Revoke
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function Tokens() {
  const api = useApi();
  const list = useResource(() => api.tokens());
  const [adding, setAdding] = useState(false);
  const active = (list.data ?? []).filter((t) => !t.revokedAt);

  return (
    <div className="stack">
      {active.length > 0 ? (
        <ul className="rows">
          {active.map((token) => (
            <TokenRow key={token.id} token={token} onRevoked={(id) => list.set((current) => (current ?? []).filter((t) => t.id !== id))} />
          ))}
        </ul>
      ) : (
        list.data && <p className="settings-fact">No assistants or devices are connected.</p>
      )}
      {adding ? (
        <AssistantKey onCreated={() => void list.reload()} />
      ) : (
        <div className="button-row">
          <button type="button" className="btn btn--ghost" onClick={() => setAdding(true)}>
            Add an assistant
          </button>
          <Link to="/app/setup?step=texts" className="btn btn--quiet">
            Add a phone
          </Link>
        </div>
      )}
    </div>
  );
}

function BlockedSenders() {
  const api = useApi();
  const id = useId();
  const list = useResource(() => api.blockedSenders());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [label, setLabel] = useState('');

  async function block(event: FormEvent) {
    event.preventDefault();
    if (handle.trim().length < 3) {
      setError('Enter a phone number or an email address.');
      return;
    }
    setError(null);
    try {
      const added = await api.blockHandle(handle.trim(), label.trim() || undefined);
      list.set((current) => [added, ...(current ?? [])]);
      setHandle('');
      setLabel('');
      setMessage('Witness will not save anything from them.');
    } catch {
      setError('That did not go through. Try again in a moment.');
    }
  }

  // The number or address is turned into a key right away and never kept as written.
  const form = (
    <form className="inline-form" onSubmit={block}>
      <div className="field">
        <label htmlFor={`${id}-handle`}>Block a phone number or email address</label>
        <input id={`${id}-handle`} value={handle} onChange={(e) => setHandle(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor={`${id}-label`}>A name for it here (optional)</label>
        <input id={`${id}-label`} value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
      </div>
      <button type="submit" className="btn btn--ghost">
        Never save from them
      </button>
      <p className="fine-print">Witness keeps only a key made from it, never the number or address itself.</p>
    </form>
  );

  async function allow(senderKey: string) {
    try {
      await api.unblockSender(senderKey);
      list.set((current) => (current ?? []).filter((s) => s.senderKey !== senderKey));
      setMessage('Witness can save from them again.');
    } catch {
      setError('That did not go through. Try again in a moment.');
    }
  }

  if (list.data && list.data.length === 0) {
    return (
      <div className="stack-sm">
        <p className="settings-fact">No one. Choose “Never save from this sender” on any card, or add a number or address below.</p>
        {form}
        <Feedback error={error} message={message} />
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <ul className="rows">
        {(list.data ?? []).map((sender, i) => {
          const name = sender.label?.trim() || `Sender ${i + 1}`;
          return (
            <li key={sender.senderKey} className="row">
              <span className="row__main">
                <span className="row__title">{name}</span>
                <span className="row__note">since {formatDate(sender.createdAt)}</span>
              </span>
              <button type="button" className="btn btn--quiet btn--small" aria-label={`Allow ${name} again`} onClick={() => void allow(sender.senderKey)}>
                Allow again
              </button>
            </li>
          );
        })}
      </ul>
      {form}
      <Feedback error={error} message={message} />
    </div>
  );
}

function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const api = useApi();
  const id = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === DELETE_PHRASE;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      onDeleted();
    } catch {
      setError('Nothing was deleted. Try again in a moment.');
      setBusy(false);
    }
  }

  return (
    <form className="danger-zone" onSubmit={submit}>
      <p>
        This deletes everything Witness has kept for you, your rhythm, and every key, and it cannot be undone. You may
        want to download everything first.
      </p>
      <div className="field">
        <label htmlFor={`${id}-confirm`}>
          Type <strong>{DELETE_PHRASE}</strong> to confirm
        </label>
        <input id={`${id}-confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      <button type="submit" className="btn btn--danger" disabled={!matches || busy}>
        Delete everything
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function Settings() {
  useTitle('Settings');
  const api = useApi();
  const { me } = useSession();
  const rhythm = useResource(() => api.rhythm());
  const [deleted, setDeleted] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.signOut();
    } finally {
      navigate('/', { replace: true });
    }
  }

  if (deleted) {
    return (
      <AppPage className="container narrow page-message">
        <Eyebrow>Deleted</Eyebrow>
        <h1 className="display-sm">Everything is deleted.</h1>
        <p className="lede">Witness no longer holds anything of yours. Take care.</p>
        <Link to="/" className="btn btn--ghost">
          Go to the start
        </Link>
      </AppPage>
    );
  }

  const summary = rhythm.data?.enabled ? `On, at ${describeRhythm(rhythm.data)}.` : 'Off. Nothing is sent.';

  return (
    <AppPage className="container settings">
      <Eyebrow>Your Witness</Eyebrow>
      <h1 className="display-sm">Settings.</h1>
      <p className="lede">Everything here can be changed any time.</p>

      <Section id="rhythm" title="Rhythm" intro={rhythm.data ? summary : undefined}>
        {rhythm.loading && !rhythm.data ? (
          <p className="loading">Loading…</p>
        ) : (
          <RhythmForm key={rhythm.data ? 'loaded' : 'default'} initial={rhythm.data} email={me.email} variant="settings" onSaved={(r) => rhythm.set(r)} />
        )}
      </Section>

      <Section id="pause" title="Pause" intro="Take a break: no deliveries, and no offers from assistants. Nothing is lost.">
        <PauseControls rhythm={rhythm.data} onChange={(r) => rhythm.set((current) => ({ ...(current ?? r), ...r }))} />
      </Section>

      <Section id="email" title="Email" intro="Mail forwarded from these addresses is accepted. Anything else is turned away.">
        <Addresses />
      </Section>

      <Section id="assistants" title="Assistants and devices" intro="Each has its own key. Revoke one and it stops working right away.">
        <Tokens />
      </Section>

      <Section
        id="blocked"
        title="Never save from"
        intro="Witness will not keep anything new from these senders. Allowing someone again does not bring back anything that was removed."
      >
        <BlockedSenders />
      </Section>

      <Section id="data" title="Your data" intro="A JSON file with everything Witness has kept, images included.">
        <a className="btn btn--ghost" href={EXPORT_PATH} download="witness-export.json">
          Download everything
        </a>
      </Section>

      <Section id="account" title="Account" intro={<>Signed in as {me.email}.</>}>
        <div className="stack">
          <div className="button-row">
            <button type="button" className="btn btn--ghost" onClick={() => void signOut()} disabled={signingOut}>
              Sign out
            </button>
          </div>
          <DeleteAccount onDeleted={() => setDeleted(true)} />
        </div>
      </Section>
    </AppPage>
  );
}
