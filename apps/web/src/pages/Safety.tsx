import { LINKS } from '../lib/links';
import { useTitle } from '../lib/useTitle';
import { Article } from './Article';

function CrisisBox() {
  return (
    <aside className="crisis-box" aria-label="Crisis support">
      <p>
        If you are in crisis, call or text <a href="tel:988">988</a> in the US. Elsewhere, find a line near you at{' '}
        <a href={LINKS.crisisWorld} rel="noopener noreferrer">
          findahelpline.com
        </a>
        .
      </p>
    </aside>
  );
}

export function Safety() {
  useTitle('Safety');
  return (
    <Article eyebrow="Safety" title="Safety." lede="Witness is built for people on hard days. These are the rules it keeps.">
      <CrisisBox />
      <h2>It is not treatment</h2>
      <p>
        Witness is not therapy and not crisis care. No clinician reads what you keep. It holds on to real things people
        said, and gives them back when you asked it to.
      </p>
      <h2>It reaches out only two ways</h2>
      <p>
        By the rhythm you chose, or when an assistant you connected offers one and you say yes. It never reaches out
        because it guessed how you feel, and it never messages anyone else.
      </p>
      <h2>Exact words only</h2>
      <p>
        What you see is what the other person said, word for word. Witness never paraphrases, summarizes, or writes
        anything new. When it does not know who or when, it says so.
      </p>
      <h2>It never argues with pain</h2>
      <p>No scores, streaks, guilt, or cheering on. Nothing that tells you how to feel.</p>
      <h2>Never an empty message</h2>
      <p>If there is nothing to send, nothing is sent.</p>
      <h2>Assistants ask first</h2>
      <p>
        A connected assistant sees nothing of what you kept until you say yes to its offer, or ask it to search, if you
        turned search on for it. If you say no, it lets it go. It asks at most once a day, never while Witness is
        paused, and it is told to put crisis resources first.
      </p>
      <p className="prose__more">
        <a className="link-arrow" href={LINKS.safetyDoc} rel="noopener noreferrer">
          The full safety rules <span aria-hidden="true">→</span>
        </a>
      </p>
    </Article>
  );
}
