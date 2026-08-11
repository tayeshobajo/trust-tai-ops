/**
 * Deterministic credential parsing, detection and redaction.
 *
 * Pure TypeScript on purpose: no Deno globals, no npm specifiers, no I/O. The
 * same code that decides what a pasted message contains is exercised directly
 * by `npm run check:chat-secrets`.
 *
 * Nothing here stores, transmits or logs anything. It turns text into a
 * structured description of what was shared, plus a sanitized rendering of
 * that text with every secret value removed.
 */

export type IntakeAccessType = "wordpress_admin" | "ssh" | "sftp" | "ftp";

export type CredentialProvider =
  | "wordpress_application_password"
  | "wordpress_login_password"
  | "ssh_private_key"
  | "sftp_password"
  | "ftp_password";

export type ParsedBundle = {
  accessType: IntakeAccessType;
  provider: CredentialProvider;
  username: string;
  /** Transient. Never persisted outside the encrypted secret store. */
  secret: string;
  host?: string;
  port?: number;
  passphrase?: string;
  siteUrl?: string;
  adminUrl?: string;
};

export type MissingCredential = { accessType: IntakeAccessType; fields: string[] };

export type ParsedIntake = {
  /** True only when a labelled secret value or PEM block is actually present. */
  containsSecrets: boolean;
  /** Access kinds the message talks about, whether or not details came with it. */
  requested: IntakeAccessType[];
  bundles: ParsedBundle[];
  missing: MissingCredential[];
  /** Every http(s) address mentioned, normalized. */
  urls: string[];
  /** The non-credential sentences, so intent survives sanitization. */
  intent: string[];
};

