# Security policy

Witness holds some of the most personal things people receive. If you find a
way to read, change or delete someone else's evidence, or to make Witness
contact someone without their consent, we want to hear about it.

## Reporting a vulnerability

Please do not report security problems in public issues or Discussions.

- Use **Security → Report a vulnerability** in this GitHub repository
  (private security advisories), or
- email **hello@musenexus.studio** with "Security" in the subject.

Include what you found, how to reproduce it with **synthetic data**, the
affected commit, and the impact you expect. Never include real evidence,
personal messages, credentials, tokens, signed links or production data.

We will acknowledge your report privately before discussing a fix and a
disclosure date with you. Please give us a reasonable chance to fix the
problem before you share details.

## Supported versions

The latest commit on `main`. v1 is in active development and not yet deployed.

## In scope

- `apps/core`: sign-in links, sessions and cookies, CSRF checks, agent and
  device tokens and their scopes, the per-user encryption and key derivation,
  signed delivery links, inbound email sender checks and forwarding
  confirmations, rate limiting, export and delete-everything, and the MCP
  offer and reveal rules (an offer must never carry evidence; a reveal must be
  single-use, same-token and time-limited).
- `apps/web`: anything that exposes one person's evidence to another, or
  bypasses the rules above.
- `apps/mac`: read-only access to the Messages database, what leaves the Mac,
  and how the device token is stored.
- `packages/detector`: any way the model judge's output could be shown to a
  person without being an exact substring of the original text.
- Documentation that would lead a self-hoster into an insecure setup.

## Out of scope

- Proof Gallery v0 (see `legacy/README.md`), which is no longer in this tree
  and is not maintained. Reports are still welcome, but fixes are not
  guaranteed.
- Vulnerabilities in Cloudflare, Resend, Anthropic or other third-party
  services themselves; please report those to the provider.
- Volumetric denial of service, social engineering, and physical attacks.
- Findings that need a compromised device or a stolen master key, unless
  Witness makes the impact worse than it needs to be.

## Design notes for researchers

Evidence is encrypted at rest with per-user keys derived from a server-held
master key. This is not end-to-end encryption; the operator's code can decrypt.
See [Privacy](docs/PRIVACY.md) and [Architecture](docs/ARCHITECTURE.md) for
the trust boundaries.
