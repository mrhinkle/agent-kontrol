import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAlerts } from "../../src/lib/progress-store";
import type { RepoProgress } from "../../src/lib/progress-types";

function repo(over: Partial<RepoProgress>): RepoProgress {
  return {
    repo: "acme/app", label: "App", short: "app", color: "#000000",
    open_issues: 10, open_prs: 0, blocked_issues: 5, blocked_label: "waiting-on-vendor", blocked_ratio: 0.5,
    merged_prs: 0, issues_closed: 0, issues_opened: 0, net_backlog: 0, review_rounds: null, no_verdict_rate: null,
    lane_mix: {}, stalled_prs: [], last_collected_at: null,
    ...over,
  } as RepoProgress;
}

describe("blocked alert", () => {
  it("names the repo's own label and links to a search for it", () => {
    const [a] = buildAlerts([repo({})], []).filter((x) => x.rule === "blockedRatio");
    assert.ok(a);
    assert.match(a.message, /50% of open issues are labeled "waiting-on-vendor"/);
    assert.doesNotMatch(a.message, /dependency-blocked/);
    assert.equal(a.url, `https://github.com/acme/app/issues?q=${encodeURIComponent('is:issue is:open label:"waiting-on-vendor"')}`);
  });

  it("raises nothing when the repo has no blocked label, even if a stale count is stored", () => {
    const alerts = buildAlerts([repo({ blocked_label: null, blocked_ratio: 0.9, blocked_issues: 9 })], []);
    assert.equal(alerts.filter((x) => x.rule === "blockedRatio").length, 0);
  });

  it("raises nothing below the threshold", () => {
    assert.equal(buildAlerts([repo({ blocked_ratio: 0.05, blocked_issues: 0 })], []).filter((x) => x.rule === "blockedRatio").length, 0);
  });
});
