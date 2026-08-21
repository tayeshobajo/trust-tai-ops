# Fix the agent's broken fix-plan loop and its honesty about SEO work

The transcript shows three separate failures. Two are bugs with a confirmed root cause; one is a capability gap the agent should be honest about instead of papering over.

## 1. The stored plan is silently thrown away (confirmed root cause)

When the agent finishes diagnosis it asks the reasoner for a fix plan, shows it in chat, and then saves it so the execution step can pick it up. The save is rejected by the database: the artifact table only accepts five kinds of record (`backup_note`, `scan_result`, `diff_summary`, `qa_capture`, `report`), and the plan is saved as `fix_plan`. The write fails, the failure is swallowed, and moments later execution says "I couldn't find a stored fix plan for this run."

Fix:
- Allow `fix_plan` and `execution_failed` as artifact kinds in the database.
- Stop swallowing the save failure. If the plan cannot be stored, the agent must not show a plan card promising a fix it cannot run — it says the plan could not be saved and stays in diagnosis.
- The plan is currently truncated to 2000 characters before saving, which can corrupt it into unreadable text. Store the plan whole (with a much larger ceiling) and treat unreadable stored plans the same as a missing one, with a clear message.

## 2. The agent offered a "fix" that was explicitly not a fix

The plan card read "Here's what I can do to fix this" while its own reasoning said no changes were warranted, and the listed steps were checks (verify sitemap, confirm pages indexed, confirm indexing settings), not changes. Then it announced "I'm applying the fix now."

Fix:
- Only show a fix-plan card when the plan actually contains changes the agent can make. A plan whose reasoning concludes no changes are warranted becomes a findings summary, not a fix offer.
- Never say "I've identified the likely cause / I'm applying the fix now" unless there are approved, executable steps. Those lines are currently emitted regardless of whether a runnable plan exists.
- The progress track showed "Resolving — waiting on you" after the run had already dead-ended. When planning fails, the run returns to the investigation phase with the reason stated, rather than sitting in a resolving state nobody can advance.

## 3. Repetitive filler and unearned confidence

Early in the thread the agent posted several boilerplate lines back to back ("This run begins as a read-only verification pass…", "No execution plan yet…", "Applying the smallest safe fix path…"). These are canned strings that fire independently of what is happening.

Fix:
- Suppress the canned run-scaffolding lines when the agent is already speaking in its own voice in the same turn, so the thread carries one explanation instead of three.
- Drop the "Applying the smallest safe fix path" tone line unless a fix is genuinely being applied.

## 4. Be honest about what this task actually needed

The brief asked for Search Console indexing checks, Semrush prompt/competitor settings review, live prompt testing across ChatGPT/Gemini, schema and internal-linking review, local/entity signals, and a 30–60 day monitoring plan. The agent has none of those abilities — it can reach WordPress, SFTP and the public site. Instead of saying so, it reported "site is healthy" and guessed that the score was a reporting lag.

Fix, using only what the agent can genuinely do today:
- Add a scope statement to briefs of this type: list which action items it can verify itself (published/indexable state of pages, robots and sitemap availability, meta and schema markup present in the served HTML, page structure, internal links, caching), and which need access it does not have (Search Console, Semrush, AI platform prompt testing).
- For the checks it can do, actually do them against the live pages and report findings with evidence, rather than concluding from plugin counts and response time.
- Close the run with a written findings-and-gaps summary plus recommendations, which is what the brief's expected outcome asked for — not a fix attempt.

## Technical notes

- Migration: extend `run_artifacts.artifact_type` check to include `fix_plan` and `execution_failed`.
- `src/agentExecutor.ts`: fix-plan block around lines 144–201 (await/handle the `addEvidence` failure, gate the card on executable steps, raise the JSON size cap); `executeFixPlan` around lines 379–405 (distinguish "no plan stored" from "plan unreadable", roll the run back to the investigating phase).
- `src/lib.ts` lines 381–386 and `src/data.ts` line 57: the canned scaffolding/tone strings.
- Scope statement and the read-only SEO checks live in the reasoner prompt and the read-only tool sequence, no new external integrations.

Out of scope for this pass: adding real Google Search Console or Semrush integrations to the agent. Say the word and that becomes its own build.
