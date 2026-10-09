import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { demoProgress, seedFor } from "../../src/lib/demo-progress";
import { REPOS, WINDOWS } from "../../src/lib/progress-config";

describe("demo progress", () => {
  it("gives a repo with no hand-written seed a generic one instead of crashing", () => {
    const s = seedFor("example-org/not-seeded");
    assert.equal(s.repo, "example-org/not-seeded");
    assert.ok(s.open_issues > 0);
  });

  it("renders every configured repo in every window", () => {
    for (const w of WINDOWS) {
      const r = demoProgress(w);
      assert.deepEqual(
        r.repos.map((x) => x.repo),
        REPOS.map((x) => x.repo),
      );
    }
  });
});
