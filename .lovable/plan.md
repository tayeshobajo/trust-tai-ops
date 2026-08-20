# Chat presentation pass: alive, and clearly two voices

Bring the workspace chat to the reference: every turn is visibly owned by a speaker, agent work reads as a living panel, and the composer invites the four things people actually paste.

## What changes

**Speaker identity (the main fix)**
- Agent turns: round blue-tinted mark, name "Engineering Agent", a small `AI` chip, and the time. Body sits on a near-white panel with a thin royal accent bar down the left edge, full working width.
- Your turns: dark ink avatar with your initial, "You" plus time. No coloured bubble — content sits on paper so pasted cards and screenshots read cleanly.
- Grouped follow-on lines keep the accent bar and indentation but drop the repeated name, so a multi-part agent answer reads as one turn.

**Aliveness**
- While the agent works, the accent bar on its current turn breathes and the header state chip pulses — motion only while something is actually running.
- The header carries a plain-English attention chip ("Waiting for you") when a decision is pending.
- A compact phase strip (Understanding · Investigating · Resolving · Checking · Completed) sits at the foot of the agent's active turn, with the live phase marked.
- Nested observation cards ("What I'm seeing") get a light inset panel inside the agent turn instead of plain list text.
- Attached screenshots render as a thumbnail beside the agent's text rather than stacked below it.

**Credential and evidence cards**
- The saved-access card gains a platform mark, label/value rows, and a green "Saved securely" confirmation chip. Values stay masked; nothing about secret handling changes.

**Composer**
- A row of quick actions under the input: Attach, Credentials, Screenshot, Commands.
- Send becomes a dark pill with icon and label.
- A single quiet tip line beneath: "Paste credentials, URLs, or screenshots — I'll understand."

**Rails**
- Left: active task card keeps the royal left edge and reads with its plain-English waiting line.
- Right: section headings tighten into eyebrow labels with rules between blocks, and the phase checklist uses filled/ring/hollow dots for done, current, and upcoming.

## Scope

Presentation only. No changes to agent logic, run states, credential handling, persistence, or Supabase.

- `src/ProjectWorkspace.tsx` — message row structure, speaker headers, phase strip, composer quick actions, header attention chip.
- `src/index.css` — accent bars, avatars, panels, chips, motion, rail refinements.

Checked at 375px, 768px, 1440px; motion respects reduced-motion.
