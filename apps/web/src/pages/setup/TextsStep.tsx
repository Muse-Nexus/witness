import { useState } from 'react';
import { useApi } from '../../api/context';
import type { CreatedToken } from '../../api/types';
import { CopyBlock, CopyField } from '../../components/Copy';
import { LINKS } from '../../lib/links';
import { readyShortcutsFor, readyShortcutsHost } from '../../lib/shortcuts';
import { StepFrame, stepHref } from './StepFrame';

/** What each ready-made shortcut is for, by its id in lib/shortcuts.json. */
const SHORTCUT_NOTES: Record<string, string> = {
  text: 'For a kind text or email. Share it to the shortcut, or copy it and run the shortcut.',
  image: 'For a screenshot or photo, sent as the original file.',
};

// "shared": you chose this one, so Witness keeps it (in Maybe at worst) even when it is not sure.
const SHORTCUT_BODY = `{
  "sourceType": "text",
  "sourceLabel": "iPhone",
  "text": "<Shortcut Input>",
  "shared": true
}`;

// The sender lets "Never save from this sender" work for texts an automation sends in.
const AUTOMATION_BODY = `{
  "sourceType": "text",
  "sourceLabel": "iPhone",
  "text": "<Message Content>",
  "fromHandle": "<Sender>"
}`;

/** Where the Mac card's steps point for a key: the phone key is the key for the Mac too. */
const PHONE_KEY_ID = 'phone-key';

function PhoneKey() {
  const api = useApi();
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setCreated(await api.createToken({ label: 'iPhone', kind: 'device', scopes: ['capture'] }));
    } catch {
      setError('The key was not created. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  if (!created) {
    return (
      <div className="button-row" id={PHONE_KEY_ID}>
        <button type="button" className="btn btn--ghost" onClick={() => void create()} disabled={busy}>
          Create a phone key
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="stack-sm" id={PHONE_KEY_ID}>
      <p className="token-configs__once">This key is shown once. It can only add things, never read them.</p>
      <CopyField label="Address" value={`${window.location.origin}/api/v1/capture`} />
      <CopyField label="Key" value={created.token} />
    </div>
  );
}

/** One tap per shortcut, where they were built for this Witness. */
function ReadyShortcuts() {
  const shortcuts = readyShortcutsFor(window.location.origin);
  if (!shortcuts) {
    return (
      <p className="fine-print">
        The ready-made shortcuts send to {readyShortcutsHost()}, not to this Witness. Build them yourself below, or{' '}
        <a href={LINKS.iphoneGuide} rel="noopener noreferrer">
          make ready-made ones for this Witness
        </a>
        .
      </p>
    );
  }
  return (
    <>
      <ol className="plain-steps">
        <li>Create a phone key and copy it.</li>
        <li>On your iPhone, tap Add to iPhone. If Safari asks, download the file, then open it.</li>
        <li>Tap Add Shortcut, then paste your key when it asks.</li>
      </ol>
      <ul className="shortcut-list">
        {shortcuts.map((s) => (
          <li key={s.id} className="shortcut-row">
            <span className="shortcut-row__text">
              <span id={`shortcut-${s.id}`} className="shortcut-row__name">
                {s.name}
              </span>
              <span className="row__note">{SHORTCUT_NOTES[s.id]}</span>
            </span>
            <a className="btn btn--primary" href={s.href} download={`${s.name}.shortcut`} aria-describedby={`shortcut-${s.id}`}>
              Add to iPhone
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

export function TextsStep() {
  return (
    <StepFrame
      id="texts"
      title="Texts and photos."
      lede={<p>Send a kind text, a screenshot, or a photo to Witness from your phone, in a couple of taps.</p>}
      next={{ label: 'Next: your rhythm', to: stepHref('rhythm') }}
    >
      <div className="source-cards">
        <article className="source-card">
          <h2 className="source-card__title">iPhone</h2>
          <p>
            Two shortcuts put Witness in your Share menu: one for text, one for screenshots and photos. Start with a
            phone key; the shortcuts use it to add things.
          </p>
          <PhoneKey />
          <ReadyShortcuts />
          <p className="fine-print">
            A screenshot is kept as the whole image you send, so crop it to the kind part first. Other people's messages
            in the picture are kept too.
          </p>
          <details className="disclosure">
            <summary>Build it yourself</summary>
            <ol className="plain-steps">
              <li>Open Shortcuts and make a new shortcut called Send to Witness.</li>
              <li>In its details, turn on Show in Share Sheet for Text.</li>
              <li>Add Get Contents of URL. Paste the address above and set Method to POST.</li>
              <li>Add a header named Authorization with the value Bearer, a space, then your key.</li>
              <li>Set Request Body to JSON with these fields:</li>
            </ol>
            <CopyBlock label="Shortcut request body" value={SHORTCUT_BODY} />
            <p className="fine-print">
              For screenshots and photos, the{' '}
              <a href={LINKS.iphoneGuide} rel="noopener noreferrer">
                iPhone guide
              </a>{' '}
              has the steps.
            </p>
          </details>
          <details className="disclosure">
            <summary>Send texts from one person on their own</summary>
            <ol className="plain-steps">
              <li>In Shortcuts, open Automation and choose New Automation, then Message.</li>
              <li>Pick the people whose kind words you want kept, and choose Run Immediately.</li>
              <li>Use the same Get Contents of URL action, with Message Content as the text and Sender as fromHandle:</li>
            </ol>
            <CopyBlock label="Automation request body" value={AUTOMATION_BODY} />
            <p className="fine-print">
              Witness keeps only the kind ones. The rest are not stored. With the sender included, “Never save from this
              sender” works for these texts too.
            </p>
          </details>
        </article>

        <article className="source-card" aria-labelledby="source-mac">
          <h2 id="source-mac" className="source-card__title">
            Mac
          </h2>
          <p>Witness for Mac reads your texts on your Mac and sends on only the kind ones. The rest stay on your Mac.</p>
          <div className="button-row">
            <a className="btn btn--primary" href={LINKS.macDownload} rel="noopener noreferrer">
              Download Witness for Mac
            </a>
            <span className="fine-print">For macOS 14 or later.</span>
          </div>
          <ol className="plain-steps">
            <li>
              Open it and paste a <a href={`#${PHONE_KEY_ID}`}>phone key from this page</a>.
            </li>
            <li>Allow Full Disk Access when it asks.</li>
            <li>Choose how far back to look.</li>
          </ol>
        </article>
      </div>
    </StepFrame>
  );
}
