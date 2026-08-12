/**
 * Conversation evidence — browser side.
 *
 * The browser's job here is narrow: pick files, show them, upload the bytes to
 * a path the server issued, and ask the server what it found. It does not
 * decide what is acceptable, where a file lives, or what an attachment means.
 * Every check below is a courtesy to the person typing; the server repeats all
 * of them and its answer wins.
 */

import { hasSupabasePublicConfig, resolveOpsEnv } from "./env";
import { getSupabaseClient } from "./supabase";
import type { EvidenceAnalysis, EvidenceKind, EvidenceProvenance, ProjectEvidence } from "./types";

const BUCKET = "project-evidence";

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

const MB = 1024 * 1024;

/** Mirrors the server policy so a person is told early, not after an upload. */
const LOCAL_RULES: Array<{ extensions: string[]; kind: EvidenceKind; maxBytes: number }> = [
  { extensions: ["png", "jpg", "jpeg", "webp"], kind: "image", maxBytes: 10 * MB },
  { extensions: ["mp4", "webm", "mov"], kind: "video", maxBytes: 25 * MB },
  { extensions: ["pdf"], kind: "pdf", maxBytes: 15 * MB },
  { extensions: ["txt", "md"], kind: "text", maxBytes: 10 * MB },
  { extensions: ["log"], kind: "log", maxBytes: 10 * MB },
  { extensions: ["har"], kind: "har", maxBytes: 15 * MB },
  { extensions: ["json"], kind: "json", maxBytes: 15 * MB },
  { extensions: ["csv"], kind: "csv", maxBytes: 15 * MB },
];

export const ACCEPT_ATTRIBUTE = LOCAL_RULES.flatMap((rule) => rule.extensions)
  .map((extension) => `.${extension}`)
  .join(",");

export const evidenceIntakeAvailable = (): boolean => hasSupabasePublicConfig(resolveOpsEnv());

const extensionOf = (filename: string): string => filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

export const localEvidenceKind = (filename: string): EvidenceKind =>
  LOCAL_RULES.find((rule) => rule.extensions.includes(extensionOf(filename)))?.kind ?? "other";

/** Returns a plain-English reason a file cannot be sent, or null when it can. */
export const localRejectionFor = (file: { name: string; size: number }): string | null => {
  const rule = LOCAL_RULES.find((item) => item.extensions.includes(extensionOf(file.name)));
  if (!rule) return `I can't read ${file.name} yet — try an image, video, PDF, log, text, HAR, JSON or CSV file.`;
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > rule.maxBytes) {
    return `${file.name} is larger than the ${Math.round(rule.maxBytes / MB)} MB limit for ${rule.kind} files.`;
  }
  return null;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
};

/** Provenance survives client mapping: a reading must keep its source. */
const asProvenance = (value: unknown): EvidenceProvenance | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.evidenceId !== "string") return null;
  return {
    evidenceId: raw.evidenceId,
    filename: typeof raw.filename === "string" ? raw.filename : "attachment",
    messageId: typeof raw.messageId === "string" ? raw.messageId : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
};

const asAnalysis = (value: unknown): EvidenceAnalysis | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.summary !== "string") return null;
  const list = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  return {
    status: (raw.status === "unavailable" || raw.status === "unsupported" || raw.status === "failed"
      ? raw.status
      : "complete"),
    summary: raw.summary,
    observations: list(raw.observations),
    extractedTextExcerpt: typeof raw.extractedTextExcerpt === "string" ? raw.extractedTextExcerpt : "",
    technicalSignals: list(raw.technicalSignals),
    confidence: raw.confidence === "high" || raw.confidence === "low" ? raw.confidence : "medium",
    warnings: list(raw.warnings),
    unsupportedReason: typeof raw.unsupportedReason === "string" ? raw.unsupportedReason : null,
    provenance: asProvenance(raw.provenance),
  };
};

export type UploadedEvidence = {
  evidenceId: string;
  filename: string;
  kind: EvidenceKind;
  sizeBytes: number;
  analysis: EvidenceAnalysis | null;
};

