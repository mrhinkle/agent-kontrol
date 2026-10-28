import { createHash } from "node:crypto";
import { isConfigured, sql } from "./db";
import { briefShown, repoOwner, type OwnerRule, type TrackedRepo } from "./owner-discovery";
import type { RepoConfig } from "./progress-config";
import type { RepoInput } from "./repo-validation";
import { ownerFromRow, ruleOf, type StoredOwner } from "./watched-owners";

export type RepoSource = "database" | "file";

export interface WatchedRepo extends RepoConfig {
  origin?: "manual" | "auto";
  pinned?: boolean;
  hidden?: boolean;
  gone?: boolean;
  isFork?: boolean;
  isArchived?: boolean;
  lastActivityAt?: string | null;
  /** False drops the repo off the brief and the board. Omitted means show. */
  shown?: boolean;
}

/** The board and the morning brief skip a repo only when this is false. */
export function visibleOnBoard(repo: { shown?: boolean }): boolean {
  return repo.shown !== false;
}

/**
 * The repos the progress board watches. Rows in `watched_repos` win; with none
 * (a fresh install, demo mode, or a database that has not been migrated yet) the
 * file or build-time default is used instead.
 */
function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function trackedFromRow(r: Record<string, unknown>, position: number): TrackedRepo {
  return {
    repo: String(r.repo),
    label: String(r.label),
    short: String(r.short),
    color: String(r.color),
    blockedLabel: r.blocked_label == null ? null : String(r.blocked_label),
    origin: r.origin === "auto" ? "auto" : "manual",
    pinned: r.pinned === true,
    hidden: r.hidden === true,
    gone: r.gone === true,
    isFork: r.is_fork === true,
    isArchived: r.is_archived === true,
    lastActivityAt: iso(r.last_activity_at),
    position: Number.isFinite(Number(r.position)) ? Number(r.position) : position,
  };
}

export function toWatchedRepo(row: TrackedRepo, owners: OwnerRule[], now: Date): WatchedRepo {
  const owner = owners.find((item) => item.owner.toLowerCase() === repoOwner(row.repo)) ?? null;
  return {
    repo: row.repo,
    label: row.label,
    short: row.short,
    color: row.color,
    blockedLabel: row.blockedLabel,
    origin: row.origin,
    pinned: row.pinned,
    hidden: row.hidden,
    gone: row.gone,
    isFork: row.isFork,
    isArchived: row.isArchived,
    lastActivityAt: row.lastActivityAt,
    shown: briefShown(row, owner, now),
  };
}

async function loadOwners(): Promise<StoredOwner[]> {
  try {
    const rows = await sql()`
      select owner, activity_days, include_forks, include_archived,
             last_error, last_error_at, last_discovered_at, actor_type, actor_id
      from watched_owners
      order by owner asc
    `;
    return rows.map((r) => ownerFromRow(r));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42P01" || err.message?.includes("does not exist")) return [];
    throw e;
  }
}

export async function loadTrackedRepos(): Promise<TrackedRepo[]> {
  try {
    const rows = await sql()`
      select repo, label, short, color, blocked_label, position, origin, pinned, hidden, gone,
             is_fork, is_archived, last_activity_at
      from watched_repos
      order by position asc, repo asc
    `;
    return rows.map((r, i) => trackedFromRow(r, i));
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42703") throw e;
    const rows = await sql()`
      select repo, label, short, color, blocked_label, position
      from watched_repos
      order by position asc, repo asc
    `;
    return rows.map((r, i) => trackedFromRow(r, i));
  }
}

export async function getWatchedRepos(fallback: RepoConfig[]): Promise<{ source: RepoSource; repos: WatchedRepo[] }> {
  if (!isConfigured()) return { source: "file", repos: fallback };
  try {
    const rows = await loadTrackedRepos();
    if (rows.length === 0) return { source: "file", repos: fallback };
    const owners = (await loadOwners()).map(ruleOf);
    const now = new Date();
    return { source: "database", repos: rows.map((row) => toWatchedRepo(row, owners, now)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === "42P01" || (err.message?.includes("watched_repos") && err.message.includes("does not exist"))) {
      return { source: "file", repos: fallback };
    }
    throw e;
  }
}

/** A short fingerprint of a list, so a client can tell whether it changed since it loaded it. */
export function listVersion(repos: WatchedRepo[]): string {
  const canonical = JSON.stringify(
    repos.map((r) => [r.repo, r.label, r.short, r.color, r.blockedLabel, r.pinned === true, r.hidden === true, r.origin === "auto"]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Replaces the list in ONE statement, so a failure part-way or a concurrent
 * read never sees a half-old, half-new list: the upserts and the delete of rows
 * no longer listed all run against the same snapshot. Snapshots of a removed
 * repo stay in `repo_snapshots`; adding it back restores its history.
 */
export async function replaceWatchedRepos(repos: RepoInput[]): Promise<void> {
  if (repos.length === 0) {
    await sql()`delete from watched_repos w where w.origin is distinct from 'auto'`;
    return;
  }
  await sql()`
    with incoming as (
      select * from unnest(
        ${repos.map((r) => r.repo)}::text[],
        ${repos.map((r) => r.label)}::text[],
        ${repos.map((r) => r.short)}::text[],
        ${repos.map((r) => r.color)}::text[],
        ${repos.map((r) => r.blockedLabel)}::text[],
        ${repos.map((_, i) => i)}::int[],
        ${repos.map((r) => (typeof r.pinned === "boolean" ? r.pinned : false))}::boolean[],
        ${repos.map((r) => (typeof r.hidden === "boolean" ? r.hidden : false))}::boolean[]
      ) as t(repo, label, short, color, blocked_label, position, pinned, hidden)
    ),
    upserted as (
      insert into watched_repos (repo, label, short, color, blocked_label, position, pinned, hidden, updated_at)
      select repo, label, short, color, blocked_label, position, pinned, hidden, now() from incoming
      on conflict (repo) do update set
        label = excluded.label,
        short = excluded.short,
        color = excluded.color,
        blocked_label = excluded.blocked_label,
        position = excluded.position,
        pinned = excluded.pinned,
        hidden = excluded.hidden,
        updated_at = now()
      returning repo
    )
    delete from watched_repos w
    where w.origin is distinct from 'auto'
      and not exists (select 1 from incoming i where i.repo = w.repo)
  `;
}

/** Pin or hide one stored repo. Does not change origin. Returns false when the repo is absent. */
export async function setRepoOverride(
  repo: string,
  patch: { pinned?: boolean; hidden?: boolean },
): Promise<boolean> {
  const rows = await sql()`
    update watched_repos set
      pinned = coalesce(${patch.pinned ?? null}::boolean, pinned),
      hidden = coalesce(${patch.hidden ?? null}::boolean, hidden),
      updated_at = now()
    where repo = ${repo}
    returning repo
  `;
  return rows.length > 0;
}
