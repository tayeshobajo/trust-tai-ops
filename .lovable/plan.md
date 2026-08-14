# Make the agent talk like a person

Right now every sentence the agent says is written by hand-coded templates (`src/reply.ts`, the narration lines in `src/agent.ts`, and the fixed strings in the orchestrator). That is why it repeats itself, sounds robotic, and answers "can you access my wp-admin?" with a status line instead of a direct answer. The model is only used to *pick which check to run* — never to speak.

This change moves the voice to the model, keeps the facts locked down, and makes replies appear word by word.

## 1. The model writes every reply, from a facts sheet only

Add a second mode to the existing reasoning function: alongside "decide the next check", it can now "say the next thing".

It is given a compact, server-built facts sheet — what access is stored, what has actually been verified, what tools observed this run, what the person just asked, and the recent conversation — and it writes the reply in the agent's voice: calm senior engineer, plain English, direct answer first.

Facts stay gated exactly as they are today:
- It may only speak from the supplied facts sheet. No fact in the sheet, no claim in the reply.
- Verified vs stored-but-unverified access stay separate labels, so "yes I can get in" can only be said when a read-only check actually passed.
- No internal state names, no tool ids, no credentials.
- Any decision about *what to do next* still comes from the existing closed step catalog. The model only chooses words.

If the model is unreachable, the current templated sentences remain as a silent last-resort fallback.

## 2. Direct answers to direct questions

The facts sheet explicitly marks the person's latest message as a question when it is one, and the reply contract requires the first line to answer it. "Can you access my wp-admin?" gets "Yes — I signed in and read the plugin list a minute ago" or "Not yet — the password you gave was rejected", never a progress update.

## 3. No more repeated lines

The last few things the agent said are included in the facts sheet with an explicit instruction not to restate them. On top of that, the existing verbatim-repetition suppression is widened to near-duplicates, so a reworded version of the same sentence within the same task is dropped rather than shown.

## 4. Live streaming replies

The reply mode streams. The workspace renders the text as it arrives, in place of the typing dots, then persists the finished message once. Interrupted streams fall back to the typing indicator and the completed message, so nothing is ever half-saved.

## Technical notes

- `supabase/functions/agent-reason/index.ts`: new `compose_reply` mode. Same auth gate, same project authorization, same provider routing (Anthropic / Lovable gateway). Streaming response (SSE) rather than buffered JSON; no client-side timeout on the call.
- `supabase/functions/_shared/reasonPrompt.ts`: new `replySystemPrompt` + `replyFactsPrompt` builders, reusing the existing redaction and credential-scrubbing helpers. Provenance labels (`tool_observation`, `user_claim`, `verified_access`, `stored_access`) carry over unchanged.
- `src/agent-core/reasoner.ts` / `orchestrator.ts`: the spoken lines for a turn come from the compose call; step selection is untouched.
- `src/reply.ts`: kept, demoted to offline fallback.
- `src/ProjectWorkspace.tsx`: streaming consumer plus near-duplicate suppression; persistence still runs once on completion with the existing dedupe key.
- Checks: extend `scripts/reasoner-checks.ts` to assert the reply mode cannot emit a claim absent from the facts sheet and cannot leak credentials.
