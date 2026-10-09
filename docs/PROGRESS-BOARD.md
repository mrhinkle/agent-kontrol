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
- **Lane attribution is counted, never guessed.** These repos squash-merge, so
  `main` credits every commit to the PR owner; the collector reads the PR's own
  branch commits instead. Where a repo shares one bot identity across lanes the
  work is labelled `unattributed`. Commits carrying an `Agent-Vendor:` trailer
  (a `prepare-commit-msg` hook that appends an `Agent-Vendor:` trailer) attribute exactly.

The watched repos live in [`progress.config.json`](../progress.config.json), read by both the
dashboard and the collector; adding a repo is one entry there (then re-run the collector
installer so the scheduled job picks it up). Alert thresholds live in
[`src/lib/progress-config.ts`](../src/lib/progress-config.ts).

## See also

- [DEPLOY.md](DEPLOY.md)
- [AGENTS.md](AGENTS.md)
- [API.md](API.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