export type EvidenceUploadResult = {
  uploaded: UploadedEvidence[];
  rejected: Array<{ clientKey: string | null; filename: string; summary: string }>;
};

/** Per-file lifecycle in the composer. One global spinner tells nobody much. */
export type QueuedState = "queued" | "uploading" | "reading" | "done" | "failed";

export type QueuedFile = {
  key: string;
  intakeKey: string;
  file: File;
  /** Bounded local preview for images. Revoked when the entry is removed. */
  previewUrl: string | null;
  state: QueuedState;
  reason: string | null;
};

let queueCounter = 0;

const makeIntakeKey = (file: File): string =>
  // Stable for the same bytes-shaped file in the same session, so a resend of
  // the same queue does not reserve a second record.
  `${file.name}|${file.size}|${file.lastModified}`.replace(/[^A-Za-z0-9._|-]/g, "-").slice(0, 100);

/** Images get a local object URL; everything else stays a name and a size. */
export const makeQueuedFile = (file: File): QueuedFile => ({
  key: `q${(queueCounter += 1)}`,
  intakeKey: makeIntakeKey(file),
  file,
  previewUrl:
    localEvidenceKind(file.name) === "image" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : null,
  state: "queued",
  reason: null,
});

export const releaseQueuedFile = (entry: QueuedFile): void => {
  if (entry.previewUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(entry.previewUrl);
  }
};

/**
 * Adds files to the queue: rejects locally-impossible ones with a reason,
 * drops exact repeats, and honours the per-message ceiling.
 */
export const enqueueEvidenceFiles = (
  current: QueuedFile[],
  incoming: File[],
): { queue: QueuedFile[]; rejected: string[] } => {
  const queue = [...current];
  const rejected: string[] = [];
  const seen = new Set(current.map((entry) => entry.intakeKey));

  for (const file of incoming) {
    if (queue.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejected.push(`I can take up to ${MAX_ATTACHMENTS_PER_MESSAGE} files in one message.`);
      break;
    }
    const reason = localRejectionFor(file);
    if (reason) {
      rejected.push(reason);
      continue;
    }
    const entry = makeQueuedFile(file);
    if (seen.has(entry.intakeKey)) {
      releaseQueuedFile(entry);
      continue;
    }
    seen.add(entry.intakeKey);
    queue.push(entry);
  }

  return { queue, rejected };
};

export const dequeueEvidenceFile = (current: QueuedFile[], key: string): QueuedFile[] => {
  const entry = current.find((item) => item.key === key);
  if (entry) releaseQueuedFile(entry);
  return current.filter((item) => item.key !== key);
};

/** Files from a drop event, ignoring directories and non-file drags. */
export const filesFromDataTransfer = (transfer: DataTransfer | null): File[] => {
  if (!transfer) return [];
  const items = Array.from(transfer.items ?? []);
  if (items.length > 0) {
    return items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }
  return Array.from(transfer.files ?? []);
};

/**
 * Pasted screenshots only. When the clipboard also carries text, normal text
 * paste must keep working, so an empty result here means "not our business".
 */
export const imageFilesFromClipboard = (transfer: DataTransfer | null): File[] => {
  if (!transfer) return [];
  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      // A pasted screenshot arrives as `image.png` or with no name at all.
      const named = file.name && file.name !== "image.png"
        ? file
        : new File([file], `pasted-screenshot-${Date.now()}-${index}.${file.type.split("/")[1] || "png"}`, {
            type: file.type,
          });
      return named;
    })
    .filter((file): file is File => Boolean(file));
};

/**
 * Register → upload → commit. Each file is independent: one rejection never
 * discards the others, and a failure is reported in the same plain language
 * the agent uses everywhere else.
 */
