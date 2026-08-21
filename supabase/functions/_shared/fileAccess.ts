/**
 * One file layer over every server access a project might hold.
 *
 * The agent asks for a *site-relative* path — "wp-content/plugins" — and never
 * an absolute one. This module resolves the project's stored access, picks a
 * transport (SFTP over SSH when available, otherwise FTP/FTPS), joins the path
 * onto the recorded site root, and refuses anything that tries to climb out of
 * it. Callers upstream cannot name a host, a credential, or a path outside the
 * project's own web root.
 *
 * Reads are bounded and redacted. Writes and renames are change-class and are
 * gated by the approval rules in the execution function, not here.
 */

import { resolveRawSecret, type SecretStoreDeps } from "./secretStore.ts";
import { clampTimeout, decideHostPin, validatePrivateKey, validateSshDestination, validateSshUsername } from "./sshSafety.ts";
import { sanitizeLogText } from "./errorLogSafety.ts";
import { denoFtpTransport, type FtpTarget, type FtpTransport } from "./ftpTransport.ts";
import { denoSftpFileOps, denoSftpTransport, type SftpFileOps, type SftpTransport, type SshTarget } from "./sshTransport.ts";

export type FileToolResult =
  | { ok: true; summary: string; data: Record<string, unknown> }
  | { ok: false; code: string; summary: string; retryable: boolean };

export const FILE_MAX_READ_BYTES = 256 * 1024;
export const FILE_MAX_ENTRIES = 250;
export const FILE_MAX_WRITE_BYTES = 512 * 1024;

/** Access types that can carry file operations, in order of preference. */
const FILE_ACCESS_TYPES = ["ssh", "sftp", "ftp"] as const;

type SshFileAccess = {
  transport: "sftp";
  target: SshTarget;
  root: string;
  pinnedFingerprint: string | null;
  accessType: string;
};

type FtpFileAccess = {
  transport: "ftp";
  target: FtpTarget;
  root: string;
  accessType: string;
};

export type ResolvedFileAccess = SshFileAccess | FtpFileAccess;

export type FileAccessResolution =
  | { ok: true; access: ResolvedFileAccess }
  | { ok: false; code: string; summary: string };

// --- path confinement -------------------------------------------------------

const NORMALIZE = (value: string): string => value.replace(/\\/g, "/").replace(/\/+/g, "/");

/** Site-relative path, cleaned. Returns null when it escapes the root. */
export const safeRelativePath = (raw: unknown): string | null => {
  const value = NORMALIZE(String(raw ?? "").trim());
  if (value.includes("\x00")) return null;
  const parts = value.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return null;
  if (parts.some((part) => part.length > 255)) return null;
  const joined = parts.join("/");
  if (joined.length > 1024) return null;
  return joined;
};

/** Joins a validated relative path onto the recorded root. */
export const absolutePathFor = (root: string, relative: string): string => {
  const base = NORMALIZE(root || "").replace(/\/$/, "");
  if (!base) return relative ? `./${relative}` : ".";
  return relative ? `${base}/${relative}` : base;
};

// --- access resolution ------------------------------------------------------

type SshSecretPayload = { privateKey?: string; password?: string; passphrase?: string };

