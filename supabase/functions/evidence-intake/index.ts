// Trust Tai Ops — conversation evidence intake.
//
// The browser never touches the storage bucket on its own terms: it asks for
// permission here, uploads to a server-issued path with a short-lived token,
// then asks the server to read what it uploaded. Every filename, MIME type and
// byte count the browser claims is re-decided here, and at commit the bytes
// that actually landed are validated before anything reads them.
//
// The decisions live in `_shared/evidenceIntake.ts` behind an injected store so
// the release gate can drive the real flows. This file is the wiring.
//
// Nothing on this path executes anything against a customer system.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import { isUuid } from "../_shared/evidencePolicy.ts";
import {
  type Analyzer,
  type EvidenceRow,
  type IntakeStore,
  abortEvidence,
  attachEvidence,
  commitEvidence,
  registerEvidence,
} from "../_shared/evidenceIntake.ts";
import {
  analyzeMultimodalEvidence,
  analyzeTextualEvidence,
  type EvidenceProvenance,
  type MultimodalCaller,
  type NormalizedEvidence,
  unavailableAnalysis,
  unsupportedAnalysis,
  videoAnalysis,
} from "../_shared/evidenceAnalysis.ts";

const BUCKET = "project-evidence";
const SIGNED_READ_SECONDS = 300;

