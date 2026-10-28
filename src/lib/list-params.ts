import { apiError, mcpToolError, type McpToolResult } from "./api-error";

/**
 * Keyset pagination for the task, memory, and trace lists.
 *
 * A cursor is the opaque base64url of { r, k, id }: the sort key and id of the
 * last row the caller already has. The next page is rows strictly after that
 * point. Inserts ahead of the cursor do not shift later pages, and rows that
 * share a timestamp stay ordered by id. This is not OFFSET.
 *
 * `next_cursor` is added only when the caller passed `limit` or `cursor`.
 * Field names are checked against an allowlist and copied in JavaScript.
 * They are never interpolated into SQL.
 */

export const LIST_MAX = 200;

/** Non-enumerable millisecond timestamp used to build a cursor. JSON omits it. */
export const LIST_SORT_AT: unique symbol = Symbol.for("ak.listSortAt");

export const LIMIT_MESSAGE = "limit must be an integer from 1 to 200.";
export const CURSOR_MESSAGE = "cursor is not valid for this list.";
export const FIELDS_MESSAGE = "fields must be a comma-separated list of allowlisted names.";

const TIME_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LIMIT_RE = /^(?:0|[1-9]\d*)$/;
const STATUS_RE = /^[a-z_]{1,32}$/;
const INT_ID_RE = /^[1-9]\d{0,18}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const OPAQUE_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BIGINT = 9223372036854775807n;
const PRIORITY_MIN = -1_000_000;
const PRIORITY_MAX = 1_000_000;

export type ListResource = "task" | "memory" | "trace";

export class ListParamError extends Error {
  readonly field: "limit" | "cursor" | "fields";

  constructor(field: "limit" | "cursor" | "fields", message: string) {
    super(message);
    this.name = "ListParamError";
    this.field = field;
  }
}

export function listParamError(err: ListParamError): ReturnType<typeof apiError> {
  return apiError("validation_failed", {
    message: err.message,
    fields: { [err.field]: err.message },
  });
}

export function listParamToolError(err: ListParamError): McpToolResult {
  return mcpToolError("validation_failed", {
    message: err.message,
    fields: { [err.field]: err.message },
  });
}

interface SortKey {
  name: string;
  dir: "asc" | "desc";
  type: "status" | "int" | "time";
}

export interface ListSpec {
  resource: ListResource;
  idField: "id" | "trace_id";
  idKind: "int" | "trace";
  keys: readonly SortKey[];
  allow: readonly string[];
  allowSet: ReadonlySet<string>;
  defaultLimit: number;
}

export interface DecodedCursor {
  resource: ListResource;
  k: (string | number)[];
  id: string;
}

export interface ParsedList {
  spec: ListSpec;
  /** Set only when the caller passed limit. */
  limit: number | undefined;
  cursor: DecodedCursor | null;
  /** Set only when the caller passed fields. */
  fields: string[] | undefined;
  /** True when limit or cursor was passed. That is when next_cursor is returned. */
  paging: boolean;
  /** True when limit, cursor, or fields was passed. */
  active: boolean;
  /** Rows to keep. The database fetch adds one peek row when paging. */
  take: number;
}

export interface Page<T> {
  rows: T[];
  next_cursor: string | null;
  paging: boolean;
}

export interface TaskKeyset {
  status: string;
  priority: number;
  updatedAt: string;
  id: string;
}

export interface MemoryKeyset {
  updatedAt: string;
  id: string;
}

export interface TraceKeyset {
  startedAt: string;
  id: string;
}

const TASK_ALLOW = [
  "id",
  "title",
  "description",
  "project",
  "platform",
  "machine",
  "priority",
  "status",
  "reviewer_platform",
  "assigned_agent",
  "session_id",
  "result",
  "cost_usd",
  "created_by",
  "actor_type",
  "actor_id",
  "created_at",
  "claimed_at",
  "updated_at",
  "completed_at",
] as const;

const MEMORY_ALLOW = [
  "id",
  "key",
  "content",
  "tags",
  "agent_id",
  "source",
  "facts_at",
  "created_at",
  "updated_at",
] as const;

const TRACE_ALLOW = [
  "trace_id",
  "agent_id",
  "root_name",
  "started_at",
  "ended_at",
  "span_count",
  "error_count",
  "open_count",
  "input_tokens",
  "output_tokens",
  "cost_usd",
] as const;

function makeSpec(
  resource: ListResource,
  idField: "id" | "trace_id",
  idKind: "int" | "trace",
  keys: readonly SortKey[],
  allow: readonly string[],
  defaultLimit: number,
): ListSpec {
  return { resource, idField, idKind, keys, allow, allowSet: new Set(allow), defaultLimit };
}

const TASK_KEYS: readonly SortKey[] = [
  { name: "status", dir: "asc", type: "status" },
  { name: "priority", dir: "asc", type: "int" },
  { name: "updated_at", dir: "desc", type: "time" },
];

const MEMORY_KEYS: readonly SortKey[] = [{ name: "updated_at", dir: "desc", type: "time" }];
const TRACE_KEYS: readonly SortKey[] = [{ name: "started_at", dir: "desc", type: "time" }];

