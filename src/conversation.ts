import type { Project, Run, RunDraft, TaskType } from "./types";

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

export type DecisionKind = "access" | "backup" | "approval" | "rollback" | null;

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

const pastMapping = (run: Run) =>
  !["intake", "access_check", "backup_gate", "environment_mapping"].includes(run.state);
const pastPlan = (run: Run) =>
  ["execution", "qa", "recommendations", "complete", "rolled_back"].includes(run.state);
const inQa = (run: Run) => ["qa", "recommendations", "complete"].includes(run.state);

/**
 * State-derived thread entries.
 *
 * This builds only what the agent has not said in its own voice: evidence
 * cards and decision requests. Narration — acknowledgements, diagnosis
 * restatements, plan recaps — belongs to the real conversation, never to a
 * reconstruction, or the same thing gets said twice in two wordings.
 */
export const buildThread = (_project: Project, run: Run): ThreadMessage[] => {
  const messages: ThreadMessage[] = [];

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
    case "plan": {
      if (run.approvalRequired) {
        const pending = run.approvals.find(
          (approval) => approval.type === "high_risk_execution" && approval.status === "pending",
        );
        // Fallback diff: pull the first fix-plan step preview out of the
        // fix_plan artifact (stored as FixPlanResult JSON in its summary)
        // when the pending approval carries no preview of its own.
        let fixPlanDiff: ThreadDiff | undefined;
        const fixPlanArtifact = run.artifacts.find((a) => a.type === "fix_plan");
        if (!pending?.preview && fixPlanArtifact?.summary) {
          try {
            const fp = JSON.parse(fixPlanArtifact.summary) as {
              steps?: Array<{ preview?: { target: string; before: string; after: string; irreversible?: string } }>;
            };
            const firstPreview = fp.steps?.find((s) => s.preview)?.preview;
            if (firstPreview) {
              fixPlanDiff = {
                target: firstPreview.target,
                before: firstPreview.before,
                after: firstPreview.after,
                irreversible: firstPreview.irreversible,
              };
            }
          } catch {
            // Malformed JSON in artifact summary — skip the diff, still show approval.
          }
        }
        messages.push({
          id: `${run.id}-decision-approval`,
          role: "agent",
          body: [
            fixPlanArtifact
              ? "I've put together a fix plan for this. Review the steps below and approve when you're ready."
              : "If you're happy with that approach, I'll apply it now and verify the result. If anything looks wrong afterwards I'll roll it straight back.",
          ],
          diff: pending?.preview
            ? {
                target: pending.preview.target,
                before: pending.preview.before,
                after: pending.preview.after,
                irreversible: pending.preview.irreversible,
              }
            : fixPlanDiff,
          decision: "approval",
        });
      } else {
        messages.push({ id: `${run.id}-plan-working`, role: "agent", body: ["I'll carry on and apply the fix now."] });
      }
      break;
    }
    case "qa": {
      // If execution had failures, surface a rollback decision alongside the
      // normal re-observation so the user can choose immediately.
      const hasFailedExecution = run.artifacts.some((a) => a.type === "execution_failed");
      if (hasFailedExecution) {
        messages.push({
          id: `${run.id}-qa-rollback`,
          role: "agent",
          body: [
            "One or more fix steps didn't complete successfully. I'm re-observing the site now to assess the actual state.",
            "You can roll back to the last known-good state while I finish checking, or wait for my full assessment.",
          ],
          decision: "rollback",
        });
      } else {
        messages.push({
          id: `${run.id}-qa-working`,
          role: "agent",
          body: ["Give me a moment while I confirm the site is behaving properly, then I'll write up the result."],
        });
      }
      break;
    }
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

/**
 * Does this message start a second piece of work, or does it belong to the
 * task already underway?
 *
 * The agent runs one task at a time. When someone pastes a fresh brief in the
 * middle of something else, that brief becomes a queued task rather than
 * derailing the live one. The test is deliberately conservative: anything that
 * reads like an answer, a correction, or a short aside stays in the thread.
 */
export const looksLikeNewTaskBrief = (message: string): boolean => {
  const text = message.trim();
  if (text.length < 60) return false;

  const lower = text.toLowerCase();

  // Replies, answers and asides continue the current task.
  if (/^(yes|no|ok|okay|sure|thanks|thank you|correct|that's right|go ahead|do it|continue|proceed|wait|stop|hold on)\b/.test(lower)) {
    return false;
  }
  if (/^(here|here's|here is|attached|the password|the login|it's|its|i mean|actually|sorry)\b/.test(lower)) {
    return false;
  }
  // Quoted replies are always about the thing being quoted.
  if (text.startsWith(">")) return false;
  if (/\b(that|this|it|the above|your last|you said|earlier)\b/.test(lower.slice(0, 40)) && text.length < 200) {
    return false;
  }

  const briefSignals = [
    /\bnew task\b/,
    /\bseparate (task|piece of work|job)\b/,
    /\bnext,? (i|we|can you|could you)\b/,
    /\balso,? (i|we) (want|need|would like)\b/,
    /\b(i|we) (want|need|would like) (you )?to\b/,
    /\bcan you (also )?(look at|fix|build|set up|improve|audit|review)\b/,
    /\bplease (fix|build|set up|improve|audit|review|migrate|optimi[sz]e)\b/,
    /\b(brief|scope|objective|deliverable|requirement)s?\b/,
  ];

  const structured = text.split("\n").filter((line) => line.trim().length > 0).length >= 4;

  return structured || briefSignals.some((pattern) => pattern.test(lower));
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
