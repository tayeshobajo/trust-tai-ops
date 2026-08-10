/**
 * SSH destination, identity and output safety.
 *
 * Pure TypeScript, like `net.ts`, so the security checks run the real code.
 * Nothing here opens a socket; it decides what is allowed to be opened, and
 * what is allowed to come back out.
 */

import { isBlockedIp, redact } from "./net.ts";

export const SSH_DEFAULT_PORT = 22;
export const SSH_CONNECT_TIMEOUT_MS = 15_000;
export const WP_CLI_DEFAULT_TIMEOUT_MS = 20_000;
export const WP_CLI_MAX_TIMEOUT_MS = 45_000;
export const WP_CLI_MAX_OUTPUT_BYTES = 64_000;

/**
 * Ciphers and MACs proven to work under Deno's `node:crypto`. AES-GCM is
 * excluded deliberately: the runtime cannot drive it through `ssh2`, and a
 * silent fallback to something weaker is never acceptable, so the list is
 * pinned rather than negotiated freely.
 */
export const SSH_ALGORITHMS = {
  cipher: ["aes256-ctr", "aes192-ctr", "aes128-ctr"],
  hmac: ["hmac-sha2-256", "hmac-sha2-512"],
  serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"],
} as const;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

export type HostCheck = { ok: true; host: string; port: number } | { ok: false; reason: string };

/**
 * The same SSRF rules the HTTP path uses, applied to a raw TCP destination.
 * A private, link-local or metadata address is refused outright.
 */
export const validateSshDestination = (rawHost: string, rawPort: unknown): HostCheck => {
  const host = String(rawHost ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) {
    return { ok: false, reason: "That server address doesn't look complete." };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, reason: "That server address contains characters I won't connect to." };
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "That address points inside a private network, so I won't connect to it." };
  }
  if (isBlockedIp(host)) {
    return { ok: false, reason: "That address points inside a private network, so I won't connect to it." };
  }

  const port = rawPort === undefined || rawPort === null || rawPort === "" ? SSH_DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "That SSH port number isn't valid." };
  }

  return { ok: true, host, port };
};

export const validateSshUsername = (raw: string): { ok: true; username: string } | { ok: false; reason: string } => {
  const username = String(raw ?? "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(username)) {
    return { ok: false, reason: "That SSH username doesn't look valid." };
  }
  return { ok: true, username };
};

const KEY_HEADERS = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN DSA PRIVATE KEY-----",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
];

export const validatePrivateKey = (raw: string): { ok: true; key: string } | { ok: false; reason: string } => {
  const key = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (key.length < 100 || key.length > 32_000) {
    return { ok: false, reason: "That private key doesn't look complete." };
  }
  if (!KEY_HEADERS.some((header) => key.startsWith(header))) {
    return { ok: false, reason: "That doesn't look like an SSH private key. Please paste the whole key file." };
  }
  if (!/-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) {
    return { ok: false, reason: "That private key is missing its closing line." };
  }
  return { ok: true, key: `${key}\n` };
};

// ---------------------------------------------------------------------------
// Host identity.
// ---------------------------------------------------------------------------

/** Canonical form: `SHA256:` plus unpadded base64, exactly as OpenSSH prints. */
export const normalizeFingerprint = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const value = trimmed.replace(/^SHA256:/i, "").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]{43}$/.test(value)) return null;
  return `SHA256:${value}`;
};

/** Constant-time-ish comparison on already-normalized, equal-length strings. */
export const fingerprintsMatch = (a: string | null, b: string | null): boolean => {
  const left = normalizeFingerprint(a);
  const right = normalizeFingerprint(b);
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
};

export type PinDecision =
  | { action: "trust_on_first_use"; fingerprint: string }
  | { action: "match"; fingerprint: string }
  | { action: "reject"; reason: string };

/**
 * Host identity policy.
 *
 * The first successful connection records the server's key fingerprint. Every
 * later connection must present exactly that key. A changed key is treated as
 * a hard failure, never as something to re-learn automatically, because that
 * is precisely what a machine-in-the-middle looks like.
 *
 * `allowFirstUse` is only true during an explicit, human-initiated verify.
 */
export const decideHostPin = (
  presented: string | null,
  pinned: string | null,
  allowFirstUse: boolean,
): PinDecision => {
  const now = normalizeFingerprint(presented);
  if (!now) return { action: "reject", reason: "I couldn't read the server's identity key, so I stopped." };

  const known = normalizeFingerprint(pinned);
  if (!known) {
    if (!allowFirstUse) {
      return {
        action: "reject",
        reason: "I haven't confirmed this server's identity yet. Please check the SSH access once, and I'll remember it.",
      };
    }
    return { action: "trust_on_first_use", fingerprint: now };
  }

  if (!fingerprintsMatch(now, known)) {
    return {
      action: "reject",
      reason:
        "This server presented a different identity key than the one I recorded. I stopped rather than connect. If the server was rebuilt or moved, remove and re-add the SSH access.",
    };
  }

  return { action: "match", fingerprint: now };
};

// ---------------------------------------------------------------------------
// Output safety.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type SanitizedOutput = { text: string; truncated: boolean; bytes: number };

/**
 * Server output is untrusted text. It is stripped of terminal control codes,
 * run through the shared redactor, and hard-bounded before it can be stored,
 * shown, or fed back into reasoning.
 */
export const sanitizeOutput = (raw: string, maxBytes = WP_CLI_MAX_OUTPUT_BYTES): SanitizedOutput => {
  const cleaned = String(raw ?? "")
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .replace(CONTROL, "");
  const bytes = cleaned.length;
  const truncated = bytes > maxBytes;
  return { text: redact(truncated ? cleaned.slice(0, maxBytes) : cleaned).trim(), truncated, bytes };
};

export const clampTimeout = (raw: unknown): number => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return WP_CLI_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(value), 1_000), WP_CLI_MAX_TIMEOUT_MS);
};