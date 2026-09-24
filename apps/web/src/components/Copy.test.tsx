import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyBlock, CopyField } from './Copy';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
  window.getSelection()?.removeAllRanges();
});

describe('Copy', () => {
  it('says Copied when the clipboard takes it', async () => {
    const writeText = vi.fn(async () => undefined);
    clipboard(writeText);
    render(<CopyField label="Your Witness email address" value="witness+abc@in.example.com" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Your Witness email address' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('witness+abc@in.example.com');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failure where it can be seen, and selects the text to copy by hand', async () => {
    clipboard(async () => {
      throw new Error('not allowed');
    });
    render(<CopyBlock label="Gmail filter" value={'("thank you" OR proud) -from:me'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Gmail filter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy did not work. The text is selected, so you can copy it yourself.');
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.toString()).toBe('("thank you" OR proud) -from:me');
    // The button never claims it worked.
    expect(screen.getByRole('button', { name: 'Copy Gmail filter' })).toHaveTextContent('Copy');
  });
});
