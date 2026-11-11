import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../src/lib/db";
import { ingestSnapshots, progress } from "../src/lib/progress-store";
import { loadBrief } from "../src/lib/brief";
import { readAlerts } from "../src/lib/brief-alerts";

/** Actual reader/writer integration, including isolation from Brief and history. */
export async function testProgressActivity() {
  const owner = `progress-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const at = (hours: number) => new Date(now - hours * 3600000).toISOString();
  const names = ["old-pr", "recent-issue", "quiet", "hidden", "gone", "unknown", "recent-no-metrics"];
  const namespaced = (name: string) => `${owner}/${name}`;
  const observation = (prs: number, recent = false) => ({
    open_prs: prs,
    detail: { activity: { status: "complete" as const, checked_at: at(0), open_issues: 9,
      pushed_at: at(1000), pr_updated_at: null, issue_updated_at: recent ? at(1) : null } },
  });
  try {
    await sql()`insert into watched_owners (owner, activity_days, include_archived, include_forks)
      values (${owner}, 30, true, true)`;
    for (const [i, name] of names.entries()) {
      await sql()`insert into watched_repos (repo, label, short, color, position, origin, last_activity_at, hidden, gone)
        values (${namespaced(name)}, ${name}, ${owner.slice(-8) + i}, '#123456', ${9000 + i}, 'auto', ${at(name === "recent-issue" ? 1 : 1000)}, ${name === "hidden"}, ${name === "gone"})`;
    }
    const base = { open_issues: 5, open_prs: 0, merged_prs_24h: 2, issues_closed_24h: 1,
      issues_opened_24h: 3, total_issues_created: 20, total_issues_closed: 15, total_prs_merged: 10,
      detail: { merged: [{ merged_at: at(2) }] } };
    await ingestSnapshots({ collected_at: at(1), repos: names.filter((n) => n !== "recent-no-metrics").map((name) => ({ repo: namespaced(name), ...base })) });
    await ingestSnapshots({ collected_at: at(7 * 24 + 1), kind: "backfill", repos: names.map((name) => ({ repo: namespaced(name), total_issues_created: 10, total_issues_closed: 6, total_prs_merged: 2 })) });
    const success = names.filter((n) => n !== "unknown").map((name) => ({ repo: namespaced(name).toUpperCase(), ...observation(name === "old-pr" || name === "hidden" || name === "gone" ? 3 : 0, name === "recent-issue" || name === "recent-no-metrics") }));
    assert.equal(await ingestSnapshots({ collected_at: at(0), kind: "activity", repos: success }), success.length);
    const view = await progress("24h");
    const selected = view.repos.filter((r) => r.repo.startsWith(owner));
    assert.deepEqual(selected.map((r) => r.repo.split("/")[1]), ["old-pr", "recent-issue", "recent-no-metrics"]);
    assert.equal(selected[0].open_prs, 3);
    assert.equal(selected[0].open_issues, 9);
    assert.equal(selected[0].merged_prs, 2, "activity rows cannot replace metric rows");
    assert.equal(selected[2].merged_prs, null, "missing detailed collection is not a zero");
    assert.equal(selected[2].net_backlog, null);
    assert.equal(view.window_complete, false);
    assert.ok(view.coverage?.incomplete.some((r) => r.repo === namespaced("unknown")));
    assert.ok(!view.history.some((r) => [namespaced("quiet"), namespaced("hidden"), namespaced("gone")].includes(r.repo)));
    const week = await progress("7d");
    assert.deepEqual(week.repos.filter((r) => r.repo.startsWith(owner)).map((r) => r.repo), selected.map((r) => r.repo), "metric window never broadens inclusion");
    assert.equal(week.repos.find((r) => r.repo === namespaced("old-pr"))?.merged_prs, 8);

    // A later failed scan wins coverage status but leaves last-known open work visible.
    await ingestSnapshots({ collected_at: new Date(now + 10).toISOString(), kind: "activity", repos: [{
      repo: namespaced("old-pr"), detail: { activity: { status: "unavailable", checked_at: at(0), open_issues: null, pushed_at: null, pr_updated_at: null, issue_updated_at: null } },
    }] });
    const failedView = await progress("24h");
    const held = failedView.repos.find((r) => r.repo === namespaced("old-pr"))!;
    assert.equal(held.open_prs, 3);
    assert.equal(held.activity?.status, "unavailable");

    // The old-push/open-PR repo stays outside Brief's independent 30d policy;
    // the recent repo's complete metric row survives a newer activity row.
    const brief = await loadBrief("24h", new Date());
    assert.ok(!brief.repos.some((r) => r.repo === namespaced("old-pr")));
    const recent = brief.repos.find((r) => r.repo === namespaced("recent-issue"));
    assert.ok(recent);
    assert.equal(recent.open_prs, 0, "Brief reads detailed data, not the activity-only row");
    const briefAlerts = await readAlerts({ now: new Date() });
    assert.equal(briefAlerts.alerts.find((r) => r.key === `zero-merge:${namespaced("recent-issue")}`)?.condition,
      "clear", "activity-only rows must not hide the last measured merge in brief alerts");

    // The legacy unique key has no kind. Neither family may overwrite the other.
    const collisionRepo = namespaced("recent-issue");
    assert.equal(await ingestSnapshots({ collected_at: at(1), kind: "activity", repos: [{ repo: collisionRepo, ...observation(99) }] }), 0);
    const saved = await sql()`select kind, open_issues from repo_snapshots where repo = ${collisionRepo} and collected_at = ${at(1)}`;
    assert.equal(saved[0].kind, "tick");
    assert.equal(saved[0].open_issues, 5);
    assert.equal(await ingestSnapshots({ collected_at: at(0), kind: "tick", repos: [{ repo: collisionRepo.toUpperCase(), ...base }] }), 0);
    console.log("test:pg Progress activity ok (all-owner selection, failures, metric isolation, Brief, history, collisions)");
  } finally {
    await sql()`delete from repo_snapshots where lower(repo) like ${owner + "/%"}`;
    await sql()`delete from watched_repos where lower(repo) like ${owner + "/%"}`;
    await sql()`delete from watched_owners where owner = ${owner}`;
  }
}
