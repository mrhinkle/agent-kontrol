/**
 * TypeScript port of scripts/collect-progress-activity.py: one GraphQL pass over
 * every watched owner's repositories, plus a direct query for each retained repo
 * no owner listed. Produces the discovery results and the kind=activity snapshot.
 *
 * The rules are the script's. A failed owner or repo becomes an explicit
 * "unavailable" row, never a zero. A 401, a rate limit, or the deadline is not
 * a per-owner failure: it propagates so the caller writes nothing for the phase.
 */
import { GitHubAppNotInstalledError, GitHubAppTokenError, isAbort, type ProgressGitHub } from "./github";

const PAGE_SIZE = 50;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const FIELDS = `id nameWithOwner isArchived isFork pushedAt
  openPullRequests: pullRequests(states: OPEN) { totalCount }
  openIssues: issues(states: OPEN) { totalCount }
  latestPullRequest: pullRequests(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount nodes { updatedAt }
  }
  latestIssue: issues(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount nodes { updatedAt }
  }`;
export const OWNER_QUERY = `query ProgressOwnerActivity($owner: String!, $cursor: String) {
  repositoryOwner(login: $owner) { login repositories(first: 50, after: $cursor,
    ownerAffiliations: [OWNER], orderBy: {field: NAME, direction: ASC}) {
      totalCount pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } } }`;
export const REPO_QUERY = `query ProgressRepoActivity($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${FIELDS} } }`;

class ReadFailed extends Error {
  constructor(readonly code = "github_read_failed") {
    super(code);
  }
}

function require_(condition: unknown, code = "invalid_github_response"): void {
  if (!condition) throw new ReadFailed(code);
}

function instant(value: unknown): number {
  require_(typeof value === "string" && UTC_RE.test(value), "invalid_timestamp");
  const ms = Date.parse(value as string);
  require_(!Number.isNaN(ms), "invalid_timestamp");
  return ms;
}

function count(value: unknown): number {
  require_(typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647);
  return value as number;
}

function repoName(value: unknown): string {
  require_(typeof value === "string" && REPO_RE.test(value) && ![".", ".."].includes(value.split("/")[1]));
  return value as string;
}

export interface ActivityDetail {
  status: "complete" | "unavailable";
  checked_at: string;
  pushed_at: string | null;
  pr_updated_at: string | null;
  issue_updated_at: string | null;
  open_issues: number | null;
  error?: string;
}

export interface ActivityRow {
  repo: string;
  open_prs: number | null;
  detail: { activity: ActivityDetail };
}

export interface DiscoveredRepo {
  name: string;
  pushedAt: string | null;
  isArchived: boolean;
  isFork: boolean;
}

export type DiscoveryResult =
  | { owner: string; ok: true; truncated: false; swept_at: string; repos: DiscoveredRepo[] }
  | { owner: string; ok: false; swept_at: string; error: string };

export interface ActivityScan {
  discovery: { results: DiscoveryResult[] };
  snapshot: { kind: "activity"; collected_at: string; repos: ActivityRow[] };
  summary: {
    owners_total: number;
    owners_complete: number;
    owners_unavailable: number;
    repositories_total: number;
    repositories_complete: number;
    repositories_unavailable: number;
    direct_queries: number;
  };
}

type Clock = () => number;

function stamp(clock: Clock): string {
  const ms = clock();
  require_(Number.isFinite(ms), "invalid_clock");
  return new Date(ms).toISOString();
}

async function read(gh: ProgressGitHub, query: string, variables: Record<string, unknown>, clock: Clock, owner: string) {
  let data: Record<string, unknown>;
  try {
    data = await gh.graphql(query, variables, owner);
  } catch (err) {
    if (isAbort(err)) throw err;
    // The App is not on this owner, or its token could not be minted: a distinct, explicit reason.
    if (err instanceof GitHubAppNotInstalledError) throw new ReadFailed("app_not_installed");
    if (err instanceof GitHubAppTokenError) throw new ReadFailed("app_token_failed");
    throw new ReadFailed("github_read_failed");
  }
  const checked = stamp(clock); // Taken after the API response, never before it.
  require_(data && typeof data === "object");
  return { data: data as Record<string, any>, checked };
}

