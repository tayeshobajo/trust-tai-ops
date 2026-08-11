/**
 * Meeting analysis contract.
 *
 * The model proposes; it never acts. Everything it returns is validated here
 * against the project's real world before it is stored: known enums only,
 * known access types only, provenance that actually exists in the transcript,
 * and no invented host, path, command or project.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

export const TASK_TYPES = [
  "malware",
  "performance",
  "broken_site",
  "plugin_theme_conflict",
  "hardening",
  "qa_only",
] as const;

export const RISK_LEVELS = ["safe", "cautious", "high_risk"] as const;

export const MEMORY_TYPES = ["stack_note", "incident_note", "risk_note", "qa_rule", "procedure"] as const;

export const MEMORY_IMPORTANCE = ["medium", "high", "critical"] as const;

export const MEMORY_KINDS = ["durable", "task_detail", "uncertain"] as const;

/** Who a meeting said would carry a piece of work. "unassigned" is the honest default. */
export const TASK_OWNERS = ["us", "client", "third_party", "unassigned"] as const;

/** Access a meeting may say is needed. Nothing else is representable. */
export const MEETING_ACCESS_TYPES = [
  "wordpress_admin",
  "sftp",
  "ssh",
  "hosting_portal",
  "database",
  "cdn",
] as const;

export const LIMITS = {
  decisions: 12,
  constraints: 10,
  openQuestions: 10,
  memoryCandidates: 12,
  proposedTasks: 10,
  supersededMemory: 6,
  provenance: 3,
  line: 400,
  summary: 800,
};

export type Provenance = { chunkIndex: number; excerpt: string };

export type MeetingAnalysis = {
  summary: string;
  decisions: Array<{ statement: string; madeBy: string; confidence: "high" | "medium" | "low"; provenance: Provenance[] }>;
  constraints: Array<{ statement: string; kind: string; provenance: Provenance[] }>;
  openQuestions: Array<{ question: string; whyItMatters: string; provenance: Provenance[] }>;
  memoryCandidates: Array<{
    kind: (typeof MEMORY_KINDS)[number];
    title: string;
    content: string;
    memoryType: (typeof MEMORY_TYPES)[number];
    importance: (typeof MEMORY_IMPORTANCE)[number];
    supersedesHint: string;
    provenance: Provenance[];
  }>;
  proposedTasks: Array<{
    title: string;
    clientAsk: string;
    taskType: (typeof TASK_TYPES)[number];
    riskLevel: (typeof RISK_LEVELS)[number];
    needsInvestigation: boolean;
    accessNeeded: string[];
    dependsOn: string[];
    implementationApproach: string;
    verificationExpectation: string;
    requiresExecutionApproval: boolean;
    owner: (typeof TASK_OWNERS)[number];
    deadlineText: string;
    dueDate: string | null;
    provenance: Provenance[];
  }>;
  supersededMemory: Array<{ memoryIdHint: string; reason: string; provenance: Provenance[] }>;
};

export type MeetingValidation =
  | { ok: true; analysis: MeetingAnalysis; dropped: string[] }
  | { ok: false; reason: string };

const line = (value: unknown, max = LIMITS.line): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const bool = (value: unknown): boolean => value === true;

const oneOf = <T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : fallback;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * A calendar date the model claims the meeting named. Only an exact ISO day is
 * representable — "next sprint" stays in deadlineText, where it cannot be
 * mistaken for a commitment the system can schedule against.
 */
const isoDate = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.trim().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === text ? text : null;
};

/** Loose comparison so whitespace differences don't discard a real quote. */
const normalizeForMatch = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

export type MeetingValidationContext = {
  /** The redacted transcript chunks the model was actually given. */
  chunks: string[];
  /** Hosts the project legitimately owns. A task naming anything else is dropped. */
  allowedHosts?: string[];
};

const HOST_PATTERN = /\bhttps?:\/\/([a-z0-9.-]+)/gi;

/**
 * Language that describes losing something. A proposal reading this way always
 * keeps a human execution approval, however the model graded its own risk.
 */
