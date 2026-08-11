/**
 * WordPress error-log safety.
 *
 * Pure TypeScript, like `sshSafety.ts` and `wpCliCatalog.ts`, so the security
 * checks exercise exactly the code that runs in production.
 *
 * Three rules hold here:
 *
 *   1. The browser never supplies a path. Candidates are derived server-side
 *      from the authorized project's stored WordPress root, from a closed list.
 *   2. Every candidate must normalize to a real path *inside* that root.
 *      Traversal, control characters and anything outside the root are refused.
 *   3. Nothing leaves this file un-sanitized. Log text is untrusted, may hold
 *      credentials, and is redacted line by line before it is persisted.
 */

// The closed candidate set, relative to the resolved WordPress root. Nothing
// host-wide (/var/log, webserver logs, home directories) is in scope.
export const ERROR_LOG_CANDIDATES: readonly string[] = [
  "wp-content/debug.log",
  "error_log",
  "wp-admin/error_log",
  "wp-content/error_log",
];

export const LOG_MAX_BYTES_PER_FILE = 64 * 1024;
export const LOG_MAX_TOTAL_BYTES = 128 * 1024;
export const LOG_MAX_LINES = 300;
export const LOG_MAX_ENTRIES = 40;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Canonical absolute path: no `.`/`..` segments, no doubled or trailing slash. */
const canonicalize = (raw: string): string | null => {
  if (!raw.startsWith("/")) return null;
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join("/")}`;
};

/**
 * Resolves one candidate against the WordPress root and proves it stays inside
 * it. This is the only way a path is ever produced for a read.
 */
export const resolveLogPath = (wpRoot: string | null | undefined, candidate: string): PathCheck => {
  const root = String(wpRoot ?? "").trim();
  if (!root) {
    return { ok: false, reason: "No WordPress folder is recorded for this server, so I have nowhere safe to look." };
  }
  if (!root.startsWith("/") || CONTROL.test(root) || root.includes("..")) {
    return { ok: false, reason: "The recorded WordPress folder path isn't a safe absolute path." };
  }
  const relative = String(candidate ?? "");
  if (!relative || relative.startsWith("/") || CONTROL.test(relative) || relative.includes("..")) {
    return { ok: false, reason: "That log location isn't one I'm allowed to read." };
  }
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(relative)) {
    return { ok: false, reason: "That log location isn't one I'm allowed to read." };
  }

  const canonicalRoot = canonicalize(root);
  const resolved = canonicalize(`${root}/${relative}`);
  if (!canonicalRoot || !resolved) {
    return { ok: false, reason: "That log location isn't one I'm allowed to read." };
  }
  if (canonicalRoot === "/" || !resolved.startsWith(`${canonicalRoot}/`)) {
    return { ok: false, reason: "That log location is outside the WordPress folder, so I won't read it." };
  }
  return { ok: true, path: resolved };
};

/** The closed set of absolute paths this tool may open for a given project. */
export const eligibleLogPaths = (
  wpRoot: string | null | undefined,
  extra: readonly string[] = [],
): Array<{ label: string; path: string }> => {
  const out: Array<{ label: string; path: string }> = [];
  const seen = new Set<string>();
  for (const candidate of [...ERROR_LOG_CANDIDATES, ...extra]) {
    const check = resolveLogPath(wpRoot, candidate);
    if (!check.ok || seen.has(check.path)) continue;
    seen.add(check.path);
    // The label is project-relative on purpose: an absolute server path is not
    // evidence a person needs, and it is not worth persisting.
    out.push({ label: candidate, path: check.path });
  }
  return out;
};

/**
 * A path discovered from WordPress's own `WP_DEBUG_LOG` setting. It is only
 * accepted when it lands inside the resolved root, and it is turned back into
 * a project-relative candidate so the same rules apply to it.
 */
export const relativeCandidateFrom = (wpRoot: string | null | undefined, absoluteOrRelative: string): string | null => {
  const raw = String(absoluteOrRelative ?? "").trim();
  if (!raw || raw === "1" || raw === "0" || raw === "true" || raw === "false") return null;
  if (CONTROL.test(raw) || raw.includes("..")) return null;
  const root = canonicalize(String(wpRoot ?? "").trim() || "/nope");
  if (!root) return null;
  if (!raw.startsWith("/")) return /^[A-Za-z0-9._/-]{1,255}$/.test(raw) ? raw : null;
  const resolved = canonicalize(raw);
  if (!resolved || !resolved.startsWith(`${root}/`)) return null;
  return resolved.slice(root.length + 1);
};

// ---------------------------------------------------------------------------
// Redaction.
// ---------------------------------------------------------------------------

/**
 * Secret-shaped material in PHP/WordPress logs. Deliberately narrow: stack
 * frames, plugin and theme paths, function names, timestamps, line numbers and
 * HTTP status codes are diagnostic evidence and must survive intact.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted key]"],
  [/(authorization|proxy-authorization)\s*[:=]\s*\S+/gi, "$1: [redacted]"],
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\n]+/gi, "$1: [redacted]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|application[_-]?password|app[_-]?password|db[_-]?password|session[_-]?id|nonce)\b(\s*(?:=>|[:=])\s*)(["']?)[^\s"',;)]+\3/gi,
    "$1$2[redacted]",
  ],
  [
    /([?&](?:key|token|secret|password|pass|api_key|apikey|access_token|auth|signature|sig)=)[^&\s"']+/gi,
    "$1[redacted]",
  ],
  [/\bDB_PASSWORD['"\s,]+['"][^'"]*['"]/gi, "DB_PASSWORD '[redacted]'"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted email]"],
];

export const sanitizeLogText = (raw: string): string => {
  let text = String(raw ?? "").replace(ANSI, "").replace(/\r\n/g, "\n").replace(CONTROL_G, "");
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  return text;
};

// ---------------------------------------------------------------------------
// Structure.
// ---------------------------------------------------------------------------

export type LogEntry = {
  timestamp: string | null;
  severity: string;
  message: string;
};

const SEVERITIES: Array<[RegExp, string]> = [
  [/PHP Fatal error/i, "fatal"],
  [/PHP Parse error/i, "fatal"],
  [/PHP Warning/i, "warning"],
  [/PHP Deprecated/i, "deprecated"],
  [/PHP Notice/i, "notice"],
  [/WordPress database error/i, "database"],
];

const severityOf = (line: string): string => {
  for (const [pattern, name] of SEVERITIES) if (pattern.test(line)) return name;
  return "other";
};

/** Keeps only the last `LOG_MAX_LINES` lines, newest last. */
export const tailLines = (text: string, maxLines = LOG_MAX_LINES): string[] => {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return lines.slice(Math.max(0, lines.length - maxLines));
};

export const parseLogEntries = (lines: readonly string[]): LogEntry[] => {
  const entries: LogEntry[] = [];
  for (const line of lines) {
    const stamp = line.match(/^\[([^\]]{4,40})\]\s*/);
    // A continuation frame ("#3 /path(12): fn()") belongs to the entry above it.
    if (!stamp && entries.length > 0 && /^#\d+\s/.test(line)) continue;
    const body = stamp ? line.slice(stamp[0].length) : line;
    entries.push({
      timestamp: stamp ? stamp[1] : null,
      severity: severityOf(body),
      message: body.slice(0, 500),
    });
  }
  return entries.slice(Math.max(0, entries.length - LOG_MAX_ENTRIES));
};

export const countBySeverity = (entries: readonly LogEntry[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.severity] = (counts[entry.severity] ?? 0) + 1;
  return counts;
};

export type ComponentMention = { kind: "plugin" | "theme" | "core"; name: string; mentions: number };

/** WordPress components named by the sanitized lines. Deterministic, no guessing. */
export const componentsMentioned = (lines: readonly string[]): ComponentMention[] => {
  const tally = new Map<string, ComponentMention>();
  const add = (kind: ComponentMention["kind"], name: string) => {
    const key = `${kind}:${name}`;
    const existing = tally.get(key);
    if (existing) existing.mentions += 1;
    else tally.set(key, { kind, name, mentions: 1 });
  };
  for (const line of lines) {
    for (const match of line.matchAll(/wp-content\/plugins\/([A-Za-z0-9._-]{1,64})/g)) add("plugin", match[1]);
    for (const match of line.matchAll(/wp-content\/themes\/([A-Za-z0-9._-]{1,64})/g)) add("theme", match[1]);
    if (/wp-includes\/|wp-admin\/|wp-settings\.php|wp-load\.php/.test(line)) add("core", "wordpress-core");
  }
  return [...tally.values()].sort((a, b) => b.mentions - a.mentions).slice(0, 8);
};
