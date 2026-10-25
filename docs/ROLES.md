# Roles: the job descriptions

A fleet that drains a backlog has four jobs. This page is written so that anyone adopting
Agent Kontrol and the Gibson can decide **which agent holds which job**, what that agent is
accountable for, what it may never do, what it costs, and how to tell from the morning brief
whether it is doing the work.

Three rules before the cards:

- **A role is a contract, not a vendor.** Any runtime can hold any role if it keeps the
  contract. Agent Kontrol routes by task class; the contract is identical wherever it runs.
- **Whoever wrote it does not review it.** The Implementer and the Reviewer on one unit of work
  are different vendors. A single agent may hold both roles in a solo fleet only *sequentially*,
  with a fresh context per role.
- **The binding rules live in the target repository's `AGENTS.md`** (and, where the Gibson is
  adopted, in its role contracts). These cards explain the jobs and how to staff them. They do
  not add or weaken a gate.

## The funnel, and who moves work through it

```
raw issue ──(Spec Writer)──> dispatch-ready ──(Dispatcher)──> in lane ──(Implementer)──> PR
   PR ──(Reviewer)──> evidence ──(Dispatcher / merge-on-green)──> merged ──(Reviewer, post-merge)──> verified
                 anything that fails twice, or needs a call only a human can make ──> Owner decision
```

The morning brief shows the count at each stage. A deep pile at one stage names the role that
is behind. Measured in this fleet on 2026-10-25: the same harness and vendors produced 136
merges in 30 days in a repo with specs and a daily owner, and 15 in a repo with neither. The
difference was never the Implementer.

## Staffing matrix

| Role | What it optimises | Judgment needed | Suitable tier | Runs | Cost shape |
|---|---|---|---|---|---|
| **Spec Writer** | work that can be built without asking | high | top reasoning (Claude Fable/Opus class) | scheduled, budgeted per day | tokens per spec; the cheapest place to be wrong |
| **Implementer** | correct diff, small, in scope | medium | fast coding tier (Grok, Codex, Claude Sonnet class) | per lane, parallel | tokens per PR; rework dominates |
| **Reviewer** | defects caught before merge | high, adversarial | a *different* vendor from the Implementer, read-only; mid tier for A/B, top tier for Tier C | per PR, within hours | tokens per review; latency matters more than tokens |
| **Dispatcher** | lanes busy, nothing stuck silently | none | a script, not a model | every few minutes | compute only |
| **Owner** | decisions answered, priorities stated | highest | a human | daily, from the brief | minutes; the scarcest budget in the system |

---

## Spec Writer

**Mission.** Turn a raw issue into one that an Implementer can finish without asking a
question, and refuse to pretend when it cannot.

**Accountable for**

- Every issue it touches ends in exactly one of two states: `dispatch-ready` with a spec, or a
  filed decision that names what only the owner can answer.
- The spec is one mergeable unit of work. If it is not, the Spec Writer splits it.
- The dispatch-ready queue never runs dry while raw issues exist and decisions are answered.

**Inputs.** Raw issues (no spec, or a spec that failed the gate), the repo's `AGENTS.md`, the
lessons ledger, the open claims table, the live code, the owner's stated priorities.

**Output: the spec, written into the issue body.** It contains, in this order: the problem in
one paragraph; scope and explicit non-scope; numbered acceptance criteria, each testable by a
machine or a reviewer; the file scope (paths the lane may touch); the tier (A/B/C, with C for
money, consent, auth, schema); dependencies (`Blocked-by #N`); and the one-line verification
step a reviewer will run. UI work carries a design language or a wireframe. Then the labels:
tier, `dispatch-ready`, and the blocked label if it depends on something.

**May.** Edit issue bodies and labels. Split and close duplicates. File decision rows. Read
anything in the repo. Ask the owner one business question at a time through the decision
queue.

**Never.** Write implementation code. Mark an issue ready that depends on an unanswered
decision. Specify how to implement rather than what must be true afterwards. Create issues
behind a known common blocker (clear the blocker first; discovery of a new defect is always
allowed).

**Quality bar.** A spec passes when a second agent, given only the issue and the repo, can
state the first file it would open and the first test it would write. The repo's spec gate
(where one exists) is the floor, not the bar.

**Cadence and budget.** Scheduled, a few issues per run, with a daily token budget. Priority
order: issues the owner named, then the oldest P0, then whatever unblocks the most others.
It stops when the dispatch-ready queue holds more than the fleet can build in two days.

