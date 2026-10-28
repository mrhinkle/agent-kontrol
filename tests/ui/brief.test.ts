import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GET } from "../../src/app/api/brief/route";
import {
  applyTableDecisions,
  assembleBrief,
  briefWantsJson,
  coordinatorStatus,
  formatBriefText,
  loadBrief,
  parseBriefQuery,
  repoSection,
  type BriefRepo,
  type BriefStuckPr,
  type MorningBrief,
} from "../../src/lib/brief";
import type { BriefDecision } from "../../src/lib/decisions";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests, type Row } from "../../src/lib/db";
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
    assert.equal(body.totals.merged_prs, 0);
    assert.equal(body.totals.repos_counted, 0);
    assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const text = await bodyText(await GET(briefRequest()));
    assert.match(text, /DATA INCOMPLETE/);
    assert.equal(text.includes("undefined"), false);
    assert.equal(/\bnull\b/.test(text), false);
    assert.equal(text.includes("COORDINATOR"), false);
    assert.match(text, /DECISIONS FOR YOU: none open\./);
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
    ]);
    assert.equal(registered.filter((name) => name === "get_morning_brief").length, 1);
    assert.equal([...src.matchAll(/name: "reply_to_mark"/g)].length, 1);
    assert.equal([...src.matchAll(/name: "reply_to_operator"/g)].length, 1);

    const block = src.slice(src.indexOf('"get_morning_brief"'), src.indexOf('"remember"'));
    assert.match(block, /readOnlyHint:\s*true/);
    assert.match(block, /destructiveHint:\s*false/);
    assert.match(block, /idempotentHint:\s*true/);
    assert.match(block, /openWorldHint:\s*false/);
    assert.equal(src.slice(0, src.indexOf('"get_morning_brief"')).includes("readOnlyHint"), false);

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
    assert.equal(tsBrief.totals.merged_prs, 3);
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
    assert.deepEqual(bare.stuck_prs, []);
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
    assert.match(rendered, /STUCK PRs: none\./);
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
      assert.equal(brief.totals.merged_prs, 0, window);
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
    assert.equal(brief.totals.merged_prs, 0);
    assert.equal(brief.totals.issues_opened, 0);
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
