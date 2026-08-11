/**
 * Server-side stack enforcement.
 *
 * The browser's policy module is a courtesy, not a boundary. This is the
 * boundary: a project whose environments do not run WordPress can never reach
 * a WordPress tool, no matter what toolId, URL, or stored capability the
 * caller supplies.
 */

export type ServerProjectStack = "wordpress" | "meteor" | "nextjs" | "custom";

const STACKS: ServerProjectStack[] = ["wordpress", "meteor", "nextjs", "custom"];

export const stackLabels: Record<ServerProjectStack, string> = {
  wordpress: "WordPress",
  meteor: "Meteor",
  nextjs: "Next.js",
  custom: "a custom stack",
};

/** Every tool that only means something on a WordPress install. */
export const WORDPRESS_TOOLS = new Set<string>([
  "wordpress.inspect_public_surface",
  "wordpress.read_health",
  "wordpress.list_plugins",
  "wordpress.run_wp_cli_readonly",
  "wordpress.read_error_log",
  "wordpress.execute_wp_cli",
]);

export const isWordPressTool = (toolId: string): boolean => WORDPRESS_TOOLS.has(toolId);

export type EnvironmentStackRow = { environment_type?: string | null; stack?: string | null };

const normalize = (value: unknown): ServerProjectStack | null =>
  typeof value === "string" && (STACKS as string[]).includes(value) ? (value as ServerProjectStack) : null;

/**
 * Production environment first, then the first environment recorded. A legacy
 * row with no `stack` column value is WordPress, which is what it always was.
 */
export const effectiveStack = (rows: EnvironmentStackRow[] | null | undefined): ServerProjectStack => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return "wordpress";
  const production = list.find((row) => row.environment_type === "production");
  return normalize((production ?? list[0]).stack) ?? "wordpress";
};

export type StackDeps = {
  /** Service-role read. Never fed by the browser. */
  loadEnvironmentStacks: (projectId: string) => Promise<EnvironmentStackRow[]>;
};

export type StackVerdict =
  | { ok: true; stack: ServerProjectStack }
  | { ok: false; code: "stack_not_supported" | "execution_context_unavailable"; summary: string };

export const stackRejectionSummary = (stack: ServerProjectStack): string =>
  `This project runs on ${stackLabels[stack]}. WordPress tools are not available for it.`;

/**
 * Resolves the project's stack from server-trusted data and decides whether a
 * WordPress tool may proceed. Fails closed on any read error.
 */
export const authorizeToolForStack = async (
  deps: StackDeps,
  projectId: string,
  toolId: string,
): Promise<StackVerdict> => {
  if (!isWordPressTool(toolId)) return { ok: true, stack: "wordpress" };

  let rows: EnvironmentStackRow[];
  try {
    rows = await deps.loadEnvironmentStacks(projectId);
  } catch {
    return {
      ok: false,
      code: "execution_context_unavailable",
      summary: "I can't confirm what this project runs on right now, so I stopped.",
    };
  }

  const stack = effectiveStack(rows);
  if (stack !== "wordpress") {
    return { ok: false, code: "stack_not_supported", summary: stackRejectionSummary(stack) };
  }
  return { ok: true, stack };
};
