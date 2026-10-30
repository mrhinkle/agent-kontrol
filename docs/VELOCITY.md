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
- **`watched_owners`** (shipped, `supabase/migrations/20261028_watched_owners.sql`): the GitHub
  owners whose repos are auto-discovered, with a per-owner activity window. `watched_repos`
  stays as the override layer: pin and hide for discovered repos; label, short, color and blocked label for hand-added repos. Hide wins over pin. A repo
  marked gone is not shown, including when it is pinned. A failed or empty `gh repo list`
  records `last_error` and does not delete or hide tracked repos.

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
coordinator silent past the limit, a repo with zero merges for 72h that had merges before, or
a decision older than 14 days. No other pushes. A review-SLA breach is listed in the brief and
is not a push. A dashboard you have to
open tells you about a stall three days late; a chat that pings on every event trains you to
ignore it.

Those three pushes are `brief.alerts` in `progress.config.json`. `enabled` defaults to
**false**. `POST /api/brief/alerts/evaluate` computes the conditions either way and inserts a
message only when `enabled` is boolean true. `GET /api/brief/alerts` reports the same
conditions and never sends. The progress collector does not evaluate alerts. The scheduler
that curls `GET /api/brief` is what POSTs the evaluate route, on that same cadence, not on
every collector tick. Nothing else inserts an alert message.

Threshold alerts are **off until the owner has cleared the decision backlog once.** Importing
two dozen stale decisions and alerting on every one of them on day one teaches the owner to
ignore the channel; the first week is collection only. The enable switch is that gate: leave
`brief.alerts.enabled` false until that first clear, then set it to true. Defaults besides
the switch: coordinator re-send 12h, zero-merge 72h after a merge in the prior 7 days,
decision age 14 days. An unmeasured source is `unknown`. Unknown does not send and does not
clear a latch.

Each claim carries the evaluation's compute instant, the database clock used to judge the
condition. A cleared latch is re-armed only when `cleared_at` is null or older than that
instant, and a clear writes `cleared_at` only when the latch is still active and
`last_sent_at` is older than the clear's own instant. A clear that saw newer evidence beats
a stale claim, and a delayed clear cannot erase a newer claim. A decision alert is inserted
only while that decision is still `open` and its `opened_at` (or `first_seen_at` when
`opened_at` is null) is still at least `decisionAgeDays` old at the compute instant. One
residual window remains: an event that lands between compute and claim, with no concurrent
evaluation to clear the latch, can still produce one alert. The next evaluation clears it.

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

## Host watcher

The brief's coordinator check is a work event (`session_end`, `milestone`, or `status`). The host watcher is a different measurement. It reads `GET /api/watch/beats` and judges whether the Mini and MacBook dead-man observations were received, using the server's `age_s`. It does not prove the coordinator did any work, and it does not replace the threshold alerts. `scripts/watch.config.json` lists the expected sources. The check walks that list, not only the rows that came back.

For each enabled source:

- Missing from a successful read: `source-missing`.
- `status` of `stale`, `failing`, `paused`, or `unknown`: `unhealthy:<status>`, at any age.
- `status` of `ok` or `held` with `age_s` greater than that source's `max_age_s`: `stale`. `age_s` equal to the limit is within the limit. `held` is the producer's own hold. This check does not decide whether the hold was authorized.
- Any other returned source is ignored. `watcher` is this monitor's own beat, so it is left out of the host loop.

Mini is enabled at 2700 seconds. MacBook is listed at 93600 seconds and left disabled until that producer is installed. Mark sets `enabled` to true when the producer is in place. The limits are config, not secrets. `beat_at` is stored as the sender sent it, including a clock two days behind or two days ahead. `age_s` is the only age.

A successful read is a JSON object whose `beats` field is an array. Each row has string `source`, `status`, `detail`, `beat_at`, and `received_at`, and a finite, non-negative numeric `age_s`. A non-2xx response, a 10 second timeout, malformed JSON, a non-object body, a `beats` value that is not an array, a bad field type, or two rows for the same source fails the whole read. The check tries once more after 30 seconds. A retry that succeeds is evaluated as a normal read and can still alert. Two failures raise only `api-unreachable`. They do not invent a per-host failure and they do not clear a latch.

