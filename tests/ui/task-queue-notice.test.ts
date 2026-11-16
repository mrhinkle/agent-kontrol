import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { publicError, toolResultFromCaught } from "../../src/lib/api-error";
import { setSqlForTests, type SqlTag } from "../../src/lib/db";
import { GhEventInputError, insertGhEvent, isEventHeader, isWebhookDeliveryId } from "../../src/lib/gh-events";
import { createTask, report, updateTask } from "../../src/lib/store";
import {
  ReservedQueueMarkerError,
  TASK_NOTICE_PRODUCER_ENV,
  containsReservedQueueMarker,
  decideQueueEvidence,
  taskNoticeProducerEnabled,
  taskReadyDeliveryId,
} from "../../src/lib/task-queue-notice";
import { POST as postTasks } from "../../src/app/api/tasks/route";
import { PATCH as patchTask } from "../../src/app/api/tasks/[id]/route";

/**
 * Unit 1: the queue episode is the audit receipt written when a task enters
 * queued, and the task-ready notice is the same statement, gated off unless
 * AK_TASK_NOTICE_PRODUCER is exactly "1". Callers cannot supply the marker.
 */

const env = process.env as Record<string, string | undefined>;
const TOKEN = "task-notice-test-token";
const FIXTURE_URL = "postgres://fixture:fixture@127.0.0.1:9/ak_task_notice";

const saved = {
  db: env.DATABASE_URL,
  token: env.MC_TOKEN,
  producer: env[TASK_NOTICE_PRODUCER_ENV],
};

type ClaimRow = {
  request_hash: string;
  response: unknown;
  expires_at: string;
  started_at: string | null;
  claim_token: string;
};

function restoreEnv(): void {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
  if (saved.producer === undefined) delete env[TASK_NOTICE_PRODUCER_ENV];
  else env[TASK_NOTICE_PRODUCER_ENV] = saved.producer;
}

function noticeSlice(text: string): string {
  const start = text.indexOf("insert into gh_events");
  assert.ok(start >= 0, "notice insert missing");
  const end = text.indexOf("returning id", start);
  assert.ok(end > start);
  return text.slice(start, end);
}

function taskRow(title: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    title,
    description: null,
    project: null,
    platform: "any",
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
    receipt_id: 9,
    receipt_kind: "create_task",
    receipt_at: "2026-11-15T00:00:00.000Z",
    ...extra,
  };
}

beforeEach(() => {
  delete env[TASK_NOTICE_PRODUCER_ENV];
  setSqlForTests(null);
});

afterEach(() => {
  setSqlForTests(null);
  restoreEnv();
});

describe("task queue notice helpers", () => {
  it("enables the producer only for the exact value 1", () => {
    assert.equal(taskNoticeProducerEnabled({}), false);
    for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
      assert.equal(taskNoticeProducerEnabled({ [TASK_NOTICE_PRODUCER_ENV]: value }), false, value);
    }
    assert.equal(taskNoticeProducerEnabled({ [TASK_NOTICE_PRODUCER_ENV]: "1" }), true);
  });

  it("builds a decimal delivery id and rejects anything else", () => {
    assert.equal(taskReadyDeliveryId("12", "34"), "task:ready:12:34");
    assert.equal(taskReadyDeliveryId("9".repeat(19), "1"), `task:ready:${"9".repeat(19)}:1`);
    for (const [taskId, receiptId] of [["0", "1"], ["01", "1"], ["1", "1.2"], ["1", ""], ["", "1"], ["1", "0"]]) {
      assert.throws(() => taskReadyDeliveryId(taskId, receiptId), /decimal/);
    }
  });

  it("walks nested caller JSON for the reserved marker and ignores a plain task id", () => {
    assert.equal(containsReservedQueueMarker({ task_id: "123" }), false);
    assert.equal(containsReservedQueueMarker({ nested: { task_id: "123", title: "secret" } }), false);
    assert.equal(containsReservedQueueMarker({ _ak_task_queue_v1: { task_id: "123" } }), true);
    assert.equal(containsReservedQueueMarker({ a: [{ queue_receipt_id: "9" }] }), true);
    const cycle: Record<string, unknown> = { ok: true };
    cycle.self = cycle;
    assert.equal(containsReservedQueueMarker(cycle), false);
    cycle.queue_receipt_id = "1";
    assert.equal(containsReservedQueueMarker(cycle), true);
    assert.equal(containsReservedQueueMarker(null), false);
  });

  it("keeps a missing or truncated episode unknown and does not fall back", () => {
    assert.deepEqual(decideQueueEvidence({
      scanned: 1,
      scanLimit: 500,
      episodeId: "40",
      noticeId: "8",
      noticeAt: "2026-11-15T00:00:00.000Z",
    }), {
      evidence: "notified",
      queue_episode: "40",
      notice_id: "8",
      notice_at: "2026-11-15T00:00:00.000Z",
      reason: "exact_notice",
    });
    assert.deepEqual(decideQueueEvidence({
      scanned: 3,
      scanLimit: 500,
      episodeId: "40",
      noticeId: null,
      noticeAt: "2026-11-01T00:00:00.000Z",
    }), {
      evidence: "unnotified_or_expired",
      queue_episode: "40",
      notice_id: null,
      notice_at: null,
      reason: "notice_absent",
    });
    assert.deepEqual(decideQueueEvidence({
      scanned: 500,
      scanLimit: 500,
      episodeId: null,
      noticeId: null,
      noticeAt: null,
    }).reason, "audit_window_truncated");
    const absent = decideQueueEvidence({
      scanned: 4,
      scanLimit: 500,
      episodeId: null,
      noticeId: null,
      noticeAt: null,
    });
    assert.equal(absent.evidence, "unknown_history");
    assert.equal(absent.reason, "no_episode_in_window");
    assert.equal(absent.queue_episode, null);
  });
});

