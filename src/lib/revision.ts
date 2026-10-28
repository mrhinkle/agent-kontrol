/**
 * Revision tokens for a confirm-after-preview write.
 *
 * Postgres computes `md5(<table alias>::text)` in the same statement that
 * reads or updates the row, so a timestamp's microseconds never pass through
 * a JavaScript Date. Demo mode hashes stable JSON of the stored object.
 * The two digests are not required to match across stores. The absent token
 * is the literal `absent`.
 */
import { createHash } from "node:crypto";

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
  return "absent";
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Demo-mode revision of one stored object. Postgres uses `md5(alias::text)`. */
export function stableRowRevision(row: object): string {
  return createHash("md5").update(stableJson(row)).digest("hex");
}

export function memoryRevision(row: object): string {
  return stableRowRevision(row);
}

export function taskRevision(row: object): string {
  return stableRowRevision(row);
}
