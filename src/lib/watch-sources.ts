/**
 * Who may write which host's liveness row (mrhinkle/agent-kontrol#82).
 *
 * `WATCH_SOURCE_CREDENTIAL_IDS_JSON` maps `mini`, `macbook`, and `watcher`
 * to arrays of credential row UUIDs (`principal.id`, not an agent id and
 * not a label). Several UUIDs per source are rotation. One UUID under two
 * sources is invalid configuration. A missing or invalid document fails
 * closed. GET does not use this map.
 *
 * The beat instant rules match `beatAtForSql` in src/lib/watch.ts so a
 * string the store would reject is rejected here, before a query.
 */

import { unicodeCodePointLength, WATCH_STATUSES, type WatchStatus } from "./watch";

export const WATCH_SOURCES = ["mini", "macbook", "watcher"] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];

export const WATCH_BODY_MAX_BYTES = 8 * 1024;

const SOURCE_SET: ReadonlySet<string> = new Set(WATCH_SOURCES);
const BEAT_FIELDS = new Set(["source", "status", "detail", "beat_at"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

export type SourceBindings = Record<WatchSource, readonly string[]>;

export type BindingFailure = "absent" | "json" | "shape" | "name" | "empty" | "uuid" | "duplicate";

export type BindingResult =
  | { ok: true; bindings: SourceBindings }
  | { ok: false; reason: BindingFailure };

export type BeatInput = {
  source: WatchSource;
  status: WatchStatus;
  detail: string;
  beat_at: string;
};

export type BeatParse =
  | { ok: true; beat: BeatInput }
  | { ok: false; field: string; message: string };

export function isWatchSource(value: string): value is WatchSource {
  return SOURCE_SET.has(value);
}

function emptyBindings(): SourceBindings {
  return { mini: [], macbook: [], watcher: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent or invalid configuration. Does not echo the document. */
export function loadWatchSourceBindings(
  raw: string | undefined = process.env.WATCH_SOURCE_CREDENTIAL_IDS_JSON,
): BindingResult {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "shape" };

  const bindings = emptyBindings();
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(parsed)) {
    if (!isWatchSource(name)) return { ok: false, reason: "name" };
    if (!Array.isArray(value) || value.length === 0) return { ok: false, reason: "empty" };
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !UUID_RE.test(item)) return { ok: false, reason: "uuid" };
      const id = item.toLowerCase();
      if (seen.has(id)) return { ok: false, reason: "duplicate" };
      seen.add(id);
      ids.push(id);
    }
    bindings[name] = ids;
  }
  return { ok: true, bindings };
}

export function credentialBoundTo(bindings: SourceBindings, source: string, credentialId: string): boolean {
  if (!isWatchSource(source)) return false;
  if (typeof credentialId !== "string" || !UUID_RE.test(credentialId)) return false;
  const id = credentialId.toLowerCase();
  return bindings[source].some((item) => item === id);
}

function isRealCivilDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Finite RFC 3339 instant with an explicit `Z` or `±HH:MM` offset. */
export function parseSenderBeatAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = INSTANT_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  if (
    month < 1 || month > 12
    || day < 1
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59
    || !isRealCivilDate(year, month, day)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return value;
}

function reject(field: string, message: string): BeatParse {
  return { ok: false, field, message };
}

/** One beat object. `received_at` and `age_s` are server-owned. */
export function parseWatchBeat(value: unknown): BeatParse {
  if (!isPlainObject(value)) {
    return reject("body", "Send a JSON object with source, status, detail, and beat_at.");
  }
  if (Object.prototype.hasOwnProperty.call(value, "received_at")) {
    return reject("received_at", "The server sets received_at. Do not send it.");
  }
  if (Object.prototype.hasOwnProperty.call(value, "age_s")) {
    return reject("age_s", "The server sets age_s from the database clock. Do not send it.");
  }
  for (const key of Object.keys(value)) {
    if (!BEAT_FIELDS.has(key)) return reject(key, "Unexpected field.");
  }

  const source = value.source;
  if (typeof source !== "string" || !isWatchSource(source)) {
    return reject("source", "source must be mini, macbook, or watcher.");
  }
  const status = value.status;
  if (typeof status !== "string" || !(WATCH_STATUSES as readonly string[]).includes(status)) {
    return reject("status", "status must be one of ok, held, paused, stale, failing, unknown.");
  }
  if (typeof value.detail !== "string") return reject("detail", "detail must be a string.");
  if (unicodeCodePointLength(value.detail) > 500) {
    return reject("detail", "detail must be at most 500 Unicode code points.");
  }
  const beatAt = parseSenderBeatAt(value.beat_at);
  if (!beatAt) {
    return reject("beat_at", "beat_at must be a finite RFC 3339 timestamp with an explicit offset.");
  }
  return {
    ok: true,
    beat: { source, status: status as WatchStatus, detail: value.detail, beat_at: beatAt },
  };
}