const DESTRUCTIVE_PATTERN =
  /\b(delete|drop|truncate|wipe|purge|erase|destroy|uninstall|deactivate|remove|overwrite|reset|restore|rollback|revert|migrate|rename|disable)\b/i;

const readsAsDestructive = (text: string): boolean => DESTRUCTIVE_PATTERN.test(text);

const namesForeignHost = (text: string, allowedHosts: string[]): boolean => {
  if (allowedHosts.length === 0) return false;
  const matches = text.matchAll(HOST_PATTERN);
  for (const match of matches) {
    const host = (match[1] ?? "").toLowerCase().replace(/^www\./, "");
    if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return true;
  }
  return false;
};

/** Provenance must be real. An excerpt not present in the transcript is a fabrication. */
const validProvenance = (value: unknown, chunks: string[]): Provenance[] => {
  const haystacks = chunks.map(normalizeForMatch);
  const whole = haystacks.join(" \n ");
  const out: Provenance[] = [];

  for (const entry of array(value)) {
    const raw = object(entry);
    const excerpt = line(raw.excerpt, 300);
    if (excerpt.length < 8) continue;
    const needle = normalizeForMatch(excerpt);
    const declared = Number(raw.chunkIndex ?? raw.chunk_index);
    const index =
      Number.isInteger(declared) && declared >= 0 && declared < chunks.length && haystacks[declared].includes(needle)
        ? declared
        : haystacks.findIndex((chunk) => chunk.includes(needle));
    if (index < 0 || !whole.includes(needle)) continue;
    out.push({ chunkIndex: index, excerpt });
    if (out.length >= LIMITS.provenance) break;
  }
  return out;
};

/**
 * Validates a model answer into an analysis the product is willing to show.
 * Individual unsupportable items are dropped; only a structurally unusable
 * answer fails the whole call.
 */
