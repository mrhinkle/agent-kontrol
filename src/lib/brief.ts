import { apiError } from "@/lib/api-error";
import { briefConfig, filterWorkKinds, REPOS, resolveWorkKinds, type BriefSettings } from "@/lib/progress-config";
import type { RepoConfig } from "@/lib/progress-config";
import { hoursBetween, listDecisions, partitionBrief, type BriefDecision } from "@/lib/decisions";
import { isConfigured, sql } from "@/lib/db";
import type { RepoSnapshot, SnapshotDetail } from "@/lib/progress-types";
import { getWatchedRepos } from "@/lib/watched-repos";

/**
 * The morning brief, read from Postgres.
 *
 * The shape matches `scripts/morning-brief.sh --json`. The script stays the
 * fallback when this route is down: it still sweeps GitHub. This module never
 * calls GitHub. Counts, stuck PRs, and lead time come from the latest
 * `repo_snapshots` row (and, for a 72h window, from the cumulative counters).
 * Decisions come from the decisions table, joined on owner/name. Coordinator
 * liveness is a work event, never a heartbeat.
 */

export const BRIEF_WINDOWS = ["24h", "72h"] as const;
export type BriefWindow = (typeof BRIEF_WINDOWS)[number];

export interface BriefStuckPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  age_hours: number;
  age_days: number;
  idle_days: number | null;
  state: string | null;
  review: string | null;
  reason: string;
}

export interface BriefMergedPr {
  number: number;
  title: string;
  url: string;
  author: string | null;
  lead_hours: number | null;
}

export interface BriefRepo {
  repo: string;
  label: string;
  short: string;
  incomplete: boolean;
  errors: string[];
  merged_prs: number | null;
  median_lead_hours: number | null;
  issues_opened: number | null;
  issues_closed: number | null;
  net_backlog: number | null;
  open_issues: number | null;
  open_prs: number | null;
  drafts: number | null;
  stale_issues: number | null;
  stale_ratio: number | null;
  blocked_label: string | null;
  blocked_issues: number | null;
  stuck_prs: BriefStuckPr[] | null;
  decisions: BriefDecision[] | null;
  merged_list: BriefMergedPr[] | null;
}

export interface BriefCoordinator {
  configured: boolean;
  agent_id: string | null;
  found?: boolean;
  last_seen_at?: string | null;
  last_seen_hours?: number | null;
  last_work_at?: string | null;
  last_work_kind?: string | null;
  last_work_hours?: number | null;
  last_any_kind?: string | null;
  max_silence_hours?: number;
  recent_errors?: number;
  verdict?: string;
}

export interface MorningBrief {
  generated_at: string;
  window_hours: number;
  repo_source: string;
  thresholds: { stuck_pr_hours: number; stale_issue_days: number };
  coordinator: BriefCoordinator;
  incomplete_repos: { repo: string; errors: string[] }[];
  totals: {
    /**
     * Null when any watched repo is incomplete, or a counted repo lacks the
     * field. Zero is a measured empty set on every watched repo.
     */
    merged_prs: number | null;
    issues_opened: number | null;
    issues_closed: number | null;
    net_backlog: number | null;
    open_issues: number | null;
    open_prs: number | null;
    stuck_prs: number | null;
    decisions: number | null;
    repos_counted: number;
    repos_total: number;
  };
  repos: BriefRepo[];
  /** Null when the total is unmeasured and no row is known: an empty list would read as "none". */
  stuck_prs: BriefStuckPr[] | null;
  /** Null when the total is unmeasured and no row is known: an empty list would read as "none". */
  decisions: BriefDecision[] | null;
}

export interface CoordinatorEvent {
  kind: string;
  created_at: string;
}

export type BriefQuery =
  | { ok: true; window: BriefWindow; hours: 24 | 72 }
  | { ok: false; code: "validation_failed"; message: string; fields: Record<string, string> };

const WINDOW_FIELD = "window must be 24h or 72h.";

function queryFail(): BriefQuery {
  return { ok: false, code: "validation_failed", message: WINDOW_FIELD, fields: { window: WINDOW_FIELD } };
}

/**
 * `24h` and `72h` are the only windows. Omitted means 24h, same as the script.
 * An empty value, a different duration, a repeated `window`, or `window[]` is
 * rejected. Nothing here falls through to 24h.
 */
export function parseBriefQuery(params: URLSearchParams): BriefQuery {
  for (const key of params.keys()) {
    if (key !== "window" && key.startsWith("window")) return queryFail();
  }
  const values = params.getAll("window");
  if (values.length === 0) return { ok: true, window: "24h", hours: 24 };
  if (values.length !== 1) return queryFail();
  if (values[0] === "24h") return { ok: true, window: "24h", hours: 24 };
  if (values[0] === "72h") return { ok: true, window: "72h", hours: 72 };
  return queryFail();
}

