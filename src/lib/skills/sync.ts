import { randomUUID } from "node:crypto";
import { assembleSkills } from "./assemble";
import { SYNC_LEASE_MS, skillNow } from "./clock";
import { planSync } from "./plan";
import { readUpstream } from "./query";
import { createGitHubFetcher, type SkillSnapshotFetcher } from "./source";
import { beginSyncRun, finishSyncRun, listSkillRows, listSources, markSkillRemoved, SyncLeaseLost, upsertSkill } from "./store";
import type { SkillRecord, SyncConflict, SyncError, SyncResult, SyncSkillRef, SyncTrigger } from "./types";

export interface SyncOptions {
  trigger: SyncTrigger;
  fetcher?: SkillSnapshotFetcher;
}

/**
 * Mirror enabled sources.
 *
 * A source that cannot be fetched keeps its rows. Vanished files are a removal
 * only after a successful fetch of that source. A second overlapping sync
 * returns busy and writes nothing. When nothing changed, no skill row is written.
 * The sync run row still records the commit that was fetched.
 *
 * A SKILL.md that cannot be parsed is not written. An existing row and its
 * settings stay. A skill that was not stored yet is skipped. The run is failed.
 *
 * status is failed when a source was not fetched, a SKILL.md could not be
 * parsed, or a SKILL.md was too large to read. A reported id conflict, a
 * skipped reference, or an ignored runtime name does not by itself fail the run.
 * Failed still lists the rows that were written. It is not "nothing happened".
 *
 * Skill writes and the finish update run only while this sync's row is still
 * running. If a newer sync took the lease, this one stops and returns busy.
 */
export async function syncSkills(options: SyncOptions): Promise<SyncResult> {
  const id = randomUUID();
  const started = skillNow();
  const staleBefore = new Date(started.getTime() - SYNC_LEASE_MS).toISOString();
  const locked = await beginSyncRun({
    id,
    trigger: options.trigger,
    startedAt: started.toISOString(),
    staleBefore,
  });
  if (!locked) {
    const upstream = await readUpstream().catch(() => emptyUpstream());
    return { status: "busy", added: [], changed: [], removed: [], conflicts: [], errors: [], upstream };
  }
  try {
    const applied = await runSync(options, started, id);
    const error = applied.errors.length ? applied.errors.map((item) => `${item.source}: ${item.message}`).join("; ") : null;
    const closed = await finishSyncRun({
      id,
      status: applied.status,
      summary: {
        sources: applied.sourceCommits,
        added: applied.added,
        changed: applied.changed,
        removed: applied.removed,
        conflicts: applied.conflicts,
      },
      error,
      finishedAt: skillNow().toISOString(),
    });
    if (!closed) return leaseLost();
    const upstream = await readUpstream();
    return { ...applied, upstream };
  } catch (err) {
    if (err instanceof SyncLeaseLost) return leaseLost();
    const message = err instanceof Error ? err.message : "sync failed";
    const errors: SyncError[] = [{ source: "sync", message }];
    try {
      await finishSyncRun({
        id,
        status: "failed",
        summary: { sources: [], added: [], changed: [], removed: [], conflicts: [] },
        error: message,
        finishedAt: skillNow().toISOString(),
      });
    } catch (writeErr) {
      console.error("[skills] failed to record the sync run", writeErr);
    }
    const upstream = await readUpstream().catch(() => emptyUpstream());
    return { status: "failed", added: [], changed: [], removed: [], conflicts: [], errors, upstream };
  }
}

interface Applied {
  status: "ok" | "failed";
  added: SyncSkillRef[];
  changed: SyncSkillRef[];
  removed: string[];
  conflicts: SyncConflict[];
  errors: SyncError[];
  sourceCommits: { id: string; commit_sha: string }[];
}

async function leaseLost(): Promise<SyncResult> {
  const upstream = await readUpstream().catch(() => emptyUpstream());
  return {
    status: "busy",
    added: [],
    changed: [],
    removed: [],
    conflicts: [],
    errors: [{ source: "sync", message: "sync lease lost" }],
    upstream,
  };
}

