/**
 * Byte-level evidence validation.
 *
 * `register` only ever sees what the browser *claims*. This module runs at
 * commit time against the bytes that actually landed in storage, so a file
 * renamed `.txt`, a 2 GB payload declared as 2 KB, or an executable wearing a
 * `.png` extension all fail before anything reads them.
 *
 * Pure TypeScript: no Deno globals, no npm specifiers.
 */

import { type EvidenceKind, maxBytesFor } from "./evidencePolicy.ts";

export type ByteRejection =
  | "size_mismatch"
  | "file_too_large"
  | "empty_upload"
  | "signature_mismatch"
  | "binary_content"
  | "malformed_json";

export type ByteVerdict = { ok: true } | { ok: false; code: ByteRejection; summary: string };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  let out = "";
  for (let index = offset; index < Math.min(bytes.length, offset + length); index += 1) {
    out += String.fromCharCode(bytes[index]);
  }
  return out;
};

/** Container signatures we can check cheaply and honestly. */
const signatureOk = (mimeType: string, bytes: Uint8Array): boolean => {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "video/mp4":
    case "video/quicktime":
      // ISO base media: a size prefix then the `ftyp` box.
      return ascii(bytes, 4, 4) === "ftyp";
    case "video/webm":
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return true;
  }
};

const SIGNATURE_CHECKED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export const isSignatureChecked = (mimeType: string): boolean => SIGNATURE_CHECKED.has(mimeType);

/**
 * Text-shaped kinds must actually be text. A NUL byte, or a heavy run of
 * control bytes, means someone renamed a binary — decoding it would produce
 * garbage the agent might then quote as an observation.
 */
export const looksBinary = (bytes: Uint8Array): boolean => {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Everything outside printable ASCII / common whitespace, allowing UTF-8
    // continuation bytes (>= 0x80) which are legitimate in text.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) suspicious += 1;
  }
  return suspicious / sample.length > 0.02;
};

export const TEXTUAL_BYTE_KINDS: EvidenceKind[] = ["text", "log", "har", "json", "csv"];

/**
 * The authoritative gate. Bucket metadata and client claims are defence in
 * depth; this is the decision.
 */
export const validateEvidenceBytes = (input: {
  kind: EvidenceKind;
  mimeType: string;
  bytes: Uint8Array;
  declaredSize: number;
}): ByteVerdict => {
  const { kind, mimeType, bytes, declaredSize } = input;
  const actual = bytes.byteLength;

  if (actual === 0) {
    return { ok: false, code: "empty_upload", summary: "That upload arrived empty, so there's nothing for me to read." };
  }

  const max = maxBytesFor(kind);
  if (actual > max) {
    return {
      ok: false,
      code: "file_too_large",
      summary: `The file that arrived is larger than the ${Math.round(max / (1024 * 1024))} MB limit for ${kind} evidence.`,
    };
  }

  // The signed upload stores exactly the bytes the browser sent, so the size it
  // declared and the size that landed must agree.
  if (declaredSize > 0 && actual !== declaredSize) {
    return {
      ok: false,
      code: "size_mismatch",
      summary: "What arrived isn't the file that was described to me, so I didn't read it.",
    };
  }

  if (isSignatureChecked(mimeType) && !signatureOk(mimeType, bytes)) {
    return {
      ok: false,
      code: "signature_mismatch",
      summary: "That file isn't really the type its name claims, so I didn't read it.",
    };
  }

  if (TEXTUAL_BYTE_KINDS.includes(kind) && looksBinary(bytes)) {
    return {
      ok: false,
      code: "binary_content",
      summary: "That file is binary rather than text, so I didn't try to read it as text.",
    };
  }

  return { ok: true };
};

/** JSON and HAR must parse before anything treats them as structured. */
export const parsesAsJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};
