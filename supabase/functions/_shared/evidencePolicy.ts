/**
 * Evidence intake policy.
 *
 * Everything the browser says about an attachment — its name, its type, its
 * size, where it should live — is a claim. This module turns a claim into a
 * bounded, sanitized, server-decided fact, or refuses it.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers, so the release gate can
 * execute it directly.
 */

export type EvidenceKind = "image" | "video" | "pdf" | "text" | "log" | "har" | "json" | "csv" | "other";

export type EvidenceRejection =
  | "unsupported_type"
  | "file_too_large"
  | "too_many_attachments"
  | "invalid_filename"
  | "invalid_metadata";

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** One row per accepted type. The mime is decided here, never by the client. */
type TypeRule = { extensions: string[]; mimes: string[]; kind: EvidenceKind; maxBytes: number; canonicalMime: string };

const MB = 1024 * 1024;

const RULES: TypeRule[] = [
  { extensions: ["png"], mimes: ["image/png"], kind: "image", maxBytes: 15 * MB, canonicalMime: "image/png" },
  { extensions: ["jpg", "jpeg"], mimes: ["image/jpeg"], kind: "image", maxBytes: 15 * MB, canonicalMime: "image/jpeg" },
  { extensions: ["webp"], mimes: ["image/webp"], kind: "image", maxBytes: 15 * MB, canonicalMime: "image/webp" },
  { extensions: ["mp4"], mimes: ["video/mp4"], kind: "video", maxBytes: 100 * MB, canonicalMime: "video/mp4" },
  { extensions: ["webm"], mimes: ["video/webm"], kind: "video", maxBytes: 100 * MB, canonicalMime: "video/webm" },
  { extensions: ["mov"], mimes: ["video/quicktime"], kind: "video", maxBytes: 100 * MB, canonicalMime: "video/quicktime" },
  { extensions: ["pdf"], mimes: ["application/pdf"], kind: "pdf", maxBytes: 25 * MB, canonicalMime: "application/pdf" },
  { extensions: ["txt", "md"], mimes: ["text/plain", "text/markdown"], kind: "text", maxBytes: 10 * MB, canonicalMime: "text/plain" },
  { extensions: ["log"], mimes: ["text/plain"], kind: "log", maxBytes: 10 * MB, canonicalMime: "text/plain" },
  { extensions: ["har"], mimes: ["application/json", "application/har+json"], kind: "har", maxBytes: 15 * MB, canonicalMime: "application/json" },
  { extensions: ["json"], mimes: ["application/json"], kind: "json", maxBytes: 15 * MB, canonicalMime: "application/json" },
  { extensions: ["csv"], mimes: ["text/csv"], kind: "csv", maxBytes: 15 * MB, canonicalMime: "text/csv" },
];

export const SUPPORTED_EXTENSIONS = RULES.flatMap((rule) => rule.extensions);

/** Human-readable limits, so the interface can state the truth it enforces. */
export const EVIDENCE_LIMITS = {
  maxAttachments: MAX_ATTACHMENTS_PER_MESSAGE,
  image: 15 * MB,
  video: 100 * MB,
  pdf: 25 * MB,
  text: 10 * MB,
  log: 10 * MB,
  har: 15 * MB,
  json: 15 * MB,
  csv: 15 * MB,
  other: 0,
} as const;

const extensionOf = (filename: string): string => {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
};

/**
 * A filename is display text, never a path. Directory separators, traversal
 * segments, control characters, NUL bytes and leading dots are removed rather
 * than escaped, and the result is bounded.
 */
export const sanitizeFilename = (raw: unknown): string => {
  const input = typeof raw === "string" ? raw : "";
  // Take the last segment of anything path-shaped, then strip what remains.
  const base = input.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : "attachment";
};

export type EvidenceClaim = {
  filename: unknown;
  mimeType: unknown;
  sizeBytes: unknown;
};

export type EvidenceDecision =
  | {
      ok: true;
      safeFilename: string;
      originalFilename: string;
      mimeType: string;
      kind: EvidenceKind;
      sizeBytes: number;
      maxBytes: number;
    }
  | { ok: false; code: EvidenceRejection; summary: string; maxBytes?: number };

const bytesLabel = (bytes: number) => `${Math.round(bytes / MB)} MB`;

/**
 * The single decision point. The extension decides the type; a client-supplied
 * MIME is only allowed to agree with it, never to widen it.
 */
export const decideEvidence = (claim: EvidenceClaim): EvidenceDecision => {
  const original = typeof claim.filename === "string" ? claim.filename : "";
  if (original.trim().length === 0) {
    return { ok: false, code: "invalid_filename", summary: "That file arrived without a name, so I didn't store it." };
  }

  const safeFilename = sanitizeFilename(original);
  const extension = extensionOf(safeFilename);
  const rule = RULES.find((item) => item.extensions.includes(extension));
  if (!rule) {
    return {
      ok: false,
      code: "unsupported_type",
      summary: `I can't take ${extension ? `.${extension}` : "that"} files yet. I can read images, video, PDFs, logs, text, HAR, JSON and CSV.`,
    };
  }

  const size = typeof claim.sizeBytes === "number" && Number.isFinite(claim.sizeBytes) ? Math.floor(claim.sizeBytes) : -1;
  if (size < 0) {
    return { ok: false, code: "invalid_metadata", summary: "I couldn't tell how big that file is, so I didn't store it." };
  }
  if (size === 0) {
    return { ok: false, code: "invalid_metadata", summary: "That file is empty, so there's nothing for me to read." };
  }
  if (size > rule.maxBytes) {
    return {
      ok: false,
      code: "file_too_large",
      summary: `That file is larger than the ${bytesLabel(rule.maxBytes)} limit for ${rule.kind} evidence.`,
      maxBytes: rule.maxBytes,
    };
  }

  const claimed = typeof claim.mimeType === "string" ? claim.mimeType.split(";")[0].trim().toLowerCase() : "";
  const mimeType = rule.mimes.includes(claimed) ? claimed : rule.canonicalMime;

  return {
    ok: true,
    safeFilename,
    originalFilename: original.slice(0, 240),
    mimeType,
    kind: rule.kind,
    sizeBytes: size,
    maxBytes: rule.maxBytes,
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/**
 * The object key. Derived only from server-held identifiers plus the already
 * sanitized filename, so no client string can ever escape its project folder.
 */
export const storagePathFor = (projectId: string, evidenceId: string, safeFilename: string): string => {
  if (!isUuid(projectId) || !isUuid(evidenceId)) {
    throw new Error("evidence path requires server-issued identifiers");
  }
  return `${projectId}/${evidenceId}/${sanitizeFilename(safeFilename)}`;
};

/** Kinds whose content can be read as text by the server without a model. */
export const TEXTUAL_KINDS: EvidenceKind[] = ["text", "log", "har", "json", "csv"];

/** Kinds that need a multimodal model to be understood at all. */
export const MULTIMODAL_KINDS: EvidenceKind[] = ["image", "pdf"];
