import { useState } from 'react';
import { useApi } from '../../api/context';
import type { CreatedToken } from '../../api/types';
import { CopyBlock, CopyField } from '../../components/Copy';
import { LINKS } from '../../lib/links';
import { StepFrame, stepHref } from './StepFrame';

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
      <div className="button-row">
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
    <div className="stack-sm">
      <p className="token-configs__once">This key is shown once. It can only add things, never read them.</p>
      <CopyField label="Address" value={`${window.location.origin}/api/v1/capture`} />
      <CopyField label="Key" value={created.token} />
    </div>
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
            A “Send to Witness” shortcut puts Witness in your Share menu. Start with a phone key; the shortcut uses it
            to add things.
          </p>
          <PhoneKey />
          <details className="disclosure">
            <summary>Build the shortcut, about five minutes</summary>
            <p className="fine-print">
              A screenshot is kept as the whole image you send, so crop it to the kind part first. Other people's
              messages in the picture are kept too.
            </p>
            <ol className="plain-steps">
              <li>Open Shortcuts and make a new shortcut called Send to Witness.</li>
              <li>In its details, turn on Show in Share Sheet for Text and Images.</li>
              <li>Add Get Contents of URL. Paste the address above and set Method to POST.</li>
              <li>Add a header named Authorization with the value Bearer, a space, then your key.</li>
              <li>Set Request Body to JSON with these fields:</li>
            </ol>
            <CopyBlock label="Shortcut request body" value={SHORTCUT_BODY} />
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

        <article className="source-card">
          <h2 className="source-card__title">Mac</h2>
          <p>
            Witness for Mac reads new messages on your Mac and sends on only the kind ones. It is coming soon. If you
            are comfortable with Xcode, you can build it from source today.
          </p>
          <a className="link-arrow" href={LINKS.macSource} rel="noopener noreferrer">
            Witness for Mac source <span aria-hidden="true">→</span>
          </a>
        </article>
      </div>
    </StepFrame>
  );
}