/** REST tasks. Default 100, matching listTasks. */
export const TASK_REST: ListSpec = makeSpec("task", "id", "int", TASK_KEYS, TASK_ALLOW, 100);
/** MCP get_task_queue. Same sort and fields. Default stays 40. */
export const TASK_QUEUE: ListSpec = { ...TASK_REST, defaultLimit: 40 };
/** REST memory. Default 50, matching the route. */
export const MEMORY_REST: ListSpec = makeSpec("memory", "id", "int", MEMORY_KEYS, MEMORY_ALLOW, 50);
/** MCP recall. Same sort and fields. Default stays 20. */
export const RECALL_SPEC: ListSpec = { ...MEMORY_REST, defaultLimit: 20 };
/** REST traces. Default 50. */
export const TRACE_LIST: ListSpec = makeSpec("trace", "trace_id", "trace", TRACE_KEYS, TRACE_ALLOW, 50);

export function stampSortAt(row: object, iso: string): void {
  Object.defineProperty(row, LIST_SORT_AT, { value: iso, enumerable: false });
}

function bad(field: "limit" | "cursor" | "fields"): never {
  const message = field === "limit" ? LIMIT_MESSAGE : field === "cursor" ? CURSOR_MESSAGE : FIELDS_MESSAGE;
  throw new ListParamError(field, message);
}

function cmpText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function canonicalTime(value: unknown): string | null {
  if (typeof value === "string" && TIME_MS.test(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function timeOf(row: object, field: string): string {
  const stamp = (row as { [LIST_SORT_AT]?: unknown })[LIST_SORT_AT];
  if (typeof stamp === "string" && TIME_MS.test(stamp)) return stamp;
  const value = (row as Record<string, unknown>)[field];
  const canon = canonicalTime(value);
  if (!canon) throw new Error("list row is missing a sort time");
  return canon;
}

function keyValues(spec: ListSpec, row: Record<string, unknown>): (string | number)[] {
  return spec.keys.map((key) => {
    if (key.type === "time") return timeOf(row, key.name);
    if (key.type === "int") return Number(row[key.name]);
    return String(row[key.name]);
  });
}

function compareIds(spec: ListSpec, rowId: unknown, cursorId: string): number {
  if (spec.idKind === "int") {
    const delta = BigInt(String(rowId)) - BigInt(cursorId);
    if (delta < 0n) return -1;
    if (delta > 0n) return 1;
    return 0;
  }
  return cmpText(String(rowId), cursorId);
}

/** Positive when `row` sorts strictly after the cursor. */
export function compareToCursor(spec: ListSpec, row: Record<string, unknown>, cursor: DecodedCursor): number {
  const values = keyValues(spec, row);
  for (let i = 0; i < spec.keys.length; i++) {
    const key = spec.keys[i];
    const left = values[i];
    const right = cursor.k[i];
    const cmp = key.type === "int"
      ? Number(left) - Number(right)
      : cmpText(String(left), String(right));
    if (cmp !== 0) return key.dir === "asc" ? cmp : -cmp;
  }
  return compareIds(spec, row[spec.idField], cursor.id);
}

function compareRows(spec: ListSpec, a: Record<string, unknown>, b: Record<string, unknown>): number {
  const cursor: DecodedCursor = { resource: spec.resource, k: keyValues(spec, b), id: String(b[spec.idField]) };
  return compareToCursor(spec, a, cursor);
}

export function encodeCursor(spec: ListSpec, row: Record<string, unknown>): string {
  const payload = { r: spec.resource, k: keyValues(spec, row), id: String(row[spec.idField]) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseIntId(id: unknown): string {
  if (typeof id !== "string" || !INT_ID_RE.test(id)) bad("cursor");
  if (BigInt(id) > MAX_BIGINT) bad("cursor");
  return id;
}

function parseTraceId(id: unknown): string {
  if (typeof id !== "string" || !TRACE_ID_RE.test(id)) bad("cursor");
  return id;
}

export function decodeCursor(spec: ListSpec, token: string): DecodedCursor {
  if (typeof token !== "string" || !OPAQUE_RE.test(token)) bad("cursor");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== token) bad("cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    bad("cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad("cursor");
  const record = parsed as Record<string, unknown>;
  const names = Object.keys(record);
  if (names.length !== 3 || names[0] !== "r" || names[1] !== "k" || names[2] !== "id") bad("cursor");
  if (record.r !== spec.resource) bad("cursor");
  if (!Array.isArray(record.k) || record.k.length !== spec.keys.length) bad("cursor");
  const k: (string | number)[] = [];
  for (let i = 0; i < spec.keys.length; i++) {
    const key = spec.keys[i];
    const value = record.k[i];
    if (key.type === "time") {
      if (typeof value !== "string" || !TIME_MS.test(value)) bad("cursor");
      k.push(value);
    } else if (key.type === "status") {
      if (typeof value !== "string" || !STATUS_RE.test(value)) bad("cursor");
      k.push(value);
    } else if (typeof value !== "number" || !Number.isInteger(value) || value < PRIORITY_MIN || value > PRIORITY_MAX) {
      bad("cursor");
    } else {
      k.push(value);
    }
  }
  const id = spec.idKind === "int" ? parseIntId(record.id) : parseTraceId(record.id);
  return { resource: spec.resource, k, id };
}

function parseLimitText(raw: string): number {
  if (!LIMIT_RE.test(raw)) bad("limit");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > LIST_MAX) bad("limit");
  return n;
}

function parseToolLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LIST_MAX) bad("limit");
  return value;
}

function parseFields(spec: ListSpec, raw: string): string[] {
  if (raw.length === 0) bad("fields");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name || !spec.allowSet.has(name)) bad("fields");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length === 0) bad("fields");
  return out;
}

