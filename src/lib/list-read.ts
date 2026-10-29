import { ActivityQueryError, activityQueryToolError, parseActivityFilters } from "./activity";
import { memoryKeyError, type McpToolResult } from "./api-error";
import { demoMemory, demoTasks } from "./demo-data";
import {
  DEMO_BANNER,
  DEMO_CAPS,
  demoListActivity,
  demoListTasks,
  demoRecall,
  demoRecallTool,
  demoTaskQueueTool,
} from "./demo-store";
import { demoSpans, demoSummary } from "./demo-traces";
import {
  ACTIVITY_LIST,
  activityKeyset,
  listParamToolError,
  ListParamError,
  memoryKeyset,
  pageRows,
  parseToolList,
  RECALL_SPEC,
  splitPage,
  TASK_QUEUE,
  taskKeyset,
  traceKeyset,
  type Page,
  type ParsedList,
} from "./list-params";
import { listActivity, listTasks, recall } from "./store";
import { listTraces } from "./trace-store";
import type { MemoryItem, Task } from "./types";
import type { TraceSummary } from "./traces";

/**
 * Shared reads for the list routes and for MCP recall / get_task_queue.
 * Omitting limit, cursor, and fields keeps the previous call and the previous prose.
 */

const OPEN = new Set(["queued", "claimed", "running", "review"]);

type Row = Record<string, unknown>;

function filterTasks(rows: Task[], status: string): Task[] {
  if (status === "all") return rows;
  if (status === "open") return rows.filter((task) => OPEN.has(task.status));
  return rows.filter((task) => task.status === status);
}

function filterMemory(
  items: MemoryItem[],
  input: { query?: string; key?: string; tags?: string[] },
): MemoryItem[] {
  const query = input.query?.toLowerCase() ?? null;
  const tags = input.tags && input.tags.length > 0 ? input.tags : null;
  return items.filter((item) => {
    if (input.key != null && item.key !== input.key) return false;
    if (query != null && !item.content.toLowerCase().includes(query)) return false;
    if (tags && !tags.some((tag) => item.tags.includes(tag))) return false;
    return true;
  });
}

export async function loadTaskPage(
  source: "database" | "demo-sample" | "demo-store",
  input: { status?: string; parsed: ParsedList },
): Promise<Page<Row>> {
  const status = input.status ?? "all";
  if (source === "database") {
    const rows = await listTasks({
      status,
      limit: input.parsed.paging ? input.parsed.take + 1 : input.parsed.take,
      keyset: input.parsed.paging,
      cursor: input.parsed.cursor ? taskKeyset(input.parsed.cursor) : null,
    });
    return splitPage(rows as unknown as Row[], input.parsed);
  }
  const rows = source === "demo-sample"
    ? filterTasks(demoTasks(), status)
    : await demoListTasks({ status, limit: DEMO_CAPS.tasks });
  return pageRows(rows as unknown as Row[], input.parsed);
}

export async function loadMemoryPage(
  source: "database" | "demo-sample" | "demo-store",
  input: { query?: string; key?: string; tags?: string[]; parsed: ParsedList },
): Promise<Page<Row>> {
  if (source === "database") {
    const rows = await recall({
      query: input.query,
      key: input.key,
      tags: input.tags,
      limit: input.parsed.paging ? input.parsed.take + 1 : input.parsed.take,
      keyset: input.parsed.paging,
      cursor: input.parsed.cursor ? memoryKeyset(input.parsed.cursor) : null,
    });
    return splitPage(rows as unknown as Row[], input.parsed);
  }
  const rows = source === "demo-sample"
    ? filterMemory(demoMemory(), input)
    : await demoRecall({
      query: input.query,
      key: input.key,
      tags: input.tags,
      limit: DEMO_CAPS.notes,
    });
  return pageRows(rows as unknown as Row[], input.parsed);
}

export async function loadTracePage(
  source: "database" | "demo-sample",
  input: { agent?: string | null; errorsOnly?: boolean; before?: string | null; parsed: ParsedList },
): Promise<Page<Row>> {
  if (source === "database") {
    const rows = await listTraces({
      agent: input.agent,
      errorsOnly: input.errorsOnly,
      before: input.before,
      limit: input.parsed.paging ? input.parsed.take + 1 : input.parsed.take,
      keyset: input.parsed.paging,
      cursor: input.parsed.cursor ? traceKeyset(input.parsed.cursor) : null,
    });
    return splitPage(rows as unknown as Row[], input.parsed);
  }
  const summary = demoSummary(demoSpans());
  let rows: TraceSummary[] = [summary];
  if (input.agent != null && summary.agent_id !== input.agent) rows = [];
  if (input.errorsOnly && summary.error_count <= 0) rows = [];
  if (input.before) {
    const cut = Date.parse(input.before);
    if (!(Date.parse(summary.started_at) < cut)) rows = [];
  }
  return pageRows(rows as unknown as Row[], input.parsed);
}

export async function loadActivityPage(
  source: "database" | "demo-store",
  input: {
    actor: string | null;
    kind: string | null;
    since: string | null;
    until: string | null;
    parsed: ParsedList;
  },
): Promise<Page<Row>> {
  if (source === "database") {
    const cursor = input.parsed.cursor ? activityKeyset(input.parsed.cursor) : null;
    const rows = await listActivity({
      actor: input.actor,
      kind: input.kind,
      since: input.since,
      until: input.until,
      limit: input.parsed.paging ? input.parsed.take + 1 : input.parsed.take,
      cursorCreatedAt: cursor?.createdAt ?? null,
      cursorId: cursor?.id ?? null,
    });
    return splitPage(rows as unknown as Row[], input.parsed);
  }
  const rows = await demoListActivity({
    actor: input.actor,
    kind: input.kind,
    since: input.since,
    until: input.until,
  });
  return pageRows(rows as unknown as Row[], input.parsed);
}

