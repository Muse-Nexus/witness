# Muse Nexus Witness — Claude guide (same as AGENTS.md)

Witness keeps the real things people say and do for someone (texts, emails,
photos) and brings one back on the rhythm they chose. It is a mental-health
support tool, so the product rules matter as much as the code.

Read first: `docs/dev/SPEC.md` (the contract), `docs/SAFETY.md` (the rules).

## Rules that are never traded away
- **Verbatim only.** Evidence is the other person's exact words or the original
  image. Never generate, paraphrase or embellish it. Models may only classify
  and pick an exact substring, and code verifies it.
- **Never argue with pain.** No worth scores, streaks, guilt, urgency or
  cheerleading. No exclamation marks in product copy.
- **Reach out only by consent:** the scheduled rhythm the person set, or an
  agent offer they explicitly accept. Never triggered by inferred mood.
- **Crisis first.** Witness is not treatment. Keep the crisis line (988 / findahelpline.com) in deliveries and the app.
- **Never send an empty-handed message.** Nothing to deliver means send nothing.
- **Private by default.** Evidence text and media are encrypted at rest per user.
  No content analytics. Export and delete-everything always work.
- **Synthetic data only** in code, tests, fixtures, docs, screenshots, issues.

## Layout
`apps/core` Worker (API, MCP, email, cron) · `apps/web` React app ·
`apps/mac` Swift collector · `packages/detector` evidence detector ·
`legacy/` a pointer to Proof Gallery v0 in git history (no code).

## Checks
`bun install && bun run check` (typecheck, tests, build). Detector corpus gates
must pass. `cd apps/mac && swift test` for native changes. `bun run e2e` drives
the real web app, Worker, MCP and Mac CLI end to end (Chrome, port 8787).
