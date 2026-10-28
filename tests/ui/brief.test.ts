import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GET } from "../../src/app/api/brief/route";
import {
  applyTableDecisions,
  assembleBrief,
  briefWantsJson,
  coordinatorFromDb,
  coordinatorStatus,
  formatBriefText,
  loadBrief,
  parseBriefQuery,
  repoSection,
  type BriefRepo,
  type BriefStuckPr,
  type MorningBrief,
} from "../../src/lib/brief";
import { partitionBrief, type BriefDecision, type Decision } from "../../src/lib/decisions";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { readBriefSettings } from "../../src/lib/progress-config";
import type { RepoSnapshot } from "../../src/lib/progress-types";
import { scopeForRoute, TOOL_SCOPES } from "../../src/lib/scopes";

/**
 * Failure cases for GET /api/brief. Each one tries to break the brief:
 * auth holes, a silent bad window, the wrong content type, an empty
 * database, a heartbeat that looks like work, two repos that share a
 * short name, a renamed MCP tool, and a join that drifts from the script.
 */

const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
};

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["NODE_ENV", saved.node],
    ["MC_DASHBOARD_PASSWORD", saved.password],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

beforeEach(() => {
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  env.NODE_ENV = "test";
  resetCredentialsForTests();
});

afterEach(() => {
  setSqlForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

function briefRequest(query = "", headers?: Record<string, string>): Request {
  return new Request(`http://localhost/api/brief${query}`, { headers });
}

async function bodyText(res: Response): Promise<string> {
  return await res.text();
}

function quotedVar(src: string, name: string): string {
  const marker = `${name}='`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const from = start + marker.length;
  const end = src.indexOf("'", from);
  assert.ok(end > from, `unterminated ${name}`);
  return src.slice(from, end);
}

function jq(program: string, args: string[]): unknown {
  const out = execFileSync("jq", ["-n", ...args, program], { encoding: "utf8" });
  return JSON.parse(out);
}

function decision(repo: string, number: number, age: number, title: string): BriefDecision {
  return {
    repo,
    repo_short: "app",
    number,
    title,
    url: `https://example.test/${repo}/issues/${number}`,
    kind: "issue",
    age_hours: age,
    age_days: Math.floor(age / 24),
    labels: ["needs-owner"],
  };
}

function stuck(short: string, number: number, age: number): BriefStuckPr {
  return {
    repo: short,
    number,
    title: `stuck ${number}`,
    url: `https://example.test/pull/${number}`,
    author: "ada",
    age_hours: age,
    age_days: Math.floor(age / 24),
    idle_days: 1,
    state: "CLEAN",
    review: null,
    reason: "open",
  };
}

function section(over: Partial<BriefRepo> & Pick<BriefRepo, "repo" | "short">): BriefRepo {
  return {
    label: over.short,
    incomplete: false,
    errors: [],
    merged_prs: 1,
    median_lead_hours: 2,
    issues_opened: 1,
    issues_closed: 1,
    net_backlog: 0,
    open_issues: 3,
    open_prs: 1,
    drafts: 0,
    stale_issues: 0,
    stale_ratio: 0,
    blocked_label: null,
    blocked_issues: null,
    stuck_prs: [],
    decisions: [],
    merged_list: [],
    ...over,
  };
}

describe("GET /api/brief", { concurrency: false }, () => {
  it("F1 denies the wrong caller and still matches the other read routes in dev-open", async () => {
    const sentinel = "example-org/app-server";

    env.MC_DASHBOARD_PASSWORD = "test-dashboard-password";
    const locked = await GET(briefRequest());
    assert.equal(locked.status, 401);
    const lockedBody = await bodyText(locked);
    assert.equal(JSON.parse(lockedBody).error, "unauthorized");
    assert.equal(lockedBody.includes("MORNING BRIEF"), false);
    assert.equal(lockedBody.includes(sentinel), false);

    const wrongBearer = await GET(briefRequest("", { authorization: "Bearer not-the-token" }));
    assert.equal(wrongBearer.status, 401);
    assert.equal((await bodyText(wrongBearer)).includes("MORNING BRIEF"), false);

    const badWindowWhileLocked = await GET(briefRequest("?window=1h"));
    assert.equal(badWindowWhileLocked.status, 401);

    delete env.MC_DASHBOARD_PASSWORD;
    const unknown = await GET(briefRequest("", { authorization: "Bearer akc_not-a-real-token" }));
    assert.equal(unknown.status, 401);
    const unknownBody = await bodyText(unknown);
    assert.equal(JSON.parse(unknownBody).error, "unauthorized");
    assert.equal(unknownBody.includes("MORNING BRIEF"), false);
    assert.equal(unknownBody.includes(sentinel), false);

    const tasksOnly = await createCredential({ label: "tasks only", scopes: ["tasks:read"] });
    assert.equal(tasksOnly.ok, true);
    if (!tasksOnly.ok) return;
    const wrongScope = await GET(briefRequest("", { authorization: `Bearer ${tasksOnly.token}` }));
    assert.equal(wrongScope.status, 403);
    const wrongBody = await bodyText(wrongScope);
    const wrongJson = JSON.parse(wrongBody);
    assert.equal(wrongJson.code, "insufficient_scope");
    assert.equal(wrongJson.retryable, false);
    assert.match(wrongJson.fix, /progress:read/);
    assert.equal(wrongBody.includes("MORNING BRIEF"), false);
    assert.equal(wrongBody.includes(sentinel), false);
    assert.equal(wrongBody.includes(tasksOnly.token), false);

    const open = await GET(briefRequest());
    assert.equal(open.status, 200);
    assert.match(await bodyText(open), /MORNING BRIEF/);

    const garbage = await GET(briefRequest("", { authorization: "Bearer not-a-token" }));
    assert.equal(garbage.status, 200);

    const reader = await createCredential({ label: "brief reader", scopes: ["progress:read"] });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const allowed = await GET(briefRequest("", { authorization: `Bearer ${reader.token}` }));
    assert.equal(allowed.status, 200);
    assert.match(await bodyText(allowed), new RegExp(sentinel));
  });

  it("F2 rejects a window that is not 24h or 72h", async () => {
    for (const query of ["?window=1h", "?window=", "?window[]=", "?window[]=24h", "?window[0]=24h", "?window=24H", "?window=72", "?window=%2024h", "?window=24h&window=72h"]) {
      const res = await GET(briefRequest(query));
      assert.equal(res.status, 400, query);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = await res.json();
      assert.equal(body.code, "validation_failed");
      assert.equal(body.error, "window must be 24h or 72h.");
      assert.equal(body.fields.window, "window must be 24h or 72h.");
      assert.equal(body.retryable, false);
      assert.equal(typeof body.fix, "string");
      assert.equal(JSON.stringify(body).includes("MORNING BRIEF"), false);
      assert.equal(body.stack, undefined);
    }

    const ok = await GET(briefRequest("?window=24h"));
    assert.equal(ok.status, 200);
    const extra = await GET(briefRequest("?window=72h&unread=1"));
    assert.equal(extra.status, 200);
    assert.equal(parseBriefQuery(new URLSearchParams("window=1h")).ok, false);
    assert.deepEqual(parseBriefQuery(new URLSearchParams("")), { ok: true, window: "24h", hours: 24 });
  });

  it("F3 negotiates text and JSON, and treats */* as text", async () => {
    const textCases = [
      undefined,
      "text/plain",
      "*/*",
      "application/json;q=0",
      "application/json;q=0.1, text/plain",
      "text/*;q=0.9, application/json;q=0.2",
    ];
    for (const accept of textCases) {
      const headers = accept ? { accept } : undefined;
      const res = await GET(briefRequest("", headers));
      assert.equal(res.status, 200, accept ?? "(omitted)");
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      const text = await bodyText(res);
      assert.match(text, /^MORNING BRIEF /);
      assert.equal(text.includes("undefined"), false);
    }

    for (const accept of ["application/json", "application/json, text/plain;q=0.1", "*/*;q=0.1, application/json"]) {
      const res = await GET(briefRequest("?window=72h", { accept }));
      assert.equal(res.status, 200, accept);
      assert.match(res.headers.get("content-type") ?? "", /application\/json/);
      const body = await res.json();
      assert.equal(body.window_hours, 72);
      assert.ok(Array.isArray(body.repos));
      assert.ok(Array.isArray(body.decisions));
      assert.equal(typeof body.coordinator, "object");
      assert.equal(body.demo, undefined);
    }

    assert.equal(briefWantsJson(null), false);
    assert.equal(briefWantsJson("*/*"), false);
    assert.equal(briefWantsJson("application/json"), true);
  });

  it("F4 renders an empty database without crashing or printing undefined", async () => {
    const res = await GET(briefRequest("", { accept: "application/json" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const encoded = JSON.stringify(body);
    assert.equal(encoded.includes("undefined"), false);
    assert.equal(body.repo_source, "config");
    assert.equal(body.coordinator.configured, false);
    assert.equal(body.coordinator.agent_id, null);
    assert.ok(Array.isArray(body.repos));
    assert.ok(body.repos.length > 0);
    assert.deepEqual(body.decisions, []);
    assert.deepEqual(body.stuck_prs, []);
    assert.ok(body.incomplete_repos.length > 0);
    for (const repo of body.repos) {
      assert.equal(repo.incomplete, true);
      assert.deepEqual(repo.errors, ["no snapshot"]);
      assert.equal(repo.merged_prs, null);
      assert.equal(repo.decisions, null);
    }
    assert.equal(body.totals.merged_prs, null);
    assert.equal(body.totals.repos_counted, 0);
    assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const text = await bodyText(await GET(briefRequest()));
    assert.match(text, /DATA INCOMPLETE/);
    assert.equal(text.includes("undefined"), false);
    assert.equal(/\bnull\b/.test(text), false);
    assert.equal(text.includes("COORDINATOR"), false);
    assert.match(text, /DECISIONS FOR YOU: DATA INCOMPLETE\./);
    assert.equal(text.includes("DECISIONS FOR YOU: none open."), false);
    assert.ok(text.endsWith("\n"));

    const empty = formatBriefText(assembleBrief({
      generatedAt: "2026-10-27T12:00:00Z",
      windowHours: 24,
      repoSource: "config",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [],
    }), { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: [] });
    assert.match(empty, /MORNING BRIEF — Mon 2026-10-27 08:00 EDT — last 24h {2}\(repos from config\)/);
    assert.match(empty, /0 PRs merged, 0 issues closed, 0 opened — the queue held level\./);
    assert.match(empty, /not tracked \(set brief\.decisionLabels/);
    // An unmeasured decisions total stays DATA INCOMPLETE even with no labels configured.
    const unmeasuredBrief = assembleBrief({
      generatedAt: "2026-10-27T12:00:00Z",
      windowHours: 24,
      repoSource: "config",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [],
    });
    unmeasuredBrief.totals.decisions = null;
    const unmeasured = formatBriefText(unmeasuredBrief, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: [] });
    assert.match(unmeasured, /DECISIONS FOR YOU: DATA INCOMPLETE\./);
    assert.equal(/not tracked/.test(unmeasured), false);
    assert.equal(empty.includes("undefined"), false);

    const missing = repoSection({
      cfg: { repo: "acme/app", label: "Acme", short: "app", blockedLabel: null },
      snap: null,
      baseline: null,
      windowHours: 24,
      nowIso: "2026-10-27T12:00:00Z",
    });
    assert.equal(missing.incomplete, true);
    assert.notEqual(missing.merged_prs, 0);
  });

  it("F5 does not call a heartbeat-only coordinator working", () => {
    const now = "2026-10-27T12:00:00Z";
    const kinds = ["session_end", "milestone", "status"] as const;
    const base = {
      agentId: "hermes-carmack",
      maxSilenceHours: 3,
      workKinds: kinds,
      nowIso: now,
      reachable: true,
    };
    const heartbeat = coordinatorStatus({
      ...base,
      agent: { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" },
      events: [
        { kind: "telemetry", created_at: "2026-10-27T11:59:50Z" },
        { kind: "heartbeat", created_at: "2026-10-27T11:59:40Z" },
      ],
    });
    assert.match(heartbeat.verdict ?? "", /^NOT WORKING: no work event/);
    assert.match(heartbeat.verdict ?? "", /only telemetry/);
    assert.ok((heartbeat.last_seen_hours ?? 99) < 0.1);
    assert.equal(heartbeat.verdict?.startsWith("working"), false);

    const text = formatBriefText(assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: heartbeat,
      repos: [],
    }), { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.match(text, /COORDINATOR {2}\[!!\] hermes-carmack — NOT WORKING/);
    assert.match(text, /telemetry seen 0h ago/);
    assert.equal(text.includes("[ok]"), false);

    const disguised = coordinatorStatus({
      ...base,
      agent: { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" },
      events: [{ kind: "status_update", created_at: "2026-10-27T11:50:00Z" }],
    });
    assert.match(disguised.verdict ?? "", /^NOT WORKING/);
    assert.equal(disguised.last_work_kind, null);

    const staleWork = coordinatorStatus({
      ...base,
      agent: { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" },
      events: [{ kind: "session_end", created_at: "2026-10-27T02:00:00Z" }],
    });
    assert.equal(staleWork.verdict, "NOT WORKING: last work event 10h ago (limit 3h)");

    const failing = coordinatorStatus({
      ...base,
      agent: { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" },
      events: [
        { kind: "turn_start", created_at: "2026-10-27T11:00:00Z" },
        { kind: "error", created_at: "2026-10-27T11:30:00Z" },
      ],
    });
    assert.match(failing.verdict ?? "", /^FAILING: 1 error event/);

    const missing = coordinatorStatus({
      ...base,
      agent: null,
      events: [{ kind: "session_end", created_at: "2026-10-27T11:00:00Z" }],
    });
    assert.equal(missing.verdict, "unknown: agent not registered");
    assert.equal(missing.found, false);

    const working = coordinatorStatus({
      ...base,
      agent: { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" },
      events: [{ kind: "milestone", created_at: "2026-10-27T11:30:00Z" }],
    });
    assert.equal(working.verdict, "working: last work event 0.5h ago");

    const unconfigured = coordinatorStatus({
      ...base,
      agentId: null,
      agent: { id: "ignored", last_seen_at: now },
      events: [{ kind: "session_end", created_at: now }],
    });
    assert.deepEqual(unconfigured, { configured: false, agent_id: null });
    const quiet = formatBriefText(assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "config",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: unconfigured,
      repos: [],
    }), { clock: "Mon 2026-10-27 08:00 EDT" });
    assert.equal(quiet.includes("COORDINATOR"), false);
  });

  it("F6 keeps two repos that share a short name in distinct sections", () => {
    const acme = section({
      repo: "acme/app",
      short: "app",
      label: "Acme",
      stuck_prs: [stuck("app", 11, 10)],
    });
    const other = section({
      repo: "other/app",
      short: "app",
      label: "Other",
      stuck_prs: [stuck("app", 22, 80)],
    });
    const table = [
      decision("acme/app", 1, 10, "acme only"),
      decision("other/app", 2, 20, "other only"),
      decision("app", 3, 30, "short name is not a join key"),
    ];
    const joined = applyTableDecisions([other, acme], table, []);
    assert.deepEqual(joined.map((repo) => repo.repo), ["other/app", "acme/app"]);
    assert.deepEqual(joined[0].decisions?.map((row) => row.number), [2]);
    assert.deepEqual(joined[1].decisions?.map((row) => row.number), [1]);
    assert.equal(joined[0].label, "Other");
    assert.equal(joined[1].label, "Acme");

    const brief = assembleBrief({
      generatedAt: "2026-10-27T12:00:00Z",
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: joined,
    });
    assert.deepEqual(brief.decisions.map((row) => row.repo), ["other/app", "acme/app"]);
    assert.deepEqual(brief.stuck_prs.map((row) => [row.repo, row.number]), [["app", 22], ["app", 11]]);
    const text = formatBriefText(brief, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.ok(text.indexOf("other only") < text.indexOf("acme only"));
    assert.ok(text.indexOf("Other") < text.indexOf("Acme"));
    assert.equal(text.includes("#3"), false);
  });

  it("F7 keeps the existing MCP tools and marks get_morning_brief read-only", () => {
    const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const registered = [...src.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(registered, [
      "report_status",
      "get_fleet_status",
      "get_progress_digest",
      "get_morning_brief",
      "remember",
      "recall",
      "check_inbox",
      "create_task",
      "get_task_queue",
      "claim_task",
      "update_task",
      "list_skills",
      "get_skill",
      "run_skill",
      "request_decision",
      "list_decisions",
      "resolve_decision",
    ]);
    assert.equal(registered.filter((name) => name === "get_morning_brief").length, 1);
    assert.equal([...src.matchAll(/name: "reply_to_mark"/g)].length, 1);
    assert.equal([...src.matchAll(/name: "reply_to_operator"/g)].length, 1);

    const block = src.slice(src.indexOf('"get_morning_brief"'), src.indexOf('"remember"'));
    assert.match(block, /title: "Get morning brief",\n\s+annotations: READ_ONLY,/);

    assert.equal(TOOL_SCOPES.get_morning_brief, "progress:read");
    assert.equal(TOOL_SCOPES.get_progress_digest, "progress:read");
    assert.equal(TOOL_SCOPES.report_status, "status:write");
    assert.equal(TOOL_SCOPES.get_fleet_status, "fleet:read");
    assert.equal(TOOL_SCOPES.remember, "memory:write");
    assert.equal(TOOL_SCOPES.recall, "memory:read");
    assert.equal(TOOL_SCOPES.check_inbox, "messages:read");
    assert.equal(TOOL_SCOPES.reply_to_operator, "messages:write");
    assert.equal(TOOL_SCOPES.reply_to_mark, "messages:write");
    assert.equal(TOOL_SCOPES.create_task, "tasks:write");
    assert.equal(TOOL_SCOPES.get_task_queue, "tasks:read");
    assert.equal(TOOL_SCOPES.claim_task, "tasks:write");
    assert.equal(TOOL_SCOPES.update_task, "tasks:write");
    assert.equal(TOOL_SCOPES.list_skills, "skills:read");
    assert.equal(TOOL_SCOPES.get_skill, "skills:read");
    assert.equal(TOOL_SCOPES.run_skill, "skills:write");
    assert.equal(scopeForRoute("GET", "/api/brief"), "progress:read");
    assert.equal(scopeForRoute("POST", "/api/brief"), null);
    assert.equal(scopeForRoute("GET", "/api/progress"), "progress:read");
  });

  it("F8 matches morning-brief.sh on decisions and repo sections", () => {
    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    execFileSync("bash", ["-n", "scripts/morning-brief.sh"]);
    const join = quotedVar(script, "TABLE_DECISIONS_JQ");
    const assemble = quotedVar(script, "BRIEF_ASSEMBLE_JQ");

    const other = section({
      repo: "other/app",
      short: "app",
      label: "Other",
      stuck_prs: [stuck("app", 22, 30)],
      merged_prs: 2,
      issues_opened: 4,
      issues_closed: 1,
      net_backlog: 3,
    });
    const acme = section({
      repo: "acme/app",
      short: "app",
      label: "Acme",
      stuck_prs: [stuck("app", 11, 100)],
      merged_prs: 0,
      issues_opened: 0,
      issues_closed: 5,
      net_backlog: -5,
    });
    const held = section({
      repo: "held/app",
      short: "app",
      label: "Held",
      decisions: [decision("held/app", 9, 50, "github sweep")],
      stuck_prs: [stuck("app", 33, 5)],
    });
    const incomplete = section({
      repo: "nope/app",
      short: "app",
      label: "Nope",
      incomplete: true,
      errors: ["no snapshot"],
      merged_prs: 100,
      median_lead_hours: null,
      issues_opened: 100,
      issues_closed: 100,
      net_backlog: 0,
      open_issues: null,
      open_prs: null,
      drafts: null,
      stale_issues: null,
      stale_ratio: null,
      blocked_issues: null,
      stuck_prs: [stuck("app", 99, 900)],
      decisions: [decision("nope/app", 99, 900, "must not leak")],
      merged_list: null,
    });
    const repos = [other, acme, held, incomplete];
    const table = [
      decision("other/app", 2, 40, "other only"),
      decision("acme/app", 1, 40, "acme only"),
      decision("held/app", 8, 80, "table must not replace the sweep"),
      decision("nope/app", 99, 900, "must not leak"),
    ];
    const incompleteRepos = ["held/app"];

    const joined = applyTableDecisions(repos, table, incompleteRepos);
    const fromJq = jq(`$repos | ${join}`, [
      "--argjson", "repos", JSON.stringify(repos),
      "--argjson", "table", JSON.stringify(table),
      "--argjson", "incomplete", JSON.stringify(incompleteRepos),
    ]) as BriefRepo[];
    assert.deepEqual(JSON.parse(JSON.stringify(joined)), fromJq);
    assert.deepEqual(fromJq.find((repo) => repo.repo === "acme/app")?.decisions?.map((row) => row.number), [1]);
    assert.deepEqual(fromJq.find((repo) => repo.repo === "other/app")?.decisions?.map((row) => row.number), [2]);
    assert.deepEqual(fromJq.find((repo) => repo.repo === "held/app")?.decisions?.map((row) => row.number), [9]);
    assert.deepEqual(fromJq.find((repo) => repo.repo === "nope/app")?.decisions?.map((row) => row.number), [99]);

    const coordinator = { configured: false, agent_id: null };
    const tsBrief = assembleBrief({
      generatedAt: "2026-10-27T12:00:00Z",
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator,
      repos: joined,
    });
    const jqBrief = jq(assemble, [
      "--arg", "at", "2026-10-27T12:00:00Z",
      "--argjson", "window", "24",
      "--arg", "repo_source", "dashboard",
      "--argjson", "repos", JSON.stringify(joined),
      "--argjson", "coordinator", JSON.stringify(coordinator),
      "--argjson", "stuck_h", "48",
      "--argjson", "stale_d", "21",
    ]) as MorningBrief;
    assert.deepEqual(JSON.parse(JSON.stringify(tsBrief.repos)), jqBrief.repos);
    assert.deepEqual(JSON.parse(JSON.stringify(tsBrief.decisions)), jqBrief.decisions);
    assert.deepEqual(JSON.parse(JSON.stringify(tsBrief.stuck_prs)), jqBrief.stuck_prs);
    assert.deepEqual(JSON.parse(JSON.stringify(tsBrief.totals)), jqBrief.totals);
    assert.deepEqual(tsBrief.decisions.map((row) => row.number), [9, 2, 1]);
    assert.deepEqual(tsBrief.stuck_prs.map((row) => row.number), [11, 22, 33]);
    assert.equal(tsBrief.decisions.some((row) => row.number === 99), false);
    assert.equal(tsBrief.stuck_prs.some((row) => row.number === 99), false);
    assert.equal(tsBrief.totals.merged_prs, null);
    assert.equal(tsBrief.totals.stuck_prs, null);
    assert.equal(tsBrief.totals.decisions, null);
    assert.equal(tsBrief.totals.open_issues, null);
    assert.equal(tsBrief.totals.repos_counted, 3);

    const text = formatBriefText(tsBrief, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.ok(text.indexOf("#11") < text.indexOf("#22"));
    assert.ok(text.indexOf("github sweep") < text.indexOf("other only"));
    assert.equal(text.includes("must not leak"), false);
    assert.equal(text.includes("undefined"), false);
  });

  it("does not reuse a 24h median for a 72h window, and an empty snapshot stays incomplete", () => {
    const now = "2026-10-27T12:00:00Z";
    const detail = {
      median_lead_hours: 99,
      merged_list: [{ number: 1, title: "stored", url: "https://example.test/1", author: "a", lead_hours: 99 }],
      merged: [{
        number: 7,
        title: "older",
        url: "https://example.test/7",
        author: "a",
        created_at: "2026-10-24T12:00:00Z",
        merged_at: "2026-10-25T12:00:00Z",
      }],
    };
    const snap: RepoSnapshot = {
      repo: "acme/app",
      label: "Acme",
      collected_at: now,
      kind: "tick",
      open_issues: 2,
      open_prs: 0,
      blocked_issues: 4,
      merged_prs_24h: 1,
      issues_closed_24h: 1,
      issues_opened_24h: 1,
      total_issues_created: 10,
      total_issues_closed: 8,
      total_prs_merged: 4,
      review_rounds: null,
      no_verdict_rate: null,
      detail,
    };
    const cfg = { repo: "acme/app", label: "Acme", short: "app", blockedLabel: null };
    const day = repoSection({ cfg, snap, baseline: null, windowHours: 24, nowIso: now });
    assert.equal(day.median_lead_hours, null);
    assert.deepEqual(day.merged_list, []);
    assert.equal(day.merged_prs, 1);
    assert.equal(day.blocked_issues, null);

    const weekend = repoSection({ cfg, snap, baseline: null, windowHours: 72, nowIso: now });
    assert.equal(weekend.median_lead_hours, 24);
    assert.equal(weekend.merged_list?.[0]?.number, 7);
    assert.notEqual(weekend.median_lead_hours, 99);

    const bare = repoSection({
      cfg,
      snap: { ...snap, detail: { lane_mix: { grok: 1 } } },
      baseline: null,
      windowHours: 24,
      nowIso: now,
    });
    assert.equal(bare.incomplete, false);
    assert.equal(bare.stuck_prs, null);
    assert.equal(bare.median_lead_hours, null);
    assert.equal(bare.stale_issues, null);
    const rendered = formatBriefText(assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [bare],
    }), { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.equal(rendered.includes("undefined"), false);
    assert.equal(rendered.includes("STUCK PRs: none."), false);
    assert.match(rendered, /STUCK PRs: DATA INCOMPLETE\./);
  });

  it("collector brief jq keeps a stuck PR and drops a young one", () => {
    execFileSync("bash", ["-n", "scripts/collect-progress.sh"]);
    const src = fs.readFileSync("scripts/collect-progress.sh", "utf8");
    assert.match(src, /brief_metrics\(\) \{/);
    assert.match(src, /brief metrics unavailable/);
    const program = quotedVar(src, "BRIEF_METRICS_JQ");
    const now = "2026-10-27T12:00:00Z";
    const out = jq(program, [
      "--arg", "short", "app",
      "--arg", "now", now,
      "--arg", "stale_before", "2026-10-06T12:00:00Z",
      "--argjson", "stuck_h", "48",
      "--argjson", "issues", JSON.stringify([
        { number: 1, updatedAt: "2026-09-01T00:00:00Z" },
        { number: 2, updatedAt: "2026-10-20T00:00:00Z" },
      ]),
      "--argjson", "prs", JSON.stringify([
        {
          number: 10,
          title: "old",
          url: "https://example.test/10",
          createdAt: "2026-10-23T08:00:00Z",
          updatedAt: "2026-10-23T08:00:00Z",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          statusCheckRollup: [],
          author: { login: "ada" },
        },
        {
          number: 11,
          title: "young",
          url: "https://example.test/11",
          createdAt: "2026-10-27T11:00:00Z",
          updatedAt: "2026-10-27T11:00:00Z",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          statusCheckRollup: [],
          author: { login: "ada" },
        },
      ]),
      "--argjson", "merged", JSON.stringify([
        {
          number: 3,
          title: "landed",
          url: "https://example.test/3",
          createdAt: "2026-10-27T08:00:00Z",
          mergedAt: "2026-10-27T10:00:00Z",
          author: { login: "ada" },
        },
      ]),
    ]) as { stuck_prs: { number: number }[]; stale_issues: number; median_lead_hours: number; drafts: number; merged: { merged_at: string }[] };
    assert.deepEqual(out.stuck_prs.map((row) => row.number), [10]);
    assert.equal(out.stale_issues, 1);
    assert.equal(out.drafts, 0);
    assert.equal(out.median_lead_hours, 2);
    assert.equal(out.merged[0].merged_at, "2026-10-27T10:00:00Z");
  });

  it("keeps a newer partial snapshot instead of an older complete row", async () => {
    const now = new Date("2026-10-27T15:00:00Z");
    const repo = "example-org/app-server";
    const older = snapshotRow({
      repo,
      label: "App Server",
      collected_at: "2026-10-26T12:00:00.000Z",
      open_issues: 9,
      open_prs: 3,
      merged_prs_24h: 4,
      issues_opened_24h: 2,
      issues_closed_24h: 1,
      total_issues_created: 20,
      total_issues_closed: 11,
      total_prs_merged: 7,
    });
    const newer = snapshotRow({
      repo,
      label: "App Server",
      collected_at: "2026-10-27T14:00:00.000Z",
      open_issues: null,
      open_prs: null,
      blocked_issues: null,
      merged_prs_24h: null,
      issues_opened_24h: null,
      issues_closed_24h: null,
      total_issues_created: null,
      total_issues_closed: null,
      total_prs_merged: null,
    });
    installSnapshotSql([older, newer]);

    for (const window of ["24h", "72h"] as const) {
      const brief = await loadBrief(window, now);
      const section = brief.repos.find((row) => row.repo === repo);
      assert.equal(brief.generated_at, "2026-10-27T15:00:00Z", window);
      assert.equal(section?.incomplete, true, window);
      assert.deepEqual(section?.errors, ["counts not measured"], window);
      assert.equal(section?.open_issues, null, window);
      assert.equal(section?.open_prs, null, window);
      assert.equal(section?.merged_prs, null, window);
      assert.equal(brief.totals.repos_counted, 0, window);
      assert.equal(brief.totals.merged_prs, null, window);
      assert.equal(brief.incomplete_repos.some((row) => row.repo === repo), true, window);
      const text = formatBriefText(brief, {
        clock: "Tue 2026-10-27 11:00 EDT",
        decisionLabels: ["needs-owner"],
      });
      assert.match(text, /DATA INCOMPLETE/);
      assert.match(text, new RegExp(`${repo}: counts not measured`));
      assert.equal(text.includes("undefined"), false);
    }
  });

  it("keeps the 72h baseline on the newest row at the cutoff when that row has null open_issues", async () => {
    const now = new Date("2026-10-27T15:00:00Z");
    const repo = "example-org/web-studio";
    const cutoff = "2026-10-24T15:00:00.000Z";
    installSnapshotSql([
      snapshotRow({
        repo,
        label: "Web Studio",
        collected_at: "2026-10-23T15:00:00.000Z",
        open_issues: 1,
        open_prs: 1,
        total_issues_created: 0,
        total_issues_closed: 0,
        total_prs_merged: 1,
      }),
      snapshotRow({
        repo,
        label: "Web Studio",
        collected_at: cutoff,
        open_issues: null,
        open_prs: null,
        merged_prs_24h: null,
        issues_opened_24h: null,
        issues_closed_24h: null,
        total_issues_created: 10,
        total_issues_closed: 6,
        total_prs_merged: 4,
      }),
      snapshotRow({
        repo,
        label: "Web Studio",
        collected_at: "2026-10-27T15:00:00.000Z",
        open_issues: 5,
        open_prs: 2,
        merged_prs_24h: 1,
        issues_opened_24h: 1,
        issues_closed_24h: 1,
        total_issues_created: 12,
        total_issues_closed: 8,
        total_prs_merged: 10,
      }),
    ]);

    const brief = await loadBrief("72h", now);
    const section = brief.repos.find((row) => row.repo === repo);
    assert.equal(section?.incomplete, false);
    assert.equal(section?.merged_prs, 6);
    assert.equal(section?.issues_opened, 2);
    assert.equal(section?.issues_closed, 2);
    assert.equal(brief.totals.repos_counted, 1);
  });

  it("marks a snapshot incomplete when open_prs was not measured", () => {
    const now = "2026-10-27T12:00:00Z";
    const cfg = { repo: "acme/app", label: "Acme", short: "app", blockedLabel: "blocked" };
    const snap: RepoSnapshot = {
      repo: "acme/app",
      label: "Acme",
      collected_at: now,
      kind: "tick",
      open_issues: 5,
      open_prs: null,
      blocked_issues: 1,
      merged_prs_24h: 2,
      issues_closed_24h: 3,
      issues_opened_24h: 4,
      total_issues_created: 12,
      total_issues_closed: 8,
      total_prs_merged: 6,
      review_rounds: null,
      no_verdict_rate: null,
      detail: null,
    };
    const baseline: RepoSnapshot = {
      ...snap,
      open_issues: 1,
      open_prs: 1,
      total_issues_created: 1,
      total_issues_closed: 1,
      total_prs_merged: 1,
    };
    const day = repoSection({ cfg, snap, baseline: null, windowHours: 24, nowIso: now });
    assert.equal(day.incomplete, true);
    assert.deepEqual(day.errors, ["counts not measured"]);
    assert.equal(day.open_prs, null);
    assert.equal(day.open_issues, null);
    assert.equal(day.merged_prs, null);

    const weekend = repoSection({ cfg, snap, baseline, windowHours: 72, nowIso: now });
    assert.equal(weekend.incomplete, true);
    assert.deepEqual(weekend.errors, ["counts not measured"]);

    const brief = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [day],
    });
    assert.equal(brief.totals.repos_counted, 0);
    assert.equal(brief.totals.merged_prs, null);
    assert.equal(brief.totals.issues_opened, null);
    assert.deepEqual(brief.incomplete_repos, [{ repo: "acme/app", errors: ["counts not measured"] }]);
    const text = formatBriefText(brief, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.match(text, /DATA INCOMPLETE for 1 of 1 repos/);
    assert.match(text, /acme\/app: counts not measured/);
    assert.match(text, /!! Acme/);
    assert.equal(text.includes("undefined"), false);
  });

  it("stays on text when JSON and text/plain tie, and uses the highest quality of a repeated type", async () => {
    assert.equal(briefWantsJson("text/plain;q=0.5, application/json;q=0.5"), false);
    assert.equal(briefWantsJson("application/json;q=0.5, text/plain;q=0.5"), false);
    assert.equal(briefWantsJson("application/json;q=0.9, application/json;q=0.2, text/plain;q=0.5"), true);
    assert.equal(briefWantsJson("application/json;q=0.2, application/json;q=0.9, text/plain;q=0.5"), true);
    assert.equal(briefWantsJson("text/plain;q=0.2, text/plain;q=0.8, application/json;q=0.5"), false);
    assert.equal(briefWantsJson("application/json;q=0.6, text/plain;q=0.5"), true);
    assert.equal(briefWantsJson("application/json;q=2, text/plain"), false);

    const equal = await GET(briefRequest("", { accept: "text/plain;q=0.5, application/json;q=0.5" }));
    assert.equal(equal.status, 200);
    assert.equal(equal.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(await bodyText(equal), /^MORNING BRIEF /);

    const repeated = await GET(briefRequest("", {
      accept: "application/json;q=0.9, application/json;q=0.2, text/plain;q=0.5",
    }));
    assert.equal(repeated.status, 200);
    assert.match(repeated.headers.get("content-type") ?? "", /application\/json/);
    const body = await repeated.json();
    assert.equal(body.window_hours, 24);
    assert.equal(body.demo, undefined);
  });

  it("absent stuck_prs is unmeasured, and an empty array is none", () => {
    const now = "2026-10-27T12:00:00Z";
    const cfg = { repo: "acme/app", label: "Acme", short: "app", blockedLabel: null };
    const snap: RepoSnapshot = {
      repo: "acme/app",
      label: "Acme",
      collected_at: now,
      kind: "tick",
      open_issues: 2,
      open_prs: 0,
      blocked_issues: 0,
      merged_prs_24h: 1,
      issues_closed_24h: 1,
      issues_opened_24h: 1,
      total_issues_created: 10,
      total_issues_closed: 8,
      total_prs_merged: 4,
      review_rounds: null,
      no_verdict_rate: null,
      detail: { lane_mix: { grok: 1 } },
    };
    const bare = repoSection({ cfg, snap, baseline: null, windowHours: 24, nowIso: now });
    assert.equal(bare.incomplete, false);
    assert.equal(bare.stuck_prs, null);
    assert.equal(bare.merged_prs, 1);
    const omitted = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [bare],
    });
    assert.equal(omitted.totals.stuck_prs, null);
    assert.deepEqual(omitted.stuck_prs, []);
    const rendered = formatBriefText(omitted, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.equal(rendered.includes("STUCK PRs: none."), false);
    assert.match(rendered, /STUCK PRs: DATA INCOMPLETE\./);
    const row = rendered.split("\n").find((line) => line.startsWith("Acme"));
    assert.ok(row);
    assert.equal(row.trimEnd().split(/\s+/)[6], "-");

    const measuredEmpty = repoSection({
      cfg,
      snap: { ...snap, detail: { stuck_prs: [] } },
      baseline: null,
      windowHours: 24,
      nowIso: now,
    });
    assert.deepEqual(measuredEmpty.stuck_prs, []);
    const emptyBrief = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [measuredEmpty],
    });
    assert.equal(emptyBrief.totals.stuck_prs, 0);
    const emptyText = formatBriefText(emptyBrief, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.match(emptyText, /STUCK PRs: none\./);
    const emptyRow = emptyText.split("\n").find((line) => line.startsWith("Acme"));
    assert.equal(emptyRow?.trimEnd().split(/\s+/)[6], "0");

    const mixed = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [
        section({ repo: "acme/app", short: "app", label: "Acme", stuck_prs: [stuck("app", 11, 10)] }),
        section({ repo: "other/app", short: "other", label: "Other", stuck_prs: null }),
      ],
    });
    assert.equal(mixed.totals.stuck_prs, null);
    assert.deepEqual(mixed.stuck_prs.map((row) => row.number), [11]);
    const mixedText = formatBriefText(mixed, { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] });
    assert.equal(mixedText.includes("STUCK PRs: none."), false);
    assert.match(mixedText, /STUCK PRs: DATA INCOMPLETE\./);
    assert.match(mixedText, /#11/);
  });

  it("configured heartbeat, telemetry, turn_start, and status_update never count as work", () => {
    const now = "2026-10-27T12:00:00Z";
    const base = {
      agentId: "hermes-carmack",
      maxSilenceHours: 3,
      nowIso: now,
      reachable: true,
      agent: { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" },
    };
    for (const kind of ["heartbeat", "telemetry", "turn_start", "status_update"] as const) {
      const status = coordinatorStatus({
        ...base,
        workKinds: [kind],
        events: [{ kind, created_at: "2026-10-27T11:50:00Z" }],
      });
      assert.equal(status.verdict?.startsWith("working"), false, kind);
      assert.match(status.verdict ?? "", /^NOT WORKING/, kind);
      assert.equal(status.last_work_kind, null, kind);
    }

    const heartbeatBesideWork = coordinatorStatus({
      ...base,
      workKinds: ["heartbeat", "milestone"],
      events: [{ kind: "heartbeat", created_at: "2026-10-27T11:50:00Z" }],
    });
    assert.match(heartbeatBesideWork.verdict ?? "", /^NOT WORKING/);

    const realWork = coordinatorStatus({
      ...base,
      workKinds: ["telemetry", "milestone"],
      events: [{ kind: "milestone", created_at: "2026-10-27T11:30:00Z" }],
    });
    assert.equal(realWork.verdict, "working: last work event 0.5h ago");

    const onlyNoise = readBriefSettings({ brief: { coordinator: { workKinds: ["heartbeat"] } } });
    assert.deepEqual(onlyNoise.coordinator.workKinds, ["session_end", "milestone", "status"]);
    const mixedKinds = readBriefSettings({ brief: { coordinator: { workKinds: ["heartbeat", "milestone", "status_update"] } } });
    assert.deepEqual(mixedKinds.coordinator.workKinds, ["milestone"]);
    const piped = readBriefSettings({ brief: { coordinator: { workKinds: "telemetry|turn_start|session_end" } } });
    assert.deepEqual(piped.coordinator.workKinds, ["session_end"]);
    const custom = readBriefSettings({ brief: { coordinator: { workKinds: ["custom_work", "heartbeat"] } } });
    assert.deepEqual(custom.coordinator.workKinds, ["custom_work"]);

    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const start = script.indexOf("filter_work_kinds() {");
    const end = script.indexOf("# end filter_work_kinds");
    assert.ok(start >= 0 && end > start);
    const fn = script.slice(start, end);
    const filtered = execFileSync("bash", ["-c", `${fn}\nfilter_work_kinds "heartbeat|milestone|telemetry|turn_start|status_update"`], { encoding: "utf8" });
    assert.equal(filtered, "milestone");
  });

  it("wildcard Accept quality counts as text when text/plain is not listed", async () => {
    assert.equal(briefWantsJson("application/json;q=0.5, */*;q=1"), false);
    assert.equal(briefWantsJson("application/json;q=0.5, */*;q=0.5"), false);
    assert.equal(briefWantsJson("application/json;q=0.4, */*;q=0.2, */*;q=0.9"), false);
    assert.equal(briefWantsJson("application/json;q=0.9, */*;q=0.1"), true);
    assert.equal(briefWantsJson("application/json;q=0.8, text/*;q=0.3, */*;q=0.9"), true);
    assert.equal(briefWantsJson("application/json;q=0.4, text/plain;q=0.2, */*;q=0.9"), true);
    assert.equal(briefWantsJson("application/json, */*"), false);

    const higherWildcard = await GET(briefRequest("", { accept: "application/json;q=0.5, */*;q=1" }));
    assert.equal(higherWildcard.status, 200);
    assert.equal(higherWildcard.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(await bodyText(higherWildcard), /^MORNING BRIEF /);

    const equalWildcard = await GET(briefRequest("", { accept: "application/json;q=0.5, */*;q=0.5" }));
    assert.equal(equalWildcard.status, 200);
    assert.equal(equalWildcard.headers.get("content-type"), "text/plain; charset=utf-8");
  });

  it("sends Vary Accept on both brief representations", async () => {
    const text = await GET(briefRequest());
    assert.equal(text.status, 200);
    assert.equal(text.headers.get("vary"), "Accept");
    assert.match(text.headers.get("cache-control") ?? "", /s-maxage=60/);
    assert.match(text.headers.get("content-type") ?? "", /text\/plain/);

    const json = await GET(briefRequest("", { accept: "application/json" }));
    assert.equal(json.status, 200);
    assert.equal(json.headers.get("vary"), "Accept");
    assert.match(json.headers.get("cache-control") ?? "", /s-maxage=60/);
    assert.match(json.headers.get("content-type") ?? "", /application\/json/);
  });

  it("a burst of non-work events does not hide a work event inside the silence window", async () => {
    const now = "2026-10-27T12:00:00Z";
    const nowMs = Date.parse(now);
    const at = (secondsAgo: number) => new Date(nowMs - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const agentId = "hermes-carmack";
    let events: Row[] = [];
    env.DATABASE_URL = "postgres://brief:brief@127.0.0.1:9/brief_test";
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ");
      if (text.includes("from agents")) {
        return [{ id: agentId, last_seen_at: "2026-10-27T11:59:00Z" }];
      }
      if (text.includes("from events")) return applyEventQuery(strings, values, events);
      throw new Error(`unexpected sql: ${text}`);
    });
    const settings = readBriefSettings({
      brief: { coordinator: { agentId, maxSilenceHours: 3, workKinds: ["session_end", "milestone", "status"] } },
    });

    // 201 turn_start rows are newer than a milestone that is still inside 3h.
    // An error sits in that same burst. The milestone has to win.
    const noise = Array.from({ length: 201 }, (_, i) => ({
      id: i + 1,
      agent_id: agentId,
      kind: "turn_start",
      created_at: at(30 + i * 10),
    }));
    events = [
      ...noise,
      { id: 900, agent_id: agentId, kind: "error", created_at: at(20) },
      { id: 901, agent_id: agentId, kind: "milestone", created_at: at(2 * 3600) },
      { id: 902, agent_id: agentId, kind: "status_update", created_at: at(15) },
    ];
    const buried = await coordinatorFromDb(settings, now);
    assert.equal(buried.verdict, "working: last work event 2h ago");
    assert.equal(buried.last_work_kind, "milestone");
    assert.equal(buried.recent_errors, 1);

    // The newest work event is older than the window, and newer noise would
    // fill a 200-row cap. The age still has to come from that work event.
    events = [
      ...noise,
      { id: 903, agent_id: agentId, kind: "session_end", created_at: at(11 * 3600) },
    ];
    const stale = await coordinatorFromDb(settings, now);
    assert.equal(stale.verdict, "NOT WORKING: last work event 11h ago (limit 3h)");
    assert.equal(stale.last_work_kind, "session_end");

    events = Array.from({ length: 201 }, (_, i) => ({
      id: i + 1,
      agent_id: agentId,
      kind: "error",
      created_at: at(10 + i),
    }));
    const manyErrors = await coordinatorFromDb(settings, now);
    assert.equal(manyErrors.verdict, "FAILING: 201 error event(s) in the last 3h and no completed work");
    assert.equal(manyErrors.recent_errors, 201);

    const custom = readBriefSettings({
      brief: { coordinator: { agentId, maxSilenceHours: 3, workKinds: ["custom_work", "heartbeat"] } },
    });
    events = [
      ...noise.map((row) => ({ ...row, kind: "status_update" })),
      { id: 904, agent_id: agentId, kind: "custom_work", created_at: at(2 * 3600) },
    ];
    const configured = await coordinatorFromDb(custom, now);
    assert.equal(configured.verdict, "working: last work event 2h ago");
    assert.equal(configured.last_work_kind, "custom_work");
  });

  it("collector merged_list is the 24h window and merged keeps 72h", () => {
    execFileSync("bash", ["-n", "scripts/collect-progress.sh"]);
    const program = quotedVar(fs.readFileSync("scripts/collect-progress.sh", "utf8"), "BRIEF_METRICS_JQ");
    const now = "2026-10-27T12:00:00Z";
    const out = jq(program, [
      "--arg", "short", "app",
      "--arg", "now", now,
      "--arg", "stale_before", "2026-10-06T12:00:00Z",
      "--argjson", "stuck_h", "48",
      "--argjson", "issues", "[]",
      "--argjson", "prs", "[]",
      "--argjson", "merged", JSON.stringify([
        {
          number: 3,
          title: "today",
          url: "https://example.test/3",
          createdAt: "2026-10-27T08:00:00Z",
          mergedAt: "2026-10-27T10:00:00Z",
          author: { login: "ada" },
        },
        {
          number: 8,
          title: "edge",
          url: "https://example.test/8",
          createdAt: "2026-10-26T08:00:00Z",
          mergedAt: "2026-10-26T12:00:00Z",
          author: { login: "ada" },
        },
        {
          number: 9,
          title: "weekend",
          url: "https://example.test/9",
          createdAt: "2026-10-25T11:59:59Z",
          mergedAt: "2026-10-26T11:59:59Z",
          author: { login: "ada" },
        },
      ]),
    ]) as {
      merged_list: { number: number; lead_hours: number }[];
      merged: { number: number; merged_at: string }[];
      median_lead_hours: number;
    };
    assert.deepEqual(out.merged_list.map((row) => row.number), [3, 8]);
    assert.deepEqual(out.merged.map((row) => row.number), [3, 8, 9]);
    assert.equal(out.merged_list.some((row) => row.number === 9), false);
    assert.equal(out.median_lead_hours, 3);
    assert.equal(out.merged.find((row) => row.number === 9)?.merged_at, "2026-10-26T11:59:59Z");
  });

  it("does not say STUCK PRs none when every repo is incomplete", () => {
    const now = "2026-10-27T12:00:00Z";
    const clock = { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] };
    const blank = {
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
      blocked_issues: null,
      stuck_prs: null,
      decisions: null,
      merged_list: null,
    };
    const brief = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [
        section({
          repo: "acme/app",
          short: "app",
          label: "Acme",
          incomplete: true,
          errors: ["no snapshot"],
          ...blank,
          stuck_prs: [stuck("app", 99, 900)],
        }),
        section({
          repo: "other/app",
          short: "other",
          label: "Other",
          incomplete: true,
          errors: ["counts not measured"],
          ...blank,
        }),
      ],
    });
    assert.equal(brief.totals.repos_counted, 0);
    assert.equal(brief.incomplete_repos.length, 2);
    const text = formatBriefText(brief, clock);
    assert.match(text, /DATA INCOMPLETE for 2 of 2 repos/);
    assert.equal(text.includes("STUCK PRs: none."), false);
    assert.match(text, /STUCK PRs: DATA INCOMPLETE\./);
    assert.equal(text.includes("#99"), false);

    const measured = formatBriefText(assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [section({ repo: "acme/app", short: "app", label: "Acme", stuck_prs: [] })],
    }), clock);
    assert.match(measured, /STUCK PRs: none\./);

    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const start = script.indexOf("stuck_heading() {");
    const end = script.indexOf("# END stuck_heading");
    assert.ok(start >= 0 && end > start);
    const fn = script.slice(start, end);
    const heading = (args: string) => execFileSync("bash", ["-c", `${fn}\nstuck_heading ${args}`], { encoding: "utf8" });
    assert.equal(heading("null"), "STUCK PRs: DATA INCOMPLETE.\n");
    assert.equal(heading("0"), "STUCK PRs: none.\n");
    assert.match(heading("4"), /^STUCK PRs \(4\) /);
    assert.match(script, /stuck_heading "\$n_stuck"/);
  });

  it("configured error never counts as work, including beside newer noise", async () => {
    const now = "2026-10-27T12:00:00Z";
    const agent = { id: "hermes-carmack", last_seen_at: "2026-10-27T11:59:30Z" };
    const base = {
      agentId: "hermes-carmack",
      maxSilenceHours: 3,
      nowIso: now,
      reachable: true,
      agent,
    };
    const onlyError = coordinatorStatus({
      ...base,
      workKinds: ["error"],
      events: [{ kind: "error", created_at: "2026-10-27T11:30:00Z" }],
    });
    assert.equal(onlyError.verdict?.startsWith("working"), false);
    assert.match(onlyError.verdict ?? "", /^FAILING: 1 error event/);
    assert.equal(onlyError.last_work_kind, null);

    const mixed = coordinatorStatus({
      ...base,
      workKinds: ["session_end", "error"],
      events: [
        { kind: "turn_start", created_at: "2026-10-27T11:55:00Z" },
        { kind: "status_update", created_at: "2026-10-27T11:50:00Z" },
        { kind: "error", created_at: "2026-10-27T11:30:00Z" },
      ],
    });
    assert.equal(mixed.verdict?.startsWith("working"), false);
    assert.match(mixed.verdict ?? "", /^FAILING: 1 error event/);
    assert.equal(mixed.last_work_kind, null);
    assert.equal(mixed.last_any_kind, "turn_start");

    const errorOnlyConfig = readBriefSettings({ brief: { coordinator: { workKinds: ["error"] } } });
    assert.deepEqual(errorOnlyConfig.coordinator.workKinds, ["session_end", "milestone", "status"]);
    const errorBesideWork = readBriefSettings({ brief: { coordinator: { workKinds: ["session_end", "error"] } } });
    assert.deepEqual(errorBesideWork.coordinator.workKinds, ["session_end"]);
    const pipedError = readBriefSettings({ brief: { coordinator: { workKinds: "error|milestone|heartbeat" } } });
    assert.deepEqual(pipedError.coordinator.workKinds, ["milestone"]);

    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const start = script.indexOf("filter_work_kinds() {");
    const end = script.indexOf("# end filter_work_kinds");
    assert.ok(start >= 0 && end > start);
    const fn = script.slice(start, end);
    const filtered = (raw: string) => execFileSync("bash", ["-c", `${fn}\nfilter_work_kinds ${JSON.stringify(raw)}`], { encoding: "utf8" });
    assert.equal(filtered("error"), "");
    assert.equal(filtered("session_end|error"), "session_end");
    assert.equal(filtered("error|turn_start|milestone|status_update"), "milestone");

    const nowMs = Date.parse(now);
    const at = (secondsAgo: number) => new Date(nowMs - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const agentId = "hermes-carmack";
    let events: Row[] = [];
    const queried: string[][] = [];
    env.DATABASE_URL = "postgres://brief:brief@127.0.0.1:9/brief_test";
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ");
      if (text.includes("from agents")) return [{ id: agentId, last_seen_at: "2026-10-27T11:59:00Z" }];
      if (text.includes("from events")) {
        const kinds = values.find((value) => Array.isArray(value));
        if (Array.isArray(kinds)) queried.push(kinds.map(String));
        return applyEventQuery(strings, values, events);
      }
      throw new Error(`unexpected sql: ${text}`);
    });
    events = [
      { id: 1, agent_id: agentId, kind: "turn_start", created_at: at(60) },
      { id: 2, agent_id: agentId, kind: "error", created_at: at(600) },
    ];
    const errorOnly = readBriefSettings({
      brief: { coordinator: { agentId, maxSilenceHours: 3, workKinds: ["error"] } },
    });
    queried.length = 0;
    const fromErrorOnly = await coordinatorFromDb(errorOnly, now);
    assert.equal(fromErrorOnly.verdict?.startsWith("working"), false);
    assert.match(fromErrorOnly.verdict ?? "", /^FAILING: 1 error event/);
    assert.equal(queried.some((kinds) => kinds.includes("error")), false);
    assert.deepEqual(queried[0], ["session_end", "milestone", "status"]);

    const sneaky = {
      ...errorOnly,
      coordinator: { agentId, maxSilenceHours: 3, workKinds: ["session_end", "error"] },
    };
    queried.length = 0;
    const fromMixed = await coordinatorFromDb(sneaky, now);
    assert.match(fromMixed.verdict ?? "", /^FAILING: 1 error event/);
    assert.deepEqual(queried[0], ["session_end"]);
    assert.equal(queried[0]?.includes("error"), false);
  });

  it("does not say decisions none open when incomplete repos suppressed them", () => {
    const now = "2026-10-27T12:00:00Z";
    const clock = { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] };
    const blank = {
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
      blocked_issues: null,
      stuck_prs: null,
      decisions: null,
      merged_list: null,
    };
    const allIncomplete = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "config",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [
        section({
          repo: "acme/app",
          short: "app",
          label: "Acme",
          incomplete: true,
          errors: ["no snapshot"],
          ...blank,
        }),
      ],
    });
    const suppressed = formatBriefText(allIncomplete, clock);
    assert.match(suppressed, /DECISIONS FOR YOU: DATA INCOMPLETE\./);
    assert.equal(suppressed.includes("DECISIONS FOR YOU: none open."), false);

    const mixed = formatBriefText(assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [
        section({ repo: "acme/app", short: "app", label: "Acme", decisions: [] }),
        section({
          repo: "other/app",
          short: "other",
          label: "Other",
          incomplete: true,
          errors: ["counts not measured"],
          ...blank,
        }),
      ],
    }), clock);
    assert.match(mixed, /DECISIONS FOR YOU: DATA INCOMPLETE\./);
    assert.equal(mixed.includes("DECISIONS FOR YOU: none open."), false);

    const measuredNone = formatBriefText(assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [section({ repo: "acme/app", short: "app", label: "Acme", decisions: [], stuck_prs: [] })],
    }), clock);
    assert.match(measuredNone, /DECISIONS FOR YOU: none open\./);

    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const start = script.indexOf("decisions_heading() {");
    const end = script.indexOf("# END decisions_heading");
    assert.ok(start >= 0 && end > start);
    const fn = script.slice(start, end);
    const heading = (args: string) => execFileSync("bash", ["-c", `${fn}\ndecisions_heading ${args}`], { encoding: "utf8" });
    assert.equal(heading("null 1 0"), "DECISIONS FOR YOU: DATA INCOMPLETE.\n");
    assert.equal(heading("null 3 0"), "DECISIONS FOR YOU: DATA INCOMPLETE.\n");
    assert.equal(heading("null 1 4"), "DECISIONS FOR YOU: DATA INCOMPLETE.\n");
    assert.equal(heading("0 1 0"), "DECISIONS FOR YOU: none open.\n");
    // Empty labels plus an unmeasured count is DATA INCOMPLETE, never "not tracked" (round 7 review).
    assert.equal(heading("null 0 0"), "DECISIONS FOR YOU: DATA INCOMPLETE.\n");
    assert.match(heading("0 0 0"), /not tracked/);
    assert.match(heading("4 1 4"), /^DECISIONS FOR YOU \(4\) /);
    assert.match(script, /decisions_heading "\$n_dec" "\$n_labels" "\$n_known_dec"/);
  });

  it("an incomplete repo makes every fleet aggregate unknown, even when another repo measured an empty list", () => {
    const now = "2026-10-27T12:00:00Z";
    const clock = { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] };
    const blank = {
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
      blocked_issues: null,
      stuck_prs: null,
      decisions: null,
      merged_list: null,
    };
    const incomplete = section({
      repo: "other/app",
      short: "other",
      label: "Other",
      incomplete: true,
      errors: ["no snapshot"],
      ...blank,
    });
    const measuredEmpty = section({
      repo: "acme/app",
      short: "app",
      label: "Acme",
      merged_prs: 0,
      issues_opened: 0,
      issues_closed: 0,
      net_backlog: 0,
      open_issues: 0,
      open_prs: 0,
      drafts: 0,
      stale_issues: 0,
      stale_ratio: 0,
      median_lead_hours: null,
      stuck_prs: [],
      decisions: [],
      merged_list: [],
    });
    const input = {
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: {
        configured: true,
        agent_id: "hermes-carmack",
        verdict: "working: last work event 0.2h ago",
        last_seen_hours: 0.2,
      },
    };
    // One row per fleet aggregate. The complete repo measured an empty list
    // or a zero. The incomplete repo must keep the aggregate unknown.
    const aggregates: { field: "merged_prs" | "issues_opened" | "issues_closed" | "net_backlog" | "open_issues" | "open_prs" | "stuck_prs" | "decisions"; ban: RegExp }[] = [
      { field: "merged_prs", ban: /0 PRs merged/ },
      { field: "issues_opened", ban: /\b0 opened\b/ },
      { field: "issues_closed", ban: /0 issues closed/ },
      { field: "net_backlog", ban: /the queue held level/ },
      { field: "open_issues", ban: /0 open issues/ },
      { field: "open_prs", ban: /0 open PRs/ },
      { field: "stuck_prs", ban: /STUCK PRs: none/ },
      { field: "decisions", ban: /none open/ },
    ];
    for (const row of aggregates) {
      const brief = assembleBrief({ ...input, repos: [incomplete, measuredEmpty] });
      assert.equal(brief.totals[row.field], null, row.field);
      const text = formatBriefText(brief, clock);
      assert.equal(row.ban.test(text), false, row.field);
      assert.match(text, /DATA INCOMPLETE/, row.field);
      assert.equal(/\bnone\b/i.test(text), false, row.field);
      assert.equal(/\bnull\b/.test(text), false, row.field);
    }

    const known = assembleBrief({
      ...input,
      repos: [
        incomplete,
        section({
          repo: "acme/app",
          short: "app",
          label: "Acme",
          merged_prs: 1,
          issues_opened: 0,
          issues_closed: 0,
          net_backlog: 0,
          open_issues: 0,
          open_prs: 0,
          stuck_prs: [stuck("app", 11, 10)],
          decisions: [decision("acme/app", 8, 30, "needs a call")],
          merged_list: [{ number: 4, title: "landed", url: "https://example.test/4", author: "ada", lead_hours: 2 }],
        }),
      ],
    });
    for (const row of aggregates) assert.equal(known.totals[row.field], null, `known ${row.field}`);
    const knownText = formatBriefText(known, clock);
    assert.match(knownText, /STUCK PRs: DATA INCOMPLETE\./);
    assert.match(knownText, /#11/);
    assert.match(knownText, /DECISIONS FOR YOU: DATA INCOMPLETE\./);
    assert.match(knownText, /needs a call/);
    assert.match(knownText, /SHIPPED — Acme:/);
    assert.match(knownText, /#4/);
    assert.equal(/\bnone\b/i.test(knownText), false);
    assert.equal(/0 PRs merged/.test(knownText), false);
    assert.match(knownText, /COORDINATOR {2}\[ok\] hermes-carmack — working: last work event 0\.2h ago/);

    const unreachable = formatBriefText(assembleBrief({
      ...input,
      coordinator: { configured: true, agent_id: "hermes-carmack", verdict: "unknown: dashboard unreachable" },
      repos: [incomplete, measuredEmpty],
    }), clock);
    assert.match(unreachable, /unknown: dashboard unreachable/);
    assert.equal(/\bnone\b/i.test(unreachable), false);

    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const assemble = quotedVar(script, "BRIEF_ASSEMBLE_JQ");
    const jqBrief = jq(assemble, [
      "--arg", "at", now,
      "--argjson", "window", "24",
      "--arg", "repo_source", "dashboard",
      "--argjson", "repos", JSON.stringify([incomplete, measuredEmpty]),
      "--argjson", "coordinator", JSON.stringify(input.coordinator),
      "--argjson", "stuck_h", "48",
      "--argjson", "stale_d", "21",
    ]) as MorningBrief;
    for (const row of aggregates) assert.equal(jqBrief.totals[row.field], null, `jq ${row.field}`);

    const stuckStart = script.indexOf("stuck_heading() {");
    const stuckEnd = script.indexOf("# END stuck_heading");
    const stuckFn = script.slice(stuckStart, stuckEnd);
    const stuckHeading = (args: string) => execFileSync("bash", ["-c", `${stuckFn}\nstuck_heading ${args}`], { encoding: "utf8" });
    assert.equal(stuckHeading("null"), "STUCK PRs: DATA INCOMPLETE.\n");
    const countsStart = script.indexOf("counts_heading() {");
    const countsEnd = script.indexOf("# END counts_heading");
    assert.ok(countsStart >= 0 && countsEnd > countsStart);
    const countsFn = script.slice(countsStart, countsEnd);
    const countsHeading = (args: string) => execFileSync("bash", ["-c", `${countsFn}\ncounts_heading ${args}`], { encoding: "utf8" });
    const unknownCounts = countsHeading("null null null null null null");
    assert.match(unknownCounts, /PRs merged, issues closed, and issues opened: DATA INCOMPLETE\./);
    assert.match(unknownCounts, /Open issues and open PRs: DATA INCOMPLETE\./);
    assert.equal(/\bnone\b/.test(unknownCounts), false);
    assert.equal(countsHeading("0 0 0 0 0 0"), "0 PRs merged, 0 issues closed, 0 opened — the queue held level.\n");

    const lacks: { field: (typeof aggregates)[number]["field"]; ban: RegExp; over: Partial<BriefRepo> }[] = [
      { field: "merged_prs", ban: /0 PRs merged/, over: { merged_prs: null } },
      { field: "issues_opened", ban: /\b0 opened\b/, over: { issues_opened: null } },
      { field: "issues_closed", ban: /0 issues closed/, over: { issues_closed: null } },
      { field: "net_backlog", ban: /the queue held level/, over: { net_backlog: null } },
      { field: "open_issues", ban: /0 open issues/, over: { open_issues: null } },
      { field: "open_prs", ban: /0 open PRs/, over: { open_prs: null } },
      { field: "stuck_prs", ban: /STUCK PRs: none/, over: { stuck_prs: null } },
      { field: "decisions", ban: /none open/, over: { decisions: null } },
    ];
    for (const row of lacks) {
      const brief = assembleBrief({
        ...input,
        coordinator: { configured: false, agent_id: null },
        repos: [
          section({
            repo: "acme/app",
            short: "app",
            label: "Acme",
            merged_prs: 0,
            issues_opened: 0,
            issues_closed: 0,
            net_backlog: 0,
            open_issues: 0,
            open_prs: 0,
            stuck_prs: [],
            decisions: [],
            merged_list: [],
            ...row.over,
          }),
          measuredEmpty,
        ],
      });
      // measuredEmpty is a second complete repo. Rename its identity so the two rows differ.
      brief.repos[1] = { ...brief.repos[1], repo: "beta/app", short: "beta", label: "Beta" };
      assert.equal(brief.totals[row.field], null, `lacks ${row.field}`);
      const text = formatBriefText(brief, clock);
      assert.equal(row.ban.test(text), false, `lacks ${row.field}`);
      assert.match(text, /DATA INCOMPLETE/, `lacks ${row.field}`);
      assert.equal(/\bnull\b/.test(text), false, `lacks ${row.field}`);
    }
  });

  it("treats an empty detail.merged array as measured and does not fall back to merged_list", () => {
    const now = "2026-10-27T12:00:00Z";
    const cfg = { repo: "acme/app", label: "Acme", short: "app", blockedLabel: null };
    const decoy = { number: 1, title: "stored", url: "https://example.test/1", author: "a", lead_hours: 99 };
    const snap: RepoSnapshot = {
      repo: "acme/app",
      label: "Acme",
      collected_at: now,
      kind: "tick",
      open_issues: 0,
      open_prs: 0,
      blocked_issues: 0,
      merged_prs_24h: 0,
      issues_closed_24h: 0,
      issues_opened_24h: 0,
      total_issues_created: 4,
      total_issues_closed: 4,
      total_prs_merged: 2,
      review_rounds: null,
      no_verdict_rate: null,
      detail: { merged: [], merged_list: [decoy], median_lead_hours: 99 },
    };
    const day = repoSection({ cfg, snap, baseline: null, windowHours: 24, nowIso: now });
    assert.deepEqual(day.merged_list, []);
    assert.equal(day.median_lead_hours, null);
    const weekend = repoSection({ cfg, snap, baseline: null, windowHours: 72, nowIso: now });
    assert.deepEqual(weekend.merged_list, []);
    assert.equal(weekend.median_lead_hours, null);

    const absent = repoSection({
      cfg,
      snap: { ...snap, detail: { merged_list: [decoy], median_lead_hours: 99 } },
      baseline: null,
      windowHours: 24,
      nowIso: now,
    });
    assert.equal(absent.merged_list?.[0]?.number, 1);
    assert.equal(absent.median_lead_hours, 99);
  });

  it("a held legacy decisions row is unmeasured when the server has no sweep", () => {
    const now = "2026-10-27T12:00:00Z";
    const clock = { clock: "Mon 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] };
    const cfg = { repo: "acme/app", label: "Acme", short: "app", blockedLabel: null };
    const snap: RepoSnapshot = {
      repo: "acme/app",
      label: "Acme",
      collected_at: now,
      kind: "tick",
      open_issues: 4,
      open_prs: 1,
      blocked_issues: 0,
      merged_prs_24h: 2,
      issues_closed_24h: 1,
      issues_opened_24h: 3,
      total_issues_created: 10,
      total_issues_closed: 6,
      total_prs_merged: 5,
      review_rounds: null,
      no_verdict_rate: null,
      detail: { stuck_prs: [], merged: [] },
    };
    const complete = repoSection({ cfg, snap, baseline: null, windowHours: 24, nowIso: now });
    assert.equal(complete.incomplete, false);
    assert.equal(complete.merged_prs, 2);

    for (const field of ["kind", "labels", "opened_at", "repo_short"] as const) {
      const legacy = legacyDecision({ [field]: null });
      const part = partitionBrief([legacy], now);
      assert.deepEqual(part.incomplete_repos, ["acme/app"], field);
      assert.deepEqual(part.decisions, [], field);
      const joined = applyTableDecisions([complete], part.decisions, part.incomplete_repos);
      assert.equal(joined[0].decisions, null, field);
      assert.equal(joined[0].incomplete, false, field);
      assert.equal(joined[0].merged_prs, 2, field);
      assert.ok(joined[0].errors.includes("decisions incomplete"), field);
      const brief = assembleBrief({
        generatedAt: now,
        windowHours: 24,
        repoSource: "dashboard",
        stuckPrHours: 48,
        staleIssueDays: 21,
        coordinator: { configured: false, agent_id: null },
        repos: joined,
      });
      assert.equal(brief.totals.decisions, null, field);
      assert.equal(brief.totals.merged_prs, 2, field);
      assert.equal(brief.totals.stuck_prs, 0, field);
      assert.ok(
        brief.incomplete_repos.some((row) => row.repo === "acme/app" && row.errors.includes("decisions incomplete")),
        field,
      );
      const text = formatBriefText(brief, clock);
      assert.match(text, /DECISIONS FOR YOU: DATA INCOMPLETE\./, field);
      assert.equal(text.includes("DECISIONS FOR YOU: none open."), false, field);
      assert.equal(text.includes("Fleet totals stay unknown"), false, field);
      assert.equal(/\bnull\b/.test(text), false, field);
    }

    const swept = section({
      repo: "acme/app",
      short: "app",
      label: "Acme",
      merged_prs: 2,
      decisions: [decision("acme/app", 9, 50, "github sweep")],
    });
    const kept = applyTableDecisions([swept], [], ["acme/app"]);
    assert.deepEqual(kept[0].decisions?.map((row) => row.number), [9]);
    assert.equal(kept[0].errors.includes("decisions incomplete"), false);

    const emptySweep = section({ repo: "acme/app", short: "app", label: "Acme", decisions: [] });
    const keptEmpty = applyTableDecisions([emptySweep], [], ["acme/app"]);
    assert.deepEqual(keptEmpty[0].decisions, []);
    assert.equal(keptEmpty[0].errors.includes("decisions incomplete"), false);

    const measured = applyTableDecisions([complete], [], []);
    assert.deepEqual(measured[0].decisions, []);
    assert.equal(measured[0].errors.includes("decisions incomplete"), false);
    const none = assembleBrief({
      generatedAt: now,
      windowHours: 24,
      repoSource: "dashboard",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: measured,
    });
    assert.equal(none.totals.decisions, 0);
    assert.deepEqual(none.incomplete_repos, []);
    assert.match(formatBriefText(none, clock), /DECISIONS FOR YOU: none open\./);
  });

  it("a missing decisions relation or a failed decisions query is not an empty list", async () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const clock = { clock: "Tue 2026-10-27 08:00 EDT", decisionLabels: ["needs-owner"] };
    const repo = "example-org/app-server";
    const other = "example-org/web-studio";
    const snapshots = [repo, other, "example-org/agent-harness"].map((name, index) => snapshotRow({
      repo: name,
      label: name,
      collected_at: "2026-10-27T14:00:00.000Z",
      open_issues: 3,
      open_prs: 1,
      merged_prs_24h: index === 0 ? 2 : 0,
      issues_opened_24h: 1,
      issues_closed_24h: 1,
      detail: { stuck_prs: [], merged: [] },
    }));
    const legacy = {
      id: 4,
      key: `github:${repo}#4`,
      source: "github-label",
      repo,
      repo_short: null,
      number: 4,
      url: `https://example.test/${repo}/issues/4`,
      title: "legacy gate",
      status: "open",
      kind: null,
      labels: null,
      opened_at: null,
      github_present: true,
    };
    const known = {
      id: 8,
      key: `github:${other}#8`,
      source: "github-label",
      repo: other,
      repo_short: "web",
      number: 8,
      url: `https://example.test/${other}/issues/8`,
      title: "needs a call",
      status: "open",
      kind: "issue",
      labels: ["needs-owner"],
      opened_at: "2026-10-20T12:00:00Z",
      github_present: true,
    };

    installBriefSql(snapshots, [legacy, known]);
    const held = await loadBrief("24h", now);
    const heldRepo = held.repos.find((row) => row.repo === repo);
    const knownRepo = held.repos.find((row) => row.repo === other);
    assert.equal(heldRepo?.incomplete, false);
    assert.equal(heldRepo?.merged_prs, 2);
    assert.equal(heldRepo?.decisions, null);
    assert.ok(heldRepo?.errors.includes("decisions incomplete"));
    assert.deepEqual(knownRepo?.decisions?.map((row) => row.number), [8]);
    assert.equal(held.totals.decisions, null);
    assert.equal(held.totals.merged_prs, 2);
    assert.ok(held.incomplete_repos.some((row) => row.repo === repo && row.errors.includes("decisions incomplete")));
    assert.equal(held.incomplete_repos.some((row) => row.repo === other), false);
    const heldText = formatBriefText(held, clock);
    assert.match(heldText, /DECISIONS FOR YOU: DATA INCOMPLETE\./);
    assert.match(heldText, /needs a call/);
    assert.equal(heldText.includes("DECISIONS FOR YOU: none open."), false);
    assert.equal(heldText.includes("Fleet totals stay unknown"), false);
    assert.match(heldText, /2 PRs merged/);

    for (const failure of ["missing", "fail"] as const) {
      installBriefSql(snapshots, failure);
      const brief = await loadBrief("24h", now);
      assert.equal(brief.repos.every((row) => row.decisions === null), true, failure);
      assert.equal(brief.repos.every((row) => row.incomplete === false), true, failure);
      assert.equal(brief.repos.every((row) => row.errors.includes("decisions unavailable")), true, failure);
      assert.equal(brief.totals.decisions, null, failure);
      assert.equal(brief.totals.merged_prs, 2, failure);
      assert.equal(brief.incomplete_repos.length, brief.repos.length, failure);
      const text = formatBriefText(brief, clock);
      assert.match(text, /DECISIONS FOR YOU: DATA INCOMPLETE\./, failure);
      assert.equal(text.includes("DECISIONS FOR YOU: none open."), false, failure);
      assert.equal(text.includes("Fleet totals stay unknown"), false, failure);
    }

    installBriefSql(snapshots, []);
    const empty = await loadBrief("24h", now);
    assert.equal(empty.repos.every((row) => Array.isArray(row.decisions) && row.decisions.length === 0), true);
    assert.equal(empty.totals.decisions, 0);
    assert.deepEqual(empty.incomplete_repos, []);
    assert.match(formatBriefText(empty, clock), /DECISIONS FOR YOU: none open\./);
  });

  it("shell workKinds accepts the array form the TypeScript reader accepts", () => {
    const script = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    const start = script.indexOf("filter_work_kinds() {");
    const end = script.indexOf("# END read_work_kinds");
    assert.ok(start >= 0 && end > start);
    const fn = script.slice(start, end);
    assert.match(script, /COORD_WORK_KINDS="\$\(read_work_kinds /);
    const cases: unknown[] = [
      ["milestone", "heartbeat"],
      ["error"],
      ["custom_work", "heartbeat"],
      [" session_end "],
      ["milestone", 3, "heartbeat"],
      [],
      "telemetry|turn_start|session_end",
      "error|milestone|heartbeat",
      "",
    ];
    const run = (raw: string) => execFileSync(
      "bash",
      ["-c", `${fn}\nread_work_kinds ${JSON.stringify(raw)}`],
      { encoding: "utf8" },
    );
    for (const value of cases) {
      const expected = readBriefSettings({
        brief: { coordinator: { workKinds: value as never } },
      }).coordinator.workKinds.join("|");
      const raw = Array.isArray(value) ? JSON.stringify(value) : String(value);
      assert.equal(run(raw), expected, JSON.stringify(value));
    }
  });
});

