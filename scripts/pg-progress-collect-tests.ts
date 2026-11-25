/**
 * Hosted progress collector single-runner lock, against a real Postgres.
 * Called from run-pg-tests.ts.
 *
 * Two overlapping runs: the second must return busy at once, run nothing, and
 * write nothing. After the first ends, the lock is free again.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../src/lib/db";
import { runProgressCollection, type CollectDeps } from "../src/lib/progress-collect/run";
import { withCollectorLock } from "../src/lib/progress-collect/store";
import { ingestSnapshots } from "../src/lib/progress-store";

export async function testProgressCollectLock() {
  const repo = `collect-${randomUUID().slice(0, 8)}/app`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });

  const first = withCollectorLock(async () => {
    entered();
    await held;
    return "first";
  });
  await inside;

  // The second run would write a snapshot if it ran at all.
  let secondRan = false;
  const deps: CollectDeps = {
    token: "pg-test-token",
    fetchImpl: async () => { throw new Error("the busy run must not call GitHub"); },
    now: Date.now,
    settings: { laneBotPrefix: "agent-lanes-", sharedBotPrefixes: [], decisionLabels: [], stuckPrHours: 48, staleIssueDays: 21, lanePrCap: 80 },
    ingest: ingestSnapshots,
    readOwners: async () => { secondRan = true; throw new Error("unreachable"); },
    readRepos: async () => { secondRan = true; throw new Error("unreachable"); },
    applyDiscovery: async () => true,
    latestActivityAt: async () => { secondRan = true; return null; },
    tickAges: async () => new Map(),
    decisions: { async upsert() { return true; }, async reconcile() { return true; } },
  };
  const second = await withCollectorLock(() => runProgressCollection(deps));
  assert.deepEqual(second, { busy: true }, "an overlapping run is skipped as busy");
  assert.equal(secondRan, false, "the busy run did no work");
  const rows = await sql()`select count(*)::int as n from repo_snapshots where repo = ${repo}`;
  assert.equal(rows[0].n, 0, "the busy run wrote nothing");

  release();
  assert.deepEqual(await first, { busy: false, value: "first" });

  // Released at commit: the next run gets the lock.
  const third = await withCollectorLock(async () => {
    await ingestSnapshots({ kind: "tick", collected_at: new Date().toISOString(), repos: [{ repo, open_issues: 1 }] });
    return "third";
  });
  assert.deepEqual(third, { busy: false, value: "third" });
  const after = await sql()`select count(*)::int as n from repo_snapshots where repo = ${repo}`;
  assert.equal(after[0].n, 1, "a lock holder's writes commit independently");
  await sql()`delete from repo_snapshots where repo = ${repo}`;
  console.log("ok - progress collector single-runner lock");
}
