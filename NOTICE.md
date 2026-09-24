# Notices

Muse Nexus Witness is released under the [MIT License](LICENSE).
Built by Muse Nexus (Mark Matthews) and contributors.

## Fonts

The web app and Witness's own pages use two typefaces, loaded from Google Fonts
at runtime. They are not bundled in this repository. Emails do not load them:
they fall back to Georgia and system fonts, so opening an email tells no one
else anything.

- **Fraunces**, by Undercase Type (Phaedra Charles and Flavia Zimbardi),
  licensed under the [SIL Open Font License 1.1](https://openfontlicense.org).
- **Inter**, by Rasmus Andersson, licensed under the
  [SIL Open Font License 1.1](https://openfontlicense.org).

Delivery emails fall back to Georgia and system fonts where web fonts are not
available.

## Third-party code

This repository does not vendor third-party source code. Runtime and
development dependencies are installed from npm and pinned in `bun.lock`. Each
keeps its own license, found in its package. Built bundles include code from,
among others:

- Web app: React and React DOM (MIT).
- Worker: Hono (MIT), postal-mime (MIT-0), Zod (MIT), the Model Context
  Protocol TypeScript SDK (MIT), and the Anthropic TypeScript SDK (MIT).

## Code of conduct

The [Code of Conduct](CODE_OF_CONDUCT.md) adopts the Contributor Covenant 2.1
by reference. The Contributor Covenant is available under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Legacy

Proof Gallery v0, the project Witness grew out of, is no longer in this tree.
Its source and its own notices (including its decorative images) are in the
repository history; see [legacy/README.md](legacy/README.md).
