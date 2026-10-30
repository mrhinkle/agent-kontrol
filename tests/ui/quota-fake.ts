import type { Row } from "../../src/lib/db";

/**
 * Answers for the request-quota statements in src/lib/credential-rate-limit.ts,
 * for suites whose fake SQL tag stands in for agent_credentials. The fake
 * always has room, so those suites keep testing what they tested before.
 * Quota behaviour itself is tested in credential-rate-limit.test.ts and
 * against Postgres in scripts/run-pg-tests.ts. Returns null for any other
 * statement.
 */
export function fakeQuotaSql(text: string, values: unknown[]): Row[] | null {
  const lower = text.toLowerCase();
  if (!lower.includes("agent_credentials")) return null;
  if (lower.includes("for update")) return [{ id: values[0] }];
  if (lower.includes("clock_timestamp()")) {
    const now = new Date();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const day = new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
    return [{
      now: now.toISOString(),
      minute_start: minute.toISOString(),
      day_start: day.toISOString(),
      revoked: false,
      expired: false,
      rate_limit_per_minute: 60,
      rate_limit_per_day: 10_000,
      minute_used: 0,
      day_used: 0,
      minute_left: 30,
      day_left: 3_600,
    }];
  }
  if (lower.includes("set rate_minute_start")) return [];
  return null;
}
