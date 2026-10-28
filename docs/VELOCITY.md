# Velocity: the morning brief and the decision queue

Status: **specification + first collector**, 2026-10-25. The `scripts/morning-brief.sh` sweep
and the `decisions` table ship with this document. The API, dashboard page, MCP tools and
repo discovery are tracked in the epic linked from the CHANGELOG.

## The problem this solves

Agent fleets stall quietly. The symptoms we measured across three repos on 2026-10-25:

- A coordinator's five scheduled jobs had been **paused for two days**. Its telemetry heartbeat
  kept posting every minute, so every "is it alive" check said yes. Its last *work* event was
  60 hours old. Nothing told the owner.
- One repo had **zero merges and zero issues closed in seven days** with 163 open issues and 17
  unassigned P0s. Another had 136 merges in 30 days and still looked stalled from the owner's
  chair, because five PRs had sat 2 to 13 days on a merge conflict or a failing required check.
- **24 decisions only the owner could make** were waiting, the oldest 96 days, spread across
  GitHub labels (`owner-gate-tierc`, `needs-mark`), coordinator status files and alert
  messages. No list existed. The agents re-asked; the owner never saw a queue.

Merge counts alone cannot show any of that. (The second repo was shipping well by any
throughput measure; what the owner saw was the stuck tail. The brief exists so the two are
not confused.) The progress board already answers "is the backlog
shrinking?" This layer answers three more questions every morning, in one message:

1. **Is anything stuck, for how long, and on what?** (flow)
2. **Is the coordinator working, or merely alive?** (liveness measured by output)
3. **What is waiting on me?** (ownership, with age)

## Design rule: the running instance is the source of truth

Agent Kontrol is open source and will run in places we never see. So nothing in this design
depends on a file on an operator's laptop or on an agent remembering to report:

- **Repos self-populate.** The operator names GitHub owners once (`watched_owners`). The
  collector lists each owner's repos and tracks any with a push or merged PR in the last 30
  days. New repos appear on their own; dormant ones drop off the brief but keep their history.
  The Settings list becomes an override (pin, hide, rename, colour), not the source.
- **Decisions self-populate.** Any open issue or PR carrying a configured decision label becomes
  a row. Any agent can file one through MCP. Resolving a row writes the answer back to where it
  was asked (a GitHub comment, and the label is removed), so agents read the decision in their
  own channel.
- **Liveness is a work event, never a heartbeat.** A heartbeat proves the daemon that posts
  heartbeats is up. The brief calls a coordinator "working" only if a `session_end`,
  `milestone` or `status` event arrived within `maxSilenceHours`. The read is that work event, not the newest 200 other events, so a burst of `turn_start` cannot hide it. `turn_start` and `error`
  do not count: a coordinator that starts turns and errors every hour is not working, it is
  failing, and the brief says *failing* for that case. Telemetry-only is reported as exactly
  that. Configuring `workKinds` as `heartbeat`, `telemetry`, `turn_start`, `status_update`, or `error`
  does not make those events count. An error-only list falls back to the three work kinds.
