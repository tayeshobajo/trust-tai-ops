# Trust Tai Ops — Post-Import Audit

Read-only review of the imported codebase. No files were changed.

## 1. Stack: confirmed, and it builds

- Plain **Vite 7 + React 18 + TypeScript 5** SPA. No Tailwind, no shadcn, no router library — navigation is `useState` tab/view switching in `src/App.tsx`.
- Data layer: `@supabase/supabase-js` with a `demo` / `supabase` adapter switch in `src/repository.ts`, env resolved in `src/env.ts` (`VITE_OPS_*` variables).
- Styling: one 2.3k-line `src/index.css` holding all brand tokens (`--tt-ink`, `--tt-paper`, `--tt-royal`, `--tt-space-*`) and every component style.
- `npm run build` (`tsc -b && vite build`) passes locally; the app renders in the dev server on desktop, tablet, and mobile.

## 2. Why the preview shows the old scaffold / "preview not built"

Confirmed cause: **`package.json` has no `build:dev` script.** The Lovable build pipeline runs `build:dev`, which errors with `Script not found "build:dev"`, so no new preview bundle is produced and the previously built scaffold output stays live. Contributing factors found in the repo:

- A committed `dist/` folder from an earlier build is present and can be mistaken for current output.
- Both `vite.config.ts` and a compiled `vite.config.js` (+ `vite.config.d.ts`) exist. Vite resolves `vite.config.js` first, so edits to the `.ts` config would silently not apply.
- The Vite config sets no dev server host/port and no path alias, so it relies entirely on platform defaults.

Fix (one line plus cleanup): add `"build:dev": "vite build --mode development"` to scripts, delete the stale `vite.config.js` / `vite.config.d.ts`, and stop tracking `dist/`.

## 3. Where the UI still reflects the old command-center concept

The domain model is fine; the **surface** is the problem. Concretely:

- **Workspace is tab-first, not project-first.** Five tabs (Overview, Active Run, QA Proof, Recommendations, Memory) are the primary navigation, defaulting to `active_run`. There is no WhatsApp/Telegram-style project list as the home surface — projects are a sidebar section inside a dense rail.
- **The chat is decorative.** In `App.tsx` the thread is built from `conversationMoments`, a derived array of run fields, and the composer is `<input value="" readOnly placeholder="Message the agent..." />` with non-functional Attach / Upload / Terminal labels. Nothing sends a message; there is no AI call anywhere in `src/` (no `fetch`, no edge function invoke).
- **Guardrails are manually operated.** `src/OperationsPanel.tsx` (864 lines) exposes state advancement, approvals, QA verdicts, rollback, evidence attachment, and recommendation status as operator buttons — exactly the machinery that should sit under the hood and be requested by the agent in conversation.
- **Run state is user-visible furniture.** Phase ladders, progress percentages, risk pills, backup posture, and a "Guided intake" form with task type / urgency / environment / access / backup checkboxes front-load run-contract vocabulary before the user has said what they want.
- **Project creation is a multi-step console**, not the simple "name + URL + access" capture the target product describes.

## 4. Smallest frontend realignment (no backend or domain-model rewrite)

Keep `types.ts`, `data.ts`, `lib.ts`, `operations.ts`, `repository.ts`, `seed.ts`, and `db/` untouched. Change only presentation and the layer that calls into them:

1. **Make the project list the home surface.** Full-width list of project rows (avatar/initials, name, last activity line, unread/attention dot) styled with existing tokens. Selecting a project opens the project view; the dark rail becomes secondary or collapses into the existing mobile drawer.
2. **Make the project view chat-first.** One scrolling conversation plus a real composer with local state and send handling. Render existing run findings, actions, artifacts, and QA results as message-shaped cards in the same thread instead of separate panels.
3. **Reduce `OperationsPanel` to inline chat affordances.** Keep the guardrail functions; surface them only as contextual prompts inside the conversation ("Confirm backup before I continue" → Confirm / Not yet), each calling the same existing `advanceRunState` / approval helpers.
4. **Collapse the tabs into a lightweight project header/drawer.** Overview, QA, and Memory become secondary panels reachable from the project header, not the primary navigation.
5. **Simplify project creation** to name + site URL + access toggles, deriving the remaining `ProjectDraft` fields with existing defaults.
6. **Simplify run intake** to a first chat message; map it onto the existing `RunDraft` behind the scenes with default urgency and environment.

This is a re-composition of `App.tsx` and `OperationsPanel.tsx` plus additive CSS in `index.css` — all brand tokens, fonts, radii, and spacing scale preserved.

## 5. Do not touch yet

- **The domain model and state machine.** `operations.ts` guardrails, `types.ts`, and the QA/approval contracts are the product's value; hide them, don't delete them.
- **`repository.ts` and the Supabase adapter, `db/schema.sql`, `db/rls.sql`.** No live auth/RLS-safe write path is proven yet; a UI rewrite should not also change persistence.
- **Auth screen and role gating.** Run creation is currently blocked below `operator` role — leave that rule in place.
- **Real AI wiring.** Connecting the chat to a model requires a backend function and keys; treat it as a separate, later step. Ship the chat shell against existing run data first.
- **The design system.** No Tailwind, shadcn, or router migration; no new fonts or colors.
- **The responsive layer just added** (mobile drawer, container queries) — reuse it rather than re-solving it.

## Suggested order

1. Fix the build script and config duplication so the preview reflects the repo.
2. Project list home + chat-first project view.
3. Fold operations controls into in-chat prompts.
4. Simplify project creation and run intake.
