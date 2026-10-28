import { sql } from "./db";

/**
 * Host liveness beats (mrhinkle/agent-kontrol#81).
 *
 * One row per source. `beat_at` is the sender's instant. `received_at` is
 * the database clock at the last successful insert or conflict update.
 * Callers cannot supply `received_at`. Liveness age is
 * max(0, floor(database_now - received_at)) in whole seconds. `beat_at`
 * does not decide acceptance, overwrite order, or that age.
 *
 * `upsertBeat` takes `beatAt` as either:
 * - an RFC3339 / ISO-8601 instant string: `YYYY-MM-DDTHH:MM:SS[.fraction]Z`
 *   or the same with a numeric offset `±HH:MM` (`T` and `Z` are
 *   case-insensitive; the offset colon is required), passed through to
 *   Postgres so fractional seconds survive in the column, or
 * - a `Date`, stored as that instant in UTC (millisecond precision via
 *   `Date.toISOString()`).
 * Invalid instants are rejected before a query runs.
 */

export const WATCH_STATUSES = ["ok", "held", "paused", "stale", "failing", "unknown"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export type WatchBeat = {
  source: string;
  status: WatchStatus;
  detail: string;
  beat_at: string;
  received_at: string;
  age_s: number;
};

export class WatchBeatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchBeatError";
  }
}

const DETAIL_MAX_CODE_POINTS = 500;

// Groups: year, month, day, hour, minute, second, fraction, offset hour, offset minute.
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Unicode code points, not UTF-16 units. One emoji is 1, matching Postgres char_length. */
export function unicodeCodePointLength(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

function assertSource(source: unknown): string {
  if (typeof source !== "string" || unicodeCodePointLength(source) === 0) {
    throw new WatchBeatError("source must be a nonempty string");
  }
  return source;
}

function assertStatus(status: unknown): WatchStatus {
  if (typeof status !== "string" || !(WATCH_STATUSES as readonly string[]).includes(status)) {
    throw new WatchBeatError("status must be one of ok, held, paused, stale, failing, unknown");
  }
  return status as WatchStatus;
}

function assertDetail(detail: unknown): string {
  if (typeof detail !== "string") {
    throw new WatchBeatError("detail must be a string");
  }
  if (unicodeCodePointLength(detail) > DETAIL_MAX_CODE_POINTS) {
    throw new WatchBeatError("detail must be at most 500 Unicode code points");
  }
  return detail;
}

function isRealCivilDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * A Date is already an instant. A string must be a real civil timestamp
 * with a zone: `Date.parse` rolls 31 February forward and treats a
 * zone-less time as local, so neither of those is accepted here.
 */
function beatAtForSql(beatAt: unknown): string {
  if (beatAt instanceof Date) {
    if (Number.isNaN(beatAt.getTime())) {
      throw new WatchBeatError("beatAt is not a valid instant");
    }
    return beatAt.toISOString();
  }
  if (typeof beatAt !== "string") {
    throw new WatchBeatError("beatAt must be an RFC3339/ISO-8601 instant or a Date");
  }
  const match = INSTANT_RE.exec(beatAt);
  if (!match) {
    throw new WatchBeatError("beatAt must be an RFC3339/ISO-8601 instant or a Date");
  }
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
    throw new WatchBeatError("beatAt is not a valid instant");
  }
  const parsed = new Date(beatAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new WatchBeatError("beatAt is not a valid instant");
  }
  return beatAt;
}

/**
 * Insert or replace the single row for `source`. `received_at` is not an
 * argument: both the insert and the conflict update stamp the database clock.
 */
export async function upsertBeat(
  source: string,
  status: string,
  detail: string,
  beatAt: string | Date,
  ...forbidden: unknown[]
): Promise<void> {
  if (forbidden.length > 0) {
    throw new WatchBeatError("received_at is set by the database clock and cannot be supplied");
  }
  const src = assertSource(source);
  const st = assertStatus(status);
  const det = assertDetail(detail);
  const beat = beatAtForSql(beatAt);
  await sql()`
    insert into watch_beats (source, status, detail, beat_at, received_at)
    values (${src}, ${st}, ${det}, ${beat}::timestamptz, clock_timestamp())
    on conflict (source) do update set
      status = excluded.status,
      detail = excluded.detail,
      beat_at = excluded.beat_at,
      received_at = clock_timestamp()
  `;
}

function utcIso(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error("watch beat timestamp from the database is invalid");
  }
  return date.toISOString();
}

function integerAge(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  throw new Error("watch beat age_s from the database is not an integer");
}

/** Rows ordered by source. Missing configuration or a failed query throws. */
export async function readBeats(): Promise<WatchBeat[]> {
  const rows = await sql()`
    select
      source,
      status,
      detail,
      beat_at,
      received_at,
      greatest(0, floor(extract(epoch from (clock_timestamp() - received_at))))::int as age_s
    from watch_beats
    order by source
  `;
  return rows.map((row) => ({
    source: String(row.source),
    status: String(row.status) as WatchStatus,
    detail: String(row.detail),
    beat_at: utcIso(row.beat_at),
    received_at: utcIso(row.received_at),
    age_s: integerAge(row.age_s),
  }));
}
