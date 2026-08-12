/**
 * Evidence intake logic.
 *
 * Everything the `evidence-intake` function decides lives here, behind an
 * injected store, so the release gate can drive the real flows — cross-project
 * provenance, retry idempotency, byte validation, abandoned uploads — without
 * a network or a Deno runtime.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  decideEvidence,
  displayFilename,
  type EvidenceKind,
  isUuid,
  storagePathFor,
} from "./evidencePolicy.ts";
import { validateEvidenceBytes } from "./evidenceBytes.ts";
import type { NormalizedEvidence } from "./evidenceAnalysis.ts";

export type EvidenceRow = {
  id: string;
  projectId: string;
  runId: string | null;
  messageId: string | null;
  safeFilename: string;
  originalFilename: string;
  mimeType: string;
  kind: EvidenceKind;
  sizeBytes: number;
  storagePath: string;
  status: string;
  contentHash: string | null;
  analysisId: string | null;
  intakeKey: string | null;
  createdAt: string;
};

export type StoredAnalysis = { id: string; status: string; result: NormalizedEvidence };

export type IntakeStore = {
  /** The project a run belongs to, or null when the run does not exist. */
  runProject(runId: string): Promise<string | null>;
  /** The project and run a message belongs to, or null when it does not exist. */
  messageProject(messageId: string): Promise<{ projectId: string; runId: string | null } | null>;
  findByIntakeKey(projectId: string, intakeKey: string): Promise<EvidenceRow | null>;
  insertEvidence(row: EvidenceRow): Promise<EvidenceRow | null>;
  getEvidence(projectId: string, evidenceId: string): Promise<EvidenceRow | null>;
  updateEvidence(evidenceId: string, patch: Partial<EvidenceRow> & { failureReason?: string | null }): Promise<void>;
  deleteEvidence(evidenceId: string): Promise<void>;
  createSignedUpload(path: string): Promise<{ signedUrl: string; token: string } | null>;
  download(path: string): Promise<Uint8Array | null>;
  removeObject(path: string): Promise<void>;
  latestAnalysis(evidenceId: string): Promise<StoredAnalysis | null>;
  insertAnalysis(input: {
    projectId: string;
    evidenceId: string;
    analyzer: string;
    modelId: string;
    status: string;
    result: NormalizedEvidence;
  }): Promise<StoredAnalysis | null>;
  staleUploading(projectId: string, olderThanIso: string): Promise<EvidenceRow[]>;
  sha256Hex(bytes: Uint8Array): Promise<string>;
  newId(): string;
  now(): Date;
};

export type IntakeContext = { projectId: string; userId: string | null };

export type IntakeResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: string; summary: string; retryable: boolean };

const refuse = (code: string, summary: string, retryable = false): IntakeResult => ({
  ok: false,
  code,
  summary,
  retryable,
});

/** Uploads that were reserved and never finished are cleaned up after this. */
export const STALE_UPLOAD_TTL_MS = 15 * 60 * 1000;

const SIGNED_UPLOAD_SECONDS = 120;

// ---------------------------------------------------------------------------
// Provenance. An id from another project must behave as if it does not exist.
// ---------------------------------------------------------------------------

export type ProvenanceVerdict =
  | { ok: true; runId: string | null; messageId: string | null }
  | { ok: false; code: string; summary: string };

export const resolveProvenance = async (
  store: IntakeStore,
  projectId: string,
  claim: { runId?: unknown; messageId?: unknown },
): Promise<ProvenanceVerdict> => {
  const runClaim = typeof claim.runId === "string" && isUuid(claim.runId) ? claim.runId : null;
  const messageClaim = typeof claim.messageId === "string" && isUuid(claim.messageId) ? claim.messageId : null;

  if (claim.runId != null && claim.runId !== "" && !runClaim) {
    return { ok: false, code: "not_found", summary: "I can't find that task on this project." };
  }
  if (claim.messageId != null && claim.messageId !== "" && !messageClaim) {
    return { ok: false, code: "not_found", summary: "I can't find that message on this project." };
  }

  let runId: string | null = null;
  if (runClaim) {
    const owner = await store.runProject(runClaim);
    // Service-role authority must never be lent to a row from another project.
    if (owner !== projectId) {
      return { ok: false, code: "not_found", summary: "I can't find that task on this project." };
    }
    runId = runClaim;
  }

  let messageId: string | null = null;
  if (messageClaim) {
    const owner = await store.messageProject(messageClaim);
    if (!owner || owner.projectId !== projectId) {
      return { ok: false, code: "not_found", summary: "I can't find that message on this project." };
    }
    // When both are named and the schema records the pair, they must agree.
    if (runId && owner.runId && owner.runId !== runId) {
      return { ok: false, code: "not_found", summary: "That message doesn't belong to that task." };
    }
    messageId = messageClaim;
    if (!runId && owner.runId) runId = owner.runId;
  }

  return { ok: true, runId, messageId };
};

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

