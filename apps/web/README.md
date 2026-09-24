# Muse Nexus Witness · web app

The landing page, sign-in, setup wizard, gallery and settings for Witness. React 19 +
Vite, plain CSS, a tiny History API router, no UI framework. It talks only to the
same-origin core API (`apps/core`, see `docs/dev/SPEC.md` §8 and §10.1).

## Run it

```sh
bun install                              # at the repo root
cd apps/web
VITE_MOCK_API=1 bunx vite --port 5391    # synthetic data, no core needed
bunx vite                                # against core on :8787 (bun run dev at the root)
```

Against core, the dev server proxies `/api`, `/auth`, `/mcp` and `/d` to it and presents
core's own origin, so core's same-origin check passes and saving, adding and signing in
work with hot reload.

`VITE_MOCK_API=1` swaps the API for an in-memory mock (`src/api/mock.ts`) seeded with
**fictional** people and messages (`src/api/mockData.ts`). The mock is its own chunk and
is left out of production builds.

## Check it

```sh
bun run typecheck && bun run test && bun run build
```

Tests use Vitest, jsdom and Testing Library, and run the whole app against the mock.
`src/voice.test.tsx` reads every page and fails on exclamation marks, cheerleading, or a
missing crisis line.

## Layout

| Path | What |
|---|---|
| `src/api/` | Typed REST client (CSRF header on every mutation), wire types, mock API |
| `src/app/` | Router, routes, session gate |
| `src/components/` | Wordmark, cards, menus, copy fields, tabs, rhythm form, assistant keys |
| `src/pages/` | Landing, sign-in, home, maybe, setup (one file per step), settings, privacy, safety |
| `src/lib/` | Formatting, assistant configs, links (the repo URL lives in `links.ts`). The Gmail filter comes from `@witness/detector/gmail` (the cue terms in `packages/detector/lexicon.json`) |
| `src/styles/tokens.css` | Muse Nexus brand tokens; dark default, light via `prefers-color-scheme` |
| `public/_headers` | Strict CSP and security headers for Workers static assets |
| `brand/` | Sources for `og.png` and `apple-touch-icon.png` |

## Brand and voice

Muse Nexus: black ink, warm cream, coral accent; Fraunces for display and for every
quoted word (italic, with a coral opening mark), Inter for the interface; the coral
block cursor before eyebrows; hairline rules; lots of space. Copy is calm, plain and
second person, with no exclamation marks and nothing that tells anyone how to feel.
Append `?theme=light` or `?theme=dark` to any URL to pin a theme.

## Images

```sh
node scripts/brand.mjs      # brand/ → public/og.png, public/apple-touch-icon.png
node scripts/screens.mjs    # README screenshots → docs/assets/screens (mock server on :5391)
```

Both drive headless Chrome over the DevTools protocol; set `CHROME` if it is not in the
default macOS location.
