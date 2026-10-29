/**
 * Server side of a dry run. The preview helpers only read. The tool helpers
 * write only when dry_run is not true, and they are what the MCP handlers call.
 */
import { memoryKeyError, mcpToolError, type McpToolResult } from "./api-error";
import { isConfigured } from "./db";
import {
  diffMemoryWrite,
  diffTaskUpdate,
  type DryRunResult,
  type MemoryWriteInput,
  type StoredMemory,
  type TaskPatch,
} from "./dry-run";
import { demoRememberTool, demoUpdateTaskTool } from "./demo-store";
import { absentRevision } from "./revision";
import { readMemoryForPreview, readTaskForPreview, remember, report, updateTask } from "./store";
import type { TaskStatus } from "./types";

export async function previewTaskChange(id: number, patch: TaskPatch): Promise<DryRunResult | null> {
  const loaded = await readTaskForPreview(id);
  if (!loaded) return null;
  return diffTaskUpdate(loaded.task, patch, loaded.revision);
}

export async function previewMemoryWrite(input: MemoryWriteInput): Promise<DryRunResult> {
  const key = input.key ?? null;
  if (!key) return diffMemoryWrite(null, input, absentRevision());
  const loaded = await readMemoryForPreview(key);
  if (!loaded) return diffMemoryWrite(null, input, absentRevision());
  return diffMemoryWrite(loaded.item as StoredMemory, input, loaded.revision);
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
  if (!isConfigured()) return demoRememberTool(args);
  if (args.dry_run === true) {
    const preview = await previewMemoryWrite(args);
    return { content: [{ type: "text", text: JSON.stringify(preview) }] };
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
  if (!isConfigured()) return demoUpdateTaskTool(args);
  if (args.dry_run === true) {
    const preview = await previewTaskChange(args.id, args);
    if (!preview) return mcpToolError("task_not_found");
    return { content: [{ type: "text", text: JSON.stringify(preview) }] };
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
