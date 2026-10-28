/**
 * Revision tokens for a confirm-after-preview write.
 *
 * A row with `updated_at` uses that timestamp. A row without one uses
 * `rev:` plus an MD5 of the current value. The absent token is the preview
 * of a missing memory key. Postgres compares the timestamp in the UPDATE
 * predicate, or the same MD5 expression the preview selected. Demo mode
 * compares the token this module builds. The two hashes are not required
 * to be equal across those stores; each store compares a token to itself.
 */
import { createHash } from "node:crypto";

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export class StaleWrite extends Error {
  readonly currentRevision: string;

  constructor(currentRevision: string) {
    super("stale_write");
    this.name = "StaleWrite";
    this.currentRevision = currentRevision;
  }
}

/** Preview of a memory key that has no row yet. */
export function absentRevision(): string {
  return `rev:${createHash("md5").update("absent").digest("hex")}`;
}

export function updatedAtToken(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

export function isTimestampRevision(value: string): boolean {
  return TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

/** Hex digest without the `rev:` prefix, or null when the token is not a hash. */
export function hashDigest(value: string): string | null {
  const match = /^rev:([0-9a-f]{32})$/.exec(value);
  return match ? match[1] : null;
}

/**
 * Field order matches the `md5(...)` expression in `store.ts`:
 * key, content, tags joined by comma, agent_id, source, and "1" when
 * facts_at is set.
 */
export function memoryDigest(row: {
  key?: string | null;
  content?: string | null;
  tags?: unknown;
  agent_id?: string | null;
  source?: string | null;
  facts_at?: unknown;
}): string {
  const tags = Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)).join(",") : "";
  const parts = [
    row.key ?? "",
    row.content ?? "",
    tags,
    row.agent_id ?? "",
    row.source ?? "",
    row.facts_at ? "1" : "0",
  ];
  return createHash("md5").update(parts.join("\u001f")).digest("hex");
}

/**
 * Field order matches the task `md5(...)` expression in `store.ts`.
 * completed_at contributes "1" or "0" so a timestamp's text format is not
 * part of the hash.
 */
export function taskDigest(row: {
  status?: string | null;
  result?: string | null;
  cost_usd?: unknown;
  session_id?: string | null;
  assigned_agent?: string | null;
  title?: string | null;
  description?: string | null;
  project?: string | null;
  platform?: string | null;
  machine?: string | null;
  priority?: unknown;
  reviewer_platform?: string | null;
  completed_at?: unknown;
}): string {
  const parts = [
    row.status ?? "",
    row.result ?? "",
    row.cost_usd == null ? "" : String(row.cost_usd),
    row.session_id ?? "",
    row.assigned_agent ?? "",
    row.title ?? "",
    row.description ?? "",
    row.project ?? "",
    row.platform ?? "",
    row.machine ?? "",
    row.priority == null ? "" : String(row.priority),
    row.reviewer_platform ?? "",
    row.completed_at ? "1" : "0",
  ];
  return createHash("md5").update(parts.join("\u001f")).digest("hex");
}

export function memoryRevision(row: {
  updated_at?: unknown;
  key?: string | null;
  content?: string | null;
  tags?: unknown;
  agent_id?: string | null;
  source?: string | null;
  facts_at?: unknown;
}): string {
  return updatedAtToken(row.updated_at) ?? `rev:${memoryDigest(row)}`;
}

export function taskRevision(row: {
  updated_at?: unknown;
  status?: string | null;
  result?: string | null;
  cost_usd?: unknown;
  session_id?: string | null;
  assigned_agent?: string | null;
  title?: string | null;
  description?: string | null;
  project?: string | null;
  platform?: string | null;
  machine?: string | null;
  priority?: unknown;
  reviewer_platform?: string | null;
  completed_at?: unknown;
}): string {
  return updatedAtToken(row.updated_at) ?? `rev:${taskDigest(row)}`;
}
