/**
 * Read-only WP-CLI over SSH — the orchestration between stored access, the
 * command catalog, host pinning and the transport.
 *
 * Nothing the browser sends reaches this except a catalog id and, at most, a
 * bounded parameter. The host, port, username, key and WordPress path are all
 * resolved server-side from the authorized project.
 */

import { buildWpCliCommand, type WpCliCommand } from "./wpCliCatalog.ts";
import {
  clampTimeout,
  decideHostPin,
  sanitizeOutput,
  validateSshDestination,
  validateSshUsername,
  validatePrivateKey,
} from "./sshSafety.ts";
import { resolveRawSecret, type SecretStoreDeps } from "./secretStore.ts";
import type { SshTransport } from "./sshTransport.ts";

export type SshAccess = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  wpRoot: string | null;
  wpBinary: string | null;
  pinnedFingerprint: string | null;
};

export type SshAccessResult = { ok: true; access: SshAccess } | { ok: false; code: string; summary: string };

/** The shape sealed into the secret column. Only ever secret material. */
type SshSecretPayload = { privateKey?: unknown; passphrase?: unknown };

export const resolveSshAccess = async (
  deps: SecretStoreDeps,
  projectId: string,
): Promise<SshAccessResult> => {
  const resolved = await resolveRawSecret(deps, projectId, "ssh");
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      summary:
        resolved.code === "secret_store_unavailable"
          ? "The secure credential store isn't available, so I won't attempt a server inspection."
          : "I don't have usable SSH access stored for this project yet.",
    };
  }

  let payload: SshSecretPayload;
  try {
    payload = JSON.parse(resolved.plaintext) as SshSecretPayload;
  } catch {
    return { ok: false, code: "secret_store_unavailable", summary: "The stored SSH access could not be read." };
  }

  const key = validatePrivateKey(String(payload.privateKey ?? ""));
  if (!key.ok) return { ok: false, code: "capability_unavailable", summary: key.reason };

  const config = (resolved.row.config ?? {}) as Record<string, unknown>;
  const destination = validateSshDestination(String(config.host ?? ""), config.port);
  if (!destination.ok) return { ok: false, code: "unsafe_destination", summary: destination.reason };

  const username = validateSshUsername(resolved.row.username);
  if (!username.ok) return { ok: false, code: "capability_unavailable", summary: username.reason };

  return {
    ok: true,
    access: {
      host: destination.host,
      port: destination.port,
      username: username.username,
      privateKey: key.key,
      passphrase: typeof payload.passphrase === "string" && payload.passphrase ? payload.passphrase : undefined,
      wpRoot: typeof config.wpRoot === "string" && config.wpRoot ? config.wpRoot : null,
      wpBinary: typeof config.wpBinary === "string" && config.wpBinary ? config.wpBinary : null,
      pinnedFingerprint: resolved.row.host_fingerprint ?? null,
    },
  };
};

export type WpCliRunResult =
  | {
      ok: true;
      summary: string;
      entry: WpCliCommand;
      data: Record<string, unknown>;
    }
  | { ok: false; code: string; summary: string; retryable: boolean };

const FAILURE_SUMMARY: Record<string, string> = {
  auth_failed: "The server did not accept the stored SSH key. Please replace the SSH access.",
  unreachable: "I could not reach that server over SSH, so nothing ran.",
  timeout: "The server did not answer the inspection in time, so I stopped it.",
  host_key_rejected: "I stopped because the server's identity key did not match the one I recorded.",
  protocol_error: "The server connected but refused to run the inspection.",
};

/**
 * Runs one catalog command. `allowFirstUse` is only ever true for an explicit,
 * human-initiated verification — a normal agent run must connect to a server
 * whose identity is already pinned.
 */
export const runReadOnlyWpCli = async (
  deps: SecretStoreDeps,
  transport: SshTransport,
  input: {
    projectId: string;
    commandId: string;
    params?: Record<string, string | undefined>;
    timeoutMs?: unknown;
    allowFirstUse?: boolean;
  },
): Promise<WpCliRunResult> => {
  const access = await resolveSshAccess(deps, input.projectId);
  if (!access.ok) return { ok: false, code: access.code, summary: access.summary, retryable: false };

  const built = buildWpCliCommand({
    commandId: input.commandId,
    params: input.params,
    wpRoot: access.access.wpRoot,
    wpBinary: access.access.wpBinary,
  });
  if (!built.ok) return { ok: false, code: built.code, summary: built.reason, retryable: false };

  // Decided before the socket opens, so an unpinned host is refused without
  // ever reaching the auth stage.
  let pinRejection: string | null = null;
  let observedFingerprint: string | null = null;

  const outcome = await transport.exec(
    {
      host: access.access.host,
      port: access.access.port,
      username: access.access.username,
      privateKey: access.access.privateKey,
      passphrase: access.access.passphrase,
    },
    built.command,
    clampTimeout(input.timeoutMs),
    (fingerprint) => {
      observedFingerprint = fingerprint;
      const decision = decideHostPin(fingerprint, access.access.pinnedFingerprint, input.allowFirstUse === true);
      if (decision.action === "reject") {
        pinRejection = decision.reason;
        return false;
      }
      return true;
    },
  );

  if (pinRejection) {
    return { ok: false, code: "host_key_rejected", summary: pinRejection, retryable: false };
  }

  if (!outcome.ok) {
    if (outcome.kind === "auth_failed") {
      await deps.markVerification?.(input.projectId, "ssh", "rejected", null);
    }
    return {
      ok: false,
      code: outcome.kind,
      summary: FAILURE_SUMMARY[outcome.kind] ?? "The server inspection did not complete.",
      retryable: outcome.kind === "unreachable" || outcome.kind === "timeout",
    };
  }

  // The connection succeeded, so the identity observed is now the pinned one.
  if (!access.access.pinnedFingerprint && observedFingerprint) {
    await deps.pinHostFingerprint?.(input.projectId, "ssh", observedFingerprint);
  }

  const stdout = sanitizeOutput(outcome.stdout);
  const stderr = sanitizeOutput(outcome.stderr);

  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      code: "command_failed",
      summary: stderr.text
        ? `WP-CLI could not complete that inspection: ${stderr.text.split("\n")[0].slice(0, 200)}`
        : "WP-CLI could not complete that inspection on the server.",
      retryable: false,
    };
  }

  // A real authenticated command finished, which is the only honest basis for
  // calling this access verified.
  await deps.markVerification?.(input.projectId, "ssh", "verified", new Date().toISOString());

  let parsed: unknown = null;
  if (built.entry.json && stdout.text) {
    try {
      parsed = JSON.parse(stdout.text);
    } catch {
      parsed = null;
    }
  }

  return {
    ok: true,
    summary: `${built.entry.purpose} The server answered without anything being changed.`,
    entry: built.entry,
    data: {
      commandId: built.entry.id,
      purpose: built.entry.purpose,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated || outcome.outputTruncated,
      parsed,
      readOnly: true,
    },
  };
};