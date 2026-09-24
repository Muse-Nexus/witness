import { useApi } from '../api/context';
import { LINKS } from '../lib/links';
import { useResource } from '../lib/useResource';
import { useTitle } from '../lib/useTitle';
import { Article } from './Article';

export function Privacy() {
  useTitle('Privacy');
  const api = useApi();
  const config = useResource(() => api.config());
  const aiCheck = config.data?.aiCheck;
  return (
    <Article eyebrow="Privacy" title="Privacy." lede="What Witness keeps, how it is protected, and what it never does.">
      <h2>What it keeps</h2>
      <p>
        Only the kind part: the exact words, who said them, when, and where they came from, plus any image you send.
        Witness never collects whole threads; a screenshot you send is kept as the whole image, so crop it to the kind
        part. When a message is not kept, only a note that something arrived remains, with no content.
      </p>
      <h2>How it is protected</h2>
      <p>
        What you keep is encrypted when it is stored, with a separate key for each person. Witness's server holds
        those keys, so it can show you your things and send your emails. This is not end-to-end encryption. Senders are
        stored only as scrambled codes, so “never save from this sender” works without keeping their address.
      </p>
      <h2>Where it lives</h2>
      <p>
        On Cloudflare's servers, run by whoever runs this Witness. It is shown only to you, and it never messages the
        people whose words you keep.
      </p>
      <h2>What it never does</h2>
      <p>No ads. No selling data. No analytics on what you keep. No training models on your things.</p>
      <h2>An optional AI check</h2>
      <p>
        Whoever runs a Witness can turn on an AI check for messages it is not sure about. If it is on, those messages go
        to Anthropic, an AI company, to be sorted. The AI can only sort and point to exact words; it never writes
        anything.
        {aiCheck === true && ' On this Witness, the AI check is on.'}
        {aiCheck === false && ' On this Witness, the AI check is off.'}
      </p>
      <h2>You stay in control</h2>
      <p>
        Remove any single thing in one tap. Download everything, or delete everything, from Settings at any time. If
        someone asks for their words to be removed, you can remove them and never save from them again.
      </p>
      <p className="prose__more">
        <a className="link-arrow" href={LINKS.privacyDoc} rel="noopener noreferrer">
          The full privacy notes <span aria-hidden="true">→</span>
        </a>
      </p>
    </Article>
  );
}
