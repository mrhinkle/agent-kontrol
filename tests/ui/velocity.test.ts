import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { compatibility, parseVelocity, summarizeVelocity, windowDates } from "../../src/lib/velocity";
import { insertVelocity, velocityIdentity } from "../../src/lib/velocity-store";
import { setSqlForTests } from "../../src/lib/db";
import { velocityFixture } from "./velocity-fixture";

afterEach(() => setSqlForTests(null));
describe("velocity measurements", () => {
  it("pools observations, keeps coverage and uses the full CI-covered denominator", () => {
    const s = summarizeVelocity(velocityFixture());
    assert.equal(s.ci?.revisions.mean, 3); // (1+1+4+6)/4, not mean(2,6)=4.
    assert.equal(s.ci?.revisions.median, 2.5);
    assert.equal(s.ci?.revisions.p90, 6);
    assert.equal(s.ci?.firstPassRate, 1 / 5);
    assert.equal(s.ci?.noGreen, 1);
    assert.equal(s.ci?.noCI, 2);
    assert.equal(s.prs?.mergeHours.median, 2);
    assert.deepEqual(s.prs?.daily.map((d) => d.opened), [4, 3]);
    assert.equal(s.cd?.production.turns.mean, 1.5);
    assert.equal(s.cd?.preview.turns.mean, null);
    assert.equal(s.coverage.cd, 1);
  });
  it("preserves unavailable rather than reporting zero", () => {
    const s = velocityFixture();
    s.repositories.forEach((r) => { r.ci = null; r.coverage.ci = "unavailable"; });
    assert.equal(summarizeVelocity(parseVelocity(s)).ci, null);
  });
  it("rejects inconsistent counts, subset claims and unsafe or duplicate identities", () => {
    const mutations: ((s: ReturnType<typeof velocityFixture>) => void)[] = [
      (s) => { s.repositories[0].ci!.covered++; },
      (s) => { s.repositories[0].ci!.firstPass = 3; },
      (s) => { s.repositories[0].prs!.daily[0].merged++; },
      (s) => { s.repositories[0].prs!.mergeHours.pop(); },
      (s) => { s.repositories[0].cd!.production.attempts = [9]; },
      (s) => { s.repositories[0].ci!.revisionSamples[0] = 0.2; },
      (s) => { s.repositories[0].repo = "example/alpha?token=bad"; },
      (s) => { s.repositories[1].repo = "EXAMPLE/ALPHA"; },
      (s) => { s.repositories[0].repo = "elsewhere/alpha"; },
      (s) => { s.repositories[0].coverage.ci = "unavailable"; },
      (s) => { s.scope.includeArchived = false; },
      (s) => { s.repositories[0].prs!.openCurrent = Number.POSITIVE_INFINITY; },
    ];
    for (const mutate of mutations) { const s = velocityFixture(); mutate(s); assert.throws(() => parseVelocity(s)); }
    assert.throws(() => parseVelocity({ ...velocityFixture(), extra: true }));
  });
  it("handles DST as complete calendar days and rejects partial or future windows", () => {
    assert.equal(windowDates("2026-10-04T04:00:00Z", "2026-11-03T05:00:00Z", "America/New_York").length, 30);
    const s = velocityFixture(); s.window.start = "2026-01-01T01:00:00Z";
    assert.throws(() => parseVelocity(s));
    s.window.start = "2026-01-01T00:00:00Z"; s.capturedAt = "2026-01-02T12:00:00Z";
    assert.throws(() => parseVelocity(s));
    s.capturedAt = "2026-01-09T00:00:00Z";
    assert.throws(() => parseVelocity(s, new Date("2026-01-04T00:00:00Z")));
  });
  it("normalizes identity and separates incompatible periods, policies and coverage", () => {
    const a = velocityFixture(); let b = velocityFixture();
    b.repositories.reverse(); b.repositories[0].repo = b.repositories[0].repo.toUpperCase(); b.scope.owners = ["EXAMPLE"];
    assert.equal(velocityIdentity(a).id, velocityIdentity(parseVelocity(b)).id);
    b = parseVelocity(b);
    b.scope.includeForks = false;
    assert.notEqual(compatibility(a), compatibility(b));
    b.scope.includeForks = true; b.repositories[0].coverage.prs = "partial";
    assert.equal(compatibility(a), compatibility(b));
    assert.notEqual(velocityIdentity(a).inventoryKey, velocityIdentity(b).inventoryKey);
  });
  it("concurrent duplicate imports return one immutable receipt and cannot update payloads", async () => {
    const rows = new Map<string, { id: string; recorded_at: string }>();
    let inserts = 0;
    setSqlForTests(async (strings, ...values) => {
      const query = strings.join("?");
      assert.doesNotMatch(query, /\b(update|delete)\b/i);
      const id = values[0] as string;
      if (query.startsWith("insert")) {
        assert.match(query, /on conflict \(id\) do nothing/);
        if (rows.has(id)) return [];
        inserts++; const r = { id, recorded_at: "2026-01-04T00:00:00Z" }; rows.set(id, r); return [r];
      }
      return rows.has(id) ? [rows.get(id)!] : [];
    });
    const actor = { actor_type: "human" as const, actor_id: "operator" };
    const results = await Promise.all([insertVelocity(velocityFixture(), actor), insertVelocity(velocityFixture(), actor)]);
    assert.equal(inserts, 1); assert.equal(results[0].id, results[1].id);
    assert.equal(results.filter((r) => r.duplicate).length, 1);
    const revised = velocityFixture(); revised.capturedAt = "2026-01-04T00:00:00Z";
    await insertVelocity(revised, actor); assert.equal(inserts, 2);
  });
});
