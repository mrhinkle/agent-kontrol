/**
 * Hosted progress collector (GET /api/progress/collect). Every GitHub call goes
 * to an injected fake fetch; nothing reaches api.github.com. Snapshot rows are
 * asserted at the injected ingest seam.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GET, maxDuration } from "../../src/app/api/progress/collect/route";
import type { IngestInput } from "../../src/lib/progress-store";
import type { OwnerSettingsBody, RepoSettingsBody } from "../../src/lib/settings-read";
import { CollectDeadlineError, GITHUB_FETCH_TIMEOUT_MS, ProgressGitHub, RepoTimeCapError } from "../../src/lib/progress-collect/github";
import {
  COLLECT_BUDGET_MS, COLLECT_DB_DEADLINE_MS, COLLECT_HARD_DEADLINE_MS, REPO_TIME_CAP_MS,
  runProgressCollection, sweepTargets, type CollectDeps,
} from "../../src/lib/progress-collect/run";
import { briefMetrics, collectRepo, laneOf, syncRepoDecisions, type OpenPr, type SweepSettings } from "../../src/lib/progress-collect/sweep";
import type { ReconcileInput, UpsertInput } from "../../src/lib/decisions";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString().replace(".000Z", "Z");
const SINCE = iso(24);
const SINCE72 = iso(72);

const SETTINGS: SweepSettings = {
  laneBotPrefix: "agent-lanes-",
  sharedBotPrefixes: ["shared-agent-lanes"],
  decisionLabels: ["needs-owner", "owner-gate-*", "decision"],
  stuckPrHours: 48,
  staleIssueDays: 21,
  lanePrCap: 80,
};

/* ------------------------------------------------------------ fake GitHub */

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

interface FakeOptions {
  /** search q -> total_count, or a Reply to fail with. */
  counts?: Record<string, number | Reply>;
  /** Replies for any request whose URL or GraphQL operation contains the key, checked first. */
  override?: (url: string, op: string | null, body: any) => Reply | null;
  clock: { t: number };
  /** Virtual ms each HTTP request costs. */
  costMs?: number;
}

function repoFixtures(repo: string) {
  return {
    [`repo:${repo} is:issue is:open`]: 12,
    [`repo:${repo} is:pr is:open`]: 3,
    [`repo:${repo} is:issue is:open label:"blocked"`]: 2,
    [`repo:${repo} is:issue closed:>=${SINCE}`]: 4,
    [`repo:${repo} is:issue created:>=${SINCE}`]: 5,
    [`repo:${repo} is:issue`]: 100,
    [`repo:${repo} is:issue is:closed`]: 90,
    [`repo:${repo} is:pr is:merged`]: 50,
  } as Record<string, number | Reply>;
}

const OPEN_ISSUES = [
  { number: 2, title: "Pick a vendor", url: "https://github.com/acme/app/issues/2", createdAt: iso(500), updatedAt: iso(30 * 24), labels: { nodes: [{ name: "needs-owner" }] } },
  { number: 1, title: "Fresh bug", url: "https://github.com/acme/app/issues/1", createdAt: iso(600), updatedAt: iso(2), labels: { nodes: [] } },
];