/** A repo_snapshots row. Nulls are unmeasured counts, not zeros. */
function snapshotRow(over: Partial<Row> & Pick<Row, "repo" | "collected_at">): Row {
  return {
    label: null,
    kind: "tick",
    open_issues: 0,
    open_prs: 0,
    blocked_issues: 0,
    merged_prs_24h: 0,
    issues_closed_24h: 0,
    issues_opened_24h: 0,
    total_issues_created: 0,
    total_issues_closed: 0,
    total_prs_merged: 0,
    review_rounds: null,
    no_verdict_rate: null,
    detail: null,
    ...over,
  };
}

/**
 * Applies the brief's snapshot SQL to an in-memory table, including the
 * `open_issues is not null` predicate when the query still has it.
 */
function legacyDecision(over: Partial<Decision>): Decision {
  const opened = "2026-10-01T12:00:00Z";
  return {
    id: over.id ?? 1,
    key: over.key ?? "github:acme/app#20",
    source: over.source ?? "github-label",
    repo: over.repo === undefined ? "acme/app" : over.repo,
    repo_short: over.repo_short === undefined ? "app" : over.repo_short,
    number: over.number === undefined ? 20 : over.number,
    url: over.url === undefined ? "https://github.com/acme/app/issues/20" : over.url,
    title: over.title ?? "legacy gate",
    why: over.why === undefined ? null : over.why,
    options: over.options === undefined ? null : over.options,
    recommended: over.recommended === undefined ? null : over.recommended,
    requested_by: over.requested_by === undefined ? "collector" : over.requested_by,
    status: over.status ?? "open",
    decision: over.decision === undefined ? null : over.decision,
    decided_by: over.decided_by === undefined ? null : over.decided_by,
    decided_at: over.decided_at === undefined ? null : over.decided_at,
    defer_until: over.defer_until === undefined ? null : over.defer_until,
    kind: over.kind === undefined ? "issue" : over.kind,
    labels: over.labels === undefined ? ["needs-owner"] : over.labels,
    opened_at: over.opened_at === undefined ? opened : over.opened_at,
    github_present: over.github_present === undefined ? true : over.github_present,
    first_seen_at: over.first_seen_at ?? opened,
    last_seen_at: over.last_seen_at ?? opened,
    created_at: over.created_at ?? opened,
    updated_at: over.updated_at ?? opened,
    age_days: over.age_days ?? 0,
    revision: over.revision ?? 0,
    actor_type: over.actor_type === undefined ? null : over.actor_type,
    actor_id: over.actor_id === undefined ? null : over.actor_id,
    chosen_option: over.chosen_option === undefined ? null : over.chosen_option,
    writeback: over.writeback === undefined ? null : over.writeback,
  };
}