export const resolveFileAccess = async (
  deps: SecretStoreDeps,
  projectId: string,
): Promise<FileAccessResolution> => {
  let storeUnavailable = false;

  for (const accessType of FILE_ACCESS_TYPES) {
    const resolved = await resolveRawSecret(deps, projectId, accessType);
    if (!resolved.ok) {
      if (resolved.code === "secret_store_unavailable") storeUnavailable = true;
      continue;
    }

    const config = (resolved.row.config ?? {}) as Record<string, unknown>;
    const root =
      typeof config.wpRoot === "string" && config.wpRoot
        ? config.wpRoot
        : typeof config.root === "string" && config.root
          ? config.root
          : "";

    let payload: SshSecretPayload;
    try {
      payload = JSON.parse(resolved.plaintext) as SshSecretPayload;
    } catch {
      continue;
    }

    if (accessType === "ftp") {
      const destination = validateSshDestination(String(config.host ?? ""), config.port);
      if (!destination.ok) continue;
      const password = typeof payload.password === "string" ? payload.password : "";
      if (!password || !resolved.row.username) continue;
      return {
        ok: true,
        access: {
          transport: "ftp",
          accessType,
          root,
          target: {
            host: destination.host,
            port: destination.port,
            username: resolved.row.username,
            password,
            mode: config.security === "plain" ? "plain" : "auto",
          },
        },
      };
    }

    const destination = validateSshDestination(String(config.host ?? ""), config.port);
    if (!destination.ok) continue;
    const username = validateSshUsername(resolved.row.username);
    if (!username.ok) continue;

    let privateKey: string | undefined;
    if (payload.privateKey) {
      const key = validatePrivateKey(payload.privateKey);
      if (!key.ok) continue;
      privateKey = key.key;
    } else if (!payload.password) {
      continue;
    }

    return {
      ok: true,
      access: {
        transport: "sftp",
        accessType,
        root,
        pinnedFingerprint: resolved.row.host_fingerprint ?? null,
        target: {
          host: destination.host,
          port: destination.port,
          username: username.username,
          privateKey,
          password: payload.password || undefined,
          passphrase: payload.passphrase || undefined,
        },
      },
    };
  }

  if (storeUnavailable) {
    return {
      ok: false,
      code: "secret_store_unavailable",
      summary: "The secure credential store isn't available, so I won't attempt to reach the server.",
    };
  }
  return {
    ok: false,
    code: "capability_unavailable",
    summary:
      "I don't have file access to that server yet. FTP, FTPS, SFTP or SSH all work — send the host, username and password and I'll take it from there.",
  };
};

// --- shared plumbing --------------------------------------------------------

export type FileTransports = { sftp: SftpFileOps; ftp: FtpTransport; sftpWrite: SftpTransport };

export const defaultFileTransports = (): FileTransports => ({
  sftp: denoSftpFileOps(),
  ftp: denoFtpTransport(),
  sftpWrite: denoSftpTransport(),
});

const FAILURE_SUMMARY: Record<string, string> = {
  auth_failed: "The server did not accept the stored sign-in, so I could not open the files.",
  unreachable: "I could not reach that server, so I read nothing.",
  timeout: "The server did not answer in time, so I stopped.",
  host_key_rejected: "I stopped because the server's identity key did not match the one I recorded.",
  protocol_error: "The server answered, but it refused the file operation.",
  sftp_unavailable: "That server does not allow file access over SSH.",
  bad_credential: "I could not read the stored server key, so nothing ran.",
  tls_failed: "The secure FTPS channel could not be established with that server.",
  not_found: "That path is not there on the server.",
  write_failed: "The server refused the change.",
};

const failed = (kind: string, detail?: string): FileToolResult => ({
  ok: false,
  code: kind,
  summary: detail || FAILURE_SUMMARY[kind] || "The file operation did not complete.",
  retryable: kind === "timeout" || kind === "unreachable",
});

/** Host pinning for the SSH path; FTP has no comparable server identity. */
const pinAcceptor = (access: SshFileAccess, onObserved: (fingerprint: string) => void) => (fingerprint: string) => {
  onObserved(fingerprint);
  return decideHostPin(fingerprint, access.pinnedFingerprint, true).action !== "reject";
};

const recordPin = async (
  deps: SecretStoreDeps,
  projectId: string,
  access: SshFileAccess,
  fingerprint: string | null,
) => {
  if (!fingerprint || access.pinnedFingerprint) return;
  try {
    await deps.pinHostFingerprint?.(projectId, access.accessType, fingerprint);
  } catch {
    // The pin is a hardening record, never the reason an operation fails.
  }
};

const securityNote = (access: ResolvedFileAccess, security?: string): string =>
  access.transport === "sftp"
    ? "over SFTP"
    : security === "ftps"
      ? "over FTPS"
      : "over plain FTP — this host would not present a certificate this runtime can validate, so the connection was not encrypted";

// --- operations -------------------------------------------------------------

