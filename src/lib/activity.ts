/**
 * Receipts for writes and the activity-list filter.
 *
 * A receipt names the events row that recorded the write. Tool text keeps
 * the sentence it already returned and adds one line after it. Callers that
 * only read the first line see the same words.
 *
 * This module does not import the database or the demo store.
 */
import { apiError, mcpToolError, type McpToolResult } from "./api-error";
import { canonicalTime, stampSortAt } from "./list-params";

export interface Receipt {
  id: string;
  kind: string;
  at: string;
}

export interface ActivityRow {
  id: number;
  agent_id: string | null;
  session_id: string | null;
  kind: string;
  title: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  actor_type: string | null;
  actor_id: string | null;
}

const RECEIPT_KEY = Symbol.for("ak.activityReceipt");
const INT_ID = /^[1-9]\d{0,18}$/;
const KIND_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export class ActivityQueryError extends Error {
  readonly field: "since" | "until" | "actor" | "kind";

  constructor(field: "since" | "until" | "actor" | "kind", message: string) {
    super(message);
    this.name = "ActivityQueryError";
    this.field = field;
  }
}

export function activityQueryError(err: ActivityQueryError): ReturnType<typeof apiError> {
  return apiError("validation_failed", {
    message: err.message,
    fields: { [err.field]: err.message },
  });
}

export function activityQueryToolError(err: ActivityQueryError): McpToolResult {
  return mcpToolError("validation_failed", {
    message: err.message,
    fields: { [err.field]: err.message },
  });
}

/** id, kind, and at, in that order, so the line is stable. */
export function receiptLine(receipt: Receipt): string {
  return `receipt: ${JSON.stringify({ id: receipt.id, kind: receipt.kind, at: receipt.at })}`;
}

export function withReceipt(text: string, receipt: Receipt | null | undefined): McpToolResult {
  if (!receipt) return { content: [{ type: "text", text }] };
  const body = { id: receipt.id, kind: receipt.kind, at: receipt.at };
  return {
    content: [{ type: "text", text: `${text}\n${receiptLine(receipt)}` }],
    structuredContent: { receipt: body },
  };
}

export function receiptFromParts(id: unknown, kind: unknown, at: unknown): Receipt | null {
  if (typeof kind !== "string" || kind.length === 0) return null;
  const when = canonicalTime(at);
  if (!when) return null;
  const raw = typeof id === "bigint" ? id.toString() : typeof id === "number" ? String(id) : typeof id === "string" ? id : "";
  if (!INT_ID.test(raw)) return null;
  return { id: raw, kind, at: when };
}

/** Hidden on the object. JSON and object spread do not copy it. */
export function attachReceipt<T extends object>(target: T, receipt: Receipt): T {
  Object.defineProperty(target, RECEIPT_KEY, { value: receipt, enumerable: false });
  return target;
}

export function readReceipt(value: unknown): Receipt | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<symbol, unknown>)[RECEIPT_KEY];
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Receipt;
  return receiptFromParts(rec.id, rec.kind, rec.at);
}

function blank(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

function parseBound(name: "since" | "until", raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null;
  const canon = canonicalTime(raw.trim());
  if (!canon) throw new ActivityQueryError(name, `${name} must be an ISO timestamp`);
  return canon;
}

/**
 * since and until are inclusive instants. A since later than until is rejected.
 * actor is an exact actor_id. kind is an exact events.kind.
 */
export function parseActivityFilters(input: {
  actor?: string | null;
  kind?: string | null;
  since?: string | null;
  until?: string | null;
}): { actor: string | null; kind: string | null; since: string | null; until: string | null } {
  const actor = blank(input.actor);
  const kind = blank(input.kind);
  if (actor && actor.length > 200) {
    throw new ActivityQueryError("actor", "actor must be at most 200 characters.");
  }
  if (kind && !KIND_RE.test(kind)) {
    throw new ActivityQueryError("kind", "kind must be 1 to 64 letters, digits, or _ . : -");
  }
  const since = parseBound("since", input.since);
  const until = parseBound("until", input.until);
  if (since && until && since > until) {
    throw new ActivityQueryError("until", "until must be greater than or equal to since");
  }
  return { actor, kind, since, until };
}

function stringOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function detailObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return detailObject(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** One events row, with the actor copied out of detail for filters and fields=. */
export function activityRow(input: Record<string, unknown>): ActivityRow {
  const created = canonicalTime(input.created_at);
  if (!created) throw new Error("activity row is missing created_at");
  const id = typeof input.id === "bigint" ? Number(input.id) : Number(input.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("activity row id is not a safe integer");
  const detail = detailObject(input.detail);
  const row: ActivityRow = {
    id,
    agent_id: stringOrNull(input.agent_id),
    session_id: stringOrNull(input.session_id),
    kind: String(input.kind ?? ""),
    title: stringOrNull(input.title),
    detail,
    created_at: created,
    actor_type: stringOrNull(input.actor_type) ?? stringOrNull(detail?.actor_type),
    actor_id: stringOrNull(input.actor_id) ?? stringOrNull(detail?.actor_id),
  };
  stampSortAt(row, created);
  return row;
}

export function activityDetail(
  tool: string,
  actor: { actor_type: string; actor_id: string } | null,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tool,
    actor_type: actor?.actor_type ?? null,
    actor_id: actor?.actor_id ?? null,
    ...extra,
  };
}
