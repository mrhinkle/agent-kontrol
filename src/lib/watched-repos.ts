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

/**
 * Replaces the list. Rows are upserted first and the ones no longer listed are
 * deleted after, so a failure part-way never leaves the table empty. Snapshots
 * of a removed repo stay in `repo_snapshots`; adding it back restores its history.
 */
export async function replaceWatchedRepos(repos: RepoInput[]): Promise<void> {
  const db = sql();
  for (const [position, r] of repos.entries()) {
    await db`
      insert into watched_repos (repo, label, short, color, blocked_label, position, updated_at)
      values (${r.repo}, ${r.label}, ${r.short}, ${r.color}, ${r.blockedLabel}, ${position}, now())
      on conflict (repo) do update set
        label = excluded.label,
        short = excluded.short,
        color = excluded.color,
        blocked_label = excluded.blocked_label,
        position = excluded.position,
        updated_at = now()
    `;
  }
  const names = repos.map((r) => r.repo);
  await db`delete from watched_repos where repo <> all(${names}::text[])`;
}
