import { createHash } from "node:crypto";
import type { Actor } from "./actor";
import { isConfigured, sql } from "./db";
import {
  planDiscovery,
  repoIdentity,
  repoOwner,
  type DiscoveryOutcome,
  type DiscoverySweep,
  type GhListedRepo,
  type OwnerRule,
  type TrackedRepo,
} from "./owner-discovery";
import {
  ACTIVITY_DAYS_DEFAULT,
  type OwnerInput,
} from "./owner-validation";

export interface StoredOwner extends OwnerInput {
  lastError: string | null;
  lastErrorAt: string | null;
  lastDiscoveredAt: string | null;
  actorType: string | null;
  actorId: string | null;
}

export interface DiscoveryRequest {
  owner: string;
  ok: boolean;
  error?: string | null;
  repos?: GhListedRepo[];
  truncated?: boolean;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function missingRelation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err.code === "42P01" || (err.message?.includes("does not exist") ?? false);
}

export function ownerListVersion(owners: OwnerInput[]): string {
  const canonical = JSON.stringify(
    owners.map((o) => [o.owner, o.activityDays, o.includeForks, o.includeArchived]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function ownerFromRow(r: Record<string, unknown>): StoredOwner {
  return {
    owner: String(r.owner),
    activityDays: Number(r.activity_days ?? ACTIVITY_DAYS_DEFAULT),
    includeForks: r.include_forks === true,
    includeArchived: r.include_archived === true,
    lastError: r.last_error == null ? null : String(r.last_error),
    lastErrorAt: iso(r.last_error_at),
    lastDiscoveredAt: iso(r.last_discovered_at),
    actorType: r.actor_type == null ? null : String(r.actor_type),
    actorId: r.actor_id == null ? null : String(r.actor_id),
  };
}

export async function listWatchedOwners(): Promise<StoredOwner[]> {
  if (!isConfigured()) return [];
  try {
    const rows = await sql()`
      select owner, activity_days, include_forks, include_archived,
             last_error, last_error_at, last_discovered_at, actor_type, actor_id
      from watched_owners
      order by owner asc
    `;
    return rows.map((r) => ownerFromRow(r));
  } catch (e) {
    if (missingRelation(e)) return [];
    throw e;
  }
}

/** Replaces the owner list. Does not delete discovered repos. Records the actor. */
export async function replaceWatchedOwners(owners: OwnerInput[], actor: Actor | null): Promise<void> {
  const actorType = actor?.actor_type ?? null;
  const actorId = actor?.actor_id ?? null;
  await sql()`
    with incoming as (
      select * from unnest(
        ${owners.map((o) => o.owner)}::text[],
        ${owners.map((o) => o.activityDays)}::int[],
        ${owners.map((o) => o.includeForks)}::boolean[],
        ${owners.map((o) => o.includeArchived)}::boolean[]
      ) as t(owner, activity_days, include_forks, include_archived)
    ),
    upserted as (
      insert into watched_owners (
        owner, activity_days, include_forks, include_archived, actor_type, actor_id, updated_at
      )
      select owner, activity_days, include_forks, include_archived, ${actorType}, ${actorId}, now()
      from incoming
      on conflict (owner) do update set
        activity_days = excluded.activity_days,
        include_forks = excluded.include_forks,
        include_archived = excluded.include_archived,
        actor_type = excluded.actor_type,
        actor_id = excluded.actor_id,
        updated_at = now()
      returning owner
    )
    delete from watched_owners w
    where not exists (select 1 from incoming i where i.owner = w.owner)
  `;
}

export function ruleOf(owner: StoredOwner): OwnerRule {
  return {
    owner: owner.owner,
    activityDays: owner.activityDays,
    includeForks: owner.includeForks,
    includeArchived: owner.includeArchived,
  };
}

export function sweepOf(request: DiscoveryRequest): DiscoverySweep {
  if (!request.ok) {
    return { repos: null, error: request.error?.trim() || "gh repo list failed", truncated: false };
  }
  return {
    repos: request.repos ?? [],
    error: request.error ?? null,
    truncated: request.truncated === true,
  };
}

/**
 * Applies one owner's sweep. A failure records `last_error` and does not
 * insert, update, hide, or delete tracked repos.
 */
export async function applyOwnerDiscovery(
  rule: OwnerRule,
  existing: TrackedRepo[],
  sweep: DiscoverySweep,
  now: Date,
): Promise<DiscoveryOutcome> {
  const outcome = planDiscovery(existing, rule, sweep, now);
  const visibleError = outcome.failure ?? outcome.warning;
  await sql()`
    update watched_owners set
      last_error = ${visibleError},
      last_error_at = case when ${visibleError}::text is null then null else now() end,
      last_discovered_at = case when ${outcome.failure}::text is null then now() else last_discovered_at end,
      updated_at = now()
    where owner = ${rule.owner}
  `;
  if (outcome.failure) return outcome;

  const owned = outcome.repos.filter((row) => repoOwner(row.repo) === rule.owner.toLowerCase());
  if (owned.length === 0) return outcome;
  await sql()`
    insert into watched_repos (
      repo, label, short, color, blocked_label, position, origin, pinned, hidden, gone,
      is_fork, is_archived, last_activity_at, updated_at
    )
    select
      t.repo, t.label, t.short, t.color, t.blocked_label, t.position, t.origin,
      t.pinned, t.hidden, t.gone, t.is_fork, t.is_archived, t.last_activity_at, now()
    from unnest(
      ${owned.map((r) => r.repo)}::text[],
      ${owned.map((r) => r.label)}::text[],
      ${owned.map((r) => r.short)}::text[],
      ${owned.map((r) => r.color)}::text[],
      ${owned.map((r) => r.blockedLabel)}::text[],
      ${owned.map((r) => r.position)}::int[],
      ${owned.map((r) => r.origin)}::text[],
      ${owned.map((r) => r.pinned)}::boolean[],
      ${owned.map((r) => r.hidden)}::boolean[],
      ${owned.map((r) => r.gone)}::boolean[],
      ${owned.map((r) => r.isFork)}::boolean[],
      ${owned.map((r) => r.isArchived)}::boolean[],
      ${owned.map((r) => r.lastActivityAt)}::timestamptz[]
    ) as t(
      repo, label, short, color, blocked_label, position, origin, pinned, hidden, gone,
      is_fork, is_archived, last_activity_at
    )
    on conflict (repo) do update set
      last_activity_at = excluded.last_activity_at,
      is_fork = excluded.is_fork,
      is_archived = excluded.is_archived,
      gone = excluded.gone,
      updated_at = now()
  `;
  return outcome;
}

export function sameIdentity(a: string, b: string): boolean {
  return repoIdentity(a) === repoIdentity(b);
}
