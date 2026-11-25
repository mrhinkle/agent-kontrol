/**
 * Hosted progress collector with the read-only GitHub App: one installation
 * token per repo owner. Every call goes to an injected fake fetch; nothing
 * reaches api.github.com. The RSA key is generated here and is not a secret.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { githubAppConfig } from "../../src/lib/github-read";
import {
  collectorAppCredentials,
  collectorCredentials,
  GitHubAppNotInstalledError,
  ProgressGitHub,
  type GitHubCredentials,
} from "../../src/lib/progress-collect/github";
import { runProgressCollection, type CollectDeps } from "../../src/lib/progress-collect/run";
import type { IngestInput } from "../../src/lib/progress-store";
import type { RepoSettingsBody } from "../../src/lib/settings-read";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP: GitHubCredentials = { kind: "app", appId: "5928005", privateKey };

interface Call {
  method: string;
  path: string;
  auth: string;
  owner: string | null;
}

/** Which repo owner a GitHub call is about, read from the call itself. */
function ownerOf(url: URL, body: any): string | null {
  if (url.pathname === "/search/issues") return /repo:([^/\s]+)\//.exec(url.searchParams.get("q") ?? "")?.[1] ?? null;
  if (url.pathname === "/graphql") return body?.variables?.owner ?? null;
  return /^\/repos\/([^/]+)\//.exec(url.pathname)?.[1] ?? null;
}

