export type ThemeOverride = 'light' | 'dark';

/**
 * Dark is the default and light follows prefers-color-scheme (see tokens.css).
 * `?theme=light|dark` pins one for the visit, which is how screenshots are taken.
 */
export function applyThemeOverride(search: string, root: HTMLElement = document.documentElement): ThemeOverride | null {
  const value = new URLSearchParams(search).get('theme');
  if (value !== 'light' && value !== 'dark') return null;
  root.dataset.theme = value;
  return value;
}