Slack and Telegram are independent. Each attempt times out at 10 seconds. Slack succeeds on HTTP 2xx, and only when the webhook starts with `https://hooks.slack.com/services/`. Telegram succeeds on HTTP 2xx and a JSON body with `ok` set to true. The bot token and chat id must match the shapes the script checks, or that channel fails closed and no request is sent. A timeout, a non-2xx status, a body that is not that JSON, or `ok: false` is a failed delivery on that channel only. Logs drop webhook URLs, bot tokens, authorization headers, and raw provider bodies.

The alert key is `<destination>|<source>|<condition>` with condition `source-missing`, `stale`, or `unhealthy:<status>`. A failed read uses `<destination>|api-unreachable` and no host key. A new condition is a new key. A failed send stays pending on the original key and is tried on the next run. A successful send suppresses that key for 12 hours while the condition holds. The boundary is inclusive at the end: a run at `lastDeliveredAt + 12h` sends again, and a run one millisecond earlier does not. When a later successful read shows that source healthy, each destination that received the alert gets one recovery, and that recovery closes only its key. A destination that never received it gets no recovery. A failed read does not clear those keys. A failed store of this monitor's own beat uses `<destination>|beat-post-failed` the same way.

The process exits nonzero when any expected source is unhealthy, the read failed, a delivery failed, or the watcher beat did not store. Suppression drops the repeat message. The exit status stays nonzero.

There is no detection SLA. The schedule is `7,17,27,37,47,57 * * * *` UTC. That asks GitHub for a run every ten minutes. GitHub can delay a run, skip a run, or turn schedules off on a public repository after 60 days without a person pushing or dispatching the workflow. Six runs an hour is about 4,320 runs in 30 days before a retry. Hosted minutes are free on a public repository and come out of the included quota on a private one. Mark accepts that cost before activation.

Dedup state is a small JSON document of keys and delivery timestamps. It holds no credentials and no raw API or provider payloads. The Actions cache is best effort. On a live run the workflow restores with the prefix `watch-state-v1-` and saves a new immutable key `watch-state-v1-<run_id>-<run_attempt>`, including after a nonzero evaluation, then the job exits with that evaluation's code. A dry-run or disabled run does not restore or save, so it never creates a cache entry. A missing, evicted, or corrupt cache is unknown history: current faults alert again, and no recovery is invented. A crash after a successful send and before the save can deliver the same message once more. Cache quota can drop the entry. Those are the limits.

After evaluation the run POSTs `/api/watch/beat` as source `watcher`. The credential is a dedicated `akc_` key with `watch:read` and `watch:write`, bound only to `watcher`, passed from the `WATCH_AK_KEY` secret into the live step. It is not written to the log. `beat_at` is this run's clock. `status` is this monitor's own read and delivery health (`ok` or `failing`), which is separate from the Mini and the MacBook. A failed store fails the run and is reported on the configured channels.

Reverse watch is the other half of the pair, and this repo only states the contract. A Mini integration tracked outside this repo reads `age_s` for source `watcher` and alerts when that beat is missing or older than 3600 seconds. It says one thing when the API could not be read and a different thing when the API answered and the watcher was silent. Nothing here shows that the Mini side is installed. Until that is demonstrated, the two checks are not coverage for each other.

Activation is Mark's. Merging the workflow leaves it dark. The live step receives notification secrets and `WATCH_AK_KEY` only when `github.ref` is `refs/heads/<default branch>` and the repository variable `WATCH_ENABLED` is `true`. `github.ref` includes the `refs/heads/` prefix, so the comparison uses that full ref. Any other `workflow_dispatch`, and every run while `WATCH_ENABLED` is unset, takes the dry-run step: `node scripts/watch-check.mjs --dry-run` with no fixture. That step receives no secret context. Workflow permissions are exactly `contents: read`. Cache restore and save use the runner's scoped cache token. The job token cannot push. Both cache steps carry the same live gate, so a dry-run or disabled run never restores or saves a cache entry. `--dry-run` performs no network I/O to Agent Kontrol, Slack, or Telegram. `--fixture <path>` reads a beats document from a path under the working directory or the system temp directory, evaluates it, and prints the decisions. It sends nothing, posts no beat, and writes no state. A path outside those directories is rejected and left unopened. With no `--fixture`, the process prints `dry-run: no fixture, nothing evaluated` and exits 0.

