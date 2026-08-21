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
      }
      break;
    }
    case "qa": {
      // If execution had failures, surface a rollback decision so the user can
      // choose immediately. Ordinary progress is narrated by the agent itself.
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
      }
      break;
    }
    case "paused":
    case "escalated":
    case "failed":
      if (run.operatorPrompt) {
        messages.push({
          id: `${run.id}-decision-human`,
          role: "agent",
          body: [run.operatorPrompt],
        });
      }
      break;
    default:
      break;
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

/** A written name for the work, rather than an echo of the first line typed. */
const TASK_TITLES: Record<TaskType, string> = {
  malware: "Malware cleanup",
  performance: "Performance investigation",
  broken_site: "Site outage investigation",
  plugin_theme_conflict: "Plugin or theme conflict",
  hardening: "Hardening and maintenance",
  qa_only: "Site review",
  deploy: "Deployment",
  migration: "Migration",
  feature: "Feature work",
  dependency_upgrade: "Dependency upgrade",
};

const subjectFromBrief = (brief: string, project: Project): string => {
  const lower = brief.toLowerCase();
  if (/\b(seo|search|indexing|ranking|visibility|serp)\b/.test(lower)) return "search visibility";
  if (/\b(checkout|cart|woocommerce|payment)\b/.test(lower)) return "checkout";
  if (/\b(form|contact form|enquiry|enquir)\b/.test(lower)) return "forms";
  if (/\b(email|smtp|deliverab)\b/.test(lower)) return "email delivery";
  if (/\b(mobile|responsive)\b/.test(lower)) return "mobile experience";
  return project.primaryDomain || "";
};

const titleFromBrief = (brief: string, project: Project, taskType: TaskType): string => {
  const base = TASK_TITLES[taskType];
  const subject = subjectFromBrief(brief, project);
  return subject ? `${base} — ${subject}` : base;
};

/**
 * Is this message conversation, or is it work?
 *
 * A greeting, a question, a pasted URL or a short aside is talk: it gets a
 * reply, not a task in the rail. Only something that describes work opens a
 * task, and anything genuinely in between is asked about once.
 */
export type IntakeIntent = "chat" | "task" | "ambiguous";

const CHAT_OPENERS =
  /^(hi|hey|hello|yo|good (morning|afternoon|evening)|thanks|thank you|cheers|ok|okay|sure|yes|no|got it|nice|great|sorry)\b/;

const WORK_SIGNALS = [
  /\b(fix|repair|debug|investigate|diagnose|audit|review|check|migrate|optimi[sz]e|harden|clean up|cleanup|restore|update|upgrade|deploy|build|set up)\b/,
  /\b(broken|down|not working|white screen|slow|hacked|malware|error|failing|crash)\b/,
  /\b(brief|scope|objective|deliverable|requirement)s?\b/,
];

export const classifyIntake = (message: string): IntakeIntent => {
  const text = message.trim();
  if (!text) return "chat";

  const lower = text.toLowerCase();
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  // A bare link, a greeting or a one-line question is conversation.
  if (/^https?:\/\/\S+$/i.test(text)) return "chat";
  if (CHAT_OPENERS.test(lower) && text.length < 120) return "chat";
  if (text.length < 40) return "chat";
  if (lines.length === 1 && text.endsWith("?") && text.length < 140) return "chat";

  if (looksLikeNewTaskBrief(text)) return "task";
  if (text.length >= 80 && WORK_SIGNALS.some((pattern) => pattern.test(lower))) return "task";

  return "ambiguous";
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
  if (text.length < 80) return false;
  // A pasted link, however long, is context for the task at hand.
  if (/^https?:\/\/\S+$/i.test(text)) return false;

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

  const structured = text.split("\n").filter((line) => line.trim().length > 0).length >= 5;

  return structured || briefSignals.some((pattern) => pattern.test(lower));
};

export const draftFromBrief = (project: Project, brief: string): RunDraft => {
  const primaryEnvironment =
    project.environments.find((environment) => environment.type === "production") ?? project.environments[0];
  const taskType = inferTaskType(brief);

  return {
    title: titleFromBrief(brief, project, taskType),
    taskType,
    taskSummary: brief.trim(),
    urgency: "normal",
    environmentId: primaryEnvironment?.id ?? "",
    accessReady: project.accessMethods.length > 0,
    backupConfirmed: false,
  };
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
