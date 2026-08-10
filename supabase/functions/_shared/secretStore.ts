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
  /**
   * Non-secret connection details (host, port, WordPress path). Never holds a
   * credential: anything secret goes through `ciphertext`.
   */
  config?: Record<string, unknown> | null;
  /** Pinned SSH host identity, recorded on first successful verify. */
  host_fingerprint?: string | null;
};

export type SecretStoreDeps = {
  /** Raw value of the server-only encryption key secret, if configured. */
  encryptionKey: string | undefined | null;
  /** Service-role upsert. Only ever receives ciphertext. */
  saveRow: (row: Omit<StoredSecretRow, "id"> & { id?: string }) => Promise<void>;
  /** Service-role read by project + access type. */
  loadRow: (projectId: string, accessType: string) => Promise<StoredSecretRow | null>;
  /**
   * Records the outcome of a real authenticated call. Never stores secrets.
   * `verifiedAt` is null for a rejection: a rejected credential must not keep
   * or gain a verification timestamp.
   */
  markVerification?: (
    projectId: string,
    accessType: string,
    state: "verified" | "rejected",
    verifiedAt: string | null,
  ) => Promise<void>;
  /**
   * Records the server identity observed on a first successful connection.
   * Separate from `saveRow` so a pin can never be set by a submission.
   */
  pinHostFingerprint?: (projectId: string, accessType: string, fingerprint: string) => Promise<void>;
};

export type WordPressCredential = { username: string; applicationPassword: string };

export type StoreResult = { ok: true; reference: string } | { ok: false; code: SecretFailure };

/** Reference exposed to metadata. It identifies a row, never a value. */
export const secretReferenceFor = (projectId: string, accessType: string): string =>
  `secret:${accessType}:${projectId}`;

export const storeCredential = async (
  deps: SecretStoreDeps,
  input: {
    projectId: string;
    accessType: string;
    provider: string;
    username: string;
    secret: string;
    config?: Record<string, unknown> | null;
  },
): Promise<StoreResult> => {
  const key = await parseEncryptionKey(deps.encryptionKey);
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
    config: input.config ?? null,
    // A new credential always invalidates the previous host pin: it may be a
    // different server entirely.
    host_fingerprint: null,
  });

  return { ok: true, reference: secretReferenceFor(input.projectId, input.accessType) };
};

export type RawSecretResult =
  | { ok: true; plaintext: string; row: StoredSecretRow }
  | { ok: false; code: SecretFailure };

/**
 * Opens a stored secret of any shape, together with its non-secret row. Used
 * by access types whose credential is not a username plus password.
 */
export const resolveRawSecret = async (
  deps: SecretStoreDeps,
  projectId: string,
  accessType: string,
): Promise<RawSecretResult> => {
  const key = await parseEncryptionKey(deps.encryptionKey);
  if (!key.ok) return { ok: false, code: "secret_store_unavailable" };

  let row: StoredSecretRow | null = null;
  try {
    row = await deps.loadRow(projectId, accessType);
  } catch {
    return { ok: false, code: "secret_store_unavailable" };
  }
  if (!row) return { ok: false, code: "capability_unavailable" };
  if (row.project_id !== projectId) return { ok: false, code: "capability_unavailable" };

  const opened = await openSecret(
    { ciphertext: row.ciphertext, iv: row.iv, algorithm: row.algorithm, keyVersion: row.key_version },
    key.key,
  );
  if (!opened.ok) return { ok: false, code: "secret_store_unavailable" };

  return { ok: true, plaintext: opened.plaintext, row };
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
  const key = await parseEncryptionKey(deps.encryptionKey);
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

/**
 * Server truth, in two distinct grades:
 *
 *   stored   — a credential exists for this project and decrypts cleanly.
 *   verified — the provider has actually accepted that credential at least once.
 *
 * A stored credential is enough to *attempt* a read-only private call. It is
 * never enough to tell a person their access is verified.
 */
export type CapabilityTruth = { stored: string[]; verified: string[] };

export const capabilityTruth = async (
  deps: SecretStoreDeps,
  projectId: string,
  candidates: string[],
): Promise<CapabilityTruth> => {
  const stored: string[] = [];
  const verified: string[] = [];
  for (const accessType of candidates) {
    const resolved = await resolveCredential(deps, projectId, accessType);
    if (!resolved.ok) continue;
    stored.push(accessType);
    let row: StoredSecretRow | null = null;
    try {
      row = await deps.loadRow(projectId, accessType);
    } catch {
      row = null;
    }
    if (row?.verification_state === "verified") verified.push(accessType);
  }
  return { stored, verified };
};

/** Credentials this project holds. Decryptable, not proven acceptable. */
export const storedCapabilities = async (
  deps: SecretStoreDeps,
  projectId: string,
  candidates: string[],
): Promise<string[]> => (await capabilityTruth(deps, projectId, candidates)).stored;