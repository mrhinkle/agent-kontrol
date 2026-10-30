# Agent Kontrol and the Gibson

Two pieces of software in this fleet, one job each. Agent Kontrol **manages** the work. The Gibson **enforces** the rules on it.

| | Agent Kontrol | The Gibson |
| --- | --- | --- |
| Role | The development manager | The law |
| Question it answers | What is happening, what is stuck, who should do what next, what is waiting on the owner? | May this change merge, ship or be claimed? |
| Nature | A running service with a database and a dashboard. Its instance is the source of truth for fleet state. | A harness of deterministic gates, playbooks and contracts that live in each repository. |
| Output | Fleet view, task queue, progress board, morning brief, owner decision queue | Pass or fail on a gate: claim, review, CI, merge, promote |
| Judgment | Surfaces facts and routes work. It does not approve a merge. | None. A gate is a check that returns the same answer for the same input. |
| Repository | `mrhinkle/agent-kontrol` (this one) | `The-AIE/the-gibson` |

## How they fit

```
                Agent Kontrol (manager)                         The Gibson (law)
        ┌──────────────────────────────────┐          ┌─────────────────────────────┐
        │ sees every agent, repo and PR    │          │ claim gate                  │
        │ queues and dispatches tasks      │ ──work─> │ cross-vendor review gate    │
        │ tracks net backlog and lead time │          │ CI and merge gates          │
        │ pushes the morning brief         │ <─state─ │ playbooks per role          │
        │ holds the owner decision queue   │          │ owner-attestation rules     │
        └──────────────────────────────────┘          └─────────────────────────────┘
```

- **Agent Kontrol routes; the Gibson refuses.** Agent Kontrol can assign a task to any runtime. Whether that runtime's pull request may merge is the Gibson's call, made by the gates in the target repository.
- **Agent Kontrol reads gate outcomes; it never overrides them.** A stuck pull request in the brief names the check or conflict the Gibson's gates are holding it on. Agent Kontrol does not bypass, waive or re-run a gate to make a number look better.
- **Roles are defined once.** [ROLES.md](ROLES.md) gives each role's job description; each card names the Gibson playbook that maps to it. The binding rules live in the target repository's `AGENTS.md`. Where the Gibson is adopted, its role contracts apply there, and if ROLES.md and the Gibson disagree, the Gibson wins.
- **Owner decisions flow through Agent Kontrol, authority stays with the owner.** The decision queue lists what waits on a person, oldest first. Answering it (a label, an MCP call, a comment) is how the owner releases a gate where the target repository has one, for example under the Gibson; Agent Kontrol records the answer and does not make it.
- **Liveness is a work event.** Agent Kontrol marks a coordinator working only when it has recorded a work event (a merge, a review, a dispatched task) inside the configured silence window, never because it sent a heartbeat. See [VELOCITY.md](VELOCITY.md).

## What goes where

| If you are changing... | It belongs in |
| --- | --- |
| How agents are shown, queued, dispatched or reported on | Agent Kontrol |
| The brief, thresholds, stuck-PR and decision-queue logic | Agent Kontrol |
| Who may review whose work, what a claim requires, what a merge needs | The Gibson |
| A role's binding contract or playbook | The Gibson (describe it here only in [ROLES.md](ROLES.md), non-normatively) |

## Not the same thing: the Gibson page

The dashboard's **Gibson** page (`/gibson`, the 3D view of towers, docks and streams) is a visualization inside Agent Kontrol. It renders fleet state read from Agent Kontrol's own API. It is named for the Gibson but contains no gates and enforces nothing.

## Using Agent Kontrol without the Gibson

Agent Kontrol stands alone: the fleet view, queue, progress board and brief work on any set of repositories. Without the Gibson you get visibility and routing, and the merge rules are whatever your own branch protection and review habits provide. The Gibson is what makes those rules mechanical.
