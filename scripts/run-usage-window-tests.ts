/**
 * Unit tests: rolling Usage and Costs windows + Postgres 42P01 detection.
 */
import {
  DEFAULT_USAGE_WINDOW,
  isUsageWindow,
  resolveUsageWindow,
  usageWindowRange,
  USAGE_WINDOWS,
} from "../src/lib/usage-window";
import { isUndefinedTableError, USAGE_SETUP_MESSAGE } from "../src/lib/usage-errors";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(DEFAULT_USAGE_WINDOW === "7d", "default window");
  assert(USAGE_WINDOWS.join(",") === "24h,7d,30d", "windows list");
  assert(isUsageWindow("7d") && !isUsageWindow("90d") && !isUsageWindow(null), "isUsageWindow");

  const now = new Date("2026-10-05T21:00:00.000Z");
  const d7 = usageWindowRange("7d", now);
  assert(d7.until === "2026-10-05T21:00:00.000Z", `until got ${d7.until}`);
  assert(d7.since === "2026-09-28T21:00:00.000Z", `since 7d got ${d7.since}`);
  assert(d7.window === "7d", "label");

  const d24 = usageWindowRange("24h", now);
  assert(d24.since === "2026-10-04T21:00:00.000Z", `since 24h got ${d24.since}`);

  const d30 = usageWindowRange("30d", now);
  assert(d30.since === "2026-09-05T21:00:00.000Z", `since 30d got ${d30.since}`);

  // Defaults to rolling 7d when no params
  const def = resolveUsageWindow({ now });
  assert(def.window === "7d", "resolve default window");
  assert(def.since === d7.since && def.until === d7.until, "resolve default range");

  // ?window=24h
  const w24 = resolveUsageWindow({ window: "24h", now });
  assert(w24.window === "24h" && w24.since === d24.since, "resolve window param");

  // Explicit since/until wins when window absent
  const custom = resolveUsageWindow({
    since: "2026-01-01T00:00:00.000Z",
    until: "2026-01-08T00:00:00.000Z",
    now,
  });
  assert(custom.window === null, "custom has null window label");
  assert(custom.since.startsWith("2026-01-01"), "custom since");

  // window param beats since/until
  const prefer = resolveUsageWindow({
    window: "30d",
    since: "2020-01-01T00:00:00.000Z",
    until: "2020-01-02T00:00:00.000Z",
    now,
  });
  assert(prefer.window === "30d" && prefer.since === d30.since, "window preferred");

  console.log("usage_window_ok", d7.since, "→", d7.until);

  // 42P01 detection
  assert(isUndefinedTableError({ code: "42P01", message: "relation \"usage_facts\" does not exist" }), "code");
  assert(
    isUndefinedTableError(Object.assign(new Error('relation "usage_facts" does not exist'), { code: "42P01" })),
    "Neon-shaped",
  );
  assert(isUndefinedTableError({ message: 'relation "account_snapshots" does not exist' }), "message-only");
  assert(isUndefinedTableError({ message: "boom 42P01" }), "message contains code");
  assert(isUndefinedTableError({ cause: { code: "42P01" } }), "nested cause");
  assert(!isUndefinedTableError(new Error("connection refused")), "other errors");
  assert(!isUndefinedTableError(null), "null");
  assert(USAGE_SETUP_MESSAGE.includes("supabase/schema.sql"), "setup message");
  assert(USAGE_SETUP_MESSAGE.includes("collector"), "setup mentions collector");

  console.log("usage_42P01_ok", USAGE_SETUP_MESSAGE.slice(0, 40) + "…");
}

main();
