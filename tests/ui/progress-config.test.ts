import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REPOS,
  repoConfig,
  LANE_BOT_PREFIX,
} from "../../src/lib/progress-config";

describe("progress-config", () => {
  it("shipped config loads with at least one repo", () => {
    assert.ok(REPOS.length >= 1);
  });

  it("every repo is unique", () => {
    const repos = REPOS.map((r) => r.repo);
    assert.equal(new Set(repos).size, repos.length);
  });

  it("every short is unique", () => {
    const shorts = REPOS.map((r) => r.short);
    assert.equal(new Set(shorts).size, shorts.length);
  });

  it("repoConfig finds the first repo", () => {
    assert.equal(repoConfig(REPOS[0].repo), REPOS[0]);
  });

  it("repoConfig returns undefined for an unknown name", () => {
    assert.equal(repoConfig("example-org/no-such-repo"), undefined);
  });

  it("LANE_BOT_PREFIX is a non-empty string", () => {
    assert.equal(typeof LANE_BOT_PREFIX, "string");
    assert.ok(LANE_BOT_PREFIX.length > 0);
  });

  it("no label or blockedLabel contains the collector's field separator", () => {
    for (const r of REPOS) {
      assert.ok(!r.label.includes("|"), `label has | for ${r.repo}`);
      assert.ok(r.blockedLabel === null || !r.blockedLabel.includes("|"), `blockedLabel has | for ${r.repo}`);
    }
  });

  it("every blockedLabel is a string or null", () => {
    for (const r of REPOS) {
      assert.ok(
        r.blockedLabel === null || typeof r.blockedLabel === "string",
        `bad blockedLabel for ${r.repo}`,
      );
    }
  });
});
