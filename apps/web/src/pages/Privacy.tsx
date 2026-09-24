import { LINKS } from '../lib/links';
import { useTitle } from '../lib/useTitle';
import { Article } from './Article';

export function Privacy() {
  useTitle('Privacy');
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
        Your words and images are encrypted at rest with a key that is yours alone. Senders are stored as keyed hashes,
        so “never save from this sender” works without keeping their address.
      </p>
      <h2>What it never does</h2>
      <p>No ads. No selling data. No analytics on what you keep. No training models on your things.</p>
      <h2>An optional model check</h2>
      <p>
        If the Witness you use turns it on, messages Witness is unsure about are sent to Anthropic's API to be
        classified. The model can only sort and point to exact words; it never writes anything. People who run their
        own Witness can leave it off.
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