export const uploadEvidence = async (input: {
  projectId: string;
  runId: string | null;
  /** Bound at registration: the user message already exists before the upload. */
  messageId?: string | null;
  files: QueuedFile[];
  /** Per-file progress, so the composer never shows one global spinner. */
  onProgress?: (clientKey: string, state: QueuedState, reason?: string) => void;
}): Promise<EvidenceUploadResult> => {
  const report = (key: string, state: QueuedState, reason?: string) => input.onProgress?.(key, state, reason);

  if (!evidenceIntakeAvailable()) {
    return {
      uploaded: [],
      rejected: input.files.map((queued) => ({
        clientKey: queued.key,
        filename: queued.file.name,
        summary: "I can't reach secure storage from here, so I haven't taken that file.",
      })),
    };
  }

  const client = getSupabaseClient();
  const rejected: EvidenceUploadResult["rejected"] = [];
  const byKey = new Map<string, QueuedFile>();
  const claims = input.files.map((queued) => {
    byKey.set(queued.key, queued);
    report(queued.key, "uploading");
    return {
      clientKey: queued.key,
      filename: queued.file.name,
      mimeType: queued.file.type,
      sizeBytes: queued.file.size,
      // Stable across retries of the same queued file, so a double submit or a
      // network retry converges on one record instead of two.
      intakeKey: queued.intakeKey,
    };
  });

  const registered = await client.functions.invoke("evidence-intake", {
    body: {
      action: "register",
      projectId: input.projectId,
      runId: input.runId,
      messageId: input.messageId ?? null,
      files: claims,
    },
  });

  const payload = registered.data as
    | {
        ok?: boolean;
        summary?: string;
        accepted?: Array<Record<string, unknown>>;
        rejected?: Array<Record<string, unknown>>;
      }
    | null;

  if (registered.error || !payload?.ok) {
    for (const queued of input.files) report(queued.key, "failed");
    return {
      uploaded: [],
      rejected: input.files.map((queued) => ({
        clientKey: queued.key,
        filename: queued.file.name,
        summary: typeof payload?.summary === "string"
          ? payload.summary
          : "I couldn't take those files just now, so nothing was stored.",
      })),
    };
  }

  for (const item of payload.rejected ?? []) {
    const key = String(item.clientKey ?? "");
    if (key) report(key, "failed", String(item.summary ?? ""));
    rejected.push({
      clientKey: key || null,
      filename: String(item.filename ?? "that file"),
      summary: String(item.summary ?? "I couldn't take that file."),
    });
  }

  const uploaded: UploadedEvidence[] = [];

  for (const item of payload.accepted ?? []) {
    const clientKey = String(item.clientKey ?? "");
    const queued = byKey.get(clientKey);
    const evidenceId = String(item.evidenceId ?? "");
    const path = String(item.path ?? "");
    const token = String(item.uploadToken ?? "");
    if (!queued || !evidenceId || !path) continue;
    const file = queued.file;

    // `alreadyStored` means a retry converged on a reservation whose bytes are
    // already up: skip the upload and go straight to commit.
    if (token) {
      const sent = await client.storage.from(BUCKET).uploadToSignedUrl(path, token, file, {
        contentType: String(item.mimeType ?? file.type ?? "application/octet-stream"),
      });
      if (sent.error) {
        // Nothing may be left half-reserved behind a failed upload.
        await abortEvidence(input.projectId, [evidenceId]);
        report(clientKey, "failed", "That upload didn't finish.");
        rejected.push({
          clientKey,
          filename: file.name,
          summary: `${file.name} didn't finish uploading, so I haven't read it.`,
        });
        continue;
      }
    }

    report(clientKey, "reading");
    const committed = await client.functions.invoke("evidence-intake", {
      body: { action: "commit", projectId: input.projectId, evidenceId, messageId: input.messageId ?? null },
    });
    const result = committed.data as { ok?: boolean; summary?: string; analysis?: unknown } | null;

    if (committed.error || !result?.ok) {
      report(clientKey, "failed", typeof result?.summary === "string" ? result.summary : undefined);
      rejected.push({
        clientKey,
        filename: file.name,
        summary: typeof result?.summary === "string"
          ? result.summary
          : `I stored ${file.name} but couldn't read it just now.`,
      });
      continue;
    }

    report(clientKey, "done");
    uploaded.push({
      evidenceId,
      filename: String(item.filename ?? file.name),
      kind: (String(item.kind ?? "other") as EvidenceKind),
      sizeBytes: Number(item.sizeBytes ?? file.size),
      analysis: asAnalysis(result.analysis),
    });
  }

  return { uploaded, rejected };
};