function parsed(
  spec: ListSpec,
  limit: number | undefined,
  cursor: DecodedCursor | null,
  fields: string[] | undefined,
  paging: boolean,
  active: boolean,
): ParsedList {
  return { spec, limit, cursor, fields, paging, active, take: limit ?? spec.defaultLimit };
}

export function parseSearchList(spec: ListSpec, params: URLSearchParams): ParsedList {
  const hasLimit = params.has("limit");
  const hasCursor = params.has("cursor");
  const hasFields = params.has("fields");
  const limit = hasLimit ? parseLimitText(params.get("limit") ?? "") : undefined;
  const cursor = hasCursor ? decodeCursor(spec, params.get("cursor") ?? "") : null;
  const fields = hasFields ? parseFields(spec, params.get("fields") ?? "") : undefined;
  return parsed(spec, limit, cursor, fields, hasLimit || hasCursor, hasLimit || hasCursor || hasFields);
}

export function parseToolList(
  spec: ListSpec,
  args: { limit?: unknown; cursor?: unknown; fields?: unknown },
): ParsedList {
  const hasLimit = args.limit !== undefined;
  const hasCursor = args.cursor !== undefined;
  const hasFields = args.fields !== undefined;
  const limit = hasLimit ? parseToolLimit(args.limit) : undefined;
  if (hasCursor && typeof args.cursor !== "string") bad("cursor");
  const cursor = hasCursor ? decodeCursor(spec, args.cursor as string) : null;
  if (hasFields && typeof args.fields !== "string") bad("fields");
  const fields = hasFields ? parseFields(spec, args.fields as string) : undefined;
  return parsed(spec, limit, cursor, fields, hasLimit || hasCursor, hasLimit || hasCursor || hasFields);
}

/** Copy allowlisted names onto a fresh object. `id` (or `trace_id`) is always first. */
export function projectFields(
  row: Record<string, unknown>,
  spec: ListSpec,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (!fields) return row;
  const out: Record<string, unknown> = Object.create(null);
  out[spec.idField] = row[spec.idField];
  for (const name of fields) {
    if (name === spec.idField) continue;
    if (Object.prototype.hasOwnProperty.call(row, name)) out[name] = row[name];
  }
  return out;
}

function cut<T extends Record<string, unknown>>(ordered: T[], parsedList: ParsedList): Page<T> {
  const page = ordered.slice(0, parsedList.take);
  const more = parsedList.paging && ordered.length > parsedList.take;
  const next = more && page.length > 0 ? encodeCursor(parsedList.spec, page[page.length - 1]) : null;
  const rows = parsedList.fields
    ? page.map((row) => projectFields(row, parsedList.spec, parsedList.fields) as T)
    : page;
  return { rows, next_cursor: parsedList.paging ? next : null, paging: parsedList.paging };
}

/** Sort and drop the cursor row. For the in-memory demo sample and the demo store. */
export function pageRows<T extends Record<string, unknown>>(rows: readonly T[], parsedList: ParsedList): Page<T> {
  const spec = parsedList.spec;
  const sorted = [...rows].sort((a, b) => compareRows(spec, a, b));
  const after = parsedList.cursor
    ? sorted.filter((row) => compareToCursor(spec, row, parsedList.cursor as DecodedCursor) > 0)
    : sorted;
  return cut(after, parsedList);
}

/** The database already ordered and filtered. Do not sort again. */
export function splitPage<T extends Record<string, unknown>>(rows: readonly T[], parsedList: ParsedList): Page<T> {
  return cut([...rows], parsedList);
}

export function listBody(
  name: string,
  rows: unknown[],
  paging: boolean,
  next: string | null,
  demo: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { demo, [name]: rows };
  if (paging) body.next_cursor = next;
  return body;
}

export function taskKeyset(cursor: DecodedCursor): TaskKeyset {
  return {
    status: String(cursor.k[0]),
    priority: Number(cursor.k[1]),
    updatedAt: String(cursor.k[2]),
    id: cursor.id,
  };
}

export function memoryKeyset(cursor: DecodedCursor): MemoryKeyset {
  return { updatedAt: String(cursor.k[0]), id: cursor.id };
}

export function traceKeyset(cursor: DecodedCursor): TraceKeyset {
  return { startedAt: String(cursor.k[0]), id: cursor.id };
}
