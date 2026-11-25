import { THRESHOLDS } from "./progress-config";
import type { HistoryPoint, RepoProgress } from "./progress-types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A repo with open work and no activity for this long is stale. */
export const STALE_AFTER_MS = 3 * DAY;
/** Past this it is going stale: worth a look, not yet a problem. */
export const COOLING_AFTER_MS = DAY;
/** The collector ticks every 15 minutes; an hour without a sync means it stopped. */
export const SYNC_STALE_AFTER_MS = HOUR;

export type Freshness = "moving" | "cooling" | "stale" | "idle" | "unknown";

export interface RepoState {
  /** Time with no push, PR or issue update, measured at the last activity check. */
  idleMs: number | null;
  freshness: Freshness;
  hasOpenWork: boolean;
  overBlocked: boolean;
  /** Longest-idle open PR the collector flagged, if any. */
  oldestStalled: RepoProgress["stalled_prs"][number] | null;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Idle time is measured against when activity was last checked, not against
 * the wall clock: if the collector stopped, "now minus last activity" would
 * claim idleness nobody observed.
 */
export function repoState(r: RepoProgress, now: number): RepoState {
  const last = ms(r.activity?.last_activity_at);
  const checked = ms(r.activity?.checked_at) ?? ms(r.last_collected_at) ?? now;
  const idleMs = last === null ? null : Math.max(0, Math.min(checked, now) - last);
  const hasOpenWork = (r.open_prs ?? 0) > 0 || (r.open_issues ?? 0) > 0;
  const shipped = (r.merged_prs ?? 0) > 0 || (r.issues_closed ?? 0) > 0;

  let freshness: Freshness;
  if (idleMs === null) freshness = shipped ? "moving" : "unknown";
  else if (idleMs < COOLING_AFTER_MS || shipped) freshness = "moving";
  else if (!hasOpenWork) freshness = "idle";
  else if (idleMs < STALE_AFTER_MS) freshness = "cooling";
  else freshness = "stale";

  const oldestStalled = r.stalled_prs.reduce<RepoState["oldestStalled"]>(
    (worst, pr) => (worst === null || pr.idle_hours > worst.idle_hours ? pr : worst),
    null,
  );

  return {
    idleMs,
    freshness,
    hasOpenWork,
    overBlocked: r.blocked_ratio !== null && r.blocked_ratio > THRESHOLDS.blockedRatio,
    oldestStalled,
  };
}

export type SortKey = "attention" | "stalest" | "shipped" | "backlog" | "name";
export type FilterKey = "all" | "moving" | "stale";

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "stalest", label: "Stalest first" },
  { key: "shipped", label: "Most shipped" },
  { key: "backlog", label: "Backlog grew" },
  { key: "name", label: "Name" },
];

/** Higher means look at it first. Stale open work outranks everything else. */
export function attentionScore(r: RepoProgress, s: RepoState): number {
  let score = 0;
  if (s.freshness === "stale") score += 4;
  else if (s.freshness === "cooling") score += 2;
  if (s.overBlocked) score += 2;
  if (r.net_backlog !== null && r.net_backlog > 0) score += 1;
  score += Math.min(r.stalled_prs.length, 3) * 0.5;
  return score;
}

const idleDesc = (a: RepoState, b: RepoState) => (b.idleMs ?? -1) - (a.idleMs ?? -1);

export function matchesFilter(s: RepoState, filter: FilterKey): boolean {
  if (filter === "moving") return s.freshness === "moving";
  if (filter === "stale") return s.freshness === "stale" || s.freshness === "cooling";
  return true;
}

export function sortRepos(repos: RepoProgress[], key: SortKey, now: number): { repo: RepoProgress; state: RepoState }[] {
  const rows = repos.map((repo) => ({ repo, state: repoState(repo, now) }));
  const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.repo.label.localeCompare(b.repo.label);
  rows.sort((a, b) => {
    switch (key) {
      case "attention":
        return attentionScore(b.repo, b.state) - attentionScore(a.repo, a.state) || idleDesc(a.state, b.state) || byName(a, b);
      case "stalest":
        // Repos with open work lead: an idle repo with nothing open is finished, not stale.
        return Number(b.state.hasOpenWork) - Number(a.state.hasOpenWork) || idleDesc(a.state, b.state) || byName(a, b);
      case "shipped":
        return (b.repo.merged_prs ?? -1) - (a.repo.merged_prs ?? -1) || (b.repo.issues_closed ?? -1) - (a.repo.issues_closed ?? -1) || byName(a, b);
      case "backlog":
        return (b.repo.net_backlog ?? -Infinity) - (a.repo.net_backlog ?? -Infinity) || byName(a, b);
      case "name":
        return byName(a, b);
    }
  });
  return rows;
}

/** "3d", "5h", "40m". */
export function formatSpan(spanMs: number): string {
  if (spanMs >= DAY) return `${Math.floor(spanMs / DAY)}d`;
  if (spanMs >= HOUR) return `${Math.floor(spanMs / HOUR)}h`;
  return `${Math.max(1, Math.floor(spanMs / 60000))}m`;
}

/** Daily backlog for one repo, oldest first, for a card sparkline. */
export function backlogSeries(history: HistoryPoint[], repo: string, points = 30): number[] {
  return history
    .filter((h) => h.repo === repo)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-points)
    .map((h) => h.backlog);
}
