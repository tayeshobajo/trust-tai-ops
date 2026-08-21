# Chat experience audit: why it feels messy, and what to clean up

I read the workspace chat path end to end (`src/ProjectWorkspace.tsx`, `src/conversation.ts`, `src/home.ts`, `src/lib.ts`, `src/agent.ts`, `src/repository.ts`). Everything you saw in the screenshot is explainable. There are five real defects, and they compound.

## What's actually wrong

**1. Every message becomes a task.**
Sending free text with no live task creates a run immediately, and the task title is just the first line of what you typed. That's why the rail shows tasks called "Hey," and "Url: http://elevateortho.com/". A greeting, a question, or a pasted URL should be a conversation, not a work item. A task should only exist when there is real work to do — and it should get a written title, not your first line.

**2. "Resolving" appears without a plan, because the run walks itself forward.**
Two separate things map to the same public phase: `plan` (thinking about a fix) and `execution` (making the fix) both display as **Resolving**, and the header prints "Applying fix". On top of that, approval is only demanded for `high_risk` runs; an audit/QA brief is classified `safe`, so nothing blocks it and the run auto-advances straight into execution. Result: the UI announces a fix is being applied when no plan was ever produced or approved — which is exactly what you saw, followed by "I couldn't find a stored fix plan for this run."

**3. Half the transcript is generated, not spoken.**
`buildThread` fabricates a scripted conversation out of run state — a fake "user brief" message, a canned "Got it, I'll take a look…" acknowledgement, an access line, a work log, a plan block — and those are rendered alongside the agent's real persisted messages. That's the duplication in your screenshot: the same "I've put that down as a separate task" appearing twice, once real and once synthesized, with different timestamps.

**4. Your real task got queued behind a dead one.**
The active task is simply the first run that isn't `complete`. The "Hey," run had dead-ended (no plan, nothing to execute) but was never closed, so it still counted as live — and your genuine SEO brief was pushed to "Up next". A run that can't proceed must close itself or ask you something; it must not hold the queue.

**5. Three surfaces disagree about the same moment.**
Header chip ("Applying fix"), phase strip ("Resolving · waiting on you"), right rail ("No execution plan yet…"), and the chat body each derive state independently, and some of it is placeholder copy. They contradict each other in one screenful.

## The clean-up

**Talk first, tasks only when earned**
- Plain messages, greetings, questions and single URLs get a reply in the thread. No run is created.
- A run is created when the message describes work, or when you press New Task. The agent writes a short human title ("SEO visibility audit — elevateortho.com") instead of echoing line one.
- Ambiguous case: the agent asks once, "Want me to open this as a task?" with two buttons.

**Honest phases**
- Split the public phase: `plan` reads as **Planning** ("working out the safest fix"), `execution` as **Resolving** ("applying the fix"). The header chip follows the same source.
- Never enter execution without a stored, executable plan. Read-only work (audits, QA, verification) skips planning/resolving entirely and goes Investigating → Checking → Completed, so it never claims to be fixing anything.
- Any change to the site — not just high-risk — pauses for a visible go-ahead in chat.

**One voice, one transcript**
- Retire the synthesized transcript. The thread shows only messages that were really said, plus explicit state cards (approval, backup, saved access, findings, work log) rendered once, keyed so they can't double up.
- Drop the canned acknowledgement and the placeholder "No execution plan yet" lines; the right rail reads from the same signal the header and strip use, or shows nothing.

**A task that can't proceed doesn't block**
- When planning fails or a run dead-ends, it goes back to investigating with the reason stated, or asks you a question — and if it's waiting on you, it stops counting as the live task so the queue moves on.
- Queue triage tightens: a bare URL or a short aside stays in the thread; only a real brief queues, and the agent says so once.

**One clear "now"**
- Header, phase strip, rail and the active-task card all render from a single derived signal, so they can never contradict each other.

## Technical notes

- `src/home.ts` — split `plan`/`execution` signals; add a read-only track that skips Resolving; make `signalForRun` the single source for header, strip and rail.
- `src/conversation.ts` — remove the fabricated brief/ack/plan/work-log messages from `buildThread`; keep card construction only. Tighten `looksLikeNewTaskBrief` (bare URLs and short pastes are not briefs) and replace `titleFromBrief` with a written title.
- `src/ProjectWorkspace.tsx` — send path: reply-without-run for conversational messages, confirm-to-open for ambiguous ones; header chip from the shared signal; deduplicate rendered state cards.
- `src/lib.ts` / `src/agent.ts` — `getActiveRun` skips runs parked awaiting a human; `autoAdvanceTarget` refuses `plan → execution` without a stored executable plan and requires approval for any write, not only high-risk.
- `src/agentExecutor.ts` — on planning failure, return the run to investigating with a stated reason instead of leaving it in a resolving state.

No schema changes, no changes to credential handling, evidence, or edge functions.