export const listDirectory = async (
  deps: SecretStoreDeps,
  transports: FileTransports,
  input: { projectId: string; path: unknown; timeoutMs?: unknown },
): Promise<FileToolResult> => {
  const relative = safeRelativePath(input.path ?? "");
  if (relative === null) return failed("invalid_input", "That folder path isn't one I can open.");

  const resolution = await resolveFileAccess(deps, input.projectId);
  if (!resolution.ok) return { ok: false, code: resolution.code, summary: resolution.summary, retryable: false };
  const access = resolution.access;
  const target = absolutePathFor(access.root, relative);
  const timeoutMs = clampTimeout(input.timeoutMs);

  if (access.transport === "ftp") {
    const outcome = await transports.ftp.list(access.target, target, FILE_MAX_ENTRIES, timeoutMs);
    if (!outcome.ok) return failed(outcome.kind, outcome.detail);
    return {
      ok: true,
      summary: `Listed ${relative || "the site root"} — ${outcome.entries.length} item(s), ${securityNote(access, outcome.security)}.`,
      data: {
        path: relative,
        transport: "ftp",
        security: outcome.security,
        truncated: outcome.truncated,
        entries: outcome.entries,
      },
    };
  }

  let observed: string | null = null;
  const outcome = await transports.sftp.list(
    access.target,
    target,
    FILE_MAX_ENTRIES,
    timeoutMs,
    pinAcceptor(access, (value) => {
      observed = value;
    }),
  );
  await recordPin(deps, input.projectId, access, observed);
  if (!outcome.ok) return failed(outcome.kind, outcome.detail);
  return {
    ok: true,
    summary: `Listed ${relative || "the site root"} — ${outcome.entries.length} item(s), over SFTP.`,
    data: { path: relative, transport: "sftp", truncated: outcome.truncated, entries: outcome.entries },
  };
};

export const readFileSlice = async (
  deps: SecretStoreDeps,
  transports: FileTransports,
  input: { projectId: string; path: unknown; maxBytes?: unknown; from?: unknown; timeoutMs?: unknown },
): Promise<FileToolResult> => {
  const relative = safeRelativePath(input.path);
  if (!relative) return failed("invalid_input", "That file path isn't one I can open.");

  const requested = Number(input.maxBytes);
  const maxBytes = Number.isFinite(requested) && requested > 0 ? Math.min(requested, FILE_MAX_READ_BYTES) : FILE_MAX_READ_BYTES;
  const from = input.from === "start" ? "start" : "tail";

  const resolution = await resolveFileAccess(deps, input.projectId);
  if (!resolution.ok) return { ok: false, code: resolution.code, summary: resolution.summary, retryable: false };
  const access = resolution.access;
  const target = absolutePathFor(access.root, relative);
  const timeoutMs = clampTimeout(input.timeoutMs);

  const present = (payload: {
    size: number | null;
    bytesRead: number;
    truncated: boolean;
    text: string;
    modifiedAt: string | null;
    security?: string;
  }): FileToolResult => ({
    ok: true,
    summary: `Read ${payload.bytesRead} byte(s) of ${relative}${payload.truncated ? " (partial)" : ""}, ${securityNote(access, payload.security)}.`,
    data: {
      path: relative,
      transport: access.transport,
      security: payload.security ?? "ssh",
      size: payload.size,
      bytesRead: payload.bytesRead,
      truncated: payload.truncated,
      modifiedAt: payload.modifiedAt,
      // Anything credential-shaped inside the file is scrubbed before it can
      // reach a transcript or an evidence record.
      content: sanitizeLogText(payload.text),
    },
  });

  if (access.transport === "ftp") {
    const outcome = await transports.ftp.read(access.target, target, { maxBytes, from }, timeoutMs);
    if (!outcome.ok) return failed(outcome.kind, outcome.detail);
    return present(outcome);
  }

  let observed: string | null = null;
  const outcome = await transports.sftp.read(
    access.target,
    target,
    { maxBytes, from },
    timeoutMs,
    pinAcceptor(access, (value) => {
      observed = value;
    }),
  );
  await recordPin(deps, input.projectId, access, observed);
  if (!outcome.ok) return failed(outcome.kind, outcome.detail);
  return present(outcome);
};

