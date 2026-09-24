import { createContext, useContext } from 'react';
import type { Me } from '../api/types';

export interface Session {
  me: Me;
  refresh: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

/** The signed-in person, or null outside the signed-in part of the app. */
export function useOptionalSession(): Session | null {
  return useContext(SessionContext);
}