function fakeGitHub(opts: {
  clock: { t: number };
  installations?: Record<string, { at: "users" | "orgs"; id: number }>;
  tokenTtlMs?: number;
  appStatus?: number;
  repoCostMs?: number;
}) {
  const calls: Call[] = [];
  const installations = opts.installations ?? { mrhinkle: { at: "users", id: 11 }, "the-aie": { at: "orgs", id: 22 } };
  const mints = new Map<number, number>();
  const ownerOfId = new Map(Object.entries(installations).map(([o, v]) => [v.id, o]));
  const fetchImpl = async (raw: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(raw);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = String((init?.headers as Record<string, string>).authorization ?? "");
    calls.push({ method: init?.method ?? "GET", path: url.pathname, auth, owner: ownerOf(url, body) });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    const inst = /^\/(users|orgs)\/([^/]+)\/installation$/.exec(url.pathname);
    if (inst) {
      if (opts.appStatus) return json(opts.appStatus, { message: "A JSON web token could not be decoded" });
      const hit = installations[decodeURIComponent(inst[2]).toLowerCase()];
      return hit && hit.at === inst[1] ? json(200, { id: hit.id }) : json(404, { message: "Not Found" });
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint) {
      const id = Number(mint[1]);
      const n = (mints.get(id) ?? 0) + 1;
      mints.set(id, n);
      return json(201, { token: `ghs_${ownerOfId.get(id)}_${n}`, expires_at: iso(opts.clock.t + (opts.tokenTtlMs ?? 3_600_000)) });
    }
    opts.clock.t += opts.repoCostMs ?? 0;
    if (url.pathname === "/search/issues") return json(200, { total_count: 1, items: [] });
    if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits$/.test(url.pathname)) return json(200, []);
    if (body?.query?.includes("ProgressOwnerActivity")) {
      const owner = String(body.variables.owner);
      const node = {
        id: `R_${owner}`, nameWithOwner: `${owner}/app`, isArchived: false, isFork: false, pushedAt: iso(NOW - 3_600_000),
        openPullRequests: { totalCount: 0 }, openIssues: { totalCount: 0 },
        latestPullRequest: { totalCount: 0, nodes: [] }, latestIssue: { totalCount: 0, nodes: [] },
      };
      return json(200, { data: { repositoryOwner: { login: owner, repositories: {
        totalCount: 1, pageInfo: { hasNextPage: false, endCursor: `c-${owner}` }, nodes: [node] } } } });
    }
    if (body?.query) {
      const field = body.query.includes("ProgressOpenIssues") ? "issues" : "pullRequests";
      return json(200, { data: { repository: { [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    }
    return json(404, { message: "unexpected fixture route" });
  };
  return { fetchImpl, calls, mints };
}

const isJwt = (auth: string) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth);

function harness(opts: { repos: string[]; owners?: string[]; credentials?: GitHubCredentials; latestActivity?: string | null } & Parameters<typeof fakeGitHub>[0]) {
  const gh = fakeGitHub(opts);
  const ingested: IngestInput[] = [];
  const deps: CollectDeps = {
    credentials: opts.credentials ?? APP,
    fetchImpl: gh.fetchImpl,
    now: () => opts.clock.t,
    sleep: async (ms) => { opts.clock.t += ms; },
    settings: { laneBotPrefix: "agent-lanes-", sharedBotPrefixes: [], decisionLabels: [], stuckPrHours: 48, staleIssueDays: 21, lanePrCap: 80 },
    ingest: async (input) => { ingested.push(structuredClone(input)); return input.repos.length; },
    readOwners: async () => ({ writable: true, max: 50, version: "v",
      owners: (opts.owners ?? []).map((owner) => ({ owner, include_forks: false, include_archived: false })) as any }),
    readRepos: async () => ({ source: "database", writable: true, max: 200, version: "v",
      repos: opts.repos.map((repo) => ({ repo, label: repo, short: repo.split("/")[1], color: "#123456", blockedLabel: null })) } as unknown as RepoSettingsBody),
    applyDiscovery: async () => true,
    latestActivityAt: async () => opts.latestActivity === undefined ? iso(opts.clock.t) : opts.latestActivity,
    tickAges: async () => new Map(),
    decisions: { async upsert() { return true; }, async reconcile() { return true; } },
  };
  return { deps, ingested, gh };
}

describe("GitHub App credentials", () => {
  it("routes every call with its owner's installation token, minting once per owner", async () => {
    const clock = { t: NOW };
    const h = harness({ clock, repos: ["mrhinkle/app", "The-AIE/app"], owners: ["mrhinkle", "The-AIE"], latestActivity: null });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.sweep.collected, ["mrhinkle/app", "The-AIE/app"]);
    assert.equal(out.body.activity.status, "complete");
    const data = h.gh.calls.filter((c) => !c.path.startsWith("/app/") && !c.path.endsWith("/installation"));
    assert.ok(data.length > 10);
    for (const call of data) {
      assert.ok(call.owner, `every data call names its owner (${call.path})`);
      const expected = call.owner!.toLowerCase() === "mrhinkle" ? "ghs_mrhinkle_1" : "ghs_the-aie_1";
      assert.equal(call.auth, `Bearer ${expected}`, `${call.method} ${call.path} for ${call.owner}`);
    }
    assert.ok(data.some((c) => c.owner?.toLowerCase() === "the-aie"));
    assert.ok(data.some((c) => c.owner === "mrhinkle"));
    const appCalls = h.gh.calls.filter((c) => c.path.startsWith("/app/") || c.path.endsWith("/installation"));
    assert.ok(appCalls.every((c) => isJwt(c.auth)), "App endpoints carry the App JWT, never an installation token");
    assert.deepEqual([...h.gh.mints.entries()].sort(), [[11, 1], [22, 1]], "one mint per owner per run");
  });

  it("re-mints after the token expires (a minute's margin)", async () => {
    const clock = { t: NOW };
    const gh = fakeGitHub({ clock, tokenTtlMs: 10 * 60_000 });
    const client = new ProgressGitHub({ credentials: APP, fetchImpl: gh.fetchImpl, now: () => clock.t });
    await client.request("GET", "repos/mrhinkle/a/pulls/1/commits", undefined, "mrhinkle");
    clock.t += 8 * 60_000;
    await client.request("GET", "repos/mrhinkle/a/pulls/1/commits", undefined, "mrhinkle");
    assert.equal(gh.mints.get(11), 1, "still valid: reused");
    clock.t += 90_000; // 9.5 min: inside the one-minute margin
    await client.request("GET", "repos/mrhinkle/a/pulls/1/commits", undefined, "mrhinkle");
    assert.equal(gh.mints.get(11), 2, "re-minted before expiry");
    const used = gh.calls.filter((c) => c.path.startsWith("/repos/")).map((c) => c.auth);
    assert.deepEqual(used, ["Bearer ghs_mrhinkle_1", "Bearer ghs_mrhinkle_1", "Bearer ghs_mrhinkle_2"]);
  });

  it("an owner without the App: unavailable activity rows and skipped repos, never zeros", async () => {
    const clock = { t: NOW };
    const h = harness({ clock, repos: ["ghost/r", "mrhinkle/app"], owners: ["ghost", "mrhinkle"], latestActivity: null });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.skipped, [{ repo: "ghost/r", reason: "app_not_installed" }]);
    assert.deepEqual(out.body.sweep.collected, ["mrhinkle/app"]);
    assert.equal(out.body.ok, true);
    const ticks = h.ingested.filter((i) => i.kind === "tick").map((i) => i.repos[0].repo);
    assert.deepEqual(ticks, ["mrhinkle/app"], "nothing written for the uninstalled owner's repo");
    const activity = h.ingested.find((i) => i.kind === "activity")!;
    const ghost = activity.repos.find((r) => r.repo === "ghost/r") as any;
    assert.equal(ghost.open_prs, null);
    assert.equal(ghost.detail.activity.status, "unavailable");
    assert.equal(ghost.detail.activity.error, "app_not_installed");
    assert.equal(ghost.detail.activity.open_issues, null);
    assert.equal(h.gh.calls.filter((c) => c.path.endsWith("/ghost/installation")).length, 2, "looked up once per run (user, then org)");
  });

  it("only uninstalled owners: nothing collected is not ok", async () => {
    const clock = { t: NOW };
    const h = harness({ clock, repos: ["ghost/r"] });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 502);
    assert.equal(out.body.ok, false);
    assert.deepEqual(h.ingested, []);
  });

  it("a key that cannot sign is the run's github_auth failure", async () => {
    const clock = { t: NOW };
    const h = harness({ clock, repos: ["mrhinkle/a"], credentials: { kind: "app", appId: "5928005", privateKey: "not a pem" } });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 502);
    assert.equal(out.body.error, "github_auth");
    assert.deepEqual(h.ingested, []);
  });

  it("a 401 from the /app endpoints is the run's github_auth failure", async () => {
    const clock = { t: NOW };
    const h = harness({ clock, repos: ["mrhinkle/a"], owners: ["mrhinkle"], latestActivity: null, appStatus: 401 });
    const out = await runProgressCollection(h.deps);
    assert.equal(out.status, 502);
    assert.equal(out.body.error, "github_auth");
    assert.deepEqual(h.ingested, []);
  });

  it("not installed is a distinct error from the client", async () => {
    const clock = { t: NOW };
    const gh = fakeGitHub({ clock });
    const client = new ProgressGitHub({ credentials: APP, fetchImpl: gh.fetchImpl, now: () => clock.t });
    await assert.rejects(client.searchCount("repo:ghost/r is:issue", "ghost"), GitHubAppNotInstalledError);
  });
});

