import type { AccessType, Project } from "./types";

/**
 * Host-aware access guidance.
 *
 * A senior engineer doesn't say "give me SSH" and leave. They know how the
 * specific host issues it and walk the owner through it. This holds that
 * knowledge for the hosts whose process is genuinely different from the
 * generic one, and stays silent everywhere else rather than guessing.
 */

export type HostGuidance = {
  host: string;
  /** One line the agent can say. */
  summary: string;
  steps: string[];
  /** Sensible values for the connection form, when the host fixes them. */
  hints?: { host?: string; user?: string; port?: string };
};

const haystack = (project: Project): string =>
  [
    project.primaryDomain,
    ...project.environments.map((environment) => `${environment.primaryUrl} ${environment.hostingProvider}`),
    ...project.accessMethods.map((method) => `${method.label} ${method.notes}`),
  ]
    .join(" ")
    .toLowerCase();

/** The WP Engine install name, when it can be read from what we already know. */
const wpEngineInstall = (text: string): string | null =>
  text.match(/\b([a-z0-9-]+)\.(?:sftp|ssh)\.wpengine\.(?:com|net)\b/)?.[1] ??
  text.match(/\b([a-z0-9-]+)\.wpengine\.com\b/)?.[1] ??
  null;

export const detectHost = (project: Project): "wpengine" | null =>
  /wpengine|wp engine/.test(haystack(project)) ? "wpengine" : null;

export const hostGuidance = (project: Project, type: AccessType): HostGuidance | null => {
  if (detectHost(project) !== "wpengine") return null;
  if (type !== "ssh") return null;

  const install = wpEngineInstall(haystack(project));

  return {
    host: "WP Engine",
    summary:
      "WP Engine's SSH Gateway is key-only — there's no SSH password to find. You create a key pair once, paste the public half into the WP Engine portal, and give me the private half.",
    steps: [
      'In a terminal, run: ssh-keygen -t ed25519 -C "trusttai" -f ~/.ssh/trusttai — press enter twice to leave the passphrase blank.',
      "Copy the public half: cat ~/.ssh/trusttai.pub",
      "In the WP Engine User Portal, open your profile → SSH Keys and paste that public key.",
      install
        ? `Back here, use host ${install}.ssh.wpengine.net, username ${install}, port 22.`
        : "Back here, use host <install>.ssh.wpengine.net and your install name as the username, port 22.",
      "Paste the private half (the file without .pub, starting with -----BEGIN OPENSSH PRIVATE KEY-----) into the SSH private key field.",
    ],
    hints: install
      ? { host: `${install}.ssh.wpengine.net`, user: install, port: "22" }
      : { port: "22" },
  };
};

/** A compact form of the same knowledge, for the agent's facts sheet. */
export const hostGuidanceFact = (project: Project): string | null => {
  const guidance = hostGuidance(project, "ssh");
  return guidance
    ? `This site is hosted on ${guidance.host}. ${guidance.summary} If you need SSH, walk them through it: ${guidance.steps.join(" ")}`
    : null;
};