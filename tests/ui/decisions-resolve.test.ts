import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { actorFromPrincipal, runWithActor } from "../../src/lib/actor";
import { authCookieValue } from "../../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { DecisionCard, DecisionList } from "../../src/components/DecisionQueue";
import { DECISION_MARKER, buildDecisionComment, decisionSourceHref } from "../../src/lib/decision-format";
import { listDecisionsTool, requestDecisionTool } from "../../src/lib/decision-resolve";
import {
  listDecisions,
  parseListQuery,
  presentDecision,
  setDecisionStoreForTests,
  setDecisionWriteback,
  upsertDecision,
  WRITEBACK_LOCK_LEASE_SECONDS,
  type Decision,
  type DecisionStore,
  type UpsertInput,
} from "../../src/lib/decisions";
import { GitHubWriteError, GITHUB_FETCH_TIMEOUT_MS, type GitHubWriteClient, clearGitHubWriteClientForTests, setGitHubWriteClientForTests, setWritebackLockWaitForTests, writeDecisionBack } from "../../src/lib/decision-writeback";
import { authorizeTool } from "../../src/lib/scopes";
import { createMemoryDecisionStore } from "./decision-memory";

const env = process.env;
const saved = {
  DATABASE_URL: env.DATABASE_URL,
  GH_TOKEN: env.GH_TOKEN,
  GITHUB_TOKEN: env.GITHUB_TOKEN,
  MC_DASHBOARD_PASSWORD: env.MC_DASHBOARD_PASSWORD,
  MC_TOKEN: env.MC_TOKEN,
};
const originalFetch = globalThis.fetch;

type Handle = { unref?: () => void };
type Route = (req: Request) => Promise<Response>;
type IdRoute = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let mcpPost: Route;
let patchDecision: IdRoute;
let postWriteback: IdRoute;
let fetchCalls = 0;

function handles(): Handle[] {
  const get = (process as unknown as { _getActiveHandles?: () => Handle[] })._getActiveHandles;
  return get ? get() : [];
}

function mcpToolText(raw: string): string {
  const line = raw.split("\n").find((item) => item.startsWith("data: "));
  if (!line) throw new Error(`MCP response has no SSE data: ${raw.slice(0, 300)}`);
  const payload = JSON.parse(line.slice("data: ".length)) as {
    result?: { content?: { text?: string }[] };
  };
  const text = payload.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`MCP response has no tool text: ${raw.slice(0, 300)}`);
  return text;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function blankAuth(): void {
  delete env.DATABASE_URL;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
}

before(async () => {
  const origInterval = global.setInterval;
  global.setInterval = ((fn: TimerHandler, ms?: number) => {
    const timer = origInterval(fn, ms);
    (timer as Handle).unref?.();
    return timer;
  }) as typeof setInterval;
  try {
    ({ POST: mcpPost } = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href));
    ({ PATCH: patchDecision } = await import("../../src/app/api/decisions/[id]/route"));
    ({ POST: postWriteback } = await import("../../src/app/api/decisions/[id]/writeback/route"));
  } finally {
    global.setInterval = origInterval;
  }
});

beforeEach(() => {
  restoreEnv();
  blankAuth();
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("real GitHub fetch");
  }) as typeof fetch;
  resetCredentialsForTests();
  setDecisionStoreForTests(null);
  clearGitHubWriteClientForTests();
});

