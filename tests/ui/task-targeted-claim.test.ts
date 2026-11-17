import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setSqlForTests } from "../../src/lib/db";
import { LEGACY_ACTOR_ID, runWithPrincipal } from "../../src/lib/actor";
import { claimNextTask, claimTaskWithCoverage, isExactTaskId } from "../../src/lib/store";
import { POST as claimTask } from "../../src/app/api/tasks/claim/route";

/**
 * Exact task_id on POST /api/tasks/claim.
 * Omitted keeps priority order. A present id claims that queued row only.
 * Malformed values are rejected before SQL, including demo mode.
 */

const env = process.env as Record<string, string | undefined>;
const TOKEN = "targeted-claim-test-token";
const FIXTURE_URL = "postgres://fixture:fixture@127.0.0.1:9/ak_targeted_claim";
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
};
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TASK_ID_FIELD = "must be a positive integer from 1 to 9007199254740991.";
const LEAK = "TARGETED-CLAIM-LEAK-99";

function restoreEnv(): void {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.driver === undefined) delete env.MC_DB_DRIVER;
  else env.MC_DB_DRIVER = saved.driver;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
  if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
  else env.MC_DASHBOARD_PASSWORD = saved.password;
}

function taskRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    title: "secret-title",
    description: "secret body",
    project: "agent-kontrol",
    platform: "codex",
    machine: null,
    priority: 2,
    status: "queued",
    reviewer_platform: null,
    assigned_agent: null,
    session_id: null,
    result: null,
    cost_usd: null,
    created_by: "dashboard",
    actor_type: null,
    actor_id: null,
    created_at: "2026-11-15T00:00:00.000Z",
    claimed_at: null,
    updated_at: "2026-11-15T00:00:00.000Z",
    completed_at: null,
    receipt_id: 11,
    receipt_kind: "task_claimed",
    receipt_at: "2026-11-15T00:02:00.000Z",
    ...extra,
  };
}

function textOf(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  env.DATABASE_URL = FIXTURE_URL;
  env.MC_DB_DRIVER = "pg";
  env.MC_TOKEN = TOKEN;
  env.MC_DASHBOARD_PASSWORD = "targeted-claim-password";
  setSqlForTests(null);
});

afterEach(() => {
  setSqlForTests(null);
  restoreEnv();
});

function headers(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
}

function post(body: unknown, extra?: { raw?: string; auth?: boolean }) {
  const authed = extra?.auth !== false;
  return claimTask(new Request("http://localhost/api/tasks/claim", {
    method: "POST",
    headers: authed ? headers() : { "content-type": "application/json" },
    body: extra?.raw ?? JSON.stringify(body),
  }));
}

