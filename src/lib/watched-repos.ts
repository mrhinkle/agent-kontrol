import { createHash } from "node:crypto";
import { isConfigured, sql } from "./db";
import type { RepoConfig } from "./progress-config";
import type { RepoInput } from "./repo-validation";

export type RepoSource = "database" | "file";

/**
 * The repos the progress board watches. Rows in `watched_repos` win; with none
 * (a fresh install, demo mode, or a database that has not been migrated yet) the
 * file or build-time default is used instead.
 */
export async function getWatchedRepos(fallback: RepoConfig[]): Promise<{ source: RepoSource; repos: RepoConfig[] }> {
  if (!isConfigured()) return { source: "file", repos: fallback };
  try {
    const rows = await sql()`
      select repo, label, short, color, blocked_label
      from watched_repos
      order by position asc, repo asc
    `;
    if (rows.length === 0) return { source: "file", repos: fallback };
    return {
      source: "database",
      repos: rows.map((r) => ({
        repo: String(r.repo),
        label: String(r.label),
        short: String(r.short),
        color: String(r.color),
        blockedLabel: r.blocked_label == null ? null : String(r.blocked_label),
      })),
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42P01" || (err.message?.includes("watched_repos") && err.message.includes("does not exist"))) {
      return { source: "file", repos: fallback };
    }
    throw e;
  }
}

/** A short fingerprint of a list, so a client can tell whether it changed since it loaded it. */
export function listVersion(repos: RepoConfig[]): string {
  const canonical = JSON.stringify(repos.map((r) => [r.repo, r.label, r.short, r.color, r.blockedLabel]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Replaces the list in ONE statement, so a failure part-way or a concurrent
 * read never sees a half-old, half-new list: the upserts and the delete of rows
 * no longer listed all run against the same snapshot. Snapshots of a removed
 * repo stay in `repo_snapshots`; adding it back restores its history.
 */
export async function replaceWatchedRepos(repos: RepoInput[]): Promise<void> {
  await sql()`
    with incoming as (
      select * from unnest(
        ${repos.map((r) => r.repo)}::text[],
        ${repos.map((r) => r.label)}::text[],
        ${repos.map((r) => r.short)}::text[],
        ${repos.map((r) => r.color)}::text[],
        ${repos.map((r) => r.blockedLabel)}::text[],
        ${repos.map((_, i) => i)}::int[]
      ) as t(repo, label, short, color, blocked_label, position)
    ),
    upserted as (
      insert into watched_repos (repo, label, short, color, blocked_label, position, updated_at)
      select repo, label, short, color, blocked_label, position, now() from incoming
      on conflict (repo) do update set
        label = excluded.label,
        short = excluded.short,
        color = excluded.color,
        blocked_label = excluded.blocked_label,
        position = excluded.position,
        updated_at = now()
      returning repo
    )
    delete from watched_repos w
    where not exists (select 1 from incoming i where i.repo = w.repo)
  `;
}