Rollback is: set `WATCH_ENABLED` to `false`, disable the workflow, let an in-flight run finish, then revoke the watcher credential. Tell the Mini reverse-watch the shutdown was intentional. Leave the existing dead-man in place.

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
   Shipped 2026-10-27: `GET /api/brief` and MCP `get_morning_brief` read Postgres. The cron should `curl` the route. `scripts/morning-brief.sh` stays the fallback and still sweeps GitHub. The API does not. A 72h lead time uses `detail.merged` from the collector, not a live recompute. A positive 72h merge count with no `detail.merged` prints `SHIPPED: DATA INCOMPLETE` for that repo. A cumulative counter that went backwards is unmeasured (`DATA INCOMPLETE`), not 0. A decisions page that fills the 1000-row read is incomplete. With no database the route does not fill in the progress board's demo numbers.
5. `/decisions` page; `request_decision` MCP tool.
6. Owner-based repo discovery (`watched_owners`); Settings becomes the override layer. Shipped:
   `GET`/`PUT /api/settings/owners`, `POST /api/settings/owners/discover`, `PATCH /api/settings/repos`,
   and `discover_watched_owners` in `scripts/collect-progress.sh`. The morning brief drops a repo
   only when `shown` is false. The collector still sweeps hidden and quiet repos and skips `gone`.
7. Remaining threshold alerts (zero-merge repo, 14-day decision), plus the coordinator-silence
   re-send, behind `brief.alerts.enabled` (default false) until the owner's first backlog clear.
   Shipped as `GET /api/brief/alerts` and `POST /api/brief/alerts/evaluate`. Review-SLA alerts
   are not sent. No other pushes.

## Absence sweeper

Issue #79, Gibson doc 33 (draft, non-normative). A stuck PR, a silent consumer, an aging decision, and an unexplained pause are things that did not happen, so no webhook delivers them. The sweeper writes them to the `gh_events` inbox as synthetic events ([EVENTS.md](EVENTS.md#synthetic-rows)). It sends no message, invokes no Spec Writer, and queues no work.

### What is shipped and what is not

Shipped: `POST /api/sweep` (one run), `GET /api/sweep` (read-only status), `POST /api/sweep/consumers` (registrations), the three sweeper observation kinds on `POST /api/ingest`, the brief's Paused section, the manual runner `scripts/sweep-once.sh`, and an inert five-minute example in `docs/examples/absence-sweep.cron.example`, and the queue and PR producer `scripts/sweep-producer.sh` (off by default; see [Producer](#producer)).

Not performed: no `vercel.json` cron, no launchd job, no Mini change, no collector scheduling, no producer config installed or enabled, no live GitHub collection, no consumer registration, and no live migration. The five-minute cadence and its operational acceptance are left for the owner. Until registrations and observations exist, the checks report `not_configured` or `unknown`, never `clear`.

### Conditions

All thresholds, ages, freshness, repeats, and retention use database time. Each check reads one instant (`clock_timestamp()`) after taking its lock; the host clock and any caller "now" are never used. Source timestamps (`observed_at`, `opened_at`, `paused_at`, `until`) are facts compared against that clock.

| Condition | Fires when | Clears when | Unknown when |
| --- | --- | --- | --- |
| `consumer-silent` | An enabled consumer has ready work and no `session_end`, `milestone`, or `status` from one of its registered reporters within `max_silence_hours` (default 3). A never-seen consumer gets that grace from `registered_at`. | The queue is measured empty, a matching work event lands, the consumer is disabled, or its mapped scheduler job is validly held (reported as `held`). | The collector queue is stale, incomplete, or missing, or the mapped scheduler job is unknown. |
| `pr-stuck` | A non-draft open PR is older than `brief.stuckPrHours` (default 48), is conflicting, or has its required checks green at the exact head for 30 minutes with no review started at that head. A proven age or conflict term fires even when the green or review facts are unknown. | A fresh complete snapshot shows it closed (absent) or every term false. | The repository's newest snapshot is stale, incomplete, or missing. A repository with no known PR is still reported unknown as `repo:<owner/name>` (not latched, never emitted), so an unmeasured repository is never a clear. |
| `pause-unexplained` | A fresh paused job is neither held nor expired: no citation, or no future `until`. | The job is active, held, or expired (expired wins for the same pause). | The job record is stale. |
| `pause-expired` | A fresh paused job's explicit `until` is at or before database time. Expiry is never inferred from `paused_at`; the draft's 72 hour maximum is advisory. | The job is active, or `until` moves into the future with a citation (held). | The job record is stale. |
| `resume-uncited` | The current transition is an observed paused-to-active change with no citation of its own. A first active observation is not a resume. The pause's citation never covers the resume. | A citation is added to that same transition, or a later transition replaces it. | Never; it is a recorded transition. |
| `decision-aging` | An open decision (or a deferral whose `defer_until` has passed) is 14 days old by `opened_at`, otherwise `first_seen_at`. The decisions table is authoritative. | It is decided, withdrawn, removed, or validly deferred (`held`). Removal is proven by looking up the latched key itself, never by its absence from the bounded scan of aging candidates. | The row has neither timestamp. |
| `dispatch-ready-empty` | A fresh complete `issue_dispatch` queue shows raw unspecced issues and zero dispatch-ready ones, continuously for one hour. | Ready work appears or the raw backlog disappears. | The queue is stale or incomplete. |

