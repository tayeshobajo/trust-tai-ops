/**
 * The verified Trust Tai OS access token, held for the active browser session
 * only. Memory is the storage: nothing is written to `localStorage`, and the
 * token is dropped on sign-out or on tab close.
 */

type SuiteSession = {
  osAccessToken: string;
  osUserId: string;
  osEmail: string;
  canonicalProjectId: string | null;
  expiresAt: number;
};

let session: SuiteSession | null = null;

export function setSuiteSession(next: SuiteSession): void {
  session = next;
}

export function getSuiteSession(): SuiteSession | null {
  if (session && session.expiresAt > 0 && session.expiresAt * 1000 < Date.now()) {
    session = null;
  }
  return session;
}

export function suiteSyncAvailable(): boolean {
  return getSuiteSession() !== null;
}

export function clearSuiteSession(): void {
  session = null;
}

export type { SuiteSession };