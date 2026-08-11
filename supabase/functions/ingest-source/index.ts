// Trust Tai Ops — meeting transcript ingestion.
//
// A transcript enters the product exactly once, here. It is normalized,
// redacted, hashed and stored against a project the caller has proven they
// belong to. Nothing is analysed and nothing is executed on this path.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import {
  MAX_TRANSCRIPT_BYTES,
  byteLength,
  chunkTranscript,
  hashTranscript,
  planTranscriptCoverage,
  prepareTranscript,
} from "../_shared/transcript.ts";

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

/**
 * V1 takes plain text only. A .pdf or .docx renamed to .txt would arrive as
 * binary noise, so the extension is checked and the content has to read as
 * text before anything is stored.
 */
const TEXT_EXTENSIONS = [".txt", ".md", ".vtt", ".srt"];

const looksBinary = (value: string): boolean => {
  const sample = value.slice(0, 4000);
  // eslint-disable-next-line no-control-regex
  const controls = sample.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0;
  return sample.includes("\u0000") || controls / Math.max(1, sample.length) > 0.02;
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
  // Measured in bytes, not characters: the storage limit is a byte limit.
  if (byteLength(raw) > MAX_TRANSCRIPT_BYTES) {
    return fail(
      "transcript_too_large",
      "That transcript is larger than I can take in one go. Split it and share it in parts.",
      false,
    );
  }

  const filename = clean(body.filename, 200);
  if (filename && !TEXT_EXTENSIONS.some((extension) => filename.toLowerCase().endsWith(extension))) {
    return fail(
      "unsupported_format",
      "I can only read plain text transcripts right now. Export it as .txt and share it again.",
      false,
    );
  }
  if (looksBinary(raw)) {
    return fail(
      "unsupported_format",
      "That file isn't plain text. Export the transcript as text and share it again.",
      false,
    );
  }

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before storing anything.", false);

  // Redaction happens before the first write. The raw text is never persisted.
  const { text, report } = prepareTranscript(raw);

  // Coverage is decided before storage: a transcript this function cannot read
  // end to end is refused, rather than analysed as a prefix later.
  const coverage = planTranscriptCoverage(chunkTranscript(text));
  if (coverage.exceedsBudget) {
    return fail(
      "transcript_too_large",
      "That meeting is too long for me to read in one pass. Share it in two parts and I'll keep both.",
      false,
    );
  }

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

  // An unknown meeting date stays unknown. Defaulting to "today" would invent a
  // fact the transcript never contained.
  const occurredAtRaw = typeof body.occurredAt === "string" ? Date.parse(body.occurredAt) : Number.NaN;
  const occurredAt = Number.isNaN(occurredAtRaw) ? null : new Date(occurredAtRaw).toISOString();

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