/**
 * Executable validation for conversation continuity and long-term recall.
 *
 * Run with: npm run check:continuity
 *
 * No network call and no database: the parser, the intent detector and the
 * retrieval ranker are driven directly against a scripted project history, and
 * the browser-side mirror is held to the same answers as the server parser.
 */

const failures: string[] = [];
const check = (name: string, condition: boolean) => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
};

const { extractAnchors, normalizeLabel } = await import("../supabase/functions/_shared/continuity/anchors.ts");
const { referenceIntent } = await import("../supabase/functions/_shared/continuity/reference.ts");
const { resolveContinuity, whenLabel, RETRIEVAL_BUDGET, MAX_REFERENCES } = await import(
  "../supabase/functions/_shared/continuity/retrieval.ts"
);
const { retrievedPromptLines, SYSTEM_PROMPT } = await import("../supabase/functions/_shared/reasonPrompt.ts");
const { referenceIntent: clientIntent } = await import("../src/continuity.ts");

type AnchorRecord = Awaited<ReturnType<Parameters<typeof resolveContinuity>[1]["listAnchors"]>>[number];
type MessageRecord = Awaited<ReturnType<Parameters<typeof resolveContinuity>[1]["searchMessages"]>>[number];

const NOW = Date.parse("2026-03-20T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// 1. Anchor extraction
// ---------------------------------------------------------------------------

const offerText =
  "Which path do you want? Option A (configure LiteSpeed properly with form exclusions) " +
  "or Option B (leave LiteSpeed off, I clean up the asset bloat)?";

const offer = extractAnchors({
  id: "m-offer",
  runId: "run-cache",
  role: "agent",
  body: [offerText],
  createdAt: daysAgo(40),
});

const optionA = offer.find((draft) => draft.label === "Option A");
const optionB = offer.find((draft) => draft.label === "Option B");

check("an offered choice produces one anchor per option", offer.filter((d) => d.anchorType === "option").length === 2);
check("the option set itself is anchored", offer.some((draft) => draft.anchorType === "option_set"));
check("Option A keeps its own wording", (optionA?.summary ?? "").toLowerCase().includes("form exclusions"));
check("Option B keeps its own wording", (optionB?.summary ?? "").toLowerCase().includes("asset bloat"));
check("Option B does not absorb Option A", !(optionB?.summary ?? "").toLowerCase().includes("form exclusions"));
check("parenthetical shells are unwrapped", !(optionB?.summary ?? "").startsWith("("));
check("trailing conjunctions are dropped", !/\bor$/i.test(optionA?.summary ?? ""));
check("everyday phrasing is aliased", (optionB?.aliases ?? []).includes("the second one"));
check("labels normalize predictably", normalizeLabel("Option B") === "option b");

check(
  "a single mention is not a choice",
  extractAnchors({ id: "m", runId: null, role: "agent", body: ["Option A is fine."], createdAt: daysAgo(1) }).length === 0,
);
check(
  "prose without labels mints nothing",
  extractAnchors({
    id: "m",
    runId: null,
    role: "agent",
    body: ["I could tune caching or clean up assets."],
    createdAt: daysAgo(1),
  }).length === 0,
);
check(
  "a person cannot mint an anchor",
  extractAnchors({ id: "m", runId: null, role: "user", body: [offerText], createdAt: daysAgo(1) }).length === 0,
);
check(
  "bracketed lists are recognised",
  extractAnchors({
    id: "m",
    runId: null,
    role: "agent",
    body: ["A) roll back the plugin update", "B) patch the theme template"],
    createdAt: daysAgo(2),
  }).filter((draft) => draft.anchorType === "option").length === 2,
);

// ---------------------------------------------------------------------------
// 2. Backward-reference detection
// ---------------------------------------------------------------------------

const pointers = [
  "option B",
  "let's do option B",
  "do the second one",
  "go with that approach",
  "use the safer approach we discussed yesterday",
  "same as yesterday",
  "what did we decide about the caching?",
  "continue where we left off",
  "as we discussed",
];
for (const text of pointers) check(`pointer detected: "${text}"`, referenceIntent(text).needsRecall);

const selfContained = [
  "Check the homepage performance",
  "The contact form stopped sending emails this morning",
  "Can you update the WooCommerce plugin to the latest version?",
  "",
];
for (const text of selfContained) check(`self-contained left alone: "${text}"`, !referenceIntent(text).needsRecall);

check("an explicit label is carried", referenceIntent("let's do option B").label === "Option B");
check("an ordinal is carried", referenceIntent("do the second one").ordinal === 1);
check("temporal wording is carried", referenceIntent("same as yesterday").temporal === "yesterday");
check("pointer words are not searched for", !referenceIntent("same as yesterday").terms.includes("yesterday"));

check(
  "the browser mirror agrees with the server on every fixture",
  [...pointers, ...selfContained, "Option A please", "the third option"].every(
    (text) =>
      clientIntent(text).needsRecall === referenceIntent(text).needsRecall &&
      clientIntent(text).label === referenceIntent(text).label &&
      clientIntent(text).ordinal === referenceIntent(text).ordinal,
  ),
);

// ---------------------------------------------------------------------------
// 3. Retrieval against a scripted project history
// ---------------------------------------------------------------------------

const anchorRow = (
  id: string,
  label: string,
  summary: string,
  createdAt: string,
  runId: string | null,
  runTitle: string | null,
  ordinal: number,
): AnchorRecord => ({
  id,
  runId,
  sourceMessageId: `msg-${id}`,
  anchorType: "option",
  label,
  normalizedLabel: normalizeLabel(label),
  aliases: [normalizeLabel(label), ["first", "second", "third"][ordinal] + " option"],
  summary,
  createdAt,
  runTitle,
});

const CACHE_B = anchorRow(
  "a-cache-b",
  "Option B",
  "Leave LiteSpeed off and clean up the asset bloat.",
  daysAgo(40),
  "run-cache",
  "Site speed on the homepage",
  1,
);
const CACHE_A = anchorRow(
  "a-cache-a",
  "Option A",
  "Configure LiteSpeed properly with form exclusions.",
  daysAgo(40),
  "run-cache",
  "Site speed on the homepage",
  0,
);
const CHECKOUT_B = anchorRow(
  "a-checkout-b",
  "Option B",
  "Rebuild the checkout template from the parent theme.",
  daysAgo(3),
  "run-checkout",
  "Checkout errors",
  1,
);

const HISTORY: MessageRecord[] = [
  {
    id: "msg-safer",
    runId: "run-cache",
    role: "agent",
    text: "The safer approach is to leave the cache plugin off and fix the images first.",
    createdAt: daysAgo(1.2),
    runTitle: "Site speed on the homepage",
  },
  {
    id: "msg-old-cache",
    runId: "run-cache",
    role: "agent",
    text: "Caching is currently doing more harm than good on the checkout pages.",
    createdAt: daysAgo(60),
    runTitle: "Site speed on the homepage",
  },
];

const storeFor = (anchors: AnchorRecord[], messages: MessageRecord[] = HISTORY) => ({
  listAnchors: async () => anchors,
  searchMessages: async (_projectId: string, terms: string[], limit: number) =>
    messages.filter((message) => terms.some((term) => message.text.toLowerCase().includes(term))).slice(0, limit),
});

const resolve = (text: string, anchors: AnchorRecord[], runId: string | null = null, messages = HISTORY) =>
  resolveContinuity({ projectId: "p1", runId, text, now: NOW }, storeFor(anchors, messages));

const optionBMonthsLater = await resolve("let's do option B", [CACHE_A, CACHE_B]);
check("a months-old Option B still resolves", optionBMonthsLater.status === "resolved");
check(
  "it resolves to the option that was actually offered",
  optionBMonthsLater.references[0]?.summary.includes("asset bloat") === true,
);
check("an exact label match is recorded as such", optionBMonthsLater.references[0]?.method === "anchor_exact");
check("provenance points at the source message", optionBMonthsLater.references[0]?.sourceMessageId === "msg-a-cache-b");

const ordinal = await resolve("do the second one", [CACHE_A, CACHE_B]);
check("an ordinal resolves through aliases", ordinal.status === "resolved" && ordinal.references[0]?.label === "Option B");
check("alias matching is recorded honestly", ordinal.references[0]?.method === "anchor_alias");

const vague = await resolve("use the safer approach we discussed yesterday", [CACHE_A, CACHE_B]);
check("a vague temporal pointer still lands", vague.status === "resolved");
check("it lands on yesterday's message, not the old one", vague.references[0]?.sourceMessageId === "msg-safer");

const ambiguous = await resolve("go with option B", [CACHE_B, CHECKOUT_B]);
check("two different Option Bs are never guessed between", ambiguous.status === "ambiguous");
check("the ambiguity is turned into one question", (ambiguous.question ?? "").includes("Which one do you mean?"));
check("each candidate is named with its context", (ambiguous.question ?? "").includes("Site speed on the homepage"));
check("each candidate is placed in time", (ambiguous.question ?? "").includes("last month"));
check("an ambiguous turn records no provenance", ambiguous.references.every((r) => r.confidence < 0.5));

const repeated = await resolve("go with option B", [
  CACHE_B,
  { ...CACHE_B, id: "a-cache-b2", sourceMessageId: "msg-repeat", createdAt: daysAgo(38) },
]);
check("the same offer repeated is not an ambiguity", repeated.status === "resolved");

const missing = await resolve("let's do option B", [CACHE_A]);
check("an option that was never offered is not invented", missing.status === "not_found");
check("the refusal asks instead of assuming", (missing.question ?? "").toLowerCase().includes("option b"));

const nothing = await resolve("continue where we left off", [], null, []);
check("an unresolvable pointer asks a question", nothing.status === "not_found" && nothing.question !== null);

const notNeeded = await resolve("Check the homepage performance", [CACHE_A, CACHE_B]);
check("a self-contained request skips retrieval entirely", notNeeded.status === "not_needed");
check("and costs no context", notNeeded.charCount === 0 && notNeeded.references.length === 0);

// ---------------------------------------------------------------------------
// 4. Budget, isolation and prompt labelling
// ---------------------------------------------------------------------------

const many: MessageRecord[] = Array.from({ length: 40 }, (_, index) => ({
  id: `bulk-${index}`,
  runId: "run-cache",
  role: "agent",
  text: `The safer approach involves ${"caching ".repeat(60)}`,
  createdAt: daysAgo(2 + index / 24),
  runTitle: "Site speed on the homepage",
}));
const bulk = await resolve("use the safer approach we discussed", [], null, many);
check("recall is capped in count", bulk.references.length <= MAX_REFERENCES);
check("recall is capped in characters", bulk.charCount <= RETRIEVAL_BUDGET);

let sawProject: string | null = null;
await resolveContinuity(
  { projectId: "project-under-test", runId: null, text: "let's do option B", now: NOW },
  {
    listAnchors: async (projectId) => {
      sawProject = projectId;
      return [];
    },
    searchMessages: async (projectId) => {
      sawProject = projectId;
      return [];
    },
  },
);
check("every read is scoped to the authorized project", sawProject === "project-under-test");

check("time is described in plain English", whenLabel(daysAgo(1.2), NOW) === "yesterday");
check("older moments are placed, not timestamped", whenLabel(daysAgo(40), NOW) === "last month");

const promptLines = retrievedPromptLines([
  { label: "Option B", text: "Leave LiteSpeed off and clean up the asset bloat.", when: "last month" },
]);
check("recall enters the prompt under its own label", promptLines.some((line) => line.includes("retrieved_conversation")));
check("recall is not disguised as an observation", !promptLines.some((line) => line.includes("tool_observation")));
check("the model is told what a retrieved memory proves", SYSTEM_PROMPT.includes("retrieved_conversation"));
check("the model is told to ask when recall is missing", SYSTEM_PROMPT.includes("do not guess what they meant"));

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} continuity check(s) failed.`);
  process.exit(1);
}
console.log("All continuity checks passed.");