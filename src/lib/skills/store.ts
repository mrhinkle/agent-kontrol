import { sql } from "../db";
import {
  flagsFromStored,
  isTrigger,
  scopeFromStored,
  triggerFromStored,
  type RunRecord,
  type SettingsRecord,
  type SkillRecord,
  type SkillReference,
  type SkillScope,
  type SkillSourceRow,
} from "./types";

/**
 * SQL for the skills tables. Each statement starts with a marker comment so
 * tests can answer it from an in-memory fake. Production runs the SQL.
 */

function db() {
  return sql();
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function asRefs(value: unknown): SkillReference[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? safeArray(value) : [];
  const out: SkillReference[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    const content = (item as { content?: unknown }).content;
    if (typeof path === "string" && typeof content === "string") out.push({ path, content });
  }
  return out;
}

function safeArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asScope(value: unknown): SkillScope {
  return scopeFromStored(typeof value === "string" ? asObject(value) : value);
}

function asRuntimes(value: unknown): SkillRecord["runtimes"] {
  return flagsFromStored(typeof value === "string" ? asObject(value) : value);
}

function asGlobs(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? safeArray(value) : [];
  return list.filter((item): item is string => typeof item === "string");
}

function asCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? safeArray(value) : [];
  const tags: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) tags.push(trimmed);
  }
  return tags;
}

export async function listSources(): Promise<SkillSourceRow[]> {
  const rows = await db()`
    /* sk:list-sources */
    select id, repo, ref, path_globs, label, enabled, position
    from skill_sources
    where enabled = true
    order by position asc, id asc
  `;
  return rows.map((row) => ({
    id: String(row.id),
    repo: String(row.repo),
    ref: row.ref == null ? null : String(row.ref),
    path_globs: asGlobs(row.path_globs),
    label: String(row.label),
    enabled: row.enabled !== false,
    position: Number(row.position ?? 0),
  }));
}

export async function listSkillRows(): Promise<SkillRecord[]> {
  const rows = await db()`
    /* sk:list-skills */
    select id, source_id, path, name, description, version, sha, commit_sha, body,
      "references" as references, runtimes, frontmatter, category, tags, removed_at, synced_at
    from skills
  `;
  return rows.map(mapSkill);
}

/** One visible skill. Removed rows are absent. get_skill and run_skill use this. */
export async function getSkillRow(id: string): Promise<SkillRecord | null> {
  const rows = await db()`
    /* sk:get-skill */
    select id, source_id, path, name, description, version, sha, commit_sha, body,
      "references" as references, runtimes, frontmatter, category, tags, removed_at, synced_at
    from skills
    where id = ${id} and removed_at is null
  `;
  const row = rows[0];
  return row ? mapSkill(row) : null;
}

export function mapSkill(row: Record<string, unknown>): SkillRecord {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    path: String(row.path),
    name: String(row.name ?? row.id),
    description: String(row.description ?? ""),
    version: row.version == null ? null : String(row.version),
    sha: String(row.sha),
    commit_sha: row.commit_sha == null || row.commit_sha === "" ? null : String(row.commit_sha),
    body: String(row.body ?? ""),
    references: asRefs(row.references),
    runtimes: asRuntimes(row.runtimes),
    category: asCategory(row.category),
    tags: asTags(row.tags),
    frontmatter: asObject(row.frontmatter),
    removed_at: iso(row.removed_at),
    synced_at: iso(row.synced_at) ?? new Date(0).toISOString(),
  };
}

