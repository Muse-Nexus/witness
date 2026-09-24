import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createClient, type Fetcher } from '../api/client';
import { ApiProvider } from '../api/context';
import type { CreatedToken, McpConfigs } from '../api/types';
import { configsFor } from '../lib/agentConfigs';
import { AssistantKey } from './AssistantKey';

const configs: McpConfigs = {
  claudeCode: 'claude mcp add --transport http witness https://w.example.com/mcp --header "Authorization: Bearer wit_agent_SYNTHETIC"',
  codex: '[mcp_servers.witness]\nurl = "https://w.example.com/mcp"',
  json: '{"mcpServers":{"witness":{"type":"http"}}}',
  curl: 'curl -s https://w.example.com/api/v1/status',
};

// Exactly what core answers to POST /api/v1/tokens (SPEC §10.1): the summary, the token once, and configs.
const created: CreatedToken = {
  id: 'tok_1',
  kind: 'agent',
  label: 'Claude at home',
  scopes: ['status', 'offer', 'reveal', 'search', 'add', 'pause'],
  createdAt: Date.UTC(2026, 8, 24),
  lastUsedAt: null,
  revokedAt: null,
  token: 'wit_agent_SYNTHETIC',
  configs: { ...configs, mcpUrl: 'https://w.example.com/mcp', captureUrl: 'https://w.example.com/api/v1/capture' },
};

function renderKey(response: CreatedToken) {
  const fetcher = vi.fn<Fetcher>(async () => new Response(JSON.stringify(response), { status: 201 }));
  render(
    <ApiProvider client={createClient(fetcher)}>
      <AssistantKey />
    </ApiProvider>,
  );
  return fetcher;
}

describe('AssistantKey', () => {
  it('creates an agent key and shows the configs from the API response', async () => {
    const fetcher = renderKey(created);
    fireEvent.change(screen.getByLabelText('Name this assistant'), { target: { value: 'Claude at home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create an assistant key' }));

    expect(await screen.findByText('wit_agent_SYNTHETIC')).toBeInTheDocument();
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({ label: 'Claude at home', kind: 'agent' });
    expect(screen.getByText(/This key is shown once/)).toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(configs.claudeCode)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(screen.getByText(/\[mcp_servers\.witness\]/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.getByText(configs.json)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'curl' }));
    expect(screen.getByText(configs.curl)).toBeInTheDocument();
  });

  it('leaves search off unless the person turns it on', async () => {
    const fetcher = renderKey(created);
    fireEvent.click(screen.getByLabelText(/Also let it search what you kept/));
    fireEvent.click(screen.getByRole('button', { name: 'Create an assistant key' }));
    await screen.findByText('wit_agent_SYNTHETIC');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({
      label: 'My assistant',
      kind: 'agent',
      scopes: ['status', 'offer', 'reveal', 'add', 'pause', 'search'],
    });
  });

  it('builds the configs itself when the response has none', async () => {
    const { configs: _omit, ...withoutConfigs } = created;
    renderKey(withoutConfigs);
    fireEvent.click(screen.getByRole('button', { name: 'Create an assistant key' }));
    expect(
      await screen.findByText(
        `claude mcp add --transport http witness ${window.location.origin}/mcp --header "Authorization: Bearer wit_agent_SYNTHETIC"`,
      ),
    ).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    renderKey(created);
    fireEvent.click(screen.getByRole('button', { name: 'Create an assistant key' }));
    const first = await screen.findByRole('tab', { name: 'Claude Code' });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveFocus();
  });
});

describe('configsFor', () => {
  it('fills in whatever core did not send', () => {
    const partial: CreatedToken = { ...created, configs: { captureUrl: 'https://w.example.com/api/v1/capture' } };
    const filled = configsFor(partial, 'https://w.example.com');
    expect(filled.claudeCode).toBe('claude mcp add --transport http witness https://w.example.com/mcp --header "Authorization: Bearer wit_agent_SYNTHETIC"');
    expect(filled.curl).toContain('/api/v1/status');
    expect(configsFor(created, 'https://other.example.com')).toEqual(configs);
  });
});

describe('HEIC photos added by hand', () => {
  it('are kept exactly as they are, even where the browser could redraw them', async () => {
    const { readImage } = await import('./AddSomething');
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0]);
    const original = btoa(String.fromCharCode(...bytes));
    const file = new File([bytes], 'photo.heic', { type: 'image/heic' });
    expect(await readImage(file)).toEqual({ base64: original, mediaType: 'image/heic' });

    // A browser that can decode HEIC (Safari) must not re-encode it: evidence is the
    // original image, so no canvas, no JPEG, no lost detail or metadata.
    const g = globalThis as unknown as { createImageBitmap?: unknown };
    const saved = g.createImageBitmap;
    let decoded = 0;
    g.createImageBitmap = async () => {
      decoded += 1;
      return { width: 2, height: 2 };
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as unknown as typeof getContext;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }));
    };
    try {
      expect(await readImage(file)).toEqual({ base64: original, mediaType: 'image/heic' });
      // An untyped .heic file (some browsers) is kept as it is too.
      expect(await readImage(new File([bytes], 'IMG_0001.HEIC', { type: '' }))).toEqual({ base64: original, mediaType: 'image/heic' });
      expect(decoded).toBe(0);
    } finally {
      g.createImageBitmap = saved;
      HTMLCanvasElement.prototype.getContext = getContext;
      HTMLCanvasElement.prototype.toBlob = toBlob;
    }
  });
});
