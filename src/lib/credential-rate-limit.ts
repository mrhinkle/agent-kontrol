/**
 * Per-credential request quotas (issue #51).
 *
 * One unit is one authorized HTTP request made with an `akc_` agent
 * credential. A request is charged after the credential is verified and the
 * route or tool scope allows it, so a 401 or 403 costs nothing. An MCP POST
 * batch, an initialize, a notification, and a GET that opens a stream are
 * each one request. Tool calls inside a request are not counted separately.
 * A held stream does not tick; a reconnect is a new request.
 *
 * Each credential has a per-minute cap and a per-day cap. The minute window
 * is the clock minute; the day window is the UTC calendar day. Both are
 * fixed windows. A request is allowed only when both windows have room, and
 * an allowed request increments both. A denied request increments neither.
 *
 * With DATABASE_URL set, the counters live on the agent_credentials row.
 * The row is locked (`select ... for update`), then the database clock is
 * read, so the time that decides the window is the time after the lock.
 * The process clock is never consulted. A store error is `unavailable` and
 * the caller answers 503; there is no in-process fallback.
 *
 * With no DATABASE_URL (demo mode) the same rules run against the in-memory
 * credential list, using the credential module's clock.
 *
 * MC_TOKEN, the dashboard session, OAuth, and dev-open callers are not
 * metered. Limits are request quotas, not spend.
 */

import { errorBody } from "./api-error";
import { credentialNow, isValidRateLimit, memoryCredentialForQuota } from "./credentials";
import { isConfigured, withTransaction } from "./db";

export {
  DEFAULT_REQUESTS_PER_DAY,
  DEFAULT_REQUESTS_PER_MINUTE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MIN,
} from "./credentials";
export { isValidRateLimit };

export type QuotaWindow = "minute" | "day";

export type ChargeResult =
  | { status: "ok"; at: string }
  | { status: "limited"; window: QuotaWindow; limit: number; retryAfterSec: number; at: string }
  | { status: "reject" }
  | { status: "unavailable" };

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

type WindowState = {
  minuteUsed: number;
  dayUsed: number;
  perMinute: number;
  perDay: number;
  minuteLeftSec: number;
  dayLeftSec: number;
};

type Decision =
  | { ok: true }
  | { ok: false; window: QuotaWindow; limit: number; retryAfterSec: number };

/**
 * Both caps are checked before either counter moves. Retry-After is the
 * time until every exhausted window has reset, rounded up, at least 1.
 */
function decide(state: WindowState): Decision {
  const minuteFull = state.minuteUsed >= state.perMinute;
  const dayFull = state.dayUsed >= state.perDay;
  if (!minuteFull && !dayFull) return { ok: true };
  const waits: { window: QuotaWindow; limit: number; sec: number }[] = [];
  if (minuteFull) waits.push({ window: "minute", limit: state.perMinute, sec: state.minuteLeftSec });
  if (dayFull) waits.push({ window: "day", limit: state.perDay, sec: state.dayLeftSec });
  const longest = waits.reduce((a, b) => (b.sec > a.sec ? b : a));
  return {
    ok: false,
    window: longest.window,
    limit: longest.limit,
    retryAfterSec: Math.max(1, Math.ceil(longest.sec)),
  };
}

const pending = new WeakMap<object, Map<string, Promise<ChargeResult>>>();

/**
 * Charge one request to a credential. The same Request object and the same
 * credential share one promise, so auth that runs twice for one request
 * charges once. The promise is stored before anything is awaited.
 */
export function chargeCredentialRequest(req: Request, credentialId: string): Promise<ChargeResult> {
  let byCredential = pending.get(req);
  if (!byCredential) {
    byCredential = new Map();
    pending.set(req, byCredential);
  }
  const existing = byCredential.get(credentialId);
  if (existing) return existing;
  const charged = charge(credentialId);
  byCredential.set(credentialId, charged);
  return charged;
}

async function charge(id: string): Promise<ChargeResult> {
  if (!isConfigured()) return chargeMemory(id);
  try {
    return await chargeDatabase(id);
  } catch (e) {
    console.error("[credential-rate-limit] charge failed", e instanceof Error ? e.name : "error");
    return { status: "unavailable" };
  }
}

