import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from './test/render';

// Product voice (SPEC §4): calm and plain. No exclamation marks, no cheerleading, and the
// crisis line on every screen. This renders each page with synthetic data and reads it.
const PAGES = ['/', '/signin', '/privacy', '/safety', '/app', '/app/maybe', '/app/setup', '/app/setup?step=texts', '/app/setup?step=rhythm', '/app/setup?step=assistant', '/app/settings', '/nowhere'];
const CHEERLEADING = [/you've got this/i, /you got this/i, /amazing/i, /awesome/i, /stay positive/i, /cheer up/i, /you should feel/i];

describe('voice', () => {
  it.each(PAGES)('%s is calm and keeps the crisis line', async (path) => {
    renderApp(path);
    await screen.findByRole('contentinfo');
    await screen.findByRole('heading', { level: 1 });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('!');
    // Paste-ready blocks (the Gmail search built from lexicon.json, assistant configs) are strings for
    // other apps, not words Witness says to the person: the Gmail filter searches for "you're amazing".
    const copy = document.body.cloneNode(true) as HTMLElement;
    for (const block of copy.querySelectorAll('pre')) block.remove();
    const words = copy.textContent ?? '';
    for (const pattern of CHEERLEADING) expect(words).not.toMatch(pattern);
    expect(screen.getByRole('contentinfo')).toHaveTextContent("If you're in crisis, call or text 988 (US)");
  });
});
