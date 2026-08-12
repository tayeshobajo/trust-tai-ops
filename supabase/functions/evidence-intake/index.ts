// Trust Tai Ops — conversation evidence intake.
//
// The browser never touches the storage bucket on its own terms: it asks for
// permission here, uploads to a server-issued path with a short-lived token,
// then asks the server to read what it uploaded. Every filename, MIME type and
// byte count the browser claims is re-decided here.
//
// Nothing on this path executes anything against a customer system.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { authorizeProject } from "../_shared/authz.ts";
import { authzDeps, executionContextConfigured, serviceClient } from "../_shared/clients.ts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  decideEvidence,
  isUuid,
  storagePathFor,
} from "../_shared/evidencePolicy.ts";
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
const SIGNED_UPLOAD_SECONDS = 120;
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

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
};

const statusFor = (analysis: NormalizedEvidence): string => {
  if (analysis.status === "complete") return "ready";
  if (analysis.status === "unsupported") return "unsupported";
  if (analysis.status === "unavailable") return "ready";
  return "failed";
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

  // -------------------------------------------------------------------------
  // register — decide the file, reserve a row, hand back a scoped upload URL
  // -------------------------------------------------------------------------
  if (action === "register") {
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) return fail("invalid_input", "No file was attached.", false);
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return fail(
        "too_many_attachments",
        `I can take up to ${MAX_ATTACHMENTS_PER_MESSAGE} files in one message.`,
        false,
      );
    }

    const runId = isUuid(body.runId) ? body.runId : null;
    const accepted: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];

    for (const raw of files) {
      const claim = (raw ?? {}) as Record<string, unknown>;
      const decision = decideEvidence({
        filename: claim.filename,
        mimeType: claim.mimeType,
        sizeBytes: claim.sizeBytes,
      });
      if (!decision.ok) {
        rejected.push({
          clientKey: typeof claim.clientKey === "string" ? claim.clientKey : null,
          filename: typeof claim.filename === "string" ? claim.filename.slice(0, 120) : "",
          code: decision.code,
          summary: decision.summary,
        });
        continue;
      }

      const evidenceId = crypto.randomUUID();
      const storagePath = storagePathFor(scopedProjectId, evidenceId, decision.safeFilename);

      const inserted = await service
        .from("project_evidence")
        .insert({
          id: evidenceId,
          project_id: scopedProjectId,
          run_id: runId,
          uploaded_by: authz.caller.userId,
          original_filename: decision.originalFilename,
          safe_filename: decision.safeFilename,
          mime_type: decision.mimeType,
          size_bytes: decision.sizeBytes,
          storage_bucket: BUCKET,
          storage_path: storagePath,
          evidence_kind: decision.kind,
          status: "uploading",
        })
        .select("id")
        .single();

      if (inserted.error) {
        console.error(`evidence insert failed: ${inserted.error.message}`);
        rejected.push({
          clientKey: typeof claim.clientKey === "string" ? claim.clientKey : null,
          filename: decision.safeFilename,
          code: "storage_unavailable",
          summary: "I couldn't reserve space for that file just now.",
        });
        continue;
      }

      const signed = await service.storage.from(BUCKET).createSignedUploadUrl(storagePath);
      if (signed.error || !signed.data) {
        console.error(`evidence signed upload failed: ${signed.error?.message ?? "unknown"}`);
        await service.from("project_evidence").delete().eq("id", evidenceId);
        rejected.push({
          clientKey: typeof claim.clientKey === "string" ? claim.clientKey : null,
          filename: decision.safeFilename,
          code: "storage_unavailable",
          summary: "Secure storage didn't answer, so I haven't taken that file.",
        });
        continue;
      }

      accepted.push({
        clientKey: typeof claim.clientKey === "string" ? claim.clientKey : null,
        evidenceId,
        filename: decision.safeFilename,
        mimeType: decision.mimeType,
        kind: decision.kind,
        sizeBytes: decision.sizeBytes,
        uploadUrl: signed.data.signedUrl,
        uploadToken: signed.data.token,
        path: storagePath,
        expiresInSeconds: SIGNED_UPLOAD_SECONDS,
      });
    }

    return ok({ accepted, rejected });
  }

  // -------------------------------------------------------------------------
  // commit — confirm the bytes landed, read them, store the analysis
  // -------------------------------------------------------------------------
  if (action === "commit") {
    const evidenceId = typeof body.evidenceId === "string" ? body.evidenceId : "";
    if (!isUuid(evidenceId)) return fail("invalid_input", "That attachment reference isn't valid.", false);

    const row = await service
      .from("project_evidence")
      .select("id, project_id, storage_path, mime_type, evidence_kind, size_bytes, safe_filename, message_id, created_at, status")
      .eq("id", evidenceId)
      .eq("project_id", scopedProjectId)
      .maybeSingle();

    if (row.error || !row.data) return fail("not_found", "I can't find that attachment on this project.", false);

    const messageId = isUuid(body.messageId) ? body.messageId : (row.data.message_id as string | null);
    const kind = String(row.data.evidence_kind) as Parameters<typeof analyzeTextualEvidence>[0];
    const provenance: EvidenceProvenance = {
      evidenceId,
      filename: String(row.data.safe_filename ?? "attachment"),
      messageId: messageId ?? null,
      createdAt: String(row.data.created_at ?? new Date().toISOString()),
    };

    await service
      .from("project_evidence")
      .update({ status: "analyzing", message_id: messageId, updated_at: new Date().toISOString() })
      .eq("id", evidenceId);

    const download = await service.storage.from(BUCKET).download(String(row.data.storage_path));
    if (download.error || !download.data) {
      await service
        .from("project_evidence")
        .update({ status: "failed", failure_reason: "upload_missing", updated_at: new Date().toISOString() })
        .eq("id", evidenceId);
      return fail("upload_missing", "That upload never finished, so there's nothing for me to read.", true);
    }

    const bytes = new Uint8Array(await download.data.arrayBuffer());
    const contentHash = await sha256Hex(bytes);

    let analysis: NormalizedEvidence;
    let analyzer = "text_reader";
    let modelId = "";

    if (kind === "video") {
      analysis = videoAnalysis(provenance, bytes.byteLength);
      analyzer = "metadata_only";
    } else if (kind === "image" || kind === "pdf") {
      const caller = multimodalCaller();
      analyzer = "multimodal";
      modelId = caller ? VISION_MODEL : "";
      analysis = await analyzeMultimodalEvidence(
        kind,
        toBase64(bytes),
        String(row.data.mime_type),
        provenance,
        caller,
      );
    } else if (kind === "other") {
      analysis = unsupportedAnalysis(kind, provenance);
    } else {
      let text = "";
      try {
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        text = "";
      }
      analysis = text.trim().length > 0
        ? analyzeTextualEvidence(kind, text, provenance)
        : unavailableAnalysis(provenance, "unreadable", "That file didn't read as text, so I haven't drawn anything from it.");
    }

    const stored = await service
      .from("evidence_analyses")
      .insert({
        project_id: scopedProjectId,
        evidence_id: evidenceId,
        version: 1,
        analyzer,
        model_id: modelId,
        status: analysis.status,
        result: analysis,
      })
      .select("id")
      .single();

    await service
      .from("project_evidence")
      .update({
        status: statusFor(analysis),
        content_hash: contentHash,
        analysis_id: stored.data?.id ?? null,
        failure_reason: analysis.unsupportedReason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", evidenceId);

    return ok({ evidenceId, analysis, status: statusFor(analysis) });
  }

  // -------------------------------------------------------------------------
  // attach — bind already-stored evidence to the message it was sent with
  // -------------------------------------------------------------------------
  if (action === "attach") {
    const messageId = typeof body.messageId === "string" ? body.messageId : "";
    const ids = Array.isArray(body.evidenceIds) ? body.evidenceIds.filter(isUuid) : [];
    if (!isUuid(messageId) || ids.length === 0) return fail("invalid_input", "Nothing to attach.", false);

    const { error } = await service
      .from("project_evidence")
      .update({ message_id: messageId, updated_at: new Date().toISOString() })
      .in("id", ids)
      .eq("project_id", scopedProjectId);

    if (error) return fail("write_failed", "I stored the files but couldn't pin them to that message.", true);
    return ok({ attached: ids.length });
  }

  // -------------------------------------------------------------------------
  // view_url — short-lived read link, issued per request, never persisted
  // -------------------------------------------------------------------------
  if (action === "view_url") {
    const evidenceId = typeof body.evidenceId === "string" ? body.evidenceId : "";
    if (!isUuid(evidenceId)) return fail("invalid_input", "That attachment reference isn't valid.", false);

    const row = await service
      .from("project_evidence")
      .select("storage_path")
      .eq("id", evidenceId)
      .eq("project_id", scopedProjectId)
      .maybeSingle();
    if (!row.data) return fail("not_found", "I can't find that attachment on this project.", false);

    const signed = await service.storage
      .from(BUCKET)
      .createSignedUrl(String(row.data.storage_path), SIGNED_READ_SECONDS);
    if (signed.error || !signed.data) return fail("storage_unavailable", "That file isn't reachable right now.", true);

    return ok({ url: signed.data.signedUrl, expiresInSeconds: SIGNED_READ_SECONDS });
  }

  return fail("invalid_input", "Unsupported request.", false);
});
