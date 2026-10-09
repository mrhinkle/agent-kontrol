# The Fleet Playbook

How to actually run a multi-platform agent harness — Claude (Code + Cowork),
Codex, Grok, and Hermes — for maximum output. Mission Control is the
infrastructure; this is the doctrine. Researched July 2026; sources at the
bottom.

## 1. The operating model

**Mission Control is the queen; the platforms are workers.** The most useful
idea in the swarm-orchestration world (ruvnet's claude-flow/Ruflo lineage) is
the hierarchical queen/worker topology: one coordinator that owns state and
routing, many specialist workers that execute [1][2]. You don't need Raft
consensus or 210 MCP tools for a one-person fleet — you need exactly what
this repo implements:

- **Deterministic telemetry** — hooks and watchers report ground truth
  (Ruflo's hooks system, rebuilt in ~140 lines of stdlib Python).
- **Shared memory** — one store all agents read/write (`remember`/`recall`),
  so agents coordinate through state, not chat.
- **A task queue with routing** — work goes to the right platform, gets
  claimed atomically, and comes back with a result and a cost.

Anthropic's own multi-agent research reached the same conclusion:
orchestrator-worker with parallel specialist subagents beats single-agent by
~90% on breadth tasks, at the price of more tokens [3].

## 2. Route by task class, not by loyalty

Community consensus + benchmarks, July 2026 [4][5]:

| Task class | Route to | Why |
| --- | --- | --- |
| Deep/large-codebase work, multi-step refactors | **claude-code** | Leads SWE-bench Pro (69.2% vs 58.6%); 1M context; best dependency-tracked agent teams |
| Terminal-heavy work, long autonomous runs, parallel fan-out | **codex** | Leads Terminal-Bench 2.0 (82.7% vs 69.4%); ~3-4x cheaper per task in tokens; 8 parallel cloud subagents |
| Research sweeps, X/social-adjacent work, second opinions | **grok** | Third quota pool (SuperGrok); grok-4.5; fast; ACP/MCP support in Grok Build |
| Messaging-first ops, triage, recurring jobs, "ping the owner" | **hermes** | Model-agnostic, fronts your messaging apps, built-in scheduler + skills |
| Anything needing judgment, taste, or your accounts | **cowork / interactive** | Don't dispatch what you'd want to watch |

Two habits that compound: **route the task to the cheapest platform that
clears the quality bar**, and **never let one platform's quota idle while
another's is throttled** — the queue's `platform: any` exists for exactly
that arbitrage [5].

## 3. Never let an agent grade its own homework

The single highest-leverage practice in 2026 multi-agent workflows is
cross-vendor review: one platform writes, a *different* platform reviews
read-only, loop until the verdict converges. Documented pipelines catch
issues single-vendor review misses (one write-review loop caught 14 issues
across 3 rounds) [6][7]. That's the `reviewer_platform` field on every task:
Claude writes → Codex reviews (`codex exec -s read-only`), or the reverse.
Make it the default for anything that ships.

## 4. What we took from ruvnet — and what we skipped

Reuven Cohen (ruvnet) is the most prolific builder in this space; claude-flow
was renamed Ruflo at v3.5 and sits at ~65k stars with near-daily releases
[1][8]. Verdict after digging in:

**Adopted (as concepts, in our own ~500 lines):** hooks-based telemetry;
SQLite/Postgres-first shared memory with stable keys; queen/worker topology;
agent role definitions; task-complexity-based model routing (his
agentic-flow's core idea) [9].

**Skipped, deliberately:** installing Ruflo itself (210 MCP tools of context
bloat, unstable surface, and orchestrators of its style were blocked on
Claude Pro/Max plans as of April 2026 — subscription-hostile) [2]; the
consensus protocols (solve problems a solo fleet doesn't have); flow-nexus
and the crypto-adjacent projects; and every unverified benchmark — the
famous "84.8% SWE-bench" number has no methodology, no dataset disclosure,
and was never submitted to the official leaderboard [10].

The meta-lesson from ruvnet worth keeping: ship the coordination layer as
boring infrastructure you own. Which is this repo.

## 5. Daily operating rhythm

1. **Morning:** Hermes cron digests the queue + fleet status to your phone.
   Queue the day's tasks in one sitting (batching beats drip-feeding).
2. **During the day:** dispatchers chew the queue. You watch the Fleet page,
   answer `NEEDS YOU` states, and message agents inline. Interactive
   sessions (Cowork, Claude Code) stay for judgment-heavy work — and they
   see the same memory and inbox.
3. **Review gates:** shipping tasks carry `reviewer_platform`. Failed
   reviews come back to the queue with the verdict attached; requeue with
   one click after triage.
4. **Memory discipline:** decisions and handoffs go in `remember` with
   stable keys (`project/status`); agents check `recall` before starting.
   This is what stops two platforms doing the same work twice.
5. **Weekly:** scan History for cost (events carry `cost_usd` from
   `claude -p`'s JSON output) and for tasks that failed twice — those are
   prompts that need better acceptance criteria, not better models.

## 6. Writing dispatchable tasks

A task the harness can actually finish has: a specific title, instructions
with acceptance criteria ("done looks like: build passes, page renders X"),
a project folder the machine has, and the right platform. Vague tasks
produce vague RESULT blocks — the model isn't the bottleneck, the ticket is.

## Sources

1. https://github.com/ruvnet/ruflo — claude-flow → Ruflo, architecture, hooks, hive-mind
2. https://claudefa.st/blog/tools/orchestrators/multi-agent-orchestrators — independent orchestrator comparison; Pro/Max policy note; benchmark skepticism
3. https://www.anthropic.com/engineering/built-multi-agent-research-system — orchestrator-worker pattern results
4. https://www.morphllm.com/comparisons/codex-vs-claude-code — SWE-bench Pro / Terminal-Bench 2.0 splits, subagent features
5. https://claude-world.com/articles/ai-coding-models-tools-july-2026/ — model/tier routing consensus
6. https://smartscope.blog/en/blog/claude-code-codex-review-loop-automation-2026/ — write/review loop automation
7. https://salmanalibanani.com/2026/07/04/a-two-agent-pr-workflow-claude-writes-codex-reviews/ — two-agent PR workflow
8. https://dev.to/stevengonsalvez/claude-flow-is-dead-long-live-ruflo-5coi — the rename, v3.5
9. https://github.com/ruvnet/agentic-flow — cost-aware model routing
10. https://github.com/ruvnet/ruflo/wiki/SWE-Bench-Evaluation — the missing methodology
11. https://github.com/NousResearch/hermes-agent — Hermes Agent (MCP, providers, scheduler)
12. https://x.ai/news/grok-build-cli — Grok Build CLI announcement
13. https://code.claude.com/docs/en/headless — claude -p headless reference

## Usage and Costs

Fleet usage ledger lives at `/usage`. Mac Mini collector: `agents/usage-collector/` → `POST /api/usage/ingest`. Spec: `docs/usage/README.md`.