function installBriefSql(snapshots: Row[], decisions: Row[] | "missing" | "fail"): void {
  env.DATABASE_URL = "postgres://brief:brief@127.0.0.1:9/brief_test";
  setSqlForTests(async (strings, ...values) => {
    const text = strings.join(" ");
    if (text.includes("from watched_repos")) return [];
    if (text.includes("from decisions")) {
      if (decisions === "missing") {
        throw Object.assign(new Error('relation "decisions" does not exist'), { code: "42P01" });
      }
      if (decisions === "fail") throw Object.assign(new Error("connection reset"), { code: "08006" });
      return decisions;
    }
    if (text.includes("from agents") || text.includes("from events")) return [];
    if (!text.includes("from repo_snapshots")) throw new Error(`unexpected sql: ${text}`);
    const repos = new Set((values[0] as string[]) ?? []);
    const best = new Map<string, Row>();
    for (const row of snapshots) {
      if (!repos.has(String(row.repo))) continue;
      const prev = best.get(String(row.repo));
      if (!prev || String(row.collected_at) > String(prev.collected_at)) best.set(String(row.repo), row);
    }
    return [...best.values()];
  });
}

function installSnapshotSql(rows: Row[]): void {
  env.DATABASE_URL = "postgres://brief:brief@127.0.0.1:9/brief_test";
  setSqlForTests(async (strings, ...values) => {
    const text = strings.join(" ");
    if (text.includes("from watched_repos")) return [];
    if (text.includes("from decisions")) return [];
    if (!text.includes("from repo_snapshots")) throw new Error(`unexpected sql: ${text}`);
    const repos = new Set((values[0] as string[]) ?? []);
    let pool = rows.filter((row) => repos.has(String(row.repo)));
    if (/open_issues\s+is\s+not\s+null/i.test(text)) {
      pool = pool.filter((row) => row.open_issues !== null && row.open_issues !== undefined);
    }
    if (text.includes("collected_at <=")) {
      const before = String(values[1]);
      pool = pool.filter((row) => String(row.collected_at) <= before);
    }
    const best = new Map<string, Row>();
    for (const row of pool) {
      const key = String(row.repo);
      const prev = best.get(key);
      if (!prev || String(row.collected_at) > String(prev.collected_at)) best.set(key, row);
    }
    return [...best.values()];
  });
}

