/**
 * MCP handlers for the operator actions the dashboard already performs:
 * enqueue a message, requeue a finished task, and delete a memory note.
 * The route file only registers them. Demo mode and Postgres share this entry.
 */
import { currentActor, type Actor } from "./actor";
import { readReceipt, withReceipt } from "./activity";
import { memoryKeyError, mcpToolError, type McpToolResult } from "./api-error";
import { isConfigured } from "./db";
import { DEMO_BANNER, demoDeleteMemory, demoRequeueTask, demoSendMessage } from "./demo-store";
import { diffMemoryDelete, diffTaskRequeue, readDryRun, readExpectedRevision } from "./dry-run";
import { messageBodyProblem } from "./message-body";
import { requeueBlock, requeueCallerId } from "./requeue";
import { StaleWrite } from "./revision";
import {
  deleteMemory,
  enqueueMessage,
  findAgent,
  readMemoryForPreview,
  readTaskForPreview,
  recordSubjectReceipt,
  updateTask,
} from "./store";

function dryRunRejected(): McpToolResult {
  return mcpToolError("validation_failed", {
    message: "dry_run must be a boolean.",
    fields: { dry_run: "Use true to preview, or false to apply." },
  });
}

function revisionRejected(): McpToolResult {
  return mcpToolError("validation_failed", {
    message: "expected_revision must be a string of 1 to 200 characters.",
    fields: { expected_revision: "Send the revision from the preview, or omit it." },
  });
}

function labeled(text: string, demo: boolean): string {
  return demo ? `${DEMO_BANNER}\n${text}` : text;
}

function requeuedText(id: number, actor: Actor | null): string {
  if (!actor) return `Task #${id} requeued.`;
  return `Task #${id} requeued. actor_type=${actor.actor_type} actor_id=${actor.actor_id}.`;
}

function deletedText(key: string, actor: Actor | null): string {
  if (!actor) return `Deleted memory key "${key}".`;
  return `Deleted memory key "${key}". actor_type=${actor.actor_type} actor_id=${actor.actor_id}.`;
}

function agentNotFound(): McpToolResult {
  return mcpToolError("not_found", {
    message: "Agent not found",
    fields: { agent_id: "Agent not found" },
  });
}

function memoryNotFound(): McpToolResult {
  return mcpToolError("not_found", { message: "Memory not found" });
}

export async function sendMessageTool(args: {
  agent_id: string;
  body: string;
  created_by?: string;
  idempotency_key?: string;
}): Promise<McpToolResult> {
  const problem = messageBodyProblem(args.body);
  if (problem) {
    return mcpToolError("validation_failed", { message: problem, fields: { body: problem } });
  }
  const actor = currentActor();
  if (!isConfigured()) {
    const sent = await demoSendMessage({
      agent_id: args.agent_id,
      body: args.body,
      created_by: args.created_by,
      actor,
      idempotency_key: args.idempotency_key,
    });
    if (sent.kind === "missing") return agentNotFound();
    const text = `Message #${sent.message.id} sent to ${sent.message.agent_id}.`;
    return withReceipt(labeled(text, true), readReceipt(sent.message));
  }
  const agent = await findAgent(args.agent_id);
  if (!agent) return agentNotFound();
  const message = await enqueueMessage({
    agent_id: args.agent_id,
    body: args.body,
    created_by: args.created_by,
    actor,
    idempotency_key: args.idempotency_key,
  });
  const text = `Message #${message.id} sent to ${message.agent_id}.`;
  const receipt = await recordSubjectReceipt({
    kind: "send_message",
    title: text.replace(/\.$/, ""),
    tool: "send_message",
    matchKey: "message_id",
    matchValue: String(message.id),
    reuse: true,
  });
  return withReceipt(text, receipt);
}

