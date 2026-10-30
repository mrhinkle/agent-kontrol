import { sql } from "./db";
import { REPOS, THRESHOLDS, windowDays, type TimeWindow } from "./progress-config";
import type { SkillsDigest } from "./progress-types";
import { stallMinutes } from "./skills/clock";
import { getWatchedRepos, visibleOnBoard } from "./watched-repos";
import type {
  Alert,
  FleetTotals,
  HistoryPoint,
  ProgressResponse,
  RepoProgress,
  RepoSnapshot,
  SnapshotDetail,
  StalledPr,
} from "./progress-types";

/* ------------------------------------------------------------------ write */

export interface SnapshotInput {
  repo: string;
  label?: string;
  open_issues?: number;
  open_prs?: number;
  blocked_issues?: number;
  merged_prs_24h?: number;
  issues_closed_24h?: number;
  issues_opened_24h?: number;
  total_issues_created?: number;
  total_issues_closed?: number;
  total_prs_merged?: number;
  review_rounds?: number;
  no_verdict_rate?: number;
  detail?: SnapshotDetail;
}

/** Documented `kind` values for POST /api/progress/ingest. The route stores any string. */
export const PROGRESS_INGEST_KINDS = ["tick", "daily", "backfill"] as const;

export interface IngestInput {
  collected_at?: string;
  kind?: string;
  repos: SnapshotInput[];
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Write one collection tick. Idempotent on (repo, collected_at), so a retried
 * cron run or a re-run backfill corrects the row instead of duplicating it.
 */
export async function ingestSnapshots(input: IngestInput): Promise<number> {
  const db = sql();
  const collectedAt = input.collected_at ?? new Date().toISOString();
  const kind = input.kind ?? "tick";
  let written = 0;

  for (const r of input.repos) {
    if (!r.repo) continue;
    await db`
      insert into repo_snapshots (
        repo, label, collected_at, kind,
        open_issues, open_prs, blocked_issues,
        merged_prs_24h, issues_closed_24h, issues_opened_24h,
        total_issues_created, total_issues_closed, total_prs_merged,
        review_rounds, no_verdict_rate, detail
      ) values (
        ${r.repo}, ${r.label ?? null}, ${collectedAt}, ${kind},
        ${num(r.open_issues)}, ${num(r.open_prs)}, ${num(r.blocked_issues)},
        ${num(r.merged_prs_24h)}, ${num(r.issues_closed_24h)}, ${num(r.issues_opened_24h)},
        ${num(r.total_issues_created)}, ${num(r.total_issues_closed)}, ${num(r.total_prs_merged)},
        ${num(r.review_rounds)}, ${num(r.no_verdict_rate)},
        ${JSON.stringify(r.detail ?? {})}::jsonb
      )
      on conflict (repo, collected_at) do update set
        label = coalesce(excluded.label, repo_snapshots.label),
        kind = excluded.kind,
        open_issues = excluded.open_issues,
        open_prs = excluded.open_prs,
        blocked_issues = excluded.blocked_issues,
        merged_prs_24h = excluded.merged_prs_24h,
        issues_closed_24h = excluded.issues_closed_24h,
        issues_opened_24h = excluded.issues_opened_24h,
        total_issues_created = excluded.total_issues_created,
        total_issues_closed = excluded.total_issues_closed,
        total_prs_merged = excluded.total_prs_merged,
        review_rounds = excluded.review_rounds,
        no_verdict_rate = excluded.no_verdict_rate,
        detail = excluded.detail
    `;
    written++;
  }
  return written;
}

/* ------------------------------------------------------------------- read */

type Row = Record<string, unknown>;

function toSnapshot(row: Row): RepoSnapshot {
  return {
    repo: String(row.repo),
    label: (row.label as string) ?? null,
    collected_at: new Date(row.collected_at as string).toISOString(),
    kind: String(row.kind ?? "tick"),
    open_issues: num(row.open_issues),
    open_prs: num(row.open_prs),
    blocked_issues: num(row.blocked_issues),
    merged_prs_24h: num(row.merged_prs_24h),
    issues_closed_24h: num(row.issues_closed_24h),
    issues_opened_24h: num(row.issues_opened_24h),
    total_issues_created: num(row.total_issues_created),
    total_issues_closed: num(row.total_issues_closed),
    total_prs_merged: num(row.total_prs_merged),
    review_rounds: num(row.review_rounds),
    no_verdict_rate: num(row.no_verdict_rate),
    detail: (row.detail as SnapshotDetail) ?? null,
  };
}

/**
 * Newest *live* snapshot per repo.
 *
 * Backfilled rows carry only the cumulative counters — GitHub cannot tell you
 * retroactively how deep the queue was on a past Tuesday — so they must not win
 * "latest" just by having a later timestamp than the last tick. `open_issues is
 * not null` is the marker of a row that actually swept the repo.
 *
 * `distinct on (lower(repo))` folds case variants of one `owner/name` onto the
 * newest live row. The map key is that lowercased name.
 */
async function latestPerRepo(): Promise<Map<string, RepoSnapshot>> {
  const db = sql();
  const rows = (await db`
    select distinct on (lower(repo)) *
    from repo_snapshots
    where open_issues is not null
    order by lower(repo), collected_at desc
  `) as Row[];
  return new Map(rows.map((r) => [String(r.repo).toLowerCase(), toSnapshot(r)]));
}

/** Newest snapshot per repo at or before `ts` — the window's starting line. */
async function baselinePerRepo(ts: string): Promise<Map<string, RepoSnapshot>> {
  const db = sql();
  const rows = (await db`
    select distinct on (lower(repo)) *
    from repo_snapshots
    where collected_at <= ${ts}
    order by lower(repo), collected_at desc
  `) as Row[];
  return new Map(rows.map((r) => [String(r.repo).toLowerCase(), toSnapshot(r)]));
}

/**
 * One point per repo per UTC day: the day's last tick.
 * Case variants of one repo share the day's newest tick.
 */
async function dailyHistory(sinceIso: string): Promise<HistoryPoint[]> {
  const db = sql();
  const rows = (await db`
    select distinct on (lower(repo), (collected_at at time zone 'utc')::date)
      repo,
      to_char((collected_at at time zone 'utc')::date, 'YYYY-MM-DD') as date,
      total_issues_created,
      total_issues_closed
    from repo_snapshots
    where collected_at >= ${sinceIso}
      and total_issues_created is not null
    order by lower(repo), (collected_at at time zone 'utc')::date, collected_at desc
  `) as Row[];

  return rows
    .map((r) => {
      const created = num(r.total_issues_created) ?? 0;
      const closed = num(r.total_issues_closed) ?? 0;
      return {
        date: String(r.date),
        repo: String(r.repo),
        total_issues_created: created,
        total_issues_closed: closed,
        backlog: created - closed,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.repo.localeCompare(b.repo)));
}

/**
 * History points keep the stored casing of the winning tick. The board and
 * the chart join them to the watched row, so a matched repo uses that row's name.
 */
function alignHistoryRepos(history: HistoryPoint[], watched: { repo: string }[]): HistoryPoint[] {
  const canon = new Map(watched.map((cfg) => [cfg.repo.toLowerCase(), cfg.repo]));
  return history.map((point) => {
    const repo = canon.get(point.repo.toLowerCase());
    if (!repo || repo === point.repo) return point;
    return { ...point, repo };
  });
}

/** Agent spend inside the window, from the existing task ledger. */
async function spendSince(sinceIso: string): Promise<number | null> {
  const db = sql();
  try {
    const rows = (await db`
      select coalesce(sum(cost_usd), 0) as spend
      from tasks
      where completed_at >= ${sinceIso}
    `) as Row[];
    return num(rows[0]?.spend) ?? 0;
  } catch {
    return null; // tasks table not migrated yet — the strip just omits spend
  }
}

/**
 * Difference two cumulative counters. Returns null when either side is
 * missing so the caller can fall back rather than render a confident zero.
 */
function delta(now: number | null, then: number | null): number | null {
  if (now === null || then === null) return null;
  return Math.max(0, now - then);
}

function mergeLaneMix(target: Record<string, number>, add?: Record<string, number>): void {
  if (!add) return;
  for (const [k, v] of Object.entries(add)) target[k] = (target[k] ?? 0) + v;
}

/* ---------------------------------------------------------------- alerts */

export interface StalledSkillAlert {
  run_id: string;
  skill_id: string;
  agent: string;
  at: string;
}

/**
 * `stalledSkills` is optional so existing callers keep the same alerts.
 * More than three stalled runs roll into one alert. The id starts with skill-stalled:.
 */
export function buildAlerts(
  repos: RepoProgress[],
  history: HistoryPoint[],
  stalledSkills: StalledSkillAlert[] = [],
): Alert[] {
  const alerts: Alert[] = [];

  for (const r of repos) {
    // A repo with no blocked label has nothing to alert on, even if an earlier tick stored a count.
    if (r.blocked_label !== null && r.blocked_ratio !== null && r.blocked_ratio > THRESHOLDS.blockedRatio) {
      alerts.push({
        id: `blocked:${r.repo}`,
        level: "bad",
        repo: r.repo,
        rule: "blockedRatio",
        message: `${r.label}: ${Math.round(r.blocked_ratio * 100)}% of open issues are labeled "${r.blocked_label}" (over ${Math.round(
          THRESHOLDS.blockedRatio * 100
        )}%) — clear blockers before decomposing more`,
        url: `https://github.com/${r.repo}/issues?q=${encodeURIComponent(
          `is:issue is:open label:"${r.blocked_label}"`
        )}`,
      });
    }

    for (const pr of r.stalled_prs ?? []) {
      alerts.push({
        id: `stalled:${r.repo}#${pr.number}`,
        level: "warn",
        repo: r.repo,
        rule: "stalledPrHours",
        message: `${r.short} #${pr.number} open ${Math.floor(pr.idle_hours / 24)}d${
          pr.green ? ", checks green" : ""
        }${pr.draft ? ", draft" : ""} — ${pr.title.slice(0, 60)}`,
        url: pr.url,
      });
    }

    if (r.review_rounds !== null && r.review_rounds > THRESHOLDS.reviewRounds) {
      alerts.push({
        id: `rounds:${r.repo}`,
        level: "warn",
        repo: r.repo,
        rule: "reviewRounds",
        message: `${r.label} averaging ${r.review_rounds.toFixed(1)} review rounds per PR (over ${THRESHOLDS.reviewRounds})`,
      });
    }

    if (r.no_verdict_rate !== null && r.no_verdict_rate > THRESHOLDS.noVerdictRate) {
      alerts.push({
        id: `noverdict:${r.repo}`,
        level: "warn",
        repo: r.repo,
        rule: "noVerdictRate",
        message: `${r.label} review rounds returning no verdict ${Math.round(
          r.no_verdict_rate * 100
        )}% of the time — spend without signal`,
      });
    }
  }

  // Backlog growing N days running, per repo. Needs N+1 daily points to see
  // N day-over-day changes, so this stays quiet until the history exists.
  const need = THRESHOLDS.backlogGrowingDays;
  for (const cfg of repos) {
    const points = history.filter((h) => h.repo === cfg.repo);
    if (points.length < need + 1) continue;
    const tail = points.slice(-(need + 1));
    const growingEveryDay = tail.every((p, i) => i === 0 || p.backlog > tail[i - 1].backlog);
    if (growingEveryDay) {
      const grew = tail[tail.length - 1].backlog - tail[0].backlog;
      alerts.push({
        id: `growing:${cfg.repo}`,
        level: "bad",
        repo: cfg.repo,
        rule: "backlogGrowingDays",
        message: `${cfg.label} backlog has grown ${need} days running (+${grew} net)`,
      });
    }
  }

  if (stalledSkills.length > 3) {
    alerts.push({
      id: `skill-stalled:${stalledSkills.length}`,
      level: "warn",
      repo: null,
      rule: "skillStalled",
      message: `${stalledSkills.length} skill runs have no end after ${stallMinutes()} minutes.`,
    });
  } else {
    for (const run of stalledSkills) {
      alerts.push({
        id: `skill-stalled:${run.run_id}`,
        level: "warn",
        repo: null,
        rule: "skillStalled",
        message: `Skill ${run.skill_id} run ${run.run_id} started by ${run.agent} has no end.`,
      });
    }
  }

  return alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1));
}