const fail = (code: string, summary: string, retryable: boolean, status = 200) =>
  new Response(JSON.stringify({ ok: false, code, summary, retryable }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ok = (payload: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: true, ...payload }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const AUTH_FAIL_SUMMARY: Record<string, string> = {
  unauthorized: "I need you signed in before I can take a file.",
  forbidden: "This account isn't allowed to work on that project.",
  execution_context_unavailable: "I can't confirm who this project belongs to right now, so I stopped.",
};

// ---------------------------------------------------------------------------
// Multimodal reader. Absent key means absent capability, never a guess.
// ---------------------------------------------------------------------------

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const VISION_MODEL = "google/gemini-2.5-flash";

const multimodalCaller = (): MultimodalCaller | null => {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) return null;

  return async ({ systemPrompt, userPrompt, mimeType, base64 }) => {
    const isPdf = mimeType === "application/pdf";
    const attachment = isPdf
      ? { type: "file", file: { filename: "evidence.pdf", file_data: `data:${mimeType};base64,${base64}` } }
      : { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } };

    const response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: [{ type: "text", text: userPrompt }, attachment] },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`evidence vision call failed: ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  };
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

// ---------------------------------------------------------------------------
// Store — the only place this subsystem touches the database or the bucket.
// ---------------------------------------------------------------------------

type Service = ReturnType<typeof serviceClient>;

const EVIDENCE_COLUMNS =
  "id, project_id, run_id, message_id, safe_filename, original_filename, mime_type, evidence_kind, size_bytes, storage_path, status, content_hash, analysis_id, intake_key, created_at";

const toRow = (record: Record<string, unknown>): EvidenceRow => ({
  id: String(record.id),
  projectId: String(record.project_id),
  runId: (record.run_id as string | null) ?? null,
  messageId: (record.message_id as string | null) ?? null,
  safeFilename: String(record.safe_filename ?? "attachment"),
  originalFilename: String(record.original_filename ?? "attachment"),
  mimeType: String(record.mime_type ?? "application/octet-stream"),
  kind: String(record.evidence_kind ?? "other") as EvidenceRow["kind"],
  sizeBytes: Number(record.size_bytes ?? 0),
  storagePath: String(record.storage_path ?? ""),
  status: String(record.status ?? "uploading"),
  contentHash: (record.content_hash as string | null) ?? null,
  analysisId: (record.analysis_id as string | null) ?? null,
  intakeKey: (record.intake_key as string | null) ?? null,
  createdAt: String(record.created_at ?? new Date().toISOString()),
});

const makeStore = (service: Service, uploadedBy: string | null): IntakeStore => ({
  runProject: async (runId) => {
    const { data } = await service.from("runs").select("project_id").eq("id", runId).maybeSingle();
    return data ? String(data.project_id) : null;
  },
  messageProject: async (messageId) => {
    const { data } = await service
      .from("project_messages")
      .select("project_id, run_id")
      .eq("id", messageId)
      .maybeSingle();
    return data ? { projectId: String(data.project_id), runId: (data.run_id as string | null) ?? null } : null;
  },
  findByIntakeKey: async (projectId, intakeKey) => {
    const { data } = await service
      .from("project_evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("project_id", projectId)
      .eq("intake_key", intakeKey)
      .maybeSingle();
    return data ? toRow(data as Record<string, unknown>) : null;
  },
  insertEvidence: async (row) => {
    const { data, error } = await service
      .from("project_evidence")
      .insert({
        id: row.id,
        project_id: row.projectId,
        run_id: row.runId,
        message_id: row.messageId,
        uploaded_by: uploadedBy,
        original_filename: row.originalFilename,
        safe_filename: row.safeFilename,
        mime_type: row.mimeType,
        size_bytes: row.sizeBytes,
        storage_bucket: BUCKET,
        storage_path: row.storagePath,
        evidence_kind: row.kind,
        status: row.status,
        intake_key: row.intakeKey,
      })
      .select(EVIDENCE_COLUMNS)
      .single();
    if (error) {
      console.error(`evidence insert failed: ${error.message}`);
      return null;
    }
    return toRow(data as Record<string, unknown>);
  },
  getEvidence: async (projectId, evidenceId) => {
    const { data } = await service
      .from("project_evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("id", evidenceId)
      .eq("project_id", projectId)
      .maybeSingle();
    return data ? toRow(data as Record<string, unknown>) : null;
  },
  updateEvidence: async (evidenceId, patch) => {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.messageId !== undefined) update.message_id = patch.messageId;
    if (patch.runId !== undefined) update.run_id = patch.runId;
    if (patch.contentHash !== undefined) update.content_hash = patch.contentHash;
    if (patch.analysisId !== undefined) update.analysis_id = patch.analysisId;
    if (patch.failureReason !== undefined) update.failure_reason = patch.failureReason;
    await service.from("project_evidence").update(update).eq("id", evidenceId);
  },
  deleteEvidence: async (evidenceId) => {
    await service.from("project_evidence").delete().eq("id", evidenceId);
  },
  createSignedUpload: async (path) => {
    const signed = await service.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (signed.error || !signed.data) {
      console.error(`evidence signed upload failed: ${signed.error?.message ?? "unknown"}`);
      return null;
    }
    return { signedUrl: signed.data.signedUrl, token: signed.data.token };
  },
  download: async (path) => {
    const result = await service.storage.from(BUCKET).download(path);
    if (result.error || !result.data) return null;
    return new Uint8Array(await result.data.arrayBuffer());
  },
  removeObject: async (path) => {
    await service.storage.from(BUCKET).remove([path]);
  },
  latestAnalysis: async (evidenceId) => {
    const { data } = await service
      .from("evidence_analyses")
      .select("id, status, result")
      .eq("evidence_id", evidenceId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data
      ? { id: String(data.id), status: String(data.status), result: data.result as NormalizedEvidence }
      : null;
  },
  insertAnalysis: async (input) => {
    const { data, error } = await service
      .from("evidence_analyses")
      .insert({
        project_id: input.projectId,
        evidence_id: input.evidenceId,
        version: 1,
        analyzer: input.analyzer,
        model_id: input.modelId,
        status: input.status,
        result: input.result,
      })
      .select("id, status, result")
      .single();
    if (error || !data) return null;
    return { id: String(data.id), status: String(data.status), result: data.result as NormalizedEvidence };
  },
  staleUploading: async (projectId, olderThanIso) => {
    const { data } = await service
      .from("project_evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("project_id", projectId)
      .eq("status", "uploading")
      .lt("created_at", olderThanIso)
      .limit(25);
    return (data ?? []).map((record) => toRow(record as Record<string, unknown>));
  },
  sha256Hex: async (bytes) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  },
  newId: () => crypto.randomUUID(),
  now: () => new Date(),
});

const analyzer: Analyzer = async ({ row, bytes }) => {
  const provenance: EvidenceProvenance = {
    evidenceId: row.id,
    filename: row.safeFilename,
    messageId: row.messageId,
    createdAt: row.createdAt,
  };

  if (row.kind === "video") {
    return { analysis: videoAnalysis(provenance, bytes.byteLength), analyzer: "metadata_only", modelId: "" };
  }
  if (row.kind === "image" || row.kind === "pdf") {
    const caller = multimodalCaller();
    const analysis = await analyzeMultimodalEvidence(row.kind, toBase64(bytes), row.mimeType, provenance, caller);
    return { analysis, analyzer: "multimodal", modelId: caller ? VISION_MODEL : "" };
  }
  if (row.kind === "other") {
    return { analysis: unsupportedAnalysis(row.kind, provenance), analyzer: "text_reader", modelId: "" };
  }

  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    text = "";
  }
  const analysis: NormalizedEvidence = text.trim().length > 0
    ? analyzeTextualEvidence(row.kind, text, provenance)
    : unavailableAnalysis(provenance, "unreadable", "That file didn't read as text, so I haven't drawn anything from it.");
  return { analysis, analyzer: "text_reader", modelId: "" };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("invalid_input", "Unsupported request.", false);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_input", "I couldn't read that request.", false);
  }

  const action = typeof body.action === "string" ? body.action : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!isUuid(projectId)) return fail("invalid_input", "No project was named.", false);

  if (!executionContextConfigured()) {
    return fail("execution_context_unavailable", AUTH_FAIL_SUMMARY.execution_context_unavailable, true);
  }

  const authz = await authorizeProject(req.headers.get("Authorization"), projectId, authzDeps());
  if (!authz.ok) {
    return fail(authz.code, AUTH_FAIL_SUMMARY[authz.code] ?? "I stopped before storing anything.", false);
  }

  const service = serviceClient();
  const scopedProjectId = authz.project.projectId;
  const store = makeStore(service, authz.caller.userId);
  const ctx = { projectId: scopedProjectId, userId: authz.caller.userId };

  if (action === "register" || action === "commit" || action === "abort" || action === "attach") {
    const result = action === "register"
      ? await registerEvidence(store, ctx, body)
      : action === "commit"
      ? await commitEvidence(store, ctx, body, analyzer)
      : action === "abort"
      ? await abortEvidence(store, ctx, body)
      : await attachEvidence(store, ctx, body);

    return result.ok ? ok(result.payload) : fail(result.code, result.summary, result.retryable);
  }

  // -------------------------------------------------------------------------
  // view_url — short-lived read link, issued per request, never persisted
  // -------------------------------------------------------------------------
  if (action === "view_url") {
    const evidenceId = typeof body.evidenceId === "string" ? body.evidenceId : "";
    if (!isUuid(evidenceId)) return fail("invalid_input", "That attachment reference isn't valid.", false);

    const row = await store.getEvidence(scopedProjectId, evidenceId);
    if (!row) return fail("not_found", "I can't find that attachment on this project.", false);

    const signed = await service.storage.from(BUCKET).createSignedUrl(row.storagePath, SIGNED_READ_SECONDS);
    if (signed.error || !signed.data) return fail("storage_unavailable", "That file isn't reachable right now.", true);

    return ok({ url: signed.data.signedUrl, expiresInSeconds: SIGNED_READ_SECONDS });
  }

  return fail("invalid_input", "Unsupported request.", false);
});