export function briefQueryError(parsed: Extract<BriefQuery, { ok: false }>): Response {
  return apiError(parsed.code, { message: parsed.message, fields: parsed.fields });
}

/**
 * Plain text is the default, including when the client sends `Accept: *\/*`
 * or no Accept header. JSON is returned only when `application/json` has a
 * quality strictly greater than the effective quality of `text/plain`.
 * `text/plain` uses its own `q` when listed, otherwise `text/*`, otherwise
 * `*\/*`. A repeated media type uses its highest quality in 0..1. Equal
 * quality stays text.
 */
export function briefWantsJson(accept: string | null): boolean {
  if (!accept || !accept.trim()) return false;
  let jsonQ: number | null = null;
  let plainQ: number | null = null;
  let textStarQ: number | null = null;
  let starQ: number | null = null;
  for (const part of accept.split(",")) {
    const bits = part.split(";").map((bit) => bit.trim()).filter(Boolean);
    if (bits.length === 0) continue;
    const type = bits[0].toLowerCase();
    let q = 1;
    for (const bit of bits.slice(1)) {
      const match = /^q\s*=\s*([0-9]*\.?[0-9]+)$/i.exec(bit);
      if (!match) continue;
      const n = Number(match[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) q = n;
    }
    const higher = (current: number | null) => (current === null ? q : Math.max(current, q));
    if (type === "application/json") jsonQ = higher(jsonQ);
    else if (type === "text/plain") plainQ = higher(plainQ);
    else if (type === "text/*") textStarQ = higher(textStarQ);
    else if (type === "*/*") starQ = higher(starQ);
  }
  if (jsonQ === null || jsonQ <= 0) return false;
  const textQ = plainQ ?? textStarQ ?? starQ;
  if (textQ !== null && textQ >= jsonQ) return false;
  return true;
}

export function toSecondIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `date '+%a %Y-%m-%d %H:%M %Z'`. */
export function formatBriefClock(date: Date, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} ${parts.timeZoneName}`;
}

function stamp(iso: string): number {
  const ms = Date.parse(iso.replace(/\.[0-9]+(?=Z$)/, ""));
  return Number.isNaN(ms) ? 0 : ms;
}

function tenths(n: number): string {
  return String(Math.floor(n * 10) / 10);
}

function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/**
 * One window count from a cumulative counter.
 *
 * A missing baseline falls back to the 24h column: the first tick has no baseline.
 * A missing latest counter is unmeasured (null).
 * A decrease is a reset or rollback. That delta is null, and the 24h column
 * is not a stand-in for a number the counter no longer supports.
 */
function windowCount(
  windowHours: 24 | 72,
  day: number | null,
  latest: number | null,
  baseline: number | null,
): { value: number | null; reset: boolean } {
  if (windowHours === 24) return { value: day, reset: false };
  if (latest !== null && baseline !== null && latest < baseline) return { value: null, reset: true };
  // Only a missing baseline (first tick) may fall back to the 24h column. A missing
  // latest counter means this tick did not measure it: unmeasured, never a count.
  if (latest === null) return { value: null, reset: false };
  if (baseline === null) return { value: day, reset: false };
  return { value: latest - baseline, reset: false };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function stableByAgeDesc<T extends { age_hours: number }>(rows: T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.age_hours - a.row.age_hours || a.index - b.index)
    .map((item) => item.row);
}

export function coordinatorStatus(input: {
  agentId: string | null;
  maxSilenceHours: number;
  workKinds: readonly string[];
  nowIso: string;
  /** False when the events could not be read. A configured coordinator then says unknown. */
  reachable: boolean;
  /** Null when the id is not in `agents`. Ignored when `reachable` is false. */
  agent: { id: string; last_seen_at: string | null } | null;
  events: readonly CoordinatorEvent[];
}): BriefCoordinator {
  if (!input.agentId) return { configured: false, agent_id: null };
  if (!input.reachable) {
    return {
      configured: true,
      agent_id: input.agentId,
      verdict: "unknown: dashboard unreachable",
    };
  }
  const work = new Set(filterWorkKinds(input.workKinds));
  const events = [...input.events].sort((a, b) => stamp(b.created_at) - stamp(a.created_at));
  const age = (iso: string) => hoursBetween(iso, input.nowIso);
  const recent = events.filter((event) => age(event.created_at) <= input.maxSilenceHours);
  const recentWork = recent.find((event) => work.has(event.kind)) ?? null;
  const recentErrors = recent.filter((event) => event.kind === "error").length;
  const lastWork = events.find((event) => work.has(event.kind)) ?? null;
  const any = events[0] ?? null;
  const seenAt = input.agent?.last_seen_at ?? null;
  let verdict: string;
  if (!input.agent) verdict = "unknown: agent not registered";
  else if (recentWork) verdict = `working: last work event ${tenths(age(recentWork.created_at))}h ago`;
  else if (recentErrors > 0) {
    verdict = `FAILING: ${recentErrors} error event(s) in the last ${input.maxSilenceHours}h and no completed work`;
  } else if (lastWork) {
    verdict = `NOT WORKING: last work event ${Math.floor(age(lastWork.created_at))}h ago (limit ${input.maxSilenceHours}h)`;
  } else {
    verdict = `NOT WORKING: no work event in the dashboard window (only ${any?.kind ?? "nothing"})`;
  }
  return {
    configured: true,
    agent_id: input.agentId,
    found: input.agent !== null,
    last_seen_at: seenAt,
    last_seen_hours: seenAt ? Math.max(0, age(seenAt)) : null,
    last_work_at: lastWork?.created_at ?? null,
    last_work_kind: lastWork?.kind ?? null,
    last_work_hours: lastWork ? age(lastWork.created_at) : null,
    last_any_kind: any?.kind ?? null,
    max_silence_hours: input.maxSilenceHours,
    recent_errors: recentErrors,
    verdict,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stuckFromDetail(detail: SnapshotDetail | null, short: string): BriefStuckPr[] | null {
  const raw = detail?.stuck_prs;
  // Older ticks omit the key. That is unmeasured, not an empty fleet.
  if (!Array.isArray(raw)) return null;
  const out: BriefStuckPr[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const number = num(row.number);
    if (number === null) continue;
    const ageHours = num(row.age_hours) ?? 0;
    out.push({
      repo: str(row.repo) || short,
      number,
      title: str(row.title),
      url: str(row.url),
      author: typeof row.author === "string" ? row.author : null,
      age_hours: ageHours,
      age_days: num(row.age_days) ?? Math.floor(ageHours / 24),
      idle_days: num(row.idle_days),
      state: typeof row.state === "string" ? row.state : null,
      review: typeof row.review === "string" ? row.review : null,
      reason: str(row.reason),
    });
  }
  return out;
}

function leadHours(createdAt: string, mergedAt: string): number | null {
  const hours = hoursBetween(createdAt, mergedAt);
  return Number.isFinite(hours) ? hours : null;
}

function mergedFromDetail(detail: SnapshotDetail | null, windowHours: number, nowIso: string): {
  list: BriefMergedPr[] | null;
  median: number | null;
  fromTimestamps: boolean;
} {
  // An array owns the window, including an empty one. That is a measured
  // empty list. Do not replace it with merged_list or a stored median.
  if (Array.isArray(detail?.merged)) {
    const inWindow = detail.merged.filter((row) => {
      if (!row || typeof row.merged_at !== "string" || typeof row.created_at !== "string") return false;
      const age = hoursBetween(row.merged_at, nowIso);
      return Number.isFinite(age) && age >= 0 && age <= windowHours;
    });
    const list = inWindow.map((row) => ({
      number: num(row.number) ?? 0,
      title: str(row.title),
      url: str(row.url),
      author: typeof row.author === "string" ? row.author : null,
      lead_hours: leadHours(row.created_at as string, row.merged_at as string),
    }));
    const leads = list.map((row) => row.lead_hours).filter((hours): hours is number => hours !== null);
    return { list, median: median(leads), fromTimestamps: true };
  }
  const display = Array.isArray(detail?.merged_list) ? detail.merged_list : [];
  const list = display
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      number: num(row.number) ?? 0,
      title: str(row.title),
      url: str(row.url),
      author: typeof row.author === "string" ? row.author : null,
      lead_hours: num(row.lead_hours),
    }));
  // A 72h list comes only from detail.merged. The 24h display list is a
  // different window, so its absence here is unmeasured, not an empty array.
  if (windowHours !== 24) return { list: null, median: null, fromTimestamps: false };
  const storedMedian = num(detail?.median_lead_hours);
  const leads = list.map((row) => row.lead_hours).filter((hours): hours is number => hours !== null);
  return {
    list,
    median: storedMedian ?? median(leads),
    fromTimestamps: false,
  };
}

function incompleteSection(cfg: Pick<RepoConfig, "repo" | "label" | "short">, errors: string[]): BriefRepo {
  return {
    repo: cfg.repo,
    label: cfg.label,
    short: cfg.short,
    incomplete: true,
    errors,
    merged_prs: null,
    median_lead_hours: null,
    issues_opened: null,
    issues_closed: null,
    net_backlog: null,
    open_issues: null,
    open_prs: null,
    drafts: null,
    stale_issues: null,
    stale_ratio: null,
    blocked_label: null,
    blocked_issues: null,
    stuck_prs: null,
    decisions: null,
    merged_list: null,
  };
}

/**
 * One watched repo from its latest snapshot. No row is incomplete, not a zero.
 * A row whose measured counts are null is also incomplete: `open_issues`,
 * `open_prs`, and the window's merge and issue counts all have to be present.
 */
export function repoSection(args: {
  cfg: Pick<RepoConfig, "repo" | "label" | "short" | "blockedLabel">;
  snap: RepoSnapshot | null;
  baseline: RepoSnapshot | null;
  windowHours: 24 | 72;
  nowIso: string;
}): BriefRepo {
  const { cfg, snap } = args;
  if (!snap) return incompleteSection(cfg, ["no snapshot"]);
  const detail = snap.detail;
  const merged = windowCount(args.windowHours, snap.merged_prs_24h, snap.total_prs_merged, args.baseline?.total_prs_merged ?? null);
  const opened = windowCount(args.windowHours, snap.issues_opened_24h, snap.total_issues_created, args.baseline?.total_issues_created ?? null);
  const closed = windowCount(args.windowHours, snap.issues_closed_24h, snap.total_issues_closed, args.baseline?.total_issues_closed ?? null);
  const reset = merged.reset || opened.reset || closed.reset;
  if (
    snap.open_issues === null ||
    snap.open_prs === null ||
    merged.value === null ||
    opened.value === null ||
    closed.value === null
  ) {
    return incompleteSection(cfg, [reset ? "cumulative counter decreased" : "counts not measured"]);
  }
  const mergedRows = mergedFromDetail(detail, args.windowHours, args.nowIso);
  const staleIssues = num(detail?.stale_issues);
  const staleRatio = num(detail?.stale_ratio) ?? (
    staleIssues !== null && snap.open_issues > 0 ? staleIssues / snap.open_issues : staleIssues === 0 ? 0 : null
  );
  const blockedLabel = cfg.blockedLabel;
  return {
    repo: cfg.repo,
    label: cfg.label,
    short: cfg.short,
    incomplete: false,
    errors: [],
    merged_prs: merged.value,
    median_lead_hours: mergedRows.median,
    issues_opened: opened.value,
    issues_closed: closed.value,
    net_backlog: opened.value - closed.value,
    open_issues: snap.open_issues,
    open_prs: snap.open_prs,
    drafts: num(detail?.drafts),
    stale_issues: staleIssues,
    stale_ratio: staleRatio,
    blocked_label: blockedLabel,
    blocked_issues: blockedLabel ? snap.blocked_issues : null,
    stuck_prs: stuckFromDetail(detail, cfg.short),
    // The snapshot does not measure decisions. Null stays unmeasured until
    // the table join replaces it. An empty array here would be a counted zero.
    decisions: null,
    merged_list: mergedRows.list,
  };
}

const DECISION_INCOMPLETE = "decisions incomplete";
const DECISION_UNAVAILABLE = "decisions unavailable";

function withoutDecisionErrors(errors: readonly string[]): string[] {
  return errors.filter((error) => error !== DECISION_INCOMPLETE && error !== DECISION_UNAVAILABLE);
}

/**
 * Same join as `morning-brief.sh`: a table row lands on the watched repo whose
 * `owner/name` matches. The short name is display only.
 *
 * An array already on the section is a measurement (the script's GitHub sweep,
 * including a measured empty list). A hold, or a decisions read that did not
 * succeed, keeps that array. Null means this process did not sweep. Holding
 * that section, or failing the read, leaves it null and records why. It does
 * not become an empty list.
 */
export function applyTableDecisions(
  repos: readonly BriefRepo[],
  table: readonly BriefDecision[],
  incompleteRepos: readonly string[],
  measured = true,
): BriefRepo[] {
  const hold = new Set(incompleteRepos);
  return repos.map((section) => {
    if (section.incomplete) return section;
    const swept = section.decisions !== null;
    if (!measured || hold.has(section.repo)) {
      if (swept) return section;
      const reason = measured ? DECISION_INCOMPLETE : DECISION_UNAVAILABLE;
      const errors = section.errors.includes(reason) ? section.errors : [...section.errors, reason];
      return { ...section, decisions: null, errors };
    }
    return {
      ...section,
      decisions: table.filter((row) => row.repo === section.repo),
      errors: withoutDecisionErrors(section.errors),
    };
  });
}

type CountField = "merged_prs" | "issues_opened" | "issues_closed" | "net_backlog" | "open_issues" | "open_prs";
type ListField = "stuck_prs" | "decisions";

/** Null when the fleet was not fully measured. An empty counted set is a measured zero. */
function measuredSum(counted: readonly BriefRepo[], anyIncomplete: boolean, field: CountField): number | null {
  if (anyIncomplete || counted.some((repo) => repo[field] == null)) return null;
  return counted.reduce((total, repo) => total + (repo[field] ?? 0), 0);
}

function measuredLen(counted: readonly BriefRepo[], anyIncomplete: boolean, field: ListField): number | null {
  if (anyIncomplete || counted.some((repo) => repo[field] == null)) return null;
  return counted.reduce((total, repo) => total + (repo[field]?.length ?? 0), 0);
}

export function assembleBrief(input: {
  generatedAt: string;
  windowHours: number;
  repoSource: string;
  stuckPrHours: number;
  staleIssueDays: number;
  coordinator: BriefCoordinator;
  repos: readonly BriefRepo[];
}): MorningBrief {
  const repos = input.repos.map((repo) => {
    if (repo.incomplete || repo.decisions !== null) return repo;
    if (repo.errors.includes(DECISION_INCOMPLETE) || repo.errors.includes(DECISION_UNAVAILABLE)) return repo;
    return { ...repo, errors: [...repo.errors, DECISION_INCOMPLETE] };
  });
  const counted = repos.filter((repo) => !repo.incomplete);
  const anyIncomplete = counted.length !== repos.length;
  // Known rows from counted repos stay on the lists. Incomplete repos do not
  // contribute, and they do make the fleet total unknown.
  const stuck = stableByAgeDesc(
    counted.flatMap((repo) => repo.stuck_prs ?? []),
  );
  const decisions = stableByAgeDesc(
    counted.flatMap((repo) => repo.decisions ?? []),
  );
  const stuckTotal = measuredLen(counted, anyIncomplete, "stuck_prs");
  const decisionTotal = measuredLen(counted, anyIncomplete, "decisions");
  return {
    generated_at: input.generatedAt,
    window_hours: input.windowHours,
    repo_source: input.repoSource,
    thresholds: { stuck_pr_hours: input.stuckPrHours, stale_issue_days: input.staleIssueDays },
    coordinator: input.coordinator,
    // A counted repo with null decisions is a decision hole, not a snapshot hole.
    // Its counts stay in the totals. The error is how the JSON names the hole.
    incomplete_repos: repos.flatMap((repo) => {
      if (repo.incomplete || repo.decisions === null) return [{ repo: repo.repo, errors: repo.errors }];
      return [];
    }),
    totals: {
      merged_prs: measuredSum(counted, anyIncomplete, "merged_prs"),
      issues_opened: measuredSum(counted, anyIncomplete, "issues_opened"),
      issues_closed: measuredSum(counted, anyIncomplete, "issues_closed"),
      net_backlog: measuredSum(counted, anyIncomplete, "net_backlog"),
      open_issues: measuredSum(counted, anyIncomplete, "open_issues"),
      open_prs: measuredSum(counted, anyIncomplete, "open_prs"),
      stuck_prs: stuckTotal,
      decisions: decisionTotal,
      repos_counted: counted.length,
      repos_total: repos.length,
    },
    repos,
    stuck_prs: stuckTotal === null && stuck.length === 0 ? null : stuck,
    decisions: decisionTotal === null && decisions.length === 0 ? null : decisions,
  };
}

function pad(value: string, width: number): string {
  const cut = value.slice(0, width);
  return cut.padEnd(width, " ");
}

function cell(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "-";
  return String(value);
}

function netCell(value: number | null): string {
  if (value === null) return "-";
  return value > 0 ? `+${value}` : String(value);
}

function sliceText(value: string, max: number): string {
  return value.slice(0, max);
}

/**
 * The text `scripts/morning-brief.sh` prints. `clock` is the local timestamp
 * on the header line. Every interpolated value is a string built above, so a
 * missing field cannot become the word "undefined".
 */
export function formatBriefText(
  brief: MorningBrief,
  opts?: { clock?: string; decisionLabels?: readonly string[] },
): string {
  const lines: string[] = [];
  const clock = opts?.clock ?? brief.generated_at;
  const labels = opts?.decisionLabels ?? [];
  lines.push(`MORNING BRIEF \u2014 ${clock} \u2014 last ${brief.window_hours}h  (repos from ${brief.repo_source})`);
  lines.push("");
  const snapshotMisses = brief.repos.filter((repo) => repo.incomplete);
  if (snapshotMisses.length > 0) {
    lines.push(`!! DATA INCOMPLETE for ${snapshotMisses.length} of ${brief.totals.repos_total} repos. Fleet totals stay unknown until every watched repo is measured.`);
    for (const repo of snapshotMisses) {
      lines.push(`   ${repo.repo}: ${repo.errors.join("; ")}`);
    }
    lines.push("");
  }
  const decisionGaps = brief.incomplete_repos.filter((row) => !snapshotMisses.some((repo) => repo.repo === row.repo));
  if (decisionGaps.length > 0) {
    for (const row of decisionGaps) {
      lines.push(`   ${row.repo}: ${row.errors.join("; ")}`);
    }
    lines.push("");
  }
  const merged = brief.totals.merged_prs;
  const opened = brief.totals.issues_opened;
  const closed = brief.totals.issues_closed;
  const net = brief.totals.net_backlog;
  if (merged === null || opened === null || closed === null || net === null) {
    lines.push("PRs merged, issues closed, and issues opened: DATA INCOMPLETE.");
  } else {
    const verdict = net > 0 ? `the queue grew by ${net}` : net < 0 ? `the queue shrank by ${String(net).replace(/^-/, "")}` : "the queue held level";
    lines.push(`${merged} PRs merged, ${closed} issues closed, ${opened} opened \u2014 ${verdict}.`);
  }
  if (brief.totals.open_issues === null || brief.totals.open_prs === null) {
    lines.push("Open issues and open PRs: DATA INCOMPLETE.");
  }
  lines.push("");
  if (brief.coordinator.configured) {
    const cv = brief.coordinator.verdict ?? "";
    const mark = cv.startsWith("NOT") || cv.startsWith("FAILING") ? "!!" : cv.startsWith("working") ? "ok" : "??";
    const seen = brief.coordinator.last_seen_hours;
    const seenText = seen == null ? "" : `  (telemetry seen ${tenths(seen)}h ago)`;
    lines.push(`COORDINATOR  [${mark}] ${brief.coordinator.agent_id ?? ""} \u2014 ${cv}${seenText}`);
    lines.push("");
  }
  const header = ["REPO", "merged", "issues\u00b1", "net", "open", "stale", "stuck", "lead-med"];
  const widths = [14, 7, 9, 6, 6, 6, 6, 8];
  lines.push(header.map((col, i) => pad(col, widths[i])).join(" ").trimEnd());
  for (const repo of brief.repos) {
    const cols = repo.incomplete
      ? [`!! ${repo.label}`, "-", "-", "-", "-", "-", "-", "-"]
      : [
          repo.label,
          cell(repo.merged_prs),
          `+${cell(repo.issues_opened)}/-${cell(repo.issues_closed)}`,
          netCell(repo.net_backlog),
          cell(repo.open_issues),
          repo.stale_ratio == null ? "-" : `${Math.floor(repo.stale_ratio * 100)}%`,
          repo.stuck_prs == null ? "-" : String(repo.stuck_prs.length),
          repo.median_lead_hours == null ? "-" : `${tenths(repo.median_lead_hours)}h`,
        ];
    lines.push(cols.map((col, i) => pad(col, widths[i])).join(" ").trimEnd());
  }
  lines.push(`  stale = open issue untouched ${brief.thresholds.stale_issue_days}d+ \u00b7 stuck = non-draft PR open ${brief.thresholds.stuck_pr_hours}h+ or blocked/dirty \u00b7 lead-med = median hours PR open\u2192merge`);
  lines.push("");
  const writeStuck = () => {
    for (const pr of brief.stuck_prs ?? []) {
      lines.push(`  ${pr.repo} #${pr.number}  ${pr.age_days}d  ${pr.reason}`);
      lines.push(`      ${sliceText(pr.title, 78)}  ${pr.url}`);
    }
  };
  // Null is an incomplete repo or a counted repo that did not measure the list.
  // "none" is only a measured zero on every watched repo. Known rows stay listed.
  if (brief.totals.stuck_prs === null) {
    lines.push("STUCK PRs: DATA INCOMPLETE.");
    writeStuck();
  } else if (brief.totals.stuck_prs === 0) {
    lines.push("STUCK PRs: none.");
  } else {
    lines.push(`STUCK PRs (${(brief.stuck_prs ?? []).length}) \u2014 oldest first`);
    writeStuck();
  }
  lines.push("");
  const writeDecisions = () => {
    for (const row of brief.decisions ?? []) {
      const kind = row.kind === "pr" ? "PR " : "";
      lines.push(`  ${row.repo_short} ${kind}#${row.number}  ${row.age_days}d  [${row.labels.join(",")}]  ${sliceText(row.title, 70)}`);
      lines.push(`      ${row.url}`);
    }
  };
  const decisionCount = brief.totals.decisions;
  if (decisionCount !== null && decisionCount > 0) {
    lines.push(`DECISIONS FOR YOU (${decisionCount}) \u2014 oldest first; each one is work nobody else can unblock`);
    writeDecisions();
  } else if (decisionCount === null) {
    // Unmeasured wins over "not tracked": an empty label list must not hide a failed or incomplete read.
    lines.push("DECISIONS FOR YOU: DATA INCOMPLETE.");
    writeDecisions();
  } else if (labels.length === 0) {
    lines.push("DECISIONS FOR YOU: not tracked (set brief.decisionLabels in progress.config.json).");
  } else {
    lines.push("DECISIONS FOR YOU: none open.");
  }
  lines.push("");
  for (const repo of brief.repos) {
    if (repo.merged_prs == null || repo.merged_prs <= 0) continue;
    // A positive count with no measured list is not an empty heading.
    // An empty array is a measured window with nothing to print.
    if (repo.merged_list == null) {
      lines.push(`SHIPPED: DATA INCOMPLETE \u2014 ${repo.label}`);
      continue;
    }
    if (repo.merged_list.length === 0) continue;
    lines.push(`SHIPPED \u2014 ${repo.label}:`);
    for (const pr of repo.merged_list) {
      const lead = pr.lead_hours == null ? "" : `${tenths(pr.lead_hours)}h`;
      lines.push(`  #${pr.number}  ${sliceText(pr.title, 80)}  (${pr.author ?? ""}, ${lead})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "42P01";
}

type Row = Record<string, unknown>;

function toSnapshot(row: Row): RepoSnapshot {
  const n = (key: string) => {
    const value = row[key];
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    repo: String(row.repo),
    label: row.label == null ? null : String(row.label),
    collected_at: new Date(String(row.collected_at)).toISOString(),
    kind: String(row.kind ?? "tick"),
    open_issues: n("open_issues"),
    open_prs: n("open_prs"),
    blocked_issues: n("blocked_issues"),
    merged_prs_24h: n("merged_prs_24h"),
    issues_closed_24h: n("issues_closed_24h"),
    issues_opened_24h: n("issues_opened_24h"),
    total_issues_created: n("total_issues_created"),
    total_issues_closed: n("total_issues_closed"),
    total_prs_merged: n("total_prs_merged"),
    review_rounds: n("review_rounds"),
    no_verdict_rate: n("no_verdict_rate"),
    detail: (row.detail as SnapshotDetail) ?? null,
  };
}

/** Same id from the work query and the newest-row query is one event, not two errors. */
function uniqueEventRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const id = row.id;
    const key = id === null || id === undefined ? `missing:${index}` : `id:${String(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Newest row per repo.
 *
 * The latest read does not drop a row whose counts are null. A newer partial
 * ingest has to win, so the brief can mark that repo DATA INCOMPLETE instead
 * of reprinting an older complete snapshot as current. `beforeIso` is only the
 * 72h baseline cutoff, chosen separately from the latest row. `id desc` breaks
 * a tie when two rows share `collected_at`.
 */
async function snapshotsAt(repos: string[], beforeIso: string | null): Promise<Map<string, RepoSnapshot>> {
  if (repos.length === 0) return new Map();
  const db = sql();
  const rows = beforeIso
    ? await db`
        select distinct on (repo) *
        from repo_snapshots
        where repo = any(${repos}::text[])
          and collected_at <= ${beforeIso}
        order by repo, collected_at desc, id desc
      `
    : await db`
        select distinct on (repo) *
        from repo_snapshots
        where repo = any(${repos}::text[])
        order by repo, collected_at desc, id desc
      `;
  return new Map((rows as Row[]).map((row) => [String(row.repo), toSnapshot(row)]));
}

export async function coordinatorFromDb(settings: BriefSettings, nowIso: string): Promise<BriefCoordinator> {
  const agentId = settings.coordinator.agentId;
  if (!agentId) return { configured: false, agent_id: null };
  try {
    const db = sql();
    const silenceMs = settings.coordinator.maxSilenceHours * 3_600_000;
    const cutoff = toSecondIso(new Date(Date.parse(nowIso) - silenceMs));
    // `error` is excluded again here. A caller that skipped readBriefSettings
    // must not put it in `kind = any(...)`, or the newest error is "working".
    const workKinds = resolveWorkKinds(settings.coordinator.workKinds);
    const agents = await db`select id, last_seen_at from agents where id = ${agentId} limit 1`;
    // Do not take the newest N non-heartbeat rows and classify that slice.
    // A burst of turn_start or status_update would drop a milestone that is
    // still inside the silence window, and the brief would say NOT WORKING
    // or FAILING. Work is the newest configured kind, whatever sits after it.
    // Every error inside the window is counted. The newest row of any kind
    // only names last_any_kind.
    const events = await db`
      (select id, kind, created_at from events
        where agent_id = ${agentId}
          and kind = any(${workKinds}::text[])
        order by created_at desc
        limit 1)
      union all
      (select id, kind, created_at from events
        where agent_id = ${agentId}
          and kind = 'error'
          and created_at >= ${cutoff})
      union all
      (select id, kind, created_at from events
        where agent_id = ${agentId}
        order by created_at desc
        limit 1)
    `;
    const agentRow = (agents as Row[])[0];
    return coordinatorStatus({
      agentId,
      maxSilenceHours: settings.coordinator.maxSilenceHours,
      workKinds,
      nowIso,
      reachable: true,
      agent: agentRow
        ? {
            id: String(agentRow.id),
            last_seen_at: agentRow.last_seen_at ? new Date(String(agentRow.last_seen_at)).toISOString() : null,
          }
        : null,
      events: uniqueEventRows(events as Row[]).map((row) => ({
        kind: String(row.kind ?? ""),
        created_at: new Date(String(row.created_at)).toISOString(),
      })),
    });
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
    return coordinatorStatus({
      agentId,
      maxSilenceHours: settings.coordinator.maxSilenceHours,
      workKinds: resolveWorkKinds(settings.coordinator.workKinds),
      nowIso,
      reachable: false,
      agent: null,
      events: [],
    });
  }
}

const DECISION_READ_LIMIT = 1000;

/** Production reads at most 1000. A test may pass a smaller integer. Anything else stays 1000. */
function decisionReadLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > DECISION_READ_LIMIT) {
    return DECISION_READ_LIMIT;
  }
  return value;
}

export async function loadBrief(
  window: BriefWindow,
  now = new Date(),
  options?: { decisionLimit?: number },
): Promise<MorningBrief> {
  const settings = briefConfig();
  const hours: 24 | 72 = window === "72h" ? 72 : 24;
  const nowIso = toSecondIso(now);
  const coordinatorBase = {
    agentId: settings.coordinator.agentId,
    maxSilenceHours: settings.coordinator.maxSilenceHours,
    workKinds: settings.coordinator.workKinds,
    nowIso,
  };

  if (!isConfigured()) {
    const sections = REPOS.map((cfg) => incompleteSection(cfg, ["no snapshot"]));
    const agentId = coordinatorBase.agentId;
    const coordinator: BriefCoordinator = agentId
      ? {
          configured: true,
          agent_id: agentId,
          verdict: "unknown: no dashboard credentials (MC_URL/MC_TOKEN)",
        }
      : { configured: false, agent_id: null };
    return assembleBrief({
      generatedAt: nowIso,
      windowHours: hours,
      repoSource: "config",
      stuckPrHours: settings.stuckPrHours,
      staleIssueDays: settings.staleIssueDays,
      coordinator,
      repos: sections,
    });
  }

  const watched = await getWatchedRepos(REPOS);
  const names = watched.repos.map((repo) => repo.repo);
  const baselineIso = new Date(now.getTime() - hours * 3_600_000).toISOString();
  let latest = new Map<string, RepoSnapshot>();
  let baseline = new Map<string, RepoSnapshot>();
  try {
    [latest, baseline] = await Promise.all([
      snapshotsAt(names, null),
      hours === 72 ? snapshotsAt(names, baselineIso) : Promise.resolve(new Map<string, RepoSnapshot>()),
    ]);
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
  }

  // These stay unused unless the read succeeds. A throw must not publish them
  // as a measured empty queue.
  let table: BriefDecision[] = [];
  let incompleteRepos: string[] = [];
  let decisionsMeasured = false;
  const decisionLimit = decisionReadLimit(options?.decisionLimit);
  try {
    const rows = await listDecisions({ status: "open", repo: null, source: null, limit: decisionLimit, shape: "brief" });
    if (rows.length >= decisionLimit) {
      // A full page can hide another row. The set is unmeasured, so the page
      // stays out of the list and the total stays null.
      table = [];
      incompleteRepos = watched.repos.map((repo) => repo.repo);
      decisionsMeasured = true;
    } else {
      const part = partitionBrief(rows, nowIso);
      table = part.decisions;
      incompleteRepos = part.incomplete_repos;
      decisionsMeasured = true;
    }
  } catch {
    decisionsMeasured = false;
  }

  const sections = applyTableDecisions(
    watched.repos.map((cfg) => repoSection({
      cfg,
      snap: latest.get(cfg.repo) ?? null,
      baseline: baseline.get(cfg.repo) ?? null,
      windowHours: hours,
      nowIso,
    })),
    table,
    incompleteRepos,
    decisionsMeasured,
  );
  const coordinator = await coordinatorFromDb(settings, nowIso);
  return assembleBrief({
    generatedAt: nowIso,
    windowHours: hours,
    repoSource: watched.source === "database" ? "dashboard" : "config",
    stuckPrHours: settings.stuckPrHours,
    staleIssueDays: settings.staleIssueDays,
    coordinator,
    repos: sections,
  });
}

export async function morningBriefText(window: BriefWindow, now = new Date()): Promise<string> {
  const brief = await loadBrief(window, now);
  const settings = briefConfig();
  return formatBriefText(brief, {
    clock: formatBriefClock(now),
    decisionLabels: settings.decisionLabels,
  });
}
