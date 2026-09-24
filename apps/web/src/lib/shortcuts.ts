import built from './shortcuts.json';

/** A signed shortcut file in public/shortcuts, written by scripts/shortcuts/build.mjs. */
export interface ReadyShortcut {
  id: string;
  name: string;
  href: string;
}

/** The Witness the ready-made shortcuts send to, e.g. "witness.musenexus.studio". */
export function readyShortcutsHost(): string {
  return new URL(built.appUrl).host;
}

/**
 * The ready-made shortcuts send to the one Witness they were built for. They are offered
 * only there: anywhere else, what someone shares would go to a Witness that is not theirs.
 */
export function readyShortcutsFor(origin: string): ReadyShortcut[] | null {
  return new URL(built.appUrl).origin === origin ? built.shortcuts : null;
}