**You know it is working when** the brief shows dispatch-ready depth between two and ten per
repo, the decisions it files are answered rather than withdrawn, and Implementer PRs stop
carrying "clarification" comments. **You know it is failing when** dispatch-ready is empty
while raw issues pile up, or when lanes fail on the first run because the spec was wrong.

**Seen in this fleet.** Chatterbuilt, 2026-10-25: 163 open issues, 17 P0s, zero dispatch-ready.
No one held this role. Capacity sat idle for a month.

**Gibson mapping.** `planner` + `decomposer` playbooks, collapsed into one role because for a
backlog of existing issues the plan already exists; the job is making each issue buildable.

---

## Implementer

**Mission.** Turn one dispatch-ready issue into one small, green, in-scope pull request, and
report truthfully when it cannot.

**Accountable for**

- The PR closes exactly the issue it claimed, touches only the declared file scope, and passes
  the repo's preflight before it is opened.
- Every acceptance criterion in the spec is addressed or explicitly listed as not done.
- The commit carries the vendor identity (`Agent-Vendor:` trailer or lane-bot identity) so the
  Reviewer and the ledger know who built it.

**Inputs.** One claimed issue with a spec. A fresh git worktree on its own branch. The repo's
`AGENTS.md`, lessons ledger, and preflight script. Nothing else: an Implementer that needs more
has found a spec defect, which it reports.

**Output.** A branch and PR referencing `Closes #N`, with the preflight output pasted, a
summary of what changed and what was verified, and no claims it did not check.

**May.** Edit files inside the claimed scope. Add tests. Run the preflight and local gates as
often as it likes. Push to its own branch. Comment on the issue when the spec is wrong.