/** Thrown when this sync's row is no longer the running lease. Callers stop. */
export class SyncLeaseLost extends Error {
  constructor() {
    super("sync lease lost");
    this.name = "SyncLeaseLost";
  }
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical 8-4-4-4-12 text. Anything else must not be cast to uuid. */
export function isUuid(value: string): boolean {
  return UUID_TEXT.test(value);
}

/**
 * Insert or replace one skill only while `runId` is still the running sync.
 * `for share` locks the lease row in this same statement. Without the lock,
 * beginSyncRun's expiry UPDATE can commit while this statement still sees
 * status running on its snapshot, and a sync that lost the lease still
 * writes. Neon HTTP cannot hold that lock across statements. Zero owned
 * rows means the caller must stop.
 */
export async function upsertSkill(row: SkillRecord, runId: string): Promise<void> {
  const rows = await db()`
    /* sk:upsert-skill */
    with owner as (
      select 1 as ok
      from skill_sync_runs
      where id = ${runId}::uuid and status = 'running'
      for share
    ),
    written as (
      insert into skills (
        id, source_id, path, name, description, version, sha, commit_sha, body,
        "references", runtimes, frontmatter, category, tags, removed_at, synced_at
      )
      select
        ${row.id}, ${row.source_id}, ${row.path}, ${row.name}, ${row.description}, ${row.version},
        ${row.sha}, ${row.commit_sha}, ${row.body},
        ${JSON.stringify(row.references)}::jsonb,
        ${JSON.stringify(row.runtimes)}::jsonb,
        ${JSON.stringify(row.frontmatter)}::jsonb,
        ${row.category},
        ${JSON.stringify(row.tags)}::jsonb,
        null, ${row.synced_at}::timestamptz
      from owner
      on conflict (id) do update set
        source_id = excluded.source_id,
        path = excluded.path,
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        sha = excluded.sha,
        commit_sha = excluded.commit_sha,
        body = excluded.body,
        "references" = excluded."references",
        runtimes = excluded.runtimes,
        frontmatter = excluded.frontmatter,
        category = excluded.category,
        tags = excluded.tags,
        removed_at = null,
        synced_at = excluded.synced_at
      returning id
    )
    select
      (select count(*)::int from owner) as owned,
      (select count(*)::int from written) as wrote
  `;
  if (Number(rows[0]?.owned ?? 0) < 1) throw new SyncLeaseLost();
}

/** Mark one skill removed only while `runId` is still the running sync. Same lease-row lock as upsertSkill. */
export async function markSkillRemoved(id: string, at: string, runId: string): Promise<void> {
  const rows = await db()`
    /* sk:remove-skill */
    with owner as (
      select 1 as ok
      from skill_sync_runs
      where id = ${runId}::uuid and status = 'running'
      for share
    ),
    written as (
      update skills set removed_at = ${at}::timestamptz
      where id = ${id}
        and removed_at is null
        and exists (select 1 from owner)
      returning id
    )
    select
      (select count(*)::int from owner) as owned,
      (select count(*)::int from written) as wrote
  `;
  if (Number(rows[0]?.owned ?? 0) < 1) throw new SyncLeaseLost();
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = err instanceof Error ? err.message : "";
  return message.includes("skill_sync_one_running_idx");
}

/**
 * Take the one-running lease. A unique violation means another sync holds it.
 * A running row older than the lease is marked failed first, so a crashed sync
 * does not wedge the mirror. Expiring that row does not by itself stop the old
 * process: upsertSkill, markSkillRemoved, and finishSyncRun each lock this
 * row and write only while this id is still status running. This does not
 * delete skill rows.
 */
export async function beginSyncRun(input: {
  id: string;
  trigger: "manual" | "scheduled";
  startedAt: string;
  staleBefore: string;
}): Promise<boolean> {
  await db()`
    /* sk:expire-sync */
    update skill_sync_runs
    set status = 'failed',
      finished_at = ${input.startedAt}::timestamptz,
      error = 'sync lease expired'
    where status = 'running' and started_at < ${input.staleBefore}::timestamptz
  `;
  try {
    await db()`
      /* sk:begin-sync */
      insert into skill_sync_runs (id, started_at, finished_at, trigger, status, summary, error)
      values (${input.id}::uuid, ${input.startedAt}::timestamptz, null, ${input.trigger}, 'running', null, null)
    `;
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Close the lease row this sync inserted. `for update` locks that row in
 * this statement, same fence as upsertSkill: expiry either waits or this
 * update matches nothing after it commits. A row that is no longer running
 * is left alone. False means this sync no longer owns the lease.
 */
export async function finishSyncRun(input: {
  id: string;
  status: string;
  summary: unknown;
  error: string | null;
  finishedAt: string;
}): Promise<boolean> {
  const rows = await db()`
    /* sk:finish-sync */
    update skill_sync_runs as target
    set finished_at = ${input.finishedAt}::timestamptz,
      status = ${input.status},
      summary = ${JSON.stringify(input.summary)}::jsonb,
      error = ${input.error}
    from (
      select id
      from skill_sync_runs
      where id = ${input.id}::uuid and status = 'running'
      for update
    ) as owner
    where target.id = owner.id
    returning target.id
  `;
  return rows.length > 0;
}

export interface SyncRunRow {
  summary: unknown;
  finished_at: string | null;
  status: string;
  trigger: string;
}

export async function latestSyncRuns(): Promise<SyncRunRow[]> {
  const rows = await db()`
    /* sk:latest-sync */
    select summary, finished_at, status, trigger
    from skill_sync_runs
    where finished_at is not null
      and jsonb_typeof(summary->'sources') = 'array'
      and exists (
        select 1
        from jsonb_array_elements(summary->'sources') as source
        where coalesce(source->>'commit_sha', '') <> ''
      )
    order by finished_at desc
    limit 5
  `;
  return rows.map((row) => ({
    summary: typeof row.summary === "string" ? safeJson(row.summary) : row.summary,
    finished_at: iso(row.finished_at),
    status: String(row.status),
    trigger: String(row.trigger ?? ""),
  }));
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function listSettings(): Promise<SettingsRecord[]> {
  const rows = await db()`
    /* sk:list-settings */
    select skill_id, trigger, scope, schedule, updated_by, updated_at
    from skill_settings
  `;
  return rows.map((row) => ({
    skill_id: String(row.skill_id),
    trigger: triggerFromStored(row.trigger),
    triggerInvalid: !(typeof row.trigger === "string" && isTrigger(row.trigger)),
    scope: asScope(row.scope),
    schedule: row.schedule == null ? null : String(row.schedule),
    updated_by: row.updated_by == null ? null : String(row.updated_by),
    updated_at: iso(row.updated_at) ?? new Date(0).toISOString(),
  }));
}

export async function upsertSettings(row: SettingsRecord): Promise<void> {
  await db()`
    /* sk:upsert-settings */
    insert into skill_settings (skill_id, trigger, scope, schedule, updated_by, updated_at)
    values (
      ${row.skill_id}, ${row.trigger}, ${JSON.stringify(row.scope)}::jsonb,
      ${row.schedule}, ${row.updated_by}, ${row.updated_at}::timestamptz
    )
    on conflict (skill_id) do update set
      trigger = excluded.trigger,
      scope = excluded.scope,
      schedule = excluded.schedule,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `;
}

export interface RunStat {
  skill_id: string;
  triggers_7d: number;
  last_agent: string | null;
  last_at: string | null;
}

export async function runStats(sinceIso: string): Promise<RunStat[]> {
  const rows = await db()`
    /* sk:run-stats */
    select skill_id,
      count(*) filter (where started_at >= ${sinceIso}::timestamptz)::int as triggers_7d,
      (array_agg(agent_id order by started_at desc))[1] as last_agent,
      max(started_at) as last_at
    from skill_runs
    group by skill_id
  `;
  return rows.map((row) => ({
    skill_id: String(row.skill_id),
    triggers_7d: Number(row.triggers_7d ?? 0),
    last_agent: row.last_agent == null ? null : String(row.last_agent),
    last_at: iso(row.last_at),
  }));
}

export async function recentRuns(skillId: string, limit: number): Promise<RunRecord[]> {
  const rows = await db()`
    /* sk:recent-runs */
    select run_id, skill_id, skill_sha, agent_id, lane, runtime, started_at, ended_at,
      status, note, actor_type, actor_id
    from skill_runs
    where skill_id = ${skillId}
    order by started_at desc
    limit ${limit}
  `;
  return rows.map(mapRun);
}

export function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    run_id: String(row.run_id),
    skill_id: String(row.skill_id),
    skill_sha: String(row.skill_sha),
    agent_id: String(row.agent_id),
    lane: row.lane == null ? null : String(row.lane),
    runtime: String(row.runtime),
    started_at: iso(row.started_at) ?? new Date(0).toISOString(),
    ended_at: iso(row.ended_at),
    status: row.status === "done" || row.status === "failed" ? row.status : "running",
    note: row.note == null ? null : String(row.note),
    actor_type: row.actor_type == null || row.actor_type === "" ? null : String(row.actor_type),
    actor_id: row.actor_id == null || row.actor_id === "" ? null : String(row.actor_id),
  };
}

export async function insertRun(row: RunRecord): Promise<void> {
  await db()`
    /* sk:insert-run */
    insert into skill_runs (
      run_id, skill_id, skill_sha, agent_id, lane, runtime, started_at, ended_at,
      status, note, actor_type, actor_id
    ) values (
      ${row.run_id}::uuid, ${row.skill_id}, ${row.skill_sha}, ${row.agent_id}, ${row.lane},
      ${row.runtime}, ${row.started_at}::timestamptz, null,
      'running', null, ${row.actor_type}, ${row.actor_id}
    )
  `;
}

export async function getRun(runId: string): Promise<RunRecord | null> {
  if (!isUuid(runId)) return null;
  const rows = await db()`
    /* sk:get-run */
    select run_id, skill_id, skill_sha, agent_id, lane, runtime, started_at, ended_at,
      status, note, actor_type, actor_id
    from skill_runs
    where run_id = ${runId}::uuid
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Updates only an open run owned by this actor. Returns the row when updated. */
export async function completeRun(input: {
  runId: string;
  actorType: string;
  actorId: string;
  status: "done" | "failed";
  note: string | null;
  endedAt: string;
}): Promise<RunRecord | null> {
  if (!isUuid(input.runId)) return null;
  const rows = await db()`
    /* sk:complete-run */
    update skill_runs
    set ended_at = ${input.endedAt}::timestamptz, status = ${input.status}, note = ${input.note}
    where run_id = ${input.runId}::uuid
      and ended_at is null
      and actor_type = ${input.actorType}
      and actor_id = ${input.actorId}
    returning run_id, skill_id, skill_sha, agent_id, lane, runtime, started_at, ended_at,
      status, note, actor_type, actor_id
  `;
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function deleteRun(runId: string): Promise<void> {
  if (!isUuid(runId)) return;
  await db()`
    /* sk:delete-run */
    delete from skill_runs where run_id = ${runId}::uuid
  `;
}

export interface DriftRow {
  host: string;
  dir: string;
  reported_at: string;
  entries: { name: string; sha: string }[];
}

export async function listDrift(): Promise<DriftRow[]> {
  const rows = await db()`
    /* sk:list-drift */
    select host, dir, reported_at, entries from skill_drift
  `;
  return rows.map((row) => ({
    host: String(row.host),
    dir: String(row.dir),
    reported_at: iso(row.reported_at) ?? new Date(0).toISOString(),
    entries: asDriftEntries(row.entries),
  }));
}

function asDriftEntries(value: unknown): { name: string; sha: string }[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? safeArray(value) : [];
  const out: { name: string; sha: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    const sha = (item as { sha?: unknown }).sha;
    if (typeof name === "string" && typeof sha === "string") out.push({ name, sha });
  }
  return out;
}

export async function upsertDrift(row: DriftRow): Promise<void> {
  await db()`
    /* sk:upsert-drift */
    insert into skill_drift (host, dir, reported_at, entries)
    values (${row.host}, ${row.dir}, ${row.reported_at}::timestamptz, ${JSON.stringify(row.entries)}::jsonb)
    on conflict (host, dir) do update set
      reported_at = excluded.reported_at,
      entries = excluded.entries
  `;
}

export async function digestRuns(sinceIso: string): Promise<RunRecord[]> {
  const rows = await db()`
    /* sk:digest-runs */
    select run_id, skill_id, skill_sha, agent_id, lane, runtime, started_at, ended_at,
      status, note, actor_type, actor_id
    from skill_runs
    where started_at >= ${sinceIso}::timestamptz or ended_at is null
  `;
  return rows.map(mapRun);
}