/* ------------------------------------------------------------- assemble */

export async function progress(window: TimeWindow): Promise<Omit<ProgressResponse, "demo" | "generated_at">> {
  const days = windowDays(window);
  const latest = await latestPerRepo();

  const lastSync =
    [...latest.values()].map((s) => s.collected_at).sort().pop() ?? null;
  const anchor = lastSync ? new Date(lastSync) : new Date();
  const baselineTs = new Date(anchor.getTime() - days * 86_400_000).toISOString();

  const [baseline, history, spend] = await Promise.all([
    baselinePerRepo(baselineTs),
    // Always fetch a little more than the window so the graph has lead-in.
    dailyHistory(new Date(anchor.getTime() - Math.max(days, 14) * 86_400_000).toISOString()),
    spendSince(baselineTs),
  ]);

  let baselineAt: string | null = null;
  let windowComplete = true;

  // How far off the requested boundary a baseline may sit before its numbers
  // stop being a fair answer to the question asked. A "7d" figure measured from
  // 40 days ago is not a slow week, it is a wrong number.
  const targetMs = anchor.getTime() - days * 86_400_000;
  const slackMs = Math.max(6 * 3_600_000, days * 86_400_000 * 0.2);

  const watched = (await getWatchedRepos(REPOS)).repos.filter(visibleOnBoard);
  const namedHistory = alignHistoryRepos(history, watched);
  const repos: RepoProgress[] = watched.map((cfg) => {
    const now = latest.get(cfg.repo.toLowerCase());
    const then = baseline.get(cfg.repo.toLowerCase());
    const thenUsable = then !== undefined && targetMs - new Date(then.collected_at).getTime() <= slackMs;
    if (thenUsable && then && (!baselineAt || then.collected_at > baselineAt)) baselineAt = then.collected_at;

    let merged: number | null;
    let closed: number | null;
    let opened: number | null;

    if (days === 1) {
      // 24h is measured directly by the collector against GitHub, so use it
      // rather than differencing — exact, and available from the very first tick.
      merged = now?.merged_prs_24h ?? null;
      closed = now?.issues_closed_24h ?? null;
      opened = now?.issues_opened_24h ?? null;
    } else {
      // Longer windows difference two cumulative counters: exact, and immune to
      // the overlap you'd get by summing rolling 24h counts across ticks.
      const base = thenUsable ? then : undefined;
      merged = delta(now?.total_prs_merged ?? null, base?.total_prs_merged ?? null);
      closed = delta(now?.total_issues_closed ?? null, base?.total_issues_closed ?? null);
      opened = delta(now?.total_issues_created ?? null, base?.total_issues_created ?? null);
    }

    // No usable baseline yet: fall back to the one window we can always measure
    // and say plainly that it isn't the window that was asked for.
    if (merged === null || closed === null || opened === null) {
      if (days > 1) windowComplete = false;
      merged = merged ?? now?.merged_prs_24h ?? 0;
      closed = closed ?? now?.issues_closed_24h ?? 0;
      opened = opened ?? now?.issues_opened_24h ?? 0;
    }

    const openIssues = now?.open_issues ?? 0;
    const blocked = now?.blocked_issues ?? null;

    return {
      repo: cfg.repo,
      label: now?.label ?? cfg.label,
      short: cfg.short,
      color: cfg.color,
      open_issues: openIssues,
      open_prs: now?.open_prs ?? 0,
      blocked_issues: blocked,
      blocked_label: cfg.blockedLabel,
      blocked_ratio: blocked !== null && openIssues > 0 ? blocked / openIssues : null,
      merged_prs: merged,
      issues_closed: closed,
      issues_opened: opened,
      net_backlog: opened - closed,
      review_rounds: now?.review_rounds ?? null,
      no_verdict_rate: now?.no_verdict_rate ?? null,
      lane_mix: now?.detail?.lane_mix ?? {},
      stalled_prs: now?.detail?.stalled_prs ?? [],
      last_collected_at: now?.collected_at ?? null,
    };
  });

  const laneMix: Record<string, number> = {};
  for (const r of repos) mergeLaneMix(laneMix, r.lane_mix);

  const totals: FleetTotals = {
    merged_prs: repos.reduce((a, r) => a + r.merged_prs, 0),
    issues_closed: repos.reduce((a, r) => a + r.issues_closed, 0),
    issues_opened: repos.reduce((a, r) => a + r.issues_opened, 0),
    net_backlog: repos.reduce((a, r) => a + r.net_backlog, 0),
    open_issues: repos.reduce((a, r) => a + r.open_issues, 0),
    open_prs: repos.reduce((a, r) => a + r.open_prs, 0),
    spend_usd: spend,
    lane_mix: laneMix,
  };

  let skills: SkillsDigest | undefined;
  try {
    const { skillsDigest } = await import("./skills/digest");
    skills = await skillsDigest(window);
  } catch (err) {
    if (!skillsTableMissing(err)) throw err;
    console.error("[progress] skills digest omitted; skill tables are not installed");
  }

  return {
    window,
    last_sync: lastSync,
    baseline_at: baselineAt,
    // 24h needs no baseline — the collector measures it directly each tick.
    window_complete: days === 1 ? lastSync !== null : windowComplete && baselineAt !== null,
    repos,
    totals,
    history: namedHistory,
    alerts: buildAlerts(repos, namedHistory, skills?.stalled ?? []),
    ...(skills ? { skills } : {}),
  };
}

/* --------------------------------------------------------------- helpers */

/** Installed databases that predate the skills migration have no skill tables. */
function skillsTableMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "42P01") return true;
  const message = err instanceof Error ? err.message : "";
  return message.includes("does not exist");
}

export type { StalledPr };