describe("credential selection", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";

  it("prefers the App; falls back to GH_TOKEN, then GITHUB_TOKEN; none is null (503)", () => {
    assert.deepEqual(collectorCredentials({ MC_GITHUB_APP_ID: "1", MC_GITHUB_APP_PRIVATE_KEY: key, GH_TOKEN: "gh" }), { kind: "app", appId: "1", privateKey: key });
    assert.deepEqual(collectorCredentials({ GH_TOKEN: "gh", GITHUB_TOKEN: "other" }), { kind: "token", token: "gh" });
    assert.deepEqual(collectorCredentials({ GITHUB_TOKEN: "other" }), { kind: "token", token: "other" });
    assert.deepEqual(collectorCredentials({ MC_GITHUB_APP_ID: "1", GH_TOKEN: "gh" }), { kind: "token", token: "gh" }, "half an App config is not an App");
    assert.equal(collectorCredentials({}), null);
  });

  it("with GH_TOKEN only, every call carries it and no App endpoint is called", async () => {
    const clock = { t: NOW };
    const h = harness({ clock, repos: ["mrhinkle/a", "The-AIE/b"], credentials: { kind: "token", token: "gh-fallback" } });
    const out = await runProgressCollection(h.deps);
    assert.deepEqual(out.body.sweep.collected, ["mrhinkle/a", "The-AIE/b"]);
    assert.ok(h.gh.calls.length > 0 && h.gh.calls.every((c) => c.auth === "Bearer gh-fallback"));
    assert.equal(h.gh.calls.some((c) => c.path.startsWith("/app/") || c.path.endsWith("/installation")), false);
  });

  it("the reducer gate stays closed: githubAppConfig is null without MC_GITHUB_APP_BOT_LOGIN", () => {
    const env = { MC_GITHUB_APP_ID: "5928005", MC_GITHUB_APP_PRIVATE_KEY: key } as unknown as NodeJS.ProcessEnv;
    assert.equal(githubAppConfig(env), null, "reducers (#80) stay off");
    assert.notEqual(collectorAppCredentials(env), null, "the collector still uses the App");
  });
});