export async function requeueTaskTool(args: {
  id: number;
  agent_id?: string;
  dry_run?: unknown;
  expected_revision?: unknown;
}): Promise<McpToolResult> {
  const dry = readDryRun(args.dry_run);
  if (!dry.ok) return dryRunRejected();
  const revision = readExpectedRevision(args.expected_revision);
  if (!revision.ok) return revisionRejected();
  const actor = currentActor();
  const callerId = requeueCallerId(args, actor?.actor_id);
  if (!isConfigured()) {
    const result = await demoRequeueTask({
      id: args.id,
      callerId,
      dryRun: dry.dryRun,
      expectedRevision: revision.revision,
      actor,
    });
    if (result.kind === "missing") return mcpToolError("task_not_found");
    if (result.kind === "blocked") return mcpToolError(result.code, { message: result.message });
    if (result.kind === "preview") {
      const preview = diffTaskRequeue(result.task, result.revision, actor);
      return { content: [{ type: "text", text: JSON.stringify(preview) }] };
    }
    return withReceipt(labeled(requeuedText(result.task.id, actor), true), readReceipt(result.task));
  }
  const loaded = await readTaskForPreview(args.id);
  if (!loaded) return mcpToolError("task_not_found");
  const block = requeueBlock(loaded.task, callerId);
  if (!block.ok) return mcpToolError(block.code, { message: block.message });
  if (dry.dryRun) {
    return {
      content: [{ type: "text", text: JSON.stringify(diffTaskRequeue(loaded.task, loaded.revision, actor)) }],
    };
  }
  // Always guard on a revision: with none from the caller, use the one read above, so a task
  // claimed by another agent between the read and this write is refused, not requeued.
  const task = await updateTask({
    id: args.id,
    status: "queued",
    expected_revision: revision.revision ?? loaded.revision,
    actor,
    eventKind: "task_requeued",
    activityTool: "requeue_task",
  });
  return withReceipt(requeuedText(task.id, actor), readReceipt(task));
}

export async function deleteNoteTool(args: {
  key: string;
  dry_run?: unknown;
  expected_revision?: unknown;
}): Promise<McpToolResult> {
  const badKey = memoryKeyError(typeof args.key === "string" ? args.key : "");
  if (badKey) return badKey;
  const dry = readDryRun(args.dry_run);
  if (!dry.ok) return dryRunRejected();
  const revision = readExpectedRevision(args.expected_revision);
  if (!revision.ok) return revisionRejected();
  const actor = currentActor();
  if (!isConfigured()) {
    try {
      const result = await demoDeleteMemory({
        key: args.key,
        dryRun: dry.dryRun,
        expectedRevision: revision.revision,
      });
      if (result.kind === "missing") return memoryNotFound();
      if (result.kind === "preview") {
        return {
          content: [{ type: "text", text: JSON.stringify(diffMemoryDelete(result.item, result.revision)) }],
        };
      }
      return withReceipt(labeled(deletedText(args.key, actor), true), readReceipt(result.item));
    } catch (err) {
      const mapped = mapDeleteError(err);
      if (mapped) return mapped;
      throw err;
    }
  }
  if (dry.dryRun) {
    const loaded = await readMemoryForPreview(args.key);
    if (!loaded) return memoryNotFound();
    return {
      content: [{ type: "text", text: JSON.stringify(diffMemoryDelete(loaded.item, loaded.revision)) }],
    };
  }
  try {
    const removed = await deleteMemory({ key: args.key, expected_revision: revision.revision });
    const text = deletedText(removed.key ?? args.key, actor);
    const receipt = await recordSubjectReceipt({
      kind: "delete_note",
      title: text.replace(/\.$/, ""),
      tool: "delete_note",
      matchKey: "memory_key",
      matchValue: removed.key ?? args.key,
      reuse: false,
      extra: { memory_id: String(removed.id) },
    });
    return withReceipt(text, receipt);
  } catch (err) {
    const mapped = mapDeleteError(err);
    if (mapped) return mapped;
    throw err;
  }
}

/** A stale confirm is an isError result, same as the route's guard. Nothing was deleted. */
function mapDeleteError(err: unknown): McpToolResult | null {
  if (err instanceof StaleWrite) {
    return mcpToolError("stale_write", { extra: { current_revision: err.currentRevision } });
  }
  if (err instanceof Error && err.message === "Memory not found") return memoryNotFound();
  return null;
}
