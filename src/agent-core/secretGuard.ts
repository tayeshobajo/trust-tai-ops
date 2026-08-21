/**
 * Client-side secret detection and redaction.
 *
 * This is a user-experience aid and a last safety net — never the security
 * boundary. The server repeats every check in
 * `supabase/functions/_shared/credentialText.ts`, and `npm run check:chat-secrets`
 * asserts the two agree on the same corpus.
 *
 * Nothing here stores or transmits anything.
 */

const SECRET_LABEL =
  "(?:app(?:lication)?[ _-]?password|password|passwd|pwd|passphrase|private[ _-]?key|secret[ _-]?key|api[ _-]?key|access[ _-]?token|bearer[ _-]?token|auth[ _-]?token|token)";

const LABELLED_SECRET = new RegExp(`(^|[\\s([{])(${SECRET_LABEL})\\s*[:=]\\s*(\\S.*)$`, "gim");
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_OPENING = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const BEARER_INLINE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

const normalizeLine = (line: string): string =>
  line
    .replace(MARKDOWN_LINK, (_match, label: string, target: string) =>
      /^(https?:|mailto:)/i.test(target) ? target.replace(/^mailto:/i, "") : label,
    )
    .replace(/\\([_*`[\]()#+\-.!:@/])/g, "$1")
    .replace(/^\s*[*\-•]\s+/, "")
    .trimEnd();

const trimValue = (value: string): string =>
  value.trim().replace(/^[`"'“”]+|[`"'“”]+$/g, "").replace(/[.,;]+$/, "").trim();

/**
 * True only when a labelled secret carries a real value, or a private key
 * block is present. Ordinary phrases such as "password reset", "login page"
 * or "FTP issue" are never credentials.
 */
export const containsSecretMaterial = (text: string): boolean => {
  if (PEM_OPENING.test(text)) return true;
  if (new RegExp(BEARER_INLINE.source, "i").test(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    const match = normalizeLine(line).match(new RegExp(`${SECRET_LABEL}\\s*[:=]\\s*(\\S.*)$`, "i"));
    if (match && trimValue(match[1] ?? "").length >= 3) return true;
  }
  return false;
};

/**
 * `sftp://user:pass@host:2222` and friends. Host welcome emails are full of
 * these, and the value after the colon is a real credential.
 */
const CONNECTION_URL =
  /\b(?:sftp|ftp|ftps|ssh|mysql):\/\/[^\s:@/]+(?::[^\s@/]+)?@[A-Za-z0-9.-]+(?::\d{1,5})?/i;

const HOSTNAME_LINE = /^(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const IP_LINE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const USERNAME_LINE = /^[A-Za-z0-9._-]{2,64}$/;

/**
 * A bare paste with no labels at all — a host line, a user line and a secret
 * line — is still access. Deliberately conservative: a few short tokens, no
 * prose, one recognisable host.
 */
export const inferBareBundle = (
  input: string,
): { host: string; username: string; secret: string } | null => {
  const lines = input
    .split(/\r?\n/)
    .map((line) => normalizeLine(line).trim())
    .filter(Boolean);
  if (lines.length < 3 || lines.length > 5) return null;
  if (lines.some((line) => /\s/.test(line) || line.includes(":") || line.includes("="))) return null;

  const hostIndex = lines.findIndex((line) => HOSTNAME_LINE.test(line) || IP_LINE.test(line));
  if (hostIndex < 0) return null;
  const rest = lines.filter((_, index) => index !== hostIndex);

  const userIndex = rest.findIndex((line) => USERNAME_LINE.test(line) && !/[!#$%^&*()+]/.test(line));
  if (userIndex < 0) return null;
  const secret = rest.filter((_, index) => index !== userIndex).find((line) => line.length >= 6);
  if (!secret) return null;

  return { host: lines[hostIndex], username: rest[userIndex], secret };
};

/**
 * Everything that must go through secure intake rather than the conversation:
 * labelled secrets, connection URLs, and unlabelled host/user/secret pastes.
 */
export const looksLikeAccessText = (text: string): boolean =>
  containsSecretMaterial(text) || CONNECTION_URL.test(text) || inferBareBundle(text) !== null;

/** Removes secret values while leaving the sentence readable. */

export const redactSecrets = (text: string): string =>
  text
    .replace(PEM_BLOCK, "[private key redacted]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, "[private key redacted]")
    .replace(BEARER_INLINE, "Bearer [redacted]")
    .replace(LABELLED_SECRET, (_match, lead: string, label: string) => `${lead}${label}: [redacted]`);

export const redactBody = (body: string[]): string[] => body.map((line) => redactSecrets(line));