afterEach(() => {
  setDecisionStoreForTests(null);
  clearGitHubWriteClientForTests();
  setWritebackLockWaitForTests(null);
  resetCredentialsForTests();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

after(() => {
  for (const handle of handles()) handle.unref?.();
});

async function issue(scopes: string[]): Promise<string> {
  const created = await createCredential({ label: "decision lane", scopes });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("credential was not issued");
  assert.match(created.token, /^akc_/);
  return created.token;
}

function patch(id: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return patchDecision(new Request(`http://localhost/api/decisions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(id) }) });
}

function writeback(id: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return postWriteback(new Request(`http://localhost/api/decisions/${id}/writeback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(id) }) });
}

async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const before = new Set(handles());
  try {
    const res = await mcpPost(new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }));
    return { status: res.status, text: await res.text() };
  } finally {
    for (const handle of handles()) {
      if (!before.has(handle)) handle.unref?.();
    }
  }
}

async function seed(over: Partial<UpsertInput> = {}): Promise<Decision> {
  const result = await upsertDecision({
    key: "github:acme/widgets#12",
    source: "github-label",
    repo: "evil/other",
    repo_short: "evil",
    number: 99,
    url: null,
    title: "Ship the schema",
    why: "The page and the collector disagree.",
    options: [
      { id: "ship", label: "Ship the columns" },
      { id: "wait", label: "Wait" },
    ],
    recommended: "wait",
    requested_by: "collector",
    kind: "issue",
    labels: ["bug", "needs-owner", "decision"],
    opened_at: "2026-10-01T00:00:00.000Z",
    first_seen_at: "2026-10-01T00:00:00.000Z",
    github_present: true,
    force: false,
    ...over,
  });
  return result.decision;
}

class FakeGitHub implements GitHubWriteClient {
  calls: { method: string; repo: string; number: number; body?: string; label?: string }[] = [];
  state = "open";
  labels = [
    { name: "bug" },
    { name: "needs-owner" },
    { name: "decision" },
    { name: "owner-gate-tierc" },
  ];
  comments: { body: string; author?: string | null }[] = [];
  viewerLogin: string | null = null;
  failGet: "403" | "404" | "network" | null = null;
  failLabel = false;

  async viewer(): Promise<string | null> {
    return this.viewerLogin;
  }

  async getIssue(repo: string, number: number) {
    this.calls.push({ method: "get", repo, number });
    if (this.failGet === "network") throw new Error("socket hang up");
    if (this.failGet) throw new GitHubWriteError(this.failGet);
    return { state: this.state, labels: this.labels.map((label) => ({ ...label })) };
  }

  async listComments(repo: string, number: number) {
    this.calls.push({ method: "comments", repo, number });
    return this.comments.map((comment) => ({ ...comment }));
  }

  async createComment(repo: string, number: number, body: string) {
    this.calls.push({ method: "comment", repo, number, body });
    this.comments.push({ body, author: this.viewerLogin });
  }

  async removeLabel(repo: string, number: number, name: string) {
    this.calls.push({ method: "unlabel", repo, number, label: name });
    if (this.failLabel) throw new GitHubWriteError("403");
    this.labels = this.labels.filter((label) => label.name !== name);
  }
}

function install(github: FakeGitHub): void {
  setGitHubWriteClientForTests(github);
}

describe("decision resolve", { concurrency: false }, () => {
  it("F1: an agent credential can request and list, and cannot resolve", async () => {
    const asker = await issue(["decisions:request", "decisions:read"]);
    const writer = await issue(["decisions:write"]);
    const askerPrincipal = { kind: "agent" as const, id: "asker", scopes: ["decisions:request", "decisions:read"] };
    assert.equal(authorizeTool(askerPrincipal, "request_decision").ok, true);
    assert.equal(authorizeTool(askerPrincipal, "list_decisions").ok, true);
    assert.equal(authorizeTool(askerPrincipal, "resolve_decision").ok, false);
    assert.equal(authorizeTool({ kind: "agent", id: "writer", scopes: ["decisions:write"] }, "resolve_decision").ok, true);
    assert.equal(authorizeTool({ kind: "agent", id: "writer", scopes: ["decisions:write"] }, "request_decision").ok, false);

    const requested = await mcp(asker, "request_decision", {
      slug: "pick",
      title: "Pick one",
      repo: "evil/other",
      number: 99,
      key: "github:evil/other#99",
      force: true,
    });
    assert.equal(requested.status, 200, requested.text.slice(0, 400));
    assert.match(requested.text, /Demo mode; decision not stored/);

    const listed = await mcp(asker, "list_decisions", {});
    assert.equal(listed.status, 200, listed.text.slice(0, 400));
    assert.deepEqual(JSON.parse(mcpToolText(listed.text)), { demo: true, decisions: [] });

    const resolved = await mcp(asker, "resolve_decision", { id: 1, status: "decided", decision: "no" });
    assert.equal(resolved.status, 403, resolved.text.slice(0, 400));
    assert.match(resolved.text, /insufficient_scope/);
    assert.match(resolved.text, /decisions:write/);

    const deniedPatch = await patch(4, { status: "decided", decision: "no" }, { authorization: `Bearer ${asker}` });
    assert.equal(deniedPatch.status, 403);
    assert.equal((await deniedPatch.json()).code, "insufficient_scope");

    const deniedRetry = await writeback(4, { expected_updated_at: "2026-10-27T00:00:00.000Z" }, { authorization: `Bearer ${asker}` });
    assert.equal(deniedRetry.status, 403);
    assert.equal((await deniedRetry.json()).code, "insufficient_scope");

    const allowed = await patch(4, { status: "decided", decision: "Ship it" }, { authorization: `Bearer ${writer}` });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true, demo: true });

    const toolResolve = await mcp(writer, "resolve_decision", { id: 4, status: "withdrawn" });
    assert.equal(toolResolve.status, 200, toolResolve.text.slice(0, 400));
    assert.match(toolResolve.text, /Demo mode; decision not resolved/);

    env.MC_DASHBOARD_PASSWORD = "secret";
    const cookie = await authCookieValue("secret");
    const session = await patch(4, { status: "withdrawn" }, { cookie: `mc_auth=${cookie}` });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { ok: true, demo: true });
    assert.equal(fetchCalls, 0);
  });

  it("F2: the same request key upserts, never duplicates, and never reopens a decided row", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const actor = { actor_type: "agent" as const, actor_id: "cred-9" };
    const first = await runWithActor(actor, () => requestDecisionTool({
      slug: "pick",
      title: "Pick one",
      why: "because",
      options: [{ id: "a", label: "A" }],
      recommended: "a",
    }));
    const opened = JSON.parse(first.content[0].text) as { decision: Decision; status_held: boolean };
    assert.equal(opened.status_held, false);
    assert.equal(opened.decision.status, "open");
    assert.equal(opened.decision.key, "agent:cred-9:pick");
    assert.equal(opened.decision.repo, null);
    assert.equal(opened.decision.number, null);
    assert.equal(store.upserts[0].force, false);

    const decided = await patch(opened.decision.id, {
      status: "decided",
      decision: "ship",
      repo: "evil/other",
      number: 99,
      force: true,
      decided_by: "mark",
    });
    assert.equal(decided.status, 200, await decided.clone().text());
    const decidedBody = await decided.json() as { decision: Decision };
    assert.equal(decidedBody.decision.status, "decided");
    assert.equal(decidedBody.decision.decision, "ship");

    const second = await runWithActor(actor, () => requestDecisionTool({
      slug: "pick",
      title: "Pick again",
      why: "try to reopen",
    }));
    const again = JSON.parse(second.content[0].text) as { decision: Decision; status_held: boolean };
    assert.equal(again.status_held, true);
    assert.equal(again.decision.id, opened.decision.id);
    assert.equal(again.decision.status, "decided");
    assert.equal(again.decision.decision, "ship");
    assert.equal(store.rows.filter((row) => row.key === "agent:cred-9:pick").length, 1);
    assert.equal(store.upserts.every((input) => input.force === false && input.repo == null && input.number == null), true);
    assert.equal(fetchCalls, 0);
  });

  it("F3: write-back failures still decide the row, and a retry does not double-comment", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    install(github);

    async function decide(key: string): Promise<Decision> {
      const row = await seed({ key, title: key });
      const res = await patch(row.id, { status: "decided", decision: "ship", expected_updated_at: row.updated_at });
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json() as { decision: Decision };
      assert.equal(body.decision.status, "decided");
      return body.decision;
    }

    clearGitHubWriteClientForTests();
    const noToken = await decide("github:acme/widgets#21");
    assert.equal(noToken.writeback, "not_written");
    assert.equal(fetchCalls, 0);
    assert.equal(github.calls.length, 0);

    install(github);
    github.failGet = "403";
    const forbidden = await decide("github:acme/widgets#22");
    assert.equal(forbidden.writeback, "not_written");
    assert.equal(github.calls.filter((call) => call.method === "comment").length, 0);

    github.failGet = "404";
    const missing = await decide("github:acme/widgets#23");
    assert.equal(missing.writeback, "not_written");
    assert.equal(github.comments.length, 0);

    github.failGet = "network";
    const offline = await decide("github:acme/widgets#24");
    assert.equal(offline.writeback, "not_written");
    assert.equal(github.comments.length, 0);

    github.failGet = null;
    github.state = "closed";
    const closed = await decide("github:acme/widgets#25");
    assert.equal(closed.writeback, "not_written");
    assert.equal(github.comments.length, 0);
    assert.equal(github.calls.some((call) => call.method === "comment"), false);

    github.state = "open";
    github.failLabel = true;
    const partial = await decide("github:acme/widgets#26");
    assert.equal(partial.writeback, "not_written");
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, new RegExp(`^${DECISION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    github.failLabel = false;
    const retry = await writeback(partial.id, { expected_updated_at: partial.updated_at });
    assert.equal(retry.status, 200, await retry.clone().text());
    const retried = await retry.json() as { decision: Decision };
    assert.equal(retried.decision.writeback, "written");
    assert.equal(github.comments.length, 1);
    assert.deepEqual(github.labels.map((label) => label.name), ["bug"]);
    assert.equal(github.calls.filter((call) => call.method === "comment").length, 1);
    assert.equal(fetchCalls, 0);
  });

  it("F4: write-back posts only to the issue named by the key", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    install(github);
    const row = await seed({
      key: "github:acme/widgets#12",
      repo: "evil/other",
      number: 99,
    });
    const res = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
      repo: "evil/other",
      number: 99,
      key: "github:evil/other#99",
    });
    assert.equal(res.status, 200, await res.clone().text());
    const targets = github.calls.map((call) => `${call.method} ${call.repo}#${call.number}`);
    assert.ok(targets.length > 0);
    assert.equal(targets.every((target) => target.endsWith("acme/widgets#12")), true, targets.join(", "));
    assert.equal(targets.some((target) => target.includes("evil/other")), false);
    assert.equal(fetchCalls, 0);

    const href = decisionSourceHref({
      url: "javascript:alert(1)",
      key: "github:acme/widgets#12",
      kind: "pr",
      repo: "evil/other",
      number: 99,
    } as Decision);
    assert.equal(href, "https://github.com/acme/widgets/pull/12");
  });

  it("F5: a second decide, defer, or withdraw is a conflict and does not overwrite", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const row = await seed({ key: "agent:cred:pick", repo: null, number: null });
    const first = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    assert.equal(first.status, 200, await first.clone().text());
    const decided = await first.json() as { decision: Decision };

    const overwrite = await patch(decided.decision.id, {
      status: "decided",
      decision: "<script>overwrite</script>",
      expected_updated_at: decided.decision.updated_at,
    });
    assert.equal(overwrite.status, 409);
    const conflict = await overwrite.json() as { code: string; error: string; fields: { status: string } };
    assert.equal(conflict.code, "conflict");
    assert.equal(typeof conflict.error, "string");
    assert.match(conflict.fields.status, /Already decided or withdrawn/);
    assert.equal(store.rows.find((item) => item.id === row.id)?.decision, "ship");

    const withdraw = await patch(row.id, { status: "withdrawn", expected_updated_at: decided.decision.updated_at });
    assert.equal(withdraw.status, 409);
    assert.equal((await withdraw.json()).code, "conflict");

    const deferredRow = await seed({ key: "agent:cred:later" });
    const deferred = await patch(deferredRow.id, {
      status: "deferred",
      defer_until: "2099-01-01",
      expected_updated_at: deferredRow.updated_at,
    });
    assert.equal(deferred.status, 200, await deferred.clone().text());
    const deferredBody = await deferred.json() as { decision: Decision };
    const redefer = await patch(deferredRow.id, {
      status: "deferred",
      defer_until: "2099-06-01",
      expected_updated_at: deferredBody.decision.updated_at,
    });
    assert.equal(redefer.status, 200, await redefer.clone().text());
    const fromDeferred = await patch(deferredRow.id, {
      status: "decided",
      decision: "now",
      expected_updated_at: (await redefer.json() as { decision: Decision }).decision.updated_at,
    });
    assert.equal(fromDeferred.status, 200, await fromDeferred.clone().text());

    const openAgain = await patch(row.id, { status: "open", expected_updated_at: decided.decision.updated_at });
    assert.equal(openAgain.status, 200, await openAgain.clone().text());
    const reopened = await openAgain.json() as { decision: Decision };
    assert.equal(reopened.decision.status, "open");
    assert.equal(reopened.decision.decision, null);
    assert.equal(store.rows.find((item) => item.id === row.id)?.decision, null);
    const fresh = await seed({ key: "agent:cred:clear" });
    const closed = await patch(fresh.id, { status: "decided", decision: "once", expected_updated_at: fresh.updated_at });
    const closedBody = await closed.json() as { decision: Decision };
    const cleared = await patch(fresh.id, { status: "open" });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    const clearedBody = await cleared.json() as { decision: Decision };
    assert.equal(clearedBody.decision.status, "open");
    assert.equal(clearedBody.decision.decision, null);
    assert.notEqual(closedBody.decision.status, "open");

    const withdrawn = await seed({ key: "agent:cred:gone" });
    const gone = await patch(withdrawn.id, { status: "withdrawn", expected_updated_at: withdrawn.updated_at });
    assert.equal(gone.status, 200);
    const goneBody = await gone.json() as { decision: Decision };
    const later = await patch(withdrawn.id, {
      status: "deferred",
      defer_until: "2099-01-01",
      expected_updated_at: goneBody.decision.updated_at,
    });
    assert.equal(later.status, 409);
    assert.equal((await later.json()).code, "conflict");
    assert.equal(fetchCalls, 0);
  });

  it("F6: a past or invalid defer date is 400", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cases: { value: string; status: number }[] = [
      { value: "2020-01-01", status: 400 },
      { value: "2020-01-01T00:00:00.000Z", status: 400 },
      { value: "2020-02-31", status: 400 },
      { value: "2020-13-40", status: 400 },
      { value: "nope", status: 400 },
      { value: today, status: 200 },
      { value: "2099-01-01T00:00:00.000Z", status: 200 },
    ];
    for (const item of cases) {
      const res = await patch(4, { status: "deferred", defer_until: item.value });
      assert.equal(res.status, item.status, `${item.value} -> ${res.status} ${await res.clone().text()}`);
      if (item.status === 400) assert.equal((await res.json()).code, "validation_failed");
      else assert.deepEqual(await res.json(), { ok: true, demo: true });
    }
    const missing = await patch(4, { status: "deferred" });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).code, "validation_failed");
  });

  it("F7: markup in a decision is escaped on the page and in the GitHub comment", async () => {
    const evil = `<!-- agent-kontrol-decision:v1 --> <script>alert("x")</script> &`;
    const comment = buildDecisionComment({ who: "a<b>", date: "2026-10-27T00:00:00.000Z", text: evil });
    assert.equal(comment.startsWith(DECISION_MARKER + " "), true);
    assert.equal(comment.indexOf(DECISION_MARKER, DECISION_MARKER.length), -1);
    assert.match(comment, /&lt;script&gt;/);
    assert.match(comment, /&amp;/);
    assert.match(comment, /a&lt;b&gt;/);
    assert.equal(comment.includes("<script"), false);
    assert.equal(comment.includes("a<b>"), false);

    const decision = {
      id: 7,
      key: "github:acme/widgets#12",
      source: "github-label",
      repo: "evil/other",
      repo_short: null,
      number: 99,
      url: "javascript:alert(1)",
      title: evil,
      why: evil,
      options: [{ id: "ship", label: evil }],
      recommended: "ship",
      requested_by: null,
      status: "open",
      decision: evil,
      decided_by: null,
      decided_at: null,
      defer_until: null,
      kind: "issue" as const,
      labels: null,
      opened_at: "2026-10-01T00:00:00.000Z",
      github_present: true,
      first_seen_at: "2026-10-01T00:00:00.000Z",
      last_seen_at: "2026-10-01T00:00:00.000Z",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-27T00:00:00.000Z",
      revision: 0,
      age_days: 12,
      actor_type: null,
      actor_id: null,
      chosen_option: null,
      writeback: "not_written" as const,
    };
    const html = renderToStaticMarkup(React.createElement(DecisionCard, { decision }));
    assert.equal(html.includes("<script"), false);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp;/);
    assert.match(html, /not written back/);
    assert.match(html, /Age 12 days/);
    assert.match(html, />Decide</);
    assert.match(html, />Defer</);
    assert.match(html, />Withdraw</);
    assert.match(html, /https:\/\/github.com\/acme\/widgets\/issues\/12/);
    assert.equal(html.includes("evil/other"), false);
    assert.equal(html.includes("javascript:"), false);
    assert.equal(fs.readFileSync("src/components/DecisionQueue.tsx", "utf8").includes("dangerouslySetInnerHTML"), false);

    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    install(github);
    const row = await seed({ key: "github:acme/widgets#12" });
    const res = await patch(row.id, {
      status: "decided",
      decision: evil,
      expected_updated_at: row.updated_at,
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(github.comments.length, 1);
    const posted = github.comments[0].body;
    assert.equal(posted.includes("<script"), false);
    assert.match(posted, /&lt;script&gt;/);
    assert.match(posted, /&amp;/);
    assert.equal(posted.indexOf(DECISION_MARKER, DECISION_MARKER.length), -1);
    assert.equal(fetchCalls, 0);
  });

  it("F8: dev-open stores null actor fields", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const row = await seed({ key: "agent:local:pick", repo: null, number: null });
    assert.equal(actorFromPrincipal({ kind: "dev-open" }), null);
    const res = await patch(row.id, {
      status: "decided",
      decision: "ship",
      decided_by: "mark",
      actor_type: "human",
      actor_id: "operator",
      expected_updated_at: row.updated_at,
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { decision: Decision };
    assert.equal(body.decision.actor_type, null);
    assert.equal(body.decision.actor_id, null);
    assert.equal(body.decision.decided_by, null);
    const stored = store.rows.find((item) => item.id === row.id);
    assert.equal(stored?.actor_type, null);
    assert.equal(stored?.actor_id, null);
    assert.equal(stored?.decided_by, null);
    assert.notEqual(stored?.decided_by, "mark");
    assert.notEqual(stored?.actor_id, "operator");
  });

  it("F9: a stale expected_revision is refused, including when the row is now decided", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const row = await seed({ key: "agent:cred:race", repo: null, number: null });
    const loaded = row.revision;
    const first = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_revision: loaded,
      expected_updated_at: "2026-10-28 12:00:00.123456+00",
    });
    assert.equal(first.status, 200, await first.clone().text());
    const current = await first.json() as { decision: Decision };
    assert.notEqual(current.decision.revision, loaded);

    const stale = await patch(row.id, {
      status: "withdrawn",
      decision: "overwrite",
      expected_revision: loaded,
      expected_updated_at: current.decision.updated_at,
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as { code: string };
    assert.equal(staleBody.code, "stale");
    assert.equal(store.rows.find((item) => item.id === row.id)?.status, "decided");
    assert.equal(store.rows.find((item) => item.id === row.id)?.decision, "ship");

    const currentConflict = await patch(row.id, {
      status: "decided",
      decision: "overwrite",
      expected_revision: current.decision.revision,
      expected_updated_at: "1999-01-01T00:00:00.000Z",
    });
    assert.equal(currentConflict.status, 409);
    assert.equal((await currentConflict.json()).code, "conflict");
  });

  it("lists oldest first and does not write back on defer or withdraw", async () => {
    const wire = fs.readFileSync("docs/decisions-wireframe.md", "utf8");
    assert.match(wire, /not written back/);
    assert.match(wire, /\[ Decide \]/);
    assert.match(wire, /Retry write-back/);

    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    install(github);
    const older = await seed({
      key: "github:acme/widgets#1",
      title: "Older",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      opened_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = await seed({
      key: "github:acme/widgets#2",
      title: "Newer",
      first_seen_at: "2026-10-01T00:00:00.000Z",
      opened_at: "2026-10-01T00:00:00.000Z",
    });
    const listed = await listDecisionsTool({ status: "open" });
    const payload = JSON.parse(listed.content[0].text) as { decisions: Decision[] };
    assert.deepEqual(payload.decisions.map((row) => row.title), ["Older", "Newer"]);
    const before = payload.decisions.map((row) => row.updated_at);
    const again = await listDecisionsTool({ status: "open" });
    const second = JSON.parse(again.content[0].text) as { decisions: Decision[] };
    assert.deepEqual(second.decisions.map((row) => row.updated_at), before);

    const html = renderToStaticMarkup(React.createElement(DecisionList, { decisions: payload.decisions }));
    assert.ok(html.indexOf("Older") < html.indexOf("Newer"));
    assert.match(html, /\(recommended\)/);
    assert.match(html, /The page and the collector disagree/);

    const deferred = await patch(older.id, { status: "deferred", defer_until: "2099-01-01", expected_updated_at: older.updated_at });
    assert.equal(deferred.status, 200, await deferred.clone().text());
    const withdrawn = await patch(newer.id, { status: "withdrawn", expected_updated_at: newer.updated_at });
    assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
    assert.equal(github.calls.length, 0);
    assert.equal((await deferred.json() as { decision: Decision }).decision.writeback, null);
    assert.equal(fetchCalls, 0);
  });

  it("rejects a decision-text overwrite of a decided or withdrawn row when status is omitted", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    install(github);
    const row = await seed({ key: "github:acme/widgets#41", repo: null, number: null });
    const first = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    assert.equal(first.status, 200, await first.clone().text());
    const decided = (await first.json() as { decision: Decision }).decision;
    assert.equal(decided.writeback, "written");
    assert.equal(github.comments.length, 1);

    const overwrite = await patch(decided.id, {
      decision: "overwrite",
      expected_updated_at: decided.updated_at,
    });
    assert.equal(overwrite.status, 409);
    assert.equal((await overwrite.json() as { code: string }).code, "conflict");
    const stored = store.rows.find((item) => item.id === row.id);
    assert.equal(stored?.status, "decided");
    assert.equal(stored?.decision, "ship");
    assert.equal(stored?.writeback, "written");
    assert.equal(github.comments.length, 1);

    const parked = await seed({ key: "agent:cred:gone-text" });
    const withdrawn = await patch(parked.id, {
      status: "withdrawn",
      expected_updated_at: parked.updated_at,
    });
    assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
    const gone = (await withdrawn.json() as { decision: Decision }).decision;
    const rewrite = await patch(parked.id, {
      decision: "overwrite",
      expected_updated_at: gone.updated_at,
    });
    assert.equal(rewrite.status, 409);
    assert.equal((await rewrite.json() as { code: string }).code, "conflict");
    const withdrawnRow = store.rows.find((item) => item.id === parked.id);
    assert.equal(withdrawnRow?.status, "withdrawn");
    assert.equal(withdrawnRow?.decision, null);
    assert.equal(fetchCalls, 0);
  });

  it("does not treat a bare decision marker as a completed write-back", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    github.comments.push({ body: `${DECISION_MARKER}\nlooks done` });
    install(github);
    const row = await seed({ key: "github:acme/widgets#42" });
    const res = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(github.comments.length, 2, github.comments.map((comment) => comment.body).join("\n---\n"));
    const posted = github.comments[1].body;
    assert.equal(posted.startsWith(DECISION_MARKER), true);
    assert.match(posted, /ship/);
    assert.equal((await res.json() as { decision: Decision }).decision.writeback, "written");
    assert.equal(github.labels.some((label) => label.name === "needs-owner"), false);

    clearGitHubWriteClientForTests();
    const again = await seed({ key: "github:acme/widgets#43" });
    const held = await patch(again.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: again.updated_at,
    });
    const heldRow = (await held.json() as { decision: Decision }).decision;
    assert.equal(heldRow.writeback, "not_written");
    const expected = buildDecisionComment({
      who: heldRow.actor_id ?? "unknown",
      date: heldRow.decided_at ?? "",
      text: heldRow.decision ?? "",
    });
    const forged = new FakeGitHub();
    forged.viewerLogin = "ak-bot";
    forged.comments.push({ body: expected, author: "mallory" });
    install(forged);
    const retry = await writeback(heldRow.id, { expected_updated_at: heldRow.updated_at });
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal(forged.comments.length, 2);
    assert.equal(forged.comments[1].body, expected);
    assert.equal(forged.comments[1].author, "ak-bot");
    assert.equal(fetchCalls, 0);
  });

  it("serializes concurrent write-backs so only one GitHub comment is posted", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const row = await seed({ key: "github:acme/widgets#44" });
    const first = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    assert.equal(first.status, 200, await first.clone().text());
    const decided = (await first.json() as { decision: Decision }).decision;
    assert.equal(decided.writeback, "not_written");
    assert.equal(decided.decision, "ship");

    const github = new FakeGitHub();
    let creates = 0;
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      github.createComment = async (repo, number, body) => {
        creates += 1;
        if (creates === 1) {
          resolve();
          await new Promise<void>((done) => {
            release = done;
          });
        }
        github.calls.push({ method: "comment", repo, number, body });
        github.comments.push({ body, author: github.viewerLogin });
      };
    });
    install(github);
    const one = writeback(decided.id, { expected_updated_at: decided.updated_at });
    await entered;
    const two = writeback(decided.id, { expected_updated_at: decided.updated_at });
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      assert.equal(creates, 1);
    } finally {
      release();
    }
    const [left, right] = await Promise.all([one, two]);
    assert.equal(left.status, 200, await left.clone().text());
    assert.equal(right.status, 200, await right.clone().text());
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /ship/);
    assert.equal(creates, 1);
    assert.equal(fetchCalls, 0);
  });

  it("lists decided rows whose write-back did not land", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const missed = await seed({ key: "github:acme/widgets#45", title: "Missed" });
    const posted = await seed({ key: "github:acme/widgets#46", title: "Posted" });
    const missedRes = await patch(missed.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: missed.updated_at,
    });
    const postedRes = await patch(posted.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: posted.updated_at,
    });
    assert.equal((await missedRes.json() as { decision: Decision }).decision.writeback, "not_written");
    assert.equal((await postedRes.json() as { decision: Decision }).decision.writeback, "not_written");
    const stored = store.rows.find((item) => item.id === posted.id);
    assert.ok(stored);
    stored.writeback = "written";

    const parsed = parseListQuery(new URLSearchParams("status=decided&writeback=not_written"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const rows = await listDecisions(parsed);
    assert.deepEqual(rows.map((item) => item.title), ["Missed"]);
  });

  it("conflicts an explicit reopen while write-back holds the decided revision", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const row = await seed({ key: "github:acme/widgets#70" });
    const github = new FakeGitHub();
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      github.getIssue = async (repo, number) => {
        github.calls.push({ method: "get", repo, number });
        resolve();
        await new Promise<void>((done) => {
          release = done;
        });
        return { state: github.state, labels: github.labels.map((label) => ({ ...label })) };
      };
    });
    install(github);
    const deciding = patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    try {
      await entered;
      assert.equal(github.comments.length, 0);
      const during = store.rows.find((item) => item.id === row.id);
      assert.equal(during?.status, "decided");
      assert.equal(during?.decision, "ship");
      assert.equal(typeof during?.writeback_lock, "string");

      const reopened = await patch(row.id, { status: "open" });
      assert.equal(reopened.status, 409, await reopened.clone().text());
      assert.equal((await reopened.json() as { code: string }).code, "writeback_in_progress");
      const held = store.rows.find((item) => item.id === row.id);
      assert.equal(held?.status, "decided");
      assert.equal(held?.decision, "ship");
      assert.equal(held?.writeback, null);
      assert.equal(github.comments.length, 0);
    } finally {
      release();
    }

    const res = await deciding;
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { decision: Decision };
    assert.equal(body.decision.status, "decided");
    assert.equal(body.decision.writeback, "written");
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /ship/);
    const stored = store.rows.find((item) => item.id === row.id);
    assert.equal(stored?.status, "decided");
    assert.equal(stored?.writeback, "written");
    assert.equal(stored?.writeback_lock ?? null, null);

    const opened = await patch(row.id, { status: "open" });
    assert.equal(opened.status, 200, await opened.clone().text());
    const openRow = store.rows.find((item) => item.id === row.id);
    assert.equal(openRow?.status, "open");
    assert.equal(openRow?.decision, null);
    assert.equal(openRow?.actor_id, null);
    assert.equal(openRow?.writeback, null);
    assert.equal(fetchCalls, 0);
  });

  it("does not post or stamp a stale decision after the store row was reopened", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const row = await seed({ key: "github:acme/widgets#71" });
    const decidedRes = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    assert.equal(decidedRes.status, 200, await decidedRes.clone().text());
    const decided = (await decidedRes.json() as { decision: Decision }).decision;
    assert.equal(decided.status, "decided");
    assert.equal(decided.writeback, "not_written");

    const opened = await patch(row.id, { status: "open" });
    assert.equal(opened.status, 200, await opened.clone().text());
    const github = new FakeGitHub();
    install(github);
    const outcome = await writeDecisionBack({
      id: row.id,
      key: decided.key,
      actor_id: decided.actor_id,
      decided_at: decided.decided_at,
      decision: decided.decision,
      revision: decided.revision,
    });
    assert.notEqual(outcome.status, "written");
    assert.equal(github.calls.length, 0);
    assert.equal(github.comments.length, 0);

    const stamped = await setDecisionWriteback(row.id, "written", decided.revision, "lost-token");
    assert.equal(stamped, null);
    const stored = store.rows.find((item) => item.id === row.id);
    assert.equal(stored?.status, "open");
    assert.equal(stored?.decision, null);
    assert.equal(stored?.actor_id, null);
    assert.equal(stored?.writeback, null);
    assert.equal(fetchCalls, 0);
  });

  it("stamps writeback only for the same decided revision in SQL", () => {
    const src = fs.readFileSync("src/lib/decisions.ts", "utf8");
    const stampStart = src.indexOf("export async function setDecisionWriteback");
    const stampEnd = src.indexOf("export async function listDecisions");
    const stamp = src.slice(stampStart, stampEnd);
    assert.match(stamp, /status = 'decided'/);
    assert.match(stamp, /revision = \$\{revision\}/);
    assert.match(stamp, /writeback_lock = \$\{token\}/);
    assert.match(stamp, /writeback_lock = null/);
    assert.doesNotMatch(stamp, /updated_at = \$\{revision\}/);

    const patchStart = src.indexOf("export async function patchDecision");
    const patchSql = src.slice(patchStart);
    assert.match(patchSql, /\$\{status\} is distinct from 'open'/);
    assert.match(patchSql, /writeback_lock is null/);
    assert.match(patchSql, /revision = \$\{expectedRevision\}/);
    assert.doesNotMatch(patchSql, /updated_at = \$\{expected/);

    const claimStart = src.indexOf("export async function claimDecisionWriteback");
    const claimEnd = src.indexOf("export async function releaseDecisionWriteback");
    assert.ok(claimStart >= 0 && claimEnd > claimStart);
    const claim = src.slice(claimStart, claimEnd);
    assert.match(claim, /status = 'decided'/);
    assert.match(claim, /revision = \$\{revision\}/);
    assert.match(claim, /revision = revision \+ 1/);
    assert.doesNotMatch(claim, /updated_at = \$\{/);
  });

  it("does not compare updated_at for equality in decision SQL", () => {
    const src = ["src/lib/decisions.ts", "src/lib/decision-resolve.ts", "src/lib/decision-writeback.ts"]
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const bad = src.split("\n").filter((line) => {
      if (/updated_at\s*=\s*now\(\)/.test(line)) return false;
      if (/updated_at\s*=\s*excluded\.updated_at/.test(line)) return false;
      return /updated_at\s*=\s*(\$\{|\$\d+)/.test(line) || /(?<!expected_)updated_at\s*=\s*'/.test(line);
    });
    assert.deepEqual(bad, []);
  });

  it("keeps the write-back lease longer than the caller and aborts GitHub fetches", () => {
    assert.equal(WRITEBACK_LOCK_LEASE_SECONDS, 180);
    assert.equal(GITHUB_FETCH_TIMEOUT_MS, 15_000);
    const route = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    assert.match(route, /maxDuration:\s*60/);
    const src = fs.readFileSync("src/lib/decision-writeback.ts", "utf8");
    assert.match(src, /signal:\s*AbortSignal\.timeout\(GITHUB_FETCH_TIMEOUT_MS\)/);
    assert.ok(WRITEBACK_LOCK_LEASE_SECONDS > 60);
  });

  it("a microsecond updated_at does not break the write-back claim", async () => {
    const stored: Record<string, unknown> = {
      id: 1,
      key: "github:acme/widgets#9",
      source: "github-label",
      repo: "acme/widgets",
      number: 9,
      title: "Ship the schema",
      status: "decided",
      decision: "ship",
      decided_by: null,
      decided_at: "2026-10-28 12:00:00.123456+00",
      actor_id: "operator",
      writeback: null,
      writeback_lock: null,
      writeback_lock_at: null,
      revision: 4,
      updated_at: "2026-10-28 12:00:00.123456+00",
      first_seen_at: "2026-10-01T00:00:00.000Z",
      last_seen_at: "2026-10-28 12:00:00.123456+00",
      created_at: "2026-10-01T00:00:00.000Z",
    };
    const presented = presentDecision(stored, "2026-10-28T12:00:01.000Z");
    assert.equal(presented.updated_at, "2026-10-28T12:00:00.123Z");
    assert.equal(presented.revision, 4);
    const claimedWith: { value: unknown } = { value: undefined };
    const store: DecisionStore = {
      async get() {
        return { ...stored };
      },
      async list() {
        return [];
      },
      async upsert() {
        throw new Error("unused");
      },
      async patch() {
        throw new Error("unused");
      },
      async setWriteback(_id, writeback, revision, token) {
        if (stored.status !== "decided" || stored.revision !== revision) return null;
        if (token != null && stored.writeback_lock !== token) return null;
        stored.writeback = writeback;
        stored.revision = Number(stored.revision) + 1;
        if (token != null) {
          stored.writeback_lock = null;
          stored.writeback_lock_at = null;
        }
        return { ...stored };
      },
      async claimWriteback(_id, revision) {
        claimedWith.value = revision;
        if (typeof revision !== "number" || revision !== 4) {
          stored.status = "open";
          return null;
        }
        stored.writeback_lock = "fence";
        stored.revision = 5;
        return { token: "fence", revision: 5 };
      },
      async releaseWriteback(_id, token) {
        if (stored.writeback_lock === token) {
          stored.writeback_lock = null;
          stored.writeback_lock_at = null;
        }
      },
      async writebackClaimHeld(_id, token, revision) {
        return stored.status === "decided" && stored.writeback_lock === token && stored.revision === revision;
      },
    };
    setDecisionStoreForTests(store);
    const github = new FakeGitHub();
    install(github);
    const outcome = await writeDecisionBack({
      id: 1,
      key: "github:acme/widgets#9",
      actor_id: "operator",
      decided_at: presented.decided_at,
      decision: "ship",
      revision: presented.revision,
    });
    assert.equal(typeof claimedWith.value, "number");
    assert.equal(claimedWith.value, 4);
    assert.equal(outcome.status, "written");
    assert.equal(github.comments.length, 1);
    assert.equal(stored.writeback, "written");
    assert.equal(stored.status, "decided");
  });

  it("an expired-lease writer cannot post after reopen", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    const row = await seed({ key: "github:acme/widgets#80" });
    const github = new FakeGitHub();
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      github.getIssue = async (repo, number) => {
        github.calls.push({ method: "get", repo, number });
        resolve();
        await new Promise<void>((done) => {
          release = done;
        });
        return { state: github.state, labels: github.labels.map((label) => ({ ...label })) };
      };
    });
    install(github);
    const deciding = patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    try {
      await entered;
      const during = store.rows.find((item) => item.id === row.id);
      assert.ok(during);
      during.writeback_lock_at = new Date(Date.now() - 50_000).toISOString();
      const early = await patch(row.id, { status: "open" });
      assert.equal(early.status, 409, await early.clone().text());
      assert.equal((await early.json() as { code: string }).code, "writeback_in_progress");
      assert.equal(store.rows.find((item) => item.id === row.id)?.status, "decided");
      assert.equal(github.comments.length, 0);

      during.writeback_lock_at = new Date(Date.now() - (WRITEBACK_LOCK_LEASE_SECONDS + 1) * 1000).toISOString();
      const reopened = await patch(row.id, { status: "open" });
      assert.equal(reopened.status, 200, await reopened.clone().text());
      const opened = store.rows.find((item) => item.id === row.id);
      assert.equal(opened?.status, "open");
      assert.equal(opened?.writeback_lock ?? null, null);
      assert.equal(opened?.writeback_lock_at ?? null, null);
    } finally {
      release();
    }
    const res = await deciding;
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { decision: Decision };
    assert.equal(body.decision.status, "open");
    assert.equal(github.comments.length, 0);
    assert.equal(store.rows.find((item) => item.id === row.id)?.writeback ?? null, null);
  });

  it("crash then force reopen then a new decision writes back", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const key = "github:acme/widgets#81";
    const row = await seed({ key });
    const decidedRes = await patch(row.id, {
      status: "decided",
      decision: "old answer",
      expected_updated_at: row.updated_at,
    });
    assert.equal(decidedRes.status, 200, await decidedRes.clone().text());
    const stored = store.rows.find((item) => item.id === row.id);
    assert.ok(stored);
    const revisionBefore = stored.revision;
    stored.writeback = null;
    stored.writeback_lock = "crashed-token";
    stored.writeback_lock_at = new Date().toISOString();

    const input: UpsertInput = {
      key,
      source: "github-label",
      repo: "acme/widgets",
      repo_short: "widgets",
      number: 81,
      url: null,
      title: "Ship the schema",
      why: null,
      options: null,
      recommended: null,
      requested_by: null,
      kind: "issue",
      labels: ["decision"],
      opened_at: "2026-10-01T00:00:00.000Z",
      first_seen_at: "2026-10-01T00:00:00.000Z",
      github_present: true,
      force: true,
    };
    const blocked = await upsertDecision(input);
    assert.equal(blocked.writeback_in_progress, true);
    assert.equal(stored.status, "decided");
    assert.equal(stored.writeback_lock, "crashed-token");
    assert.equal(stored.revision, revisionBefore);
    assert.equal(stored.decision, "old answer");

    env.DATABASE_URL = "postgres://example.invalid/decisions";
    const { POST: postDecisions } = await import("../../src/app/api/decisions/route");
    const http = await postDecisions(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, source: "github-label", title: "Ship the schema", force: true }),
    }));
    assert.equal(http.status, 409, await http.clone().text());
    assert.equal((await http.json() as { code: string }).code, "writeback_in_progress");
    assert.equal(stored.writeback_lock, "crashed-token");
    assert.equal(stored.status, "decided");

    stored.writeback_lock_at = new Date(Date.now() - (WRITEBACK_LOCK_LEASE_SECONDS + 1) * 1000).toISOString();
    const opened = await upsertDecision(input);
    assert.equal(opened.writeback_in_progress, undefined);
    assert.equal(opened.decision.status, "open");
    assert.equal(opened.decision.writeback, null);
    assert.equal(stored.writeback_lock ?? null, null);
    assert.equal(stored.writeback_lock_at ?? null, null);
    assert.equal(stored.writeback ?? null, null);

    const github = new FakeGitHub();
    install(github);
    const again = await patch(row.id, {
      status: "decided",
      decision: "ship the new answer",
      expected_revision: opened.decision.revision,
    });
    assert.equal(again.status, 200, await again.clone().text());
    const body = await again.json() as { decision: Decision };
    assert.equal(body.decision.status, "decided");
    assert.equal(body.decision.writeback, "written");
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0].body, /ship the new answer/);
  });

  it("a claim that cannot be acquired stamps writeback not_written", async () => {
    const store = createMemoryDecisionStore();
    setDecisionStoreForTests(store);
    clearGitHubWriteClientForTests();
    const row = await seed({ key: "github:acme/widgets#82" });
    const decidedRes = await patch(row.id, {
      status: "decided",
      decision: "ship",
      expected_updated_at: row.updated_at,
    });
    assert.equal(decidedRes.status, 200, await decidedRes.clone().text());
    const decided = (await decidedRes.json() as { decision: Decision }).decision;
    assert.equal(decided.writeback, "not_written");
    const stored = store.rows.find((item) => item.id === row.id);
    assert.ok(stored);
    stored.writeback = null;
    stored.writeback_lock = "busy-token";
    stored.writeback_lock_at = new Date().toISOString();
    const revision = Number(stored.revision);
    setWritebackLockWaitForTests(30);
    const github = new FakeGitHub();
    install(github);
    const outcome = await writeDecisionBack({
      id: row.id,
      key: decided.key,
      actor_id: decided.actor_id,
      decided_at: decided.decided_at,
      decision: decided.decision,
      revision,
    });
    assert.equal(outcome.status, "not_written");
    assert.equal(stored.writeback, "not_written");
    assert.equal(stored.status, "decided");
    assert.equal(github.comments.length, 0);
    const parsed = parseListQuery(new URLSearchParams("status=decided&writeback=not_written"));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const pending = await listDecisions(parsed);
    assert.deepEqual(pending.map((item) => item.id), [row.id]);
  });
});
