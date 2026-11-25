import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backlogSeries, formatSpan, matchesFilter, repoState, sortRepos } from "../../src/lib/progress-sort";
import type { RepoProgress } from "../../src/lib/progress-types";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function repo(over: Partial<RepoProgress> & { lastActivityAgo?: number | null; checkedAgo?: number }): RepoProgress {
  const { lastActivityAgo = 0, checkedAgo = 0, ...rest } = over;
  return {
    repo: `acme/${over.label ?? "app"}`, label: "app", short: "app", color: "#000000",
    open_issues: 3, open_prs: 1, blocked_issues: null, blocked_label: null, blocked_ratio: null,
    merged_prs: 0, issues_closed: 0, issues_opened: 0, net_backlog: 0, review_rounds: null, no_verdict_rate: null,
    lane_mix: {}, stalled_prs: [], last_collected_at: ago(checkedAgo),
    activity: {
      status: "fresh",
      checked_at: ago(checkedAgo),
      last_activity_at: lastActivityAgo === null ? null : ago(lastActivityAgo),
      reasons: ["open_prs"],
    },
    ...rest,
  } as RepoProgress;
}

describe("repoState freshness", () => {
  it("calls open work untouched for 3+ days stale", () => {
    assert.equal(repoState(repo({ lastActivityAgo: 4 * DAY }), NOW).freshness, "stale");
  });
  it("calls 1-3 days idle with open work cooling", () => {
    assert.equal(repoState(repo({ lastActivityAgo: 2 * DAY }), NOW).freshness, "cooling");
  });
  it("calls recent activity moving", () => {
    assert.equal(repoState(repo({ lastActivityAgo: 3_600_000 }), NOW).freshness, "moving");
  });
  it("does not let merges counted over a long window hide stale activity", () => {
    // 90d view: two merges three weeks ago, nothing since.
    assert.equal(repoState(repo({ lastActivityAgo: 21 * DAY, merged_prs: 2, issues_closed: 4 }), NOW).freshness, "stale");
  });
  it("calls an idle repo with nothing open quiet, not stale", () => {
    assert.equal(repoState(repo({ lastActivityAgo: 9 * DAY, open_issues: 0, open_prs: 0 }), NOW).freshness, "idle");
  });
  it("measures idle time at the last check, not the wall clock", () => {
    // Collector stopped 4 days ago; the repo was active 1 hour before that check.
    const s = repoState(repo({ lastActivityAgo: 4 * DAY + 3_600_000, checkedAgo: 4 * DAY }), NOW);
    assert.equal(s.idleMs, 3_600_000);
    assert.equal(s.freshness, "moving");
  });
  it("reports unknown without an activity timestamp", () => {
    assert.equal(repoState(repo({ lastActivityAgo: null }), NOW).freshness, "unknown");
  });
  it("picks the longest-idle stalled PR", () => {
    const s = repoState(repo({
      stalled_prs: [
        { number: 1, title: "a", url: "u1", idle_hours: 10, green: true, draft: false },
        { number: 2, title: "b", url: "u2", idle_hours: 90, green: false, draft: false },
      ],
    }), NOW);
    assert.equal(s.oldestStalled?.number, 2);
  });
});

describe("sortRepos", () => {
  const repos = [
    repo({ label: "fresh", lastActivityAgo: 3_600_000, merged_prs: 4 }),
    repo({ label: "stale", lastActivityAgo: 6 * DAY }),
    repo({ label: "cooling", lastActivityAgo: 2 * DAY }),
    repo({ label: "done", lastActivityAgo: 20 * DAY, open_issues: 0, open_prs: 0 }),
  ];
  const order = (key: Parameters<typeof sortRepos>[1]) => sortRepos(repos, key, NOW).map((x) => x.repo.label);

  it("stalest first puts the longest-idle open work on top and finished repos last", () => {
    assert.deepEqual(order("stalest"), ["stale", "cooling", "fresh", "done"]);
  });
  it("needs attention leads with stale work", () => {
    assert.deepEqual(order("attention").slice(0, 2), ["stale", "cooling"]);
  });
  it("most shipped leads with merges", () => {
    assert.equal(order("shipped")[0], "fresh");
  });
  it("filters stale to stale and cooling", () => {
    const stale = sortRepos(repos, "name", NOW).filter((x) => matchesFilter(x.state, "stale")).map((x) => x.repo.label);
    assert.deepEqual(stale, ["cooling", "stale"]);
  });
});

describe("helpers", () => {
  it("formats spans", () => {
    assert.equal(formatSpan(3 * DAY + 5), "3d");
    assert.equal(formatSpan(5 * 3_600_000), "5h");
    assert.equal(formatSpan(1000), "1m");
  });
  it("builds a per-repo series oldest first", () => {
    const h = [
      { date: "2026-11-03", repo: "a", total_issues_created: 0, total_issues_closed: 0, backlog: 3 },
      { date: "2026-11-01", repo: "a", total_issues_created: 0, total_issues_closed: 0, backlog: 1 },
      { date: "2026-11-02", repo: "b", total_issues_created: 0, total_issues_closed: 0, backlog: 9 },
    ];
    assert.deepEqual(backlogSeries(h, "a"), [1, 3]);
  });
});