const intakeKeyFor = (claim: Record<string, unknown>, messageId: string | null): string | null => {
  const raw = typeof claim.intakeKey === "string" ? claim.intakeKey.trim() : "";
  if (raw.length === 0 || raw.length > 120) return null;
  // Scoped by message so the same file re-used on a different message is a new
  // record, while a retry of the same queued file converges on one.
  return `${messageId ?? "unbound"}:${raw.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 100)}`;
};

export const registerEvidence = async (
  store: IntakeStore,
  ctx: IntakeContext,
  body: Record<string, unknown>,
): Promise<IntakeResult> => {
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) return refuse("invalid_input", "No file was attached.");
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return refuse("too_many_attachments", `I can take up to ${MAX_ATTACHMENTS_PER_MESSAGE} files in one message.`);
  }

  const provenance = await resolveProvenance(store, ctx.projectId, body);
  if (!provenance.ok) return refuse(provenance.code, provenance.summary);

  // Housekeeping runs on the ordinary path so nothing needs a scheduler.
  await cleanupStaleUploads(store, ctx.projectId).catch(() => undefined);

  const accepted: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];

  for (const raw of files) {
    const claim = (raw ?? {}) as Record<string, unknown>;
    const clientKey = typeof claim.clientKey === "string" ? claim.clientKey : null;
    const decision = decideEvidence({
      filename: claim.filename,
      mimeType: claim.mimeType,
      sizeBytes: claim.sizeBytes,
    });
    if (!decision.ok) {
      rejected.push({
        clientKey,
        filename: displayFilename(typeof claim.filename === "string" ? claim.filename : "attachment"),
        code: decision.code,
        summary: decision.summary,
      });
      continue;
    }

    const intakeKey = intakeKeyFor(claim, provenance.messageId);

    // A retried register for the same queued file returns the reservation it
    // already made rather than reserving a second one.
    if (intakeKey) {
      const existing = await store.findByIntakeKey(ctx.projectId, intakeKey);
      if (existing) {
        if (existing.status === "uploading") {
          const reissued = await store.createSignedUpload(existing.storagePath);
          if (reissued) {
            accepted.push({
              clientKey,
              evidenceId: existing.id,
              filename: displayFilename(existing.safeFilename),
              mimeType: existing.mimeType,
              kind: existing.kind,
              sizeBytes: existing.sizeBytes,
              uploadUrl: reissued.signedUrl,
              uploadToken: reissued.token,
              path: existing.storagePath,
              expiresInSeconds: SIGNED_UPLOAD_SECONDS,
              duplicate: true,
            });
            continue;
          }
        }
        accepted.push({
          clientKey,
          evidenceId: existing.id,
          filename: displayFilename(existing.safeFilename),
          mimeType: existing.mimeType,
          kind: existing.kind,
          sizeBytes: existing.sizeBytes,
          uploadUrl: null,
          uploadToken: null,
          path: existing.storagePath,
          alreadyStored: true,
          duplicate: true,
        });
        continue;
      }
    }

    const evidenceId = store.newId();
    const storagePath = storagePathFor(ctx.projectId, evidenceId, decision.safeFilename);
    const row: EvidenceRow = {
      id: evidenceId,
      projectId: ctx.projectId,
      runId: provenance.runId,
      // Bound at registration: the user message exists before the upload does.
      messageId: provenance.messageId,
      safeFilename: decision.safeFilename,
      originalFilename: decision.originalFilename,
      mimeType: decision.mimeType,
      kind: decision.kind,
      sizeBytes: decision.sizeBytes,
      storagePath,
      status: "uploading",
      contentHash: null,
      analysisId: null,
      intakeKey,
      createdAt: store.now().toISOString(),
    };

    const inserted = await store.insertEvidence(row);
    if (!inserted) {
      // A concurrent duplicate lost the unique-index race: adopt the winner.
      const winner = intakeKey ? await store.findByIntakeKey(ctx.projectId, intakeKey) : null;
      if (winner) {
        const reissued = await store.createSignedUpload(winner.storagePath);
        accepted.push({
          clientKey,
          evidenceId: winner.id,
          filename: displayFilename(winner.safeFilename),
          mimeType: winner.mimeType,
          kind: winner.kind,
          sizeBytes: winner.sizeBytes,
          uploadUrl: reissued?.signedUrl ?? null,
          uploadToken: reissued?.token ?? null,
          path: winner.storagePath,
          expiresInSeconds: SIGNED_UPLOAD_SECONDS,
          duplicate: true,
        });
        continue;
      }
      rejected.push({
        clientKey,
        filename: displayFilename(decision.safeFilename),
        code: "storage_unavailable",
        summary: "I couldn't reserve space for that file just now.",
      });
      continue;
    }

    const signed = await store.createSignedUpload(storagePath);
    if (!signed) {
      await store.deleteEvidence(evidenceId);
      rejected.push({
        clientKey,
        filename: displayFilename(decision.safeFilename),
        code: "storage_unavailable",
        summary: "Secure storage didn't answer, so I haven't taken that file.",
      });
      continue;
    }

    accepted.push({
      clientKey,
      evidenceId,
      filename: displayFilename(decision.safeFilename),
      mimeType: decision.mimeType,
      kind: decision.kind,
      sizeBytes: decision.sizeBytes,
      uploadUrl: signed.signedUrl,
      uploadToken: signed.token,
      path: storagePath,
      expiresInSeconds: SIGNED_UPLOAD_SECONDS,
    });
  }

  return { ok: true, payload: { accepted, rejected } };
};

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export type Analyzer = (input: {
  row: EvidenceRow;
  bytes: Uint8Array;
}) => Promise<{ analysis: NormalizedEvidence; analyzer: string; modelId: string }>;

