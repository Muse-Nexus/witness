import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test/render';

describe('Landing', () => {
  it('carries the Muse Nexus brand and the tagline', () => {
    renderApp('/');
    const home = screen.getAllByRole('link', { name: 'Muse Nexus Witness, home' });
    expect(home.length).toBeGreaterThan(0);
    expect(home[0]).toHaveTextContent('Muse Nexus');
    expect(home[0]).toHaveTextContent('Witness.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A witness to your life.');
    expect(
      screen.getByText(
        'Witness quietly keeps the real things people say and do for you, and brings one back on the days you choose.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the three beats and a clearly labelled example', () => {
    renderApp('/');
    for (const beat of ['It keeps the real things.', 'It comes to you.', "It's yours."]) {
      expect(screen.getByRole('heading', { name: beat })).toBeInTheDocument();
    }
    const example = screen.getByRole('article', { name: /example/i });
    expect(example).toHaveTextContent('Example');
  });

  it('keeps the crisis line and the honest note in view', () => {
    renderApp('/');
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent(
      "Made by Muse Nexus in Hawaiʻi · Open source (MIT) · If you're in crisis, call or text 988 (US) · findahelpline.com",
    );
    expect(screen.getByRole('heading', { name: 'Not therapy. Not crisis care.' })).toBeInTheDocument();
    const helplines = screen.getAllByRole('link', { name: 'findahelpline.com' });
    expect(helplines[0]).toHaveAttribute('href', 'https://findahelpline.com');
  });

  it('links to the source, safety, privacy and self-hosting docs', () => {
    renderApp('/');
    expect(screen.getAllByRole('link', { name: /GitHub/ })[0]).toHaveAttribute(
      'href',
      'https://github.com/Muse-Nexus/proof-gallery',
    );
    expect(screen.getAllByRole('link', { name: /Self-host/ })[0]).toHaveAttribute(
      'href',
      expect.stringContaining('docs/SELF_HOSTING.md'),
    );
    expect(screen.getAllByRole('link', { name: /^Start/ })[0]).toHaveAttribute('href', '/signin');
  });
});
