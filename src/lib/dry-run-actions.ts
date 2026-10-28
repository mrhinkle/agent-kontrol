/**
 * Server side of a dry run. The preview helpers only read. The tool helpers
 * write only when dry_run is not true, and they are what the MCP handlers call.
 */
import { memoryKeyError, mcpToolError, type McpToolResult } from "./api-error";
import { isConfigured } from "./db";
import {
  diffMemoryWrite,
  diffTaskUpdate,
  refusedDryRun,
  type DryRunResult,
  type MemoryWriteInput,
  type StoredMemory,
  type TaskPatch,
} from "./dry-run";
import { findMemoryByKey, getTask, remember, report, updateTask } from "./store";
import type { TaskStatus } from "./types";

export async function previewTaskChange(id: number, patch: TaskPatch): Promise<DryRunResult | null> {
  const task = await getTask(id);
  if (!task) return null;
  return diffTaskUpdate(task, patch);
}

export async function previewMemoryWrite(input: MemoryWriteInput): Promise<DryRunResult> {
  const key = input.key ?? null;
  const existing = key ? ((await findMemoryByKey(key)) as StoredMemory | null) : null;
  return diffMemoryWrite(existing, input);
}

export async function rememberForTool(args: {
  content: string;
  key?: string;
  tags?: string[];
  agent_id?: string;
  dry_run?: boolean;
}): Promise<McpToolResult> {
  const badKey = memoryKeyError(args.key);
  if (badKey) return badKey;
  if (args.dry_run === true) {
    if (!isConfigured()) {
      const preview = diffMemoryWrite(null, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...preview, would_write: false, note: "Demo mode; note not stored." }),
          },
        ],
      };
    }
    const preview = await previewMemoryWrite(args);
    return { content: [{ type: "text", text: JSON.stringify(preview) }] };
  }
  if (!isConfigured()) {
    return { content: [{ type: "text", text: "Demo mode; note not stored." }] };
  }
  const item = await remember(args);
  return {
    content: [{ type: "text", text: `Stored memory #${item.id}${item.key ? ` (key: ${item.key})` : ""}.` }],
  };
}

export async function updateTaskForTool(args: {
  id: number;
  status?: TaskStatus;
  result?: string;
  cost_usd?: number;
  agent_id?: string;
  dry_run?: boolean;
}): Promise<McpToolResult> {
  if (args.dry_run === true) {
    if (!isConfigured()) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              refusedDryRun(
                args.status === "cancelled" ? "cancel_task" : "update_task",
                "Demo mode; task not updated.",
              ),
            ),
          },
        ],
      };
    }
    const preview = await previewTaskChange(args.id, args);
    if (!preview) return mcpToolError("task_not_found");
    return { content: [{ type: "text", text: JSON.stringify(preview) }] };
  }
  if (!isConfigured()) {
    return { content: [{ type: "text", text: "Demo mode; task not updated." }] };
  }
  const task = await updateTask({
    id: args.id,
    status: args.status,
    result: args.result,
    cost_usd: args.cost_usd,
  });
  if (args.status && args.agent_id) {
    await report({
      agent_id: args.agent_id,
      kind: args.status === "failed" ? "error" : "status",
      title: `Task #${task.id} → ${args.status}: ${task.title}`,
      detail: { task_id: task.id },
    });
  }
  return { content: [{ type: "text", text: `Task #${task.id} updated (${task.status}).` }] };
}
