// Trust Tai Ops — meeting transcript ingestion.
//
// A transcript enters the product exactly once, here. It is normalized,
// redacted, hashed and stored against a project the caller has proven they
// belong to. Nothing is analysed and nothing is executed on this path.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import { MAX_TRANSCRIPT_BYTES, hashTranscript, prepareTranscript } from "../_shared/transcript.ts";

const fail = (code: string, summary: string, retryable: boolean) =>
  Response.json({ ok: false, code, summary, retryable }, { headers: corsHeaders });

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you signed in before I can take a transcript.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

const clean = (value: unknown, max: number, fallback = ""): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  return text || fallback;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("invalid_input", "Unsupported request.", false);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_input", "I couldn't read that upload.", false);
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return fail("invalid_input", "No project was named.", false);

  const raw = typeof body.text === "string" ? body.text : "";
  if (raw.trim().length < 40) {
    return fail("invalid_input", "That transcript looks empty — I need the meeting text itself.", false);
  }
  if (raw.length > MAX_TRANSCRIPT_BYTES) {
    return fail("transcript_too_large", "That transcript is larger than I can take in one go.", false);
  }

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before storing anything.", false);

  // Redaction happens before the first write. The raw text is never persisted.
  const { text, report } = prepareTranscript(raw);
  const contentHash = await hashTranscript(text);
  const service = serviceClient();

  // The same transcript pasted twice is the same source, not a second meeting.
  const existing = await service
    .from("project_sources")
    .select("id, title, occurred_at, processing_status, created_at")
    .eq("project_id", authz.project.projectId)
    .eq("content_hash", contentHash)
    .maybeSingle();

  if (existing.data) {
    return Response.json(
      {
        ok: true,
        duplicate: true,
        summary: "I already have this transcript on this project.",
        source: {
          id: String(existing.data.id),
          title: String(existing.data.title ?? ""),
          occurredAt: existing.data.occurred_at ?? null,
          processingStatus: String(existing.data.processing_status ?? "pending"),
        },
        redaction: report,
      },
      { headers: corsHeaders },
    );
  }

  const occurredAtRaw = typeof body.occurredAt === "string" ? Date.parse(body.occurredAt) : Number.NaN;
  const occurredAt = Number.isNaN(occurredAtRaw) ? new Date().toISOString() : new Date(occurredAtRaw).toISOString();

  const inserted = await service
    .from("project_sources")
    .insert({
      project_id: authz.project.projectId,
      source_type: "meeting_transcript",
      title: clean(body.title, 160, "Client meeting transcript"),
      occurred_at: occurredAt,
      uploaded_by: authz.caller.userId,
      original_filename: clean(body.filename, 200) || null,
      storage_kind: "inline_text",
      normalized_text: text,
      redaction_report: report,
      content_hash: contentHash,
      byte_size: text.length,
      processing_status: "pending",
    })
    .select("id, title, occurred_at, processing_status")
    .single();

  if (inserted.error || !inserted.data) {
    console.error(`ingest-source insert failed: ${inserted.error?.message ?? "unknown"}`);
    return fail("source_write_failed", "I couldn't file that transcript just now.", true);
  }

  return Response.json(
    {
      ok: true,
      duplicate: false,
      summary:
        report.total > 0
          ? `Transcript filed. I removed ${report.total} credential-looking value${report.total === 1 ? "" : "s"} before storing it.`
          : "Transcript filed.",
      source: {
        id: String(inserted.data.id),
        title: String(inserted.data.title ?? ""),
        occurredAt: inserted.data.occurred_at ?? null,
        processingStatus: String(inserted.data.processing_status ?? "pending"),
      },
      redaction: report,
    },
    { headers: corsHeaders },
  );
});