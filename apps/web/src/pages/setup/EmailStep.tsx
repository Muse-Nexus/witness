import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import type { ForwardingConfirmation } from '../../api/types';
import { useSession } from '../../app/session';
import { CopyBlock, CopyField } from '../../components/Copy';
import { Tabs } from '../../components/Tabs';
import { providerName, safeConfirmationUrl } from '../../lib/confirmation';
import { gmailFilterQuery, plainCues } from '@witness/detector/gmail';
import { HeardFrom } from './HeardFrom';
import { StepFrame, stepHref } from './StepFrame';

type Provider = 'gmail' | 'outlook' | 'icloud';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'gmail', label: 'Gmail' },
  { id: 'outlook', label: 'Outlook' },
  { id: 'icloud', label: 'iCloud' },
];

export const CONFIRMATION_POLL_MS = 5000;

/**
 * Watches for the forwarding confirmation a provider mails to Witness. It keeps checking
 * while the page is open, so a newer confirmation (a second account, a retry) replaces an
 * older one, and it only ever shows the given provider's.
 */
export function useConfirmation(provider: Provider) {
  const api = useApi();
  const [confirmation, setConfirmation] = useState<ForwardingConfirmation | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const latest = await api.latestConfirmation(provider);
      setConfirmation((current) => {
        if (!latest || latest.provider !== provider) return current && current.provider === provider ? current : null;
        return current && current.receivedAt === latest.receivedAt && current.provider === latest.provider ? current : latest;
      });
    } catch {
      // A failed poll is not worth interrupting anyone for; the next one will try again.
    } finally {
      setChecking(false);
    }
  }, [api, provider]);

  useEffect(() => {
    setConfirmation(null);
    void check();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void check();
    }, CONFIRMATION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [check]);

  return { confirmation, checking, check };
}

function ConfirmationStatus({ state, waitingFor }: { state: ReturnType<typeof useConfirmation>; waitingFor: string }) {
  const { confirmation, checking, check } = state;
  if (!confirmation) {
    return (
      <div className="confirm-box" aria-live="polite">
        <p className="confirm-box__waiting">
          <span className="pulse" aria-hidden="true" />
          Waiting for {waitingFor}. This page checks every few seconds.
        </p>
        <CheckNow checking={checking} check={check} />
      </div>
    );
  }
  const name = providerName(confirmation.provider);
  const url = safeConfirmationUrl(confirmation.url);
  return (
    <div className="confirm-box confirm-box--found" aria-live="polite">
      <p className="confirm-box__found">{name} sent a confirmation.</p>
      {url ? (
        <a className="btn btn--primary btn--small" href={url} target="_blank" rel="noopener noreferrer">
          Confirm it <span aria-hidden="true">↗</span>
        </a>
      ) : (
        !confirmation.code && (
          <p>
            Witness could not find a link or code in it. Remove the Witness address in your email settings and add it
            again, so a new confirmation comes.
          </p>
        )
      )}
      {confirmation.code && <CopyField label="Confirmation code" value={confirmation.code} />}
      {url && confirmation.code && <p>Tap Confirm it, or paste the code in {name}. Either one is enough.</p>}
      <p className="step__aside">This page keeps checking, so a newer confirmation takes this one's place.</p>
    </div>
  );
}

function CheckNow({ checking, check }: { checking: boolean; check: () => Promise<void> }) {
  return (
    <button type="button" className="btn btn--ghost btn--small" onClick={() => void check()} disabled={checking}>
      {checking ? 'Checking…' : 'Check now'}
    </button>
  );
}