function activityLine(row: Row): string {
  const title = row.title ? ` ${String(row.title)}` : "";
  const actor = row.actor_id == null || row.actor_id === "" ? "-" : String(row.actor_id);
  return `- [${String(row.created_at)}] ${String(row.kind)}${title} actor=${actor} #${String(row.id)}`;
}

export interface ActivityListArgs {
  actor?: string;
  kind?: string;
  since?: string;
  until?: string;
  limit?: unknown;
  cursor?: unknown;
  fields?: unknown;
}

export async function listActivityResult(args: ActivityListArgs, configured: boolean): Promise<McpToolResult> {
  let filters: ReturnType<typeof parseActivityFilters>;
  try {
    filters = parseActivityFilters(args);
  } catch (err) {
    if (err instanceof ActivityQueryError) return activityQueryToolError(err);
    throw err;
  }
  try {
    const parsedList = parseToolList(ACTIVITY_LIST, args);
    const page = await loadActivityPage(configured ? "database" : "demo-store", { ...filters, parsed: parsedList });
    const text = pageText(page.rows, parsedList.fields, "No activity.", activityLine);
    return { content: [{ type: "text", text: finishText(text, !configured, page.paging, page.next_cursor) }] };
  } catch (err) {
    if (err instanceof ListParamError) return listParamToolError(err);
    throw err;
  }
}

function taskLine(task: Task): string {
  return `#${task.id} [${task.status.toUpperCase()}] (${task.platform}, p${task.priority}) ${task.title}` +
    (task.project ? ` — project: ${task.project}` : "") +
    (task.assigned_agent ? ` — agent: ${task.assigned_agent}` : "") +
    (task.result ? `\n   result: ${task.result.slice(0, 200)}` : "");
}

function recallBlock(item: MemoryItem): string {
  return `#${item.id}${item.key ? ` [${item.key}]` : ""}${item.tags.length ? ` (${item.tags.join(", ")})` : ""} by ${item.agent_id ?? "unknown"} @ ${item.updated_at}\n${item.content}`;
}

function finishText(text: string, demo: boolean, paging: boolean, next: string | null): string {
  const body = paging ? `${text}\nnext_cursor: ${next ?? "null"}` : text;
  return demo ? `${DEMO_BANNER}\n${body}` : body;
}

function pageText(
  rows: Row[],
  fields: string[] | undefined,
  empty: string,
  line: (row: Row) => string,
): string {
  if (rows.length === 0) return empty;
  if (fields) return rows.map((row) => JSON.stringify(row)).join("\n");
  return rows.map(line).join("\n");
}

export interface TaskQueueArgs {
  status?: string;
  limit?: unknown;
  cursor?: unknown;
  fields?: unknown;
}

export interface RecallArgs {
  query?: string;
  key?: string;
  tags?: string[];
  limit?: unknown;
  cursor?: unknown;
  fields?: unknown;
}

function toolActive(args: { limit?: unknown; cursor?: unknown; fields?: unknown }): boolean {
  return args.limit !== undefined || args.cursor !== undefined || args.fields !== undefined;
}

export async function taskQueueResult(args: TaskQueueArgs, configured: boolean): Promise<McpToolResult> {
  if (!toolActive(args)) {
    if (!configured) return demoTaskQueueTool({ status: args.status });
    const tasks = await listTasks({ status: args.status ?? "open", limit: 40 });
    if (tasks.length === 0) return { content: [{ type: "text", text: "Task queue is empty." }] };
    const text = tasks.map(taskLine).join("\n");
    return { content: [{ type: "text", text }] };
  }
  try {
    const parsedList = parseToolList(TASK_QUEUE, args);
    const page = await loadTaskPage(configured ? "database" : "demo-store", {
      status: args.status ?? "open",
      parsed: parsedList,
    });
    const text = pageText(page.rows, parsedList.fields, "Task queue is empty.", (row) => taskLine(row as unknown as Task));
    return { content: [{ type: "text", text: finishText(text, !configured, page.paging, page.next_cursor) }] };
  } catch (err) {
    if (err instanceof ListParamError) return listParamToolError(err);
    throw err;
  }
}

export async function recallResult(args: RecallArgs, configured: boolean): Promise<McpToolResult> {
  const badKey = memoryKeyError(args.key);
  if (badKey) return badKey;
  if (!toolActive(args)) {
    if (!configured) return demoRecallTool({ query: args.query, key: args.key, tags: args.tags });
    const items = await recall({ query: args.query, key: args.key, tags: args.tags, limit: args.limit as number | undefined });
    if (items.length === 0) return { content: [{ type: "text", text: "No matching memory." }] };
    const text = items.map(recallBlock).join("\n\n");
    return { content: [{ type: "text", text }] };
  }
  try {
    const parsedList = parseToolList(RECALL_SPEC, args);
    const page = await loadMemoryPage(configured ? "database" : "demo-store", {
      query: args.query,
      key: args.key,
      tags: args.tags,
      parsed: parsedList,
    });
    const text = pageText(page.rows, parsedList.fields, "No matching memory.", (row) => recallBlock(row as unknown as MemoryItem));
    return { content: [{ type: "text", text: finishText(text, !configured, page.paging, page.next_cursor) }] };
  } catch (err) {
    if (err instanceof ListParamError) return listParamToolError(err);
    throw err;
  }
}
