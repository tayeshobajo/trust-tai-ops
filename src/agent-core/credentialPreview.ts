/**
 * Local, presentation-only reading of credential-shaped text.
 *
 * This never transmits, stores or echoes anything. It exists purely so the
 * composer can show the person what it is about to hand to the secure intake,
 * with the secret itself masked the moment it is recognised. The real parsing,
 * authorization and sealing stay server-side in `credential-intake`.
 */

export type CredentialKind =
  | "wordpress"
  | "sftp"
  | "ssh"
  | "google_search_console"
  | "hosting_portal"
  | "database"
  | "cdn"
  | "login"
  | "unknown";

import { inferBareBundle } from "./secretGuard";

export type CredentialPreviewField = {
  label: string;
  /** Already safe to render: secrets arrive here masked. */
  value: string;
  secret?: boolean;
};

export type CredentialPreview = {
  kind: CredentialKind;
  title: string;
  fields: CredentialPreviewField[];
  /** True when the shape is only a guess and the copy should stay restrained. */
  ambiguous: boolean;
};

const MASK = "••••••••";

const valueFor = (text: string, labels: string[]): string | null => {
  for (const label of labels) {
    const match = text.match(new RegExp(`(?:^|[\\s([{])${label}\\s*[:=]\\s*([^\\s\n]+)`, "i"));
    const found = match?.[1]?.replace(/^[`"'“”]+|[`"'“”,.;]+$/g, "").trim();
    if (found) return found;
  }
  return null;
};

const urlIn = (text: string): string | null => {
  const match = text.match(/https?:\/\/[^\s<>()"']+/i);
  if (!match) return null;
  return match[0].replace(/[.,;]+$/, "");
};

const hostIn = (text: string): string | null =>
  valueFor(text, ["host", "hostname", "server", "sftp host", "ftp host", "ssh host"]);

const prettyHost = (value: string): string => value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");

/**
 * Returns a masked description of what the text looks like, or null when the
 * text does not read as site access at all.
 */
export const describeCredentialText = (raw: string): CredentialPreview | null => {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const connection = text.match(
    /\b(sftp|ftp|ftps|ssh|mysql):\/\/([^\s:@/]+)(?::([^\s@/]+))?@([A-Za-z0-9.-]+)(?::(\d{1,5}))?/i,
  );
  const bare = inferBareBundle(text);
  const username =
    valueFor(text, ["username", "user", "login", "user name", "account"]) ??
    connection?.[2] ??
    bare?.username ??
    null;
  const password =
    valueFor(text, ["password", "passwd", "pwd", "pass", "app password", "application password"]) ??
    connection?.[3] ??
    bare?.secret ??
    null;
  const port = valueFor(text, ["port"]) ?? connection?.[5] ?? null;
  const url = urlIn(text);
  const host = hostIn(text) ?? connection?.[4] ?? bare?.host ?? null;
  const hasPrivateKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);

  if (!password && !hasPrivateKey) return null;

  const fields: CredentialPreviewField[] = [];
  const push = (label: string, value: string | null | undefined, secret = false) => {
    if (!value) return;
    fields.push({ label, value: secret ? MASK : value, secret });
  };

  const scheme = connection?.[1]?.toLowerCase() ?? "";
  const isPanel = /\bcpanel|plesk|hosting (?:panel|portal|login)|whm\b/.test(lower);
  const isDatabase = scheme === "mysql" || /\bphpmyadmin|mysql|database (?:login|user|password)\b/.test(lower);
  const isCdn = /\bcloudflare|fastly|cdn\b/.test(lower);

  if (isPanel || isDatabase || isCdn) {
    const kind: CredentialKind = isPanel ? "hosting_portal" : isDatabase ? "database" : "cdn";
    push("Address", url ? prettyHost(url) : host ? prettyHost(host) : "");
    push("Username", username);
    push("Secret", password, true);
    return {
      kind,
      title:
        kind === "hosting_portal"
          ? "Hosting panel access detected"
          : kind === "database"
            ? "Database access detected"
            : "CDN access detected",
      fields,
      ambiguous: fields.length < 2,
    };
  }

  const isWordPress = /wp-admin|wp-login|wordpress/.test(lower);
  const isSftp = /\bs?ftp\b/.test(lower);
  const isSsh = /\bssh\b/.test(lower) || hasPrivateKey;
  const isGsc =
    /"type"\s*:\s*"service_account"/.test(text) &&
    /"private_key"\s*:/.test(text) &&
    /"client_email"\s*:/.test(text);

  if (isGsc) {
    const emailMatch = text.match(/"client_email"\s*:\s*"([^"]+)"/);
    const projectMatch = text.match(/"project_id"\s*:\s*"([^"]+)"/);
    push("Service account", emailMatch?.[1] ?? "");
    push("Project", projectMatch?.[1] ?? "");
    fields.push({ label: "Private key", value: MASK, secret: true });
    return {
      kind: "google_search_console",
      title: "Google service account key detected",
      fields,
      ambiguous: fields.length < 2,
    };
  }

  if (isWordPress) {
    push("Site", url ? prettyHost(url) : host ?? "");
    push("Username", username);
    push("Password", password, true);
    return {
      kind: "wordpress",
      title: "WordPress access detected",
      fields,
      ambiguous: fields.length < 2,
    };
  }

  if (isSftp) {
    push("Host", host ? prettyHost(host) : url ? prettyHost(url) : "");
    push("Port", port ?? "22");
    push("Username", username);
    push("Password", password, true);
    return { kind: "sftp", title: "SFTP access detected", fields, ambiguous: fields.length < 3 };
  }

  if (isSsh) {
    push("Host", host ? prettyHost(host) : url ? prettyHost(url) : "");
    push("Port", port ?? "22");
    push("Username", username);
    if (hasPrivateKey) fields.push({ label: "Private key", value: MASK, secret: true });
    else push("Password", password, true);
    return { kind: "ssh", title: "SSH access detected", fields, ambiguous: fields.length < 3 };
  }

  if (url || host) {
    push("Site", url ? prettyHost(url) : prettyHost(host ?? ""));
    push("Username", username);
    push("Password", password, true);
    return { kind: "login", title: "Login details detected", fields, ambiguous: fields.length < 3 };
  }

  push("Username", username);
  push("Password", password, true);
  return { kind: "unknown", title: "This looks like site access", fields, ambiguous: true };
};