function Guide({ steps }: { steps: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="guide">
      {steps.map((step, i) => (
        <li key={step.title} className="guide__step">
          <span className="guide__num" aria-hidden="true">
            {String.fromCharCode(97 + i)}
          </span>
          <div>
            <h3 className="guide__title">{step.title}</h3>
            <div className="guide__body">{step.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Cues() {
  return (
    <ul className="cue-list" aria-label="Phrases">
      {plainCues().map((cue) => (
        <li key={cue} className="cue">
          {cue}
        </li>
      ))}
    </ul>
  );
}

export function EmailStep() {
  const { me } = useSession();
  const [provider, setProvider] = useState<Provider>('gmail');
  const confirmation = useConfirmation(provider);

  const guides: Record<Provider, { title: string; body: ReactNode }[]> = {
    gmail: [
      {
        title: 'Add your Witness address',
        body: (
          <p>
            In Gmail on a computer, open Settings, then See all settings, then Forwarding and POP/IMAP. Choose Add a
            forwarding address and paste your Witness email address.
          </p>
        ),
      },
      {
        title: 'Confirm it',
        body: (
          <>
            <p>Gmail mails a confirmation to Witness. It will show up here.</p>
            <ConfirmationStatus state={confirmation} waitingFor="Gmail's confirmation" />
          </>
        ),
      },
      {
        title: 'Create one filter',
        body: (
          <>
            <p>
              Paste this into the Gmail search bar. Open the search options, choose Create filter, then Forward it to
              your Witness email address. Leave Gmail's main forwarding setting on Disable forwarding: the filter sends
              only likely-kind mail, not your whole inbox.
            </p>
            <CopyBlock label="Gmail filter" value={gmailFilterQuery()} />
          </>
        ),
      },
    ],
    outlook: [
      {
        title: 'Start a rule',
        body: <p>In Outlook on the web, open Settings, then Mail, then Rules, and choose Add new rule.</p>,
      },
      {
        title: 'Choose the words',
        body: (
          <>
            <p>Choose Subject or body includes, and add these phrases:</p>
            <Cues />
          </>
        ),
      },
      {
        title: 'Forward to Witness',
        body: (
          <>
            <p>Set the action to Forward to, paste your Witness email address, and save. If Outlook asks to confirm, it shows up here.</p>
            <ConfirmationStatus state={confirmation} waitingFor="a confirmation, if Outlook sends one" />
          </>
        ),
      },
    ],
    icloud: [
      {
        title: 'Start a rule',
        body: <p>On iCloud.com, open Mail, then Settings, then Rules, and choose Add a rule.</p>,
      },
      {
        title: 'Choose who or what',
        body: (
          <>
            <p>
              iCloud rules cannot read the message itself, only who sent it and the subject. Choose is from and one
              person's address, or Subject contains and a phrase. Add a rule for each. Phrases you could use:
            </p>
            <Cues />
          </>
        ),
      },
      {
        title: 'Forward to Witness',
        body: <p>Choose Then forward to, and paste your Witness email address. Save the rule.</p>,
      },
    ],
  };

  return (
    <StepFrame
      id="email"
      title="Forward the kind ones."
      lede={
        <p>
          This is your private Witness email address. Forward a kind email here, and Witness keeps the kind part in the
          sender's exact words.
        </p>
      }
      next={{ label: 'Next: texts & photos', to: stepHref('texts') }}
    >
      <CopyField label="Your Witness email address" value={me.inboundAddress} />
      <p className="step__aside">
        Forward kind emails here whenever you like. Witness only accepts mail from {me.email}. You can add your other
        addresses in Settings. Witness keeps only the kind part; anything it is not sure about goes to Maybe, and the
        rest is dropped without storing what it said.
      </p>
      <HeardFrom types={['email']} what="your email" check="To check it, forward one kind email to your Witness email address." />
      <h2 className="step__subhead">Or set it up once, so it happens on its own</h2>
      <Tabs label="Your email" tabs={PROVIDERS} selected={provider} onSelect={setProvider}>
        <Guide steps={guides[provider]} />
      </Tabs>
      <p className="step__aside">
        A filter or rule catches new mail from now on. To keep an older email, forward it here by hand.
      </p>
    </StepFrame>
  );
}