describe("reserved namespace stays out of public writers", () => {
  it("rejects the reserved delivery and event before SQL, and still accepts the repo name on a normal event", async () => {
    let calls = 0;
    const tripwire: SqlTag = async () => {
      calls += 1;
      throw new Error("sql should not run");
    };
    setSqlForTests(tripwire);
    await assert.rejects(
      () => insertGhEvent({ delivery_id: "task:ready:1:2", event: "push", payload: { title: "secret" } }),
      (err: unknown) => err instanceof GhEventInputError && /not writable/.test(err.message),
    );
    await assert.rejects(
      () => insertGhEvent({ delivery_id: "push-1", event: "task-ready", payload: {} }),
      GhEventInputError,
    );
    assert.equal(calls, 0);
    assert.equal(isWebhookDeliveryId("task:ready:1:2"), false);
    assert.equal(isEventHeader("task-ready"), false);
    assert.equal(isWebhookDeliveryId("delivery-1"), true);
    assert.equal(isEventHeader("push"), true);

    const seen: string[] = [];
    const ok = await insertGhEvent({
      delivery_id: "push-1",
      event: "push",
      repo: "agent-kontrol/task-queue",
      payload: { ref: "refs/heads/main" },
    }, async (strings) => {
      seen.push(strings.join(" "));
      return [{ id: "55" }];
    });
    assert.deepEqual(ok, { stored: true, duplicate: false, id: "55" });
    assert.equal(seen.length, 1);
    assert.equal(calls, 0);
  });

  it("rejects a caller-supplied marker from report and maps it to validation_failed", async () => {
    let calls = 0;
    setSqlForTests(async () => {
      calls += 1;
      return [];
    });
    await assert.rejects(
      () => report({ agent_id: "worker", kind: "status", detail: { _ak_task_queue_v1: { task_id: "1" } } }),
      (err: unknown) => err instanceof ReservedQueueMarkerError,
    );
    await assert.rejects(
      () => report({ agent_id: "worker", kind: "status", detail: { note: { queue_receipt_id: "9" } } }),
      ReservedQueueMarkerError,
    );
    assert.equal(calls, 0);
    const plain = await report({ agent_id: "worker", kind: "status", detail: { task_id: "1" } });
    assert.equal(plain, null);
    assert.equal(calls, 1);

    const rest = publicError("[tasks] marker", new ReservedQueueMarkerError());
    assert.equal(rest.status, 400);
    const body = await rest.json() as { code: string; fields?: { detail?: string } };
    assert.equal(body.code, "validation_failed");
    assert.match(body.fields?.detail ?? "", /reserved queue marker/);
    const tool = toolResultFromCaught("[mcp] marker", new ReservedQueueMarkerError());
    assert.equal(tool.isError, true);
    assert.equal(JSON.parse(tool.content[0].text).code, "validation_failed");
  });

  it("returns 400 from task create and update before any SQL", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_TOKEN = TOKEN;
    let calls = 0;
    setSqlForTests(async () => {
      calls += 1;
      throw new Error("sql should not run");
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const created = await postTasks(new Request("http://localhost/api/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "secret title", _ak_task_queue_v1: { task_id: "1" } }),
    }));
    assert.equal(created.status, 400);
    const createdBody = await created.json() as { code: string };
    assert.equal(createdBody.code, "validation_failed");
    const patched = await patchTask(new Request("http://localhost/api/tasks/7", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "queued", queue_receipt_id: "9" }),
    }), { params: Promise.resolve({ id: "7" }) });
    assert.equal(patched.status, 400);
    assert.equal(calls, 0);
  });
});

