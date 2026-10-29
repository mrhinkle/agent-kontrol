/**
 * Operator MCP tools: send_message, requeue_task, delete_note.
 * Each F-test tries to break the rule it names. Demo mode (no DATABASE_URL).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runWithActor, type Actor } from "../../src/lib/actor";
import { toolResultFromCaught, type McpToolResult } from "../../src/lib/api-error";
import {
  DEMO_BANNER,
  demoCreateTask,
  demoFindMemoryByKey,
  demoGetTask,
  demoMessagesForTests,
  demoRemember,
  demoReport,
  demoUpdateTask,
  resetDemoStoreForTests,
} from "../../src/lib/demo-store";
import { MESSAGE_BODY_MAX } from "../../src/lib/message-body";
import { openApiDocument } from "../../src/lib/openapi";
import { deleteNoteTool, requeueTaskTool, sendMessageTool } from "../../src/lib/operator-actions";
import { authorizeTool, evaluateMcpMessages, insufficientScopeBody, SCOPES } from "../../src/lib/scopes";

const savedDb = process.env.DATABASE_URL;

beforeEach(() => {
  resetDemoStoreForTests();
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  resetDemoStoreForTests();
  if (savedDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDb;
});

function actor(id: string): Actor {
  return { actor_type: "agent", actor_id: id };
}

function errorOf(result: McpToolResult): {
  code: string;
  error: string;
  fields?: Record<string, string>;
  current_revision?: string;
} {
  assert.equal(result.isError, true, result.content[0]?.text);
  const body = JSON.parse(result.content[0].text) as {
    code: string;
    error: string;
    fields?: Record<string, string>;
    current_revision?: string;
  };
  assert.equal(result.content[0].text.startsWith(DEMO_BANNER), false);
  return body;
}

function previewOf(result: McpToolResult): {
  dry_run: true;
  applied: false;
  would_write: boolean;
  action: string;
  expected_revision: string;
} {
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text.startsWith(DEMO_BANNER), false);
  const body = JSON.parse(result.content[0].text) as {
    dry_run: true;
    applied: false;
    would_write: boolean;
    action: string;
    expected_revision: string;
  };
  assert.equal(body.dry_run, true);
  assert.equal(body.applied, false);
  assert.equal(body.would_write, true);
  assert.match(body.expected_revision, /^[0-9a-f]{32}$/);
  return body;
}

/** The route's guardTool maps these throws. Call the same mapper so a direct test sees the tool result. */
async function guarded(label: string, run: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await run();
  } catch (err) {
    return toolResultFromCaught(label, err);
  }
}

async function send(args: { agent_id: string; body: string; created_by?: string; idempotency_key?: string }, id = "cred-send") {
  return guarded("send_message", () => runWithActor(actor(id), () => sendMessageTool(args)));
}

async function requeue(
  args: { id: number; agent_id?: string; dry_run?: unknown; expected_revision?: unknown },
  id = "cred-requeue",
) {
  return guarded("requeue_task", () => runWithActor(actor(id), () => requeueTaskTool(args)));
}

async function remove(args: { key: string; dry_run?: unknown; expected_revision?: unknown }, id = "cred-delete") {
  return guarded("delete_note", () => runWithActor(actor(id), () => deleteNoteTool(args)));
}