/** Withdraws reservations whose upload never completed. Ready evidence is safe. */
export const abortEvidence = async (projectId: string, evidenceIds: string[]): Promise<void> => {
  if (!evidenceIntakeAvailable() || evidenceIds.length === 0) return;
  try {
    await getSupabaseClient().functions.invoke("evidence-intake", {
      body: { action: "abort", projectId, evidenceIds },
    });
  } catch {
    // Best effort: the server also prunes stale reservations on its own.
  }
};

/** Binds already-stored evidence to the message it was sent with. */
export const attachEvidenceToMessage = async (input: {
  projectId: string;
  messageId: string;
  evidenceIds: string[];
}): Promise<boolean> => {
  if (!evidenceIntakeAvailable() || input.evidenceIds.length === 0) return false;
  const client = getSupabaseClient();
  const response = await client.functions.invoke("evidence-intake", {
    body: {
      action: "attach",
      projectId: input.projectId,
      messageId: input.messageId,
      evidenceIds: input.evidenceIds,
    },
  });
  return !response.error && Boolean((response.data as { ok?: boolean } | null)?.ok);
};

/** Every attachment on a project, with its analysis. Read-only. */
export const listProjectEvidence = async (projectId: string): Promise<ProjectEvidence[]> => {
  if (!evidenceIntakeAvailable()) return [];
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("project_evidence")
    .select(
      "id, project_id, message_id, run_id, safe_filename, mime_type, evidence_kind, size_bytes, status, created_at, evidence_analyses(result)",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>).map((row) => {
    const analyses = Array.isArray(row.evidence_analyses) ? row.evidence_analyses : [];
    const latest = (analyses[analyses.length - 1] ?? {}) as { result?: unknown };
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      messageId: typeof row.message_id === "string" ? row.message_id : null,
      runId: typeof row.run_id === "string" ? row.run_id : null,
      filename: String(row.safe_filename ?? "attachment"),
      mimeType: String(row.mime_type ?? "application/octet-stream"),
      kind: (String(row.evidence_kind ?? "other") as EvidenceKind),
      sizeBytes: Number(row.size_bytes ?? 0),
      status: (String(row.status ?? "stored") as ProjectEvidence["status"]),
      analysis: asAnalysis(latest.result),
      createdAt: String(row.created_at ?? new Date().toISOString()),
    };
  });
};

/** Short-lived read link, requested per view and never stored. */
export const evidenceViewUrl = async (projectId: string, evidenceId: string): Promise<string | null> => {
  if (!evidenceIntakeAvailable()) return null;
  const client = getSupabaseClient();
  const response = await client.functions.invoke("evidence-intake", {
    body: { action: "view_url", projectId, evidenceId },
  });
  const payload = response.data as { ok?: boolean; url?: string } | null;
  return !response.error && payload?.ok && typeof payload.url === "string" ? payload.url : null;
};

/** What the agent says back after reading an attachment. Never invented. */
export const evidenceReplyLines = (uploaded: UploadedEvidence[]): string[] => {
  const lines: string[] = [];
  for (const item of uploaded) {
    const analysis = item.analysis;
    if (!analysis) {
      lines.push(`I've stored ${item.filename}, but I haven't been able to read it.`);
      continue;
    }
    lines.push(`${item.filename}: ${analysis.summary}`);
    for (const observation of analysis.observations.slice(0, 4)) lines.push(`• ${observation}`);
    for (const signal of analysis.technicalSignals.slice(0, 4)) lines.push(`• ${signal}`);
    for (const warning of analysis.warnings) lines.push(`Worth flagging: ${warning}`);
  }
  return lines;
};
