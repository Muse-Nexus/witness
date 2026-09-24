import { act, render } from '@testing-library/react';
import { createClient } from '../api/client';
import { createMockApi, type MockApi, type MockOptions } from '../api/mock';
import { App } from '../app/App';

export interface Rendered {
  mock: MockApi;
}

/** Render the whole app at `path`, backed by the synthetic mock API. */
export function renderApp(path: string, options: MockOptions = {}): Rendered {
  const mock = createMockApi({ confirmationAfterPolls: null, ...options });
  window.history.replaceState(null, '', path);
  render(<App client={createClient(mock.fetch)} />);
  return { mock };
}

export function callsTo(mock: MockApi, method: string, path: string) {
  return mock.calls.filter((c) => c.method === method && c.path.split('?')[0] === path);
}

export async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
