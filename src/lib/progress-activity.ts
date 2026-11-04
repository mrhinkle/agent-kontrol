import type { ProgressActivity, RepoSnapshot } from "./progress-types";
import type { WatchedRepo } from "./watched-repos";

export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_FRESH_MS = 2 * 60 * 60 * 1000;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown, now: number): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now ? parsed : null;
}

function complete(snapshot: RepoSnapshot | undefined, now: number): boolean {
  const observation = snapshot?.detail?.activity;
  return Boolean(observation && observation.status === "complete" &&
    timestamp(observation.checked_at, now) !== null && count(snapshot?.open_prs) && count(observation.open_issues) &&
    [observation.pushed_at, observation.pr_updated_at, observation.issue_updated_at]
      .every((value) => value === null || timestamp(value, now) !== null));
}

/** User exclusions precede pins; owner preferences precede activity selection. */
export function progressEligible(repo: WatchedRepo): boolean {
  return !repo.hidden && !repo.gone && (repo.pinned === true || !repo.ownerExcluded);
}

/**
 * Activity is a rolling wall-clock view, independent of the metric window.
 * A failed newest scan never turns an older success into fresh evidence.
 */
export function progressActivity(
  repo: WatchedRepo,
  metric: RepoSnapshot | undefined,
  latest: RepoSnapshot | undefined,
  priorSuccess: RepoSnapshot | undefined,
  now: number,
): { shown: boolean; activity: ProgressActivity; open_prs: number | null; open_issues: number | null } {
  const validLatest = complete(latest, now);
  const evidence = validLatest ? latest : complete(priorSuccess, now) ? priorSuccess : undefined;
  const observation = evidence?.detail?.activity;
  const checked = latest?.detail?.activity?.checked_at ?? null;
  const checkedMs = timestamp(checked, now);
  const status: ProgressActivity["status"] = !latest ? "legacy" : !validLatest ? "unavailable"
    : checkedMs !== null && now - checkedMs <= ACTIVITY_FRESH_MS ? "fresh" : "stale";
  const openPrs = evidence ? evidence.open_prs : count(metric?.open_prs) ? metric.open_prs : null;
  const openIssues = observation ? observation.open_issues : count(metric?.open_issues) ? metric.open_issues : null;
  const dates = observation
    ? [observation.pushed_at, observation.pr_updated_at, observation.issue_updated_at]
    : [repo.lastActivityAt];
  const activityTimes = dates.map((at) => timestamp(at, now)).filter((at): at is number => at !== null);
  const lastActivity = activityTimes.length ? Math.max(...activityTimes) : null;
  const reasons: ProgressActivity["reasons"] = [];
  if (openPrs !== null && openPrs > 0) reasons.push("open_prs");
  if (lastActivity !== null && now - lastActivity <= ACTIVITY_WINDOW_MS) reasons.push("recent_activity");
  if (repo.pinned) reasons.push("pinned");
  return {
    shown: progressEligible(repo) && reasons.length > 0,
    activity: {
      status, checked_at: checkedMs === null ? null : checked,
      last_activity_at: lastActivity === null ? null : new Date(lastActivity).toISOString(), reasons,
    },
    open_prs: openPrs, open_issues: openIssues,
  };
}