**Never.** Edit outside the scope or in the canonical checkout. Merge. Review its own work.
Weaken or delete a failing test to go green. Add a dependency casually. Rebase or force-push
a branch under review (it invalidates the review's pinned head). Mark a check green it did not
run.

**Quality bar.** Green at the exact head on every required check; diff under the repo's PR-size
limit; a reviewer can trace each hunk to a criterion.

**Cadence and budget.** One lane per Implementer process, several in parallel across disjoint
scopes. Lead time from claim to PR should be hours, not days; a lane older than 48 hours is
reported stuck. Retry once on a failed gate; twice means the Dispatcher escalates.

**You know it is working when** median open-to-merge lead time is under a day and the stuck-PR
list is short and explained. **You know it is failing when** the same PR accumulates review
rounds, or PRs sit green and unreviewed (that is the Reviewer's failure, and the brief will
say so).

**Seen in this fleet.** ConferenceOS, 30 days: 136 merges, median lead 3.6 hours in the last
24h. Also: a PR left 13 days with a merge conflict nobody owned. The role is cheap; the
hand-off after it is not.

**Gibson mapping.** `builder`; `test-engineer` where the spec demands new tests.

---

## Reviewer

**Mission.** Find what is wrong with a PR before it merges, with evidence, and never grade
work it produced.

**Accountable for**

- A verdict within the agreed latency (hours, not days) on every PR the Dispatcher presents,
  pinned to the exact head SHA reviewed.
- Findings with file and line, graded by severity, across the lenses the repo requires
  (correctness, tests, security, scope, contract, maintainability).
- A post-merge verification on Tier C and on anything deployed: does production do what the
  criterion said.

**Inputs.** A green PR at a named head, its issue and spec, the tier label, the repo's lenses.
Read-only access to the code.

**Output.** A review ending in exactly one line, `VERDICT: APPROVE` or
`VERDICT: REQUEST_CHANGES`, with findings above it, posted as review evidence the gate can
read. On Tier C, an adversarial pass that tries to break the change, not just read it.

**May.** Read everything. Run the build, lint and tests locally. Request changes. Re-tier a PR
whose diff drifted into money, consent, auth or schema.

**Never.** Review its own vendor's generation on the same unit of work. Merge. Write code into
the Implementer's branch. Approve without per-lens clearance ("LGTM" is a contract violation).
Approve a head other than the one it read. Soften a hard-fail finding to report-only.

**Quality bar.** Every finding is reproducible from the PR alone. Every APPROVE names what was
checked. Escaped defects (found after merge) are counted against the Reviewer, not the
Implementer.

**Cadence and budget.** Per PR, triggered by the gate or the Dispatcher. Latency is the metric
that matters: the September measurement in this fleet found review and merge latency, not
coding parallelism, was the throughput constraint. Mid tier for Tier A/B; top tier plus a
second lens for Tier C.

**You know it is working when** time-in-review is a small share of lead time and the
escaped-defect count stays near zero. **You know it is failing when** PRs sit green with
`review-evidence` pending, or when approvals outnumber findings for weeks.

**Seen in this fleet.** A gate that only accepted one reviewer identity sat dead for weeks
while merges stalled; the fix was a second-vendor reviewer running as a GitHub App. A reviewer
that "re-read" a PR after the Implementer force-pushed approved a head it had never seen.

**Gibson mapping.** `reviewer`, plus `security` and `ux-evaluator` lenses on the tiers that
require them.

---

## Dispatcher

**Mission.** Keep every lane busy with the next right item, notice when anything stops, and
escalate instead of guessing. It has no judgment and needs none.

**Accountable for**

- Claiming the highest-priority dispatch-ready item atomically (two machines never take the
  same one) and starting the lane within minutes.
- Presenting every green PR to a Reviewer and merging what has evidence, in dependency order,
  one at a time.
- Opening a decision row for anything that fails twice, conflicts, or waits on a label only a
  human can set, and then leaving it alone.
- Posting a work event (not a heartbeat) at the end of every round, so the brief can tell
  working from alive.

**Inputs.** The queue (`dispatch-ready` items across watched repos, by priority), the live
claims, the PR list with check states, the merge train order.

**Output.** Lanes started, PRs merged, decision rows filed, a round receipt per cycle with
counts: claimed, started, presented for review, merged, escalated.

**May.** Claim, start and stop lanes. Trigger reviews. Merge PRs that carry review evidence at
the current head and pass every required check. Remove stale claims past their TTL. Alert the
owner on the agreed channel when a threshold is crossed (once, then every 12 hours).

**Never.** Write a spec, edit code, or pick between options. Merge on green CI alone where the
repo's rules require evidence. Retry the same failing item a third time. Hold a lock without a
PID and TTL. Approve another agent's permission prompt. Run two lanes in one checkout.

**Quality bar.** Deterministic: given the same queue and repo state it does the same thing. A
round receipt exists for every scheduled run. Zero items in `claimed` older than the TTL.

**Cadence.** Every few minutes while the queue is non-empty. One instance per machine, with a
kill switch the owner can flip in one command.

**You know it is working when** the brief's coordinator line says *working*, dispatch-ready
depth falls while lanes stay busy, and stuck PRs each carry a reason. **You know it is failing
when** dispatch-ready is deep and in-lane is empty, or when the coordinator line says *only
telemetry*.

**Seen in this fleet.** An LLM coordinator with a 66 KB plan file and ad hoc lock files sat on
a dead lock for five days in October and was paused for two days without a recorded reason
while its heartbeat said healthy. A coordinator that reasons about what to do next is a Spec
Writer with a dispatcher's permissions; split the jobs.

**Gibson mapping.** `release` and `delivery-control` for the merge and promote half; the claim
loop in `loop-step`. Agent Kontrol's per-machine dispatcher is the reference implementation.

---

## Owner

The one role a model cannot hold. Accountable for answering the decision queue (oldest first,
every working day), stating priorities the Spec Writer can read, and deciding tier-C questions
about money, consent, auth and schema. Never in the review loop on individual PRs: that is the
Reviewer's job, and an owner attestation is a bypass of it. The brief exists so this role costs
minutes a day; a decision older than fourteen days is the system's failure, not the owner's.

## Choosing who holds what

1. Start with the Dispatcher as a script and the Reviewer as a different vendor from your
   Implementer. Those two decisions prevent most of the failures above.
2. Put your most capable model on the Spec Writer, on a budget. It is the cheapest place to be
   wrong and the most expensive to skip.
3. Put your cheapest competent coder on the Implementer and let it run many lanes.
4. Measure with the brief for two weeks before adding any role, gate or agent. Process scales
   with measured throughput; a repo under about twenty merges a month needs a thin path, not
   more supervision.

Related: [VELOCITY.md](VELOCITY.md) (the brief and the decision queue), [PLAYBOOK.md](../PLAYBOOK.md)
(the operating model), the Gibson's `docs/03-roles.md` and `playbooks/` (binding contracts and
dispatch prompts).