`held` is the non-alerting verdict for a cited, unexpired pause, a held consumer, and a valid deferral. It clears an active latch like `clear` does.

Combined predicates use three-valued logic: one true term makes an OR true, one false term makes an AND false, anything else undecided is unknown.

### Latches and repeats

`sweep_latches` holds one row per condition and entity, independent of inbox retention. First firing writes one event at once. While it keeps firing, it writes again only 12 hours after its last emission (this repeat rule applies to every condition, including `decision-aging`). Active to clear writes exactly one `<condition>-cleared`. Already clear writes nothing; a new proven episode writes at once. Unknown never writes and never clears, and leaves `active`, `episode`, `seq`, and `last_emitted_at` alone.

Every domain runs in its own transaction: `pg_advisory_xact_lock` on the domain, one database instant, evidence read with `for share` row locks, latch rows locked `for update`, inbox insert, latch update, commit. A concurrent run waits on the lock and then sees the committed latches. A latch already evaluated at a later instant is not overwritten. Delivery ids are deterministic per episode and sequence, so a retry after a committed run whose response was lost writes nothing new. There are no wall-clock buckets. A failed statement aborts only its own domain, which reports `unknown` with an error; the other domains still run. Each domain visits at most 500 entities per run (active latches first); `complete: false` and `unvisited` say so, and unvisited entities are not clear.

### Evidence

Only trusted writers create evidence. Scheduler, queue, and PR observations need `MC_TOKEN` on `POST /api/ingest`; registrations and runs need `MC_TOKEN` or the signed-in dashboard. A generic `status:write` credential, OAuth, or an open dashboard cannot alter these facts, spoof the reserved kinds, manufacture an empty queue, or clear an alarm. Every observation is validated and bounded before any write, and its audit row and projection commit together. The sweeper never reads `events.detail`.

- Scheduler jobs (`sweep.scheduler_job`): one row per `source`/`job_id` in `scheduler_jobs`, ordered by the source's monotonic `transition`. See [API.md](API.md#sweeper-observations) for replay rules.
- Queues (`sweep.queue`): `issue_dispatch` ready is open issues labelled `dispatch-ready` and not blocked; raw is open issues with neither label (unspecced). `pr_review` ready is open non-draft PRs at their current head waiting on a reviewer; raw is every open PR. Open counts minus blocked counts are not a classification. A consumer's own claim that nothing is ready is not evidence. Local task queues use the task table directly: queued, this platform or `any`, unpinned or pinned to the registered machine.
- PRs (`sweep.pr_snapshot`): every open PR in one repository at one instant. `green_since` is the database receipt time of the first observation with required checks green at that head; a head or check-state change, or a gap longer than the freshness window, resets it.
- The existing `repo_snapshots` ages and stuck lists are not used as the sweeper clock: they lack raw timestamps and review-start facts.

Freshness defaults to 30 minutes, twice the 15 minute collector tick. A source may send `stale_after_minutes` (5 to 1440) with each observation. Stale, failed, or truncated evidence is unknown, never zero, and an older success never replaces a newer failure.

### Producer

`scripts/sweep-producer.sh --repo owner/name` measures one repository and POSTs `sweep.queue` (`issue_dispatch`) and `sweep.pr_snapshot` with `MC_TOKEN`. `--dry-run` prints both envelopes and posts nothing. `scripts/collect-progress.sh` runs it per repo on each tick, as a child process whose failure never stops the progress tick; `--backfill` never runs it, so no historical tick carries current queue or PR state. The installer copies the script beside the collector and changes nothing else.

