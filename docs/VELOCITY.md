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

Merge counts alone cannot show any of that. The progress board already answers "is the backlog
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
  heartbeats is up. The brief calls a coordinator "working" only if a `session_*`, `milestone`,
  `status`, `turn_start` or `error` event arrived within `maxSilenceHours`. Telemetry-only is
  reported as exactly that.
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
| **coordinator working** | a work event (not heartbeat/telemetry) within `maxSilenceHours` | 3h |

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

Until the collector change lands, `scripts/morning-brief.sh` is the whole feature: it reads
GitHub directly, reads the coordinator from `/api/fleet` when `MC_URL`/`MC_TOKEN` are set, and
prints the brief. Install it on a scheduler (Hermes cron in `--no-agent` mode, launchd, cron)
delivering to chat at the hour the owner starts work.

## Delivery

One message a day, same time, same shape, to wherever the owner already reads (Slack DM,
Telegram, email). A second message only when something crosses a threshold during the day:
coordinator silent past the limit, a repo with zero merges for 72h that had merges before, or a
decision older than 14 days. No other pushes. A dashboard you have to open tells you about a
stall three days late; a chat that pings on every event trains you to ignore it.

## Non-goals

- Grading agent output quality. That is the outcome ledger's job.
- Replacing the coordinator. The brief reports; it does not dispatch.
- Deciding for the owner. The queue shows age, cost of delay and the requester's recommended
  option; the answer is typed by a person.

## Rollout order

1. `morning-brief.sh` on a scheduler, GitHub-only, today. (shipped with this doc)
2. `decisions` table + `POST/GET /api/decisions` + collector upsert from labels.
3. `/api/brief` + `get_morning_brief` reading the database; scheduler switches to the route.
4. `/decisions` page with resolve + GitHub write-back; `request_decision` MCP tool.
5. Owner-based repo discovery (`watched_owners`); Settings becomes the override layer.
6. Threshold alerts between briefs.
