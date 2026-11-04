/** Runs only through the existing disposable-Postgres integration suite. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../src/lib/db";
import { parseVelocity, windowDates, type VelocitySnapshot } from "../src/lib/velocity";
import { insertVelocity, readVelocity, velocityIdentity } from "../src/lib/velocity-store";
import { velocityFixture } from "../tests/ui/velocity-fixture";

export async function testVelocityStore() {
  const owner = `velocity-test-${randomUUID().slice(0, 8)}`;
  const seed = velocityFixture();
  seed.scope.owners = [owner];
  seed.repositories.forEach((r) => { r.repo = `${owner}/${r.repo.split("/")[1]}`; });
  const base = parseVelocity(seed), scopes = new Set<string>();
  const actor = { actor_type: "human" as const, actor_id: "test-operator" };
  const save = async (capture: VelocitySnapshot) => {
    const normalized = parseVelocity(capture); scopes.add(velocityIdentity(normalized).scopeKey);
    return insertVelocity(normalized, actor);
  };
  const shift = (capture: VelocitySnapshot, start: string, end: string) => {
    capture.window.start = start; capture.window.end = end;
    const days = windowDates(start, end, capture.window.timezone);
    capture.repositories.forEach((r) => r.prs?.daily.forEach((d, i) => { d.date = days[i]; }));
  };
  try {
    const initial = await Promise.all(Array.from({ length: 8 }, () => save(base)));
    assert.equal(initial.filter((r) => !r.duplicate).length, 1, "one concurrent request creates the first capture");
    const first = initial.find((r) => !r.duplicate)!;
    assert.ok(initial.every((r) => r.id === first.id && r.recordedAt === first.recordedAt));
    const replay = await save(base);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.recordedAt, first.recordedAt);
    const count = await sql()`select count(*)::int as n from velocity_benchmarks where scope_key = ${first.scopeKey}`;
    assert.equal(count[0].n, 1, "concurrent duplicates create one immutable row");
    const rls = await sql()`select relrowsecurity from pg_class where oid = 'velocity_benchmarks'::regclass`;
    assert.equal(rls[0].relrowsecurity, true);
    const policies = await sql()`select policyname from pg_policies where tablename = 'velocity_benchmarks'`;
    assert.equal(policies.length, 0, "no Data API policy grants access to private captures");
    const attribution = await sql()`select column_name, is_nullable from information_schema.columns
      where table_schema = current_schema() and table_name = 'velocity_benchmarks'
        and column_name in ('actor_type', 'actor_id') order by column_name`;
    assert.deepEqual(attribution.map((r) => [r.column_name, r.is_nullable]), [
      ["actor_id", "NO"], ["actor_type", "NO"],
    ], "every private capture requires authenticated attribution in storage");

    // Server record order, not the client capture clock, selects revisions.
    const revision = structuredClone(base);
    revision.capturedAt = "2026-01-03T01:00:00Z";
    revision.repositories[0].ci!.firstPass = 2;
    const second = await save(revision);
    let view = await readVelocity(first.scopeKey);
    assert.equal(view.latest?.id, second.id);
    assert.equal(view.latest?.summary.ci?.firstPass, 2);
    assert.equal(view.baseline?.id, first.id);
    assert.equal(view.baseline?.summary.ci?.firstPass, 1);
    assert.equal(view.history.length, 1, "one latest revision per interval");

    const backfill = structuredClone(base);
    shift(backfill, "2025-12-30T00:00:00Z", "2026-01-01T00:00:00Z");
    backfill.capturedAt = "2026-01-01T12:00:00Z";
    backfill.captureKind = "reconstructed";
    const older = await save(backfill);
    view = await readVelocity(first.scopeKey);
    assert.equal(view.baseline?.id, first.id, "later backfill cannot displace original baseline");
    assert.equal(view.latest?.id, second.id, "older interval cannot displace latest period");
    assert.deepEqual(view.history.map((p) => p.id), [older.id, second.id]);

    const next = structuredClone(base);
    shift(next, "2026-01-03T00:00:00Z", "2026-01-05T00:00:00Z");
    next.capturedAt = "2026-01-05T12:00:00Z";
    next.repositories[0].coverage.ci = "partial";
    await save(next);
    view = await readVelocity(first.scopeKey);
    assert.notEqual(view.latest?.inventoryKey, view.baseline?.inventoryKey);
    assert.equal(view.history.length, 3);
    assert.equal(view.historyLimited, false);

    const other = structuredClone(base);
    other.scope.owners = [owner + "-other"];
    other.repositories.forEach((r) => { r.repo = `${owner}-other/${r.repo.split("/")[1]}`; });
    await save(other);
    view = await readVelocity(first.scopeKey);
    assert.equal(view.history.length, 3, "different owner scope never enters this trend");
    assert.equal(view.latest?.snapshot.repositories.length, 2);
    assert.equal(view.latest?.snapshot.scope.owners[0], owner);
    assert.ok(view.series.some((s) => s.key === first.scopeKey));
    console.log("test:pg velocity ok (immutable replay, revisions, baseline, backfill, scope and coverage)");
  } finally {
    for (const scope of scopes) await sql()`delete from velocity_benchmarks where scope_key = ${scope}`;
  }
}