export const statusForAnalysis = (analysis: NormalizedEvidence): string => {
  if (analysis.status === "complete") return "ready";
  if (analysis.status === "unsupported") return "unsupported";
  if (analysis.status === "unavailable") return "ready";
  return "failed";
};

export const commitEvidence = async (
  store: IntakeStore,
  ctx: IntakeContext,
  body: Record<string, unknown>,
  analyze: Analyzer,
): Promise<IntakeResult> => {
  const evidenceId = typeof body.evidenceId === "string" ? body.evidenceId : "";
  if (!isUuid(evidenceId)) return refuse("invalid_input", "That attachment reference isn't valid.");

  const row = await store.getEvidence(ctx.projectId, evidenceId);
  if (!row) return refuse("not_found", "I can't find that attachment on this project.");

  // Idempotent: a repeated commit returns the analysis that already exists
  // rather than inserting version 1 twice and hitting the unique index.
  const existing = await store.latestAnalysis(evidenceId);
  if (existing) {
    return { ok: true, payload: { evidenceId, analysis: existing.result, status: row.status, reused: true } };
  }

  const provenance = await resolveProvenance(store, ctx.projectId, {
    runId: body.runId ?? row.runId,
    messageId: body.messageId ?? row.messageId,
  });
  if (!provenance.ok) return refuse(provenance.code, provenance.summary);

  await store.updateEvidence(evidenceId, {
    status: "analyzing",
    messageId: provenance.messageId ?? row.messageId,
    runId: provenance.runId ?? row.runId,
  });

  const bytes = await store.download(row.storagePath);
  if (!bytes) {
    await store.updateEvidence(evidenceId, { status: "failed", failureReason: "upload_missing" });
    return refuse("upload_missing", "That upload never finished, so there's nothing for me to read.", true);
  }

  // The authoritative gate: what actually landed, not what was claimed.
  const verdict = validateEvidenceBytes({
    kind: row.kind,
    mimeType: row.mimeType,
    bytes,
    declaredSize: row.sizeBytes,
  });
  if (!verdict.ok) {
    await store.removeObject(row.storagePath).catch(() => undefined);
    await store.deleteEvidence(evidenceId);
    return refuse(verdict.code, verdict.summary);
  }

  const contentHash = await store.sha256Hex(bytes);
  const bound: EvidenceRow = {
    ...row,
    messageId: provenance.messageId ?? row.messageId,
    runId: provenance.runId ?? row.runId,
  };
  const { analysis, analyzer, modelId } = await analyze({ row: bound, bytes });

  const stored = await store.insertAnalysis({
    projectId: ctx.projectId,
    evidenceId,
    analyzer,
    modelId,
    status: analysis.status,
    result: analysis,
  });

  // Lost the race to a concurrent commit: return that one's answer.
  if (!stored) {
    const winner = await store.latestAnalysis(evidenceId);
    if (winner) {
      return { ok: true, payload: { evidenceId, analysis: winner.result, status: row.status, reused: true } };
    }
    await store.updateEvidence(evidenceId, { status: "failed", failureReason: "analysis_write_failed" });
    return refuse("write_failed", "I read that file but couldn't file what I found.", true);
  }

  const status = statusForAnalysis(analysis);
  await store.updateEvidence(evidenceId, {
    status,
    contentHash,
    analysisId: stored.id,
    failureReason: analysis.unsupportedReason,
  });

  return { ok: true, payload: { evidenceId, analysis, status } };
};

