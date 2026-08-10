/**
 * Static validation for the SQL migration set.
 *
 * Run with: npm run check:migrations
 *
 * These are the mistakes that are cheap to make in SQL and expensive to find
 * in production: an identity column that does not match the table it points
 * at, a policy that casts arbitrary text to uuid (one bad row and every read
 * raises), a permissive `using (true)` policy reappearing, a public-schema
 * table with no grants, and a migration that cannot be run twice.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const failures: string[] = [];
const check = (name: string, condition: boolean, detail = "") => {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const root = join(import.meta.dirname, "..", "db");
const schema = readFileSync(join(root, "schema.sql"), "utf8");
const migrationDir = join(root, "migrations");
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationDir, name), "utf8") }));

const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

/** `projects` -> type of its `id` column, read from the canonical schema. */
const idTypes = new Map<string, string>();
for (const match of schema.matchAll(/create table if not exists (?:public\.)?(\w+)\s*\(\s*id\s+(\w+)/g)) {
  idTypes.set(match[1], match[2].toLowerCase());
}

console.log("\nidentity column types match the tables they reference");
for (const { name, sql } of migrations) {
  const body = strip(sql);
  for (const match of body.matchAll(/^\s*(\w+)\s+(text|uuid)\b[^,\n]*references\s+(?:public\.)?(\w+)\s*\(\s*id\s*\)/gim)) {
    const [, column, declared, table] = match;
    const expected = idTypes.get(table);
    if (!expected) continue;
    check(
      `${name}: ${column} references ${table}.id as ${expected}`,
      declared.toLowerCase() === expected,
      `declared ${declared}, target is ${expected}`,
    );
  }
}

console.log("\npolicies never cast arbitrary text to uuid");
for (const { name, sql } of migrations) {
  const body = strip(sql);
  // Inside a policy, `something::uuid` raises on the first unconvertible row
  // and takes the whole table's readability with it.
  const policyBlocks = body.match(/create policy[\s\S]*?;/gi) ?? [];
  for (const block of policyBlocks) {
    check(
      `${name}: policy avoids an unsafe ::uuid cast`,
      !/\w+::uuid/i.test(block),
      block.split("\n").find((line) => /::uuid/i.test(line))?.trim(),
    );
  }
}

console.log("\nno permissive or anonymous access returns");
for (const { name, sql } of migrations) {
  const body = strip(sql);
  const policyBlocks = body.match(/create policy[\s\S]*?;/gi) ?? [];
  for (const block of policyBlocks) {
    const permissive = /using\s*\(\s*true\s*\)/i.test(block) || /with check\s*\(\s*true\s*\)/i.test(block);
    const serviceOnly = /to\s+service_role/i.test(block);
    check(
      `${name}: policy is not permissive for a browser role`,
      !permissive || serviceOnly,
      block.slice(0, 80).replace(/\s+/g, " "),
    );
  }
  check(`${name}: grants nothing to anon`, !/grant\s+[\s\S]*?\s+to\s+anon/i.test(body));
}

console.log("\nnew public tables are granted and protected");
for (const { name, sql } of migrations) {
  const body = strip(sql);
  for (const match of body.matchAll(/create table if not exists public\.(\w+)/g)) {
    const table = match[1];
    check(`${name}: ${table} has grants`, new RegExp(`grant[\\s\\S]*?public\\.${table}`, "i").test(body));
    check(
      `${name}: ${table} has row level security enabled`,
      new RegExp(`alter table public\\.${table} enable row level security`, "i").test(body),
    );
  }
}

console.log("\nmigrations are idempotent");
for (const { name, sql } of migrations) {
  const body = strip(sql);
  check(`${name}: every create table is guarded`, !/create table (?!if not exists)/i.test(body));
  check(`${name}: every create index is guarded`, !/create (unique )?index (?!if not exists)/i.test(body));
  check(
    `${name}: every function is replaceable`,
    !/create function/i.test(body),
  );
  // A bare `create policy` is only safe inside an existence check or after a
  // matching `drop policy if exists`.
  for (const match of body.matchAll(/create policy (\w+)/gi)) {
    const policy = match[1];
    const guarded =
      new RegExp(`policyname\\s*=\\s*'${policy}'`, "i").test(body) ||
      new RegExp(`drop policy if exists ${policy}`, "i").test(body);
    check(`${name}: policy ${policy} can be re-applied`, guarded);
  }
  for (const match of body.matchAll(/create trigger (\w+)/gi)) {
    check(
      `${name}: trigger ${match[1]} can be re-applied`,
      new RegExp(`drop trigger if exists ${match[1]}`, "i").test(body),
    );
  }
  check(`${name}: every added column is guarded`, !/add column (?!if not exists)/i.test(body));
}

console.log("\nverification cannot be forged from the browser");
const guard = migrations.find((item) => item.name.includes("verification_integrity"));
check("a verification guard migration exists", Boolean(guard));
if (guard) {
  check(
    "the guard checks the server-only secret store",
    /project_access_secrets/.test(guard.sql) && /verification_state\s*=\s*'verified'/.test(guard.sql),
  );
  check("the guard runs before the write", /before insert or update on public\.project_access_methods/i.test(guard.sql));
}

const repository = readFileSync(join(import.meta.dirname, "..", "src", "repository.ts"), "utf8");
const nativeVerify = repository.split("async verifyAccessMethod").pop() ?? "";
check(
  "the native repository refuses to stamp an executable credential",
  /accessType === "wordpress_admin"/.test(nativeVerify),
);

console.log(
  failures.length === 0
    ? "\nAll migration checks passed."
    : `\n${failures.length} migration check(s) failed:\n  - ${failures.join("\n  - ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