describe("queue episode and atomic notice", () => {
  it("keeps the activity source lock and leaves the notice outside claim SQL", () => {
    const store = fs.readFileSync("src/lib/store.ts", "utf8");
    const claim = store.slice(store.indexOf("export async function claimNextTask"), store.indexOf("export async function updateTask"));
    const update = store.slice(store.indexOf("export async function updateTask"), store.indexOf("async function taskRevisionOf"));
    assert.equal(claim.split("insert into events").length - 1, 1);
    assert.equal(claim.split("with changed as (").length - 1, 1);
    assert.equal(claim.includes("insert into gh_events"), false);
    assert.equal(update.split("insert into events").length - 1, 2);
    assert.equal(update.split("with changed as (").length - 1, 2);
    assert.equal(update.split("insert into gh_events").length - 1, 2);
    assert.equal(update.split("for update").length - 1, 2);
    assert.equal(
      update.split("when changed.status = 'queued' and changed.previous_status is distinct from 'queued'").length - 1,
      2,
    );
    assert.equal(update.split("changed.previous_status is distinct from 'queued'").length - 1, 4);
  });

  it("writes the marker and the gated notice in the one create statement", async () => {
    const seen: { text: string; values: unknown[] }[] = [];
    setSqlForTests(async (strings, ...values) => {
      seen.push({ text: strings.join(" ").replace(/\s+/g, " ").trim(), values });
      return [taskRow("secret-title", { notice_rows: 1, previous_status: "running" })];
    });
    const task = await createTask({ title: "secret-title", description: "secret body" });
    assert.equal(seen.length, 1);
    const text = seen[0].text.toLowerCase();
    assert.match(text, /insert into tasks/);
    assert.match(text, /insert into events/);
    assert.match(text, /insert into gh_events/);
    assert.match(text, /_ak_task_queue_v1/);
    assert.doesNotMatch(noticeSlice(text), /title|description|result|token|prompt/);
    assert.equal(text.includes("secret-title"), false);
    assert.equal(text.includes("secret body"), false);
    assert.equal(seen[0].values.at(-1), false);
    assert.equal(seen[0].values[0], "secret-title");
    const published = JSON.stringify(task);
    assert.equal(published.includes("notice_rows"), false);
    assert.equal(published.includes("previous_status"), false);
    assert.equal(published.includes("_ak_task_queue_v1"), false);
    assert.equal(task.title, "secret-title");

    env[TASK_NOTICE_PRODUCER_ENV] = "1";
    seen.length = 0;
    await createTask({ title: "secret-title" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].values.at(-1), true);
    delete env[TASK_NOTICE_PRODUCER_ENV];
  });

  it("replays an idempotent create without a second episode and rolls one statement back", async () => {
    const claims = new Map<string, ClaimRow>();
    const taskSql: { text: string; values: unknown[] }[] = [];
    let committed = 0;
    let failTask = false;
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      const lower = text.toLowerCase();
      if (lower.includes("delete from idempotency_keys") && lower.includes("expires_at")) return [];
      if (lower.includes("delete from idempotency_keys") && lower.includes("response is null")) {
        const [scope, key, token] = values as string[];
        const row = claims.get(`${scope}\0${key}`);
        if (row && row.response == null && row.claim_token === token) claims.delete(`${scope}\0${key}`);
        return [];
      }
      if (lower.includes("insert into idempotency_keys")) {
        const [scope, key, requestHash, expiresAt, startedAt, claimToken] = values as string[];
        const id = `${scope}\0${key}`;
        if (claims.has(id)) return [];
        const row: ClaimRow = {
          request_hash: requestHash,
          response: null,
          expires_at: expiresAt,
          started_at: startedAt,
          claim_token: claimToken,
        };
        claims.set(id, row);
        return [row];
      }
      if (lower.includes("insert into tasks") && lower.includes("update idempotency_keys")) {
        taskSql.push({ text, values });
        if (failTask) throw new Error("rolled back");
        const [scope, key, token] = values as string[];
        const row = claims.get(`${scope}\0${key}`);
        if (!row || row.claim_token !== token || row.response != null) return [];
        assert.equal(values[3], "secret-title");
        assert.equal(values[12], null);
        assert.equal(values[16], false);
        assert.equal(values[17], token);
        const stored = taskRow("secret-title");
        row.response = stored;
        committed += 1;
        return [{ response: JSON.parse(JSON.stringify(stored)) }];
      }
      if (lower.includes("from idempotency_keys")) {
        const [scope, key] = values as string[];
        const row = claims.get(`${scope}\0${key}`);
        return row ? [JSON.parse(JSON.stringify(row))] : [];
      }
      throw new Error(`unexpected sql: ${lower.slice(0, 120)}`);
    });

    const input = { title: "secret-title", description: "secret body", idempotency_key: "same-key" };
    const first = await createTask(input);
    const second = await createTask(input);
    assert.equal(committed, 1);
    assert.equal(taskSql.length, 1);
    assert.equal(first.id, second.id);
    assert.equal(JSON.stringify(second).includes("_ak_task_queue_v1"), false);
    const statement = taskSql[0].text.toLowerCase();
    assert.match(statement, /insert into tasks/);
    assert.match(statement, /insert into events/);
    assert.match(statement, /insert into gh_events/);
    assert.equal(statement.split("insert into gh_events").length - 1, 1);
    assert.doesNotMatch(noticeSlice(statement), /title|description|result|token|prompt/);
    assert.equal(statement.includes("secret body"), false);

    failTask = true;
    claims.clear();
    committed = 0;
    taskSql.length = 0;
    await assert.rejects(() => createTask({ ...input, idempotency_key: "other-key" }), /rolled back/);
    assert.equal(committed, 0);
    assert.equal(taskSql.length, 1);
    assert.equal(claims.size, 0);
    assert.match(taskSql[0].text.toLowerCase(), /insert into gh_events/);
  });

  it("locks the previous status inside both update statements and strips notice columns", async () => {
    const seen: { text: string; values: unknown[] }[] = [];
    setSqlForTests(async (strings, ...values) => {
      seen.push({ text: strings.join(" ").replace(/\s+/g, " ").trim(), values });
      const lower = strings.join(" ").toLowerCase();
      if (lower.includes("select md5")) return [{ revision: "abc" }];
      return [taskRow("secret-title", {
        status: "queued",
        previous_status: "running",
        notice_rows: 0,
        receipt_kind: "task_requeued",
      })];
    });
    const unguarded = await updateTask({ id: 7, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    env[TASK_NOTICE_PRODUCER_ENV] = "1";
    const guarded = await updateTask({ id: 7, status: "queued", expected_revision: "abc" });
    delete env[TASK_NOTICE_PRODUCER_ENV];
    assert.equal(seen.length, 2);
    for (const call of seen) {
      const text = call.text.toLowerCase();
      assert.match(text, /for update/);
      assert.match(text, /changed\.status = 'queued' and changed\.previous_status is distinct from 'queued'/);
      assert.equal(text.split("insert into gh_events").length - 1, 1);
      assert.equal(text.split("insert into events").length - 1, 1);
      assert.doesNotMatch(noticeSlice(text), /title|description|result|token|prompt/);
      assert.equal(call.values.includes("secret-title"), false);
    }
    assert.deepEqual(seen[0].values.slice(-6), [false, 7, "task_requeued", "requeue_task", null, null]);
    assert.deepEqual(seen[1].values.slice(-7), [true, 7, "abc", "task_updated", "update_task", null, null]);
    assert.match(seen[1].text, /md5\(t::text\)/);
    for (const task of [unguarded, guarded]) {
      const published = JSON.stringify(task);
      assert.equal(published.includes("previous_status"), false);
      assert.equal(published.includes("notice_rows"), false);
      assert.equal(published.includes("secret-title"), true);
      assert.equal(task.title, "secret-title");
    }
  });

  it("does not set the producer flag in deployment config", () => {
    for (const name of ["fly.toml", "docker-compose.yml", "docker-compose.yaml", ".env", ".env.example", ".env.local"]) {
      if (!fs.existsSync(name)) continue;
      const text = fs.readFileSync(name, "utf8");
      assert.equal(text.includes(TASK_NOTICE_PRODUCER_ENV), false, name);
    }
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    assert.equal(schema.includes("task-ready"), false);
    assert.equal(schema.includes("_ak_task_queue_v1"), false);
  });
});
