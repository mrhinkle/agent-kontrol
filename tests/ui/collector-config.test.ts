import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Static guards on scripts/collect-progress.sh: the collector must ask the dashboard
// for its repo list, keep the local file as the fallback, and do it before any work.
const sh = fs.readFileSync("scripts/collect-progress.sh", "utf8");

describe("collector repo discovery", () => {
  it("asks the dashboard's settings endpoint with the bearer token", () => {
    assert.ok(sh.includes("/api/settings/repos"));
    assert.ok(/Authorization: Bearer \$MC_TOKEN/.test(sh));
  });

  it("uses the dashboard's list whenever it answers, and otherwise keeps the local file", () => {
    assert.ok(!sh.includes('!= "database"'), "must not require a saved list: the dashboard default beats a local example file");
    assert.ok(sh.includes("from the local config"));
    assert.ok(sh.includes("MC_REPOS_FROM_DASHBOARD"));
  });

  it("refreshes the list before the tick or backfill starts", () => {
    const call = sh.lastIndexOf("\nrefresh_repos_from_dashboard\n");
    const run = sh.indexOf('if [[ "$MODE" == "backfill" ]]; then\n  run_backfill');
    assert.ok(call > 0 && run > call, "refresh must run before the dispatch");
  });
});
