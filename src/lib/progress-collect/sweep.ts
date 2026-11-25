/**
 * One repo of the detailed sweep: a TypeScript port of `collect_repo`,
 * `brief_metrics`, `lane_of`/`lane_mix_for` and `sync_repo_decisions` in
 * scripts/collect-progress.sh. Same fields, same semantics:
 * - a search that fails twice is null, never 0 (`search_count`);
 * - a failed brief sweep leaves the brief keys off the row (fail open, as the script);
 * - a failed PR listing makes stalled_prs [] (as the script);
 * - a failed or truncated decision listing never withdraws.
 * `gh issue list` / `gh pr list` are GraphQL listings in created-desc order, as gh does.
 */
import type { SnapshotDetail } from "../progress-types";
import { collectorDecisionBody, isDecisionLabel, type GhItem, type ReconcileInput, type UpsertInput } from "../decisions";
import { mustPropagate, type OwnerCalls, type ProgressGitHub } from "./github";

export interface SweepRepo {
  repo: string;
  label: string;
  blockedLabel: string | null;
  short: string;
}

export interface SweepSettings {
  laneBotPrefix: string;
  sharedBotPrefixes: string[];
  decisionLabels: string[];
  stuckPrHours: number;
  staleIssueDays: number;
  /** LANE_PR_CAP. */
  lanePrCap: number;
}

export const STALLED_HOURS = 24;
export const LANE_PR_CAP = 80;

/** The row handed to ingestSnapshots. Nulls are "not measured", never zero. */
export interface TickRow {
  repo: string;
  label: string;
  open_issues: number | null;
  open_prs: number | null;
  blocked_issues: number | null;
  merged_prs_24h: number | null;
  issues_closed_24h: number | null;
  issues_opened_24h: number | null;
  total_issues_created: number | null;
  total_issues_closed: number | null;
  total_prs_merged: number | null;
  detail: SnapshotDetail & Record<string, unknown>;
}

export interface DecisionSink {
  /** True when the row was stored (the route's HTTP 200). */
  upsert(body: UpsertInput): Promise<boolean>;
  reconcile(input: ReconcileInput): Promise<boolean>;
}

/* ------------------------------------------------------------- time */

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** jq `ts`: drop fractional seconds, then whole unix seconds. */
function ts(value: string): number {
  return Math.floor(Date.parse(value.replace(/\.[0-9]+(?=Z$)/, "")) / 1000);
}

function hours(a: string, b: string): number {
  return (ts(b) - ts(a)) / 3600;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 === 1 ? s[Math.floor(n / 2)] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/* ---------------------------------------------------------- listings */

interface Check {
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

export interface OpenPr extends GhItem {
  updatedAt: string;
  isDraft: boolean;
  mergeStateStatus: string;
  reviewDecision: string;
  author: { login: string };
  statusCheckRollup: Check[];
}

export interface OpenIssue extends GhItem {
  updatedAt: string;
}

interface Listing<T> {
  items: T[];
  /** Every page was read (or the limit was reached). */
  complete: boolean;
}

const LABELS = "labels(first: 100) { nodes { name } }";

export const OPEN_ISSUES_QUERY = `query ProgressOpenIssues($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url createdAt updatedAt ${LABELS} }
    }
  }
}`;

export const OPEN_PRS_QUERY = `query ProgressOpenPrs($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $first, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt updatedAt isDraft mergeStateStatus reviewDecision
        author { login }
        ${LABELS}
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } } } } } }
      }
    }
  }
}`;

function labelsOf(node: any): { name: string }[] {
  const nodes = node?.labels?.nodes;
  return Array.isArray(nodes) ? nodes.filter((l: any) => typeof l?.name === "string").map((l: any) => ({ name: l.name })) : [];
}

function checksOf(node: any): Check[] {
  const contexts = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  if (!Array.isArray(contexts)) return [];
  return contexts.map((c: any): Check => c?.__typename === "StatusContext"
    ? { context: c.context, state: c.state ?? null }
    : { name: c?.name, status: c?.status ?? null, conclusion: c?.conclusion ?? null });
}

/** Pages a created-desc GraphQL listing up to `limit` items. Ordinary failures end it as incomplete. */
async function list<T>(
  gh: OwnerCalls,
  query: string,
  field: "issues" | "pullRequests",
  repo: string,
  limit: number,
  pageSize: number,
  map: (node: any) => T,
): Promise<Listing<T>> {
  const [owner, name] = repo.split("/");
  const items: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    let conn: any;
    try {
      const data = await gh.graphql(query, { owner, name, first: Math.min(pageSize, limit - items.length), cursor });
      conn = (data.repository as any)?.[field];
      if (!conn || !Array.isArray(conn.nodes)) return { items, complete: false };
    } catch (err) {
      if (mustPropagate(err)) throw err;
      return { items, complete: false };
    }
    for (const node of conn.nodes) items.push(map(node));
    if (items.length >= limit || !conn.pageInfo?.hasNextPage) return { items, complete: true };
    cursor = conn.pageInfo.endCursor;
  }
}

/* -------------------------------------------------------------- lanes */

const TRAILER_RE = /^Agent-Vendor:[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,31})[ \t]*$/i;

