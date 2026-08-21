# One task at a time, with a visible queue

Right now the workspace has no rule about how many tasks can be live. Anything you type while a task is open gets folded into that task's thread, and separate tasks (the access confirmation task, the SEO brief) end up narrated together — which is what produced the mixed, contradictory transcript you pasted.

This pass makes the workspace behave like Lovable: exactly one task runs at a time, anything else you send waits in a queue you can see and reorder.

## What you'll experience

**New brief while a task is running**
When you send a message that reads as a new piece of work (or you press "New task" and then send), the agent doesn't derail the current task. It replies once, plainly: "I've queued this — I'll start it as soon as the current task is done," and the item appears in the left rail.

If the message is really a follow-up to the current task (an answer, a correction, credentials, a screenshot), it stays in the current thread exactly as it does today. When it's genuinely ambiguous, the agent asks once: "Is this part of the current task, or a new one?" with two buttons.

**Queue in the left rail**
Below "In progress" a new section: **Queued · N**, listing each waiting task with its title and a one-line summary. Per item: **Start now** (pauses the running task and promotes this one), **Move up / down**, **Remove**. Clicking a queued item opens its brief read-only — the agent does not work on it.

**Automatic hand-off**
When the active task reaches Completed, is marked done manually, or is paused, the top queued item starts by itself and the agent opens it in the conversation: "Starting the next task: <title>."

**Header**
The chat header shows the active task and, when there are waiting items, a quiet "2 queued" chip that scrolls the rail to the queue.

## Why the transcript went wrong, and what else this fixes

- Two open tasks (access confirmation + the SEO brief) were both live, so the agent alternated between them. With a single active task, that can't happen.
- The auto-step loop will be hard-gated to the one active, non-queued task, so no background task can speak.
- The Captain plan that said "NO TASK DEFINED" was planning against the access task, not your SEO brief. Captain will only ever plan against the active task's own brief.

## Technical outline

- **Data**: add nullable `queue_position integer` to `public.runs` (migration in `db/migrations/`, service-role grants unchanged). A run is queued when `queue_position is not null`; it stays in `intake` and is invisible to the state machine. No new `RunState`, so `operations.ts`, phases and copy are untouched.
- **`src/lib.ts`**: `getActiveRun` ignores queued runs. Add `getQueuedRuns(project)` sorted by position.
- **`src/repository.ts`**: `createRun` gains an optional `{ queued: true }`; add `promoteQueuedRun`, `reorderQueue`, `removeQueuedRun`. Local and Supabase implementations both. Creating a run while a non-complete run exists defaults to queued.
- **`src/conversation.ts`**: `newTaskIntent(text, activeRun)` — heuristic classifier (explicit "new task", a long brief with its own URL/objective, versus short replies, credential pastes, attachments-only). Returns `follow_up | new_task | ambiguous`.
- **`src/ProjectWorkspace.tsx`**: send path routes by that classification; auto-step effect and `triggerCaptainPlan` gated on the active non-queued run; queue section, controls, header chip, and the completion hand-off effect.
- **`src/index.css`**: queue rows reuse the existing task-row tokens with a quieter treatment; no new design language.

No change to agent reasoning, credential handling, evidence, or edge functions.
