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

export type IntakeAccessType =
  | "wordpress_admin"
  | "ssh"
  | "sftp"
  | "ftp"
  | "google_search_console"
  | "hosting_portal"
  | "database"
  | "cdn";

export type CredentialProvider =
  | "wordpress_application_password"
  | "wordpress_login_password"
  | "ssh_private_key"
  | "sftp_password"
  | "ftp_password"
  | "google_service_account"
  | "hosting_panel_password"
  | "database_password"
  | "api_token";

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

type Section = "wordpress" | "ssh" | "sftp" | "ftp" | "hosting" | "database" | "cdn" | "unknown";

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
  const value = word.toLowerCase().replace(/[ _-]/g, "");
  if (value === "sftp") return "sftp";
  if (value === "ftp") return "ftp";
  if (value === "ssh") return "ssh";
  if (/^(hosting|host(ing)?panel|controlpanel|cpanel|plesk|whm|siteground|wpengine|kinsta|panel|staging)$/.test(value)) {
    return "hosting";
  }
  if (/^(database|db|mysql|mariadb|phpmyadmin)$/.test(value)) return "database";
  if (/^(cloudflare|cdn|fastly)$/.test(value)) return "cdn";
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
  // "Wp-admin:" arrives here as the bare word "admin" once the section prefix
  // has been peeled off.
  { re: /^(?:admin|wp[ _-]?admin|wp[ _-]?admin[ _-]?url|admin[ _-]?url|admin[ _-]?login|admin[ _-]?page|dashboard|dashboard[ _-]?url|login[ _-]?url|login[ _-]?page)$/i, field: "adminUrl", section: "wordpress" },
  { re: /^(?:url|site|site[ _-]?url|site[ _-]?address|website|domain|wordpress[ _-]?url|home[ _-]?url|home)$/i, field: "siteUrl", section: "wordpress" },
  { re: /^(?:app(?:lication)?[ _-]?password)$/i, field: "appPassword", section: "wordpress" },
  { re: /^(?:admin[ _-]?)?(?:email|e-?mail|login|user[ _-]?email|wp[ _-]?user|wp[ _-]?login)$/i, field: "identity", section: "wordpress" },
  { re: /^(?:host|hostname|host[ _-]?name|server|address|host[ _-]?address|server[ _-]?address|ip|ip[ _-]?address|sftp[ _-]?host|ftp[ _-]?host)$/i, field: "host" },
  { re: /^(?:port|port[ _-]?number|sftp[ _-]?port|ftp[ _-]?port)$/i, field: "port" },
  { re: /^(?:protocol|type)$/i, field: "protocol" },
  { re: /^(?:private[ _-]?key|ssh[ _-]?key|key)$/i, field: "privateKey" },
  { re: /^(?:passphrase|key[ _-]?passphrase|ssh[ _-]?passphrase)$/i, field: "passphrase" },
  { re: /^(?:user|username|user[ _-]?name|account|sftp[ _-]?user|ftp[ _-]?user|ssh[ _-]?user)$/i, field: "username" },
  { re: /^(?:password|passwd|pwd|pass|sftp[ _-]?password|ftp[ _-]?password|ssh[ _-]?password)$/i, field: "password" },
];

// ---------------------------------------------------------------------------
// Inline label expansion
// ---------------------------------------------------------------------------
//
// People paste credentials as one run-on line:
//   "SFTP Address: host Port Number: 2222 Username: bob Password: hunter2"
// The parser is line-based, so a second label on the same line would be
// swallowed into the previous value. Every recognised label after the first
// one starts its own line before parsing begins.

const INLINE_LABEL = new RegExp(
  "(?:\\b(?:s?ftp|ssh|wordpress|wp)[ _-]?)?" +
    "\\b(?:" +
    "app(?:lication)?[ _-]?password|password|passwd|pwd|pass" +
    "|passphrase|private[ _-]?key" +
    "|host(?:[ _-]?name)?|server(?:[ _-]?address)?|address|ip(?:[ _-]?address)?" +
    "|port(?:[ _-]?number)?|protocol" +
    "|user(?:[ _-]?name)?|username|account" +
    "|admin(?:[ _-]?(?:url|login|email))?|e-?mail|email|login" +
    "|site(?:[ _-]?url)?|website|domain|url" +
    ")\\s*[:=]",
  "gi",
);

const splitInlineLabels = (line: string): string[] => {
  const starts: number[] = [];
  INLINE_LABEL.lastIndex = 0;
  for (let match = INLINE_LABEL.exec(line); match; match = INLINE_LABEL.exec(line)) {
    starts.push(match.index);
  }
  if (starts.length < 2) return [line];

  const segments: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = i === 0 ? 0 : starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : line.length;
    const piece = line.slice(from, to).trim();
    if (piece) segments.push(piece);
  }
  return segments;
};

