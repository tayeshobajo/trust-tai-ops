/**
 * Server-only secret store.
 *
 * The browser can submit a credential once. It can never read one back: there
 * is no select path from the client, and this module is only reachable from
 * inside an edge function with the service role.
 */

import { openSecret, parseEncryptionKey, sealSecret, type SealedSecret } from "./crypto.ts";

export type SecretFailure = "secret_store_unavailable" | "capability_unavailable";

export type StoredSecretRow = {
  id: string;
  project_id: string;
  access_type: string;
  provider: string;
  username: string;
  ciphertext: string;
  iv: string;
  algorithm: string;
  key_version: string;
  verification_state: string | null;
};

export type SecretStoreDeps = {
  /** Raw value of the server-only encryption key secret, if configured. */
  encryptionKey: string | undefined | null;
  /** Service-role upsert. Only ever receives ciphertext. */
  saveRow: (row: Omit<StoredSecretRow, "id"> & { id?: string }) => Promise<void>;
  /** Service-role read by project + access type. */
  loadRow: (projectId: string, accessType: string) => Promise<StoredSecretRow | null>;
  /** Records the outcome of a real authenticated call. Never stores secrets. */
  markVerification?: (projectId: string, accessType: string, state: "verified" | "rejected") => Promise<void>;
};

export type WordPressCredential = { username: string; applicationPassword: string };

export type StoreResult = { ok: true; reference: string } | { ok: false; code: SecretFailure };

/** Reference exposed to metadata. It identifies a row, never a value. */
export const secretReferenceFor = (projectId: string, accessType: string): string =>
  `secret:${accessType}:${projectId}`;

export const storeCredential = async (
  deps: SecretStoreDeps,
  input: { projectId: string; accessType: string; provider: string; username: string; secret: string },
): Promise<StoreResult> => {
  const key = parseEncryptionKey(deps.encryptionKey);
  if (!key.ok) return { ok: false, code: "secret_store_unavailable" };

  const sealed = await sealSecret(input.secret, key.key);
  await deps.saveRow({
    project_id: input.projectId,
    access_type: input.accessType,
    provider: input.provider,
    username: input.username,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    algorithm: sealed.algorithm,
    key_version: sealed.keyVersion,
    verification_state: "unverified",
  });

  return { ok: true, reference: secretReferenceFor(input.projectId, input.accessType) };
};

export type ResolveResult =
  | { ok: true; credential: WordPressCredential; provider: string }
  | { ok: false; code: SecretFailure };

/** Resolves a usable credential, or fails closed. Never returns partials. */
export const resolveCredential = async (
  deps: SecretStoreDeps,
  projectId: string,
  accessType: string,
): Promise<ResolveResult> => {
  const key = parseEncryptionKey(deps.encryptionKey);
  if (!key.ok) return { ok: false, code: "secret_store_unavailable" };

  let row: StoredSecretRow | null = null;
  try {
    row = await deps.loadRow(projectId, accessType);
  } catch {
    return { ok: false, code: "secret_store_unavailable" };
  }
  if (!row) return { ok: false, code: "capability_unavailable" };
  // A row belonging to another project can never satisfy this resolution.
  if (row.project_id !== projectId) return { ok: false, code: "capability_unavailable" };

  const sealed: SealedSecret = {
    ciphertext: row.ciphertext,
    iv: row.iv,
    algorithm: row.algorithm,
    keyVersion: row.key_version,
  };
  const opened = await openSecret(sealed, key.key);
  if (!opened.ok) return { ok: false, code: "secret_store_unavailable" };

  return {
    ok: true,
    provider: row.provider,
    credential: { username: row.username, applicationPassword: opened.plaintext },
  };
};

/** Server truth about what private capabilities this project can actually use. */
export const resolvableCapabilities = async (
  deps: SecretStoreDeps,
  projectId: string,
  candidates: string[],
): Promise<string[]> => {
  const usable: string[] = [];
  for (const accessType of candidates) {
    const resolved = await resolveCredential(deps, projectId, accessType);
    if (resolved.ok) usable.push(accessType);
  }
  return usable;
};