// ---------------------------------------------------------------------------
// abort / attach / cleanup
// ---------------------------------------------------------------------------

/** The client calls this when a signed upload fails, so nothing is orphaned. */
export const abortEvidence = async (
  store: IntakeStore,
  ctx: IntakeContext,
  body: Record<string, unknown>,
): Promise<IntakeResult> => {
  const ids = Array.isArray(body.evidenceIds) ? body.evidenceIds.filter((id): id is string => isUuid(id)) : [];
  if (ids.length === 0) return refuse("invalid_input", "Nothing to withdraw.");

  let removed = 0;
  for (const id of ids) {
    const row = await store.getEvidence(ctx.projectId, id);
    // Ready evidence is never deleted by an abort.
    if (!row || (row.status !== "uploading" && row.status !== "analyzing")) continue;
    await store.removeObject(row.storagePath).catch(() => undefined);
    await store.deleteEvidence(id);
    removed += 1;
  }
  return { ok: true, payload: { removed } };
};

export const attachEvidence = async (
  store: IntakeStore,
  ctx: IntakeContext,
  body: Record<string, unknown>,
): Promise<IntakeResult> => {
  const ids = Array.isArray(body.evidenceIds) ? body.evidenceIds.filter((id): id is string => isUuid(id)) : [];
  if (ids.length === 0) return refuse("invalid_input", "Nothing to attach.");

  const provenance = await resolveProvenance(store, ctx.projectId, { messageId: body.messageId, runId: body.runId });
  if (!provenance.ok) return refuse(provenance.code, provenance.summary);
  if (!provenance.messageId) return refuse("invalid_input", "Nothing to attach.");

  let attached = 0;
  for (const id of ids) {
    // Scoped read: an evidence id from another project is simply not here.
    const row = await store.getEvidence(ctx.projectId, id);
    if (!row) continue;
    await store.updateEvidence(id, {
      messageId: provenance.messageId,
      runId: provenance.runId ?? row.runId,
    });
    attached += 1;
  }
  return { ok: true, payload: { attached } };
};

/** Reservations nobody ever uploaded to. Ready evidence is left alone. */
export const cleanupStaleUploads = async (store: IntakeStore, projectId: string): Promise<number> => {
  const cutoff = new Date(store.now().getTime() - STALE_UPLOAD_TTL_MS).toISOString();
  const stale = await store.staleUploading(projectId, cutoff);
  let removed = 0;
  for (const row of stale) {
    if (row.status !== "uploading") continue;
    await store.removeObject(row.storagePath).catch(() => undefined);
    await store.deleteEvidence(row.id);
    removed += 1;
  }
  return removed;
};
