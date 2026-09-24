// SYNTHETIC sample data for the mock API (local dev, tests, README screenshots).
// Every person, message, and address here is fictional.
import type { Item } from './types';

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** An abstract evening beach: no real photo, no real people. */
export const SAMPLE_PHOTO = svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2140"/><stop offset=".55" stop-color="#c8665a"/><stop offset=".78" stop-color="#f1b47e"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f6f78"/><stop offset="1" stop-color="#132b33"/></linearGradient>
<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff1d6"/><stop offset=".6" stop-color="#ffd29a"/><stop offset="1" stop-color="#ffd29a" stop-opacity="0"/></radialGradient>
</defs>
<rect width="800" height="600" fill="url(#sky)"/>
<circle cx="520" cy="360" r="120" fill="url(#sun)"/>
<rect y="380" width="800" height="220" fill="url(#sea)"/>
<g stroke="#ffd9a8" stroke-opacity=".5" stroke-linecap="round">
<path d="M420 400h200M450 424h140M470 450h90M490 478h50" stroke-width="4"/>
</g>
<path d="M0 520 C 200 500 420 540 800 505 L800 600 L0 600Z" fill="#0b1a1f"/>
<g fill="#0b1a1f">
<circle cx="250" cy="418" r="15"/><path d="M232 520 C 232 470 238 440 250 436 C 262 440 268 470 268 520Z"/>
<circle cx="292" cy="428" r="12"/><path d="M278 522 C 278 480 283 452 292 448 C 301 452 306 480 306 522Z"/>
</g>
</svg>`);

/** An abstract garden table in daylight. */
export const SAMPLE_PHOTO_2 = svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9dcc3"/><stop offset="1" stop-color="#c9b48f"/></linearGradient>
</defs>
<rect width="800" height="800" fill="url(#bg)"/>
<circle cx="610" cy="170" r="210" fill="#7f9c6b" opacity=".55"/>
<circle cx="170" cy="120" r="160" fill="#5f7f55" opacity=".45"/>
<ellipse cx="400" cy="560" rx="300" ry="120" fill="#f7f0e3"/>
<ellipse cx="300" cy="545" rx="62" ry="24" fill="#d8694f"/>
<ellipse cx="470" cy="575" rx="78" ry="28" fill="#27665c" opacity=".85"/>
<circle cx="560" cy="520" r="26" fill="#e6b25a"/>
<rect x="370" y="470" width="26" height="70" rx="8" fill="#f7f0e3" stroke="#b9a37d" stroke-width="3"/>
</svg>`);

const DAY = 86_400_000;
const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 20);

type Seed = Omit<Item, 'createdAt' | 'updatedAt' | 'edited' | 'context' | 'kind' | 'mediaType' | 'mediaUrl'> &
  Partial<Pick<Item, 'kind' | 'mediaType' | 'mediaUrl'>>;

function item(seed: Seed, index: number, now: number): Item {
  const created = now - (index + 1) * 3 * DAY;
  return {
    kind: 'text',
    mediaType: null,
    mediaUrl: null,
    context: null,
    edited: false,
    createdAt: created,
    updatedAt: created,
    ...seed,
  };
}

export function sampleItems(now: number): Item[] {
  const saved: Seed[] = [
    {
      id: 'itm_priya',
      status: 'saved',
      quote: 'You were the calmest person in the room today. The whole team noticed, and so did I.',
      fromName: 'Priya Shah',
      occurredAt: at(2026, 9, 22),
      sourceType: 'email',
      sourceLabel: 'Email',
      category: 'pride',
    },
    {
      id: 'itm_kai_photo',
      status: 'saved',
      kind: 'image',
      quote: null,
      fromName: 'Kai',
      occurredAt: at(2026, 8, 30),
      sourceType: 'photo',
      sourceLabel: 'Photos',
      category: 'love',
      mediaType: 'image/svg+xml',
      mediaUrl: SAMPLE_PHOTO,
    },
    {
      id: 'itm_dad',
      status: 'saved',
      quote: 'Proud of you, kid. Always have been.',
      fromName: 'Dad',
      occurredAt: at(2026, 8, 14),
      sourceType: 'text',
      sourceLabel: 'iMessage',
      category: 'pride',
    },
    {
      id: 'itm_lena',
      status: 'saved',
      quote: 'We picked your proposal because you listened better than anyone else we talked to.',
      fromName: 'Lena Okafor',
      occurredAt: at(2026, 7, 2),
      sourceType: 'email',
      sourceLabel: 'Email',
      category: 'trust',
    },
    {
      id: 'itm_rosa',
      status: 'saved',
      quote: 'Thank you for teaching Mateo to swim. He talks about you every night at dinner.',
      fromName: 'Rosa Alvarez',
      occurredAt: at(2026, 6, 18),
      sourceType: 'email',
      sourceLabel: 'Email',
      category: 'gratitude',
    },
    {
      id: 'itm_jonah',
      status: 'saved',
      quote: "Six months ago you couldn't walk to the mailbox. Today you walked me home.",
      fromName: 'Jonah',
      occurredAt: at(2026, 5, 9),
      sourceType: 'text',
      sourceLabel: 'iMessage',
      category: 'recovery',
    },
    {
      id: 'itm_sam',
      status: 'saved',
      quote: 'Honestly the best mentor I have had. Thank you for believing in me before I did.',
      fromName: 'Sam',
      occurredAt: at(2026, 4, 3),
      sourceType: 'agent',
      sourceLabel: 'Added by Claude Code',
      category: 'gratitude',
    },
    {
      id: 'itm_garden',
      status: 'saved',
      kind: 'mixed',
      quote: 'Same table next summer. You are always welcome here.',
      fromName: 'June',
      occurredAt: at(2026, 3, 21),
      sourceType: 'photo',
      sourceLabel: 'Photos',
      category: 'belonging',
      mediaType: 'image/svg+xml',
      mediaUrl: SAMPLE_PHOTO_2,
    },
    {
      id: 'itm_tess',
      status: 'saved',
      quote: 'You make every room feel like somewhere I belong.',
      fromName: 'Tess',
      occurredAt: at(2025, 12, 24),
      sourceType: 'text',
      sourceLabel: 'iMessage',
      category: 'belonging',
    },
    {
      id: 'itm_unknown',
      status: 'saved',
      quote: "I don't say it enough. I love you, and I'm so glad you're my sister.",
      fromName: null,
      occurredAt: null,
      sourceType: 'screenshot',
      sourceLabel: 'Screenshot',
      category: 'love',
    },
  ];

  const maybe: Seed[] = [
    {
      id: 'itm_maybe_chris',
      status: 'maybe',
      quote: 'Thanks for your help today, appreciate it.',
      fromName: 'Chris',
      occurredAt: at(2026, 9, 19),
      sourceType: 'email',
      sourceLabel: 'Email',
      category: 'gratitude',
    },
    {
      id: 'itm_maybe_ari',
      status: 'maybe',
      quote: "lol you're unbelievable",
      fromName: 'Ari',
      occurredAt: at(2026, 9, 12),
      sourceType: 'text',
      sourceLabel: 'iMessage',
      category: 'other',
    },
    {
      id: 'itm_maybe_morgan',
      status: 'maybe',
      quote: "Congrats on the launch. Let's catch up soon.",
      fromName: 'Morgan',
      occurredAt: at(2026, 9, 5),
      sourceType: 'email',
      sourceLabel: 'Email',
      category: 'accomplishment',
    },
  ];

  return [...saved, ...maybe].map((seed, i) => item(seed, i, now));
}