describe("exact task id claim", () => {
  it("accepts only a positive JavaScript safe integer", () => {
    assert.equal(isExactTaskId(1), true);
    assert.equal(isExactTaskId(MAX_SAFE), true);
    for (const value of [null, "1", 1.5, 0, -3, MAX_SAFE + 1, true, false, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(isExactTaskId(value), false, JSON.stringify(String(value)));
    }
  });

  it("rejects a malformed task_id before SQL in configured and demo mode", async () => {
    let calls = 0;
    setSqlForTests(async () => {
      calls += 1;
      throw new Error("rejected task id must not query");
    });
    const bad: unknown[] = [null, "1", 1.5, 0, -3, MAX_SAFE + 1, true, false, [LEAK], { leak: LEAK }];
    for (const task_id of bad) {
      const rejected = await post({ platform: "codex", agent_id: "worker", task_id });
      assert.equal(rejected.status, 400, JSON.stringify(task_id));
      const body = await rejected.json() as { code: string; error: string; fields: Record<string, string> };
      assert.equal(body.code, "validation_failed");
      assert.equal(body.error, "task_id must be a positive safe integer");
      assert.equal(body.fields.task_id, TASK_ID_FIELD);
      assert.equal(JSON.stringify(body).includes(LEAK), false);
    }
    const missingFirst = await post({ project: "not a lane", task_id: LEAK });
    assert.equal(missingFirst.status, 400);
    assert.equal((await missingFirst.json() as { code: string }).code, "missing_field");
    const projectFirst = await post({ platform: "codex", agent_id: "worker", project: "", task_id: LEAK });
    const projectBody = await projectFirst.json() as { code: string; fields: Record<string, string> };
    assert.equal(projectBody.code, "validation_failed");
    assert.equal(typeof projectBody.fields.project, "string");
    assert.equal(projectBody.fields.task_id, undefined);
    assert.equal(JSON.stringify(projectBody).includes(LEAK), false);
    const broken = await post(null, { raw: "{" });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json() as { code: string }).code, "invalid_json");
    const denied = await post({ platform: "codex", agent_id: "worker", task_id: 7 }, { auth: false });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);

    await assert.rejects(
      () => claimNextTask({ platform: "codex", agent_id: "worker", task_id: null }),
      /invalid task id filter/,
    );
    await assert.rejects(
      () => claimTaskWithCoverage({ platform: "codex", agent_id: "worker", task_id: "4" as unknown as number, observer: null }),
      /invalid task id filter/,
    );
    await assert.rejects(
      () => claimNextTask({ platform: "codex", agent_id: "worker", task_id: undefined }),
      /invalid task id filter/,
    );
    assert.equal(calls, 0);

    delete env.DATABASE_URL;
    for (const task_id of bad) {
      const demoRejected = await post({ platform: "codex", agent_id: "worker", task_id });
      assert.equal(demoRejected.status, 400, JSON.stringify(task_id));
      const body = await demoRejected.json() as { code: string; demo?: boolean };
      assert.equal(body.code, "validation_failed");
      assert.equal(body.demo, undefined);
      assert.equal(JSON.stringify(body).includes(LEAK), false);
    }
    const demoCoverage = await post({ platform: "codex", agent_id: "worker", coverage: true, task_id: { leak: LEAK } });
    assert.equal(demoCoverage.status, 400);
    assert.equal(JSON.stringify(await demoCoverage.json()).includes(LEAK), false);
    const demoOmitted = await post({ platform: "codex", agent_id: "worker" });
    assert.deepEqual(await demoOmitted.json(), { task: null, demo: true });
    const demoExact = await post({ platform: "codex", agent_id: "worker", task_id: MAX_SAFE, coverage: true });
    const demoExactBody = await demoExact.json() as { task: null; demo: boolean; coverage: { reason: string; queue_episode: null; notice_id: null } };
    assert.equal(demoExactBody.task, null);
    assert.equal(demoExactBody.demo, true);
    assert.equal(demoExactBody.coverage.reason, "unconfigured");
    assert.equal(demoExactBody.coverage.queue_episode, null);
    assert.equal(demoExactBody.coverage.notice_id, null);
    const demoJunk = await post(null, { raw: "{" });
    assert.deepEqual(await demoJunk.json(), { task: null, demo: true });
    assert.equal(calls, 0);
  });

  it("keeps the id predicate in front of the candidate limit and out of the MCP tool", () => {
    const store = fs.readFileSync("src/lib/store.ts", "utf8");
    const candidates = store.slice(store.indexOf("async function queuedClaimCandidates"), store.indexOf("export async function claimNextTask"));
    const claim = store.slice(store.indexOf("export async function claimNextTask"), store.indexOf("export async function updateTask"));
    const update = store.slice(store.indexOf("export async function updateTask"), store.indexOf("async function taskRevisionOf"));
    const coverage = store.slice(store.indexOf("export async function claimTaskWithCoverage"), store.indexOf("export async function getTask"));
    assert.equal(claim.split("insert into events").length - 1, 1);
    assert.equal(claim.split("with changed as (").length - 1, 1);
    assert.equal(coverage.split("insert into events").length - 1, 1);
    assert.equal(coverage.split("with changed as (").length - 1, 1);
    assert.equal(store.split("claim receipt was not stored").length - 1, 2);
    assert.equal(update.includes("claim receipt was not stored"), false);
    const candidateLower = candidates.toLowerCase();
    assert.ok(candidateLower.indexOf("or id =") < candidateLower.indexOf("order by priority asc"));
    assert.ok(candidateLower.indexOf("or id =") < candidateLower.indexOf("limit 10"));
    assert.match(claim, /or id = \$\{scope\.taskId\}::bigint/);
    assert.match(coverage, /or id = \$\{scope\.taskId\}::bigint/);
    const mcp = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const tool = mcp.slice(mcp.indexOf('"claim_task"'), mcp.indexOf('"update_task"'));
    assert.equal(tool.includes("task_id"), false);
    assert.equal(tool.includes("claimTaskWithCoverage"), false);
    const openapi = fs.readFileSync("src/lib/openapi.ts", "utf8");
    const schema = openapi.slice(openapi.indexOf("ClaimTask:"), openapi.indexOf("PatchTask:"));
    assert.match(schema, /task_id:/);
    assert.match(schema, /minimum: 1/);
    assert.match(schema, /maximum: 9007199254740991/);
    const docs = fs.readFileSync("docs/API.md", "utf8");
    assert.match(docs, /task_id/);
    assert.match(docs, /does not claim another row|claims no other task/);
  });

  it("claims the requested id on the candidate query and the guarded update, and no other row", async () => {
    const seen: { text: string; values: unknown[] }[] = [];
    const updates: unknown[] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = textOf(strings);
      const lower = text.toLowerCase();
      seen.push({ text, values: [...values] });
      if (lower.includes("insert into agents")) return [];
      if (lower.includes("from tasks") && lower.includes("status = 'queued'") && !lower.includes("update tasks")) {
        return [taskRow({ id: 7 }), taskRow({ id: 8, priority: 0 })];
      }
      if (lower.includes("with changed as")) {
        updates.push(values[3]);
        if (values[3] !== 7) throw new Error("fallback update");
        return [taskRow({ id: 7, status: "claimed" })];
      }
      return [];
    });
    const response = await post({
      platform: "codex",
      agent_id: "worker",
      project: "agent-kontrol",
      task_id: 7,
      actor_id: "forged-root",
      actor_type: "human",
      created_by: "forged-root",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { task: { id: number; actor_id: string | null }; coverage?: unknown };
    assert.equal(body.task.id, 7);
    assert.equal(body.coverage, undefined);
    assert.equal(body.task.actor_id, null);
    assert.equal(JSON.stringify(body).includes("forged-root"), false);
    const select = seen.find((call) => call.text.toLowerCase().includes("from tasks") && call.text.toLowerCase().includes("limit"));
    const update = seen.find((call) => call.text.toLowerCase().includes("task_claimed"));
    assert.ok(select);
    assert.ok(update);
    assert.ok(select.text.toLowerCase().indexOf("or id =") < select.text.toLowerCase().indexOf("limit"));
    assert.equal(select.values.includes(7), true);
    assert.equal(select.values.includes(true), true);
    assert.equal(update.values[3], 7);
    assert.equal(update.values[4], true);
    assert.equal(update.values[5], 7);
    assert.equal(update.values.at(-2), "agent");
    assert.equal(update.values.at(-1), LEGACY_ACTOR_ID);
    assert.equal(update.values.includes("forged-root"), false);
    assert.equal(select.values.includes("forged-root"), false);
    assert.deepEqual(updates, [7]);
    const report = seen.find((call) => call.text.toLowerCase().includes("insert into agents"));
    assert.ok(report);
    assert.ok(seen.indexOf(update) < seen.indexOf(report));
    assert.equal(report.text.toLowerCase().includes("with changed as"), false);
    assert.equal(report.values.includes("forged-root"), false);
    assert.equal(report.values.includes(LEGACY_ACTOR_ID), true);
  });

  it("returns task null for a miss and does not claim a competing row or write a report", async () => {
    const updates: unknown[] = [];
    let reports = 0;
    setSqlForTests(async (strings, ...values) => {
      const lower = textOf(strings).toLowerCase();
      if (lower.includes("insert into agents")) {
        reports += 1;
        return [];
      }
      if (lower.includes("with changed as")) {
        updates.push(values[3]);
        return [];
      }
      if (lower.includes("from tasks") && !lower.includes("update tasks")) {
        return [taskRow({ id: 99, priority: 0 }), taskRow({ id: 7 })];
      }
      return [];
    });
    const lost = await post({ platform: "codex", agent_id: "worker", task_id: 7 });
    assert.equal(lost.status, 200);
    assert.deepEqual(await lost.json(), { task: null });
    assert.deepEqual(updates, [7]);
    assert.equal(reports, 0);

    updates.length = 0;
    setSqlForTests(async (strings, ...values) => {
      const lower = textOf(strings).toLowerCase();
      if (lower.includes("with changed as")) {
        updates.push(Number(values[3]));
        throw new Error("a different id must not be updated");
      }
      if (lower.includes("from tasks") && !lower.includes("update tasks")) return [taskRow({ id: 99, priority: 0 })];
      return [];
    });
    const hidden = await post({ platform: "codex", agent_id: "worker", task_id: 7 });
    assert.deepEqual(await hidden.json(), { task: null });
    assert.deepEqual(updates, []);

    const omittedSeen: { text: string; values: unknown[] }[] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = textOf(strings);
      const lower = text.toLowerCase();
      omittedSeen.push({ text, values: [...values] });
      if (lower.includes("insert into agents")) return [];
      if (lower.includes("from tasks") && !lower.includes("update tasks")) return [taskRow({ id: 4, priority: 0 })];
      if (lower.includes("with changed as")) return [taskRow({ id: 4, status: "claimed" })];
      return [];
    });
    const omitted = await post({ platform: "codex", agent_id: "worker", project: "agent-kontrol" });
    assert.equal(omitted.status, 200);
    assert.equal((await omitted.json() as { task: { id: number } }).task.id, 4);
    const omittedSelect = omittedSeen.find((call) => call.text.toLowerCase().includes("limit"));
    const omittedUpdate = omittedSeen.find((call) => call.text.toLowerCase().includes("task_claimed"));
    assert.ok(omittedSelect);
    assert.ok(omittedUpdate);
    assert.equal(omittedSelect.values.at(-2), false);
    assert.equal(omittedSelect.values.at(-1), null);
    assert.equal(omittedUpdate.values[3], 4);
    assert.equal(omittedUpdate.values[4], false);
    assert.equal(omittedUpdate.values[5], null);
    assert.equal(omittedUpdate.values.at(-2), "agent");
    assert.equal(omittedUpdate.values.at(-1), LEGACY_ACTOR_ID);
    assert.match(omittedSelect.text.toLowerCase(), /order by priority asc, created_at asc/);
  });

  it("forwards the largest safe id and stops after that row loses the race", async () => {
    const updates: unknown[] = [];
    setSqlForTests(async (strings, ...values) => {
      const lower = textOf(strings).toLowerCase();
      if (lower.includes("insert into agents")) return [];
      if (lower.includes("from tasks") && !lower.includes("update tasks")) {
        return [taskRow({ id: MAX_SAFE, priority: 5 }), taskRow({ id: 1, priority: 0 })];
      }
      if (lower.includes("with changed as")) {
        updates.push(values[3]);
        return [];
      }
      return [];
    });
    const response = await post({ platform: "codex", agent_id: "worker", task_id: MAX_SAFE });
    assert.deepEqual(await response.json(), { task: null });
    assert.deepEqual(updates, [MAX_SAFE]);
  });

  it("carries the exact id through both coverage paths and keeps a miss from falling through", async () => {
    const observer = { consumer: "dispatcher-1", credentialId: "cred-events", generation: "4" };
    const updates: unknown[] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = textOf(strings);
      const lower = text.toLowerCase();
      if (lower === "begin" || lower === "commit" || lower === "rollback" || lower.startsWith("set local ")) return [];
      if (lower.includes("clock_timestamp") && !lower.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:03:00.000Z" }];
      }
      if (lower.includes("from tasks") && lower.includes("status = 'queued'") && !lower.includes("update tasks")) {
        return [taskRow({ id: 3, priority: 0 }), taskRow({ id: 7 })];
      }
      if (lower.includes("with changed as")) {
        updates.push(values[3]);
        if (values[3] !== 7) return [taskRow({ id: values[3], status: "claimed" })];
        return [taskRow({
          id: 7,
          status: "claimed",
          scanned_rows: 1,
          queue_episode: null,
          notice_id: null,
          notice_at: null,
          observer_generation: "4",
          measured_at: "2026-11-15T00:03:00.000Z",
        })];
      }
      return [];
    });
    const exact = await runWithPrincipal({ kind: "agent", id: "cred-actor", scopes: ["tasks:write"] }, () =>
      claimTaskWithCoverage({ platform: "codex", agent_id: "worker", project: "agent-kontrol", task_id: 7, observer }),
    );
    assert.equal(exact.task?.id, 7);
    assert.equal(exact.coverage.queue_episode, null);
    assert.equal(exact.coverage.notice_id, null);
    assert.deepEqual(updates, [7]);
    assert.equal(updates.includes(3), false);

    updates.length = 0;
    setSqlForTests(async (strings, ...values) => {
      const lower = textOf(strings).toLowerCase();
      if (lower === "begin" || lower === "commit" || lower === "rollback" || lower.startsWith("set local ")) return [];
      if (lower.includes("clock_timestamp") && !lower.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:04:00.000Z" }];
      }
      if (lower.includes("from tasks") && !lower.includes("update tasks")) {
        return [taskRow({ id: 3, priority: 0 })];
      }
      if (lower.includes("with changed as")) {
        updates.push(Number(values[3]));
        return [];
      }
      return [];
    });
    const missed = await claimTaskWithCoverage({
      platform: "codex",
      agent_id: "worker",
      task_id: 7,
      observer,
    });
    assert.equal(missed.task, null);
    assert.equal(missed.coverage.reason, "no_claim");
    assert.equal(missed.coverage.evidence, "unknown");
    assert.equal(missed.coverage.queue_episode, null);
    assert.equal(missed.coverage.notice_id, null);
    assert.deepEqual(updates, []);

    const ineligible = await claimTaskWithCoverage({
      platform: "codex",
      agent_id: "worker",
      task_id: 7,
      observer: null,
    });
    assert.equal(ineligible.task, null);
    assert.equal(ineligible.coverage.reason, "ineligible_observer");
    assert.equal(ineligible.coverage.queue_episode, null);
    assert.equal(ineligible.coverage.notice_id, null);
    assert.deepEqual(updates, []);
  });

  it("returns 500 when the status report throws after the claim statement", async () => {
    const seen: string[] = [];
    setSqlForTests(async (strings) => {
      const lower = textOf(strings).toLowerCase();
      seen.push(lower);
      if (lower.includes("insert into agents")) throw new Error("report failed");
      if (lower.includes("from tasks") && !lower.includes("update tasks")) return [taskRow()];
      if (lower.includes("with changed as")) return [taskRow({ status: "claimed" })];
      return [];
    });
    const response = await post({ platform: "codex", agent_id: "worker", task_id: 7 });
    assert.equal(response.status, 500);
    assert.equal((await response.json() as { code: string }).code, "internal_error");
    const claimAt = seen.findIndex((text) => text.includes("task_claimed"));
    const reportAt = seen.findIndex((text) => text.includes("insert into agents"));
    assert.ok(claimAt >= 0);
    assert.ok(reportAt > claimAt);
  });

  it("answers a coverage miss from the route without notice ids", async () => {
    setSqlForTests(async (strings) => {
      const lower = textOf(strings).toLowerCase();
      if (lower.includes("clock_timestamp") && !lower.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:05:00.000Z" }];
      }
      if (lower.includes("update tasks")) throw new Error("route miss must not update");
      return [];
    });
    const response = await post({ platform: "codex", agent_id: "worker", task_id: 7, coverage: true });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: null; coverage: { reason: string; queue_episode: null; notice_id: null } };
    assert.equal(body.task, null);
    assert.equal(body.coverage.reason, "ineligible_observer");
    assert.equal(body.coverage.queue_episode, null);
    assert.equal(body.coverage.notice_id, null);
  });
});
