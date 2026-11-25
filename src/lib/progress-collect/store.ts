/**
 * Database wiring for the hosted progress collector: the single-runner lock and
 * the in-process versions of the HTTP calls collect-progress.sh made.
 */
import { sql, withTransaction } from "../db";
import { parseReconcile, parseUpsert, reconcileDecisions, upsertDecision } from "../decisions";
import { validateOwnerName } from "../owner-validation";
import { parseCollectorSweptAt } from "../owner-discovery";
import { briefConfig, LANE_BOT_PREFIX, SHARED_BOT_PREFIXES } from "../progress-config";
import { ingestSnapshots } from "../progress-store";
import { readOwnerSettings, readRepoSettings } from "../settings-read";
import { applyOwnerDiscovery, DiscoveryShortConflict, listWatchedOwners, ruleOf, sweepOf, type DiscoveryRequest } from "../watched-owners";
import { loadTrackedRepos } from "../watched-repos";
import type { DiscoveryResult } from "./activity";
import type { CollectDeps } from "./run";
import type { DecisionSink, SweepSettings } from "./sweep";
import { LANE_PR_CAP } from "./sweep";

export const COLLECTOR_LOCK_KEY = "agent-kontrol:progress-collect";

/**
 * Runs `fn` only if no other collection holds the lock. The lock is a
 * transaction-scoped advisory lock (as sweeper.ts uses), taken with the
 * try variant so a second, overlapping invocation returns at once. It is held
 * on its own connection for the whole run and released when that transaction
 * ends, including when the function is killed and the connection drops.
 */
export async function withCollectorLock<T>(fn: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  return withTransaction(async (tx) => {
    const rows = await tx`select pg_try_advisory_xact_lock(hashtext(${COLLECTOR_LOCK_KEY})) as locked`;
    if (rows[0]?.locked !== true) return { busy: true } as const;
    return { busy: false, value: await fn() } as const;
  });
}

export function sweepSettings(): SweepSettings {
  const brief = briefConfig();
  return {
    laneBotPrefix: LANE_BOT_PREFIX,
    sharedBotPrefixes: [...SHARED_BOT_PREFIXES],
    decisionLabels: brief.decisionLabels,
    stuckPrHours: brief.stuckPrHours,
    staleIssueDays: brief.staleIssueDays,
    lanePrCap: LANE_PR_CAP,
  };
}

export async function latestActivityAt(): Promise<string | null> {
  const rows = await sql()`select max(collected_at) as at from repo_snapshots where kind = 'activity'`;
  const at = rows[0]?.at;
  if (at == null) return null;
  return at instanceof Date ? at.toISOString() : new Date(String(at)).toISOString();
}

export async function tickAges(): Promise<Map<string, string>> {
  const rows = await sql()`
    select lower(repo) as repo, max(collected_at) as at
    from repo_snapshots where kind = 'tick' group by lower(repo)
  `;
  return new Map(rows.map((r) => [String(r.repo), r.at instanceof Date ? r.at.toISOString() : new Date(String(r.at)).toISOString()]));
}

/** What POST /api/settings/owners/discover does with a collector tick, in process. */
export async function applyDiscovery(results: DiscoveryResult[]): Promise<boolean> {
  const now = new Date();
  const listed = await listWatchedOwners();
  if (!listed.writable) return false;
  let existing = await loadTrackedRepos();
  let clean = true;
  for (const result of results) {
    const name = validateOwnerName(result.owner);
    const swept = parseCollectorSweptAt(result.swept_at, now);
    if (!name.ok || !swept.ok) {
      clean = false;
      continue;
    }
    const stored = listed.owners.find((owner) => owner.owner === name.owner);
    if (!stored) {
      clean = false;
      continue;
    }
    const request: DiscoveryRequest = result.ok
      ? { owner: name.owner, ok: true, error: null, repos: result.repos, truncated: false, sweptAt: swept.sweptAt }
      : { owner: name.owner, ok: false, error: result.error, sweptAt: swept.sweptAt, failureCode: "collection_failed" };
    try {
      const outcome = await applyOwnerDiscovery(ruleOf(stored), existing, sweepOf(request), now);
      if (!outcome.failure) existing = outcome.repos;
      if (outcome.failure || outcome.skipped === "stale" || !result.ok) clean = false;
    } catch (e) {
      if (!(e instanceof DiscoveryShortConflict)) throw e;
      clean = false;
    }
  }
  return clean;
}

/** POST /api/decisions, in process: the same parse, the same upsert and reconcile. */
export const decisionSink: DecisionSink = {
  async upsert(body) {
    const parsed = parseUpsert(body);
    if (!parsed.ok) return false;
    const result = await upsertDecision(parsed.value);
    return !result.writeback_in_progress;
  },
  async reconcile(input) {
    const parsed = parseReconcile({ reconcile: input });
    if (!parsed.ok) return false;
    await reconcileDecisions(parsed.value);
    return true;
  },
};

export function defaultDeps(token: string): CollectDeps {
  return {
    token,
    now: Date.now,
    settings: sweepSettings(),
    ingest: ingestSnapshots,
    readOwners: readOwnerSettings,
    readRepos: readRepoSettings,
    applyDiscovery,
    latestActivityAt,
    tickAges,
    decisions: decisionSink,
  };
}
