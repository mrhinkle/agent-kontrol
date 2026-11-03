import { parseVelocity, type VelocitySnapshot } from "../../src/lib/velocity";

export function velocityFixture(): VelocitySnapshot {
  return parseVelocity({
    schemaVersion: 1, metricVersion: "observed-development-velocity-v1.0", capturedAt: "2026-01-03T12:00:00Z", captureKind: "observed",
    window: { start: "2026-01-01T00:00:00Z", end: "2026-01-03T00:00:00Z", days: 2, timezone: "UTC" },
    scope: { owners: ["Example"], includeForks: true, includeArchived: true, cohort: "pr-created-in-window" }, inventoryComplete: true,
    source: { artifactSha256: "a".repeat(64), evidenceSha256: "b".repeat(64), collectorVersion: "fixture-v1" },
    repositories: [
      { repo: "Example/alpha", archived: false, fork: false, coverage: { prs: "complete", ci: "complete", cd: "complete" },
        prs: { opened: 4, merged: 2, openCurrent: 2, mergeHours: [1, 9], daily: [{ date: "2026-01-01", opened: 1, merged: 0 }, { date: "2026-01-02", opened: 3, merged: 2 }] },
        ci: { covered: 4, noGreen: 1, noCI: 0, revisionSamples: [1, 1, 4], firstPass: 1, reruns: 2, sameShaRepeats: 1 },
        cd: { production: { targets: 2, records: 3, attempts: [1, 2] }, preview: { targets: 1, records: 1, attempts: [] }, other: { targets: 0, records: 0, attempts: [] } } },
      { repo: "Example/beta", archived: true, fork: true, coverage: { prs: "complete", ci: "complete", cd: "unavailable" },
        prs: { opened: 3, merged: 1, openCurrent: 1, mergeHours: [2], daily: [{ date: "2026-01-01", opened: 3, merged: 1 }, { date: "2026-01-02", opened: 0, merged: 0 }] },
        ci: { covered: 1, noGreen: 0, noCI: 2, revisionSamples: [6], firstPass: 0, reruns: 0, sameShaRepeats: 0 }, cd: null },
    ],
  }, new Date("2026-01-04T00:00:00Z"));
}
