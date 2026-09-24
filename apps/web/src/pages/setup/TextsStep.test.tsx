import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render';

// Which Witness the ready-made shortcuts were built for (lib/shortcuts.json); each test says.
const built = vi.hoisted(() => ({
  appUrl: 'https://witness.example.com',
  shortcuts: [
    { id: 'text', name: 'Send to Witness', href: '/shortcuts/send-to-witness.shortcut' },
    { id: 'image', name: 'Send image to Witness', href: '/shortcuts/send-image-to-witness.shortcut' },
  ],
}));
vi.mock('../../lib/shortcuts.json', () => ({ default: built }));

describe('Setup: texts and photos', () => {
  it('offers each shortcut in one tap on the Witness they were made for, under the phone key', async () => {
    built.appUrl = window.location.origin;
    renderApp('/app/setup?step=texts');
    const create = await screen.findByRole('button', { name: 'Create a phone key' });

    const adds = screen.getAllByRole('link', { name: 'Add to iPhone' });
    expect(adds.map((a) => a.getAttribute('href'))).toEqual(['/shortcuts/send-to-witness.shortcut', '/shortcuts/send-image-to-witness.shortcut']);
    expect(adds[0]).toHaveAccessibleDescription('Send to Witness');
    expect(adds[1]).toHaveAccessibleDescription('Send image to Witness');
    expect(adds[0]).toHaveAttribute('download', 'Send to Witness.shortcut');
    expect(adds[0]).toHaveClass('btn--primary');
    // The key comes first: each shortcut asks for it when it is added.
    expect(create.compareDocumentPosition(adds[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Tap Add Shortcut, then paste your key when it asks.')).toBeInTheDocument();

    // Building it by hand is still there, folded away.
    const manual = screen.getByText('Build it yourself').closest('details')!;
    expect(manual).not.toHaveAttribute('open');
    expect(within(manual).getByText(/Add a header named Authorization/)).toBeInTheDocument();
    expect(screen.getByText('Send texts from one person on their own').closest('details')).not.toHaveAttribute('open');

    fireEvent.click(create);
    expect(await screen.findByText(/^wit_dev_/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('!');
  });

  it('never offers shortcuts that send to another Witness', async () => {
    built.appUrl = 'https://witness.example.com';
    renderApp('/app/setup?step=texts');
    await screen.findByRole('button', { name: 'Create a phone key' });
    expect(screen.queryByRole('link', { name: 'Add to iPhone' })).toBeNull();
    expect(screen.getByText(/The ready-made shortcuts send to witness\.example\.com, not to this Witness\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'make ready-made ones for this Witness' })).toHaveAttribute(
      'href',
      'https://github.com/Muse-Nexus/witness/blob/main/docs/guides/iphone.md',
    );
    expect(screen.getByText('Build it yourself')).toBeInTheDocument();
  });
});
