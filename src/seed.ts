import { createPhases } from "./data";
import type { Organization, Recommendation, Run, RunState } from "./types";

const now = (iso: string) => iso;

const buildRun = (input: {
  id: string;
  title: string;
  taskType: Run["taskType"];
  taskSummary: string;
  urgency: Run["urgency"];
  environmentId: string;
  state: RunState;
  riskLevel: Run["riskLevel"];
  backupStatus: Run["backupStatus"];
  approvalRequired: boolean;
  nextAction: string;
  operatorPrompt: string;
  diagnosisSummary: string;
  planSummary: string;
  startedAt: string;
  updatedAt: string;
  findings: Run["findings"];
  actions: Run["actions"];
  artifacts: Run["artifacts"];
  approvals: Run["approvals"];
  qaReport: Run["qaReport"];
  recommendations: Recommendation[];
}): Run => ({
  ...input,
  phases: createPhases(input.state, input.taskType),
});

export const createSeedWorkspace = (): Organization => ({
  id: "trusttai",
  name: "TrustTai Ops",
  descriptor: "WordPress engineering command center",
  subdomain: "ops.trust-tai.com",
  projects: [
    {
      id: "epaypolicy",
      name: "ePayPolicy",
      clientName: "ePayPolicy",
      primaryDomain: "epaypolicy.com",
      status: "active",
      environmentHealth: "watching",
      environments: [
        {
          id: "epay-prod",
          name: "Production",
          type: "production",
          primaryUrl: "https://epaypolicy.com",
          hostingProvider: "WP Engine",
          stack: "wordpress",
          versions: { wordpress: "6.7.1", php: "8.2" },
          cacheLayers: ["WP Engine cache", "Cloudflare", "Object cache"],
          notes: "High-value marketing and policy traffic. No staging parity guarantee.",
        },
        {
          id: "epay-stage",
          name: "Staging",
          type: "staging",
          primaryUrl: "https://epaypolicy.staging.wpengine.com",
          hostingProvider: "WP Engine",
          stack: "wordpress",
          versions: { wordpress: "6.7.1", php: "8.2" },
          cacheLayers: ["WP Engine cache"],
          notes: "Useful for low-risk verification, but content drifts from production.",
        },
      ],
      accessMethods: [
        {
          id: "epay-wp-admin",
          type: "wordpress_admin",
          label: "WordPress Admin",
          status: "available",
          authMethod: "Application Password",
          // Seed data cannot verify anything: no WordPress has ever answered
          // for these fixtures, so the stamp stays empty.
          lastVerifiedAt: "",
          notes: "Stored securely. Not yet checked against the live site.",
        },
        {
          id: "epay-sftp",
          type: "sftp",
          label: "WP Engine SFTP",
          status: "available",
          authMethod: "SFTP credential reference",
          lastVerifiedAt: "2026-08-04 21:41 CDT",
          notes: "Use for theme/plugin file inspection and surgical edits.",
        },
        {
          id: "epay-hosting",
          type: "hosting_portal",
          label: "WP Engine Portal",
          status: "available",
          authMethod: "Portal login reference",
          lastVerifiedAt: "2026-08-04 21:42 CDT",
          notes: "Best path for backup evidence and environment metadata.",
        },
      ],
      memoryEntries: [
        {
          id: "mem-epay-1",
          title: "Speed work should treat cache as a suspect, not proof.",
          type: "procedure",
          importance: "high",
          content: "Frontend speed can look fixed while backend admin remains slow. Always compare admin, frontend, and cache-bypassed behavior.",
        },
        {
          id: "mem-epay-2",
          title: "Production staging parity is weak.",
          type: "risk_note",
          importance: "high",
          content: "Staging cannot be treated as a fully trusted mirror. Production guardrails should stay stricter than normal.",
        },
        {
          id: "mem-epay-3",
          title: "Custom checkout-adjacent logic exists.",
          type: "stack_note",
          importance: "critical",
          content: "Any plugin disable or config change touching user flow should be classified as high-impact cautious or high-risk.",
        },
      ],
      recommendations: [
        {
          id: "rec-epay-1",
          category: "performance",
          priority: "high",
          status: "open",
          title: "Create a real performance baseline pack.",
          summary: "Store before/after traces for homepage, wp-admin, and logged-in flows so future speed work stops guessing.",
        },
        {
          id: "rec-epay-2",
          category: "process",
          priority: "medium",
          status: "reviewed",
          title: "Require backup evidence attachment for production edits.",
          summary: "Checkbox-only backup confirmation is too weak for high-value production work.",
        },
      ],
      riskFlags: [
        {
          id: "risk-epay-1",
          severity: "high",
          status: "open",
          title: "No dependable staging parity",
          summary: "Production changes need stronger approvals because staging does not fully reflect live conditions.",
        },
      ],
      qaRules: [
        {
          id: "qa-epay-1",
          name: "Homepage availability",
          type: "availability_check",
          required: true,
          description: "Primary marketing pages must load without fatal errors.",
        },
        {
          id: "qa-epay-2",
          name: "Admin login sanity",
          type: "login_check",
          required: true,
          description: "Admin must remain reachable after any fix touching auth, plugins, or caching.",
        },
        {
          id: "qa-epay-3",
          name: "Visual spot check",
          type: "visual_check",
          required: true,
          description: "Desktop and mobile spot checks on key public pages before closure.",
        },
      ],
      runs: [
        buildRun({
          id: "run-epay-speed",
          title: "Speed stabilization and cache-path diagnosis",
          taskType: "performance",
          taskSummary: "The site feels improved in spots but still needs a governed speed pass with real evidence and rollback posture.",
          urgency: "urgent",
          environmentId: "epay-prod",
          state: "qa",
          riskLevel: "cautious",
          backupStatus: "evidence_attached",
          approvalRequired: false,
          nextAction: "Complete visual QA on mobile, then publish the recommendation pack.",
          operatorPrompt: "Confirm whether mobile spot-check artifacts should be attached before the run closes.",
          diagnosisSummary: "Cache behavior and inconsistent optimization layers are masking where the real latency still lives.",
          planSummary: "Validate backup, map cache layers, capture evidence, apply narrow cache/config improvements, then run QA.",
          startedAt: now("2026-08-04 20:18 CDT"),
          updatedAt: now("2026-08-04 22:00 CDT"),
          findings: [
            {
              id: "finding-epay-1",
              severity: "high",
              title: "Admin latency does not match public-page cache wins",
              summary: "The public experience improved faster than the operator experience. The system should not call that full success.",
            },
            {
              id: "finding-epay-2",
              severity: "medium",
              title: "Environment memory already predicts staging drift",
              summary: "The drift note changed the plan from staging-first to production-cautious verification.",
            },
          ],
          actions: [
            { id: "action-epay-1", actor: "operator", summary: "Attached WP Engine backup confirmation.", outcome: "succeeded" },
            { id: "action-epay-2", actor: "agent", summary: "Mapped caching layers and environment notes.", outcome: "succeeded" },
            { id: "action-epay-3", actor: "agent", summary: "Logged diagnosis and constrained the execution plan.", outcome: "succeeded" },
          ],
          artifacts: [
            { id: "artifact-epay-1", type: "backup_note", title: "Backup evidence", summary: "WP Engine restore point attached before changes." },
            { id: "artifact-epay-2", type: "report", title: "Cache-path note", summary: "Compared cache-hit public flow vs admin behavior." },
          ],
          approvals: [],
          qaReport: {
            verdict: "partial",
            summary: "Core functionality is stable, but mobile visual QA and one deeper admin sanity check still need closure.",
            unresolvedRisks: [
              "Need final mobile artifact capture.",
              "Admin responsiveness should be compared again after cache settles.",
            ],
            results: [
              { id: "qa-result-epay-1", name: "Homepage availability", result: "passed", notes: "Public homepage loads cleanly." },
              { id: "qa-result-epay-2", name: "Admin login sanity", result: "warning", notes: "Reachable, but still feels slower than target." },
              { id: "qa-result-epay-3", name: "Visual spot check", result: "warning", notes: "Desktop checked. Mobile artifact still pending." },
            ],
          },
          recommendations: [
            {
              id: "run-rec-epay-1",
              category: "performance",
              priority: "high",
              status: "open",
              title: "Record baseline traces for future speed work.",
              summary: "This project needs durable before/after proof, not memory and vibes.",
            },
          ],
        }),
      ],
    },
    {
      id: "bluehole",
      name: "Blue Hole Road FC",
      clientName: "Blue Hole Road FC",
      primaryDomain: "blueholeroadfc.com",
      status: "active",
      environmentHealth: "stable",
      environments: [
        {
          id: "bluehole-prod",
          name: "Production",
          type: "production",
          primaryUrl: "https://blueholeroadfc.com",
          hostingProvider: "Vercel + WordPress content backend",
          stack: "wordpress",
          versions: { wordpress: "6.6.2", php: "8.1" },
          cacheLayers: ["CDN", "Application cache"],
          notes: "Frontend delivery sits outside classic WordPress theme control.",
        },
      ],
      accessMethods: [
        {
          id: "bluehole-wp",
          type: "wordpress_admin",
          label: "WordPress Admin",
          status: "available",
          authMethod: "Application Password",
          lastVerifiedAt: "",
          notes: "Use cautiously; public delivery path is partially decoupled.",
        },
        {
          id: "bluehole-cdn",
          type: "cdn",
          label: "Delivery Layer",
          status: "available",
          authMethod: "Platform project access",
          lastVerifiedAt: "2026-08-02 18:11 CDT",
          notes: "Useful for QA and delivery issues more than content fixes.",
        },
      ],
      memoryEntries: [
        {
          id: "mem-bluehole-1",
          title: "WordPress is not the whole blast radius.",
          type: "risk_note",
          importance: "critical",
          content: "Runs must account for the external delivery layer before assuming a WordPress-only fix changes the visible site.",
        },
      ],
      recommendations: [],
      riskFlags: [],
      qaRules: [
        {
          id: "qa-bluehole-1",
          name: "Public route check",
          type: "availability_check",
          required: true,
          description: "Top public routes must load without delivery errors.",
        },
      ],
      runs: [
        buildRun({
          id: "run-bluehole-qa",
          title: "Pre-season QA confidence pass",
          taskType: "qa_only",
          taskSummary: "Verify the site is stable across the public routes before the next campaign push.",
          urgency: "normal",
          environmentId: "bluehole-prod",
          state: "recommendations",
          riskLevel: "safe",
          backupStatus: "unconfirmed",
          approvalRequired: false,
          nextAction: "Convert the two small findings into project memory and close the run.",
          operatorPrompt: "Review whether the route-level caveat should become a permanent project procedure.",
          diagnosisSummary: "No active production issue. The run is serving as a confidence-building QA pass.",
          planSummary: "Map delivery-sensitive routes, run visual checks, note any weak spots, and publish follow-up guidance.",
          startedAt: now("2026-08-03 15:05 CDT"),
          updatedAt: now("2026-08-04 18:20 CDT"),
          findings: [
            {
              id: "finding-bluehole-1",
              severity: "medium",
              title: "Delivery layer needs to stay in the QA story",
              summary: "WordPress-only QA misses a class of frontend breakage for this project.",
            },
          ],
          actions: [
            { id: "action-bluehole-1", actor: "agent", summary: "Ran public route checks and visual spot checks.", outcome: "succeeded" },
          ],
          artifacts: [
            { id: "artifact-bluehole-1", type: "qa_capture", title: "Public route check", summary: "Captured successful top-route verification." },
          ],
          approvals: [],
          qaReport: {
            verdict: "passed",
            summary: "No active regression detected. The main value is the future QA rule improvement.",
            unresolvedRisks: [],
            results: [
              { id: "qa-result-bluehole-1", name: "Public route check", result: "passed", notes: "Top routes loaded as expected." },
            ],
          },
          recommendations: [
            {
              id: "run-rec-bluehole-1",
              category: "process",
              priority: "medium",
              status: "open",
              title: "Add delivery-layer QA notes to the project memory.",
              summary: "Future operators should not assume the visible site is a pure WordPress surface.",
            },
          ],
        }),
      ],
    },
    {
      id: "bioptrics",
      name: "Bioptrics (TeamsynerG)",
      clientName: "TeamsynerG",
      primaryDomain: "lms.teamsynerg.com",
      status: "active",
      environmentHealth: "stable",
      deployPipeline: {
        hasStaging: true,
        branchGated: true,
        autoDeployStaging: true,
        autoDeployProduction: true,
        stagingUrl: "https://dev-pulse-lms.bioptrics.com",
        productionUrl: "https://lms.teamsynerg.com",
        integrationBranch: "develop",
        productionBranch: "main",
        buildTimeMinutes: 4,
        buildTimeMinMinutes: 4,
        buildTimeMaxMinutes: 7,
        rollbackStrategy: "git_revert",
        steps: [
          {
            kind: "feature_branch",
            label: "Feature branch",
            detail: "Work happens on a branch, never directly on a shared branch.",
          },
          {
            kind: "integration_branch",
            label: "develop",
            detail: "Merging to develop deploys staging automatically.",
          },
          {
            kind: "staging_verify",
            label: "Staging verify",
            detail: "Staging must be checked and healthy before anything moves on.",
          },
          {
            kind: "release_branch",
            label: "main",
            detail: "Only verified work merges to main.",
          },
          {
            kind: "production",
            label: "Production",
            detail: "Merging to main deploys production automatically.",
          },
        ],
      },
      environments: [
        {
          id: "bioptrics-prod",
          name: "Production",
          type: "production",
          primaryUrl: "https://lms.teamsynerg.com",
          hostingProvider: "Dedicated server",
          stack: "meteor",
          versions: { meteor: "2.15", node: "22.22.1", mongo: "8.2.3" },
          runtime: {
            port: 3000,
            processManager: "PM2",
            databaseProvider: "MongoDB Atlas",
            databaseName: "production cluster",
          },
          cacheLayers: [],
          notes: "Live learning platform. Long-running application process, so restarts are visible to users.",
        },
        {
          id: "bioptrics-stage",
          name: "Staging",
          type: "staging",
          primaryUrl: "https://dev-pulse-lms.bioptrics.com",
          hostingProvider: "Dedicated server",
          stack: "meteor",
          versions: { meteor: "2.15", node: "22.22.1", mongo: "8.2.3" },
          runtime: {
            port: 3001,
            processManager: "PM2",
            databaseProvider: "MongoDB Atlas",
            databaseName: "staging database",
          },
          cacheLayers: [],
          notes: "Every change is verified here first. Collection parity with production is not guaranteed.",
        },
      ],
      accessMethods: [
        {
          id: "bioptrics-ssh",
          type: "ssh",
          label: "SSH Access",
          status: "available",
          authMethod: "root@178.156.170.11",
          lastVerifiedAt: "",
          notes: "Recorded from the client handoff. Not yet verified by the system.",
        },
        {
          id: "bioptrics-ci",
          type: "ci_cd",
          label: "CI/CD pipeline",
          status: "available",
          authMethod: "GitHub Actions",
          lastVerifiedAt: "",
          notes: "Recorded as environment truth. The system does not act on the pipeline yet.",
        },
        {
          id: "bioptrics-pm2",
          type: "server_pm2",
          label: "Server process manager",
          status: "available",
          authMethod: "PM2 on the application server",
          lastVerifiedAt: "",
          notes: "Recorded as environment truth. The system does not restart processes yet.",
        },
        {
          id: "bioptrics-db",
          type: "database",
          label: "Database",
          status: "available",
          authMethod: "MongoDB Atlas",
          lastVerifiedAt: "",
          notes: "Recorded as environment truth. No database execution path exists yet.",
        },
      ],
      memoryEntries: [
        {
          id: "mem-bioptrics-1",
          title: "ALWAYS staging first — never skip",
          type: "procedure",
          importance: "critical",
          content: "Every change goes through staging verification before main. This protocol is not negotiable, even for small fixes.",
        },
        {
          id: "mem-bioptrics-2",
          title: "Migration 009 hung startup — 74MB topic fetch on boot",
          type: "incident_note",
          importance: "critical",
          content: "A boot-time migration pulled roughly 74MB of topic data and hung startup. Treat any boot-time data work as a startup risk.",
        },
        {
          id: "mem-bioptrics-3",
          title: "8,133 PM2 restarts from disk-full crash loop",
          type: "incident_note",
          importance: "high",
          content: "A full disk drove the process into a crash loop with 8,133 restarts. Disk headroom is part of health, not an afterthought.",
        },
        {
          id: "mem-bioptrics-4",
          title: "Multi-tenant isolation ~40% unconfirmed on organizationId scoping",
          type: "risk_note",
          importance: "high",
          content: "Roughly 40% of queries have not been confirmed to scope by organizationId. Assume tenant isolation is unproven until audited.",
        },
      ],
      recommendations: [
        {
          id: "rec-bioptrics-1",
          category: "performance",
          priority: "high",
          status: "open",
          title: "Performance fixes 2-5 are parked",
          summary: "Prefetch tuning, DDP WebSocket compression, and contentBlocks extraction remain outstanding.",
        },
        {
          id: "rec-bioptrics-2",
          category: "security",
          priority: "high",
          status: "open",
          title: "Multi-tenant isolation audit",
          summary: "Confirm every query scopes by organizationId before treating tenant separation as safe.",
        },
      ],
      riskFlags: [
        {
          id: "risk-bioptrics-1",
          severity: "high",
          status: "open",
          title: "Staging parity is not guaranteed for all collections",
          summary: "Staging verification is still required, but a clean staging result does not prove production data behaves the same way.",
        },
      ],
      qaRules: [
        {
          id: "qa-bioptrics-1",
          name: "Production availability",
          type: "availability_check",
          required: true,
          description: "The production URL must load before and after any release.",
        },
        {
          id: "qa-bioptrics-2",
          name: "Application process health",
          type: "login_check",
          required: true,
          description: "The application should stay reachable and the app process should stay healthy after any change.",
        },
      ],
      runs: [],
    },
  ],
});
