import { createHash } from "node:crypto";
import { isConfigured, sql, withTransaction, type SqlTag } from "./db";
import {
  alignRepoCasing,
  briefShown,
  DISCOVERY_WRITE_LOCK,
  planOverrideResets,
  repoOwner,
  type OwnerRule,
  type TrackedRepo,
} from "./owner-discovery";
import type { RepoConfig } from "./progress-config";
import type { RepoInput } from "./repo-validation";
import { missingOwnersRelation, ownerFromRow, ruleOf, type StoredOwner } from "./watched-owners";

export type RepoSource = "database" | "file";

export interface WatchedRepo extends RepoConfig {
  origin?: "manual" | "auto";
  pinned?: boolean;
  hidden?: boolean;
  gone?: boolean;
  isFork?: boolean;
  isArchived?: boolean;
  lastActivityAt?: string | null;
  /**
   * True after a hand-added save wrote label, short, color, or blocked label
   * onto an auto row. False after a later save cleared that override. Null
   * when discovery still owns those fields.
   */
  fieldsOverridden?: boolean | null;
  /** False drops the repo off the brief and the board. Omitted means show. */
  shown?: boolean;
}

/** The board and the morning brief skip a repo only when this is false. */
export function visibleOnBoard(repo: { shown?: boolean }): boolean {
  return repo.shown !== false;
}

/**
 * The repos the progress board watches. Rows in `watched_repos` win. An empty
 * repo table still wins when at least one owner is configured, so an owner
 * whose repos are filtered or not yet discovered does not show the file list.
 * The file list is only for an unconfigured store: no owner rows and no repo
 * rows, demo mode, or a database that has not been migrated yet.
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
    fieldsOverridden: r.fields_overridden === true ? true : r.fields_overridden === false ? false : null,
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
    fieldsOverridden: row.fieldsOverridden ?? null,
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
    if (missingOwnersRelation(e)) return [];
    throw e;
  }
}

/** Postgres 42P01 for `watched_repos` only. Other "does not exist" errors stay errors. */
function missingReposRelation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err.code === "42P01" && (err.message?.includes("watched_repos") ?? false);
}

/** Reads tracked repos through `q`, so a discovery transaction can reload under its lock. */
function mapRepoRows(rows: Record<string, unknown>[]): TrackedRepo[] {
  return rows.map((r, i) => trackedFromRow(r, i));
}

export async function readTrackedRepos(q: SqlTag): Promise<TrackedRepo[]> {
  try {
    const rows = await q`
      select repo, label, short, color, blocked_label, position, origin, pinned, hidden, gone,
             is_fork, is_archived, last_activity_at, fields_overridden
      from watched_repos
      order by position asc, repo asc
    `;
    return mapRepoRows(rows);
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42703") throw e;
  }
  try {
    const rows = await q`
      select repo, label, short, color, blocked_label, position, origin, pinned, hidden, gone,
             is_fork, is_archived, last_activity_at
      from watched_repos
      order by position asc, repo asc
    `;
    return mapRepoRows(rows);
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42703") throw e;
  }
  const rows = await q`
    select repo, label, short, color, blocked_label, position
    from watched_repos
    order by position asc, repo asc
  `;
  return mapRepoRows(rows);
}

export async function loadTrackedRepos(): Promise<TrackedRepo[]> {
  return readTrackedRepos(sql());
}

export async function getWatchedRepos(fallback: RepoConfig[]): Promise<{ source: RepoSource; repos: WatchedRepo[] }> {
  if (!isConfigured()) return { source: "file", repos: fallback };
  try {
    const rows = await loadTrackedRepos();
    const owners = (await loadOwners()).map(ruleOf);
    if (rows.length === 0 && owners.length === 0) return { source: "file", repos: fallback };
    const now = new Date();
    return { source: "database", repos: rows.map((row) => toWatchedRepo(row, owners, now)) };
  } catch (e) {
    if (missingReposRelation(e)) return { source: "file", repos: fallback };
    throw e;
  }
}