export const validateMeetingAnalysis = (
  value: unknown,
  context: MeetingValidationContext,
): MeetingValidation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not an object" };
  }
  const raw = value as Record<string, unknown>;
  const chunks = context.chunks ?? [];
  const allowedHosts = (context.allowedHosts ?? []).map((host) => host.toLowerCase().replace(/^www\./, ""));
  const dropped: string[] = [];

  const summary = line(raw.summary, LIMITS.summary);
  if (!summary) return { ok: false, reason: "missing summary" };

  const withProvenance = <T>(
    items: unknown,
    limit: number,
    label: string,
    map: (entry: Record<string, unknown>, provenance: Provenance[]) => T | null,
  ): T[] => {
    const out: T[] = [];
    for (const item of array(items)) {
      if (out.length >= limit) break;
      const entry = object(item);
      const provenance = validProvenance(entry.provenance, chunks);
      if (provenance.length === 0) {
        dropped.push(`${label}: no verifiable provenance`);
        continue;
      }
      const mapped = map(entry, provenance);
      if (mapped === null) continue;
      out.push(mapped);
    }
    return out;
  };

  const decisions = withProvenance(raw.decisions, LIMITS.decisions, "decision", (entry, provenance) => {
    const statement = line(entry.statement);
    if (!statement) return null;
    return {
      statement,
      madeBy: line(entry.madeBy ?? entry.made_by, 80),
      confidence: oneOf(entry.confidence, ["high", "medium", "low"] as const, "medium"),
      provenance,
    };
  });

  const constraints = withProvenance(raw.constraints, LIMITS.constraints, "constraint", (entry, provenance) => {
    const statement = line(entry.statement);
    if (!statement) return null;
    return { statement, kind: line(entry.kind, 60) || "preference", provenance };
  });

  const openQuestions = withProvenance(
    raw.openQuestions ?? raw.open_questions,
    LIMITS.openQuestions,
    "question",
    (entry, provenance) => {
      const question = line(entry.question);
      if (!question) return null;
      return { question, whyItMatters: line(entry.whyItMatters ?? entry.why_it_matters), provenance };
    },
  );

  const memoryCandidates = withProvenance(
    raw.memoryCandidates ?? raw.memory_candidates,
    LIMITS.memoryCandidates,
    "memory candidate",
    (entry, provenance) => {
      const title = line(entry.title, 160);
      const content = line(entry.content, 600);
      if (!title || !content) return null;
      return {
        kind: oneOf(entry.kind, MEMORY_KINDS, "uncertain"),
        title,
        content,
        memoryType: oneOf(entry.memoryType ?? entry.memory_type, MEMORY_TYPES, "stack_note"),
        importance: oneOf(entry.importance, MEMORY_IMPORTANCE, "medium"),
        supersedesHint: line(entry.supersedesHint ?? entry.supersedes_hint, 160),
        provenance,
      };
    },
  );

  const proposedTasks = withProvenance(
    raw.proposedTasks ?? raw.proposed_tasks,
    LIMITS.proposedTasks,
    "proposed task",
    (entry, provenance) => {
      const title = line(entry.title, 160);
      if (!title) return null;
      const clientAsk = line(entry.clientAsk ?? entry.client_ask, 600);
      const implementationApproach = line(entry.implementationApproach ?? entry.implementation_approach, 600);
      const verificationExpectation = line(entry.verificationExpectation ?? entry.verification_expectation, 400);

      const combined = `${title} ${clientAsk} ${implementationApproach} ${verificationExpectation}`;
      if (namesForeignHost(combined, allowedHosts)) {
        dropped.push("proposed task: named a site outside this project");
        return null;
      }

      const accessNeeded = array(entry.accessNeeded ?? entry.access_needed)
        .filter((item): item is string => typeof item === "string")
        .filter((item) => (MEETING_ACCESS_TYPES as readonly string[]).includes(item))
        .slice(0, 4);

      const riskLevel = oneOf(entry.riskLevel ?? entry.risk_level, RISK_LEVELS, "cautious");

      // A meeting can never lower the execution bar. High risk always keeps its
      // later approval, and so does anything that reads as destructive, whatever
      // risk level the model attached to it.
      const modelSaysSafe = bool(entry.safeToProceedAfterPlanApproval ?? entry.safe_to_proceed_after_plan_approval);
      const requiresExecutionApproval =
        riskLevel === "high_risk" || readsAsDestructive(combined) ? true : !modelSaysSafe;

      return {
        title,
        clientAsk,
        taskType: oneOf(entry.taskType ?? entry.task_type, TASK_TYPES, "qa_only"),
        riskLevel,
        needsInvestigation: bool(entry.needsInvestigation ?? entry.needs_investigation),
        accessNeeded,
        dependsOn: array(entry.dependsOn ?? entry.depends_on)
          .map((item) => line(item, 160))
          .filter((item) => item.length > 0)
          .slice(0, 4),
        implementationApproach,
        verificationExpectation,
        requiresExecutionApproval,
        owner: oneOf(entry.owner, TASK_OWNERS, "unassigned"),
        deadlineText: line(entry.deadlineText ?? entry.deadline_text, 120),
        dueDate: isoDate(entry.dueDate ?? entry.due_date),
        provenance,
      };
    },
  );

  const supersededMemory = withProvenance(
    raw.supersededMemory ?? raw.superseded_memory,
    LIMITS.supersededMemory,
    "superseded memory",
    (entry, provenance) => {
      const memoryIdHint = line(entry.memoryIdHint ?? entry.memory_id_hint, 160);
      if (!memoryIdHint) return null;
      return { memoryIdHint, reason: line(entry.reason, 300), provenance };
    },
  );

  return {
    ok: true,
    dropped,
    analysis: {
      summary,
      decisions,
      constraints,
      openQuestions,
      memoryCandidates,
      proposedTasks,
      supersededMemory,
    },
  };
};

/** Deterministic task key: re-analysing the same content never duplicates work. */
export const taskKeyFor = (analysisId: string, title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${analysisId}:${slug}`;
};

export const candidateKeyFor = (analysisId: string, title: string): string => `mem:${taskKeyFor(analysisId, title)}`;