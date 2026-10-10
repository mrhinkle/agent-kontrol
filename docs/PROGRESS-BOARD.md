# Progress board

Page: `/progress`. API: `GET /api/progress`, `GET /api/progress/digest`. MCP tool: `get_progress_digest`.

Answers one question the fleet view can't: **is the backlog actually shrinking?**

The headline metric is `net_backlog` — issues opened minus issues closed in the
window. Positive means the queue grew. It leads because merge counts alone lie
by omission: the sweep that motivated this page found a 28-PR day on which all
three repos still ended deeper in the hole.

```
scripts/collect-progress.sh              # one tick (cron, every 15 min)
scripts/collect-progress.sh --backfill 90  # seed history, one time
scripts/collect-progress.sh --dry-run    # print the payload, post nothing
agents/progress-collector/install.sh     # install the tick as a launchd job
```

Install the collector on a machine that stays awake. Queue depth on a past date
is not recoverable from the GitHub API, so a tick that never ran is a permanent
hole in the graph.

Notes that matter when reading the numbers:

- **The page never calls GitHub.** The collector owns the whole API budget and
  writes to `repo_snapshots`; the page reads Postgres. Search allows 30 req/min,
  which a live-querying page would burn through in one open tab.
- **24h is measured directly** by each tick. Longer windows difference two
  cumulative counters, which is exact — summing overlapping rolling counts
  would not be. When history doesn't reach back far enough, the page says so
  instead of quietly reporting a short window as a full one.
- **Blocked work is per-repo.** Each repo spells the label differently and
  a repo with none reads `not tracked` rather than `0%`.

## What "blocked" means

Agent Kontrol does not detect that work is stuck. **Blocked is a GitHub label you choose per repo in Settings.** The board counts the open issues that carry it and divides by all open issues in that repo, so 26% means about a quarter of the open issues have the label. The alert fires when that share passes the threshold, and its link opens the matching issue search.

- Pull requests are not counted, only issues.
- An issue stays counted until the label is removed, so a stale label overstates blocking and unlabeled stuck work is invisible. Keeping the label current is part of the practice.
- Use one label for one meaning (for example "waiting on a dependency or a decision"), and leave the field empty for repos that do not use one.
- **Lane attribution is counted, never guessed.** These repos squash-merge, so
  `main` credits every commit to the PR owner; the collector reads the PR's own
  branch commits instead. Where a repo shares one bot identity across lanes the
  work is labelled `unattributed`. Commits carrying an `Agent-Vendor:` trailer
  (a `prepare-commit-msg` hook that appends an `Agent-Vendor:` trailer) attribute exactly.

The watched repos live in [`progress.config.json`](../progress.config.json), read by both the
dashboard and the collector; adding a repo is one entry there (then re-run the collector
installer so the scheduled job picks it up). Alert thresholds live in
[`src/lib/progress-config.ts`](../src/lib/progress-config.ts).

## Choosing which repos to watch

Use **Settings** in the app header. Add a repo as `owner/name`, give it a label, a short name and a color, say which GitHub label marks blocked work (or leave it empty if the repo has none), and save. Reorder with the arrows. The progress board updates immediately, and the collector reads the same list on its next tick (within 15 minutes), so nothing needs redeploying or editing on the collector's machine.

- **Default list.** Until you save one, the board uses `progress.config.json` (or `NEXT_PUBLIC_MC_PROGRESS_CONFIG`). The first save stores your list in the database, and from then on the database wins.
- **Removing a repo** stops it being shown and collected. Its history stays in the database, and adding it back restores it. You cannot remove the last repo.
- **New repos need history.** The collector only records the present. Run `collect-progress.sh --backfill 90` once to fill in the past.
- **Access.** The collector's `gh` login must be able to read each repo, including private ones.
- **The collector trusts the dashboard.** Whenever it can reach the dashboard it uses the dashboard's list, whether that is one you saved or the default, so a reinstalled collector never sweeps stale example repos. **If the dashboard is unreachable,** it keeps using its local config file. Set `MC_REPOS_FROM_DASHBOARD=0` to make it ignore the dashboard list entirely.

## See also

- [DEPLOY.md](DEPLOY.md)
- [AGENTS.md](AGENTS.md)
- [API.md](API.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