type Section = "wordpress" | "ssh" | "sftp" | "ftp" | "unknown";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Markdown links, escaped punctuation and angle-bracket URLs all flatten. */
export const normalizeLine = (line: string): string =>
  line
    .replace(MARKDOWN_LINK, (_match, label: string, target: string) =>
      /^(https?:|mailto:)/i.test(target) ? target.replace(/^mailto:/i, "") : label,
    )
    .replace(/\\([_*`[\]()#+\-.!:@/])/g, "$1")
    .replace(/^\s*[*\-•]\s+/, "")
    .replace(/<(https?:\/\/[^>\s]+)>/gi, "$1")
    .replace(/<([^@>\s]+@[^>\s]+)>/g, "$1")
    .trimEnd();

const trimValue = (value: string): string =>
  value
    .trim()
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .replace(/[.,;]+$/, "")
    .trim();

export const normalizeUrl = (value: string): string => {
  const raw = trimValue(value).replace(/^["'<]+|[">']+$/g, "");
  if (!raw) return "";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
};

export const hostOf = (value: string): string => {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** `a.example.com` matches `example.com`; `exampleevil.com` never does. */
export const sameSite = (candidate: string, canonical: string): boolean => {
  const a = candidate.toLowerCase().replace(/^www\./, "");
  const b = canonical.toLowerCase().replace(/^www\./, "");
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
};

// ---------------------------------------------------------------------------
// Secret detection and redaction (defence in depth)
// ---------------------------------------------------------------------------

const SECRET_LABEL =
  /\b(?:app(?:lication)?[ _-]?password|password|passwd|pwd|passphrase|private[ _-]?key|secret[ _-]?key|api[ _-]?key|access[ _-]?token|bearer[ _-]?token|auth[ _-]?token|token)\b/i;

// Three groups: leading boundary, the label itself, then the value that must
// never survive. The label is kept so a redacted line still reads plainly.
const LABELLED_SECRET = new RegExp(`(^|[\\s([{])(${SECRET_LABEL.source})\\s*[:=]\\s*(\\S.*)$`, "gim");

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_OPENING = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const BEARER_INLINE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;

/**
 * True only when a labelled secret carries an actual value, or a PEM block is
 * present. Prose such as "password reset" or "the login page is broken" is
 * never a credential bundle.
 */
export const containsSecretMaterial = (text: string): boolean => {
  if (PEM_OPENING.test(text)) return true;
  if (new RegExp(BEARER_INLINE.source, "i").test(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    const normalized = normalizeLine(line);
    const match = normalized.match(new RegExp(`${SECRET_LABEL.source}\\s*[:=]\\s*(\\S.*)$`, "i"));
    if (match && trimValue(match[1] ?? "").length >= 3) return true;
  }
  return false;
};

/**
 * Last safety net before any persistence boundary. Never the storage
 * mechanism, and never relied on as the security boundary.
 */
export const redactSecrets = (text: string): string =>
  text
    .replace(PEM_BLOCK, "[private key redacted]")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, "[private key redacted]")
    .replace(BEARER_INLINE, "Bearer [redacted]")
    .replace(LABELLED_SECRET, (_match, lead: string, label: string) => `${lead}${label}: [redacted]`);

export const redactBody = (body: string[]): string[] => body.map((line) => redactSecrets(line));

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SECTION_PREFIX = /^(s?ftp|ssh|wordpress|wp)[ _-]?/i;

const sectionFromWord = (word: string): Section => {
  const value = word.toLowerCase();
  if (value === "sftp") return "sftp";
  if (value === "ftp") return "ftp";
  if (value === "ssh") return "ssh";
  return "wordpress";
};

type Field =
  | "siteUrl"
  | "adminUrl"
  | "identity"
  | "password"
  | "appPassword"
  | "host"
  | "port"
  | "username"
  | "privateKey"
  | "passphrase"
  | "protocol";

const FIELD_RULES: Array<{ re: RegExp; field: Field; section?: Section }> = [
  { re: /^(?:wp[ _-]?admin|wp[ _-]?admin[ _-]?url|admin[ _-]?url|admin[ _-]?login|dashboard)$/i, field: "adminUrl", section: "wordpress" },
  { re: /^(?:url|site|site[ _-]?url|website|domain|wordpress[ _-]?url)$/i, field: "siteUrl", section: "wordpress" },
  { re: /^(?:app(?:lication)?[ _-]?password)$/i, field: "appPassword", section: "wordpress" },
  { re: /^(?:email|e-?mail|login|user[ _-]?email)$/i, field: "identity", section: "wordpress" },
  { re: /^(?:host|hostname|server|ip|ip[ _-]?address)$/i, field: "host" },
  { re: /^(?:port)$/i, field: "port" },
  { re: /^(?:protocol)$/i, field: "protocol" },
  { re: /^(?:private[ _-]?key|key)$/i, field: "privateKey" },
  { re: /^(?:passphrase|key[ _-]?passphrase)$/i, field: "passphrase" },
  { re: /^(?:user|username|user[ _-]?name|account)$/i, field: "username" },
  { re: /^(?:password|passwd|pwd|pass)$/i, field: "password" },
];

type LabelHit = { field: Field; value: string; section: Section | null };

const readLabel = (line: string): LabelHit | null => {
  const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _./-]{0,40}?)\s*[:=]\s*(.*)$/);
  if (!match) return null;
  let label = match[1].trim();
  const value = match[2] ?? "";

  let section: Section | null = null;
  const prefix = label.match(SECTION_PREFIX);
  if (prefix) {
    const rest = label.slice(prefix[0].length).trim();
    // "FTP" alone is a section heading, not a labelled field.
    if (rest.length > 0) {
      section = sectionFromWord(prefix[1]);
      label = rest;
    }
  }

  for (const rule of FIELD_RULES) {
    if (rule.re.test(label)) {
      return { field: rule.field, value, section: section ?? rule.section ?? null };
    }
  }
  return null;
};

const HEADING = /^\s*(sftp|ftp|ssh|wordpress|wp[ _-]?admin)\b[^A-Za-z0-9]*$/i;

const URL_ANYWHERE = /https?:\/\/[^\s<>"')]+/gi;

const emptyFileSection = () => ({
  host: "",
  port: 0,
  username: "",
  password: "",
  privateKey: "",
  passphrase: "",
  protocol: "",
});

type FileSection = ReturnType<typeof emptyFileSection>;

export const parseCredentialText = (input: string): ParsedIntake => {
  const rawLines = input.split(/\r?\n/);
  const lines = rawLines.map(normalizeLine);

  const wp = { siteUrl: "", adminUrl: "", identity: "", password: "", appPassword: "" };
  const files: Record<"ssh" | "sftp" | "ftp", FileSection> = {
    ssh: emptyFileSection(),
    sftp: emptyFileSection(),
    ftp: emptyFileSection(),
  };

  let current: Section = "unknown";
  const intent: string[] = [];
  const urls: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    for (const found of line.match(URL_ANYWHERE) ?? []) {
      const normalized = normalizeUrl(found);
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
    }

    const heading = line.match(HEADING);
    if (heading) {
      current = sectionFromWord(heading[1].replace(/[ _-].*$/, ""));
      continue;
    }

    // A PEM block runs until its END line and belongs to the active section.
    if (PEM_OPENING.test(line)) {
      const collected: string[] = [];
      let cursor = index;
      while (cursor < rawLines.length) {
        collected.push(rawLines[cursor]);
        if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(rawLines[cursor])) break;
        cursor += 1;
      }
      const target = current === "sftp" || current === "ftp" ? current : "ssh";
      files[target].privateKey = collected.join("\n").trim();
      if (current === "unknown" || current === "wordpress") current = "ssh";
      index = cursor;
      continue;
    }

    const hit = readLabel(line);
    if (!hit) {
      intent.push(line.trim());
      continue;
    }

    const section: Section = hit.section ?? (current === "unknown" ? "wordpress" : current);
    if (hit.section) current = hit.section;

    const value = trimValue(hit.value);
    if (!value) continue;

    if (section === "wordpress") {
      if (hit.field === "siteUrl") wp.siteUrl = normalizeUrl(value) || wp.siteUrl;
      else if (hit.field === "adminUrl") wp.adminUrl = normalizeUrl(value) || wp.adminUrl;
      else if (hit.field === "identity" || hit.field === "username") wp.identity = wp.identity || value;
      else if (hit.field === "appPassword") wp.appPassword = value;
      else if (hit.field === "password") wp.password = value;
      else if (hit.field === "privateKey" || hit.field === "passphrase") {
        // A key under a WordPress heading is a server credential, not a site one.
        files.ssh[hit.field] = value;
        current = "ssh";
      }
      continue;
    }

    if (section === "ssh" || section === "sftp" || section === "ftp") {
      const bucket = files[section];
      if (hit.field === "host") bucket.host = hostOf(value) || value.replace(/^\w+:\/\//, "").split("/")[0];
      else if (hit.field === "port") bucket.port = Number.parseInt(value, 10) || 0;
      else if (hit.field === "username" || hit.field === "identity") bucket.username = value;
      else if (hit.field === "password") bucket.password = value;
      else if (hit.field === "privateKey") bucket.privateKey = value;
      else if (hit.field === "passphrase") bucket.passphrase = value;
      else if (hit.field === "protocol") bucket.protocol = value.toLowerCase();
      else if (hit.field === "siteUrl" || hit.field === "adminUrl") {
        const normalized = normalizeUrl(value);
        if (normalized && !urls.includes(normalized)) urls.push(normalized);
      }
    }
  }

  // -- what the message asked about -----------------------------------------
  const lower = input.toLowerCase();
  const requested: IntakeAccessType[] = [];
  const mention = (re: RegExp, type: IntakeAccessType) => {
    if (re.test(lower) && !requested.includes(type)) requested.push(type);
  };
  mention(/\bwp[ -]?admin\b|\bwordpress\b|\bwp\b/, "wordpress_admin");
  mention(/\bsftp\b/, "sftp");
  mention(/(^|[^s])\bftp\b/, "ftp");
  mention(/\bssh\b/, "ssh");

  // -- bundles ---------------------------------------------------------------
  const bundles: ParsedBundle[] = [];

  if (wp.identity && (wp.appPassword || wp.password)) {
    bundles.push({
      accessType: "wordpress_admin",
      provider: wp.appPassword ? "wordpress_application_password" : "wordpress_login_password",
      username: wp.identity,
      secret: wp.appPassword || wp.password,
      siteUrl: wp.siteUrl || undefined,
      adminUrl: wp.adminUrl || undefined,
    });
  }

  const sshLike = (["ssh", "sftp", "ftp"] as const).map((key) => ({ key, bucket: files[key] }));
  for (const { key, bucket } of sshLike) {
    // An explicit protocol overrides the heading it was written under.
    const declared: "ssh" | "sftp" | "ftp" =
      bucket.protocol === "sftp" ? "sftp" : bucket.protocol === "ftp" ? "ftp" : bucket.protocol === "ssh" ? "ssh" : key;

    if (bucket.privateKey && bucket.username && bucket.host) {
      bundles.push({
        accessType: declared === "ftp" ? "sftp" : declared,
        provider: "ssh_private_key",
        username: bucket.username,
        secret: bucket.privateKey,
        host: bucket.host,
        port: bucket.port || 22,
        passphrase: bucket.passphrase || undefined,
      });
      continue;
    }
    if (bucket.password && bucket.username && bucket.host) {
      bundles.push({
        accessType: declared === "ftp" ? "ftp" : declared === "ssh" ? "ssh" : "sftp",
        provider: declared === "ftp" ? "ftp_password" : "sftp_password",
        username: bucket.username,
        secret: bucket.password,
        host: bucket.host,
        port: bucket.port || (declared === "ftp" ? 21 : 22),
      });
    }
  }

  // -- what is missing -------------------------------------------------------
  const missing: MissingCredential[] = [];
  for (const type of requested) {
    if (bundles.some((bundle) => bundle.accessType === type)) continue;
    if (type === "wordpress_admin") {
      const fields = [
        wp.identity ? "" : "username or email",
        wp.appPassword || wp.password ? "" : "password or application password",
      ].filter(Boolean);
      if (fields.length) missing.push({ accessType: type, fields });
      continue;
    }
    // ssh/sftp/ftp all need the same minimum shape.
    const bucket = files[type === "wordpress_admin" ? "ssh" : type];
    const fields = [
      bucket.host ? "" : "host",
      bucket.username ? "" : "username",
      bucket.password || bucket.privateKey ? "" : type === "ssh" ? "private key or password" : "password or private key",
    ].filter(Boolean);
    if (fields.length) missing.push({ accessType: type, fields });
  }

  return {
    containsSecrets: containsSecretMaterial(input),
    requested,
    bundles,
    missing,
    urls,
    intent: intent.filter((line) => !containsSecretMaterial(line)),
  };
};

// ---------------------------------------------------------------------------
// Sanitized rendering
// ---------------------------------------------------------------------------

export const accessLabel = (type: IntakeAccessType): string =>
  type === "wordpress_admin" ? "WordPress Admin" : type === "ssh" ? "SSH" : type === "sftp" ? "SFTP" : "FTP";

export const providerLabel = (provider: CredentialProvider): string =>
  provider === "wordpress_application_password"
    ? "Application Password"
    : provider === "wordpress_login_password"
      ? "normal login password"
      : provider === "ssh_private_key"
        ? "private key"
        : provider === "sftp_password"
          ? "password"
          : "password";

/**
 * The message that replaces the raw paste in the conversation. Intent and
 * context survive; no secret value ever appears.
 */
export const sanitizedIntakeMessage = (input: {
  site: string;
  stored: Array<{ accessType: IntakeAccessType; provider: CredentialProvider }>;
  missing: MissingCredential[];
  intent: string[];
}): string[] => {
  const lines: string[] = [];
  lines.push(input.site ? `Confirm access for ${input.site}.` : "Confirm access for this project.");

  if (input.stored.length > 0) {
    const parts = input.stored.map(
      (item) => `${accessLabel(item.accessType)} (${providerLabel(item.provider)})`,
    );
    lines.push(`Credentials shared securely: ${parts.join(", ")}.`);
  } else {
    lines.push("Credentials shared securely: none were complete enough to store.");
  }

  for (const gap of input.missing) {
    lines.push(
      `${accessLabel(gap.accessType)} access was requested but no ${accessLabel(gap.accessType)} credentials were included (missing ${gap.fields.join(", ")}).`,
    );
  }

  const context = input.intent
    .map((line) => redactSecrets(line).trim())
    .filter((line) => line.length > 0 && !/^confirm you can access/i.test(line))
    .slice(0, 4);
  if (context.length) lines.push(context.join(" "));

  return lines;
};
