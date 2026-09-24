import type { ReactNode } from 'react';
import { Link } from '../app/router';

/** "MUSE NEXUS" eyebrow over "Witness." with the coral period (SPEC §4). */
export function Wordmark({ to = '/', size = 'md' }: { to?: string; size?: 'md' | 'lg' }) {
  return (
    <Link to={to} className={`wordmark wordmark--${size}`} aria-label="Muse Nexus Witness, home">
      <span className="wordmark__studio" aria-hidden="true">
        Muse Nexus
      </span>
      <span className="wordmark__name" aria-hidden="true">
        Witness<span className="wordmark__dot">.</span>
      </span>
    </Link>
  );
}

/** Tracked-caps label with the coral block cursor. */
export function Eyebrow({ children, tone, as: Tag = 'p' }: { children: ReactNode; tone?: 'seafoam'; as?: 'p' | 'span' | 'h2' }) {
  return <Tag className={tone ? `eyebrow eyebrow--${tone}` : 'eyebrow'}>{children}</Tag>;
}

// Points sit around the edges of the hero card, so the card never hides the motif.
const NODES: [number, number, number][] = [
  [40, 150, 2.5],
  [150, 40, 2],
  [300, 78, 3],
  [455, 30, 2],
  [596, 118, 2.5],
  [604, 330, 2],
  [582, 520, 3],
  [430, 596, 2],
  [240, 588, 2.5],
  [60, 520, 2],
  [22, 330, 2],
];

function hexagon(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
}

/** The studio's network motif, drawn quietly behind the hero card. Decorative only. */
export function Constellation({ className = 'constellation' }: { className?: string }) {
  const outline = `${NODES.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ')} Z`;
  return (
    <svg className={className} viewBox="0 0 620 620" fill="none" aria-hidden="true" focusable="false">
      <path d={outline} stroke="currentColor" strokeOpacity="0.28" strokeWidth="1" />
      <path
        d="M150 40 L455 30 L604 330 M40 150 L300 78 M582 520 L240 588 M22 330 L60 520"
        stroke="currentColor"
        strokeOpacity="0.14"
        strokeWidth="1"
      />
      {NODES.map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="currentColor" fillOpacity="0.7" />
      ))}
      <polygon points={hexagon(596, 118, 17)} stroke="currentColor" strokeOpacity="0.55" fill="var(--bg)" />
      <circle cx="596" cy="118" r="3.5" fill="var(--coral)" />
      <polygon points={hexagon(40, 150, 13)} stroke="var(--lavender)" strokeOpacity="0.5" fill="var(--bg)" />
      <circle cx="40" cy="150" r="2.5" fill="var(--lavender)" />
      <polygon points={hexagon(582, 520, 11)} stroke="currentColor" strokeOpacity="0.4" fill="var(--bg)" />
    </svg>
  );
}

/** The coral opening quotation mark that marks someone else's words. */
export function QuoteMark() {
  return (
    <span className="quote-mark" aria-hidden="true">
      “
    </span>
  );
}
