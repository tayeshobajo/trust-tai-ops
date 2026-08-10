/**
 * Server-only credential encryption.
 *
 * AES-256-GCM, key supplied by a server-only function secret. There is no
 * decryption path reachable from the browser, and no plaintext fallback: when
 * the key is absent the caller must fail with `secret_store_unavailable`.
 */

export const ENCRYPTION_KEY_ENV = "AGENT_SECRET_ENCRYPTION_KEY";
export const KEY_VERSION = "v1";
export const ALGORITHM = "AES-256-GCM";

export type SealedSecret = { ciphertext: string; iv: string; algorithm: string; keyVersion: string };

export type KeyResult = { ok: true; key: Uint8Array } | { ok: false; code: "secret_store_unavailable" };

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/**
 * Accepts a raw 256-bit key as hex or base64. Any other sufficiently long
 * high-entropy string is stretched to 256 bits with SHA-256, so a generated
 * alphanumeric secret is usable without ever falling back to a weak key.
 */
export const parseEncryptionKey = async (raw: string | undefined | null): Promise<KeyResult> => {
  if (!raw || raw.trim().length === 0) return { ok: false, code: "secret_store_unavailable" };
  const value = raw.trim();
  try {
    if (/^[0-9a-f]{64}$/i.test(value)) {
      const bytes = new Uint8Array(32);
      for (let index = 0; index < 32; index += 1) {
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      return { ok: true, key: bytes };
    }
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      const bytes = fromBase64(value);
      if (bytes.length === 32) return { ok: true, key: bytes };
    }
    // Too short to stretch safely: refuse rather than accept a weak key.
    if (value.length < 32) return { ok: false, code: "secret_store_unavailable" };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return { ok: true, key: new Uint8Array(digest) };
  } catch {
    return { ok: false, code: "secret_store_unavailable" };
  }
};

const importKey = (key: Uint8Array) =>
  crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);

export const sealSecret = async (plaintext: string, key: Uint8Array): Promise<SealedSecret> => {
  const cryptoKey = await importKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
  return {
    ciphertext: toBase64(new Uint8Array(sealed)),
    iv: toBase64(iv),
    algorithm: ALGORITHM,
    keyVersion: KEY_VERSION,
  };
};

export type OpenResult = { ok: true; plaintext: string } | { ok: false; code: "secret_store_unavailable" };

export const openSecret = async (sealed: SealedSecret, key: Uint8Array): Promise<OpenResult> => {
  try {
    const cryptoKey = await importKey(key);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv) as unknown as ArrayBuffer },
      cryptoKey,
      fromBase64(sealed.ciphertext) as unknown as ArrayBuffer,
    );
    return { ok: true, plaintext: new TextDecoder().decode(opened) };
  } catch {
    // Wrong key, tampered ciphertext, or a rotated key version.
    return { ok: false, code: "secret_store_unavailable" };
  }
};