/** A short fingerprint of a list, so a client can tell whether it changed since it loaded it. */
export function listVersion(repos: WatchedRepo[]): string {
  const canonical = JSON.stringify(
    repos.map((r) => [
      r.repo,
      r.label,
      r.short,
      r.color,
      r.blockedLabel,
      r.pinned === true,
      r.hidden === true,
      r.origin === "auto",
      r.fieldsOverridden === true ? true : r.fieldsOverridden === false ? false : null,
    ]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type RepoWriteResult =
  | { ok: true }
  | { ok: false; reason: "stale" };

/** Same fingerprint GET returns. Owners and `shown` are not part of it. */
function versionOf(rows: TrackedRepo[]): string {
  return listVersion(rows.map((row) => toWatchedRepo(row, [], new Date(0))));
}

/**
 * Replaces the hand-added list in one statement, so a failure part-way or a
 * concurrent read never sees a half-old, half-new list. Auto rows the body
 * omits stay. When `fields_overridden` is true, that omit resets label, short,
 * color, and blocked label to the discovery defaults and sets the flag false.
 * Origin, pin, hide, gone, and discovery metadata stay. The short is allocated
 * under the same lock discovery uses. Snapshots of a removed repo stay in
 * `repo_snapshots`; adding it back restores its history.
 *
 * `expectedVersion`, when passed, is checked again after that lock so a pin
 * or hide that committed since the caller's read cannot be overwritten.
 */
export async function replaceWatchedRepos(repos: RepoInput[], expectedVersion?: string): Promise<RepoWriteResult> {
  return withTransaction(async (q) => {
    await q`select pg_advisory_xact_lock(${DISCOVERY_WRITE_LOCK}::bigint)`;
    const stored = await readTrackedRepos(q);
    if (expectedVersion !== undefined && expectedVersion !== versionOf(stored)) {
      return { ok: false, reason: "stale" };
    }
    const aligned = alignRepoCasing(stored, repos);
    const resets = planOverrideResets(stored, aligned);
    await writeReplacedRepos(q, aligned, resets);
    return { ok: true };
  });
}

async function writeReplacedRepos(q: SqlTag, repos: RepoInput[], resets: TrackedRepo[]): Promise<void> {
  if (repos.length === 0 && resets.length === 0) {
    await q`delete from watched_repos w where w.origin is distinct from 'auto'`;
    return;
  }
  if (resets.length === 0) {
    await q`
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
        insert into watched_repos (repo, label, short, color, blocked_label, position, pinned, hidden, fields_overridden, updated_at)
        select repo, label, short, color, blocked_label, position, pinned, hidden, true, now() from incoming
        on conflict (repo) do update set
          label = excluded.label,
          short = excluded.short,
          color = excluded.color,
          blocked_label = excluded.blocked_label,
          position = excluded.position,
          pinned = excluded.pinned,
          hidden = excluded.hidden,
          fields_overridden = true,
          updated_at = now()
        returning repo
      )
      delete from watched_repos w
      where w.origin is distinct from 'auto'
        and not exists (select 1 from incoming i where lower(i.repo) = lower(w.repo))
    `;
    return;
  }
  if (repos.length === 0) {
    await q`
      with resets as (
        select * from unnest(
          ${resets.map((r) => r.repo)}::text[],
          ${resets.map((r) => r.label)}::text[],
          ${resets.map((r) => r.short)}::text[],
          ${resets.map((r) => r.color)}::text[],
          ${resets.map((r) => r.blockedLabel)}::text[]
        ) as t(repo, label, short, color, blocked_label)
      ),
      cleared as (
        update watched_repos w set
          label = r.label,
          short = r.short,
          color = r.color,
          blocked_label = r.blocked_label,
          fields_overridden = false,
          updated_at = now()
        from resets r
        where w.repo = r.repo
          and w.origin = 'auto'
        returning w.repo
      )
      delete from watched_repos w
      where w.origin is distinct from 'auto'
        and (select count(*) from cleared) >= 0
    `;
    return;
  }
  await q`
    with resets as (
      select * from unnest(
        ${resets.map((r) => r.repo)}::text[],
        ${resets.map((r) => r.label)}::text[],
        ${resets.map((r) => r.short)}::text[],
        ${resets.map((r) => r.color)}::text[],
        ${resets.map((r) => r.blockedLabel)}::text[]
      ) as t(repo, label, short, color, blocked_label)
    ),
    cleared as (
      update watched_repos w set
        label = r.label,
        short = r.short,
        color = r.color,
        blocked_label = r.blocked_label,
        fields_overridden = false,
        updated_at = now()
      from resets r
      where w.repo = r.repo
        and w.origin = 'auto'
      returning w.repo
    ),
    incoming as (
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
      insert into watched_repos (repo, label, short, color, blocked_label, position, pinned, hidden, fields_overridden, updated_at)
      select repo, label, short, color, blocked_label, position, pinned, hidden, true, now() from incoming
      on conflict (repo) do update set
        label = excluded.label,
        short = excluded.short,
        color = excluded.color,
        blocked_label = excluded.blocked_label,
        position = excluded.position,
        pinned = excluded.pinned,
        hidden = excluded.hidden,
        fields_overridden = true,
        updated_at = now()
      where (select count(*) from cleared) >= 0
      returning repo
    )
    delete from watched_repos w
    where w.origin is distinct from 'auto'
      and not exists (select 1 from incoming i where lower(i.repo) = lower(w.repo))
  `;
}

/**
 * Pin or hide one stored repo. Does not change origin. Returns false when the
 * repo is absent. Takes the discovery write lock so a list replace cannot
 * pass its version check and then drop this flag. Pin and hide are part of
 * the list version, so a real change makes the next replace with the old
 * version stale.
 */
export async function setRepoOverride(
  repo: string,
  patch: { pinned?: boolean; hidden?: boolean },
): Promise<boolean> {
  return withTransaction(async (q) => {
    await q`select pg_advisory_xact_lock(${DISCOVERY_WRITE_LOCK}::bigint)`;
    const rows = await q`
      update watched_repos set
        pinned = coalesce(${patch.pinned ?? null}::boolean, pinned),
        hidden = coalesce(${patch.hidden ?? null}::boolean, hidden),
        updated_at = now()
      where lower(repo) = lower(${repo})
      returning repo
    `;
    return rows.length > 0;
  });
}
