# UI Presentation Cleanup — Trust Tai Ops

Presentation-only pass. No changes to agent logic, safety gates, SSH/WP-CLI boundary, persistence, repository, or domain state. Only `src/index.css` and the markup/class structure of existing view components.

## A. What is visually wrong today (ranked)

1. **The wide-desktop dead zone is a real CSS rule, not a perception.** `.home-shell` is `96px | minmax(320px,400px) | 1fr` and `.preview-panel` / `.preview-empty` are capped at `max-width: 720px` with no centering. At 1440px+ everything past ~816px of width is empty cream. At ultrawide it is severe. The preview reads as a card floating in a void.
2. **No global shell contract.** Each surface invents its own frame: home is a 3-column full-bleed grid, workspace `.pw-shell` is `320 | 1fr | 300` at `height:100vh`, Access/Memory/Activity are single-column `100vh` scroll panels with their own paddings and their own header shapes. Moving between screens feels like moving between apps.
3. **Card-in-card.** The preview panel is a bordered, radius-xl, shadow-md card that itself contains three bordered `.preview-card`s plus a bordered phase track. Same pattern in Access and the workspace rail. Too many rectangles competing for the same attention.
4. **Geometry is unsystematic.** Four radii in use (8/12/16/24) applied by taste, two shadow levels applied inconsistently, and nearly every separation is a 1px `--tt-rule` border instead of a mix of rules, paper layers, and whitespace.
5. **Typography hierarchy is ad hoc.** Display sizes are hardcoded per component (`32px`, `1.9rem`, `1.4rem`); eyebrows, metadata and status labels share weight and color, so the eye has no clear first/second/third read.
6. **Status and progress read as chrome, not signal.** Chips, dots, the 5-step phase track and the progress bar all carry borders and fills, so a calm project looks as busy as one that needs you.
7. **Inbox and preview feel disconnected** — different padding rhythm, different vertical rhythm, a hard border between the columns instead of a shared baseline.
8. **Responsive rules are scattered** across ~10 breakpoints (1180, 1040, 900, 860, 720, 640) with different intents per surface.

## B. The cleanup system

**Layout contract (new, used everywhere)**
- Tokens: `--tt-rail: 88px`, `--tt-inbox: 380px`, `--tt-measure: 720px` (reading), `--tt-workspace-max: 1180px` (single-column surfaces), `--tt-shell-max: 1760px`.
- Home: rail | inbox | preview, where the preview column becomes a real *workspace* — content centered at `--tt-workspace-max` with real internal breathing, so wide screens get a composed field instead of a left-hugging card. Above `--tt-shell-max` the whole shell centers.
- At >=1680 the preview gains a two-column interior (status + progress left; needs-you, activity, memory stacked right) so the space is used, not padded.
- Single-column surfaces (Create, Empty state, Access, Memory, Activity) all adopt one `.tt-page` wrapper: centered, `--tt-workspace-max`, one shared header block.

**Header and rhythm**
- One `.tt-page-head` pattern: back link row, eyebrow, title, sub/meta, optional actions — separated from content by a hairline rule with a fixed `--tt-space-8` below.
- Section rhythm: `--tt-space-10` between major sections, `--tt-space-5` inside them, `--tt-space-2` between a label and its value. No component-local one-offs.

**Type scale (tokens, applied by class)**
- Eyebrow: sans 11px, 0.14em tracking, muted, uppercase.
- Page title: display serif, clamp 30 to 40px. Section title: display serif 22px. Card/entry title: sans 15px 600.
- Body 15px/1.6, metadata 13px muted, mono 12px reserved for domains and paths.
- Buttons 14px 600, one height scale (36 / 44).

**Surface system (replaces cards-everywhere)**
- Three layers only: `paper` (page), `raised` (white, hairline, radius-lg, shadow-sm), `sunken` (`--tt-secondary` tint, no border).
- Rule: one raised layer maximum per region. Inside a raised region use rules, whitespace and sunken blocks — never a bordered card inside a bordered card.
- Radii collapse to two: `--tt-radius-md` (controls, chips, small blocks) and `--tt-radius-lg` (panels); `xl` retired. Borders always 1px hairline. `shadow-sm` for panels; `shadow-md` reserved for overlays and menus.

**Status and progress**
- Chips become quiet: no border, tinted sunken background, 11px uppercase, colored text only. A single `is-attention` state carries the royal-blue signal; everything else is ink or muted.
- Phase track becomes a hairline horizontal rule with small dots — completed filled ink, current royal with a soft halo, upcoming hairline. No boxes, no bars in the preview.

**List rows**
- Selected: paper-to-white lift plus a 2px royal left marker, no heavy border.
- Needs-you: royal dot only. Active: subtle pulse on the dot. Completed: muted status text.
- Consistent 3-line rhythm: name + timestamp / domain (mono) / status (muted).

**Responsive minimums**
- Consolidate to four breakpoints: `1680` (preview interior split on), `1280` (rail collapses to icons), `1024` (workspace right rail becomes a collapsible summary above the composer), `768` (single column, inbox/preview push navigation, existing drawer pattern kept).

## C. Files affected

- `src/index.css` — the bulk: token additions, shell/layout, page-head, type scale, surfaces, chips, rows, breakpoint consolidation.
- `src/ProjectsCommandCenter.tsx` — preview column composition, fewer nested cards, new phase track markup.
- `src/ProjectWorkspace.tsx` — column widths from tokens, de-boxed rail and message cards, composer framing.
- `src/ProjectEmptyState.tsx`, `src/ProjectAccessPanel.tsx`, `src/ProjectMemoryPanel.tsx`, `src/ProjectActivityPanel.tsx`, `src/CreateProjectPage.tsx` — adopt shared `.tt-page` / `.tt-page-head`, drop local paddings and headers.
- `src/AuthScreen.tsx` — token and geometry alignment only.
- `src/OperationsPanel.tsx` — chip and surface alignment only, no control changes.

No changes to `src/agent*.ts`, `src/agent-core/**`, `src/repository.ts`, `src/conversation.ts`, `src/messages.ts`, `supabase/**`, or `db/**`.

## D. Implementation sequence (safe, incremental)

1. **Tokens and primitives** — add layout/type/surface tokens and `.tt-page`, `.tt-page-head`, `.tt-surface`, `.tt-chip` utilities. Purely additive; nothing changes visually yet.
2. **Home shell** — fix the dead zone: shell max-width and centering, preview column workspace framing, remove the 720px cap, add the wide-width interior split.
3. **De-box the preview** — one raised layer, rules and sunken blocks inside, quiet phase track.
4. **Inbox rows and chips** — apply the new row and chip system across home and workspace.
5. **Single-column surfaces** — migrate Empty state, Access, Memory, Activity, Create to the shared page shell; delete their local header/padding rules.
6. **Project Workspace** — token-driven columns, de-boxed rail and messages, reframed composer, approval/access/verification/completion inline cards aligned to the surface system.
7. **Geometry sweep** — collapse radii to two, normalize borders and shadows, remove dead one-off rules.
8. **Breakpoint consolidation** — replace scattered media queries with the four-tier set.
9. **Verification** — Playwright screenshots of every surface and state (empty, waiting, approval, access stored vs verified, completion) at 1440 / 1680 / 1024 / 390, then `build`, `lint`, `check:agent`, `check:private`, `check:migrations`, `check:wpcli` to prove zero behavioral drift.

Each step is independently revertable and touches presentation only.