/**
 * The contract between the collector, the API, and the page.
 *
 * Only this file is shared across those three layers — same discipline as
 * gibson-types.ts. If a field isn't here, the page doesn't get to read it.
 */

import type { TimeWindow } from "./progress-config";

/** One repo's row for one collection tick — mirrors the repo_snapshots table. */
export interface RepoSnapshot {
  repo: string;
  label: string | null;
  collected_at: string;
  kind: "tick" | "daily" | "backfill" | string;

  open_issues: number | null;
  open_prs: number | null;
  blocked_issues: number | null;

  merged_prs_24h: number | null;
  issues_closed_24h: number | null;
  issues_opened_24h: number | null;

  total_issues_created: number | null;
  total_issues_closed: number | null;
  total_prs_merged: number | null;

  review_rounds: number | null;
  no_verdict_rate: number | null;

  detail: SnapshotDetail | null;
}

export interface StalledPr {
  number: number;
  title: string;
  url: string;
  /** hours since the last state change */
  idle_hours: number;
  /** true when every required check has passed — green but going nowhere */
  green: boolean;
  draft: boolean;
}

export interface SnapshotDetail {
  /**
   * Commits on the default branch in the window, counted by bot identity.
   * A repo that commits everything under one vendor-neutral bot, so its work
   * lands in `unattributed` until the identity is split. Never guess here.
   */
  lane_mix?: Record<string, number>;
  stalled_prs?: StalledPr[];
  /**
   * Morning-brief fields written by the collector. Absent on older ticks.
   * `stuck_prs[].repo` is the config short name, matching `scripts/morning-brief.sh`.
   * `merged` rows carry timestamps so a 72h brief can filter them. `merged_list`
   * is the 24h display list when timestamps were not stored. The collector
   * writes only that 24h window into `merged_list` and `median_lead_hours`.
   */
  stuck_prs?: BriefSnapshotStuckPr[];
  median_lead_hours?: number | null;
  stale_issues?: number | null;
  stale_ratio?: number | null;
  drafts?: number | null;
  merged_list?: BriefSnapshotMerged[];
  merged?: BriefSnapshotMergedRaw[];
  /** anything the collector wants to say about a partial run */
  notes?: string[];
}

/** Stuck PR as `scripts/morning-brief.sh` prints it. `repo` is the short name. */
export interface BriefSnapshotStuckPr {
  repo?: string;
  number?: number;
  title?: string;
  url?: string;
  author?: string | null;
  age_hours?: number;
  age_days?: number;
  idle_days?: number;
  state?: string | null;
  review?: string | null;
  reason?: string;
}

export interface BriefSnapshotMerged {
  number?: number;
  title?: string;
  url?: string;
  author?: string | null;
  lead_hours?: number | null;
}

export interface BriefSnapshotMergedRaw {
  number?: number;
  title?: string;
  url?: string;
  author?: string | null;
  created_at?: string;
  merged_at?: string;
}

/** What a card shows: the current tick, plus the window's totals. */
export interface RepoProgress {
  repo: string;
  label: string;
  short: string;
  color: string;

  /** queue depth right now */
  open_issues: number;
  open_prs: number;
  /** null when the repo has no blocked label — not tracked, not zero */
  blocked_issues: number | null;
  /** the GitHub label that marks blocked work in this repo; null when not tracked */
  blocked_label: string | null;
  /** blocked_issues / open_issues; null when blocked work isn't tracked */
  blocked_ratio: number | null;

  /** totals across the selected window */
  merged_prs: number;
  issues_closed: number;
  issues_opened: number;
  /**
   * issues_opened − issues_closed. Positive means the queue grew: the number
   * that makes a 28-merge day read honestly. Negative is good.
   */
  net_backlog: number;

  review_rounds: number | null;
  no_verdict_rate: number | null;
  lane_mix: Record<string, number>;
  stalled_prs: StalledPr[];

  /** when this repo was last collected; null if it never has been */
  last_collected_at: string | null;
}

/** One point on the history graph, per repo. */
export interface HistoryPoint {
  date: string; // YYYY-MM-DD (UTC)
  repo: string;
  total_issues_created: number;
  total_issues_closed: number;
  /** created − closed at that moment: the gap you want closing */
  backlog: number;
}

export type AlertLevel = "warn" | "bad";

export interface Alert {
  id: string;
  level: AlertLevel;
  /** repo this is about, or null for fleet-wide */
  repo: string | null;
  /** which THRESHOLDS key tripped */
  rule: string;
  message: string;
  /** optional deep link to the thing that needs a human */
  url?: string;
}

export interface FleetTotals {
  merged_prs: number;
  issues_closed: number;
  issues_opened: number;
  net_backlog: number;
  open_issues: number;
  open_prs: number;
  /** sum of tasks.cost_usd completed inside the window */
  spend_usd: number | null;
  lane_mix: Record<string, number>;
}

/** Counts of skill runs that started inside the digest window, plus current stalls. */
export interface SkillsDigest {
  window: TimeWindow;
  triggers_by_skill: { id: string; count: number }[];
  triggers_by_runtime: { claude: number; codex: number; grok: number; hermes: number; mini: number };
  /** Open runs past the stall window, including ones that started before `window`. */
  stalled: { run_id: string; skill_id: string; agent: string; at: string }[];
  /** Enabled skills with no run inside the window. */
  enabled_never_used: string[];
  note: "Only triggers routed through Agent Kontrol are counted.";
}

export interface ProgressResponse {
  demo: boolean;
  window: TimeWindow;
  /** newest collection tick across all repos, or null before the first run */
  last_sync: string | null;
  /**
   * The tick the window was measured against. Null means there was no snapshot
   * old enough, so the numbers cover less ground than the window claims — the
   * page says so rather than quietly reporting a short window as a full one.
   */
  baseline_at: string | null;
  window_complete: boolean;
  repos: RepoProgress[];
  totals: FleetTotals;
  history: HistoryPoint[];
  alerts: Alert[];
  /** Absent when the skills tables are not installed. Any other digest error fails the progress request. */
  skills?: SkillsDigest;
  generated_at: string;
}
