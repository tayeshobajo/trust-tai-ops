/**
 * Canonical long-term recall acceptance test.
 *
 * Run with: npm run check:continuity-e2e
 *
 * This process starts cold: nothing about the offer exists in memory here. A
 * project history is materialised first — a 30-day-old agent offer buried under
 * thousands of unrelated messages — and only then is "option B" sent. The store
 * mirrors the edge function's read semantics exactly: anchors are looked up by
 * name (as the database index does), and lexical search sees only a bounded
 * newest-first window. If recall came from anything other than that stored
 * history, the assertions below cannot pass.
 */

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const { extractAnchors } = await import("../supabase/functions/_shared/continuity/anchors.ts");
const { resolveContinuity, MAX_REFERENCES, RETRIEVAL_BUDGET } = await import(
  "../supabase/functions/_shared/continuity/retrieval.ts"
);
const { retrievedPromptLines } = await import("../supabase/functions/_shared/reasonPrompt.ts");

const NOW = Date.parse("2026-04-01T09:00:00.000Z");
const at = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const PROJECT = "proj-alpha";
const OTHER_PROJECT = "proj-beta";
const RECENT_WINDOW = 400; // mirrors RECENT_MESSAGE_WINDOW in the edge function

type Row = { id: string; projectId: string; runId: string | null; role: string; body: string[]; createdAt: string };
type Anchor = ReturnType<typeof extractAnchors>[number] & {
  id: string;
  projectId: string;
  runId: string | null;
  sourceMessageId: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// 1. A real project history: one offer, then a month of unrelated work.
// ---------------------------------------------------------------------------

const OFFER =
  "Two ways forward on the checkout timeouts. Option A (raise the PHP worker count with the host and keep the " +
  "current plugin set) or Option B (drop the abandoned-cart plugin and move the emails to a queued sender).";

const messages: Row[] = [
  {
    id: "msg-offer",
    projectId: PROJECT,
    runId: "run-checkout",
    role: "agent",
    body: [OFFER],
    createdAt: at(30),
  },
  { id: "msg-done", projectId: PROJECT, runId: "run-checkout", role: "agent", body: ["Task closed."], createdAt: at(29) },
];

// A month of unrelated conversation, far more than any window would carry.
for (let index = 0; index < 2_400; index += 1) {
  messages.push({
    id: `noise-${index}`,
    projectId: PROJECT,
    runId: `run-noise-${index % 40}`,
    role: index % 2 === 0 ? "agent" : "user",
    body: [`Routine note ${index}: media library cleanup, uptime steady, no action needed.`],
    createdAt: at(28 - (index / 2_400) * 27),
  });
}

// Another customer offers its own Option B. It must never be reachable.
messages.push({
  id: "other-offer",
  projectId: OTHER_PROJECT,
  runId: "run-other",
  role: "agent",
  body: ["Option A (restore from backup) or Option B (wipe the staging database and resync)."],
  createdAt: at(5),
});

// ---------------------------------------------------------------------------
// 2. Server-side indexing, exactly as the boundary does it: agents only.
// ---------------------------------------------------------------------------

const anchors: Anchor[] = [];
const indexMessage = (row: Row) => {
  for (const draft of extractAnchors({ id: row.id, runId: row.runId, role: row.role, body: row.body, createdAt: row.createdAt })) {
    const key = `${row.id}:${draft.normalizedLabel}`;
    if (anchors.some((anchor) => `${anchor.sourceMessageId}:${anchor.normalizedLabel}` === key)) continue; // unique index
    anchors.push({ ...draft, id: `anchor-${anchors.length}`, projectId: row.projectId, runId: row.runId, sourceMessageId: row.id, createdAt: row.createdAt });
  }
};
for (const row of messages) indexMessage(row);
// Retry / double submit: re-indexing the same message must converge.
indexMessage(messages[0]);
indexMessage(messages[0]);

check("only structured agent offers minted anchors", anchors.every((anchor) => anchor.sourceMessageId === "msg-offer" || anchor.sourceMessageId === "other-offer"));
check("re-indexing the same message does not multiply anchors", anchors.filter((a) => a.sourceMessageId === "msg-offer" && a.anchorType === "option").length === 2);
check("2,400 ordinary messages minted nothing", anchors.filter((a) => a.sourceMessageId.startsWith("noise-")).length === 0);

// ---------------------------------------------------------------------------
// 3. The store, with the edge function's read semantics.
// ---------------------------------------------------------------------------

let messageWindowReads = 0;
const storeFor = (projectId: string) => ({
  listAnchors: async (asked: string, query: { normalizedLabel: string | null; alias: string | null }) => {
    if (asked !== projectId) throw new Error("cross-project read attempted");
    return anchors
      .filter((anchor) => anchor.projectId === asked)
      .filter((anchor) => (query.normalizedLabel ? anchor.normalizedLabel === query.normalizedLabel : true))
      .filter((anchor) => (query.alias ? anchor.aliases.includes(query.alias) : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 200)
      .map((anchor) => ({ ...anchor, runTitle: anchor.runId === "run-checkout" ? "Checkout timeouts" : null }));
  },
  searchMessages: async (asked: string, terms: string[], limit: number) => {
    if (asked !== projectId) throw new Error("cross-project read attempted");
    messageWindowReads += 1;
    return messages
      .filter((row) => row.projectId === asked)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, RECENT_WINDOW)
      .filter((row) => terms.some((term) => row.body.join(" ").toLowerCase().includes(term)))
      .slice(0, limit)
      .map((row) => ({ id: row.id, runId: row.runId, role: row.role, text: row.body.join(" "), createdAt: row.createdAt, runTitle: null }));
  },
});

const ask = (text: string, projectId = PROJECT, runId: string | null = "run-new") =>
  resolveContinuity({ projectId, runId, text, now: NOW }, storeFor(projectId));

// ---------------------------------------------------------------------------
// 4. The acceptance test itself.
// ---------------------------------------------------------------------------

const recalled = await ask("option B");
check("a 30-day-old Option B resolves from stored history", recalled.status === "resolved");
check("it is the exact wording that was offered", recalled.references[0]?.summary.includes("queued sender") === true);
check("it did not absorb Option A", recalled.references[0]?.summary.includes("worker count") === false);
check("provenance points at the stored source message", recalled.references[0]?.sourceMessageId === "msg-offer");
check("provenance carries the originating task", recalled.references[0]?.sourceRunId === "run-checkout");
check("the match is reported as an exact label match", recalled.references[0]?.method === "anchor_exact");
check("recall never touched the recent message window", messageWindowReads === 0);
check("the other customer's Option B was unreachable", recalled.references.every((r) => !r.summary.includes("wipe the staging")));

const alias = await ask("do the second one");
check("\"do the second one\" resolves to the same option", alias.status === "resolved" && alias.references[0]?.label === "Option B");
const alias2 = await ask("the second one");
check("\"the second one\" resolves too", alias2.status === "resolved" && alias2.references[0]?.label === "Option B");

const capped = await ask("continue where we left off");
check("an unsupported pointer asks rather than guesses", capped.status === "not_found" && (capped.question ?? "").length > 0);
check("the question stays short", (capped.question ?? "").length < 200);

const yesterday = await ask("same as yesterday");
check("a bare temporal pointer does not invent a decision", yesterday.status === "not_found");

const selfContained = await ask("The product images stopped loading on mobile this morning");
check("an ordinary request costs no recall", selfContained.status === "not_needed" && selfContained.charCount === 0);

const neverOffered = await ask("let's do option D");
check("an option that was never offered is refused", neverOffered.status === "not_found");
check("the refusal names what it could not find", (neverOffered.question ?? "").includes("Option D"));

// Two different historical Option Bs.
indexMessage({
  id: "msg-second-offer",
  projectId: PROJECT,
  runId: "run-seo",
  role: "agent",
  body: ["Option A (rewrite the meta descriptions by hand) or Option B (generate them from the product feed)."],
  createdAt: at(2),
});
const ambiguous = await ask("option B");
check("two different Option Bs are never guessed between", ambiguous.status === "ambiguous");
check("the clarification names both candidates", (ambiguous.question ?? "").includes("product feed") && (ambiguous.question ?? "").includes("queued sender"));
check("the clarification places each in time", (ambiguous.question ?? "").includes("last month") && (ambiguous.question ?? "").includes("last week"));
check("the clarification names the task each came from", (ambiguous.question ?? "").includes("Checkout timeouts"));
check("an ambiguous turn writes no confident provenance", ambiguous.references.every((r) => r.confidence < 0.5));

// Caps.
check("references stay under the cap", ambiguous.references.length <= MAX_REFERENCES);
const promptLines = retrievedPromptLines(
  recalled.references.map((reference) => ({ label: reference.label, text: reference.summary, when: "last month" })),
);
check("retrieved context stays inside the character budget", promptLines.join("\n").length <= RETRIEVAL_BUDGET);
check(
  "retrieved context is framed as a record of what was said, not as fact",
  promptLines[0].includes("a record of what was said, not proof it is still true"),
);
check("each retrieved item is tagged as conversation, not as evidence", promptLines.slice(1).every((line) => line.startsWith("- retrieved_conversation")));

// Legacy: a project that predates anchoring, backfilled from agent text only.
const legacyAnchors: Anchor[] = [];
const legacyMessages: Row[] = [
  { id: "legacy-offer", projectId: "proj-legacy", runId: "run-legacy", role: "agent", body: [OFFER], createdAt: at(200) },
  { id: "legacy-user", projectId: "proj-legacy", runId: "run-legacy", role: "user", body: ["Option A (do nothing) or Option B (delete everything)."], createdAt: at(199) },
];
for (const row of legacyMessages) {
  for (const draft of extractAnchors(row)) {
    legacyAnchors.push({ ...draft, id: `legacy-${legacyAnchors.length}`, projectId: row.projectId, runId: row.runId, sourceMessageId: row.id, createdAt: row.createdAt });
  }
}
const legacy = await resolveContinuity(
  { projectId: "proj-legacy", runId: null, text: "option B", now: NOW },
  {
    listAnchors: async (_p: string, query: { normalizedLabel: string | null; alias: string | null }) =>
      legacyAnchors
        .filter((anchor) => (query.normalizedLabel ? anchor.normalizedLabel === query.normalizedLabel : true))
        .map((anchor) => ({ ...anchor, runTitle: null })),
    searchMessages: async () => [],
  },
);
check("a pre-anchor conversation is recoverable by backfill", legacy.status === "resolved");
check("the backfilled option keeps the agent's wording", legacy.references[0]?.summary.includes("queued sender") === true);
check("the backfill refused the user-authored option list", legacyAnchors.every((anchor) => anchor.sourceMessageId === "legacy-offer"));

// Cross-project isolation.
let leaked = false;
try {
  await resolveContinuity({ projectId: OTHER_PROJECT, runId: null, text: "option B", now: NOW }, storeFor(PROJECT));
  leaked = true;
} catch {
  leaked = false;
}
check("a mismatched project id cannot read another project's history", !leaked);

// No secret material can ride along in provenance.
const SECRET = /(password|api[_ -]?key|ssh-rsa|BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+\S{12,})/i;
check(
  "no credential-shaped text appears in any resolved provenance",
  [recalled, alias, ambiguous, legacy].every((result) => result.references.every((r) => !SECRET.test(`${r.label} ${r.summary}`))),
);

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} continuity E2E check(s) failed.`);
  process.exit(1);
}
console.log("All continuity E2E checks passed.");
