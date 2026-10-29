/**
 * Activity log and write receipts. Each case tries to break the guarantee
 * it names: a receipt that never shows up, an event left behind by a failed
 * write, a page that skips or repeats a row, a scope hole, or a tool sentence
 * that changed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { GET as getActivity } from "../../src/app/api/activity/route";
import { PATCH as patchTask } from "../../src/app/api/tasks/[id]/route";
import { activityDetail, readReceipt, type Receipt } from "../../src/lib/activity";
import { openApiDocument } from "../../src/lib/openapi";
import { type McpToolResult } from "../../src/lib/api-error";
import { runWithActor, type Actor } from "../../src/lib/actor";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { demoTasks } from "../../src/lib/demo-data";
import {
  DEMO_BANNER,
  DEMO_CAPS,
  DEMO_EMPTY_CLAIM,
  demoClaimNextTask,
  demoClaimTaskTool,
  demoCreateTask,
  demoCreateTaskTool,
  demoGetTask,
  demoRemember,
  demoRememberTool,
  demoReport,
  demoReportStatusTool,
  demoRequeueTask,
  demoStoreSize,
  demoUpdateTask,
  demoUpdateTaskTool,
  resetDemoStoreForTests,
  setActivityFaultForTests,
  setDemoClockForTests,
} from "../../src/lib/demo-store";
import { rememberForTool, updateTaskForTool } from "../../src/lib/dry-run-actions";
import { setSqlForTests } from "../../src/lib/db";
import { ACTIVITY_LIST, encodeCursor, TASK_REST } from "../../src/lib/list-params";
import { listActivityResult } from "../../src/lib/list-read";
import { deleteNoteTool, requeueTaskTool, sendMessageTool } from "../../src/lib/operator-actions";
import { authorizeRoute, authorizeTool, scopeForRoute, SCOPES } from "../../src/lib/scopes";

/**
 * A successful tools/call goes through mcp-handler, which keeps a session
 * and a timer. Exit after the suite reports so test:ui is not stuck on it.
 */
after(() => {
  const code = process.exitCode ?? 0;
  setImmediate(() => process.exit(code));
});

/** mcp-handler arms an interval at import. Unref it so the timer is not the handle. */
let postMcp: (req: Request) => Promise<Response>;

before(async () => {
  const orig = global.setInterval;
  global.setInterval = ((fn: TimerHandler, ms?: number) => {
    const timer = orig(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }) as typeof setInterval;
  try {
    const route = await import(pathToFileURL(path.join(process.cwd(), "src/app/api/[transport]/route.ts")).href);
    postMcp = route.POST;
  } finally {
    global.setInterval = orig;
  }
});

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  password: env.MC_DASHBOARD_PASSWORD,
  token: env.MC_TOKEN,
};

const ANN: Actor = { actor_type: "agent", actor_id: "ann" };
const ANNA: Actor = { actor_type: "agent", actor_id: "anna" };
const T0 = "2026-10-28T12:00:00.000Z";
const T1 = "2026-10-28T12:00:01.000Z";
const T2 = "2026-10-28T12:00:02.000Z";

beforeEach(() => {
  resetDemoStoreForTests();
  setDemoClockForTests(null);
  setActivityFaultForTests(null);
  resetCredentialsForTests();
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
});

afterEach(() => {
  setDemoClockForTests(null);
  setActivityFaultForTests(null);
  resetDemoStoreForTests();
  resetCredentialsForTests();
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.password === undefined) delete env.MC_DASHBOARD_PASSWORD;
  else env.MC_DASHBOARD_PASSWORD = saved.password;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
});

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(id: number, body: unknown): Promise<Response> {
  return patchTask(jsonReq(`http://localhost/api/tasks/${id}`, body), {
    params: Promise.resolve({ id: String(id) }),
  });
}

interface ActivityJson {
  demo?: boolean;
  activity: {
    id: number;
    kind: string;
    actor_id: string | null;
    created_at: string;
    title?: string | null;
  }[];
  next_cursor?: string | null;
  code?: string;
}

async function restActivity(query = ""): Promise<{ status: number; body: ActivityJson }> {
  const res = await getActivity(new Request(`http://localhost/api/activity${query}`));
  return { status: res.status, body: (await res.json()) as ActivityJson };
}

