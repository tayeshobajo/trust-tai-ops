/**
 * Browser-side mirror of the WP-CLI read-only catalog ids.
 *
 * The server catalog in `supabase/functions/_shared/wpCliCatalog.ts` is the
 * only authority: it is what actually builds and gates a command. This list
 * exists so the planner can name an inspection without inventing one, and
 * `npm run check:wpcli` fails if the two ever drift apart.
 */

export const WP_CLI_READONLY_COMMAND_IDS = [
  "core.version",
  "core.check_update",
  "core.is_installed",
  "core.verify_checksums",
  "plugin.list",
  "plugin.get",
  "theme.list",
  "user.list_roles",
  "option.get",
  "cron.event_list",
  "maintenance_mode.status",
  "db.size",
  "config.get_table_prefix",
] as const;

export type WpCliCommandId = (typeof WP_CLI_READONLY_COMMAND_IDS)[number];

/** Inspections that take an extra detail, and the name of that detail. */
export const WP_CLI_COMMAND_PARAMS: Partial<Record<WpCliCommandId, string>> = {
  "plugin.get": "plugin",
  "option.get": "option",
};

export const isWpCliCommandId = (value: unknown): value is WpCliCommandId =>
  typeof value === "string" && (WP_CLI_READONLY_COMMAND_IDS as readonly string[]).includes(value);