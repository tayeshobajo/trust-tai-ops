import type { MemoryEntry, Project, Run } from "./types";

/**
 * Project memory grouping + deterministic derivation.
 *
 * There is no AI synthesis layer yet, so nothing here invents facts. Memory is
 * either seeded, written by a human, or derived from concrete completed-run data.
 */

export type MemorySection = {
  id: string;
  title: string;
  blurb: string;
  entries: MemoryEntry[];
};

const SECTION_FOR_TYPE: Record<MemoryEntry["type"], string> = {
  stack_note: "technical",
  incident_note: "incidents",
  risk_note: "fragile",
  qa_rule: "rules",
  procedure: "rules",
};

const SECTION_META: Array<{ id: string; title: string; blurb: string }> = [
  { id: "technical", title: "Technical setup", blurb: "Stack facts, custom functionality, and integrations the agent relies on." },
  { id: "fragile", title: "Things to be careful with", blurb: "Fragile areas the agent treats with extra caution." },
  { id: "incidents", title: "Incidents and fixes", blurb: "What went wrong before, and what actually resolved it." },
  { id: "rules", title: "Project rules and preferences", blurb: "How this project wants work to be done." },
];

export const importanceLabel = (importance: MemoryEntry["importance"]) =>
  importance === "critical" ? "Always apply" : importance === "high" ? "Important" : "Good to know";

export const memoryTypeLabel = (type: MemoryEntry["type"]) => {
  switch (type) {
    case "stack_note":
      return "Technical setup";
    case "incident_note":
      return "Known issue";
    case "risk_note":
      return "Be careful";
    case "qa_rule":
    case "procedure":
      return "Project rule";
    default:
      return "General";
  }
};

/** Simple choices shown to a human, mapped onto the existing model. */
export const HUMAN_MEMORY_KINDS: Array<{ id: string; label: string; type: MemoryEntry["type"] }> = [
  { id: "technical", label: "Technical", type: "stack_note" },
  { id: "rule", label: "Project rule", type: "procedure" },
  { id: "issue", label: "Known issue", type: "incident_note" },
  { id: "general", label: "General", type: "stack_note" },
];

export const groupMemory = (project: Project): MemorySection[] =>
  SECTION_META.map((meta) => ({
    ...meta,
    entries: project.memoryEntries.filter((entry) => SECTION_FOR_TYPE[entry.type] === meta.id),
  })).filter((section) => section.entries.length > 0);

/** The first durable fact that reads like an overview, if one exists. */
export const projectUnderstanding = (project: Project): MemoryEntry | null =>
  project.memoryEntries.find((entry) => entry.title.toLowerCase().includes("initial project context")) ?? null;

export const openRecommendations = (project: Project) =>
  project.recommendations.filter((item) => item.status === "open" || item.status === "reviewed");

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export const memoryExists = (project: Project, title: string) =>
  project.memoryEntries.some((entry) => normalize(entry.title) === normalize(title));

export type DerivedMemory = {
  title: string;
  type: MemoryEntry["type"];
  importance: MemoryEntry["importance"];
  content: string;
};

const qaSentence = (run: Run) => {
  switch (run.qaReport.verdict) {
    case "passed":
      return "Final checks passed after the fix.";
    case "partial":
      return "Final checks passed with a warning worth remembering.";
    case "waived":
      return "Final checks were waived by the owner.";
    default:
      return "Final checks did not pass.";
  }
};

/**
 * Derives durable memory from a completed run, only where the run already holds
 * concrete data. Anything requiring interpretation is deliberately skipped and
 * left for the future AI layer.
 */
export const deriveMemoryFromRun = (project: Project, run: Run): DerivedMemory[] => {
  if (run.state !== "complete") return [];

  const derived: DerivedMemory[] = [];

  // Incident + verified fix.
  if (run.diagnosisSummary.trim() && run.qaReport.verdict !== "failed") {
    const title = `Resolved: ${run.title.replace(/\.$/, "")}`;
    if (!memoryExists(project, title)) {
      derived.push({
        title,
        type: "incident_note",
        importance: run.qaReport.verdict === "partial" ? "high" : "medium",
        content: [
          run.diagnosisSummary.trim(),
          run.planSummary.trim(),
          qaSentence(run),
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
  }

  // Fragile areas, only from findings the run already recorded as serious.
  for (const finding of run.findings) {
    if (finding.severity !== "high" && finding.severity !== "critical") continue;
    if (!finding.summary.trim()) continue;
    const title = `Be careful with: ${finding.title.replace(/\.$/, "")}`;
    if (memoryExists(project, title) || derived.some((item) => normalize(item.title) === normalize(title))) continue;
    derived.push({
      title,
      type: "risk_note",
      importance: finding.severity === "critical" ? "critical" : "high",
      content: `${finding.summary.trim()} Found while working on ${run.title.replace(/\.$/, "")}.`,
    });
  }

  return derived;
};
