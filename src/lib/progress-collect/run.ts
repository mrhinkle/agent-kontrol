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
import { progressEligible } from "../progress-activity";
import type { OwnerSettingsBody, RepoSettingsBody } from "../settings-read";
import { scanActivity, type DiscoveryResult } from "./activity";
import {
  CollectDeadlineError,
  GitHubAuthError,
  GitHubRateLimitError,
  GITHUB_FETCH_TIMEOUT_MS,
  ProgressGitHub,
  RepoTimeCapError,
  type FetchLike,
} from "./github";
import { collectRepo, syncRepoDecisions, type DecisionSink, type SweepRepo, type SweepSettings } from "./sweep";

/**
 * Time limits, all measured from the start of the run, against the route's
 * maxDuration of 300 s:
 * - no new repo starts after COLLECT_BUDGET_MS (240 s);
 * - no GitHub request or wait runs past COLLECT_HARD_DEADLINE_MS (260 s): each
 *   request's timeout is clipped to the time left, so the slowest possible
 *   request still ends by 260 s, and the in-flight repo is then dropped, not written;
 * - the one snapshot write and decision upserts that follow stop starting at
 *   COLLECT_DB_DEADLINE_MS (275 s), leaving 25 s for the statement in flight
 *   and the lock's commit.
 */
export const MAX_DURATION_MS = 300_000;
export const COLLECT_BUDGET_MS = 240_000;
export const COLLECT_HARD_DEADLINE_MS = 260_000;
export const COLLECT_DB_DEADLINE_MS = 275_000;
/** One repo may use at most this much; past it the repo is skipped for this run. */
export const REPO_TIME_CAP_MS = 90_000;

// The arithmetic the comment above claims, checked when the module loads.
if (!(COLLECT_BUDGET_MS + GITHUB_FETCH_TIMEOUT_MS <= COLLECT_HARD_DEADLINE_MS &&
  COLLECT_HARD_DEADLINE_MS < COLLECT_DB_DEADLINE_MS && COLLECT_DB_DEADLINE_MS + 10_000 <= MAX_DURATION_MS &&
  REPO_TIME_CAP_MS < COLLECT_BUDGET_MS)) {
  throw new Error("progress collector time limits do not fit maxDuration");
}
/** The activity scan reruns once its newest snapshot is this old. */
export const ACTIVITY_REFRESH_MS = 15 * 60_000;

export interface CollectDeps {
  token: string;
  fetchImpl?: FetchLike;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  hardDeadlineMs?: number;
  dbDeadlineMs?: number;
  repoTimeCapMs?: number;
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
  sweep: {
    collected: string[];
    /** Repos given up on this run, with why. Nothing was written for them. */
    skipped: { repo: string; reason: "repo_time_cap" | "deadline" | "error" }[];
    remaining: number;
    rate_limited: boolean;
  };
  elapsed_ms: number;
}

export interface CollectOutcome {
  status: number;
  body: CollectBody;
}

/**
 * The dashboard list, limited to repos the board can show (`progressEligible`:
 * not gone, not hidden, not excluded by the owner's fork/archive rule unless
 * pinned). collect-progress.sh dropped only gone repos; the others cost budget
 * for rows the board and the brief never display.
 */
export function sweepTargets(body: RepoSettingsBody): SweepRepo[] {
  return body.repos
    .filter(progressEligible)
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
    sweep: { collected: [], skipped: [], remaining: 0, rate_limited: false },
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
  const dbDeadline = started + (deps.dbDeadlineMs ?? COLLECT_DB_DEADLINE_MS);
  const repoCap = deps.repoTimeCapMs ?? REPO_TIME_CAP_MS;
  for (; next < targets.length && stoppedBy === null; next += 1) {
    if (deps.now() >= budgetEnd) break;
    const target = targets[next];
    let collected;
    gh.setRepoDeadline(deps.now() + repoCap);
    try {
      collected = await collectRepo(gh, target, deps.settings, deps.now());
    } catch (err) {
      if (err instanceof GitHubAuthError) stoppedBy = "github_auth";
      else if (err instanceof GitHubRateLimitError) stoppedBy = "rate_limited";
      else if (err instanceof CollectDeadlineError) {
        stoppedBy = "deadline";
        body.sweep.skipped.push({ repo: target.repo, reason: "deadline" });
      } else {
        // A slow or failing repo is given up for this run; the next oldest still gets its turn.
        const reason = err instanceof RepoTimeCapError ? "repo_time_cap" : "error";
        if (reason === "error") console.error(`[progress-collect] ${target.repo} failed; skipped this run`, err);
        body.sweep.skipped.push({ repo: target.repo, reason });
      }
      continue;
    } finally {
      gh.setRepoDeadline(null);
    }
    if (deps.now() >= dbDeadline) {
      body.sweep.skipped.push({ repo: target.repo, reason: "deadline" });
      stoppedBy = "deadline";
      continue;
    }
    const collectedAt = new Date(deps.now()).toISOString();
    const written = await deps.ingest({ collected_at: collectedAt, kind: "tick", repos: [collected.row as unknown as SnapshotInput] });
    if (written === 1) body.sweep.collected.push(target.repo);
    try {
      await syncRepoDecisions(target, collected.listings, deps.settings, deps.decisions, () => deps.now() >= dbDeadline);
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
  if (body.sweep.collected.length === 0 && targets.length > 0 && (stoppedBy !== null || body.sweep.skipped.length > 0)) {
    // Zero repos collected because of an error is never ok.
    body.ok = false;
    body.error = stoppedBy === "rate_limited" ? "rate_limited" : "collect_failed";
    return finish(502);
  }
  return finish(200);
}