function prNode(n: number, extra: Record<string, unknown>) {
  return {
    number: n, title: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}`,
    createdAt: iso(1), updatedAt: iso(1), isDraft: false, mergeStateStatus: "CLEAN", reviewDecision: null,
    author: { login: "mrhinkle" }, labels: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...extra,
  };
}

function rollup(contexts: unknown[]) {
  return { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] };
}

const OPEN_PRS = [
  prNode(12, { createdAt: iso(2), updatedAt: iso(2), mergeStateStatus: "DIRTY",
    commits: rollup([{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }]) }),
  prNode(11, { isDraft: true, labels: { nodes: [{ name: "owner-gate-merge" }] } }),
  prNode(10, { createdAt: iso(72), updatedAt: iso(48), reviewDecision: "REVIEW_REQUIRED",
    commits: rollup([
      { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "StatusContext", context: "vercel", state: "SUCCESS" },
    ]) }),
];

const MERGED_72H = [
  { number: 8, title: "PR 8", html_url: "https://github.com/acme/app/pull/8", user: { login: "mrhinkle" }, created_at: iso(10), pull_request: { merged_at: iso(4) } },
  { number: 7, title: "PR 7", html_url: "https://github.com/acme/app/pull/7", user: { login: "mrhinkle" }, created_at: iso(30), pull_request: { merged_at: iso(6) } },
  { number: 5, title: "PR 5", html_url: "https://github.com/acme/app/pull/5", user: { login: "mrhinkle" }, created_at: iso(60), pull_request: { merged_at: iso(48) } },
];

const COMMITS: Record<number, unknown[]> = {
  7: [{ commit: { message: "fix: thing\n\nAgent-Vendor: Grok\nCo-Authored-By: x", author: { name: "Mark" } }, author: { login: "mrhinkle" } }],
  8: [{ commit: { message: "feat: other", author: { name: "bot" } }, author: { login: "agent-lanes-codex[bot]" } }],
};

function fakeGitHub(opts: FakeOptions) {
  const calls: { url: string; op: string | null }[] = [];
  const counts = opts.counts ?? {};
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    opts.clock.t += opts.costMs ?? 0;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const op = body?.query ? /query (\w+)/.exec(body.query)?.[1] ?? null : null;
    calls.push({ url, op });
    assert.ok(url.startsWith("https://api.github.com/"), "only the GitHub API is called");
    const reply = opts.override?.(url, op, body) ?? route(url, op, body, counts);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
  };
  return { fetchImpl, calls };
}

function route(url: string, op: string | null, body: any, counts: Record<string, number | Reply>): Reply {
  const u = new URL(url);
  if (u.pathname === "/search/issues") {
    const q = u.searchParams.get("q")!;
    const merged24 = /^repo:(\S+) is:pr is:merged merged:>=(\S+)$/.exec(q);
    if (merged24 && merged24[2] === SINCE) return { status: 200, body: { total_count: 2, items: [{ number: 7 }, { number: 8 }] } };
    if (merged24 && merged24[2] === SINCE72) return { status: 200, body: { total_count: 3, items: MERGED_72H } };
    const hit = counts[q];
    if (hit === undefined) return { status: 200, body: { total_count: 0, items: [] } };
    if (typeof hit === "number") return { status: 200, body: { total_count: hit, items: [] } };
    return hit;
  }
  const commits = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/commits$/.exec(u.pathname);
  if (commits) return { status: 200, body: COMMITS[Number(commits[1])] ?? [] };
  if (op === "ProgressOpenIssues") {
    return { status: 200, body: { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: OPEN_ISSUES } } } } };
  }
  if (op === "ProgressOpenPrs") {
    return { status: 200, body: { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: OPEN_PRS } } } } };
  }
  return { status: 404, body: { message: "unexpected fixture route", op, variables: body?.variables } };
}

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, clock: { t: number }, extra: Partial<ConstructorParameters<typeof ProgressGitHub>[0]> = {}) {
  return new ProgressGitHub({
    token: "test-token", fetchImpl, now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; }, ...extra,
  });
}

/* ------------------------------------------------------------ field parity */

describe("collectRepo field parity", () => {
  it("produces collect_repo's fields, with a failed search as null", async () => {
    const clock = { t: NOW };
    const counts = repoFixtures("acme/app");
    counts["repo:acme/app is:issue is:closed"] = { status: 502, body: { message: "bad gateway" } };
    const gh = fakeGitHub({ counts, clock });
    const { row, listings } = await collectRepo(client(gh.fetchImpl, clock),
      { repo: "acme/app", label: "App", blockedLabel: "blocked", short: "app" }, SETTINGS, NOW);

    assert.equal(row.open_issues, 12);
    assert.equal(row.open_prs, 3);
    assert.equal(row.blocked_issues, 2);
    assert.equal(row.issues_closed_24h, 4);
    assert.equal(row.issues_opened_24h, 5);
    assert.equal(row.total_issues_created, 100);
    assert.equal(row.total_issues_closed, null, "a search that failed twice is null, never 0");
    assert.equal(row.total_prs_merged, 50);
    assert.equal(row.merged_prs_24h, 2);
    const closedTries = gh.calls.filter((c) => c.url.includes(encodeURIComponent("is:issue is:closed").replace(/%20/g, "+")));
    assert.equal(closedTries.length, 2, "retried exactly once");

    assert.deepEqual(row.detail.lane_mix, { codex: 1, grok: 1 });
    assert.deepEqual(row.detail.notes, ["window from 2026-11-24"]);
    assert.deepEqual(row.detail.stalled_prs, [{ number: 10, title: "PR 10", url: "https://github.com/acme/app/pull/10", idle_hours: 48, green: true, draft: false }]);
    const stuck = row.detail.stuck_prs as { number: number; reason: string; repo: string }[];
    assert.deepEqual(stuck.map((s) => [s.number, s.reason, s.repo]), [[10, "no review yet", "app"], [12, "merge conflict with base", "app"]]);
    assert.equal(row.detail.stale_issues, 1);
    assert.equal(row.detail.stale_ratio, 0.5);
    assert.equal(row.detail.drafts, 1);
    assert.equal((row.detail.merged as unknown[]).length, 3);
    assert.deepEqual((row.detail.merged_list as { number: number }[]).map((m) => m.number), [8, 7]);
    assert.equal(row.detail.median_lead_hours, (6 + 24) / 2);
    assert.equal(listings.issues.items.length, 2);
  });

  it("an untracked blocked label is null, not zero", async () => {
    const clock = { t: NOW };
    const gh = fakeGitHub({ counts: repoFixtures("acme/app"), clock });
    const { row } = await collectRepo(client(gh.fetchImpl, clock), { repo: "acme/app", label: "App", blockedLabel: null, short: "app" }, SETTINGS, NOW);
    assert.equal(row.blocked_issues, null);
    assert.ok(!gh.calls.some((c) => c.url.includes("label")), "no label search is made");
  });

  it("a failed open-PR listing leaves the brief keys off and stalled empty", async () => {
    const clock = { t: NOW };
    const gh = fakeGitHub({ counts: repoFixtures("acme/app"), clock,
      override: (_u, op) => op === "ProgressOpenPrs" ? { status: 502, body: {} } : null });
    const { row } = await collectRepo(client(gh.fetchImpl, clock), { repo: "acme/app", label: "App", blockedLabel: null, short: "app" }, SETTINGS, NOW);
    assert.deepEqual(row.detail.stalled_prs, []);
    assert.equal("stuck_prs" in row.detail, false, "absent stuck_prs means unmeasured, not 'none'");
    assert.equal("merged" in row.detail, false);
  });

  it("search calls are at least 2.1 s apart", async () => {
    const clock = { t: NOW };
    const starts: number[] = [];
    const gh = fakeGitHub({ counts: repoFixtures("acme/app"), clock });
    const spy = async (url: string, init?: RequestInit) => {
      if (url.includes("/search/issues")) starts.push(clock.t);
      return gh.fetchImpl(url, init);
    };
    await collectRepo(client(spy, clock), { repo: "acme/app", label: "App", blockedLabel: "blocked", short: "app" }, SETTINGS, NOW);
    assert.ok(starts.length >= 10);
    for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 2100, `gap ${starts[i] - starts[i - 1]}`);
  });
});

describe("brief metrics parity with BRIEF_METRICS_JQ", () => {
  it("matches the script's jq on the same inputs", (t) => {
    const probe = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) return t.skip("jq is not installed");
    const script = fs.readFileSync("scripts/collect-progress.sh", "utf8");
    const jq = /# BEGIN brief-metrics-jq\nBRIEF_METRICS_JQ='([\s\S]*?)'\n# END brief-metrics-jq/.exec(script)?.[1];
    assert.ok(jq, "BRIEF_METRICS_JQ found in the script");
    const prs: OpenPr[] = OPEN_PRS.map((n: any) => ({
      number: n.number, title: n.title, url: n.url, createdAt: n.createdAt, updatedAt: n.updatedAt,
      isDraft: n.isDraft, mergeStateStatus: n.mergeStateStatus, reviewDecision: n.reviewDecision ?? "",
      author: n.author, labels: [], statusCheckRollup: (n.commits.nodes[0].commit.statusCheckRollup?.contexts.nodes ?? []).map((c: any) =>
        c.__typename === "StatusContext" ? { context: c.context, state: c.state } : { name: c.name, status: c.status, conclusion: c.conclusion }),
    }));
    // Extra edge cases: a pending check, BEHIND, CHANGES_REQUESTED, and a merge with no created_at.
    prs.push({ ...prs[2], number: 13, mergeStateStatus: "BEHIND", reviewDecision: "APPROVED", statusCheckRollup: [{ name: "slow", status: "IN_PROGRESS", conclusion: null }] });
    prs.push({ ...prs[2], number: 14, mergeStateStatus: "CLEAN", reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ name: "odd", status: "IN_PROGRESS", conclusion: "NEUTRAL" }] });
    // Exactly at the stuck threshold, with no other reason to be stuck.
    prs.push({ ...prs[2], number: 15, createdAt: iso(48), mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [] });
    prs.push({ ...prs[2], number: 16, createdAt: iso(47), mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [] });
    const issues = OPEN_ISSUES.map((i) => ({ number: i.number, updatedAt: i.updatedAt }));
    const merged = [...MERGED_72H.map((m) => ({ number: m.number, title: m.title, url: m.html_url, author: m.user, createdAt: m.created_at, mergedAt: m.pull_request.merged_at })),
      { number: 4, title: "PR 4", url: "u", author: { login: "x" }, createdAt: null, mergedAt: iso(3) }];
    const nowIso = iso(0);
    const staleBefore = iso(21 * 24);
    const res = spawnSync("jq", ["-nc", "--arg", "short", "app", "--arg", "now", nowIso, "--arg", "stale_before", staleBefore,
      "--argjson", "stuck_h", "48", "--argjson", "issues", JSON.stringify(issues), "--argjson", "prs", JSON.stringify(prs),
      "--argjson", "merged", JSON.stringify(merged), jq!], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const expected = JSON.parse(res.stdout);
    assert.deepEqual(expected.stuck_prs.map((p: { number: number }) => p.number), [10, 13, 14, 15, 12], "fixture exercises the threshold and each reason");
    assert.deepEqual(briefMetrics("app", nowIso, staleBefore, 48, issues, prs, merged), expected);
  });
});

describe("lane_of", () => {
  it("trailer wins, then bot identity, shared prefixes stay unattributed, humans are human", () => {
    const c = (message: string, login: string | null, name = "") => ({ commit: { message, author: { name } }, author: login ? { login } : null });
    assert.equal(laneOf([c("x\n\nagent-vendor: Claude", "mrhinkle")], "agent-lanes-", []), "claude");
    assert.equal(laneOf([c("x", "agent-lanes-grok[bot]"), c("y", "agent-lanes-grok[bot]"), c("z", "agent-lanes-codex[bot]")], "agent-lanes-", []), "grok");
    assert.equal(laneOf([c("x", "shared-agent-lanes-1[bot]")], "agent-lanes-", ["shared-agent-lanes"]), "unattributed");
    assert.equal(laneOf([c("x", null, "renovate[bot]")], "agent-lanes-", []), "renovate");
    assert.equal(laneOf([c("x", "mrhinkle")], "agent-lanes-", []), "human");
    // jq max_by keeps the last of equal groups after group_by sorts them.
    assert.equal(laneOf([c("Agent-Vendor: codex", "a"), c("Agent-Vendor: grok", "b")], "agent-lanes-", []), "grok");
  });
});

/* ------------------------------------------------------------ decisions */

describe("label-sourced decisions", () => {
  it("upserts labeled issues and PRs, then reconciles; a failed upsert does not withdraw", async () => {
    const clock = { t: NOW };
    const gh = fakeGitHub({ counts: repoFixtures("acme/app"), clock });
    const target = { repo: "acme/app", label: "App", blockedLabel: null, short: "app" };
    const { listings } = await collectRepo(client(gh.fetchImpl, clock), target, SETTINGS, NOW);
    const upserts: UpsertInput[] = [];
    const reconciles: ReconcileInput[] = [];
    await syncRepoDecisions(target, listings, SETTINGS, {
      async upsert(body) { upserts.push(body); return true; },
      async reconcile(input) { reconciles.push(input); return true; },
    });
    assert.deepEqual(upserts.map((u) => [u.key, u.kind, u.why]), [["github:acme/app#2", "issue", "needs-owner"], ["github:acme/app#11", "pr", "owner-gate-merge"]]);
    assert.deepEqual(reconciles, [{ repo: "acme/app", source: "github-label", seen_keys: ["github:acme/app#2", "github:acme/app#11"] }]);

    const again: ReconcileInput[] = [];
    await syncRepoDecisions(target, listings, SETTINGS, { async upsert() { return false; }, async reconcile(i) { again.push(i); return true; } });
    assert.deepEqual(again, [], "a failed upsert never withdraws");
    const late: string[] = [];
    await syncRepoDecisions(target, listings, SETTINGS,
      { async upsert(b) { late.push(b.key); return true; }, async reconcile() { late.push("reconcile"); return true; } },
      () => late.length >= 1);
    assert.deepEqual(late, ["github:acme/app#2"], "past the write deadline: stop upserting and never withdraw");
    await syncRepoDecisions(target, { ...listings, prs: { ...listings.prs, complete: false } }, SETTINGS,
      { async upsert() { throw new Error("must not upsert"); }, async reconcile() { throw new Error("must not reconcile"); } });
  });
});

/* ------------------------------------------------------------ the run */

function repoRow(repo: string): Record<string, unknown> {
  return { repo, label: repo.split("/")[1], short: repo.split("/")[1], color: "#123456", blockedLabel: null };
}

function harness(opts: {
  repos?: string[];
  ages?: Record<string, string>;
  latestActivity?: string | null;
  budgetMs?: number;
  hardDeadlineMs?: number;
  override?: FakeOptions["override"];
  costMs?: number;
  owners?: OwnerSettingsBody["owners"];
  rows?: Record<string, Record<string, unknown>>;
}) {
  const clock = { t: NOW };
  const repos = opts.repos ?? ["acme/a", "acme/b", "acme/c"];
  const counts: Record<string, number | Reply> = {};
  for (const r of repos) Object.assign(counts, repoFixtures(r));
  const gh = fakeGitHub({ counts, clock, override: opts.override, costMs: opts.costMs });
  const ingested: IngestInput[] = [];
  const discovery: unknown[] = [];
  const deps: CollectDeps = {
    token: "test-token",
    fetchImpl: gh.fetchImpl,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    budgetMs: opts.budgetMs,
    hardDeadlineMs: opts.hardDeadlineMs,
    settings: { ...SETTINGS, decisionLabels: [] },
    ingest: async (input) => { ingested.push(structuredClone(input)); return input.repos.length; },
    readOwners: async () => ({ writable: true, max: 50, version: "v", owners: opts.owners ?? [] }),
    readRepos: async () => ({ source: "database", writable: true, max: 200, version: "v", repos: repos.map((r) => ({ ...repoRow(r), ...(opts.rows?.[r] ?? {}) })) } as unknown as RepoSettingsBody),
    applyDiscovery: async (results) => { discovery.push(...results); return true; },
    latestActivityAt: async () => opts.latestActivity === undefined ? iso(1 / 60) : opts.latestActivity,
    tickAges: async () => new Map(Object.entries(opts.ages ?? {})),
    decisions: { async upsert() { return true; }, async reconcile() { return true; } },
  };
  return { deps, ingested, discovery, gh, clock };
}

const ticks = (ingested: IngestInput[]) => ingested.filter((i) => i.kind === "tick");

describe("runProgressCollection", () => {
  it("writes each repo as its own tick with its own collected_at", async () => {
    const h = harness({});
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.sweep.collected, ["acme/a", "acme/b", "acme/c"]);
    assert.equal(out.body.sweep.remaining, 0);
    const rows = ticks(h.ingested);
    assert.deepEqual(rows.map((r) => r.repos.map((x) => x.repo)), [["acme/a"], ["acme/b"], ["acme/c"]]);
    const stamps = rows.map((r) => r.collected_at!);
    assert.equal(new Set(stamps).size, 3, "per-repo collected_at, not one shared tick instant");
    assert.ok(stamps.every((s, i) => i === 0 || s > stamps[i - 1]));
    assert.equal(JSON.stringify(out.body).includes("test-token"), false);
  });

  it("budget: once the budget is spent no repo starts, and only finished repos are written", async () => {
    const h = harness({ budgetMs: 1 });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, ["acme/a"], "the first repo started inside the budget and finished");
    assert.equal(out.body.sweep.remaining, 2);
    assert.deepEqual(ticks(h.ingested).map((r) => r.repos[0].repo), ["acme/a"]);
  });

  it("budget: a repo cut off by the hard deadline is not written at all", async () => {
    // One repo costs 9 searches x 2.2 s (about 20 s). The deadline lands inside the second repo.
    const h = harness({ hardDeadlineMs: 30_000 });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, ["acme/a"]);
    assert.deepEqual(ticks(h.ingested).map((r) => r.repos[0].repo), ["acme/a"], "no partial row for acme/b");
    assert.equal(out.body.ok, true);
  });

  it("rotation: never-collected first, then the oldest tick", async () => {
    const h = harness({ ages: { "acme/a": iso(1), "acme/b": iso(3) }, budgetMs: 30_000 });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, ["acme/c", "acme/b"]);
    assert.deepEqual(ticks(h.ingested).map((r) => r.repos[0].repo), ["acme/c", "acme/b"]);
  });

  it("gone repos are not swept", async () => {
    const h = harness({ repos: ["acme/a", "acme/b"] });
    const readRepos = h.deps.readRepos;
    h.deps.readRepos = async () => {
      const body = await readRepos();
      body.repos[1] = { ...body.repos[1], gone: true };
      return body;
    };
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, ["acme/a"]);
  });

  it("activity: skipped while the last scan is under 15 minutes old", async () => {
    const h = harness({ latestActivity: iso(5 / 60), owners: [{ owner: "acme", include_forks: false, include_archived: false } as any] });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.activity, { ran: false, repos: 0, status: "fresh" });
    assert.equal(h.gh.calls.some((c) => c.op === "ProgressOwnerActivity"), false);
    assert.equal(h.ingested.some((i) => i.kind === "activity"), false);
  });

  it("activity: runs when stale, and a failed owner becomes unavailable rows, not zeros", async () => {
    const h = harness({ latestActivity: iso(20 / 60), repos: ["acme/a"], budgetMs: 0,
      owners: [{ owner: "acme", include_forks: false, include_archived: false } as any],
      override: (_u, op) => op === "ProgressOwnerActivity" ? { status: 502, body: {} } : null });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.body.activity.ran, true);
    assert.equal(out.body.activity.status, "partial");
    const activity = h.ingested.find((i) => i.kind === "activity")!;
    assert.equal(activity.repos.length, 1);
    const row = activity.repos[0] as any;
    assert.equal(row.repo, "acme/a");
    assert.equal(row.open_prs, null);
    assert.equal(row.detail.activity.status, "unavailable");
    assert.equal(row.detail.activity.open_issues, null);
    assert.deepEqual(h.discovery.map((d: any) => [d.owner, d.ok, d.error]), [["acme", false, "github_read_failed"]]);
  });

  it("activity: runs when absent and records a complete owner scan (owner saved as Acme, GitHub login acme)", async () => {
    const node = {
      id: "R_1", nameWithOwner: "acme/a", isArchived: false, isFork: false, pushedAt: iso(3),
      openPullRequests: { totalCount: 1 }, openIssues: { totalCount: 2 },
      latestPullRequest: { totalCount: 4, nodes: [{ updatedAt: iso(2) }] },
      latestIssue: { totalCount: 5, nodes: [{ updatedAt: iso(1) }] },
    };
    const h = harness({ latestActivity: null, repos: ["acme/a"], budgetMs: 0,
      owners: [{ owner: "Acme", include_forks: false, include_archived: false } as any],
      override: (_u, op) => op === "ProgressOwnerActivity" ? { status: 200, body: { data: { repositoryOwner: { login: "acme",
        repositories: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: "c1" }, nodes: [node] } } } } } : null });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.activity, { ran: true, repos: 1, status: "complete" });
    const row = h.ingested.find((i) => i.kind === "activity")!.repos[0] as any;
    assert.equal(row.open_prs, 1);
    assert.equal(row.detail.activity.open_issues, 2);
    assert.equal(row.detail.activity.status, "complete");
    assert.deepEqual(h.discovery.map((d: any) => [d.owner, d.ok]), [["acme", true]]);
  });

  it("GitHub 401 -> 502 github_auth, nothing written", async () => {
    const h = harness({ override: () => ({ status: 401, body: { message: "Bad credentials" } }) });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 502);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.error, "github_auth");
    assert.deepEqual(h.ingested, []);
  });

  it("GitHub 401 in the activity scan -> 502, no activity rows written", async () => {
    const h = harness({ latestActivity: null, owners: [{ owner: "acme", include_forks: false, include_archived: false } as any],
      override: (_u, op) => op === "ProgressOwnerActivity" ? { status: 401, body: {} } : null });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 502);
    assert.equal(out.body.error, "github_auth");
    assert.deepEqual(h.ingested, []);
    assert.deepEqual(h.discovery, []);
  });

  it("429 mid-batch: earlier repos stay written, rate_limited true", async () => {
    const h = harness({ override: (url) => url.includes("acme%2Fb") ? { status: 429, body: { message: "slow down" } } : null });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.sweep.collected, ["acme/a"]);
    assert.equal(out.body.sweep.rate_limited, true);
    assert.equal(out.body.sweep.remaining, 2);
    assert.deepEqual(ticks(h.ingested).map((r) => r.repos[0].repo), ["acme/a"]);
  });

  it("a 403 rate limit on the first repo is never ok", async () => {
    const h = harness({ override: () => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }) });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 502);
    assert.equal(out.body.ok, false);
    assert.equal(out.body.sweep.rate_limited, true);
    assert.deepEqual(h.ingested, []);
  });
});

/* ------------------------------------------------------------ the route */

describe("GET /api/progress/collect auth", () => {
  const env = process.env as Record<string, string | undefined>;
  const keys = ["CRON_SECRET", "MC_TOKEN", "MC_DASHBOARD_PASSWORD", "DATABASE_URL", "GH_TOKEN", "GITHUB_TOKEN", "NODE_ENV"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = env[k];
      delete env[k];
    }
    env.NODE_ENV = "test";
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
  });
  const get = (auth?: string) => GET(new Request("http://127.0.0.1/api/progress/collect", auth ? { headers: { authorization: auth } } : {}));

  it("no CRON_SECRET and no MC_TOKEN: an unauthenticated call is refused", async () => {
    const res = await get();
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  it("a wrong bearer is refused when CRON_SECRET and MC_TOKEN are set", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.MC_TOKEN = "mc-token-value-1";
    const res = await get("Bearer nope");
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  });

  it("CRON_SECRET runs (demo response without a database)", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.MC_TOKEN = "mc-token-value-1";
    const res = await get("Bearer cron-secret-value-1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, demo: true, note: "DATABASE_URL not set; nothing collected." });
  });

  it("missing GitHub token -> 503 github_token_missing, before any database work", async () => {
    env.CRON_SECRET = "cron-secret-value-1";
    env.DATABASE_URL = "postgresql://nobody:none@127.0.0.1:1/none";
    const res = await get("Bearer cron-secret-value-1");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "github_token_missing");
  });
});

/* ------------------------------------------------------------ time limits */

describe("time limits", () => {
  it("the limits fit the route's maxDuration with at least 10 s to spare", () => {
    assert.equal(maxDuration * 1000, 300_000);
    assert.ok(COLLECT_BUDGET_MS + GITHUB_FETCH_TIMEOUT_MS <= COLLECT_HARD_DEADLINE_MS, "a request started at the budget ends by the deadline");
    assert.ok(COLLECT_HARD_DEADLINE_MS < COLLECT_DB_DEADLINE_MS);
    assert.ok(COLLECT_DB_DEADLINE_MS + 10_000 <= maxDuration * 1000);
    assert.ok(REPO_TIME_CAP_MS <= 90_000 && REPO_TIME_CAP_MS < COLLECT_BUDGET_MS);
  });

  it("a request near the deadline gets a shortened timeout and is cut off at the deadline", async () => {
    const started = Date.now();
    let signal: AbortSignal | undefined;
    const hanging = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const gh = new ProgressGitHub({ token: "t", fetchImpl: hanging, hardDeadline: started + 1_500 });
    assert.ok(gh.requestTimeoutMs() <= 1_500, `timeout ${gh.requestTimeoutMs()}`);
    await assert.rejects(gh.request("GET", "rate_limit"), CollectDeadlineError);
    assert.ok(Date.now() - started < 4_000, "cut at the deadline, not after the 20 s timeout");
    assert.equal(signal?.aborted, true);
  });

  it("no request starts with under a second left, and no wait sleeps past the deadline", async () => {
    const clock = { t: NOW };
    let fetched = 0;
    let slept = 0;
    const gh = new ProgressGitHub({ token: "t", now: () => clock.t, sleep: async (ms) => { slept += ms; clock.t += ms; },
      fetchImpl: async () => { fetched += 1; clock.t += 100; return new Response("{}", { status: 502 }); },
      hardDeadline: NOW + 900 });
    await assert.rejects(gh.request("GET", "rate_limit"), CollectDeadlineError);
    assert.equal(fetched, 0, "not started");
    const gh2 = new ProgressGitHub({ token: "t", now: () => clock.t, sleep: async (ms) => { slept += ms; clock.t += ms; },
      fetchImpl: async () => { fetched += 1; clock.t += 100; return new Response("{}", { status: 502 }); },
      hardDeadline: clock.t + 10_000 });
    await assert.rejects(gh2.searchCount("repo:acme/a is:issue"), CollectDeadlineError);
    assert.equal(fetched, 1, "first attempt made");
    assert.equal(slept, 0, "the 30 s retry wait would cross the deadline, so it is not slept");
  });

  it("a repo past its own time cap raises RepoTimeCapError, not the run deadline", async () => {
    const clock = { t: NOW };
    const gh = new ProgressGitHub({ token: "t", now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
      fetchImpl: async () => new Response("{}", { status: 200 }), hardDeadline: NOW + 200_000 });
    gh.setRepoDeadline(NOW + 500);
    await assert.rejects(gh.request("GET", "x"), RepoTimeCapError);
    gh.setRepoDeadline(null);
    await gh.request("GET", "x");
  });
});

describe("a slow repo does not starve the rest", () => {
  it("the oldest repo always stalls; it is skipped at its cap and the next repos are collected", async () => {
    const h = harness({
      repos: ["acme/stuck", "acme/a", "acme/b"],
      ages: { "acme/a": iso(2), "acme/b": iso(1) },
      override: (url, _op, body) => {
        const stuck = url.includes("acme%2Fstuck") || url.includes("acme/stuck") || body?.variables?.name === "stuck";
        if (!stuck) return null;
        h.clock.t += 25_000; // every call to this repo takes 25 s and fails
        return { status: 502, body: {} };
      },
    });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.skipped, [{ repo: "acme/stuck", reason: "repo_time_cap" }]);
    assert.deepEqual(out.body.sweep.collected, ["acme/a", "acme/b"]);
    assert.deepEqual(ticks(h.ingested).map((r) => r.repos[0].repo), ["acme/a", "acme/b"], "nothing written for the stalled repo");
    assert.equal(out.body.ok, true);
  });

  it("a repo that throws unexpectedly is skipped and the run moves on", async () => {
    // A null issue node makes the listing mapper throw a TypeError inside collectRepo.
    const h = harness({ repos: ["acme/bad", "acme/a"], ages: { "acme/a": iso(1) },
      override: (_url, op, body) => op === "ProgressOpenIssues" && body?.variables?.name === "bad"
        ? { status: 200, body: { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null] } } } } }
        : null });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.skipped, [{ repo: "acme/bad", reason: "error" }]);
    assert.deepEqual(out.body.sweep.collected, ["acme/a"]);
    assert.deepEqual(ticks(h.ingested).map((r) => r.repos[0].repo), ["acme/a"]);
  });

  it("every attempted repo skipped and none collected is not ok", async () => {
    const h = harness({ repos: ["acme/stuck"], override: () => { h.clock.t += 25_000; return { status: 502, body: {} }; } });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, []);
    assert.equal(out.status, 502);
    assert.equal(out.body.ok, false);
  });
});

describe("sweep eligibility", () => {
  it("skips hidden and owner-excluded repos the board never shows; a pinned excluded repo stays", async () => {
    const h = harness({ repos: ["acme/shown", "acme/hidden", "acme/fork", "acme/pinned-fork"], rows: {
      "acme/hidden": { hidden: true },
      "acme/fork": { ownerExcluded: true },
      "acme/pinned-fork": { ownerExcluded: true, pinned: true },
    } });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, ["acme/shown", "acme/pinned-fork"]);
    assert.equal(out.body.sweep.remaining, 0);
    assert.deepEqual(sweepTargets(await h.deps.readRepos()).map((t) => t.repo), ["acme/shown", "acme/pinned-fork"]);
  });
});