It is off until `sweep-producer.config.json` (beside the script, or `MC_SWEEP_PRODUCER_CONFIG`) sets `"enabled": true`. That file is separate from `progress.config.json` and from the dashboard's repo list, which carry no readiness policy. It names the `source` id and, per repo, the `queue` id, `ready_labels`, `blocked_labels` (may be `[]`, must be stated), optional `raw_exclude_labels`, `required_checks` (context names), and an optional `review_start.status_context`. `scripts/sweep-producer.config.example.json` is an inert example. A repo with no entry is unconfigured: nothing is emitted and readiness is never guessed. Label and context names compare case-insensitively.

- Queue: every open issue with its labels, paged to at most 1,000, then read a second time; the set is complete only when both reads have the same issues and labels. Ready has a ready label and no blocked label; raw has no ready, blocked, or excluded label. Counts are the whole set; refs are the 50 lowest numbers.
- PRs: every open PR (at most 200) with raw `createdAt`, draft, mergeability, head, the required contexts on the head commit, and reviews. A second pass re-reads every head; a moved head or a changed open set makes the snapshot incomplete. A missing, truncated, or unconfigured required context is `unknown`, never green, and a rollup not at the head is `unknown`. A published review counts only at the current head. `started: false` is sent only when the configured review-start status context is absent from a complete context list at the head; otherwise `review` is omitted.
- Any GitHub failure, rate limit, timeout, malformed page, cap overflow, or a set that changed while paging is a newer `complete: false` observation with a short error, never a zero or an empty list. Each repo and each subject is independent.
- Sequence numbers are persisted per subject in `MC_SWEEP_STATE_DIR` under a lock held for the whole collect-and-post, so a later collection always has the higher `seq`. The body is stored before the POST; an unacknowledged POST (transport failure, `429`, `5xx`) is retried first on the next run with the same `seq` and the same bytes. A `4xx` rejection or a `replay`/`older` answer to a new `seq` is logged as `REJECTED` or `STALE` and the run exits non-zero. State never holds a token, and response bodies are not printed.

### Consumer liveness and provenance

`events.principal_kind` and `events.principal_id` record the verified caller of `POST /api/ingest` and MCP reporting (`report_status`, `update_task`). A consumer registration lists the reporters whose work events count. Only a matching authenticated work event proves liveness; an `agent_id` in a body is not enough, and heartbeats and errors never count. Events stored before these columns existed, dev-open writes, and the task REST routes carry no provenance and are unmeasured. That is the baseline: a consumer registered today is measured from its registration, not from history.

A validly held scheduler job mapped to a consumer suppresses that consumer's silence alarm. It does not change the brief's coordinator verdict: the `COORDINATOR` line and its `NOT WORKING` / `FAILING` wording are unchanged.

### Brief: Paused

The brief (route and `scripts/morning-brief.sh`) gains a Paused section after the decisions:

```
PAUSED (2) — job, age, reason, until, decision
  mini/carmack-review  64.0h  UNEXPLAINED  reason: -  until: -  decision: -
  mini/nightly  3.0h  held  reason: owner travel  until: 2026-10-31T00:00:00.000Z  decision: mrhinkle/agent-kontrol#79
HELD VERSUS UNEXPLAINED: 1 held, 1 unexplained, 0 expired
```

A stale job is listed as `??` with its last report age, and the heading becomes `PAUSED: DATA INCOMPLETE — n job(s) stale; known rows below`. A failed read, no database, or no job ever reported is `PAUSED: DATA INCOMPLETE (...)`, never `none`. The script reads `GET /api/sweep`; it never guesses scheduler state. Brief alert switches and outbound messages are unchanged: the sweeper does not notify.

### Retention

Each run deletes inbox rows older than 30 days by database time in indexed batches (1,000 per batch, 10 per run). See [EVENTS.md](EVENTS.md#retention).

### Running it

`scripts/sweep-once.sh` posts one run with `MC_URL` and `MC_TOKEN` from the environment and prints the result. `docs/examples/absence-sweep.cron.example` is an inert five-minute line for that script; nothing installs it.

Rollback: revert the change. The new tables and columns are additive and inert without the routes; events stop.
