import { useId, useState, type FormEvent } from 'react';
import { useApi } from '../api/context';
import type { CreatedToken, McpConfigs } from '../api/types';
import { CONFIG_TABS, configsFor } from '../lib/agentConfigs';
import { CopyBlock, CopyField } from './Copy';
import { Tabs } from './Tabs';

function appOrigin(): string {
  return window.location.origin;
}

/** The configs returned with a new assistant key, one tab per assistant. */
export function TokenConfigs({ created }: { created: CreatedToken }) {
  const [tab, setTab] = useState<keyof McpConfigs>('claudeCode');
  const configs = configsFor(created, appOrigin());
  const current = CONFIG_TABS.find((t) => t.id === tab) ?? CONFIG_TABS[0]!;
  return (
    <div className="token-configs">
      <p className="token-configs__once">
        Copy this key now. Witness shows it only once. You can disconnect it any time in Settings.
      </p>
      <CopyField label={`${created.label} key`} value={created.token} />
      <Tabs label="Assistant" tabs={CONFIG_TABS.map(({ id, label }) => ({ id, label }))} selected={tab} onSelect={setTab}>
        <p className="token-configs__hint">{current.hint}</p>
        <CopyBlock label={`${current.label} setup`} value={configs[tab]} />
      </Tabs>
    </div>
  );
}

/** What a new assistant key may do by default (core's DEFAULT_AGENT_SCOPES). */
export const ASSISTANT_SCOPES = ['status', 'offer', 'reveal', 'add', 'pause'] as const;

/** Create an assistant (MCP) key and show how to connect it. */
export function AssistantKey({ onCreated }: { onCreated?: (token: CreatedToken) => void }) {
  const api = useApi();
  const id = useId();
  const [label, setLabel] = useState('My assistant');
  const [search, setSearch] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Without search, core's default: offer, reveal after a yes, add, pause and status.
      const token = await api.createToken({
        label: label.trim() || 'My assistant',
        kind: 'agent',
        ...(search ? { scopes: [...ASSISTANT_SCOPES, 'search'] } : {}),
      });
      setCreated(token);
      onCreated?.(token);
    } catch {
      setError('The key was not created. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  if (created) return <TokenConfigs created={created} />;

  return (
    <form className="inline-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-label`}>Name this assistant</label>
        <input id={`${id}-label`} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
      </div>
      <label className="consent">
        <input type="checkbox" checked={search} onChange={(e) => setSearch(e.target.checked)} />
        <span>
          Also let it search what you kept, when you ask it to. It sees what it finds without asking first. Leave this
          off unless you want that.
        </span>
      </label>
      <button type="submit" className="btn btn--primary" disabled={busy}>
        Create an assistant key
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
