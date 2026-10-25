# Roles: the job descriptions

A fleet that drains a backlog has four agent jobs and one human one. This page is written so that anyone adopting
Agent Kontrol and the Gibson can decide **which agent holds which job**, what that agent is
accountable for, what it may never do, what it costs, and how to tell from the morning brief
whether it is doing the work.

Three rules before the cards:

- **A role is a contract, not a vendor.** Any runtime can hold any agent role if it keeps the
  contract; the Owner role is held by a person. Agent Kontrol routes by task class; the contract is identical wherever it runs.
- **Whoever wrote it does not review it.** The Implementer and the Reviewer on one unit of work
  are different vendors, and so are the Spec Writer and the agent that scores its spec. A fleet
  with a single vendor has no agent that may review, so it has no agent review path and no
  Dispatcher merge path: a human performs the review (the same lenses, the same verdict line,
  posted as evidence under the human's identity) and a human merges. Same-vendor agent output,
  sequential or not, fresh context or not, is never review evidence and never a basis for a
  merge. The Dispatcher's merge gate below does not relax for a single-vendor fleet.
- **Provenance has one reading, and the registry is not in any lane.** The PR author's vendor
  is the `Agent-Vendor:` trailer on the PR's commits; where a repo commits through a per-vendor
  lane-bot identity instead, the gate reads the vendor from the bot's registered identity (one
  bot per vendor). The identities registry lives outside every repo the fleet works on (in the
  operator's fleet configuration, not in the target repo), is writable only by the operator,
  and is excluded from every lane's file scope; an Implementer cannot add or change an entry.
  A commit whose trailer names a vendor that does not match its author's registered identity
  is a provenance failure, not a different vendor. Both forms resolve to a vendor name; a
  commit with neither has no vendor and does not merge.
- **Numbers, not adjectives.** Every latency and depth in these cards is a number the brief
  reports and a breach it names: review verdict within 4 hours (Tier A/B) or 12 hours (Tier C)
  of green-at-head; a lane older than 48 hours is stuck; dispatch-ready depth capped at 10 per
  repo; a decision older than 14 days is a breach.
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
is behind. Observed in one fleet on 2026-10-25 (figures throughout this page are dated
observations from that fleet, not benchmarks): the same harness and vendors produced 136
merges in 30 days in one repo and 15 in another. Two repos is not a controlled comparison, but
the visible differences were specs per issue and an owner answering daily, and in neither repo
was the Implementer the stage with the pile.

## Staffing matrix

| Role | What it optimises | Judgment needed | Suitable tier | Runs | Cost shape |
|---|---|---|---|---|---|
| **Spec Writer** | work that can be built without asking | high | top reasoning (Claude Fable/Opus class) | scheduled, budgeted per day | tokens per spec; the cheapest place to be wrong |
| **Implementer** | correct diff, small, in scope | medium | fast coding tier (Grok, Codex, Claude Sonnet class) | per lane, parallel | tokens per PR; rework dominates |
| **Reviewer** | defects caught before merge | high, adversarial | a *different* vendor from the Implementer, read-only; mid tier for A/B; Tier C needs two reviewers from two vendors, at least one top tier | per PR, within hours | tokens per review; latency matters more than tokens |
| **Dispatcher** | lanes busy, nothing stuck silently | none | a script, not a model | every few minutes | compute only |
| **Owner** | decisions answered, priorities stated | highest | a human | daily, from the brief | minutes; the scarcest budget in the system |

---

## Spec Writer

**Mission.** Turn a raw issue into one that an Implementer can finish without asking a
question, and refuse to pretend when it cannot.

**Accountable for**

- Every issue it touches ends in exactly one of two states: `dispatch-ready` with a spec, or a
  filed decision that names what only the owner can answer. **Filing a decision is not the
  cheap exit.** A decision row must name the files the Spec Writer read and the two scopings it
  could not choose between; a row without both is returned to the Spec Writer, not the owner.
  The brief reports decisions filed per spec written; above one to one, the Spec Writer is
  deferring and is the role at fault.
- The spec is one mergeable unit of work. If it is not, the Spec Writer splits it.
- The dispatch-ready queue never runs dry while raw issues exist and decisions are answered,
  and never exceeds the cap (10 per repo).

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

**Cadence and budget.** Scheduled, a few issues per run, with a daily cap (default ten issues
or the token budget, whichever first). Priority order: issues the owner named, then the oldest
P0, then whatever unblocks the most others. It stops when the repo's dispatch-ready depth
reaches the cap.

**You know it is working when** the brief shows dispatch-ready depth between two and the cap
per repo, decisions filed per spec written stays well under one, and Implementer PRs stop
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
- The commit carries the vendor identity (`Agent-Vendor:` trailer, or a per-vendor lane-bot
  identity registered in the operator's fleet configuration, outside the repo) so the Reviewer, the Dispatcher's gate and the ledger resolve
  who built it (see "Provenance has one reading").

**Inputs.** One claimed issue with a spec. A fresh git worktree on its own branch. The repo's
`AGENTS.md`, lessons ledger, and preflight script. Nothing else: an Implementer that needs more
has found a spec defect, which it reports.

**Output.** A branch and PR referencing `Closes #N`, with the preflight output pasted, a
summary of what changed and what was verified, and no claims it did not check.

**May.** Edit files inside the claimed scope. Add tests. Run the preflight and local gates as
often as it likes. Push to its own branch. Comment on the issue when the spec is wrong.

**Never.** Edit outside the scope or in the canonical checkout. Merge. Review its own work.
Weaken or delete a failing test to go green. Add a dependency casually. Rebase or force-push
a branch under review (it invalidates the review's pinned head; when the branch falls behind,
the Dispatcher merges the base in and re-requests review, see below). Mark a check green it did
not run.

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

- A verdict within 4 hours (Tier A/B) or 12 hours (Tier C) of the PR going green at its head,
  pinned to the exact head SHA reviewed. The brief lists every breach by PR and hours over.
- Findings with file and line, graded by severity, across the lenses the repo requires
  (correctness, tests, security, scope, contract, maintainability).
- A post-merge verification on Tier C and on anything deployed: does production do what the
  criterion said.

**Inputs.** A green PR at a named head, its issue and spec, the tier label, the repo's lenses.
Read-only access to the code.

**Output.** A structured review-evidence comment the gate can read: a header naming the exact
head SHA reviewed, the reviewer's vendor and model tier (`tier: top|mid`), one line per required
lens stating `cleared` or a finding, the findings
with file and line, and a final line that is exactly `VERDICT: APPROVE` or
`VERDICT: REQUEST_CHANGES`. A comment missing any required lens line is not evidence, whatever
its verdict says. On Tier C, an adversarial pass that tries to break the change, not just read
it, recorded as its own lens line.

**May.** Read everything. Run the build, lint and tests locally. Request changes. Re-tier a PR
whose diff drifted into money, consent, auth or schema.

**Never.** Review its own vendor's generation on the same unit of work. Merge. Write code into
the Implementer's branch. Approve without per-lens clearance ("LGTM" is a contract violation).
Approve a head other than the one it read. Soften a hard-fail finding to report-only.

**Quality bar.** Every finding is reproducible from the PR alone. Every APPROVE names what was
checked. Escaped defects (found after merge) are counted against the Reviewer, not the
Implementer.

**Cadence and budget.** Per PR, triggered by the gate or the Dispatcher. Latency is the metric
that matters: a September review of this fleet's process (the-gibson#392) concluded that review
and merge latency, not coding parallelism, was the constraint; the brief now measures
time-in-review separately so that claim can be checked rather than repeated. Mid tier for
Tier A/B. Tier C: two reviewers from two different vendors, one of them top tier; a second
lens run by the same reviewer does not count as the second review. Escaped defects are counted from post-merge
fix PRs that reference the original.

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
  one at a time. Immediately before each merge it re-reads the head SHA and confirms the
  evidence names that SHA; a mismatch is a re-review, never a merge.
- Keeping PRs mergeable: when a serial merge leaves the next PR behind its base, the
  Dispatcher merges the base branch into it (a merge commit, never a rebase or force-push),
  and re-requests review of the new head. This is mechanical; without it, serial merges and
  the no-rebase rule deadlock each other.
- Opening a decision row for anything that fails twice, conflicts, or waits on a label only a
  human can set, and then leaving it alone.
- Posting a work event (not a heartbeat) at the end of every round, so the brief can tell
  working from alive.

**Inputs.** The queue (`dispatch-ready` items that do not also carry the repo's blocked label,
across watched repos, ordered by the owner's pinned list, then priority label P0 > P1 > P2,
then age), the live claims, the PR list with
check states, the merge train order. Where no priority label exists the item sorts last and
the brief says the repo has unprioritised work.

**Output.** Lanes started, PRs merged, decision rows filed, a round receipt per cycle with
counts: claimed, started, presented for review, merged, escalated.

**May.** Claim, start and stop lanes. Trigger reviews. Merge a PR only when all of the
following hold, each a mechanical check and none a judgment: every required check is green at
the current head; a structured review-evidence comment names that exact head SHA; that
comment carries a `cleared`-or-finding line for every lens the repo requires at the PR's tier
(a comment with a missing lens line is not evidence, whatever its verdict); its verdict line is
`VERDICT: APPROVE` (a `REQUEST_CHANGES`, a missing verdict, or a verdict for another SHA is not
evidence); the comment's author resolves to a different vendor from the PR's author, both read
as "Provenance has one reading" defines (trailer or registered lane-bot identity); and for
Tier C, two such comments from two different vendors, at least one of which declares
`tier: top` (a missing tier line is a missing field, and the comment is not evidence). Update a stale
branch from its base. Remove stale claims past their TTL. Alert the owner on the channel
configured for the brief when a VELOCITY.md threshold is crossed (once, then every 12 hours
while it holds).

**Never.** Write a spec, edit code, or pick between options. Merge on green CI alone where the
repo's rules require evidence. Retry the same failing item a third time. Hold a lock without a
PID and TTL. Approve another agent's permission prompt. Run two lanes in one checkout.

**Quality bar.** Deterministic: given the same queue and repo state it does the same thing. A
round receipt exists for every scheduled run. Zero items in `claimed` older than the TTL.

**Cadence.** Every few minutes while the queue is non-empty. One instance per machine. It
holds no merge authority until a one-command kill switch exists that halts the script and
revokes its merge credential, and the repo has a revert-first policy for bad merges.

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

Mission: answer what only a human can, fast enough that nothing waits on it for long. The one
role a model cannot hold. Accountable for answering the decision queue (ordered by tier
then age, in a time-boxed daily session), keeping a pinned priority list the Spec Writer and
Dispatcher read, and deciding tier-C *product* questions: whether a feature exists, who pays,
who consents, who may see what. The owner is not in the review loop on individual PRs, Tier C
included: in this fleet Tier C clears on two-vendor review plus the deterministic gates
(decision D-014), and an owner attestation on a PR is a bypass of review, not a form of it.
Tier C changes still need the owner's product decision *before* dispatch; that is what the
decision queue is for. The brief exists so this role costs minutes a day. A decision older than
fourteen days is a breach the brief names; the fix is a shorter queue, not a faster owner.

## Choosing who holds what

1. Start with the Dispatcher as a script and the Reviewer as a different vendor from your
   Implementer. Those two decisions prevent most of the failures above.
2. Put your most capable model on the Spec Writer, on a budget. It is the cheapest place to be
   wrong and the most expensive to skip.
3. Put your cheapest competent coder on the Implementer and let it run many lanes.
4. Measure with the brief for two weeks before adding any *further* role, gate or agent beyond
   these four. Process scales with measured throughput; a repo under about twenty merges a
   month needs thin gates, not more supervision. That is a rule about gates, not about intake:
   a slow repo still needs a Spec Writer, it does not need a fifth required check.

Related: [VELOCITY.md](VELOCITY.md) (the brief and the decision queue), [PLAYBOOK.md](../PLAYBOOK.md)
(the operating model), the Gibson's `docs/03-roles.md` and `playbooks/` (binding contracts and
dispatch prompts).
