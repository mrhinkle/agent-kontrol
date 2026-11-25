/**
 * One hosted collection tick for the progress board (Vercel Cron, every 5 minutes).
 *
 * 1. Activity scan (port of collect-progress-activity.py + discover_watched_owners),
 *    only when the newest kind=activity snapshot is older than 15 minutes.
 * 2. Detailed sweep: the dashboard repo list, oldest kind=tick snapshot first and
 *    never-collected repos before all, as many as fit before the budget ends. Each
 *    repo is collected completely and then written with its own collected_at, or
 *    not written at all.
 *
 * Every dependency is injected so tests drive it with a fake fetch and a fake store.
 */
// ingestSnapshots stores a null field as NULL (its num() helper); SnapshotInput only types numbers.
import type { IngestInput, SnapshotInput } from "../progress-store";
import type { OwnerSettingsBody, RepoSettingsBody } from "../settings-read";
import { scanActivity, type DiscoveryResult } from "./activity";
import {
  CollectDeadlineError,
  GitHubAuthError,
  GitHubRateLimitError,
  ProgressGitHub,
  type FetchLike,
} from "./github";
import { collectRepo, syncRepoDecisions, type DecisionSink, type SweepRepo, type SweepSettings } from "./sweep";

/** Stop starting new work after this much wall time. */
export const COLLECT_BUDGET_MS = 240_000;
/** No GitHub call starts after this; the in-flight repo is dropped, not written. */
export const COLLECT_HARD_DEADLINE_MS = 285_000;
/** The activity scan reruns once its newest snapshot is this old. */
export const ACTIVITY_REFRESH_MS = 15 * 60_000;

export interface CollectDeps {
  token: string;
  fetchImpl?: FetchLike;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  hardDeadlineMs?: number;
  searchSpacingMs?: number;
  searchRetryDelayMs?: number;
  settings: SweepSettings;
  ingest: (input: IngestInput) => Promise<number>;
  readOwners: () => Promise<OwnerSettingsBody>;
  readRepos: () => Promise<RepoSettingsBody>;
  /** Applies discovery results; true when every owner applied cleanly (no failure, no stale skip). */
  applyDiscovery: (results: DiscoveryResult[]) => Promise<boolean>;
  /** Newest kind=activity collected_at, or null. */
  latestActivityAt: () => Promise<string | null>;
  /** Newest kind=tick collected_at per lowercased repo. */
  tickAges: () => Promise<Map<string, string>>;
  decisions: DecisionSink;
}

export type ActivityStatus =
  | "fresh"
  | "complete"
  | "partial"
  | "settings_unavailable"
  | "failed"
  | "github_auth"
  | "rate_limited"
  | "deadline";

export interface CollectBody {
  ok: boolean;
  error?: "github_auth" | "rate_limited" | "collect_failed";
  activity: { ran: boolean; repos: number; status: ActivityStatus };
  sweep: { collected: string[]; remaining: number; rate_limited: boolean };
  elapsed_ms: number;
}

export interface CollectOutcome {
  status: number;
  body: CollectBody;
}

/** The dashboard list, filtered as `refresh_repos_from_dashboard`: gone repos dropped. */
export function sweepTargets(body: RepoSettingsBody): SweepRepo[] {
  return body.repos
    .filter((r) => r.gone !== true)
    .map((r) => ({ repo: r.repo, label: r.label, blockedLabel: r.blockedLabel ?? null, short: r.short ?? "" }));
}

/** Never-collected repos first (dashboard order), then oldest tick first. */
export function rotationOrder(targets: SweepRepo[], ages: Map<string, string>): SweepRepo[] {
  return targets
    .map((t, i) => ({ t, i, at: ages.get(t.repo.toLowerCase()) ?? null }))
    .sort((a, b) => {
      if (a.at === null && b.at === null) return a.i - b.i;
      if (a.at === null) return -1;
      if (b.at === null) return 1;
      const d = Date.parse(a.at) - Date.parse(b.at);
      return d !== 0 ? d : a.i - b.i;
    })
    .map((x) => x.t);
}

