import type { Project, Run, RunDraft, TaskType } from "./types";
import { getEnvironmentName } from "./lib";

export type ThreadCardItem = {
  label: string;
  detail: string;
  tone?: "neutral" | "good" | "warn" | "bad";
};

export type ThreadCard = {
  title: string;
  items: ThreadCardItem[];
};

/** A before/after shown alongside an approval, so the change is reviewable. */
export type ThreadDiff = {
  target: string;
  before: string;
  after: string;
  irreversible?: string;
};

export type DecisionKind = "access" | "backup" | "approval" | null;

export type ThreadMessage = {
  id: string;
  role: "user" | "agent";
  body: string[];
  card?: ThreadCard;
  diff?: ThreadDiff;
  decision?: DecisionKind;
};

const severityTone = (severity: string): ThreadCardItem["tone"] =>
  severity === "critical" || severity === "high" ? "bad" : severity === "medium" ? "warn" : "neutral";

const qaTone = (result: string): ThreadCardItem["tone"] =>
  result === "passed" ? "good" : result === "failed" ? "bad" : result === "warning" ? "warn" : "neutral";

const pastAccess = (run: Run) => run.state !== "intake" && run.state !== "access_check";
const pastMapping = (run: Run) =>
  !["intake", "access_check", "backup_gate", "environment_mapping"].includes(run.state);
const pastPlan = (run: Run) =>
  ["execution", "qa", "recommendations", "complete", "rolled_back"].includes(run.state);
const inQa = (run: Run) => ["qa", "recommendations", "complete"].includes(run.state);