const TABULAR_LABEL = new RegExp(
  "^\\s*(" +
    "app(?:lication)?[ _-]?password|password|passwd|pwd|pass" +
    "|passphrase|private[ _-]?key" +
    "|host(?:[ _-]?name)?|server(?:[ _-]?address)?|address|ip(?:[ _-]?address)?" +
    "|port(?:[ _-]?number)?|protocol" +
    "|user(?:[ _-]?name)?|username|account" +
    "|admin(?:[ _-]?(?:url|login|email))?|e-?mail|email|login" +
    "|site(?:[ _-]?url)?|website|domain|url" +
    ")(?:\\t+|\\s{2,})",
  "i",
);

const convertTabularLine = (line: string): string => {
  const match = line.match(TABULAR_LABEL);
  if (!match) return line;
  const label = match[1];
  const rest = line.slice(match[0].length).trim();
  return `${label}: ${rest}`;
};

/** Run-on credential lines become one labelled field per line. PEM blocks are left alone. */
export const expandInlineLabels = (input: string): string => {
  const out: string[] = [];
  let inPem = false;
  for (const line of input.split(/\r?\n/)) {
    if (PEM_OPENING.test(line)) inPem = true;
    if (inPem) {
      out.push(line);
      if (/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) inPem = false;
      continue;
    }
    const converted = convertTabularLine(line);
    out.push(...splitInlineLabels(converted));
  }
  return out.join("\n");
};

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

const HEADING =
  /^\s*(sftp|ftp|ssh|wordpress|wp[ _-]?admin|google[ _-]?search[ _-]?console|gsc|search[ _-]?console|hosting(?:[ _-]?panel)?|control[ _-]?panel|cpanel|plesk|whm|staging|database|db|mysql|mariadb|phpmyadmin|cloudflare|cdn|fastly)\b[^A-Za-z0-9]*$/i;

/** True when text looks like a Google service account JSON blob. */
const isServiceAccountJson = (text: string): boolean => {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  return /"type"\s*:\s*"service_account"/.test(t) && /"private_key"\s*:/.test(t) && /"client_email"\s*:/.test(t);
};

/** Extracts client_email from a service account JSON string. Never throws. */
const extractServiceAccountEmail = (json: string): string => {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed.client_email === "string" ? parsed.client_email : "";
  } catch {
    return "";
  }
};

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

export const parseCredentialText = (rawInput: string): ParsedIntake => {
  const input = expandInlineLabels(rawInput);
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
  mention(/\bgoogle[ _-]?search[ _-]?console\b|\bsearch[ _-]?console\b|\bgsc\b/, "google_search_console");

  // -- bundles ---------------------------------------------------------------
  const bundles: ParsedBundle[] = [];

  // Google Search Console — detect a service account JSON blob anywhere in input.
  // The whole JSON blob is the secret; client_email becomes the username.
  const gscJsonMatch = (() => {
    // Match a top-level JSON object that starts with { and contains the
    // service_account type marker. We capture the first such block.
    const jsonRe = /\{[\s\S]*?"type"\s*:\s*"service_account"[\s\S]*?\}/g;
    for (const match of (rawInput.match(jsonRe) ?? [])) {
      if (isServiceAccountJson(match)) return match;
    }
    return null;
  })();

  if (gscJsonMatch) {
    const email = extractServiceAccountEmail(gscJsonMatch);
    bundles.push({
      accessType: "google_search_console",
      provider: "google_service_account",
      username: email || "service-account",
      secret: gscJsonMatch,
    });
    // Ensure it was requested if not already picked up by keyword scan.
    if (!requested.includes("google_search_console")) requested.push("google_search_console");
  }

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
  type === "wordpress_admin"
    ? "WordPress Admin"
    : type === "ssh"
      ? "SSH"
      : type === "sftp"
        ? "SFTP"
        : type === "google_search_console"
          ? "Google Search Console"
          : "FTP";

export const providerLabel = (provider: CredentialProvider): string =>
  provider === "wordpress_application_password"
    ? "Application Password"
    : provider === "wordpress_login_password"
      ? "normal login password"
      : provider === "ssh_private_key"
        ? "private key"
        : provider === "sftp_password"
          ? "password"
          : provider === "google_service_account"
            ? "service account key"
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
  /** True when secret-shaped text was seen but no complete bundle could be formed. */
  sawSecretMaterial?: boolean;
}): string[] => {
  const lines: string[] = [];
  lines.push(input.site ? `Confirm access for ${input.site}.` : "Confirm access for this project.");

  if (input.stored.length > 0) {
    const parts = input.stored.map(
      (item) => `${accessLabel(item.accessType)} (${providerLabel(item.provider)})`,
    );
    lines.push(`Credentials stored securely: ${parts.join(", ")}.`);
  } else if (input.missing.length > 0 || input.sawSecretMaterial) {
    lines.push("I saw credential-shaped text but couldn't store it securely yet.");
  } else {
    lines.push("No complete credentials were included.");
  }

  for (const gap of input.missing) {
    lines.push(
      `${accessLabel(gap.accessType)} still needs: ${gap.fields.join(", ")}.`,
    );
  }

  const context = input.intent
    .map((line) => redactSecrets(line).trim())
    .filter((line) => line.length > 0 && !/^confirm you can access/i.test(line))
    .slice(0, 4);
  if (context.length) lines.push(context.join(" "));

  return lines;
};