async function runActivity(gh: ProgressGitHub, deps: CollectDeps): Promise<{ status: ActivityStatus; repos: number }> {
  let owners: OwnerSettingsBody;
  let repos: RepoSettingsBody;
  try {
    [owners, repos] = await Promise.all([deps.readOwners(), deps.readRepos()]);
  } catch (err) {
    console.error("[progress-collect] activity: settings unavailable; previous observations retained", err);
    return { status: "settings_unavailable", repos: 0 };
  }
  if (owners.writable !== true || !Array.isArray(owners.owners) || !Array.isArray(repos.repos)) {
    return { status: "settings_unavailable", repos: 0 };
  }
  let scan;
  try {
    scan = await scanActivity(gh, owners.owners, repos.repos, deps.now);
  } catch (err) {
    if (err instanceof GitHubAuthError) return { status: "github_auth", repos: 0 };
    if (err instanceof GitHubRateLimitError) return { status: "rate_limited", repos: 0 };
    if (err instanceof CollectDeadlineError) return { status: "deadline", repos: 0 };
    console.error("[progress-collect] activity: scan failed; previous observations retained");
    return { status: "failed", repos: 0 };
  }
  let clean = true;
  if (scan.discovery.results.length > 0) {
    try {
      if (!(await deps.applyDiscovery(scan.discovery.results))) clean = false;
    } catch (err) {
      console.error("[progress-collect] activity: discovery incomplete", err);
      clean = false;
    }
  }
  let written = 0;
  const expected = scan.snapshot.repos.length;
  if (expected > 0) {
    written = await deps.ingest(scan.snapshot as IngestInput);
    if (written !== expected) clean = false;
  }
  const covered = scan.snapshot.repos.every((r) => r.detail.activity.status === "complete") &&
    scan.discovery.results.every((d) => d.ok);
  return { status: clean && covered ? "complete" : "partial", repos: written };
}

export async function runProgressCollection(deps: CollectDeps): Promise<CollectOutcome> {
  const started = deps.now();
  const budgetEnd = started + (deps.budgetMs ?? COLLECT_BUDGET_MS);
  const gh = new ProgressGitHub({
    token: deps.token,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    sleep: deps.sleep,
    searchSpacingMs: deps.searchSpacingMs,
    searchRetryDelayMs: deps.searchRetryDelayMs,
    hardDeadline: started + (deps.hardDeadlineMs ?? COLLECT_HARD_DEADLINE_MS),
  });
  const body: CollectBody = {
    ok: true,
    activity: { ran: false, repos: 0, status: "fresh" },
    sweep: { collected: [], remaining: 0, rate_limited: false },
    elapsed_ms: 0,
  };
  const finish = (status: number): CollectOutcome => {
    body.elapsed_ms = deps.now() - started;
    return { status, body };
  };

  // ---- activity scan, when stale or absent
  const lastActivity = await deps.latestActivityAt();
  const lastMs = lastActivity ? Date.parse(lastActivity) : Number.NaN;
  if (Number.isNaN(lastMs) || started - lastMs >= ACTIVITY_REFRESH_MS) {
    body.activity.ran = true;
    const activity = await runActivity(gh, deps);
    body.activity.status = activity.status;
    body.activity.repos = activity.repos;
    if (activity.status === "github_auth") {
      body.ok = false;
      body.error = "github_auth";
      return finish(502);
    }
    if (activity.status === "rate_limited") {
      body.sweep.rate_limited = true;
    }
  }

  // ---- detailed sweep
  const repos = await deps.readRepos();
  const targets = rotationOrder(sweepTargets(repos), await deps.tickAges());
  let stoppedBy: "github_auth" | "rate_limited" | "deadline" | null = body.sweep.rate_limited ? "rate_limited" : null;
  let next = 0;
  for (; next < targets.length && stoppedBy === null; next += 1) {
    if (deps.now() >= budgetEnd) break;
    const target = targets[next];
    let collected;
    try {
      collected = await collectRepo(gh, target, deps.settings, deps.now());
    } catch (err) {
      if (err instanceof GitHubAuthError) stoppedBy = "github_auth";
      else if (err instanceof GitHubRateLimitError) stoppedBy = "rate_limited";
      else if (err instanceof CollectDeadlineError) stoppedBy = "deadline";
      else throw err;
      break;
    }
    const collectedAt = new Date(deps.now()).toISOString();
    const written = await deps.ingest({ collected_at: collectedAt, kind: "tick", repos: [collected.row as unknown as SnapshotInput] });
    if (written === 1) body.sweep.collected.push(target.repo);
    try {
      await syncRepoDecisions(target, collected.listings, deps.settings, deps.decisions);
    } catch (err) {
      console.error(`[progress-collect] decisions: sync failed for ${target.repo}`, err);
    }
  }
  body.sweep.remaining = targets.length - body.sweep.collected.length;
  if (stoppedBy === "rate_limited") body.sweep.rate_limited = true;

  if (stoppedBy === "github_auth") {
    body.ok = false;
    body.error = "github_auth";
    return finish(502);
  }
  if (body.sweep.collected.length === 0 && targets.length > 0 && stoppedBy !== null) {
    // Zero repos collected because of an error is never ok.
    body.ok = false;
    body.error = stoppedBy === "rate_limited" ? "rate_limited" : "collect_failed";
    return finish(502);
  }
  return finish(200);
}