function splitReceipt(result: McpToolResult): { body: string; receipt: Receipt } {
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  const lines = text.split("\n");
  const last = lines.at(-1) ?? "";
  assert.match(last, /^receipt: \{/);
  const receipt = JSON.parse(last.slice("receipt: ".length)) as Receipt;
  assert.deepEqual(Object.keys(receipt), ["id", "kind", "at"]);
  assert.match(receipt.id, /^[1-9]\d{0,18}$/);
  assert.match(receipt.kind, /^[A-Za-z0-9_.:-]{1,64}$/);
  assert.match(receipt.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const structured = result.structuredContent as { receipt?: Receipt } | undefined;
  assert.deepEqual(structured?.receipt, receipt);
  const body = lines.slice(0, -1).join("\n");
  assert.equal(body.includes("\nreceipt: "), false);
  return { body, receipt };
}

function assertNoReceipt(result: McpToolResult): void {
  const text = result.content[0].text;
  assert.equal(text.split("\n").some((line) => line.startsWith("receipt: ")), false, text);
  assert.equal(result.structuredContent, undefined);
}

async function eventIds(): Promise<number[]> {
  const { status, body } = await restActivity("?limit=200");
  assert.equal(status, 200);
  return body.activity.map((row) => row.id);
}

async function walk(limit: number, extra = ""): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams(extra.startsWith("?") ? extra.slice(1) : extra);
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const { status, body } = await restActivity(`?${params}`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(Array.isArray(body.activity), true);
    for (const row of body.activity) {
      assert.equal(ids.includes(row.id), false, `row ${row.id} returned twice`);
      ids.push(row.id);
    }
    assert.equal(Object.hasOwn(body, "next_cursor"), true);
    if (body.next_cursor == null) {
      assert.ok(body.activity.length <= limit);
      return ids;
    }
    assert.equal(body.activity.length, limit, "a cursor was issued for a short page");
    assert.equal(seen.has(body.next_cursor), false, "cursor repeated");
    seen.add(body.next_cursor);
    cursor = body.next_cursor;
  }
  assert.fail("paging did not end");
}

function mcpLines(result: McpToolResult): { lines: string[]; next: string | null } {
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.equal(text.startsWith(`${DEMO_BANNER}\n`), true, text.slice(0, 80));
  const body = text.slice(DEMO_BANNER.length + 1);
  const lines = body.split("\n");
  const tail = lines.at(-1) ?? "";
  if (tail.startsWith("next_cursor: ")) {
    return { lines: lines.slice(0, -1), next: tail.slice("next_cursor: ".length) };
  }
  return { lines, next: null };
}

async function walkTool(limit: number, args: { actor?: string; kind?: string; since?: string; until?: string } = {}): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 30; page++) {
    const result = await listActivityResult({ ...args, limit, cursor, fields: "id,kind" }, false);
    const parsed = mcpLines(result);
    const rows = parsed.lines.filter((line) => line !== "No activity.").map((line) => JSON.parse(line) as { id: number });
    for (const row of rows) {
      assert.equal(ids.includes(row.id), false, `tool row ${row.id} returned twice`);
      ids.push(row.id);
    }
    if (parsed.next == null || parsed.next === "null") return ids;
    assert.equal(seen.has(parsed.next), false, "tool cursor repeated");
    seen.add(parsed.next);
    cursor = parsed.next;
  }
  assert.fail("tool paging did not end");
}