async function runSync(options: SyncOptions, started: Date, runId: string): Promise<Applied> {
  const fetcher = options.fetcher ?? createGitHubFetcher();
  const sources = await listSources();
  const existing = await listSkillRows();
  const added: SyncSkillRef[] = [];
  const changed: SyncSkillRef[] = [];
  const removed: string[] = [];
  const conflicts: SyncConflict[] = [];
  const errors: SyncError[] = [];
  const sourceCommits: { id: string; commit_sha: string }[] = [];
  const failedSourceIds: string[] = [];
  const successfulSourceIds: string[] = [];
  const candidates = [];
  const preserved = [];
  let failed = false;
  const syncedAt = started.toISOString();

  for (const source of sources) {
    let snapshot;
    try {
      snapshot = await fetcher.fetch(source);
    } catch (err) {
      failed = true;
      failedSourceIds.push(source.id);
      errors.push({ source: source.id, message: err instanceof Error ? err.message : "fetch failed" });
      continue;
    }
    successfulSourceIds.push(source.id);
    sourceCommits.push({ id: source.id, commit_sha: snapshot.commit_sha });
    for (const skip of snapshot.skipped ?? []) {
      errors.push({ source: source.id, message: `${skip.path} skipped (${skip.reason})` });
    }
    const assembled = assembleSkills({
      source_id: source.id,
      position: source.position,
      globs: source.path_globs,
      files: snapshot.files,
      preservedDirs: snapshot.preserved_dirs ?? [],
    });
    if (assembled.errors.length > 0) failed = true;
    for (const item of assembled.errors) errors.push({ source: source.id, message: `${item.path}: ${item.message}` });
    for (const item of assembled.notices) errors.push({ source: source.id, message: `${item.path}: ${item.message}` });
    for (const skill of assembled.skills) {
      for (const problem of skill.problems) {
        failed = true;
        errors.push({ source: source.id, message: `${skill.path}: ${problem}` });
      }
    }
    candidates.push(...assembled.skills);
    preserved.push(...assembled.preserved);
  }

  const plan = planSync({
    failedSourceIds,
    successfulSourceIds,
    existing,
    candidates,
    preserved,
  });
  for (const conflict of plan.conflicts) {
    conflicts.push({
      id: conflict.id,
      kept_source: conflict.winner.source_id,
      dropped_source: conflict.loser.source_id,
      path: conflict.loser.path,
    });
  }
  for (const kept of plan.kept) {
    const dropped = candidates.find((skill) => skill.id === kept.id && skill.source_id === kept.source_id);
    conflicts.push({
      id: kept.id,
      kept_source: kept.blocked_by,
      dropped_source: kept.source_id,
      path: dropped?.path ?? kept.id,
    });
  }

  const existingById = new Map(existing.map((row) => [row.id, row]));
  for (const skill of plan.upserts) {
    const prior = existingById.get(skill.id);
    const commit = sourceCommits.find((item) => item.id === skill.source_id)?.commit_sha ?? prior?.commit_sha ?? null;
    const next: SkillRecord = {
      id: skill.id,
      source_id: skill.source_id,
      path: skill.path,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      sha: skill.sha,
      commit_sha: commit,
      body: skill.body,
      references: skill.references,
      runtimes: skill.runtimes,
      category: skill.category,
      tags: skill.tags,
      frontmatter: skill.frontmatter,
      removed_at: null,
      synced_at: syncedAt,
    };
    await upsertSkill(next, runId);
    const ref = { id: next.id, version: next.version, sha: next.sha };
    if (!prior || prior.removed_at) added.push(ref);
    else changed.push(ref);
  }
  for (const row of plan.removals) {
    await markSkillRemoved(row.id, syncedAt, runId);
    removed.push(row.id);
  }

  return {
    status: failed ? "failed" : "ok",
    added,
    changed,
    removed,
    conflicts,
    errors,
    sourceCommits,
  };
}

function emptyUpstream(): SyncResult["upstream"] {
  return { source: "", sha: null, syncedAt: null, driftCount: 0 };
}