function latest(connection: any, checked: string): [string | null, number] {
  const total = count(connection.totalCount);
  const nodes = connection.nodes;
  require_(Array.isArray(nodes) && nodes.length === (total ? 1 : 0));
  if (!total) return [null, total]; // A known empty connection, not a missing field.
  const value = nodes[0].updatedAt;
  require_(instant(value) <= instant(checked), "invalid_timestamp");
  return [value as string, total];
}

function parseRepo(node: any, checked: string, owner?: string, expected?: string) {
  const name = repoName(node.nameWithOwner);
  require_(owner === undefined || name.split("/")[0].toLowerCase() === owner.toLowerCase(), "repository_identity_changed");
  require_(expected === undefined || name.toLowerCase() === expected.toLowerCase(), "repository_identity_changed");
  require_(typeof node.id === "string" && node.id.length > 0 && node.id.length <= 200);
  require_(typeof node.isArchived === "boolean" && typeof node.isFork === "boolean");
  const pushed = node.pushedAt;
  require_(pushed === null || instant(pushed) <= instant(checked), "invalid_timestamp");
  const prs = count(node.openPullRequests.totalCount);
  const issues = count(node.openIssues.totalCount);
  const [prAt, prTotal] = latest(node.latestPullRequest, checked);
  const [issueAt, issueTotal] = latest(node.latestIssue, checked);
  require_(prs <= prTotal && issues <= issueTotal);
  const discovery: DiscoveredRepo = { name: name.split("/")[1], pushedAt: pushed, isArchived: node.isArchived, isFork: node.isFork };
  const row: ActivityRow = {
    repo: name,
    open_prs: prs,
    detail: { activity: { status: "complete", checked_at: checked, pushed_at: pushed, pr_updated_at: prAt, issue_updated_at: issueAt, open_issues: issues } },
  };
  return { id: node.id as string, discovery, row };
}

async function ownerSweep(gh: ProgressGitHub, owner: string, clock: Clock, priorIds: Set<string>) {
  let cursor: string | null = null;
  let total: number | null = null;
  const names = new Set<string>();
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const listed: DiscoveredRepo[] = [];
  const rows: ActivityRow[] = [];
  for (;;) { // No search or repository-count cap; every cursor is followed.
    const { data, checked } = await read(gh, OWNER_QUERY, { owner, cursor }, clock, owner);
    const account = data.repositoryOwner;
    require_(typeof account.login === "string" && account.login.toLowerCase() === owner);
    const page = account.repositories;
    const observed = count(page.totalCount);
    require_(observed > 0, "empty_owner_inventory");
    total = total === null ? observed : total;
    require_(total === observed, "pagination_incomplete");
    const nodes = page.nodes;
    const info = page.pageInfo;
    require_(Array.isArray(nodes) && nodes.length === Math.min(PAGE_SIZE, total - rows.length), "pagination_incomplete");
    require_(typeof info.hasNextPage === "boolean" && typeof info.endCursor === "string" &&
      info.endCursor.length > 0 && info.endCursor.length <= 2048 && !cursors.has(info.endCursor), "pagination_incomplete");
    cursors.add(info.endCursor);
    for (const node of nodes) {
      const { id, discovery, row } = parseRepo(node, checked, owner);
      const key = row.repo.toLowerCase();
      require_(!names.has(key) && !ids.has(id) && !priorIds.has(id), "duplicate_repository");
      names.add(key);
      ids.add(id);
      listed.push(discovery);
      rows.push(row);
    }
    require_(info.hasNextPage === (rows.length < total), "pagination_incomplete");
    if (!info.hasNextPage) {
      require_(rows.length === total, "pagination_incomplete");
      return { listed, rows, ids, checked };
    }
    cursor = info.endCursor;
  }
}

export interface OwnerSetting {
  owner: unknown;
  include_forks?: unknown;
  include_archived?: unknown;
}

export interface RepoSetting {
  repo: unknown;
  origin?: unknown;
  gone?: unknown;
  hidden?: unknown;
  pinned?: unknown;
  isFork?: unknown;
  isArchived?: unknown;
}