describe("activity log", { concurrency: false }, () => {
  it("F1 a write receipt is the event list_activity and GET /api/activity return", async () => {
    const created = splitReceipt(await runWithActor(ANN, () => demoCreateTaskTool({
      title: "ship the log",
      platform: "grok",
    }, ANN)));
    assert.equal(created.receipt.kind, "create_task");
    const taskId = Number(created.body.match(/Task #(\d+)/)?.[1]);
    assert.equal(created.body, `${DEMO_BANNER}\nTask #${taskId} queued for grok (priority 2).`);

    const claimed = splitReceipt(await runWithActor(ANN, () => demoClaimTaskTool({
      platform: "grok",
      agent_id: "ann",
    })));
    assert.equal(claimed.receipt.kind, "task_claimed");
    assert.notEqual(claimed.receipt.id, created.receipt.id);

    const updated = splitReceipt(await runWithActor(ANN, () => demoUpdateTaskTool({
      id: taskId,
      status: "done",
    })));
    assert.equal(updated.body, `${DEMO_BANNER}\nTask #${taskId} updated (done).`);
    assert.equal(updated.receipt.kind, "task_updated");

    const { status, body } = await restActivity();
    assert.equal(status, 200);
    assert.equal(body.demo, true);
    const listed = await listActivityResult({}, false);
    assert.equal(listed.isError, undefined);
    for (const receipt of [created.receipt, claimed.receipt, updated.receipt]) {
      const row = body.activity.find((item) => String(item.id) === receipt.id);
      assert.ok(row, `GET /api/activity is missing ${receipt.id}`);
      assert.equal(row?.kind, receipt.kind);
      assert.equal(row?.created_at, receipt.at);
      assert.equal(row?.actor_id, "ann");
      assert.match(listed.content[0].text, new RegExp(`#${receipt.id}\\b`));
      assert.match(listed.content[0].text, new RegExp(receipt.kind));
    }

    const again = splitReceipt(await demoCreateTaskTool({
      title: "once",
      platform: "any",
      idempotency_key: "same-shape",
    }, null));
    const count = demoStoreSize().events;
    const replay = splitReceipt(await demoCreateTaskTool({
      title: "once",
      platform: "any",
      idempotency_key: "same-shape",
    }, null));
    assert.deepEqual(replay.receipt, again.receipt);
    assert.equal(demoStoreSize().events, count);
    const ids = await eventIds();
    assert.equal(ids.filter((id) => String(id) === again.receipt.id).length, 1);
  });

  it("F2 a dry run, a 409, and a rejected write leave no receipt and no event", async () => {
    const empty = await demoClaimTaskTool({ platform: "hermes", agent_id: "nobody" });
    assert.equal(empty.content[0].text, `${DEMO_BANNER}\n${DEMO_EMPTY_CLAIM}`);
    assertNoReceipt(empty);
    assert.equal(demoStoreSize().events, 0);

    const beforeRemember = demoStoreSize().events;
    const memoryPreview = await rememberForTool({ content: "ghost", key: "ghost", dry_run: true });
    assert.equal(memoryPreview.isError, undefined);
    assertNoReceipt(memoryPreview);
    assert.equal(JSON.parse(memoryPreview.content[0].text).applied, false);
    assert.equal(demoStoreSize().notes, 0);
    assert.equal(demoStoreSize().events, beforeRemember);

    const badFlag = await rememberForTool({ content: "nope", dry_run: "yes" as unknown as boolean });
    assert.equal(badFlag.isError, true);
    assert.equal(JSON.parse(badFlag.content[0].text).code, "validation_failed");
    assertNoReceipt(badFlag);
    assert.equal(demoStoreSize().events, 0);

    const missing = await updateTaskForTool({ id: 404, status: "done", dry_run: true });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).code, "task_not_found");
    assertNoReceipt(missing);
    assert.equal(demoStoreSize().events, 0);

    const task = await demoCreateTask({ title: "guard me", platform: "any" });
    const createdIds = await eventIds();
    const taskPreview = await updateTaskForTool({ id: task.id, status: "cancelled", dry_run: true });
    assertNoReceipt(taskPreview);
    assert.equal(JSON.parse(taskPreview.content[0].text).applied, false);
    assert.deepEqual(await eventIds(), createdIds);
    assert.equal((await demoGetTask(task.id))?.status, "queued");

    await demoUpdateTask({ id: task.id, status: "done" });
    const doneIds = await eventIds();
    const requeuePreview = await requeueTaskTool({ id: task.id, dry_run: true });
    assertNoReceipt(requeuePreview);
    const preview = JSON.parse(requeuePreview.content[0].text) as { applied: boolean; expected_revision: string };
    assert.equal(preview.applied, false);
    assert.equal(typeof preview.expected_revision, "string");
    assert.deepEqual(await eventIds(), doneIds);

    await demoRemember({ content: "keep", key: "keep-me" });
    const noted = demoStoreSize().events;
    const deletePreview = await deleteNoteTool({ key: "keep-me", dry_run: true });
    assertNoReceipt(deletePreview);
    assert.equal(demoStoreSize().notes, 1);
    assert.equal(demoStoreSize().events, noted);

    await demoUpdateTask({ id: task.id, result: "revision moved" });
    const moved = await eventIds();
    await assert.rejects(
      () => requeueTaskTool({ id: task.id, expected_revision: preview.expected_revision }),
      (err: unknown) => err instanceof Error && err.name === "StaleWrite",
    );
    assert.deepEqual(await eventIds(), moved);
    assert.equal((await demoGetTask(task.id))?.status, "done");
    assert.equal((await eventIds()).some((id) => id > Math.max(...moved)), false);

    const staleDelete = await deleteNoteTool({ key: "keep-me", expected_revision: "not-the-note" });
    assert.equal(staleDelete.isError, true);
    assert.equal(JSON.parse(staleDelete.content[0].text).code, "stale_write");
    assertNoReceipt(staleDelete);
    assert.equal(demoStoreSize().notes, 1);

    const conflictBefore = demoStoreSize().events;
    await demoCreateTaskTool({ title: "first shape", platform: "any", idempotency_key: "shape" }, null);
    const afterFirst = demoStoreSize().events;
    assert.equal(afterFirst, conflictBefore + 1);
    await assert.rejects(() => demoCreateTaskTool({
      title: "other shape",
      platform: "any",
      idempotency_key: "shape",
    }, null));
    assert.equal(demoStoreSize().events, afterFirst);

    const restTask = await demoCreateTask({ title: "rest confirm", platform: "any" });
    const restBefore = await eventIds();
    const dry = await patch(restTask.id, { dry_run: true, status: "running" });
    assert.equal(dry.status, 200);
    const dryBody = await dry.json() as { applied: boolean; would_write: boolean; expected_revision: string };
    assert.equal(dryBody.applied, false);
    assert.equal(dryBody.would_write, false);
    assert.equal(typeof dryBody.expected_revision, "string");
    assert.deepEqual(await eventIds(), restBefore);

    const stale = await patch(restTask.id, { status: "running", expected_revision: "not-the-token" });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as { code: string };
    assert.equal(staleBody.code, "stale_write");
    assert.equal(JSON.stringify(staleBody).includes("receipt"), false);
    assert.deepEqual(await eventIds(), restBefore);
    assert.equal((await demoGetTask(restTask.id))?.status, "queued");

    const applied = await patch(restTask.id, { status: "running", expected_revision: dryBody.expected_revision });
    assert.equal(applied.status, 200);
    const appliedIds = await eventIds();
    assert.equal(appliedIds.length, restBefore.length + 1);
    const replayed = await patch(restTask.id, { status: "done", expected_revision: dryBody.expected_revision });
    assert.equal(replayed.status, 409);
    assert.deepEqual(await eventIds(), appliedIds);
    assert.equal((await demoGetTask(restTask.id))?.status, "running");

    const invalid = await patch(restTask.id, { dry_run: "true" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await eventIds(), appliedIds);
  });

  it("F3 a task status event commits with the write or not at all", async () => {
    const store = fs.readFileSync("src/lib/store.ts", "utf8");
    const claim = store.slice(store.indexOf("export async function claimNextTask"), store.indexOf("export async function updateTask"));
    const update = store.slice(store.indexOf("export async function updateTask"), store.indexOf("async function taskRevisionOf"));
    assert.equal(claim.split("insert into events").length - 1, 1);
    assert.equal(claim.split("with changed as (").length - 1, 1);
    assert.equal(update.split("insert into events").length - 1, 2);
    assert.equal(update.split("with changed as (").length - 1, 2);
    assert.match(store, /order by date_trunc\('milliseconds', created_at\) desc, id asc/);

    const task = await demoCreateTask({ title: "atomic", platform: "codex" });
    const original = await demoGetTask(task.id);
    assert.ok(original);
    const before = await eventIds();

    for (const fault of ["after-write", "after-event"] as const) {
      setActivityFaultForTests(fault);
      await assert.rejects(
        () => demoUpdateTask({ id: task.id, status: "running", result: "should not stick" }),
        new RegExp(`activity fault ${fault.replace("-", " ")}`),
      );
      const current = await demoGetTask(task.id);
      assert.equal(current?.status, "queued");
      assert.equal(current?.result, original.result);
      assert.equal(current?.updated_at, original.updated_at);
      assert.equal(current?.completed_at, original.completed_at);
      assert.deepEqual(await eventIds(), before, fault);
    }

    const written = await demoUpdateTask({ id: task.id, status: "running" });
    assert.equal(written.status, "running");
    const receipt = readReceipt(written);
    assert.ok(receipt);
    assert.equal(receipt.kind, "task_updated");
    const afterUpdate = await eventIds();
    // Same millisecond sorts by id ascending, so the new row is not always first.
    // The burned fault id must be absent: the set is exactly the prior rows plus this receipt.
    assert.deepEqual(
      [...afterUpdate].sort((a, b) => a - b),
      [...before, Number(receipt.id)].sort((a, b) => a - b),
    );
    assert.equal(before.includes(Number(receipt.id)), false);

    const queued = await demoCreateTask({ title: "claim atomic", platform: "hermes" });
    const queuedBefore = await eventIds();
    for (const fault of ["after-write", "after-event"] as const) {
      setActivityFaultForTests(fault);
      await assert.rejects(
        () => demoClaimNextTask({ platform: "hermes", agent_id: "worker" }),
        /activity fault/,
      );
      const current = await demoGetTask(queued.id);
      assert.equal(current?.status, "queued", fault);
      assert.equal(current?.assigned_agent, null, fault);
      assert.equal(current?.claimed_at, null, fault);
      assert.deepEqual(await eventIds(), queuedBefore, fault);
    }
    const claimed = await demoClaimNextTask({ platform: "hermes", agent_id: "worker" });
    assert.equal(claimed?.status, "claimed");
    const claimReceipt = readReceipt(claimed);
    assert.equal(claimReceipt?.kind, "task_claimed");
    assert.ok((await eventIds()).includes(Number(claimReceipt?.id)));

    await demoUpdateTask({ id: queued.id, status: "failed" });
    const failedBefore = await eventIds();
    for (const fault of ["after-write", "after-event"] as const) {
      setActivityFaultForTests(fault);
      await assert.rejects(
        () => demoRequeueTask({ id: queued.id, callerId: null, dryRun: false }),
        /activity fault/,
      );
      assert.equal((await demoGetTask(queued.id))?.status, "failed", fault);
      assert.deepEqual(await eventIds(), failedBefore, fault);
    }
    const requeued = await demoRequeueTask({ id: queued.id, callerId: null, dryRun: false });
    assert.equal(requeued.kind, "task");
    if (requeued.kind === "task") assert.equal(requeued.task.status, "queued");
    const kinds = (await restActivity("?kind=task_requeued")).body.activity.map((row) => row.id);
    assert.equal(kinds.length, 1);
  });

  it("F4 filters and cursors return every matching row once", async () => {
    setDemoClockForTests(() => Date.parse(T0));
    await runWithActor(ANN, () => demoCreateTask({ title: "old", platform: "any", actor: ANN }));
    setDemoClockForTests(() => Date.parse(T1));
    await runWithActor(ANN, () => demoRemember({ content: "note", key: "bound" }));
    await runWithActor(ANNA, () => demoCreateTask({ title: "tie", platform: "any", actor: ANNA }));
    setDemoClockForTests(() => Date.parse(T2));
    await runWithActor(ANNA, () => demoReport({
      agent_id: "anna",
      kind: "status",
      title: "up",
      detail: activityDetail("report_status", ANNA, {}),
    }));

    const full = await restActivity("?limit=50");
    assert.equal(full.status, 200);
    assert.deepEqual(
      full.body.activity.map((row) => [row.kind, row.actor_id, row.created_at]),
      [
        ["status", "anna", T2],
        ["remember", "ann", T1],
        ["create_task", "anna", T1],
        ["create_task", "ann", T0],
      ],
    );
    const fullIds = full.body.activity.map((row) => row.id);
    assert.deepEqual(await walk(1), fullIds);
    assert.deepEqual(await walk(2), fullIds);
    assert.deepEqual(await walkTool(1), fullIds);
    assert.deepEqual(await walkTool(2), fullIds);

    const tied = full.body.activity.filter((row) => row.created_at === T1).map((row) => row.id);
    assert.equal(tied[0] < tied[1], true);
    assert.deepEqual(await walk(1, `since=${encodeURIComponent(T1)}&until=${encodeURIComponent(T1)}`), tied);

    const annIds = full.body.activity.filter((row) => row.actor_id === "ann").map((row) => row.id);
    assert.deepEqual((await restActivity("?actor=ann&limit=50")).body.activity.map((row) => row.id), annIds);
    assert.deepEqual(await walk(1, "actor=ann"), annIds);
    assert.deepEqual(await walkTool(1, { actor: "ann" }), annIds);
    assert.deepEqual((await restActivity("?actor=an&limit=50")).body.activity, []);
    assert.deepEqual((await restActivity("?actor=anna&limit=50")).body.activity.map((row) => row.actor_id), ["anna", "anna"]);

    const creates = full.body.activity.filter((row) => row.kind === "create_task").map((row) => row.id);
    assert.deepEqual(await walk(1, "kind=create_task"), creates);
    assert.deepEqual((await restActivity("?kind=create&limit=50")).body.activity, []);
    assert.deepEqual(await walk(1, `since=${encodeURIComponent(T2)}`), [fullIds[0]]);
    assert.deepEqual(await walk(1, `until=${encodeURIComponent(T0)}`), [fullIds[3]]);
    assert.deepEqual(await walk(1, `since=${encodeURIComponent(T0)}&until=${encodeURIComponent(T0)}`), [fullIds[3]]);
    assert.deepEqual((await restActivity(`?until=${encodeURIComponent("2026-10-28T11:59:59.999Z")}`)).body.activity, []);

    const blank = await restActivity("?actor=%20%20&kind=");
    assert.equal(blank.status, 200);
    assert.deepEqual(blank.body.activity.map((row) => row.id), fullIds);

    const late = await restActivity(`?since=${encodeURIComponent(T2)}&until=${encodeURIComponent(T1)}`);
    assert.equal(late.status, 400);
    assert.equal(late.body.code, "validation_failed");
    const longActor = await restActivity(`?actor=${"a".repeat(201)}`);
    assert.equal(longActor.status, 400);
    const badKind = await restActivity("?kind=create%20task");
    assert.equal(badKind.status, 400);
    const badSince = await restActivity("?since=not-a-time");
    assert.equal(badSince.status, 400);
    for (const limit of ["0", "201", "1.5", "01", "+10"]) {
      const rejected = await restActivity(`?limit=${encodeURIComponent(limit)}`);
      assert.equal(rejected.status, 400, limit);
      assert.equal(rejected.body.code, "validation_failed", limit);
    }
    const foreign = encodeCursor(TASK_REST, {
      id: 1,
      status: "queued",
      priority: 1,
      updated_at: T0,
    });
    const wrongList = await restActivity(`?cursor=${foreign}`);
    assert.equal(wrongList.status, 400);
    assert.equal(wrongList.body.code, "validation_failed");

    const narrowed = await restActivity("?limit=10&fields=id,kind");
    assert.equal(narrowed.status, 200);
    assert.equal(narrowed.body.next_cursor, null);
    for (const row of narrowed.body.activity) {
      assert.deepEqual(Object.keys(row).sort(), ["id", "kind"]);
    }
    const badFields = await restActivity("?fields=title,password");
    assert.equal(badFields.status, 400);

    const toolBad = await listActivityResult({ since: T2, until: T1 }, false);
    assert.equal(toolBad.isError, true);
    assert.equal(JSON.parse(toolBad.content[0].text).code, "validation_failed");
    const toolLimit = await listActivityResult({ limit: 0 }, false);
    assert.equal(toolLimit.isError, true);
  });

  it("F5 missing auth is 401 and an agent credential is 403", async () => {
    env.MC_DASHBOARD_PASSWORD = "activity-gate";
    env.MC_TOKEN = "activity-legacy";
    const open = await getActivity(new Request("http://localhost/api/activity"));
    assert.equal(open.status, 401);
    assert.equal((await open.json()).code, "unauthorized");

    const wrong = await getActivity(new Request("http://localhost/api/activity", {
      headers: { authorization: "Bearer nope" },
    }));
    assert.equal(wrong.status, 401);

    const reader = await createCredential({ label: "tasks only", scopes: ["tasks:read"] });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const denied = await getActivity(new Request("http://localhost/api/activity", {
      headers: { authorization: `Bearer ${reader.token}` },
    }));
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json() as { code: string; fix: string };
    assert.equal(deniedBody.code, "insufficient_scope");
    assert.equal(deniedBody.fix, "This route is not granted by any agent scope.");
    assert.equal(JSON.stringify(deniedBody).includes(reader.token), false);
    const toolDenied = authorizeTool({ kind: "agent", id: "tasks-only", scopes: ["tasks:read"] }, "list_activity");
    assert.equal(toolDenied.ok, false);

    const fleetCred = await createCredential({ label: "fleet", scopes: ["fleet:read"] });
    assert.equal(fleetCred.ok, true);
    if (!fleetCred.ok) return;
    const fleetRead = await getActivity(new Request("http://localhost/api/activity", {
      headers: { authorization: `Bearer ${fleetCred.token}` },
    }));
    assert.equal(fleetRead.status, 403);
    assert.equal(authorizeTool({ kind: "agent", id: fleetCred.credential.id, scopes: ["fleet:read"] }, "list_activity").ok, false);

    const legacy = await getActivity(new Request("http://localhost/api/activity", {
      headers: { authorization: "Bearer activity-legacy" },
    }));
    assert.equal(legacy.status, 200);

    const call = (token: string | null) => new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_activity", arguments: {} },
      }),
    });
    const noAuth = await postMcp(call(null));
    assert.equal(noAuth.status, 401);
    await noAuth.arrayBuffer().catch(() => undefined);
    const noScope = await postMcp(call(reader.token));
    assert.equal(noScope.status, 403);
    const noScopeBody = await noScope.json() as { code: string };
    assert.equal(noScopeBody.code, "insufficient_scope");
    assert.equal(JSON.stringify(noScopeBody).includes(reader.token), false);
    const fleetCall = await postMcp(call(fleetCred.token));
    assert.equal(fleetCall.status, 403);
    await fleetCall.json().catch(() => undefined);
  });

  it("F6 write text is the previous sentence plus one receipt line", async () => {
    const reported = splitReceipt(await demoReportStatusTool({ agent_id: "ada", title: "working" }));
    assert.equal(reported.body, `${DEMO_BANNER}\nStatus reported to Agent Kontrol.`);
    assert.equal(reported.receipt.kind, "status");

    const stored = splitReceipt(await rememberForTool({ content: "loose" }));
    const memoryId = stored.body.match(/Stored memory #(\d+)\./)?.[1];
    assert.equal(stored.body, `${DEMO_BANNER}\nStored memory #${memoryId}.`);
    assert.equal(stored.receipt.kind, "remember");

    const keyed = splitReceipt(await rememberForTool({ content: "keyed", key: "project/status" }));
    assert.match(keyed.body, new RegExp(`^${DEMO_BANNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nStored memory #\\d+ \\(key: project/status\\)\\.$`));

    const created = splitReceipt(await demoCreateTaskTool({ title: "ship the log", platform: "grok" }, null));
    const taskId = Number(created.body.match(/Task #(\d+)/)?.[1]);
    assert.equal(created.body, `${DEMO_BANNER}\nTask #${taskId} queued for grok (priority 2).`);

    const claimed = splitReceipt(await demoClaimTaskTool({ platform: "grok", agent_id: "ada" }));
    assert.equal(claimed.body, [
      DEMO_BANNER,
      `Claimed task #${taskId}: ship the log`,
      "Instructions:",
      "ship the log",
      "",
      `When finished, call update_task (id: ${taskId}) with status 'done' or 'failed' and a result summary.`,
    ].join("\n"));
    assert.equal(claimed.body.split("\n")[1], `Claimed task #${taskId}: ship the log`);

    const updated = splitReceipt(await demoUpdateTaskTool({ id: taskId, status: "done" }));
    assert.equal(updated.body, `${DEMO_BANNER}\nTask #${taskId} updated (done).`);

    const sent = splitReceipt(await sendMessageTool({ agent_id: "ada", body: "ping" }));
    assert.match(sent.body, new RegExp(`^${DEMO_BANNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nMessage #\\d+ sent to ada\\.$`));
    assert.equal(sent.receipt.kind, "send_message");

    const quiet = await demoCreateTask({ title: "plain requeue", platform: "any" });
    await demoUpdateTask({ id: quiet.id, status: "cancelled" });
    const plain = splitReceipt(await requeueTaskTool({ id: quiet.id }));
    assert.equal(plain.body, `${DEMO_BANNER}\nTask #${quiet.id} requeued.`);
    assert.equal(plain.receipt.kind, "task_requeued");

    const owned = await runWithActor(ANN, () => demoCreateTask({ title: "owned", platform: "any", actor: ANN }));
    await demoUpdateTask({ id: owned.id, status: "failed" });
    const named = splitReceipt(await runWithActor(ANN, () => requeueTaskTool({ id: owned.id })));
    assert.equal(named.body, `${DEMO_BANNER}\nTask #${owned.id} requeued. actor_type=agent actor_id=ann.`);

    await demoRemember({ content: "drop", key: "drop-me" });
    const removed = splitReceipt(await runWithActor(ANN, () => deleteNoteTool({ key: "drop-me" })));
    assert.equal(removed.body, `${DEMO_BANNER}\nDeleted memory key "drop-me". actor_type=agent actor_id=ann.`);
    assert.equal(removed.receipt.kind, "delete_note");
  });

  it("F7 demo mode serves the same in-memory log on REST and list_activity", async () => {
    assert.ok(demoTasks().length > 0);
    const empty = await restActivity();
    assert.equal(empty.body.demo, true);
    assert.deepEqual(empty.body.activity, []);
    assert.equal(Object.hasOwn(empty.body, "next_cursor"), false);
    const emptyTool = await listActivityResult({}, false);
    assert.equal(emptyTool.content[0].text, `${DEMO_BANNER}\nNo activity.`);

    const preview = await rememberForTool({ content: "not stored", key: "preview-only", dry_run: true });
    assertNoReceipt(preview);
    assert.deepEqual((await restActivity()).body.activity, []);
    assert.equal((await listActivityResult({}, false)).content[0].text, `${DEMO_BANNER}\nNo activity.`);

    setDemoClockForTests(() => Date.parse(T1));
    const written = splitReceipt(await runWithActor(ANN, () => demoCreateTaskTool({
      title: "visible",
      platform: "any",
    }, ANN)));
    setDemoClockForTests(() => Date.parse(T0));
    await runWithActor(ANNA, () => demoRememberTool({ content: "older", key: "older" }));
    setDemoClockForTests(() => Date.parse(T2));
    const newest = splitReceipt(await runWithActor(ANN, () => demoReportStatusTool({
      agent_id: "ann",
      title: "later",
    })));
    const rest = await restActivity("?limit=1");
    const tool = await walkTool(1);
    assert.deepEqual(await walk(1), tool);
    // The newest row is the status report, not the earlier create_task receipt.
    assert.equal(String(rest.body.activity[0]?.id), newest.receipt.id);
    assert.equal(rest.body.activity[0]?.kind, newest.receipt.kind);
    assert.equal(rest.body.activity[0]?.created_at, newest.receipt.at);
    assert.notEqual(newest.receipt.id, written.receipt.id);
    assert.equal(rest.body.demo, true);
    assert.equal(typeof rest.body.next_cursor, "string");

    const restFields = await restActivity("?limit=10&fields=id,kind,actor_id");
    const toolFields = await listActivityResult({ limit: 10, fields: "id,kind,actor_id" }, false);
    const toolRows = mcpLines(toolFields).lines.map((line) => JSON.parse(line) as { id: number; kind: string; actor_id: string | null });
    assert.deepEqual(toolRows, restFields.body.activity);
    assert.equal(restFields.body.activity[0]?.actor_id, "ann");
    assert.ok(restFields.body.activity.some((row) => String(row.id) === written.receipt.id && row.kind === "create_task"));
    assert.equal(restFields.body.activity.some((row) => row.kind === "remember" && row.actor_id === "anna"), true);

    const filtered = await restActivity("?actor=anna&kind=remember");
    const filteredTool = await listActivityResult({ actor: "anna", kind: "remember" }, false);
    const filteredLines = mcpLines(filteredTool).lines;
    assert.equal(filtered.body.activity.length, 1);
    assert.match(filteredLines[0] ?? "", new RegExp(`#${filtered.body.activity[0]?.id}\\b`));
    assert.equal(filtered.body.activity[0]?.kind, "remember");
  });

  it("F8 a replay after event eviction returns the original receipt", async () => {
    await demoReport({ agent_id: "ada", kind: "status", title: "up" });
    const created = splitReceipt(await demoCreateTaskTool({
      title: "survive eviction",
      platform: "any",
      idempotency_key: "evict-task",
    }, null));
    const sent = splitReceipt(await sendMessageTool({
      agent_id: "ada",
      body: "ping",
      idempotency_key: "evict-msg",
    }));
    for (let i = 0; i < DEMO_CAPS.events; i++) {
      await demoReport({ agent_id: "ada", kind: "heartbeat", title: `pad ${i}` });
    }
    assert.equal(demoStoreSize().events, DEMO_CAPS.events);
    const kept = await walk(200);
    assert.equal(kept.includes(Number(created.receipt.id)), false, "the create_task receipt was evicted");
    assert.equal(kept.includes(Number(sent.receipt.id)), false, "the send_message receipt was evicted");

    const before = demoStoreSize().events;
    const replayedTask = splitReceipt(await demoCreateTaskTool({
      title: "survive eviction",
      platform: "any",
      idempotency_key: "evict-task",
    }, null));
    const replayedMessage = splitReceipt(await sendMessageTool({
      agent_id: "ada",
      body: "ping",
      idempotency_key: "evict-msg",
    }));
    assert.deepEqual(replayedTask.receipt, created.receipt);
    assert.deepEqual(replayedMessage.receipt, sent.receipt);
    assert.equal(demoStoreSize().events, before, "a replay does not insert a receipt");
  });

  it("F10 an agent credential with fleet:read is forbidden on activity the same way traces are", async () => {
    env.MC_DASHBOARD_PASSWORD = "activity-gate";
    env.MC_TOKEN = "activity-legacy";
    const fleet = await createCredential({ label: "fleet reader", scopes: ["fleet:read"] });
    assert.equal(fleet.ok, true);
    if (!fleet.ok) return;
    const everyScope = { kind: "agent" as const, id: "every-scope", scopes: [...SCOPES] };

    const rest = await getActivity(new Request("http://localhost/api/activity", {
      headers: { authorization: `Bearer ${fleet.token}` },
    }));
    assert.equal(rest.status, 403);
    const restBody = await rest.json() as { code: string; fix: string; retryable: boolean };
    assert.equal(restBody.code, "insufficient_scope");
    assert.equal(restBody.retryable, false);
    assert.equal(restBody.fix, "This route is not granted by any agent scope.");
    assert.equal(JSON.stringify(restBody).includes(fleet.token), false);

    assert.equal(scopeForRoute("GET", "/api/activity"), null);
    assert.equal(scopeForRoute("GET", "/api/traces"), null);
    assert.equal(authorizeRoute({ kind: "agent", id: fleet.credential.id, scopes: ["fleet:read"] }, "GET", "/api/activity").ok, false);
    assert.equal(authorizeRoute(everyScope, "GET", "/api/activity").ok, false);
    assert.equal(authorizeRoute({ kind: "legacy" }, "GET", "/api/activity").ok, true);
    assert.equal(authorizeRoute({ kind: "session" }, "GET", "/api/activity").ok, true);

    const tool = authorizeTool({ kind: "agent", id: fleet.credential.id, scopes: ["fleet:read"] }, "list_activity");
    assert.equal(tool.ok, false);
    if (!tool.ok) {
      assert.equal(tool.status, 403);
      assert.equal(tool.body.code, "insufficient_scope");
      assert.equal(tool.body.fix, "This route is not granted by any agent scope.");
      assert.equal(tool.body.retryable, false);
    }
    assert.equal(authorizeTool(everyScope, "list_activity").ok, false);
    assert.equal(authorizeTool({ kind: "legacy" }, "list_activity").ok, true);
    assert.equal(authorizeTool({ kind: "session" }, "list_activity").ok, true);
    assert.equal(authorizeTool({ kind: "oauth", id: "oauth-client" }, "list_activity").ok, true);

    const call = (token: string) => new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_activity", arguments: {} },
      }),
    });
    const denied = await postMcp(call(fleet.token));
    assert.equal(denied.status, 403);
    const deniedBody = await denied.json() as { code: string; fix: string };
    assert.equal(deniedBody.code, "insufficient_scope");
    assert.equal(deniedBody.fix, "This route is not granted by any agent scope.");
    assert.equal(JSON.stringify(deniedBody).includes(fleet.token), false);

    const legacy = await postMcp(call("activity-legacy"));
    assert.notEqual(legacy.status, 401);
    assert.notEqual(legacy.status, 403);
    await legacy.arrayBuffer().catch(() => undefined);

    const doc = openApiDocument() as {
      paths: Record<string, { get?: { security?: { cookieAuth?: unknown[]; bearerAuth?: unknown[]; mcToken?: unknown[] }[] } }>;
    };
    assert.deepEqual(doc.paths["/api/activity"]?.get?.security, [{ cookieAuth: [] }, { mcToken: [] }]);
    assert.equal(JSON.stringify(doc.paths["/api/activity"]?.get?.security).includes("bearerAuth"), false);
  });

  it("F11 a failed secondary status report still returns the task receipt", async () => {
    env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/ak_activity";
    const seen: { text: string; values: unknown[] }[] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ");
      seen.push({ text, values });
      if (/\bupdate\s+tasks\b/i.test(text) && /insert into events/i.test(text)) {
        return [{
          id: 7,
          title: "Fix the form",
          description: null,
          project: null,
          platform: "grok",
          machine: null,
          priority: 2,
          status: "done",
          reviewer_platform: null,
          assigned_agent: null,
          session_id: null,
          result: null,
          cost_usd: null,
          created_by: "dashboard",
          actor_type: null,
          actor_id: null,
          created_at: "2026-10-28T12:00:00.000Z",
          claimed_at: null,
          updated_at: "2026-10-28T12:00:01.000Z",
          completed_at: "2026-10-28T12:00:01.000Z",
          receipt_id: "41",
          receipt_kind: "task_updated",
          receipt_at: "2026-10-28T12:00:01.000Z",
        }];
      }
      if (/insert into agents/i.test(text) || /insert into events/i.test(text) || /insert into sessions/i.test(text)) {
        throw new Error("simulated events insert failure");
      }
      return [];
    });
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((part) => (part instanceof Error ? part.message : String(part))).join(" "));
    };
    try {
      const result = await updateTaskForTool({ id: 7, status: "done", agent_id: "lane" });
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.match(text, /^Task #7 updated \(done\)\./);
      assert.match(text, /note: the status event was not recorded/);
      const receiptLine = text.split("\n").at(-1) ?? "";
      assert.equal(receiptLine, 'receipt: {"id":"41","kind":"task_updated","at":"2026-10-28T12:00:01.000Z"}');
      const structured = result.structuredContent as { receipt?: { id: string; kind: string; at: string } } | undefined;
      assert.deepEqual(structured?.receipt, {
        id: "41",
        kind: "task_updated",
        at: "2026-10-28T12:00:01.000Z",
      });
      assert.equal(text.split("\n")[0], "Task #7 updated (done).");
      assert.ok(seen.some((query) => (
        /\bupdate\s+tasks\b/i.test(query.text)
        && /insert into events/i.test(query.text)
        && query.values.includes("task_updated")
      )));
      assert.ok(logged.some((line) => line.includes("simulated events insert failure")));
    } finally {
      console.error = original;
      setSqlForTests(null);
    }
  });

  it("F9 OpenAPI activity items list the fields list_activity returns", () => {
    const doc = openApiDocument() as {
      paths: Record<string, {
        get?: {
          responses?: Record<string, {
            content?: { "application/json"?: { schema?: { properties?: { activity?: { items?: { properties?: Record<string, unknown> } } } } } };
          }>;
        };
      }>;
    };
    const props = doc.paths["/api/activity"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.activity?.items?.properties;
    assert.deepEqual(Object.keys(props ?? {}).sort(), [...ACTIVITY_LIST.allow].sort());
  });
});
