import { REPOS, windowDays, type TimeWindow } from "./progress-config";
import { buildAlerts } from "./progress-store";
import type { HistoryPoint, ProgressResponse, RepoProgress } from "./progress-types";

/**
 * Demo mode for the progress board - what /progress renders with no
 * DATABASE_URL, so the page can be built and reviewed without a database.
 *
 * All numbers are synthetic. They are shaped to show the board's point: a busy
 * day of merges on which some backlogs still grew. History is synthesised from
 * them, deterministically, so it doesn't jitter on every poll.
 */

interface Seed {
  repo: string;
  open_issues: number;
  open_prs: number;
  blocked_issues: number | null;
  merged_24h: number;
  closed_24h: number;
  opened_24h: number;
  total_created: number;
  total_closed: number;
  total_merged: number;
  lane_mix: Record<string, number>;
  review_rounds: number;
  no_verdict_rate: number;
}

const SEEDS: Record<string, Seed> = {
  "example-org/app-server": {
    repo: "example-org/app-server",
    open_issues: 40,
    open_prs: 2,
    blocked_issues: null,
    merged_24h: 12,
    closed_24h: 14,
    opened_24h: 18,
    total_created: 1200,
    total_closed: 1160,
    total_merged: 900,
    lane_mix: { unattributed: 12 },
    review_rounds: 2.0,
    no_verdict_rate: 0.1,
  },
  "example-org/web-studio": {
    repo: "example-org/web-studio",
    open_issues: 100,
    open_prs: 6,
    blocked_issues: 30,
    merged_24h: 1,
    closed_24h: 2,
    opened_24h: 4,
    total_created: 500,
    total_closed: 400,
    total_merged: 300,
    lane_mix: {},
    review_rounds: 2.5,
    no_verdict_rate: 0.1,
  },
  "example-org/agent-harness": {
    repo: "example-org/agent-harness",
    open_issues: 60,
    open_prs: 4,
    blocked_issues: 24,
    merged_24h: 6,
    closed_24h: 7,
    opened_24h: 10,
    total_created: 400,
    total_closed: 340,
    total_merged: 320,
    lane_mix: { "agent-lanes-grok[bot]": 4, "agent-lanes-codex[bot]": 2 },
    review_rounds: 2.5,
    no_verdict_rate: 0.1,
  },
};

const STALLED = {
  "example-org/web-studio": [
    {
      number: 101,
      title: "harden the deploy path for first-run users",
      url: "https://github.com/example-org/web-studio/pull/101",
      idle_hours: 120,
      green: true,
      draft: false,
    },
    {
      number: 102,
      title: "prune stale conversation threads",
      url: "https://github.com/example-org/web-studio/pull/102",
      idle_hours: 130,
      green: false,
      draft: true,
    },
  ],
};

/** Generic numbers for a configured repo that has no hand-written seed above. */
export function seedFor(repo: string): Seed {
  return (
    SEEDS[repo] ?? {
      repo,
      open_issues: 30,
      open_prs: 2,
      blocked_issues: null,
      merged_24h: 3,
      closed_24h: 4,
      opened_24h: 5,
      total_created: 300,
      total_closed: 270,
      total_merged: 200,
      lane_mix: {},
      review_rounds: 2.0,
      no_verdict_rate: 0.1,
    }
  );
}

/** Deterministic 0..1 from an integer — keeps demo history stable across polls. */
function jitter(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function demoHistory(days: number, anchor: Date): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (const cfg of REPOS) {
    const s = seedFor(cfg.repo);
    for (let d = days; d >= 0; d--) {
      const day = new Date(anchor.getTime() - d * 86_400_000);
      // Walk the cumulative counters backwards from today at roughly the
      // observed daily rate, with a stable wobble so the lines aren't ruler-straight.
      const openRate = Math.max(s.opened_24h, 1);
      const closeRate = Math.max(s.closed_24h, 1);
      const wob = (i: number) => 0.55 + 0.9 * jitter(d * 7 + i);
      const created = Math.round(s.total_created - d * openRate * wob(1));
      const closed = Math.round(s.total_closed - d * closeRate * wob(2));
      points.push({
        date: day.toISOString().slice(0, 10),
        repo: cfg.repo,
        total_issues_created: created,
        total_issues_closed: closed,
        backlog: created - closed,
      });
    }
  }
  return points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.repo.localeCompare(b.repo)));
}

export function demoProgress(window: TimeWindow): ProgressResponse {
  const days = windowDays(window);
  const anchor = new Date("2026-01-15T12:00:00Z");

  const repos: RepoProgress[] = REPOS.map((cfg) => {
    const s = seedFor(cfg.repo);
    // Scale the window counts off the observed day, damped — a 30-day window
    // is not 30 identical days.
    const scale = days === 1 ? 1 : days * 0.72;
    const merged = Math.round(s.merged_24h * scale);
    const closed = Math.round(s.closed_24h * scale);
    const opened = Math.round(s.opened_24h * scale);
    const laneMix: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.lane_mix)) laneMix[k] = Math.round(v * scale);

    return {
      repo: cfg.repo,
      label: cfg.label,
      short: cfg.short,
      color: cfg.color,
      open_issues: s.open_issues,
      open_prs: s.open_prs,
      blocked_issues: s.blocked_issues,
      blocked_ratio: s.blocked_issues === null ? null : s.blocked_issues / s.open_issues,
      merged_prs: merged,
      issues_closed: closed,
      issues_opened: opened,
      net_backlog: opened - closed,
      review_rounds: s.review_rounds,
      no_verdict_rate: s.no_verdict_rate,
      lane_mix: laneMix,
      stalled_prs: STALLED[cfg.repo as keyof typeof STALLED] ?? [],
      last_collected_at: anchor.toISOString(),
    };
  });

  const laneMix: Record<string, number> = {};
  for (const r of repos) for (const [k, v] of Object.entries(r.lane_mix)) laneMix[k] = (laneMix[k] ?? 0) + v;

  const history = demoHistory(Math.max(days, 14), anchor);

  return {
    demo: true,
    window,
    last_sync: anchor.toISOString(),
    baseline_at: new Date(anchor.getTime() - days * 86_400_000).toISOString(),
    window_complete: true,
    repos,
    totals: {
      merged_prs: repos.reduce((a, r) => a + r.merged_prs, 0),
      issues_closed: repos.reduce((a, r) => a + r.issues_closed, 0),
      issues_opened: repos.reduce((a, r) => a + r.issues_opened, 0),
      net_backlog: repos.reduce((a, r) => a + r.net_backlog, 0),
      open_issues: repos.reduce((a, r) => a + r.open_issues, 0),
      open_prs: repos.reduce((a, r) => a + r.open_prs, 0),
      spend_usd: 4.18,
      lane_mix: laneMix,
    },
    history,
    alerts: buildAlerts(repos, history),
    generated_at: new Date().toISOString(),
  };
}