function chargeMemory(id: string): ChargeResult {
  const row = memoryCredentialForQuota(id);
  if (!row) return { status: "reject" };
  const now = credentialNow();
  if (row.revoked_at) return { status: "reject" };
  if (row.expires_at) {
    const exp = Date.parse(row.expires_at);
    if (!Number.isFinite(exp) || exp <= now) return { status: "reject" };
  }
  if (!isValidRateLimit(row.rate_limit_per_minute) || !isValidRateLimit(row.rate_limit_per_day)) {
    return { status: "unavailable" };
  }
  const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const minuteUsed = row.quota.minute_start === minuteStart ? row.quota.minute_count : 0;
  const dayUsed = row.quota.day_start === dayStart ? row.quota.day_count : 0;
  const at = new Date(now).toISOString();
  const decision = decide({
    minuteUsed,
    dayUsed,
    perMinute: row.rate_limit_per_minute,
    perDay: row.rate_limit_per_day,
    minuteLeftSec: (minuteStart + MINUTE_MS - now) / 1000,
    dayLeftSec: (dayStart + DAY_MS - now) / 1000,
  });
  if (!decision.ok) return { status: "limited", ...decision, at };
  row.quota = {
    minute_start: minuteStart,
    minute_count: minuteUsed + 1,
    day_start: dayStart,
    day_count: dayUsed + 1,
  };
  return { status: "ok", at };
}

function count(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error("quota counter is not a whole number");
  return n;
}

async function chargeDatabase(id: string): Promise<ChargeResult> {
  return withTransaction(async (tx) => {
    const locked = await tx`
      select id from agent_credentials where id = ${id} for update
    `;
    if (!locked[0]) return { status: "reject" } as const;

    // Read the clock after the lock. A request that waited on the lock is
    // judged by the time it got the row, not the time it arrived.
    const rows = await tx`
      with t as (select clock_timestamp() as now),
      b as (
        select
          now,
          date_trunc('minute', now at time zone 'UTC') at time zone 'UTC' as minute_start,
          date_trunc('day', now at time zone 'UTC') at time zone 'UTC' as day_start
        from t
      )
      select
        b.now,
        b.minute_start,
        b.day_start,
        c.revoked_at is not null as revoked,
        (c.expires_at is not null and c.expires_at <= b.now) as expired,
        c.rate_limit_per_minute,
        c.rate_limit_per_day,
        case when c.rate_minute_start = b.minute_start then c.rate_minute_count else 0 end as minute_used,
        case when c.rate_day_start = b.day_start then c.rate_day_count else 0 end as day_used,
        extract(epoch from (b.minute_start + interval '1 minute' - b.now))::float8 as minute_left,
        extract(epoch from (b.day_start + interval '1 day' - b.now))::float8 as day_left
      from agent_credentials c, b
      where c.id = ${id}
    `;
    const row = rows[0];
    if (!row) return { status: "reject" } as const;
    if (row.revoked === true || row.expired === true) return { status: "reject" } as const;

    const perMinute = Number(row.rate_limit_per_minute);
    const perDay = Number(row.rate_limit_per_day);
    if (!isValidRateLimit(perMinute) || !isValidRateLimit(perDay)) {
      throw new Error("stored rate limit is out of range");
    }
    const minuteUsed = count(row.minute_used);
    const dayUsed = count(row.day_used);
    const at = new Date(row.now as string | Date).toISOString();
    const decision = decide({
      minuteUsed,
      dayUsed,
      perMinute,
      perDay,
      minuteLeftSec: Number(row.minute_left),
      dayLeftSec: Number(row.day_left),
    });
    if (!decision.ok) return { status: "limited", ...decision, at } as const;

    await tx`
      update agent_credentials
      set rate_minute_start = ${row.minute_start}::timestamptz,
          rate_minute_count = ${minuteUsed + 1}::integer,
          rate_day_start = ${row.day_start}::timestamptz,
          rate_day_count = ${dayUsed + 1}::integer
      where id = ${id}
    `;
    return { status: "ok", at } as const;
  });
}

/** The structured 429 body. `retryable` is true; `retry_after` is seconds. */
export function rateLimitedBody(result: Extract<ChargeResult, { status: "limited" }>) {
  const unit = result.window === "minute" ? "minute" : "day (UTC)";
  return errorBody("rate_limited", {
    message: `This agent credential has used its ${result.limit} requests per ${unit}.`,
    fix: `Wait ${result.retryAfterSec} seconds (the Retry-After header), then retry. The operator can change this credential's limits in Settings.`,
    extra: { retry_after: result.retryAfterSec, window: result.window, limit: result.limit },
  });
}

export function rateLimitedResponse(
  result: Extract<ChargeResult, { status: "limited" }>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(rateLimitedBody(result)), {
    status: 429,
    headers: {
      "content-type": "application/json",
      ...headers,
      "Retry-After": String(result.retryAfterSec),
    },
  });
}