/** jq `group_by(.) | max_by(length) | .[0]`: on a tie the lexically last value wins. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = "";
  let bestN = -1;
  for (const key of [...counts.keys()].sort()) {
    const n = counts.get(key)!;
    if (n >= bestN) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

/** `lane_of`: which agent lane wrote this PR, from its own branch commits. */
export function laneOf(commits: unknown, prefix: string, shared: readonly string[]): string {
  if (!Array.isArray(commits)) return "unattributed";
  const trailers: string[] = [];
  for (const c of commits) {
    const message = (c as any)?.commit?.message;
    if (typeof message !== "string") continue;
    for (const line of message.split("\n")) {
      const m = TRAILER_RE.exec(line);
      if (m) {
        trailers.push(m[1].toLowerCase());
        break; // jq capture without "g" takes the first match in each message.
      }
    }
  }
  if (trailers.length > 0) return mostCommon(trailers);
  const logins = commits
    .map((c: any) => (c?.author?.login || c?.commit?.author?.name || "") as string)
    .filter((login) => typeof login === "string" && login.endsWith("[bot]"))
    .map((login) => login.replace(/\[bot\]$/, ""))
    .map((login) => shared.some((p) => login.startsWith(p)) ? "unattributed"
      : login.startsWith(prefix) ? login.slice(prefix.length) : login);
  return logins.length === 0 ? "human" : mostCommon(logins);
}

async function laneMixFor(gh: OwnerCalls, repo: string, numbers: number[], settings: SweepSettings): Promise<Record<string, number>> {
  const lanes: string[] = [];
  for (const n of numbers) {
    let lane = "unattributed";
    try {
      lane = laneOf(await gh.request("GET", `repos/${repo}/pulls/${n}/commits?per_page=100`), settings.laneBotPrefix, settings.sharedBotPrefixes) || "unattributed";
    } catch (err) {
      if (mustPropagate(err)) throw err;
    }
    lanes.push(lane);
  }
  const mix: Record<string, number> = {};
  for (const lane of [...lanes].sort()) mix[lane] = (mix[lane] ?? 0) + 1;
  return mix;
}

/* -------------------------------------------------------------- brief */

const BAD = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const STUCK_STATES = new Set(["DIRTY", "BLOCKED", "BEHIND", "UNSTABLE"]);

const upper = (v: unknown) => String(v ?? "").toUpperCase();
const badCheck = (c: Check) => BAD.has(upper(c.conclusion ?? c.state ?? ""));
const pendingCheck = (c: Check) => (c.conclusion ?? "") === "" && PENDING.has(upper(c.status ?? c.state ?? ""));
const checkName = (c: Check) => c.name ?? c.context ?? "check";
const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort();

