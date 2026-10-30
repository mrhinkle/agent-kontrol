/**
 * Demo mode (no DATABASE_URL) keeps the five MCP writes in memory.
 * Each case below is written to fail if that behaviour is stubbed,
 * unlabeled, unbounded, or mixed into the sample dashboard data.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { actorFromPrincipal, currentActor, runWithActor } from "../../src/lib/actor";
import { mcpToolError } from "../../src/lib/api-error";
import { setSqlForTests } from "../../src/lib/db";
import { demoMemory, demoTasks } from "../../src/lib/demo-data";
import {
  DEMO_BANNER,
  DEMO_CAPS,
  DEMO_EMPTY_CLAIM,
  demoClaimNextTask,
  demoClaimTaskTool,
  demoCreateTask,
  demoCreateTaskTool,
  demoFleetStatusTool,
  demoGetTask,
  demoListTasks,
  demoRecall,
  demoRecallTool,
  demoRemember,
  demoRememberTool,
  demoReport,
  demoReportStatusTool,
  demoSessionsForTests,
  demoStoreSize,
  demoStoreTouchCount,
  demoTaskQueueTool,
  demoUpdateTask,
  demoUpdateTaskTool,
  resetDemoStoreForTests,
  setDemoClockForTests,
  type DemoCreateTaskInput,
} from "../../src/lib/demo-store";
import { rememberForTool, updateTaskForTool } from "../../src/lib/dry-run-actions";
import { IdempotencyConflict, IdempotencyKeyInvalid, IDEMPOTENCY_TTL_MS } from "../../src/lib/idempotency";
import { listSkillsTool } from "../../src/lib/skills/mcp";
import { report } from "../../src/lib/store";
import { GET as getFleet } from "../../src/app/api/fleet/route";
import { GET as getMemory, POST as postMemory } from "../../src/app/api/memory/route";
import { GET as getDigest } from "../../src/app/api/progress/digest/route";
import { PATCH as patchTask } from "../../src/app/api/tasks/[id]/route";
import { GET as getTasks, POST as postTasks } from "../../src/app/api/tasks/route";

const SAMPLE_TASK = "Add speaker headshots to conference page";
const PROBE = "probe-agent-f9";

function assertLabeled(text: string): void {
  assert.equal(text.startsWith(`${DEMO_BANNER}\n`), true, text.slice(0, 120));
  assert.equal(text.includes("in-memory"), true);
  assert.equal(text.includes("restarts"), true);
}

function jsonCall(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("demo store", () => {
  const saved = {
    db: process.env.DATABASE_URL,
    password: process.env.MC_DASHBOARD_PASSWORD,
  };

  beforeEach(() => {
    resetDemoStoreForTests();
    setDemoClockForTests(null);
    setSqlForTests(null);
  });

  afterEach(() => {
    setDemoClockForTests(null);
    setSqlForTests(null);
    if (saved.db === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.db;
    if (saved.password === undefined) delete process.env.MC_DASHBOARD_PASSWORD;
    else process.env.MC_DASHBOARD_PASSWORD = saved.password;
  });

  it("F1: a configured process never touches the demo store, and demo mode never calls SQL", async () => {
    const route = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const actions = fs.readFileSync("src/lib/dry-run-actions.ts", "utf8");
    const demo = fs.readFileSync("src/lib/demo-store.ts", "utf8");
    assert.equal(/from ["']\.\/db["']/.test(demo), false);
    assert.equal(/from ["']\.\/store["']/.test(demo), false);
    assert.equal(/\bsql\(/.test(demo), false);

    const linesOf = (source: string) => source.split("\n");
    for (const call of [
      "demoReportStatusTool(",
      "demoFleetStatusTool(",
      "demoRecallTool(",
      "demoCreateTaskTool(",
      "demoTaskQueueTool(",
      "demoClaimTaskTool(",
    ]) {
      const lines = linesOf(route);
      const index = lines.findIndex((line) => line.includes(call));
      assert.ok(index > 0, call);
      const window = `${lines[index - 1] ?? ""}\n${lines[index]}`;
      assert.match(window, /!isConfigured\(\)/, call);
    }
    for (const call of ["demoRememberTool(", "demoUpdateTaskTool("]) {
      const lines = linesOf(actions);
      const index = lines.findIndex((line) => line.includes(call));
      assert.ok(index > 0, call);
      const window = `${lines[index - 1] ?? ""}\n${lines[index]}`;
      assert.match(window, /!isConfigured\(\)/, call);
    }

    const touchBefore = demoStoreTouchCount();
    let sqlCalls = 0;
    process.env.DATABASE_URL = "postgres://demo-store-f1.invalid/kontrol";
    setSqlForTests(async () => {
      sqlCalls += 1;
      return [
        {
          id: 1,
          key: "f1-key",
          content: "configured",
          tags: [],
          agent_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
    });
    const stored = await rememberForTool({ content: "configured", key: "f1-key" });
    assert.match(stored.content[0].text, /^Stored memory #/);
    assert.equal(stored.content[0].text.includes(DEMO_BANNER), false);
    assert.equal(stored.content[0].text.includes("in-memory"), false);
    await report({ agent_id: "f1-configured", kind: "status", title: "configured" }).catch(() => undefined);
    const configuredUpdate = await updateTaskForTool({ id: 1, status: "done" });
    assert.equal(configuredUpdate.content[0].text.includes(DEMO_BANNER), false);
    assert.ok(sqlCalls > 0, "configured writes did not reach SQL");
    assert.equal(demoStoreTouchCount(), touchBefore);
    assert.equal(demoStoreSize().tasks, 0);
    assert.equal(demoStoreSize().notes, 0);
    assert.equal(demoStoreSize().agents, 0);

    delete process.env.DATABASE_URL;
    sqlCalls = 0;
    setSqlForTests(async () => {
      sqlCalls += 1;
      throw new Error("demo mode wrote to the database");
    });
    const demoNote = await rememberForTool({ content: "demo-only", key: "f1-demo" });
    assertLabeled(demoNote.content[0].text);
    const demoStatus = await demoReportStatusTool({ agent_id: "f1-demo-agent", title: "hello" });
    assertLabeled(demoStatus.content[0].text);
    const demoTask = await demoCreateTaskTool({ title: "f1 task" }, null);
    assertLabeled(demoTask.content[0].text);
    const missing = await updateTaskForTool({ id: 424242, status: "done" });
    assert.equal(missing.isError, true);
    assert.equal(sqlCalls, 0);
    assert.ok(demoStoreTouchCount() > touchBefore);
    assert.equal(demoStoreSize().notes, 1);
    assert.equal(demoStoreSize().agents, 1);
    assert.equal(demoStoreSize().tasks, 1);
  });

  it("F2: every demo-store response is labeled demo, and the docs say it clears on restart", async () => {
    const emptyFleet = await demoFleetStatusTool();
    assertLabeled(emptyFleet.content[0].text);
    assert.match(emptyFleet.content[0].text, /No agents have reported/);

    const reported = await demoReportStatusTool({ agent_id: "label-agent", title: "working" });
    assertLabeled(reported.content[0].text);
    const fleet = await demoFleetStatusTool();
    assertLabeled(fleet.content[0].text);
    assert.match(fleet.content[0].text, /label-agent/);

    const noted = await demoRememberTool({ content: "labeled note", key: "label-key" });
    assertLabeled(noted.content[0].text);
    const recalled = await demoRecallTool({ key: "label-key" });
    assertLabeled(recalled.content[0].text);
    const emptyRecall = await demoRecallTool({ key: "missing-label-key" });
    assertLabeled(emptyRecall.content[0].text);
    assert.match(emptyRecall.content[0].text, /No matching memory/);

    const created = await demoCreateTaskTool({ title: "labeled task", platform: "grok" }, null);
    assertLabeled(created.content[0].text);
    const queue = await demoTaskQueueTool({});
    assertLabeled(queue.content[0].text);
    const claimed = await demoClaimTaskTool({ platform: "grok", agent_id: "label-agent" });
    assertLabeled(claimed.content[0].text);
    const id = Number(claimed.content[0].text.match(/Claimed task #(\d+)/)?.[1]);
    assert.ok(id > 0);
    const updated = await demoUpdateTaskTool({ id, status: "done", result: "finished" });
    assertLabeled(updated.content[0].text);
    const emptyClaim = await demoClaimTaskTool({ platform: "grok", agent_id: "label-agent" });
    assertLabeled(emptyClaim.content[0].text);

    const arch = fs.readFileSync("docs/ARCHITECTURE.md", "utf8");
    const deploy = fs.readFileSync("docs/DEPLOY.md", "utf8");
    for (const doc of [arch, deploy]) {
      assert.match(doc, /in-memory/);
      assert.match(doc, /cleared when the process restarts/);
    }
  });

  it("F3: a second claim of the same task loses, and two queued tasks produce two winners", async () => {
    const route = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const store = fs.readFileSync("src/lib/store.ts", "utf8");
    assert.match(route, /No queued tasks for your platform\./);
    assert.match(store, /where id = \$\{t\.id\} and status = 'queued'/);
    assert.equal(DEMO_EMPTY_CLAIM, "No queued tasks for your platform.");

    const task = await demoCreateTask({ title: "only one", platform: "grok" });
    const [first, second] = await Promise.all([
      demoClaimNextTask({ platform: "grok", agent_id: "racer-a" }),
      demoClaimNextTask({ platform: "grok", agent_id: "racer-b" }),
    ]);
    const winners = [first, second].filter((row) => row != null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.id, task.id);
    assert.equal(winners[0]?.status, "claimed");
    const agents = new Set(winners.map((row) => row?.assigned_agent));
    assert.equal(agents.size, 1);
    const stored = await demoGetTask(task.id);
    assert.equal(stored?.status, "claimed");
    assert.equal(stored?.assigned_agent, winners[0]?.assigned_agent);

    const again = await demoClaimTaskTool({ platform: "grok", agent_id: "racer-c" });
    assert.equal(again.isError, undefined);
    assert.match(again.content[0].text, /No queued tasks for your platform\./);
    assert.equal(again.content[0].text.includes("task_not_claimable"), false);
    assert.equal(again.content[0].text.includes("only one"), false);

    await demoUpdateTask({ id: task.id, status: "done" });
    const afterDone = await demoClaimNextTask({ platform: "grok", agent_id: "racer-d" });
    assert.equal(afterDone, null);

    resetDemoStoreForTests();
    const low = await demoCreateTask({ title: "first queued", platform: "hermes", priority: 1 });
    const high = await demoCreateTask({ title: "second queued", platform: "hermes", priority: 2 });
    const [left, right] = await Promise.all([
      demoClaimNextTask({ platform: "hermes", agent_id: "racer-a" }),
      demoClaimNextTask({ platform: "hermes", agent_id: "racer-b" }),
    ]);
    assert.ok(left);
    assert.ok(right);
    assert.notEqual(left.id, right.id);
    assert.deepEqual([left.id, right.id].sort(), [low.id, high.id].sort());
    const claimedIds = new Set([left.assigned_agent, right.assigned_agent]);
    assert.equal(claimedIds.size, 2);
  });

  it("F4: update_task on a missing id returns the real task_not_found shape", async () => {
    const expected = mcpToolError("task_not_found");
    const result = await demoUpdateTaskTool({ id: 999999, status: "done", result: "missing" });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(expected.content[0].text));
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    assert.equal(body.error, "Task not found");
    assert.equal(body.code, "task_not_found");
    assert.equal(body.retryable, false);
    assert.equal(Object.hasOwn(body, "fields"), false);
    assert.equal(result.content[0].text.includes(DEMO_BANNER), false);
    assert.equal(result.content[0].text.includes("demo"), false);
    await assert.rejects(() => demoUpdateTask({ id: 999999, status: "done" }), /Task not found/);
    assert.equal(demoStoreSize().tasks, 0);

    const preview = await demoUpdateTaskTool({ id: 999999, status: "cancelled", dry_run: true });
    assert.deepEqual(JSON.parse(preview.content[0].text), JSON.parse(expected.content[0].text));
    assert.equal(demoStoreSize().tasks, 0);
  });

  it("F5: tasks, notes, and agents stop growing at the cap, and cap+1 drops the oldest", async () => {
    for (let i = 0; i < DEMO_CAPS.tasks; i++) {
      await demoCreateTask({ title: `task-${i}` });
    }
    assert.equal(demoStoreSize().tasks, DEMO_CAPS.tasks);
    assert.ok(await demoGetTask(1));
    const overflow = await demoCreateTask({ title: "task-overflow" });
    assert.equal(demoStoreSize().tasks, DEMO_CAPS.tasks);
    assert.equal(await demoGetTask(1), null);
    const tasks = await demoListTasks({ status: "all", limit: DEMO_CAPS.tasks + 5 });
    assert.equal(tasks.length, DEMO_CAPS.tasks);
    assert.ok(tasks.some((task) => task.id === overflow.id && task.title === "task-overflow"));
    assert.equal(tasks.some((task) => task.title === "task-0"), false);

    resetDemoStoreForTests();
    for (let i = 0; i < DEMO_CAPS.notes; i++) {
      await demoRemember({ content: `note-${i}` });
    }
    assert.equal(demoStoreSize().notes, DEMO_CAPS.notes);
    const atCap = await demoRecall({ limit: DEMO_CAPS.notes + 5 });
    assert.equal(atCap.length, DEMO_CAPS.notes);
    assert.ok(atCap.some((note) => note.content === "note-0"));
    await demoRemember({ content: "note-overflow" });
    assert.equal(demoStoreSize().notes, DEMO_CAPS.notes);
    const notes = await demoRecall({ limit: DEMO_CAPS.notes + 5 });
    assert.equal(notes.length, DEMO_CAPS.notes);
    assert.equal(notes.some((note) => note.content === "note-0"), false);
    assert.ok(notes.some((note) => note.content === "note-overflow"));

    resetDemoStoreForTests();
    for (let i = 0; i < DEMO_CAPS.agents; i++) {
      await demoReport({ agent_id: `ag-${i}`, kind: "status", title: "present" });
    }
    assert.equal(demoStoreSize().agents, DEMO_CAPS.agents);
    const full = await demoFleetStatusTool();
    assert.match(full.content[0].text, /- ag-0 \[/);
    await demoReport({ agent_id: "ag-overflow", kind: "status", title: "present" });
    assert.equal(demoStoreSize().agents, DEMO_CAPS.agents);
    const fleet = await demoFleetStatusTool();
    assert.match(fleet.content[0].text, /ag-overflow/);
    assert.equal(/- ag-0 \[/.test(fleet.content[0].text), false);

    const upserted = await demoRemember({ content: "same agent stays", key: "cap-key", agent_id: "ag-overflow" });
    await demoRemember({ content: "same agent stays", key: "cap-key", agent_id: "ag-overflow" });
    assert.equal(demoStoreSize().notes, 1);
    assert.equal((await demoRecall({ key: "cap-key" }))[0]?.id, upserted.id);
    assert.equal(demoStoreSize().agents, DEMO_CAPS.agents);
  });

  it("F6: actor fields come from the credential, not from request fields", async () => {
    const spoof = {
      title: "spoofed task",
      created_by: "spoofed-human",
      actor_type: "human",
      actor_id: "operator",
    };
    const text = await runWithActor({ actor_type: "agent", actor_id: "cred-9" }, () =>
      demoCreateTaskTool(spoof, currentActor()),
    );
    const id = Number(text.content[0].text.match(/Task #(\d+)/)?.[1]);
    const stored = await demoGetTask(id);
    assert.equal(stored?.actor_type, "agent");
    assert.equal(stored?.actor_id, "cred-9");
    assert.equal(stored?.created_by, "spoofed-human");
    assert.equal(text.content[0].text.includes("cred-9"), false);
    assert.equal(text.content[0].text.includes("spoofed-human"), false);

    const direct = await demoCreateTask({
      title: "direct spoof",
      created_by: "pretend-operator",
      actor: actorFromPrincipal({ kind: "agent", id: "cred-9", scopes: ["tasks:write"] }),
      ...({ actor_type: "human", actor_id: "operator" } as object),
    } as DemoCreateTaskInput);
    assert.equal(direct.actor_type, "agent");
    assert.equal(direct.actor_id, "cred-9");
    assert.equal(direct.created_by, "pretend-operator");

    const legacy = await demoCreateTask({
      title: "legacy token",
      created_by: "whoever",
      actor: actorFromPrincipal({ kind: "legacy" }),
    });
    assert.equal(legacy.actor_type, "agent");
    assert.equal(legacy.actor_id, "mc-token");

    const operator = await demoCreateTask({
      title: "dashboard",
      created_by: "not-the-actor",
      actor: actorFromPrincipal({ kind: "session" }),
    });
    assert.equal(operator.actor_type, "human");
    assert.equal(operator.actor_id, "operator");
    assert.equal(operator.created_by, "not-the-actor");

    const open = await demoCreateTask({
      title: "dev open",
      created_by: "operator",
      actor: actorFromPrincipal({ kind: "dev-open" }),
    });
    assert.equal(open.actor_type, null);
    assert.equal(open.actor_id, null);
    assert.equal(open.created_by, "operator");
  });

  it("F7: idempotency replays the original task, and dry_run writes nothing", async () => {
    const actor = { actor_type: "agent" as const, actor_id: "cred-1" };
    const first = await demoCreateTask({
      title: "same title",
      platform: "grok",
      priority: 1,
      actor,
      idempotency_key: "create-1",
    });
    const replay = await demoCreateTask({
      title: "same title",
      platform: "grok",
      priority: 1,
      actor,
      idempotency_key: "create-1",
    });
    assert.equal(replay.id, first.id);
    assert.equal(demoStoreSize().tasks, 1);
    await demoUpdateTask({ id: first.id, status: "done", result: "finished" });
    const afterWrite = await demoCreateTask({
      title: "same title",
      platform: "grok",
      priority: 1,
      actor,
      idempotency_key: "create-1",
    });
    assert.equal(afterWrite.id, first.id);
    assert.equal(afterWrite.status, "queued");
    assert.equal(afterWrite.result, null);
    assert.equal((await demoGetTask(first.id))?.status, "done");

    await assert.rejects(
      () =>
        demoCreateTask({
          title: "different title",
          platform: "grok",
          priority: 1,
          actor,
          idempotency_key: "create-1",
        }),
      (err: unknown) =>
        err instanceof IdempotencyConflict &&
        err.message === "This idempotency key was already used with different arguments.",
    );
    assert.equal(demoStoreSize().tasks, 1);

    const otherActor = await demoCreateTask({
      title: "same title",
      platform: "grok",
      priority: 1,
      actor: { actor_type: "agent", actor_id: "cred-2" },
      idempotency_key: "create-1",
    });
    assert.notEqual(otherActor.id, first.id);

    await assert.rejects(
      () => demoCreateTask({ title: "bad key", idempotency_key: "bad\nkey" }),
      (err: unknown) =>
        err instanceof IdempotencyKeyInvalid &&
        err.message === "Use 1 to 200 characters and no control characters, or omit the key.",
    );
    await assert.rejects(
      () => demoCreateTask({ title: "bad type", idempotency_key: 12 as unknown as string }),
      (err: unknown) => err instanceof IdempotencyKeyInvalid && err.message === "idempotency_key must be a string.",
    );

    setDemoClockForTests(() => 1_000);
    const timed = await demoCreateTask({ title: "timed", actor, idempotency_key: "ttl-key" });
    setDemoClockForTests(() => 1_000 + IDEMPOTENCY_TTL_MS + 1);
    const expired = await demoCreateTask({ title: "timed", actor, idempotency_key: "ttl-key" });
    assert.notEqual(expired.id, timed.id);
    setDemoClockForTests(null);

    resetDemoStoreForTests();
    const inserted = await demoRememberTool({ content: "kept", key: "dry-key", agent_id: "grok" });
    assertLabeled(inserted.content[0].text);
    const preview = await demoRememberTool({
      content: "ghost content",
      key: "ghost-key",
      agent_id: "grok",
      dry_run: true,
    });
    const previewBody = JSON.parse(preview.content[0].text) as { dry_run: boolean; applied: boolean; would_write: boolean; action: string };
    assert.equal(preview.isError, undefined);
    assert.equal(previewBody.dry_run, true);
    assert.equal(previewBody.applied, false);
    assert.equal(previewBody.would_write, true);
    assert.equal(previewBody.action, "insert_memory");
    assert.equal(demoStoreSize().notes, 1);
    const overwrite = await demoRememberTool({
      content: "replacement that must not land",
      key: "dry-key",
      dry_run: true,
    });
    const overwriteBody = JSON.parse(overwrite.content[0].text) as { action: string; would_write: boolean; applied: boolean };
    assert.equal(overwriteBody.action, "overwrite_memory");
    assert.equal(overwriteBody.would_write, true);
    assert.equal(overwriteBody.applied, false);
    assert.equal((await demoRecall({ key: "dry-key" }))[0]?.content, "kept");

    for (const bad of ["true", 0, {}] as const) {
      const rejected = await demoRememberTool({ content: "nope", key: "nope-key", dry_run: bad });
      assert.equal(rejected.isError, true);
      const body = JSON.parse(rejected.content[0].text) as { code: string; error: string };
      assert.equal(body.code, "validation_failed");
      assert.equal(body.error, "dry_run must be a boolean.");
    }
    assert.equal(demoStoreSize().notes, 1);
    assert.equal((await demoRecall({ key: "nope-key" })).length, 0);
    assert.equal((await demoRecall({ key: "ghost-key" })).length, 0);

    const task = await demoCreateTask({ title: "preview me" });
    const taskPreview = await demoUpdateTaskTool({ id: task.id, status: "done", dry_run: true });
    const taskBody = JSON.parse(taskPreview.content[0].text) as { dry_run: boolean; applied: boolean; would_write: boolean };
    assert.equal(taskBody.dry_run, true);
    assert.equal(taskBody.applied, false);
    assert.equal(taskBody.would_write, true);
    assert.equal((await demoGetTask(task.id))?.status, "queued");
    const badTask = await demoUpdateTaskTool({ id: task.id, status: "done", dry_run: "true" });
    assert.equal(badTask.isError, true);
    assert.equal(JSON.parse(badTask.content[0].text).error, "dry_run must be a boolean.");
    assert.equal((await demoGetTask(task.id))?.status, "queued");
  });

  it("F8: a memory key upserts one row, and recall is shared across agents the way the database is", async () => {
    const store = fs.readFileSync("src/lib/store.ts", "utf8");
    const recallStart = store.indexOf("export async function recall");
    const recallEnd = store.indexOf("function asMessage", recallStart);
    assert.ok(recallStart > 0 && recallEnd > recallStart);
    const realRecall = store.slice(recallStart, recallEnd);
    assert.equal(/agent_id\s*=/.test(realRecall), false, "real recall started scoping by agent; demo must follow");

    const demo = fs.readFileSync("src/lib/demo-store.ts", "utf8");
    const demoStart = demo.indexOf("function recallUnlocked");
    const demoEnd = demo.indexOf("export function demoRecall", demoStart);
    assert.equal(/agent_id/.test(demo.slice(demoStart, demoEnd)), false);

    const first = await demoRemember({
      content: "first body",
      key: "shared-key",
      agent_id: "agent-a",
      tags: ["one"],
    });
    const second = await demoRemember({
      content: "second body",
      key: "shared-key",
      agent_id: "agent-b",
      tags: ["two"],
    });
    assert.equal(second.id, first.id);
    assert.equal(demoStoreSize().notes, 1);
    assert.equal(second.content, "second body");
    assert.equal(second.agent_id, "agent-b");
    assert.deepEqual(second.tags, ["two"]);

    const byKey = await demoRecall({ key: "shared-key" });
    assert.equal(byKey.length, 1);
    assert.equal(byKey[0]?.content, "second body");
    const text = await demoRecallTool({ key: "shared-key" });
    assert.match(text.content[0].text, /second body/);
    assert.match(text.content[0].text, /agent-b/);
    assert.equal(text.content[0].text.includes("first body"), false);

    await demoRemember({ content: "only-a", key: "key-a", agent_id: "agent-a" });
    await demoRemember({ content: "only-b", key: "key-b", agent_id: "agent-b" });
    const all = await demoRecall({ limit: 20 });
    assert.ok(all.some((note) => note.content === "only-a" && note.agent_id === "agent-a"));
    assert.ok(all.some((note) => note.content === "only-b" && note.agent_id === "agent-b"));
    const unfiltered = await demoRecallTool({});
    assert.match(unfiltered.content[0].text, /only-a/);
    assert.match(unfiltered.content[0].text, /only-b/);
  });

  it("F9: sample REST reads stay sample, and MCP reads return only the in-memory store", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.MC_DASHBOARD_PASSWORD;

    const fleetBefore = await (await getFleet(new Request("http://x/api/fleet"))).json() as {
      demo: boolean;
      agents: { id: string }[];
      events: unknown[];
      generated_at: string;
    };
    assert.equal(fleetBefore.demo, true);
    assert.ok(fleetBefore.agents.some((agent) => agent.id === "cowork-cloud-1"));
    assert.deepEqual(Object.keys(fleetBefore).sort(), ["agents", "demo", "events", "generated_at"]);

    const memoryBefore = await (await getMemory(new Request("http://x/api/memory"))).json() as {
      demo: boolean;
      items: { key: string | null }[];
    };
    assert.equal(memoryBefore.demo, true);
    assert.ok(memoryBefore.items.some((item) => item.key === "agent-kontrol/decisions"));
    assert.equal(memoryBefore.items.length, demoMemory().length);

    const tasksBefore = await (await getTasks(new Request("http://x/api/tasks"))).json() as {
      demo: boolean;
      tasks: { title: string }[];
    };
    assert.equal(tasksBefore.demo, true);
    assert.ok(tasksBefore.tasks.some((task) => task.title === SAMPLE_TASK));
    assert.equal(tasksBefore.tasks.length, demoTasks().length);

    const digestBefore = await getDigest(new Request("http://x/api/progress/digest"));
    const digestText = await digestBefore.text();
    assert.match(digestText, /\[demo mode — no database connected\]/);
    assert.match(digestText, /App Server/);

    const skillsBefore = await listSkillsTool({});
    assert.match(skillsBefore.content[0].text, /verify-gibson/);
    assert.match(skillsBefore.content[0].text, /runtime filter: none \(caller did not pass runtime\)\./);

    const emptyMcp = await demoFleetStatusTool();
    assert.match(emptyMcp.content[0].text, /No agents have reported in this process/);
    assert.equal(emptyMcp.content[0].text.includes("cowork-cloud-1"), false);

    await demoReport({ agent_id: PROBE, kind: "status", title: "probe status" });
    await demoRemember({ content: "probe-note-f9", key: "probe-key-f9", agent_id: PROBE });
    await demoCreateTask({ title: "probe-task-f9", platform: "grok" });

    const fleetAfter = await (await getFleet(new Request("http://x/api/fleet"))).json() as {
      agents: { id: string }[];
    };
    assert.equal(JSON.stringify(fleetAfter).includes(PROBE), false);
    assert.ok(fleetAfter.agents.some((agent) => agent.id === "cowork-cloud-1"));
    assert.deepEqual(Object.keys(fleetAfter).sort(), ["agents", "demo", "events", "generated_at"]);

    const memoryAfter = await (await getMemory(new Request("http://x/api/memory"))).json();
    assert.equal(JSON.stringify(memoryAfter).includes("probe-note-f9"), false);
    assert.equal(JSON.stringify(memoryAfter).includes("probe-key-f9"), false);
    assert.ok((memoryAfter as { items: { key: string | null }[] }).items.some((item) => item.key === "agent-kontrol/decisions"));

    const tasksAfter = await (await getTasks(new Request("http://x/api/tasks"))).json();
    assert.equal(JSON.stringify(tasksAfter).includes("probe-task-f9"), false);
    assert.ok((tasksAfter as { tasks: { title: string }[] }).tasks.some((task) => task.title === SAMPLE_TASK));

    const digestAfter = await (await getDigest(new Request("http://x/api/progress/digest"))).text();
    assert.match(digestAfter, /\[demo mode — no database connected\]/);
    assert.match(digestAfter, /App Server/);
    assert.equal(digestAfter.includes(PROBE), false);

    const skillsAfter = await listSkillsTool({});
    assert.equal(skillsAfter.content[0].text, skillsBefore.content[0].text);

    const mcpFleet = await demoFleetStatusTool();
    assert.match(mcpFleet.content[0].text, new RegExp(PROBE));
    assert.equal(mcpFleet.content[0].text.includes("cowork-cloud-1"), false);
    const mcpRecall = await demoRecallTool({});
    assert.match(mcpRecall.content[0].text, /probe-note-f9/);
    assert.equal(mcpRecall.content[0].text.includes("agent-kontrol/decisions"), false);
    const mcpQueue = await demoTaskQueueTool({ status: "all" });
    assert.match(mcpQueue.content[0].text, /probe-task-f9/);
    assert.equal(mcpQueue.content[0].text.includes(SAMPLE_TASK), false);

    const droppedTask = await postTasks(jsonCall("http://x/api/tasks", { title: "rest-dropped-f9" }));
    const droppedTaskBody = await droppedTask.json() as { ok: boolean; demo: boolean };
    assert.equal(droppedTask.status, 200);
    assert.equal(droppedTaskBody.ok, true);
    assert.equal(droppedTaskBody.demo, true);
    const droppedNote = await postMemory(jsonCall("http://x/api/memory", {
      content: "rest-note-f9",
      key: "rest-key-f9",
    }));
    const droppedNoteBody = await droppedNote.json() as { ok: boolean; demo: boolean; note: string };
    assert.equal(droppedNoteBody.demo, true);
    assert.match(droppedNoteBody.note, /note not stored/);
    const patched = await patchTask(jsonCall("http://x/api/tasks/999999", { status: "done" }), {
      params: Promise.resolve({ id: "999999" }),
    });
    const patchedBody = await patched.json() as { ok: boolean; demo: boolean; code?: string };
    assert.equal(patched.status, 200);
    assert.equal(patchedBody.ok, true);
    assert.equal(patchedBody.demo, true);
    assert.equal(patchedBody.code, undefined);

    const queueAfterRest = await demoTaskQueueTool({ status: "all" });
    assert.equal(queueAfterRest.content[0].text.includes("rest-dropped-f9"), false);
    const recallAfterRest = await demoRecall({ key: "rest-key-f9" });
    assert.equal(recallAfterRest.length, 0);
    const stillMissing = await demoUpdateTaskTool({ id: 999999, status: "done" });
    assert.equal(stillMissing.isError, true);
    assert.equal(JSON.parse(stillMissing.content[0].text).code, "task_not_found");

    const tasksStillSample = await (await getTasks(new Request("http://x/api/tasks"))).json();
    assert.equal(JSON.stringify(tasksStillSample).includes("rest-dropped-f9"), false);
    assert.equal(JSON.stringify(tasksStillSample).includes("probe-task-f9"), false);
  });

  it("F10: report_status with a fresh session id cannot grow one agent's sessions without a cap", async () => {
    let clock = 1_700_000_000_000;
    setDemoClockForTests(() => clock);
    const extra = 25;
    const floodCount = DEMO_CAPS.sessionsPerAgent + extra;
    for (let i = 0; i < floodCount; i++) {
      clock += 1000;
      await demoReportStatusTool({
        agent_id: "flood",
        session_id: `sess-${i}`,
        title: `title-${i}`,
      });
    }
    const flood = demoSessionsForTests().filter((session) => session.agent_id === "flood");
    assert.equal(demoStoreSize().agents, 1);
    assert.equal(flood.length, DEMO_CAPS.sessionsPerAgent);
    assert.equal(demoStoreSize().sessions, DEMO_CAPS.sessionsPerAgent);
    assert.equal(flood.some((session) => session.id === "sess-0"), false);
    assert.equal(flood.some((session) => session.id === `sess-${floodCount - 1}`), true);

    clock += 1000;
    await demoReportStatusTool({
      agent_id: "flood",
      session_id: `sess-${floodCount - 1}`,
      title: "still here",
    });
    assert.equal(
      demoSessionsForTests().filter((session) => session.agent_id === "flood").length,
      DEMO_CAPS.sessionsPerAgent,
    );

    for (let i = 0; i < DEMO_CAPS.sessionsPerAgent; i++) {
      clock += 1000;
      await demoReportStatusTool({
        agent_id: "other",
        session_id: `other-${i}`,
        title: `other-${i}`,
      });
    }
    assert.equal(demoStoreSize().sessions, DEMO_CAPS.sessionsPerAgent * 2);
    assert.equal(demoSessionsForTests().filter((session) => session.agent_id === "flood").length, DEMO_CAPS.sessionsPerAgent);
    assert.equal(demoSessionsForTests().filter((session) => session.agent_id === "other").length, DEMO_CAPS.sessionsPerAgent);

    const fleet = await demoFleetStatusTool();
    assert.match(fleet.content[0].text, /flood/);
    assert.match(fleet.content[0].text, /still here/);
    assert.match(fleet.content[0].text, new RegExp(`other-${DEMO_CAPS.sessionsPerAgent - 1}`));

    const mcp = fs.readFileSync("docs/MCP.md", "utf8");
    assert.match(mcp, /Sessions are capped per agent/);
    assert.match(mcp, /does not start with that banner/);
  });

  it("F11: a task evicted at the cap still replays its idempotency key for 24 hours", async () => {
    const actor = { actor_type: "agent" as const, actor_id: "cred-cap" };
    setDemoClockForTests(() => 5_000);
    const first = await demoCreateTask({
      title: "original",
      platform: "grok",
      priority: 2,
      actor,
      idempotency_key: "K",
    });
    for (let i = 0; i < DEMO_CAPS.tasks; i++) {
      await demoCreateTask({ title: `filler-${i}` });
    }
    assert.equal(demoStoreSize().tasks, DEMO_CAPS.tasks);
    assert.equal(await demoGetTask(first.id), null);

    const replay = await demoCreateTask({
      title: "original",
      platform: "grok",
      priority: 2,
      actor,
      idempotency_key: "K",
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.title, "original");
    assert.equal(replay.status, "queued");
    assert.equal(demoStoreSize().tasks, DEMO_CAPS.tasks);
    const live = await demoListTasks({ status: "all", limit: DEMO_CAPS.tasks + 5 });
    assert.equal(live.some((task) => task.id === first.id), false);
    assert.equal(live.some((task) => task.title === "original"), false);

    await assert.rejects(
      () =>
        demoCreateTask({
          title: "different",
          platform: "grok",
          priority: 2,
          actor,
          idempotency_key: "K",
        }),
      (err: unknown) =>
        err instanceof IdempotencyConflict &&
        err.message === "This idempotency key was already used with different arguments.",
    );
    assert.equal(demoStoreSize().tasks, DEMO_CAPS.tasks);

    setDemoClockForTests(() => 5_000 + IDEMPOTENCY_TTL_MS + 1);
    const expired = await demoCreateTask({
      title: "original",
      platform: "grok",
      priority: 2,
      actor,
      idempotency_key: "K",
    });
    assert.notEqual(expired.id, first.id);
    assert.equal(demoStoreSize().tasks, DEMO_CAPS.tasks);
    assert.equal((await demoGetTask(expired.id))?.title, "original");

    const mcp = fs.readFileSync("docs/MCP.md", "utf8");
    assert.match(mcp, /does not drop its idempotency key/);
    assert.match(mcp, /returns the original result for 24 hours/);
  });
});