export const renamePath = async (
  deps: SecretStoreDeps,
  transports: FileTransports,
  input: { projectId: string; from: unknown; to: unknown; timeoutMs?: unknown },
): Promise<FileToolResult> => {
  const source = safeRelativePath(input.from);
  const destination = safeRelativePath(input.to);
  if (!source || !destination) return failed("invalid_input", "Those paths aren't ones I can rename between.");
  if (source === destination) return failed("invalid_input", "The old and new paths are the same.");

  const resolution = await resolveFileAccess(deps, input.projectId);
  if (!resolution.ok) return { ok: false, code: resolution.code, summary: resolution.summary, retryable: false };
  const access = resolution.access;
  const timeoutMs = clampTimeout(input.timeoutMs);
  const fromAbs = absolutePathFor(access.root, source);
  const toAbs = absolutePathFor(access.root, destination);

  if (access.transport === "ftp") {
    const outcome = await transports.ftp.rename(access.target, fromAbs, toAbs, timeoutMs);
    if (!outcome.ok) return failed(outcome.kind, outcome.detail);
    return {
      ok: true,
      summary: `Renamed ${source} to ${destination}, ${securityNote(access, outcome.security)}.`,
      data: { from: source, to: destination, transport: "ftp", security: outcome.security, reversible: true },
    };
  }

  let observed: string | null = null;
  const outcome = await transports.sftp.rename(
    access.target,
    fromAbs,
    toAbs,
    timeoutMs,
    pinAcceptor(access, (value) => {
      observed = value;
    }),
  );
  await recordPin(deps, input.projectId, access, observed);
  if (!outcome.ok) return failed(outcome.kind, outcome.detail);
  return {
    ok: true,
    summary: `Renamed ${source} to ${destination}, over SFTP.`,
    data: { from: source, to: destination, transport: "sftp", reversible: true },
  };
};

export const writeFileContent = async (
  deps: SecretStoreDeps,
  transports: FileTransports,
  input: { projectId: string; path: unknown; content: unknown; backupFirst?: unknown; timeoutMs?: unknown },
): Promise<FileToolResult> => {
  const relative = safeRelativePath(input.path);
  if (!relative) return failed("invalid_input", "That file path isn't one I can write to.");
  const content = typeof input.content === "string" ? input.content : "";
  if (new TextEncoder().encode(content).byteLength > FILE_MAX_WRITE_BYTES) {
    return failed("invalid_input", "That file is larger than the 512 KB write limit.");
  }

  const resolution = await resolveFileAccess(deps, input.projectId);
  if (!resolution.ok) return { ok: false, code: resolution.code, summary: resolution.summary, retryable: false };
  const access = resolution.access;
  const timeoutMs = clampTimeout(input.timeoutMs);
  const target = absolutePathFor(access.root, relative);
  const backupFirst = input.backupFirst !== false;

  if (access.transport === "ftp") {
    const outcome = await transports.ftp.write(
      access.target,
      target,
      content,
      { backupFirst, maxBackupBytes: FILE_MAX_WRITE_BYTES },
      timeoutMs,
    );
    if (!outcome.ok) return failed(outcome.kind, outcome.detail);
    return {
      ok: true,
      summary: `Wrote ${outcome.bytesWritten} byte(s) to ${relative}, ${securityNote(access, outcome.security)}.`,
      data: {
        path: relative,
        transport: "ftp",
        security: outcome.security,
        bytesWritten: outcome.bytesWritten,
        priorContentCaptured: typeof outcome.backupContent === "string",
        priorContent: outcome.backupContent ? sanitizeLogText(outcome.backupContent) : null,
      },
    };
  }

  let observed: string | null = null;
  const outcome = await transports.sftpWrite.writeFile(
    access.target,
    { path: target, content, backupFirst },
    timeoutMs,
    pinAcceptor(access, (value) => {
      observed = value;
    }),
  );
  await recordPin(deps, input.projectId, access, observed);
  if (!outcome.ok) return failed(outcome.kind, outcome.detail);
  return {
    ok: true,
    summary: `Wrote ${outcome.bytesWritten} byte(s) to ${relative}, over SFTP.`,
    data: {
      path: relative,
      transport: "sftp",
      bytesWritten: outcome.bytesWritten,
      priorContentCaptured: typeof outcome.backupContent === "string",
      priorContent: outcome.backupContent ? sanitizeLogText(outcome.backupContent) : null,
    },
  };
};