interface MergedPr {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  createdAt: string | null;
  mergedAt: string | null;
}

/** BRIEF_METRICS_JQ. `nowIso` is seconds precision, as `date -u +%Y-%m-%dT%H:%M:%SZ`. */
export function briefMetrics(
  short: string,
  nowIso: string,
  staleBefore: string,
  stuckH: number,
  issues: { number: number; updatedAt: string }[],
  prs: OpenPr[],
  merged: MergedPr[],
): Record<string, unknown> {
  const stale = issues.filter((i) => i.updatedAt < staleBefore);
  const prs2 = prs.map((p) => ({
    ...p,
    age_h: hours(p.createdAt, nowIso),
    idle_h: hours(p.updatedAt, nowIso),
    failing: uniqueSorted(p.statusCheckRollup.filter(badCheck).map(checkName)),
    pending: uniqueSorted(p.statusCheckRollup.filter(pendingCheck).map(checkName)),
  }));
  const stuck = prs2
    .filter((p) => !p.isDraft)
    .filter((p) => p.age_h >= stuckH || STUCK_STATES.has(p.mergeStateStatus))
    .map((p) => ({
      repo: short,
      number: p.number,
      title: p.title,
      url: p.url,
      author: p.author.login,
      age_hours: p.age_h,
      age_days: Math.floor(p.age_h / 24),
      idle_days: Math.floor(p.idle_h / 24),
      state: p.mergeStateStatus,
      review: p.reviewDecision ?? null,
      reason: p.mergeStateStatus === "DIRTY" ? "merge conflict with base"
        : p.failing.length > 0 ? "failing: " + p.failing.slice(0, 3).join(", ")
        : p.pending.length > 0 ? "waiting on: " + p.pending.slice(0, 3).join(", ")
        : p.reviewDecision === "CHANGES_REQUESTED" ? "changes requested"
        : p.reviewDecision === "REVIEW_REQUIRED" ? "no review yet"
        : p.mergeStateStatus === "BEHIND" ? "behind base, needs update"
        : `open ${Math.floor(p.age_h / 24)}d with no blocker reported`,
    }))
    .sort((a, b) => b.age_hours - a.age_hours);
  const mergedOk = merged.filter((m): m is MergedPr & { createdAt: string; mergedAt: string } => m.createdAt != null && m.mergedAt != null);
  // merged keeps the 72h sweep. merged_list and median_lead_hours are the 24h fallback.
  const merged24 = mergedOk.filter((m) => hours(m.mergedAt, nowIso) >= 0 && hours(m.mergedAt, nowIso) <= 24);
  const notes: string[] = [];
  if (issues.length >= 200) notes.push("open issues truncated at 200");
  if (prs.length >= 100) notes.push("open prs truncated at 100");
  if (merged.length >= 200) notes.push("merged prs truncated at 200");
  return {
    stuck_prs: stuck,
    median_lead_hours: median(merged24.map((m) => hours(m.createdAt, m.mergedAt))),
    stale_issues: stale.length,
    stale_ratio: issues.length > 0 ? stale.length / issues.length : null,
    drafts: prs.filter((p) => p.isDraft).length,
    merged_list: merged24.map((m) => ({ number: m.number, title: m.title, url: m.url, author: m.author.login, lead_hours: hours(m.createdAt, m.mergedAt) })),
    merged: mergedOk.map((m) => ({ number: m.number, title: m.title, url: m.url, author: m.author.login, created_at: m.createdAt, merged_at: m.mergedAt })),
    notes,
  };
}

/** The stalled-PR jq in collect_repo. */
export function stalledPrs(prs: OpenPr[], nowMs: number) {
  return prs
    .map((p) => ({ p, idle: (nowMs / 1000 - ts(p.updatedAt)) / 3600 }))
    .filter(({ idle }) => idle > STALLED_HOURS)
    .map(({ p, idle }) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      idle_hours: Math.floor(idle),
      // A running check has a null conclusion; it must not count as green.
      green: p.statusCheckRollup.length > 0 && p.statusCheckRollup.every((c) => GREEN.has(upper(c.conclusion ?? c.state ?? ""))),
      draft: p.isDraft,
    }))
    .sort((a, b) => b.idle_hours - a.idle_hours)
    .slice(0, 5);
}

