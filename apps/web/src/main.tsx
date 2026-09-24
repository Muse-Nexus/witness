import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, type ApiClient } from './api/client';
import { App } from './app/App';
import { applyThemeOverride } from './lib/theme';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';

async function clientForEnvironment(): Promise<ApiClient> {
  // The mock lives in its own chunk and is dropped from production builds.
  if (import.meta.env.VITE_MOCK_API === '1') {
    const { createMockApi } = await import('./api/mock');
    return createClient(createMockApi({ latencyMs: 60 }).fetch);
  }
  return createClient();
}

async function start() {
  applyThemeOverride(window.location.search);
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root');
  const client = await clientForEnvironment();
  createRoot(root).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
}

void start();
