#!/usr/bin/env node
// Read-only report of watched_repos rows that share a short name, ignoring case.
// Prints groups and suggested SQL as text. Never updates, deletes, or inserts.
import { fileURLToPath } from "node:url";
import pg from "pg";

export const DUPLICATE_SHORTS_SQL =
  "select repo, short, origin, position from watched_repos order by lower(short), position, repo";

/**
 * Groups rows whose short names match case-insensitively and appear more than once.
 * Null and empty shorts are skipped. Group order is the lowercased short.
 * @param {readonly { repo: string, short: string | null, origin?: string | null, position?: number | null }[]} rows
 */
export function groupDuplicateShorts(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.short == null || String(row.short) === "") continue;
    const key = String(row.short).toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([short, repos]) => ({ short, repos }));
}

function sqlText(value) {
  return String(value).replaceAll("'", "''");
}

/**
 * Text report. Suggested statements are SQL comments so pasting the report
 * does not write. The operator copies one line and runs it by hand.
 * @param {readonly { repo: string, short: string | null, origin?: string | null, position?: number | null }[]} rows
 */
export function formatDuplicateShortReport(rows) {
  const groups = groupDuplicateShorts(rows);
  if (groups.length === 0) return "No duplicate short names.\n";
  const lines = [
    "Duplicate short names (read-only). Rename by hand. This script does not write.",
    "",
  ];
  for (const group of groups) {
    lines.push(`short ${group.short} (${group.repos.length})`);
    for (const row of group.repos) {
      lines.push(`  ${row.repo}  short=${row.short}  origin=${row.origin ?? ""}  position=${row.position ?? ""}`);
    }
    lines.push("Suggested manual SQL (do not run from this script):");
    const keeper = group.repos[0];
    lines.push(`-- keep ${keeper.repo} short=${keeper.short}`);
    group.repos.slice(1).forEach((row, index) => {
      const base = String(row.short).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "short";
      const suggested = `${base}${index + 2}`;
      lines.push(`-- update watched_repos set short = '${sqlText(suggested)}' where repo = '${sqlText(row.repo)}';`);
    });
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(DUPLICATE_SHORTS_SQL);
    process.stdout.write(formatDuplicateShortReport(result.rows));
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
