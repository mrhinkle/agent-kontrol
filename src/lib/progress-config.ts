/**
 * The progress board's configuration: which repos it watches and where the
 * alert thresholds sit.
 *
 * Repo-agnostic by design — adding a fourth repo is one entry here plus one
 * line in scripts/collect-progress.sh's REPOS array. Nothing else changes.
 */

export interface RepoConfig {
  /** owner/name as GitHub knows it */
  repo: string;
  /** display name on the card */
  label: string;
  /** short key used in copy and alerts */
  short: string;
  /** accent used for this repo's line on the history graph */
  color: string;
  /**
   * The label this repo uses for "scoped but waiting on something". Each repo
   * spells it differently, and some repos have none — null means
   * blocked work is not tracked there, which the board says out loud rather
   * than reporting a comforting 0%.
   */
  blockedLabel: string | null;
}

export const REPOS: RepoConfig[] = [
  { repo: "example-org/app-server", label: "App Server", short: "app", color: "#f44800", blockedLabel: null },
  { repo: "example-org/web-studio", label: "Web Studio", short: "web", color: "#2563eb", blockedLabel: "blocked" },
  { repo: "example-org/agent-harness", label: "Agent Harness", short: "harness", color: "#19d2ff", blockedLabel: "dependency-blocked" },
];

export function repoConfig(repo: string): RepoConfig | undefined {
  return REPOS.find((r) => r.repo === repo);
}

/**
 * Thresholds. Each one is the line past which the board says something out
 * loud in "Needs you" — every number here is a claim you can argue with, which
 * is the point of keeping them in one place.
 */
export const THRESHOLDS = {
  /** open issues labelled dependency-blocked, as a share of open issues */
  blockedRatio: 0.4,
  /** consecutive daily snapshots with net_backlog > 0 before it's an alert */
  backlogGrowingDays: 3,
  /** an open PR with green checks and no state change for this long is stalled */
  stalledPrHours: 24,
  /** mean review invocations per merged PR */
  reviewRounds: 3.0,
  /** share of review rounds that returned no parseable verdict */
  noVerdictRate: 0.15,
} as const;

export const WINDOWS = ["24h", "7d", "30d", "90d"] as const;
export type TimeWindow = (typeof WINDOWS)[number];

export function windowDays(w: TimeWindow): number {
  return { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[w];
}

export function isWindow(v: string | null): v is TimeWindow {
  return !!v && (WINDOWS as readonly string[]).includes(v);
}