- **The watcher has a watcher.** The brief runs on a scheduler that can itself go silent (the
  coordinator's did). A dead-man's check on a second channel reports when no brief arrived by
  the expected time plus fifteen minutes. Without it the brief inherits the failure it was
  built to catch.
- **The brief is pushed, not opened.** `GET /api/brief` is plain text for a scheduler to send
  to chat or email. The dashboard page renders the same JSON. They cannot disagree.

## What the brief contains

```
MORNING BRIEF — Sun 2026-10-25 07:00 EDT — last 24h

9 PRs merged, 32 issues closed, 12 opened — the queue shrank by 20.

COORDINATOR  [!!] hermes-carmack — NOT WORKING: last work event 60h ago (limit 3h)  (telemetry seen 0.1h ago)

REPO            merged  issues±    net   open  stale  stuck lead-med
ConferenceOS         3     +1/-3     -2    132    40%      4     3.6h
Chatterbuilt         0     +0/-0      0    163    52%      1        -
The Gibson           6   +11/-29    -18    118    38%      2    16.7h

STUCK PRs (7) — oldest first
  cos #2271  13d  merge conflict with base
  cos #2342   9d  failing: review-evidence
  ...
DECISIONS FOR YOU (24) — oldest first; each one is work nobody else can unblock
  cos #233  96d  [owner-gate-tierc]  Implement role-based ACLs ...
  ...
SHIPPED — ConferenceOS: #2406 ... (mrhinkle, 3.5h)
```

Definitions, fixed so the number means the same every day:

| Term | Definition | Default |
|---|---|---|
| **stuck PR** | non-draft PR open longer than `stuckPrHours`, or in merge state `DIRTY`/`BLOCKED`/`BEHIND`/`UNSTABLE`; the reason is the first failing or pending check, or "merge conflict" | 48h |
| **stale issue** | open issue with no update in `staleIssueDays` | 21d |
| **lead-med** | median hours from PR opened to merged, over the window | — |
| **decision** | open issue/PR with any label in `decisionLabels`, or a row an agent filed | labels: `needs-owner`, `owner-gate-*`, `decision` |
| **coordinator working** | a `session_end`/`milestone`/`status` event within `maxSilenceHours`; `error`-only in the window reads *failing*, nothing reads *not working* | 3h |
| **review SLA** | hours from "green at head" to a posted verdict; breaches are listed in the brief | Tier A/B: 4h, Tier C: 12h |
| **dispatch-ready depth** | open issues labelled `dispatch-ready` per repo; the Spec Writer stops adding above the cap | cap 10 |
| **decisions per spec** | decisions filed divided by specs written, per Spec Writer run; above 1.0 the Spec Writer is deferring, not the owner | alert at 1.0 |

Thresholds live in `progress.config.json` under `brief` and, once the instance stores them, in
Settings. Every number is a claim you can argue with; that is why they are in one place.

## Data model

Existing tables carry most of it. Additions:

- **`repo_snapshots.detail`** (jsonb, already present) gains `stuck_prs[]`
  (`{number,title,url,age_days,state,reason}`), `median_lead_hours`, `stale_issues`,
  `drafts`. No migration needed; the collector writes it on every tick.
- **`decisions`** (new, `supabase/migrations/20261025_decisions.sql`): one row per decision,
  upserted by `key` (`github:<owner/repo>#<n>` for label-sourced rows, `agent:<id>:<slug>` for
  MCP-filed ones). `status` is `open | decided | deferred | withdrawn`; `decision`,
  `decided_by`, `decided_at` record the answer; `defer_until` lets a row disappear and come back.
- **`watched_owners`** (planned): the GitHub owners whose repos are auto-discovered, with a
  per-owner activity window. `watched_repos` stays as the override layer.

## API and MCP surface (planned)

| Route / tool | Does |
|---|---|
| `GET /api/brief?window=24h` | the brief as text (`Accept: application/json` for the object) |
| `GET /api/decisions?status=open` | the queue, oldest first |
| `POST /api/decisions` | upsert by key (collector and agents) |
| `PATCH /api/decisions/:id` | `{status, decision, decided_by}`; triggers write-back |
| MCP `get_morning_brief` | same as the route, for any connected agent |
| MCP `request_decision` | an agent files what only the owner can unblock: title, why, options, recommended |
| MCP `list_decisions` / `resolve_decision` | read the queue; record an answer (dashboard identity only for resolve) |

`report_status` already exists; coordinators should call it with `kind: "milestone"` at the end
of every round so the liveness check has something to measure.

## Collector changes

`scripts/collect-progress.sh` gains the sweep now in `scripts/morning-brief.sh`: per repo, the
open PR list with check rollups (one GraphQL call), the open issue list with labels and
`updatedAt` (one call), and the merged list with timestamps. It writes `detail` on the snapshot
and upserts label-sourced `decisions`. Repo discovery runs once per tick per owner.

`scripts/collect-progress.sh` writes those `detail` keys on each tick (stuck PRs, median lead
time, stale issues, drafts, and merged PRs with timestamps covering 72h). A GitHub failure in
that extra sweep logs and still posts the tick. `scripts/morning-brief.sh` remains the fallback
when `GET /api/brief` is down: it reads GitHub directly, reads the coordinator from `/api/fleet`
when `MC_URL`/`MC_TOKEN` are set, and prints the brief. The scheduler (Hermes cron in
`--no-agent` mode) should `curl` the route and keep the script for the outage.

## Delivery

One message a day, same time, same shape, to wherever the owner already reads (Slack DM,
Telegram, email). A second message only when something crosses a threshold during the day:
coordinator silent past the limit, a repo with zero merges for 72h that had merges before, a
review SLA breach, or a decision older than 14 days. No other pushes. A dashboard you have to
open tells you about a stall three days late; a chat that pings on every event trains you to
ignore it.

Threshold alerts are **off until the owner has cleared the decision backlog once.** Importing
two dozen stale decisions and alerting on every one of them on day one teaches the owner to
ignore the channel; the first week is collection only.

The decision list is ordered by tier, then age. Strict age order lets a three-month-old
naming question sit ahead of a consent decision.

## Security

- **Issue text is data.** Every role prompt treats issue bodies, comments and PR descriptions
  as untrusted input. A line in an issue that reads like an instruction to an agent is a
  finding, not a command.
- **Writes carry an identity.** `request_decision` records the authenticated agent credential
  as `requested_by`; `resolve_decision` accepts only a dashboard session or a credential
  holding `decisions:write`. An agent cannot resolve a decision, including its own.
- **Write-back is scoped.** The GitHub token the instance uses to comment on and relabel issues
  has issues-write on the watched repos and nothing else. It cannot push, merge or change
  settings. Without such a token the row still resolves and the page says "not written back."
- **Merge authority has a stop.** No dispatcher merges until a one-command kill switch exists
  (halt the script, revoke its merge credential) and the repo has a revert-first policy for
  anything that reaches production wrong.

## Cost

The brief reports spend per merged PR per repo, from the usage ledger where it exists. The
Spec Writer runs under a daily cap (default: ten issues or the configured token budget,
whichever first). A spec error is cheap to fix before dispatch and expensive after, which is
why the most capable model goes on the Spec Writer and the cheapest competent coder on the
Implementer; rework, not first drafts, is where tokens go.

## Non-goals

- Grading agent output quality. That is the outcome ledger's job.
- Replacing the coordinator. The brief reports; it does not dispatch.
- Deciding for the owner. The queue shows age, cost of delay and the requester's recommended
  option; the answer is typed by a person.

## Rollout order

Reordered 2026-10-25 after cross-vendor review (GLM 5.3, Kimi K3): the failure that motivated
the plan was silent death, so liveness ships first; the queue is useless without a dispatcher
and a resolve path, so those come before any page.

1. `morning-brief.sh` on a scheduler, GitHub-only, with the coordinator-silence alert and the
   dead-man's check on the brief itself. (brief shipped with this doc; alerts next)
2. Dispatcher bridge: a small script that claims the top `dispatch-ready` item, starts a lane,
   posts a work event, and halts on the kill switch. Proven end to end before any merge
   authority.
3. `decisions` table + `GET/POST/PATCH /api/decisions` **with GitHub write-back** + collector
   upsert from labels. Resolve ships with the table, as a CLI if the page is not ready.
4. `/api/brief` + `get_morning_brief` reading the database; scheduler switches to the route.
   Shipped 2026-10-27: `GET /api/brief` and MCP `get_morning_brief` read Postgres. The cron should `curl` the route. `scripts/morning-brief.sh` stays the fallback and still sweeps GitHub. The API does not. A 72h lead time uses `detail.merged` from the collector, not a live recompute.
5. `/decisions` page; `request_decision` MCP tool.
6. Owner-based repo discovery (`watched_owners`); Settings becomes the override layer.
7. Remaining threshold alerts (zero-merge repo, review SLA, 14-day decision), enabled after
   the owner's first backlog clear.