/* ------------------------------------------------------- one repo */

export interface RepoListings {
  issues: Listing<OpenIssue>;
  prs: Listing<OpenPr>;
}

function mapIssue(n: any): OpenIssue {
  return { number: n.number, title: n.title, url: n.url, createdAt: n.createdAt, updatedAt: n.updatedAt, labels: labelsOf(n) };
}

function mapPr(n: any): OpenPr {
  return {
    number: n.number, title: n.title, url: n.url, createdAt: n.createdAt, updatedAt: n.updatedAt,
    isDraft: n.isDraft === true, mergeStateStatus: n.mergeStateStatus ?? "", reviewDecision: n.reviewDecision ?? "",
    author: { login: n.author?.login ?? "" }, labels: labelsOf(n), statusCheckRollup: checksOf(n),
  };
}

function mapMerged(item: Record<string, any>): MergedPr {
  return {
    number: item.number, title: item.title, url: item.html_url, author: { login: item.user?.login ?? "" },
    createdAt: item.created_at ?? null, mergedAt: item.pull_request?.merged_at ?? null,
  };
}

/**
 * Collects one repo. Throws only on an abort (auth, rate limit, deadline); every
 * other failure degrades a field exactly as the script does.
 */
export async function collectRepo(
  gh: ProgressGitHub,
  target: SweepRepo,
  settings: SweepSettings,
  nowMs: number,
): Promise<{ row: TickRow; listings: RepoListings }> {
  const { repo } = target;
  // Every call about this repo uses its owner's credentials (per-owner App token, or GH_TOKEN).
  const api = gh.forOwner(repo.split("/")[0]);
  const since = isoSeconds(nowMs - 86_400_000);
  const sinceDate = since.split("T")[0];

  const open_issues = await api.searchCount(`repo:${repo} is:issue is:open`);
  const open_prs = await api.searchCount(`repo:${repo} is:pr is:open`);
  const blocked_issues = target.blockedLabel
    ? await api.searchCount(`repo:${repo} is:issue is:open label:"${target.blockedLabel}"`)
    : null; // no such label in this repo - not tracked, not zero
  const issues_closed_24h = await api.searchCount(`repo:${repo} is:issue closed:>=${since}`);
  const issues_opened_24h = await api.searchCount(`repo:${repo} is:issue created:>=${since}`);
  const total_issues_created = await api.searchCount(`repo:${repo} is:issue`);
  const total_issues_closed = await api.searchCount(`repo:${repo} is:issue is:closed`);
  const total_prs_merged = await api.searchCount(`repo:${repo} is:pr is:merged`);

  // One search yields both the 24h merged count and the PR numbers for lane attribution.
  const mergedPage = await api.searchPage(`repo:${repo} is:pr is:merged merged:>=${since}`);
  const merged_prs_24h = mergedPage.total_count;
  const numbers = mergedPage.items.map((i) => i.number).filter((n): n is number => typeof n === "number").slice(0, settings.lanePrCap);
  const lane_mix = await laneMixFor(api, repo, numbers, settings);

  // Decisions need up to 2001 issues / 501 PRs; the brief reads the newest 200 / 100.
  const decisionsOn = settings.decisionLabels.length > 0;
  const issues = await list(api, OPEN_ISSUES_QUERY, "issues", repo, decisionsOn ? 2001 : 200, 100, mapIssue);
  const prs = await list(api, OPEN_PRS_QUERY, "pullRequests", repo, decisionsOn ? 501 : 100, 50, mapPr);
  const prsForBrief = prs.items.slice(0, 100);
  const prsReadable = prs.complete || prs.items.length >= 100;
  const issuesReadable = issues.complete || issues.items.length >= 200;

  const stalled_prs = prsReadable ? stalledPrs(prsForBrief, nowMs) : [];

  let brief: Record<string, unknown> = {};
  if (prsReadable && issuesReadable) {
    const nowIso = isoSeconds(nowMs);
    const merged: MergedPr[] = [];
    let mergedOk = true;
    const since72 = isoSeconds(nowMs - 72 * 3_600_000);
    for (let page = 1; page <= 2 && merged.length < 200; page += 1) {
      const res = await api.searchPage(`repo:${repo} is:pr is:merged merged:>=${since72}`, { sort: "created", order: "desc", page: String(page) });
      if (res.total_count === null) {
        mergedOk = false;
        break;
      }
      merged.push(...res.items.map(mapMerged));
      if (merged.length >= res.total_count || res.items.length < 100) break;
    }
    if (mergedOk) {
      brief = briefMetrics(target.short, nowIso, isoSeconds(nowMs - settings.staleIssueDays * 86_400_000),
        settings.stuckPrHours, issues.items.slice(0, 200), prsForBrief, merged.slice(0, 200));
    }
  }
  const { notes: briefNotes, ...briefRest } = brief as { notes?: string[] };

  const row: TickRow = {
    repo,
    label: target.label,
    open_issues, open_prs, blocked_issues,
    merged_prs_24h, issues_closed_24h, issues_opened_24h,
    total_issues_created, total_issues_closed, total_prs_merged,
    detail: {
      lane_mix,
      stalled_prs,
      notes: [`window from ${sinceDate}`, ...(briefNotes ?? [])],
      ...briefRest,
    } as TickRow["detail"],
  };
  return { row, listings: { issues, prs } };
}