/**
 * Applies one coordinator event query to an in-memory table.
 * Kind filters, the silence cutoff, and LIMIT are honored, so a newest-200
 * read drops a work row that a kind-scoped read keeps.
 */
function applyEventQuery(strings: TemplateStringsArray, values: unknown[], events: Row[]): Row[] {
  let text = "";
  strings.forEach((part, i) => {
    text += part;
    if (i < values.length) text += `\u0000${i}\u0000`;
  });
  const branches = text.split(/\bunion\s+all\b|\bunion\b/i);
  const rows: Row[] = [];
  for (const branch of branches) {
    if (!/from\s+events/i.test(branch)) continue;
    rows.push(...evalEventBranch(branch, values, events));
  }
  return rows;
}

function evalEventBranch(branch: string, values: unknown[], events: Row[]): Row[] {
  const idxs = [...branch.matchAll(/\u0000(\d+)\u0000/g)].map((match) => Number(match[1]));
  const bound = idxs.map((index) => values[index]);
  let rows = events.filter((row) => bound.length === 0 || row.agent_id === bound[0]);
  const notIn = branch.match(/kind\s+not\s+in\s*\(([^)]*)\)/i);
  if (notIn) {
    const banned = [...notIn[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    rows = rows.filter((row) => !banned.includes(String(row.kind)));
  } else {
    const only = branch.match(/kind\s+in\s*\(([^)]*)\)/i);
    if (only) {
      const allowed = [...only[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
      rows = rows.filter((row) => allowed.includes(String(row.kind)));
    }
  }
  const exact = branch.match(/kind\s*=\s*'([^']+)'/i);
  if (exact) rows = rows.filter((row) => String(row.kind) === exact[1]);
  if (/kind\s*=\s*any\s*\(/i.test(branch)) {
    const kinds = bound.find((value) => Array.isArray(value));
    const allowed = Array.isArray(kinds) ? kinds.map(String) : [];
    rows = rows.filter((row) => allowed.includes(String(row.kind)));
  }
  if (/created_at\s*>=/.test(branch)) {
    const cutoff = bound.find((value) => typeof value === "string" && value.includes("T"));
    if (typeof cutoff === "string") {
      const min = Date.parse(cutoff);
      rows = rows.filter((row) => Date.parse(String(row.created_at)) >= min);
    }
  }
  if (/created_at\s*</.test(branch) && !/created_at\s*<=/.test(branch)) {
    const cutoff = bound.find((value) => typeof value === "string" && value.includes("T"));
    if (typeof cutoff === "string") {
      const max = Date.parse(cutoff);
      rows = rows.filter((row) => Date.parse(String(row.created_at)) < max);
    }
  }
  rows = [...rows].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
  const limit = branch.match(/limit\s+(\d+)/i);
  if (limit) rows = rows.slice(0, Number(limit[1]));
  return rows.map((row) => ({ id: row.id, kind: row.kind, created_at: row.created_at }));
}
