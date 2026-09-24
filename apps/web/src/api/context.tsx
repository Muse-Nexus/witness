import { createContext, useContext, type ReactNode } from 'react';
import { createClient, type ApiClient } from './client';

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

let fallback: ApiClient | null = null;

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client) return client;
  fallback ??= createClient();
  return fallback;
}
