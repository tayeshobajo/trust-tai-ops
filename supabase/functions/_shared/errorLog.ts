/**
 * Read-only WordPress error-log reading over the existing SSH trust boundary.
 *
 * The browser sends no path, no host and no credential — only the identity of a
 * project it has already been authorized for. Everything else is resolved here:
 * the stored SSH access, the pinned host identity, the WordPress root, and the
 * closed candidate list of logs that may be opened.
 *
 * Nothing here can write, list a directory, or open a path the candidate rules
 * did not produce.
 */

import { clampTimeout, decideHostPin } from "./sshSafety.ts";
import { resolveSshAccess } from "./wpCli.ts";
import type { SecretStoreDeps } from "./secretStore.ts";
import type { SftpTransport } from "./sshTransport.ts";
import {
  componentsMentioned,
  countBySeverity,
  eligibleLogPaths,
  relativeCandidateFrom,
  LOG_MAX_BYTES_PER_FILE,
  LOG_MAX_LINES,
  LOG_MAX_TOTAL_BYTES,
  parseLogEntries,
  sanitizeLogText,
  tailLines,
} from "./errorLogSafety.ts";

export type ErrorLogResult =
  | { ok: true; summary: string; data: Record<string, unknown> }
  | { ok: false; code: string; summary: string; retryable: boolean };

const FAILURE_SUMMARY: Record<string, string> = {
  auth_failed: "The server did not accept the stored SSH key, so I could not read the error log. Please replace the SSH access.",
  unreachable: "I could not reach that server over SSH, so I read nothing.",
  bad_credential: "I could not read the stored SSH key, so I read nothing.",
  timeout: "The server did not answer in time, so I stopped reading.",
  host_key_rejected: "I stopped because the server's identity key did not match the one I recorded.",
  protocol_error: "The server connected but refused the read.",
  sftp_unavailable: "This server does not allow file reads over SSH, so the error log stays out of reach.",
};

export const readWordPressErrorLog = async (
  deps: SecretStoreDeps,
  transport: SftpTransport,
  input: {
    projectId: string;
    timeoutMs?: unknown;
    /**
     * Raw value of WordPress's own `WP_DEBUG_LOG` setting, if it was read. It
     * is treated as untrusted: it only becomes a candidate when it resolves
     * inside the project's WordPress root.
     */
    debugLogHint?: string | null;
  },
): Promise<ErrorLogResult> => {
  const access = await resolveSshAccess(deps, input.projectId);
  if (!access.ok) return { ok: false, code: access.code, summary: access.summary, retryable: false };

  const hinted = input.debugLogHint ? relativeCandidateFrom(access.access.wpRoot, input.debugLogHint) : null;
  const candidates = eligibleLogPaths(access.access.wpRoot, hinted ? [hinted] : []);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "capability_unavailable",
      summary:
        "I don't have the WordPress folder recorded for this server, so there is no path I can safely read a log from.",
      retryable: false,
    };
  }

  let pinRejection: string | null = null;
  const outcome = await transport.readTails(
    {
      host: access.access.host,
      port: access.access.port,
      username: access.access.username,
      privateKey: access.access.privateKey,
      password: access.access.password,
      passphrase: access.access.passphrase,
    },
    {
      paths: candidates.map((candidate) => candidate.path),
      maxBytesPerFile: LOG_MAX_BYTES_PER_FILE,
      maxTotalBytes: LOG_MAX_TOTAL_BYTES,
    },
    clampTimeout(input.timeoutMs),
    (fingerprint) => {
      // A log read is never an explicit verification, so a server whose
      // identity has not been pinned yet is always refused.
      const decision = decideHostPin(fingerprint, access.access.pinnedFingerprint, false);
      if (decision.action === "reject") {
        pinRejection = decision.reason;
        return false;
      }
      return true;
    },
  );

  if (pinRejection) return { ok: false, code: "host_key_rejected", summary: pinRejection, retryable: false };

  if (!outcome.ok) {
    if (outcome.kind === "auth_failed") {
      await deps.markVerification?.(input.projectId, "ssh", "rejected", null);
    }
    return {
      ok: false,
      code: outcome.kind,
      // Never the provider's own words: only what this system decided.
      summary: FAILURE_SUMMARY[outcome.kind] ?? "The error-log read did not complete.",
      retryable: outcome.kind === "unreachable" || outcome.kind === "timeout",
    };
  }

  // A real authenticated read finished, which is the same honest basis WP-CLI
  // uses for calling this access verified.
  await deps.markVerification?.(input.projectId, "ssh", "verified", new Date().toISOString());

  const labelFor = (path: string) => candidates.find((candidate) => candidate.path === path)?.label ?? "log";

  const selectedSources: string[] = [];
  const notRegular: string[] = [];
  let bytesRead = 0;
  let truncated = false;
  let combined: string[] = [];

  for (const file of outcome.files) {
    if (file.status === "not_regular") {
      notRegular.push(labelFor(file.path));
      continue;
    }
    if (file.status !== "read" || file.bytesRead === 0) continue;
    bytesRead += file.bytesRead;
    truncated = truncated || file.truncated;
    selectedSources.push(labelFor(file.path));
    // Sanitized before anything is counted, parsed, stored or shown.
    combined = combined.concat(tailLines(sanitizeLogText(file.text)));
  }

  const lines = combined.slice(Math.max(0, combined.length - LOG_MAX_LINES));
  const entries = parseLogEntries(lines);
  const counts = countBySeverity(entries);
  const components = componentsMentioned(lines);
  const filesFound = selectedSources.length;

  const summary = filesFound === 0
    ? "I checked the WordPress-scoped error logs I can safely read, but none are present."
    : components.length > 0 && (counts.fatal ?? 0) > 0
    ? `I found recent PHP errors in WordPress's error log. The newest entries repeatedly mention ${components[0].name}, so I'm using that as evidence for the next investigation step.`
    : `I read the last ${entries.length} entries from the WordPress error log without changing anything.`;

  return {
    ok: true,
    summary,
    data: {
      filesChecked: candidates.length,
      filesFound,
      selectedSources,
      nonRegularSkipped: notRegular,
      linesRead: lines.length,
      bytesRead,
      truncated,
      recentEntries: entries,
      countsBySeverity: counts,
      likelyWordPressComponents: components,
      readOnly: true,
    },
  };
};
