/**
 * Read-before-write.
 *
 * The agent may not change a thing it has not first read in this run. Every
 * read records what it saw and a hash of that state; a write is only allowed
 * against a target whose current hash still matches what was read. If someone
 * else moved the file between the read and the write, the write fails instead
 * of overwriting work nobody looked at.
 *
 * This exists before any write tool does, on purpose. The boundary should be
 * older than the first thing that tests it.
 */

import type { AgentAction, AgentActionArguments, AgentEvidence, ToolId } from "./types";

/** What a write is about to touch, and the state it believes that target is in. */
export type WritePrecondition = {
  /** Normalized identity of the thing being changed, e.g. `file:/wp-config.php`. */
  target: string;
  /** Hash of the target's contents as observed by the read this write depends on. */
  expectedHash: string;
  /** Evidence id of the read. The audit trail can point at it later. */
  readEvidenceId: string;
};

export type PreconditionCheck =
  | { ok: true; precondition: WritePrecondition }
  | { ok: false; reason: string };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * The target a write acts on, derived only from its own arguments. Returns
 * null for read-only tools, which have nothing to guard.
 */
export const writeTargetFor = (toolId: ToolId, args: AgentActionArguments): string | null => {
  switch (toolId) {
    case "filesystem.write": {
      const path = text(args.path);
      return path ? `file:${path}` : null;
    }
    case "filesystem.rename": {
      const from = text(args.from);
      return from ? `file:${from}` : null;
    }
    case "database.execute": {
      const table = text(args.table);
      return table ? `table:${table.toLowerCase()}` : null;
    }
    case "wordpress.execute_wp_cli": {
      // A WP-CLI mutation always names the object it acts on: a plugin, a
      // theme, an option. That object is the target, not the command string.
      const plugin = text(args.plugin);
      if (plugin) return `plugin:${plugin.toLowerCase()}`;
      const theme = text(args.theme);
      if (theme) return `theme:${theme.toLowerCase()}`;
      const option = text(args.option);
      if (option) return `option:${option.toLowerCase()}`;
      return null;
    }
    default:
      return null;
  }
};

/**
 * The targets a piece of read evidence actually observed, with the hash of
 * what was seen. A read that reports no hash proves nothing and is ignored.
 */
export const observedTargets = (item: AgentEvidence): Array<{ target: string; hash: string }> => {
  const data = item.data ?? {};
  const found: Array<{ target: string; hash: string }> = [];

  const path = text(data.path);
  const contentHash = text(data.contentHash);
  if (path && contentHash) found.push({ target: `file:${path}`, hash: contentHash });

  const table = text(data.table);
  if (table && contentHash) found.push({ target: `table:${table.toLowerCase()}`, hash: contentHash });

  // A directory listing observes each file it named: name, size and modified
  // time are the state a rename would be racing against.
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const base = path ? `${path}/` : "";
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = text(row.name);
    if (!name) continue;
    const size = typeof row.size === "number" ? String(row.size) : "unknown";
    const modified = text(row.modifiedAt) ?? "unknown";
    found.push({ target: `file:${base}${name}`, hash: `${size}/${modified}` });
  }

  // A plugin listing observes every plugin it returned. Version plus active
  // state is the state a change would be racing against.
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];
  for (const entry of plugins) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const slug = text(row.slug) ?? text(row.name);
    if (!slug) continue;
    const version = text(row.version) ?? "unknown";
    const status = text(row.status) ?? (row.active === true ? "active" : "inactive");
    found.push({ target: `plugin:${slug.toLowerCase()}`, hash: `${version}/${status}` });
  }

  return found;
};

/** Every target read so far in this run, latest read winning. */
export const readLedger = (evidence: AgentEvidence[]): Map<string, { hash: string; evidenceId: string }> => {
  const ledger = new Map<string, { hash: string; evidenceId: string }>();
  for (const item of evidence) {
    for (const observation of observedTargets(item)) {
      ledger.set(observation.target, { hash: observation.hash, evidenceId: item.id });
    }
  }
  return ledger;
};

const describeTarget = (target: string): string => {
  const [kind, ...rest] = target.split(":");
  const name = rest.join(":");
  if (kind === "file") return `the file at ${name}`;
  if (kind === "table") return `the ${name} table`;
  if (kind === "plugin") return `the ${name} plugin`;
  if (kind === "theme") return `the ${name} theme`;
  if (kind === "option") return `the ${name} setting`;
  return name;
};

/**
 * The gate itself. A mutating action must name a target, and that target must
 * have been read during this investigation.
 */
export const checkReadBeforeWrite = (
  action: AgentAction,
  evidence: AgentEvidence[],
): PreconditionCheck => {
  const target = writeTargetFor(action.toolId, action.args);
  if (!target) {
    return {
      ok: false,
      reason: "I can't tell exactly what this change would touch, so I won't run it.",
    };
  }

  const read = readLedger(evidence).get(target);
  if (!read) {
    return {
      ok: false,
      reason: `I haven't read ${describeTarget(target)} yet. I check the current state before changing anything.`,
    };
  }

  return {
    ok: true,
    precondition: { target, expectedHash: read.hash, readEvidenceId: read.evidenceId },
  };
};

/**
 * Called at execution time. The hash observed a moment ago must still match
 * the hash the plan was built on, or the world moved underneath us.
 */
export const preconditionStillHolds = (
  precondition: WritePrecondition,
  currentHash: string | null,
): { ok: true } | { ok: false; reason: string } => {
  if (!currentHash) {
    return {
      ok: false,
      reason: `I couldn't re-confirm the current state of ${describeTarget(precondition.target)} right before the change, so I stopped.`,
    };
  }
  if (currentHash !== precondition.expectedHash) {
    return {
      ok: false,
      reason: `${describeTarget(precondition.target)} changed since I read it. I've stopped rather than overwrite something I haven't seen.`,
    };
  }
  return { ok: true };
};