/** Validates the two settings bodies exactly as the script does. Throws on anything off. */
export function activitySettings(owners: OwnerSetting[], repos: RepoSetting[]) {
  const ownerNames: string[] = [];
  const retained = new Map<string, string>();
  require_(Array.isArray(owners) && Array.isArray(repos), "invalid_settings");
  for (const row of owners) {
    const name = row.owner;
    require_(typeof name === "string" && OWNER_RE.test(name), "invalid_settings");
    require_(!ownerNames.includes((name as string).toLowerCase()) &&
      typeof row.include_forks === "boolean" && typeof row.include_archived === "boolean", "invalid_settings");
    ownerNames.push((name as string).toLowerCase());
  }
  const seen = new Set<string>();
  for (const row of repos) {
    const name = repoName(row.repo);
    const origin = row.origin ?? "manual";
    require_(!seen.has(name.toLowerCase()) && (origin === "auto" || origin === "manual"), "invalid_settings");
    for (const k of ["gone", "hidden", "pinned", "isFork", "isArchived"] as const) {
      require_(row[k] === undefined || typeof row[k] === "boolean", "invalid_settings");
    }
    seen.add(name.toLowerCase());
    if (row.gone !== true) retained.set(name.toLowerCase(), name);
  }
  return { owners: ownerNames, retained };
}

function unavailable(repo: string, checked: string, error: string): ActivityRow {
  return {
    repo,
    open_prs: null,
    detail: { activity: { status: "unavailable", checked_at: checked, pushed_at: null, pr_updated_at: null, issue_updated_at: null, open_issues: null, error } },
  };
}

function errorCode(err: unknown): string {
  return err instanceof ReadFailed ? err.code : "invalid_github_response";
}

export async function scanActivity(
  gh: ProgressGitHub,
  ownersBody: OwnerSetting[],
  reposBody: RepoSetting[],
  clock: Clock,
): Promise<ActivityScan> {
  const { owners, retained } = activitySettings(ownersBody, reposBody);
  const discoveries: DiscoveryResult[] = [];
  const rows = new Map<string, ActivityRow>();
  const seenIds = new Set<string>();
  const ownerStatus = new Map<string, [string, string]>();
  let directQueries = 0;
  for (const owner of owners) {
    const swept = stamp(clock);
    try {
      const { listed, rows: observed, ids, checked } = await ownerSweep(gh, owner, clock, seenIds);
      for (const id of ids) seenIds.add(id);
      discoveries.push({ owner, ok: true, truncated: false, swept_at: swept, repos: listed });
      ownerStatus.set(owner, [checked, "missing_from_inventory"]);
      for (const row of observed) {
        const key = row.repo.toLowerCase();
        row.repo = retained.get(key) ?? row.repo;
        rows.set(key, row);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      const checked = stamp(clock);
      const error = errorCode(err);
      discoveries.push({ owner, ok: false, swept_at: swept, error });
      ownerStatus.set(owner, [checked, error]);
    }
  }
  for (const [key, name] of retained) {
    if (rows.has(key)) continue;
    const [owner, repo] = name.split("/");
    const status = ownerStatus.get(owner.toLowerCase());
    if (status) {
      rows.set(key, unavailable(name, status[0], status[1]));
      continue;
    }
    // Includes manual/legacy rows and retained rows after owner removal.
    directQueries += 1;
    try {
      const { data, checked } = await read(gh, REPO_QUERY, { owner, name: repo }, clock, owner);
      const { id, row } = parseRepo(data.repository, checked, undefined, name);
      require_(!seenIds.has(id), "duplicate_repository");
      seenIds.add(id);
      row.repo = name;
      rows.set(key, row);
    } catch (err) {
      if (isAbort(err)) throw err;
      rows.set(key, unavailable(name, stamp(clock), errorCode(err)));
    }
  }
  const collected = stamp(clock);
  require_([...rows.values()].every((r) => instant(r.detail.activity.checked_at) <= instant(collected)), "invalid_clock");
  const complete = [...rows.values()].filter((r) => r.detail.activity.status === "complete").length;
  const keys = [...rows.keys()].sort();
  return {
    discovery: { results: discoveries },
    snapshot: { kind: "activity", collected_at: collected, repos: keys.map((k) => rows.get(k)!) },
    summary: {
      owners_total: owners.length,
      owners_complete: discoveries.filter((d) => d.ok).length,
      owners_unavailable: discoveries.filter((d) => !d.ok).length,
      repositories_total: rows.size,
      repositories_complete: complete,
      repositories_unavailable: rows.size - complete,
      direct_queries: directQueries,
    },
  };
}
