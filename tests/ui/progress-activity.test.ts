import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_WINDOW_MS, progressActivity, progressEligible } from "../../src/lib/progress-activity";
import type { RepoSnapshot } from "../../src/lib/progress-types";
import type { WatchedRepo } from "../../src/lib/watched-repos";

const NOW = Date.parse("2026-11-04T15:00:00Z");
const at = (delta: number) => new Date(NOW + delta).toISOString();
const repo: WatchedRepo = { repo: "owner/project", label: "Project", short: "p", color: "#123456", blockedLabel: null, shown: false };
const snapshot = (prs = 0, patch: Record<string, unknown> = {}): RepoSnapshot => ({
  repo: repo.repo, label: "Project", kind: "activity", collected_at: at(-1000), open_prs: prs,
  open_issues: null, blocked_issues: null, merged_prs_24h: null, issues_closed_24h: null,
  issues_opened_24h: null, total_issues_created: null, total_issues_closed: null, total_prs_merged: null,
  review_rounds: null, no_verdict_rate: null,
  detail: { activity: { status: "complete", checked_at: at(-1000), open_issues: 4,
    pushed_at: at(-60 * ACTIVITY_WINDOW_MS), pr_updated_at: null, issue_updated_at: null, ...patch } },
});
const select = (s: RepoSnapshot, cfg = repo, prior?: RepoSnapshot) => progressActivity(cfg, undefined, s, prior, NOW);

test("old and archived repos with open PRs qualify despite Brief's shown flag", () => {
  const result = select(snapshot(2), { ...repo, isArchived: true });
  assert.equal(result.shown, true);
  assert.deepEqual(result.activity.reasons, ["open_prs"]);
  assert.equal(result.open_issues, 4);
});

test("PR and issue updates count without a recent push; repo metadata is not consulted", () => {
  for (const key of ["pr_updated_at", "issue_updated_at", "pushed_at"]) {
    assert.equal(select(snapshot(0, { [key]: at(-1000) })).shown, true);
  }
  assert.equal(select(snapshot()).shown, false);
});

test("rolling 24h includes the exact cutoff and rejects older/future evidence", () => {
  assert.equal(select(snapshot(0, { pushed_at: at(-ACTIVITY_WINDOW_MS) })).shown, true);
  assert.equal(select(snapshot(0, { pushed_at: at(-ACTIVITY_WINDOW_MS - 1) })).shown, false);
  const future = select(snapshot(0, { pushed_at: at(1) }));
  assert.equal(future.shown, false);
  assert.equal(future.activity.status, "unavailable");
});

test("hidden/gone beat pin; pin beats owner exclusions; flags beat open PRs", () => {
  for (const flag of ["hidden", "gone"]) assert.equal(select(snapshot(2), { ...repo, [flag]: true, pinned: true }).shown, false);
  assert.equal(select(snapshot(), { ...repo, pinned: true, ownerExcluded: true }).shown, true);
  assert.equal(select(snapshot(2), { ...repo, ownerExcluded: true }).shown, false);
  assert.equal(progressEligible({ ...repo, hidden: true }), false);
});

test("failed scans retain known open work but do not claim fresh evidence", () => {
  const failed = snapshot(0, { status: "unavailable", open_issues: null });
  const result = select(failed, repo, snapshot(3));
  assert.equal(result.shown, true);
  assert.equal(result.open_prs, 3);
  assert.equal(result.activity.status, "unavailable");
  assert.equal(select(failed).open_prs, null);
});

test("stale and legacy evidence stays explicit", () => {
  assert.equal(select(snapshot(1, { checked_at: at(-3 * 3600000) })).activity.status, "stale");
  const legacy = progressActivity(repo, { ...snapshot(4), open_issues: 8 }, undefined, undefined, NOW);
  assert.equal(legacy.shown, true);
  assert.equal(legacy.activity.status, "legacy");
  assert.equal(progressActivity(repo, undefined, undefined, undefined, NOW).open_prs, null);
});

test("invalid counts or omitted timestamps cannot establish complete coverage", () => {
  for (const prs of [-1, NaN, 0.5]) assert.equal(select(snapshot(prs)).activity.status, "unavailable");
  assert.equal(select(snapshot(1, { issue_updated_at: undefined })).activity.status, "unavailable");
});
