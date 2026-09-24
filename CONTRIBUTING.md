# Contributing to Witness

Thank you for being here. Witness is a small open-source project from the Muse
Nexus studio, and help of every size is welcome: a typo fix, a synthetic test
case, a new source, a translation.

## Principles first

Witness reaches people on hard days, so a few rules come before any feature.
Please read [Safety](docs/SAFETY.md) before your first change. In short:

- **Verbatim only.** Never generate, paraphrase or embellish evidence.
- **Never argue with pain.** No scores, streaks, guilt, urgency or
  cheerleading, and no exclamation marks in product copy.
- **Reach out only by consent.** The rhythm the person chose, or an assistant
  offer they accept. Never based on inferred mood.
- **Crisis first**, and **never an empty-handed message**.
- **Private by default.** No content analytics. Export and delete always work.

## Synthetic data only

Code, tests, fixtures, docs, screenshots, issues and pull requests use made-up
data: fictional names, `example.com` addresses, `555-01xx` phone numbers.
Never paste real messages, emails, photos, exports, databases, tokens or keys,
even your own, even redacted.

## Set up

You need [Bun](https://bun.sh) 1.2.23 and [Node.js](https://nodejs.org) 22 or
later (Wrangler, which runs the Worker, needs it). For the Mac collector you
also need macOS 14+ and Swift 6. `bun run e2e` needs Google Chrome: it looks in
`/Applications` on a Mac; anywhere else set `CHROME`, for example
`CHROME=$(which google-chrome) bun run e2e`.

```sh
bun install
bun run check          # typecheck, tests and build for all workspaces
bun run e2e            # the whole product end to end (needs Chrome, port 8787)
cd apps/mac && swift test   # only if you changed Swift code
```

To run the app locally: `bun run setup:dev` once, then `bun run dev`. More in
[Self-hosting: local development](docs/SELF_HOSTING.md#local-development).

## Where things live

`apps/core` (Worker: API, MCP, email, cron) · `apps/web` (React app) ·
`apps/mac` (Swift collector) · `packages/detector` (evidence detector) ·
`docs` (guides, safety, privacy). The contract between them is
[docs/dev/SPEC.md](docs/dev/SPEC.md); [Architecture](docs/ARCHITECTURE.md) is
the map. `legacy/` only points to Proof Gallery v0 in the git history; it is not maintained.

## Making a change

1. Pick something from [good first issues](docs/dev/good-first-issues.md), or
   open an issue describing what you'd like to change.
2. Keep the pull request small and focused.
3. Add or update tests. Detector changes must keep the corpus gates passing.
   `bun run check` runs typecheck, tests and the build; `bun run e2e` runs the
   whole product end to end (web app in headless Chrome against the real Worker,
   MCP, email, cron, and on macOS the Mac helper), with synthetic data only. It
   needs Google Chrome and a free port 8787.
4. If behavior changes, update the relevant guide in the same pull request.
5. Fill in the pull request checklist.

**Adding a source?** Any app can send evidence through one endpoint. Read
[adding a source](docs/ARCHITECTURE.md#adding-a-source) for the contract and
the rules.

**Tuning the detector?** Most tuning is data, not code: edit
`packages/detector/lexicon.json` (documented in `packages/detector/LEXICON.md`)
and add synthetic examples to the corpus.

## AI-assisted development

Parts of this codebase were written with AI coding assistants and reviewed by
maintainers. You are welcome to use them too. You are responsible for what you
submit: read it, test it, and make sure it follows the rules above. Please
mention in your pull request if an assistant wrote a substantial part of it.

## Licensing

Witness is MIT licensed. By contributing, you agree that your contribution is
licensed under the same terms. No contributor license agreement and no DCO
sign-off are required.

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security problems privately, as described in [SECURITY.md](SECURITY.md), not in
a public issue.

Questions are welcome as a **Question** issue (New issue → Question) or at
hello@musenexus.studio.