export const buildThread = (project: Project, run: Run): ThreadMessage[] => {
  const messages: ThreadMessage[] = [];
  const environment = getEnvironmentName(project, run.environmentId);

  messages.push({
    id: `${run.id}-brief`,
    role: "user",
    body: [run.taskSummary || run.title],
  });

  messages.push({
    id: `${run.id}-ack`,
    role: "agent",
    body: [
      `Got it. I'll take a look at ${project.primaryDomain} on ${environment.toLowerCase()} and work through this carefully.`,
      "I always start read-only, so nothing on the site changes while I'm still learning what's going on.",
    ],
  });

  if (project.accessMethods.length > 0 && pastAccess(run)) {
    messages.push({
      id: `${run.id}-access-ok`,
      role: "agent",
      body: [
        `I can reach the site using the access you shared (${project.accessMethods.map((item) => item.label).join(", ")}).`,
      ],
    });
  }

  if (run.findings.length > 0) {
    messages.push({
      id: `${run.id}-findings`,
      role: "agent",
      body: ["Here is what I found while looking through the site:"],
      card: {
        title: "What I found",
        items: run.findings.map((finding) => ({
          label: finding.title,
          detail: finding.summary,
          tone: severityTone(finding.severity),
        })),
      },
    });
  }

  if (pastMapping(run) && run.diagnosisSummary) {
    messages.push({
      id: `${run.id}-diagnosis`,
      role: "agent",
      body: [run.diagnosisSummary],
    });
  }

  if (run.planSummary && ["plan", "execution", "qa", "recommendations", "complete", "rolled_back"].includes(run.state)) {
    messages.push({
      id: `${run.id}-plan`,
      role: "agent",
      body: [
        "Here's what I recommend doing next:",
        run.planSummary,
        run.approvalRequired
          ? "This touches production, so I'd like your go-ahead before I make the change. If anything goes wrong I can restore the previous state."
          : "This is a low-impact change and I can safely handle it from here.",
      ],
    });
  }

  const meaningfulActions = run.actions.filter((action) => action.actor !== "system");

  if (pastPlan(run) && meaningfulActions.length > 0) {
    messages.push({
      id: `${run.id}-actions`,
      role: "agent",
      body: ["This is the work I've carried out so far:"],
      card: {
        title: "Work log",
        items: meaningfulActions.map((action) => ({
          label: action.summary,
          detail: action.outcome === "succeeded" ? "Completed" : action.outcome === "failed" ? "Did not complete" : "In progress",
          tone: action.outcome === "succeeded" ? "good" : action.outcome === "failed" ? "bad" : "neutral",
        })),
      },
    });
  }

  if (run.artifacts.length > 0 && pastMapping(run)) {
    messages.push({
      id: `${run.id}-artifacts`,
      role: "agent",
      body: ["I kept evidence of everything, so the work can be reviewed or reversed later:"],
      card: {
        title: "Evidence kept",
        items: run.artifacts.map((artifact) => ({ label: artifact.title, detail: artifact.summary })),
      },
    });
  }

  if (inQa(run) && run.qaReport.results.length > 0) {
    messages.push({
      id: `${run.id}-qa`,
      role: "agent",
      body: [
        run.state === "qa"
          ? "I'm running the final checks now to make sure everything really is healthy."
          : "I finished the final checks. Here's how the site behaved:",
      ],
      card: {
        title: "Final checks",
        items: run.qaReport.results.map((result) => ({
          label: result.name,
          detail: result.notes,
          tone: qaTone(result.result),
        })),
      },
    });
  }

  if (run.recommendations.length > 0) {
    messages.push({
      id: `${run.id}-recommendations`,
      role: "agent",
      body: ["A few things I'd still recommend, whenever you're ready:"],
      card: {
        title: "Recommended next",
        items: run.recommendations.map((item) => ({ label: item.title, detail: item.summary })),
      },
    });
  }

  switch (run.state) {
    case "access_check":
      messages.push({
        id: `${run.id}-decision-access`,
        role: "agent",
        body: [
          "Before I can go further, I need a way into the site. WordPress Admin is usually enough to start, and SFTP or SSH helps if I need to look at files.",
        ],
        decision: "access",
      });
      break;
    case "backup_gate":
      messages.push({
        id: `${run.id}-decision-backup`,
        role: "agent",
        body: [
          "Before I make any change on the live site, please confirm a recent backup or restore point is available. If you're not sure, I can walk you through creating one.",
        ],
        decision: "backup",
      });
      break;
    case "plan":
      if (run.approvalRequired) {
        const pending = run.approvals.find(
          (approval) => approval.type === "high_risk_execution" && approval.status === "pending",
        );
        messages.push({
          id: `${run.id}-decision-approval`,
          role: "agent",
          body: [
            "If you're happy with that approach, I'll apply it now and verify the result. If anything looks wrong afterwards I'll roll it straight back.",
          ],
          diff: pending?.preview
            ? {
                target: pending.preview.target,
                before: pending.preview.before,
                after: pending.preview.after,
                irreversible: pending.preview.irreversible,
              }
            : undefined,
          decision: "approval",
        });
      } else {
        messages.push({ id: `${run.id}-plan-working`, role: "agent", body: ["I'll carry on and apply the fix now."] });
      }
      break;
    case "qa":
      messages.push({
        id: `${run.id}-qa-working`,
        role: "agent",
        body: ["Give me a moment while I confirm the site is behaving properly, then I'll write up the result."],
      });
      break;
    case "complete":
      messages.push({
        id: `${run.id}-complete`,
        role: "agent",
        body: [
          "All done. " + (run.qaReport.summary || "The work is finished and verified."),
          "Everything is in project memory, so I'll remember it next time you need something here.",
        ],
      });
      break;
    case "paused":
    case "escalated":
    case "failed":
      messages.push({
        id: `${run.id}-decision-human`,
        role: "agent",
        body: [run.operatorPrompt || "I've stopped here on purpose and need a decision from you before continuing."],
      });
      break;
    case "rolled_back":
      messages.push({
        id: `${run.id}-rolled-back`,
        role: "agent",
        body: ["I reversed the change and put the site back the way it was. Tell me how you'd like to approach it instead."],
      });
      break;
    default:
      messages.push({
        id: `${run.id}-working`,
        role: "agent",
        body: [run.nextAction || "I'm working through this now."],
      });
  }

  return messages;
};

const inferTaskType = (brief: string): TaskType => {
  const text = brief.toLowerCase();

  if (/(malware|hacked|virus|infect|spam link|compromis)/.test(text)) return "malware";
  if (/(down|white screen|500|fatal|broken|error|not loading|crash)/.test(text)) return "broken_site";
  if (/(slow|speed|performance|load time|ttfb|core web)/.test(text)) return "performance";
  if (/(plugin|theme|conflict|update broke|incompat)/.test(text)) return "plugin_theme_conflict";
  if (/(harden|secure|cleanup|clean up|maintenance|backup)/.test(text)) return "hardening";
  if (/(check|qa|verify|review|audit|test)/.test(text)) return "qa_only";

  return "qa_only";
};

const titleFromBrief = (brief: string) => {
  const firstLine = brief.trim().split(/\n|\.\s/)[0]?.trim() ?? "";
  const clipped = firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
  return clipped || "New task";
};

export const draftFromBrief = (project: Project, brief: string): RunDraft => {
  const primaryEnvironment =
    project.environments.find((environment) => environment.type === "production") ?? project.environments[0];

  return {
    title: titleFromBrief(brief),
    taskType: inferTaskType(brief),
    taskSummary: brief.trim(),
    urgency: "normal",
    environmentId: primaryEnvironment?.id ?? "",
    accessReady: project.accessMethods.length > 0,
    backupConfirmed: false,
  };
};