describe("operator MCP tools", () => {
  it("F1 missing scope is forbidden for each tool", () => {
    const tools = [
      ["send_message", "messages:write"],
      ["requeue_task", "tasks:write"],
      ["delete_note", "memory:write"],
    ] as const;
    for (const [name, scope] of tools) {
      const without = SCOPES.filter((item) => item !== scope);
      const denied = authorizeTool({ kind: "agent", id: "cred", scopes: without }, name);
      assert.equal(denied.ok, false, name);
      if (!denied.ok) assert.deepEqual(denied.body, insufficientScopeBody(scope));
      const call = evaluateMcpMessages(
        { kind: "agent", id: "cred", scopes: without },
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } },
      );
      assert.equal(call.ok, false, name);
      if (!call.ok) assert.deepEqual(call.body, insufficientScopeBody(scope));
      assert.equal(authorizeTool({ kind: "agent", id: "cred", scopes: [scope] }, name).ok, true, name);
    }
    assert.equal(authorizeTool({ kind: "legacy" }, "delete_note").ok, true);
    assert.equal(authorizeTool({ kind: "oauth", id: "oauth-client" }, "send_message").ok, true);
    assert.equal(authorizeTool({ kind: "agent", id: "cred", scopes: [...SCOPES] }, "not_a_tool").ok, false);
  });

  it("F2 dry_run writes nothing and returns the revision", async () => {
    await demoReport({ agent_id: "lane", kind: "status", title: "up" });
    await demoRemember({ key: "note-1", content: "keep me", agent_id: "lane" });
    const task = await demoCreateTask({ title: "finish me", platform: "grok" });
    await demoUpdateTask({ id: task.id, status: "failed", assigned_agent: "lane" });
    const before = await demoGetTask(task.id);
    assert.ok(before?.completed_at);

    const notePreview = previewOf(await remove({ key: "note-1", dry_run: true, expected_revision: "0".repeat(32) }));
    assert.equal(notePreview.action, "delete_memory");
    assert.equal((await demoFindMemoryByKey("note-1"))?.content, "keep me");

    const taskPreview = previewOf(await requeue({ id: task.id, dry_run: true, expected_revision: "stale-but-well-formed" }));
    assert.equal(taskPreview.action, "requeue_task");
    const after = await demoGetTask(task.id);
    assert.equal(after?.status, "failed");
    assert.equal(after?.assigned_agent, "lane");
    assert.equal(after?.completed_at, before.completed_at);
    assert.equal(after?.actor_id, null);

    const badDry = errorOf(await remove({ key: "note-1", dry_run: "yes" }));
    assert.equal(badDry.code, "validation_failed");
    assert.equal((await demoFindMemoryByKey("note-1"))?.content, "keep me");
    const badToken = errorOf(await requeue({ id: task.id, expected_revision: "" }));
    assert.equal(badToken.code, "validation_failed");
    assert.equal((await demoGetTask(task.id))?.status, "failed");
  });

  it("F3 stale expected_revision writes nothing", async () => {
    await demoRemember({ key: "note-1", content: "v1", agent_id: "lane" });
    const notePreview = previewOf(await remove({ key: "note-1", dry_run: true }));
    await demoRemember({ key: "note-1", content: "v2", agent_id: "lane" });
    const staleNote = errorOf(await remove({ key: "note-1", expected_revision: notePreview.expected_revision }));
    assert.equal(staleNote.code, "stale_write");
    assert.match(staleNote.current_revision ?? "", /^[0-9a-f]{32}$/);
    assert.notEqual(staleNote.current_revision, notePreview.expected_revision);
    assert.equal((await demoFindMemoryByKey("note-1"))?.content, "v2");

    const task = await demoCreateTask({ title: "again", platform: "grok" });
    await demoUpdateTask({ id: task.id, status: "failed", result: "first" });
    const taskPreview = previewOf(await requeue({ id: task.id, dry_run: true }));
    await demoUpdateTask({ id: task.id, status: "failed", result: "second" });
    const staleTask = errorOf(await requeue({ id: task.id, expected_revision: taskPreview.expected_revision }));
    assert.equal(staleTask.code, "stale_write");
    assert.notEqual(staleTask.current_revision, taskPreview.expected_revision);
    const still = await demoGetTask(task.id);
    assert.equal(still?.status, "failed");
    assert.equal(still?.result, "second");
  });

  it("F4 missing key and missing task are not-found and write nothing", async () => {
    const missingKey = errorOf(await remove({ key: "no-such-key" }));
    assert.equal(missingKey.code, "not_found");
    assert.equal(missingKey.error, "Memory not found");
    const absent = errorOf(await remove({ key: "no-such-key", expected_revision: "absent" }));
    assert.equal(absent.code, "not_found");
    assert.equal(absent.error, "Memory not found");
    const hashed = errorOf(await remove({ key: "no-such-key", expected_revision: "a".repeat(32) }));
    assert.equal(hashed.error, "Memory not found");
    assert.equal(await demoFindMemoryByKey("no-such-key"), null);

    const missingTask = errorOf(await requeue({ id: 999999, expected_revision: "a".repeat(32) }));
    assert.equal(missingTask.code, "task_not_found");
    assert.equal(missingTask.error, "Task not found");
    assert.equal(await demoGetTask(999999), null);
  });

  it("F5 refuses a task running under another agent", async () => {
    const task = await demoCreateTask({ title: "busy", platform: "grok" });
    await demoUpdateTask({ id: task.id, status: "running", assigned_agent: "other-agent" });
    const refused = errorOf(await requeue({ id: task.id, agent_id: "this-agent", expected_revision: "a".repeat(32) }));
    assert.equal(refused.code, "forbidden");
    assert.equal(refused.error, "Task is running under another agent.");
    assert.equal((await demoGetTask(task.id))?.status, "running");
    assert.equal((await demoGetTask(task.id))?.assigned_agent, "other-agent");

    const unnamed = errorOf(await requeue({ id: task.id }));
    assert.equal(unnamed.code, "forbidden");
    assert.equal((await demoGetTask(task.id))?.status, "running");

    await demoUpdateTask({ id: task.id, status: "running", assigned_agent: "Grok 1" });
    const same = errorOf(await requeue({ id: task.id, agent_id: "grok-1" }));
    assert.equal(same.code, "conflict");
    assert.match(same.error, /running/);
    assert.equal((await demoGetTask(task.id))?.status, "running");
  });

  it("F6 rejects an unknown agent and an oversized body", async () => {
    const unknown = errorOf(await send({ agent_id: "no-such-agent", body: "hello", idempotency_key: "key-unknown" }));
    assert.equal(unknown.code, "not_found");
    assert.equal(unknown.error, "Agent not found");
    assert.equal(unknown.fields?.agent_id, "Agent not found");
    assert.equal(demoMessagesForTests().length, 0);

    const blank = errorOf(await send({ agent_id: "lane", body: "" }));
    assert.equal(blank.code, "validation_failed");
    assert.equal(blank.fields?.body, "body is required");
    const huge = errorOf(await send({ agent_id: "lane", body: "x".repeat(MESSAGE_BODY_MAX + 1), idempotency_key: "key-huge" }));
    assert.equal(huge.code, "validation_failed");
    assert.match(huge.error, /8000/);
    assert.equal(demoMessagesForTests().length, 0);
    const emptySlug = errorOf(await send({ agent_id: "!!!", body: "hello" }));
    assert.equal(emptySlug.error, "Agent not found");

    await demoReport({ agent_id: "Grok 1", kind: "status", title: "up" });
    const sized = await send({ agent_id: "Grok 1", body: "x".repeat(MESSAGE_BODY_MAX), idempotency_key: "key-huge" });
    assert.equal(sized.isError, undefined);
    assert.match(sized.content[0].text, /sent to grok-1/);
    const spaces = await send({ agent_id: "grok-1", body: "   ", created_by: "not-the-actor" });
    assert.equal(spaces.isError, undefined);
    const rows = demoMessagesForTests();
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.body, "   ");
    assert.equal(rows[1]?.actor_id, "cred-send");
    assert.equal(rows[1]?.actor_type, "agent");
    assert.equal(rows[1]?.created_by, "not-the-actor");
    assert.notEqual(rows[1]?.actor_id, "not-the-actor");
  });

  it("F7 an idempotent send_message retry returns the original", async () => {
    await demoReport({ agent_id: "lane", kind: "status", title: "up" });
    const first = await send({ agent_id: "lane", body: "once", idempotency_key: "same-key", created_by: "op" });
    const second = await send({ agent_id: "lane", body: "once", idempotency_key: "same-key", created_by: "op" });
    assert.equal(first.isError, undefined);
    assert.equal(second.content[0].text, first.content[0].text);
    assert.equal(demoMessagesForTests().length, 1);
    assert.equal(demoMessagesForTests()[0]?.thread_id, String(demoMessagesForTests()[0]?.id));

    const clash = errorOf(await send({ agent_id: "lane", body: "other", idempotency_key: "same-key", created_by: "op" }));
    assert.equal(clash.code, "idempotency_conflict");
    assert.equal(demoMessagesForTests().length, 1);

    const otherActor = await send({ agent_id: "lane", body: "once", idempotency_key: "same-key", created_by: "op" }, "cred-other");
    assert.equal(otherActor.isError, undefined);
    assert.notEqual(otherActor.content[0].text, first.content[0].text);
    assert.equal(demoMessagesForTests().length, 2);
    assert.equal(demoMessagesForTests()[1]?.actor_id, "cred-other");
  });

  it("database requeue always writes conditionally on the revision it read", () => {
    // Without a caller revision, the unconditional update could requeue a task another agent claimed
    // between the read and the write (Codex review of #106, round 1).
    const src = fs.readFileSync("src/lib/operator-actions.ts", "utf8");
    const dbPath = src.slice(src.indexOf("const loaded = await readTaskForPreview(args.id);"));
    assert.match(dbPath, /expected_revision: revision\.revision \?\? loaded\.revision,/);
    assert.doesNotMatch(dbPath.slice(0, dbPath.indexOf("export async function deleteNoteTool")), /expected_revision: revision\.revision,/);
  });

  it("REST messages rejects a non-string body before the length cap", () => {
    const route = fs.readFileSync("src/app/api/messages/route.ts", "utf8");
    const typeCheck = route.indexOf('typeof body.body !== "string"');
    assert.ok(typeCheck > 0, "messages route must type-check body");
    assert.ok(typeCheck < route.indexOf("body.body.length > MESSAGE_BODY_MAX"), "type check must precede the length cap");
  });

  it("F8 demo mode matches the live preview shape and still drops REST sends", async () => {
    await demoReport({ agent_id: "lane", kind: "status", title: "up" });
    await demoRemember({ key: "note-1", content: "keep", agent_id: "lane" });
    const task = await demoCreateTask({ title: "done work", platform: "grok" });
    await demoUpdateTask({ id: task.id, status: "done", assigned_agent: "lane" });

    const preview = previewOf(await requeue({ id: task.id, dry_run: true }));
    assert.equal(preview.action, "requeue_task");
    const removed = previewOf(await remove({ key: "note-1", dry_run: true }));
    assert.equal(removed.action, "delete_memory");

    const sent = await send({ agent_id: "Lane", body: "hello" });
    assert.ok(sent.content[0].text.startsWith(`${DEMO_BANNER}\n`));
    assert.match(sent.content[0].text, /Message #\d+ sent to lane\./);
    assert.equal(demoMessagesForTests().length, 1);

    const queued = await requeue({ id: task.id, expected_revision: preview.expected_revision });
    assert.ok(queued.content[0].text.startsWith(`${DEMO_BANNER}\n`));
    assert.match(queued.content[0].text, /actor_type=agent actor_id=cred-requeue/);
    const stored = await demoGetTask(task.id);
    assert.equal(stored?.status, "queued");
    assert.equal(stored?.assigned_agent, "lane");
    assert.equal(stored?.actor_id, "cred-requeue");
    assert.equal(stored?.actor_type, "agent");

    const deleted = await remove({ key: "note-1", expected_revision: removed.expected_revision });
    assert.ok(deleted.content[0].text.startsWith(`${DEMO_BANNER}\n`));
    assert.match(deleted.content[0].text, /actor_type=agent actor_id=cred-delete/);
    assert.equal(await demoFindMemoryByKey("note-1"), null);

    const route = fs.readFileSync("src/app/api/messages/route.ts", "utf8");
    const drop = route.indexOf('note: "DATABASE_URL not set; message dropped"');
    const cap = route.indexOf("body.body.length > MESSAGE_BODY_MAX");
    assert.ok(drop > 0 && cap > drop, "REST demo drop stays ahead of the body cap");

    const spec = openApiDocument() as {
      paths: Record<string, { post?: { requestBody?: { content?: { "application/json"?: { schema?: { properties?: { body?: { maxLength?: number } } } } } } } }>;
    };
    assert.equal(spec.paths["/api/messages"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.body?.maxLength, 8000);

    const actions = fs.readFileSync("src/lib/operator-actions.ts", "utf8");
    for (const fn of ["sendMessageTool", "requeueTaskTool", "deleteNoteTool"]) {
      assert.match(actions, new RegExp(`function ${fn}[\\s\\S]*!isConfigured\\(\\)`), fn);
    }
  });

  it("F9 keeps the previous tool names and adds exactly these three", () => {
    const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const previous = [
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
    ];
    const registered = [...src.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(registered.slice(0, previous.length), previous);
    assert.deepEqual(registered.slice(previous.length), ["send_message", "requeue_task", "delete_note", "list_activity"]);
    assert.equal(src.match(/server\.registerTool\(/g)?.length, 19);
    assert.match(src, /title: "Send message",\n\s+annotations: WRITE,/);
    assert.match(src, /title: "Requeue task",\n\s+annotations: WRITE,/);
    assert.match(src, /title: "Delete note",\n\s+annotations: WRITE_DESTRUCTIVE,/);
    assert.equal(src.includes('name: "reply_to_mark"'), true);
  });

  it("requeues only done, failed, and cancelled, and a matching token deletes once", async () => {
    const task = await demoCreateTask({ title: "status matrix", platform: "any" });
    for (const status of ["queued", "claimed", "review"] as const) {
      await demoUpdateTask({ id: task.id, status });
      const blocked = errorOf(await requeue({ id: task.id, agent_id: "cred-requeue" }));
      assert.equal(blocked.code, "conflict", status);
      assert.equal((await demoGetTask(task.id))?.status, status);
    }
    for (const status of ["done", "cancelled", "failed"] as const) {
      await demoUpdateTask({ id: task.id, status, assigned_agent: "lane", result: status });
      const completedAt = (await demoGetTask(task.id))?.completed_at;
      const ok = await requeue({ id: task.id });
      assert.equal(ok.isError, undefined, status);
      const row = await demoGetTask(task.id);
      assert.equal(row?.status, "queued", status);
      assert.equal(row?.assigned_agent, "lane", status);
      assert.equal(row?.completed_at, completedAt, status);
      assert.equal(row?.actor_id, "cred-requeue", status);
    }

    await demoRemember({ key: "once", content: "gone", agent_id: "lane" });
    const token = previewOf(await remove({ key: "once", dry_run: true })).expected_revision;
    const deleted = await remove({ key: "once", expected_revision: token });
    assert.equal(deleted.isError, undefined);
    const again = errorOf(await remove({ key: "once", expected_revision: token }));
    assert.equal(again.error, "Memory not found");

    const fresh = await demoCreateTask({ title: "unconditional", platform: "any" });
    await demoUpdateTask({ id: fresh.id, status: "failed" });
    const plain = await requeue({ id: fresh.id });
    assert.equal(plain.isError, undefined);
    assert.equal((await demoGetTask(fresh.id))?.status, "queued");
  });
});