/**
 * `sync_repo_decisions`: upsert every open labeled issue/PR, then withdraw keys
 * not seen. A failed listing does nothing; a truncated listing or a failed upsert
 * upserts what it saw and does not withdraw.
 */
export async function syncRepoDecisions(
  target: SweepRepo,
  listings: RepoListings,
  settings: SweepSettings,
  sink: DecisionSink,
  /** True once the run must stop writing; the rest is skipped and nothing is withdrawn. */
  shouldStop: () => boolean = () => false,
): Promise<{ upserted: number; reconciled: boolean }> {
  const patterns = settings.decisionLabels;
  if (patterns.length === 0) return { upserted: 0, reconciled: false };
  if (!listings.issues.complete || !listings.prs.complete) return { upserted: 0, reconciled: false };
  const short = target.short || target.repo.split("/")[1];
  const truncated = listings.issues.items.length > 2000 || listings.prs.items.length > 500;
  const issueItems: GhItem[] = listings.issues.items.map(({ number, title, url, createdAt, labels }) => ({ number, title, url, createdAt, labels }));
  const prItems: GhItem[] = listings.prs.items.map(({ number, title, url, createdAt, labels, isDraft }) => ({ number, title, url, createdAt, labels, isDraft }));
  const matches = [...issueItems, ...prItems].filter((item) =>
    (item.labels ?? []).some((l) => typeof l.name === "string" && isDecisionLabel(l.name, patterns)));
  const seen: string[] = [];
  let failed = false;
  let upserted = 0;
  for (const item of matches) {
    if (shouldStop()) return { upserted, reconciled: false };
    const body = collectorDecisionBody(item, target.repo, short, patterns);
    let ok = false;
    try {
      ok = await sink.upsert(body);
    } catch {
      ok = false;
    }
    if (ok) upserted += 1;
    else failed = true;
    seen.push(body.key);
  }
  if (failed || truncated || shouldStop()) return { upserted, reconciled: false };
  let reconciled = false;
  try {
    reconciled = await sink.reconcile({ repo: target.repo, source: "github-label", seen_keys: seen });
  } catch {
    reconciled = false;
  }
  return { upserted, reconciled };
}
