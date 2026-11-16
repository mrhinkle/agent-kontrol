import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setSqlForTests } from "../../src/lib/db";
import { claimTaskWithCoverage } from "../../src/lib/store";
import { readTaskNoticeObserverHeaders } from "../../src/lib/task-queue-notice";
import { POST as claimTask } from "../../src/app/api/tasks/claim/route";

/**
 * Unit 2: optional claim evidence. The default response stays { task }.
 * An ineligible observer learns nothing about episodes or notices.
 */

const env = process.env as Record<string, string | undefined>;
const TOKEN = "claim-coverage-test-token";
const FIXTURE_URL = "postgres://fixture:fixture@127.0.0.1:9/ak_claim_coverage";
const saved = { db: env.DATABASE_URL, token: env.MC_TOKEN };

function restoreEnv(): void {
  if (saved.db === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = saved.db;
  if (saved.token === undefined) delete env.MC_TOKEN;
  else env.MC_TOKEN = saved.token;
}

function taskRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    title: "secret-title",
    description: "secret body",
    project: null,
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

const observer = { consumer: "dispatcher-1", credentialId: "cred-events", generation: "4" };

beforeEach(() => {
  setSqlForTests(null);
});

afterEach(() => {
  setSqlForTests(null);
  restoreEnv();
});

describe("event observer headers", () => {
  it("reads only the events header and ignores the task bearer", () => {
    const headers = new Headers({
      authorization: "Bearer akc_taskcredential",
      "x-ak-event-authorization": "Bearer akc_eventcredential",
      "x-ak-event-consumer": "dispatcher-1",
      "x-ak-event-generation": "4",
    });
    assert.deepEqual(readTaskNoticeObserverHeaders(headers), {
      token: "akc_eventcredential",
      consumer: "dispatcher-1",
      generation: "4",
    });
    headers.delete("x-ak-event-authorization");
    assert.equal(readTaskNoticeObserverHeaders(headers), null);
    assert.equal(readTaskNoticeObserverHeaders(new Headers({
      "x-ak-event-authorization": "akc_eventcredential",
      "x-ak-event-consumer": "dispatcher-1",
      "x-ak-event-generation": "4",
    })), null);
    assert.equal(readTaskNoticeObserverHeaders(new Headers({
      "x-ak-event-authorization": "Bearer akc_eventcredential",
      "x-ak-event-consumer": "Bad Consumer",
      "x-ak-event-generation": "4",
    })), null);
    assert.equal(readTaskNoticeObserverHeaders(new Headers({
      "x-ak-event-authorization": "Bearer akc_eventcredential",
      "x-ak-event-consumer": "dispatcher-1",
      "x-ak-event-generation": "01",
    })), null);
  });
});

describe("bounded claim evidence", () => {
  it("keeps the coverage statement outside the default claim and update slices", () => {
    const store = fs.readFileSync("src/lib/store.ts", "utf8");
    const claim = store.slice(store.indexOf("export async function claimNextTask"), store.indexOf("export async function updateTask"));
    const update = store.slice(store.indexOf("export async function updateTask"), store.indexOf("async function taskRevisionOf"));
    assert.equal(claim.split("insert into events").length - 1, 1);
    assert.equal(claim.split("with changed as (").length - 1, 1);
    assert.equal(claim.includes("event_stream_consumers"), false);
    assert.equal(update.includes("event_stream_consumers"), false);
    assert.equal(update.split("insert into events").length - 1, 2);
    const mcp = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const tool = mcp.slice(mcp.indexOf('"claim_task"'), mcp.indexOf('"update_task"'));
    assert.equal(tool.includes("claimTaskWithCoverage"), false);
    assert.equal(tool.includes("coverage"), false);
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    assert.equal(schema.includes("references gh_events"), false);
  });

  it("returns the existing task object unless coverage is requested", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_TOKEN = TOKEN;
    const texts: string[] = [];
    setSqlForTests(async (strings) => {
      const text = strings.join(" ").replace(/\s+/g, " ").toLowerCase();
      texts.push(text);
      if (text.includes("status = 'queued'")) return [taskRow()];
      if (text.includes("with changed as")) return [taskRow({ status: "claimed" })];
      return [];
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const omitted = await claimTask(new Request("http://localhost/api/tasks/claim", {
      method: "POST",
      headers,
      body: JSON.stringify({ platform: "codex", agent_id: "worker", coverage: false }),
    }));
    const omittedBody = await omitted.json() as Record<string, unknown>;
    assert.equal(omitted.status, 200);
    assert.deepEqual(Object.keys(omittedBody), ["task"]);
    assert.equal(texts.some((text) => text.includes("event_stream_consumers")), false);
    assert.equal(texts.some((text) => text.includes("token_hash")), false);

    texts.length = 0;
    const unconfigured = env.DATABASE_URL;
    delete env.DATABASE_URL;
    const demo = await claimTask(new Request("http://localhost/api/tasks/claim", {
      method: "POST",
      headers,
      body: JSON.stringify({ platform: "codex", agent_id: "worker" }),
    }));
    assert.deepEqual(await demo.json(), { task: null, demo: true });
    const demoCoverage = await claimTask(new Request("http://localhost/api/tasks/claim", {
      method: "POST",
      headers,
      body: JSON.stringify({ platform: "codex", agent_id: "worker", coverage: true }),
    }));
    const demoBody = await demoCoverage.json() as { task: null; demo: boolean; coverage: { reason: string; queue_episode: null } };
    assert.equal(demoBody.demo, true);
    assert.equal(demoBody.task, null);
    assert.equal(demoBody.coverage.reason, "unconfigured");
    assert.equal(demoBody.coverage.queue_episode, null);
    env.DATABASE_URL = unconfigured;
  });

  it("does not treat the task bearer as events proof", async () => {
    env.DATABASE_URL = FIXTURE_URL;
    env.MC_TOKEN = TOKEN;
    const texts: string[] = [];
    setSqlForTests(async (strings) => {
      const text = strings.join(" ").replace(/\s+/g, " ").toLowerCase();
      texts.push(text);
      if (text.includes("clock_timestamp") && !text.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:03:00.000Z" }];
      }
      if (text.includes("from tasks") && text.includes("status = 'queued'")) return [taskRow()];
      if (text.includes("with changed as") && !text.includes("event_stream_consumers")) {
        return [taskRow({ status: "claimed" })];
      }
      return [];
    });
    const response = await claimTask(new Request("http://localhost/api/tasks/claim", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-ak-event-consumer": "dispatcher-1",
        "x-ak-event-generation": "4",
      },
      body: JSON.stringify({ platform: "codex", agent_id: "worker", coverage: true }),
    }));
    const body = await response.json() as { task: { title: string }; coverage: { evidence: string; reason: string; queue_episode: null; notice_id: null } };
    assert.equal(response.status, 200);
    assert.equal(body.task.title, "secret-title");
    assert.equal(body.coverage.evidence, "unknown");
    assert.equal(body.coverage.reason, "ineligible_observer");
    assert.equal(body.coverage.queue_episode, null);
    assert.equal(body.coverage.notice_id, null);
    assert.equal(texts.some((text) => text.includes("token_hash")), false);
    assert.equal(texts.some((text) => text.includes("event_stream_consumers")), false);
    assert.equal(JSON.stringify(body.coverage).includes("secret"), false);
  });

  it("classifies one exact notice, a missing notice, and an incomplete scan without falling back", async () => {
    const seen: { text: string; values: unknown[] }[] = [];
    const scripted: Record<string, unknown>[] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ").replace(/\s+/g, " ").trim();
      seen.push({ text, values });
      const lower = text.toLowerCase();
      if (lower.includes("clock_timestamp") && !lower.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:03:00.000Z" }];
      }
      if (lower.includes("from tasks") && lower.includes("status = 'queued'") && !lower.includes("update tasks")) {
        return [taskRow()];
      }
      const row = scripted.shift();
      return row ? [row] : [];
    });

    scripted.push(taskRow({
      status: "claimed",
      scanned_rows: 2,
      queue_episode: "40",
      notice_id: "8",
      notice_at: "2026-11-15T00:01:00.000Z",
      observer_generation: "4",
      measured_at: "2026-11-15T00:03:00.000Z",
    }));
    const exact = await claimTaskWithCoverage({ platform: "codex", agent_id: "worker", observer });
    assert.equal(exact.coverage.evidence, "notified");
    assert.equal(exact.coverage.reason, "exact_notice");
    assert.equal(exact.coverage.queue_episode, "40");
    assert.equal(exact.coverage.notice_id, "8");
    assert.equal(exact.coverage.measured_at, "2026-11-15T00:03:00.000Z");
    assert.ok(exact.task);
    assert.equal(JSON.stringify(exact.task).includes("queue_episode"), false);
    assert.equal(JSON.stringify(exact.task).includes("notice_id"), false);
    assert.equal(exact.task.title, "secret-title");

    const statement = seen.find((call) => call.text.toLowerCase().includes("event_stream_consumers"));
    assert.ok(statement);
    const sql = statement.text.toLowerCase();
    assert.equal(sql.split("join gh_events").length - 1, 1);
    assert.equal(sql.includes("insert into gh_events"), false);
    assert.match(sql, /order by created_at desc, id desc/);
    assert.match(sql, /task:ready:/);
    assert.match(sql, /for update of c/);
    assert.match(sql, /events:read/);
    assert.equal(sql.split("limit 1").length - 1 >= 1, true);
    const notice = sql.slice(sql.indexOf("join gh_events"));
    assert.doesNotMatch(notice, /title|description|result|token|prompt/);
    assert.equal(statement.values.includes(500), true);
    assert.equal(statement.values.includes(30), true);
    assert.equal(statement.values.includes("cred-events"), true);
    assert.equal(statement.values.includes("dispatcher-1"), true);
    assert.equal(statement.values.includes("4"), true);
    assert.equal(statement.values.includes("worker"), true);
    assert.equal(statement.values.includes("secret-title"), false);
    assert.equal(statement.values.includes("secret body"), false);

    scripted.push(taskRow({
      status: "claimed",
      scanned_rows: 3,
      queue_episode: "40",
      notice_id: null,
      notice_at: null,
      observer_generation: "4",
      measured_at: "2026-11-15T00:04:00.000Z",
    }));
    const missing = await claimTaskWithCoverage({ platform: "codex", agent_id: "worker", observer });
    assert.equal(missing.coverage.evidence, "unnotified_or_expired");
    assert.equal(missing.coverage.reason, "notice_absent");
    assert.equal(missing.coverage.queue_episode, "40");
    assert.equal(missing.coverage.notice_id, null);

    scripted.push(taskRow({
      status: "claimed",
      scanned_rows: 500,
      queue_episode: null,
      notice_id: null,
      notice_at: null,
      observer_generation: "4",
      measured_at: "2026-11-15T00:05:00.000Z",
    }));
    const truncated = await claimTaskWithCoverage({ platform: "codex", agent_id: "worker", observer });
    assert.equal(truncated.coverage.evidence, "unknown_history");
    assert.equal(truncated.coverage.reason, "audit_window_truncated");
    assert.equal(truncated.coverage.queue_episode, null);

    scripted.push(taskRow({
      status: "claimed",
      scanned_rows: 4,
      queue_episode: null,
      notice_id: "99",
      notice_at: "2026-11-01T00:00:00.000Z",
      observer_generation: "4",
      measured_at: "2026-11-15T00:06:00.000Z",
    }));
    const absent = await claimTaskWithCoverage({ platform: "codex", agent_id: "worker", observer });
    assert.equal(absent.coverage.reason, "no_episode_in_window");
    assert.equal(absent.coverage.notice_id, null);

    scripted.push(taskRow({
      status: "claimed",
      scanned_rows: 1,
      queue_episode: "40",
      notice_id: "8",
      notice_at: "2026-11-15T00:01:00.000Z",
      observer_generation: null,
      measured_at: "2026-11-15T00:07:00.000Z",
    }));
    const hidden = await claimTaskWithCoverage({ platform: "codex", agent_id: "worker", observer });
    assert.equal(hidden.task?.id, 7);
    assert.equal(hidden.coverage.evidence, "unknown");
    assert.equal(hidden.coverage.reason, "ineligible_observer");
    assert.equal(hidden.coverage.queue_episode, null);
    assert.equal(hidden.coverage.notice_id, null);
    assert.equal(JSON.stringify(hidden.coverage).includes("40"), false);
  });

  it("reports no_claim instead of a miss when the queue does not yield a task", async () => {
    setSqlForTests(async (strings) => {
      const text = strings.join(" ").toLowerCase();
      if (text.includes("clock_timestamp") && !text.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:08:00.000Z" }];
      }
      if (text.includes("update tasks")) throw new Error("lost candidate must not be updated");
      return [];
    });
    const empty = await claimTaskWithCoverage({ platform: "codex", agent_id: "worker", observer });
    assert.equal(empty.task, null);
    assert.equal(empty.coverage.reason, "no_claim");
    assert.equal(empty.coverage.evidence, "unknown");
    assert.equal(empty.coverage.queue_episode, null);

    setSqlForTests(async (strings) => {
      const text = strings.join(" ").toLowerCase();
      if (text.includes("clock_timestamp") && !text.includes("with changed")) {
        return [{ measured_at: "2026-11-15T00:09:00.000Z" }];
      }
      if (text.includes("from tasks") && !text.includes("update tasks")) return [taskRow({ machine: "box-a" })];
      throw new Error("machine mismatch must not claim");
    });
    const skipped = await claimTaskWithCoverage({
      platform: "codex",
      machine: "box-b",
      agent_id: "worker",
      observer,
    });
    assert.equal(skipped.task, null);
    assert.equal(skipped.coverage.reason, "no_claim");
  });
});
