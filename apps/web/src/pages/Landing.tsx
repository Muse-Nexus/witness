import { Link } from '../app/router';
import { Constellation, Eyebrow } from '../components/Brand';
import { PublicPage } from '../components/Layout';
import { ExampleCard, type QuoteCardItem } from '../components/QuoteCard';
import { LINKS } from '../lib/links';
import { useTitle } from '../lib/useTitle';

// Fictional. Shown only as a labelled example.
const EXAMPLE: QuoteCardItem = {
  id: 'example',
  quote:
    'I never said it properly, so here it is. Those Sunday calls last winter got me through. Thank you for checking on me, every single week.',
  fromName: 'Noa',
  occurredAt: Date.UTC(2026, 0, 12, 20),
  sourceLabel: 'iMessage',
  sourceType: 'text',
  category: 'gratitude',
  mediaType: null,
  mediaUrl: null,
  edited: false,
};

const BEATS = [
  {
    title: 'It keeps the real things.',
    body: "Forward a kind email. Share a text or a screenshot. Witness keeps the other person's exact words, with who said them and when. If it is not sure, it puts the message in Maybe. You never have to look there, and nothing in Maybe is emailed to you.",
  },
  {
    title: 'It comes to you.',
    body: 'On the days and time you choose, Witness emails you one thing you kept. If you use an AI assistant, it can ask whether you would like to see one, and it shows you only if you say yes.',
  },
  {
    title: "It's yours.",
    body: 'Encrypted when stored, though not end-to-end, and shown only to you. Download or delete everything at any time. The code is open, so anyone can check how it works, or run their own Witness.',
  },
];

const SOURCES = [
  { name: 'Email', body: 'Forward a kind email any time, or set up one filter once, on a computer, and let it run.' },
  {
    name: 'Texts and screenshots',
    body: 'On iPhone, add the Witness shortcut once. Then share a text or a screenshot in two taps. On a Mac, Witness for Mac can pick up kind texts on its own. Not on Android yet.',
  },
  { name: 'Photos', body: 'Keep the picture with the people who love you, as it is.' },
  {
    name: 'Your AI assistant',
    body: 'Works with AI tools that can connect to other apps, such as Claude Code and Codex. It asks before it shows you anything. The Claude app cannot connect yet.',
  },
];

export function Landing() {
  useTitle();
  return (
    <PublicPage className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="container hero__grid">
          <div className="hero__text">
            <Eyebrow>Muse Nexus Witness · Open source</Eyebrow>
            <h1 id="hero-title" className="display">
              A witness to <em>your life.</em>
            </h1>
            <p className="lede hero__lede">
              Witness quietly keeps the real, kind things people say and do for you, and emails you one on the days you
              choose.
            </p>
            <div className="button-row">
              <Link to="/signin" className="btn btn--primary">
                Start <span aria-hidden="true">→</span>
              </Link>
              <Link to="/#how" className="btn btn--ghost">
                How it works
              </Link>
            </div>
          </div>
          <div className="hero__art">
            <Constellation />
            <p className="delivery-chip" aria-hidden="true">
              <span className="delivery-chip__dot" />
              Something you kept, for Tuesday · 8:30 AM
            </p>
            <ExampleCard item={EXAMPLE} />
          </div>
        </div>
      </section>

      <section id="how" className="section" aria-labelledby="how-title">
        <div className="container">
          <hr className="rule rule--glow" />
          <Eyebrow>How it works</Eyebrow>
          <div className="section__head">
            <h2 id="how-title" className="display-md">
              Set it up once, on a good day.
            </h2>
            <p className="section__intro">
              On a hard day, opening an app can be too much. So you set Witness up once: connect your email and phone, and
              choose when it emails you. After that, it asks for nothing.
            </p>
          </div>
          <ol className="beats">
            {BEATS.map((beat, i) => (
              <li key={beat.title} className="beat">
                <span className="beat__num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="beat__title">{beat.title}</h3>
                <p>{beat.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="band" aria-labelledby="sources-title">
        <div className="container band__grid">
          <div>
            <Eyebrow>Where things come from</Eyebrow>
            <h2 id="sources-title" className="display-md">
              It works where people already reach you.
            </h2>
          </div>
          <ul className="sources">
            {SOURCES.map((source) => (
              <li key={source.name} className="sources__item">
                <h3 className="sources__name">{source.name}</h3>
                <p>{source.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="not-title">
        <div className="container honest">
          <Eyebrow>What Witness is not</Eyebrow>
          <h2 id="not-title" className="display-md">
            Not therapy. Not crisis care.
          </h2>
          <div className="honest__body">
            <p>
              Witness never tries to talk you out of how you feel, and it never reaches out because it guessed your
              mood. It brings back what someone really said, when you asked it to. That is all it does.
            </p>
            <p className="crisis-callout">
              If you are in crisis, call or text <a href="tel:988">988</a> in the US, or find a line near you at{' '}
              <a href={LINKS.crisisWorld} rel="noopener noreferrer">
                findahelpline.com
              </a>
              .
            </p>
          </div>
          <nav className="link-row" aria-label="Learn more">
            <Link to="/safety" className="link-arrow">
              Safety <span aria-hidden="true">→</span>
            </Link>
            <Link to="/privacy" className="link-arrow">
              Privacy <span aria-hidden="true">→</span>
            </Link>
            <a href={LINKS.selfHost} className="link-arrow" rel="noopener noreferrer">
              Self-host <span aria-hidden="true">→</span>
            </a>
            <a href={LINKS.repo} className="link-arrow" rel="noopener noreferrer">
              GitHub <span aria-hidden="true">→</span>
            </a>
          </nav>
        </div>
      </section>
    </PublicPage>
  );
}
