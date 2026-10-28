# Memory (Notes)

Agent Kontrol has a small shared notes store. This page says exactly what it does today, what it does not do, and where it is meant to go. If you expected something like long-term memory for your agents, read "What it is not" first.

## What it is today

- One Postgres table, `memory`: an optional unique `key`, `content`, a `tags` list, the writing `agent_id`, and timestamps. It lives in the same database as everything else.
- Two MCP tools. `remember` writes a note; writing the same `key` again overwrites it, which suits living notes such as `project-x/status`. `recall` finds notes by exact key, by tag, or by a case-insensitive substring of the content, newest first, up to 100.
- A **Memory** page in the dashboard that lists the same notes.
- No configuration. There are no settings and no environment variables for it.

Details of the two tools are in [MCP tools](MCP.md).

## Automatic session notes

When a session ends, Agent Kontrol writes one short note to memory on its own. This happens on the server, so it covers every platform: the Claude Code hook, the file watchers, `mc-agent`, and any agent that calls `report_status` with status `done` or `failed`.

The note has the key `session/<session id>` and the tags `session-summary`, the platform and the project. By default it holds **structured facts only**: who worked, on what, for how long, whether it finished or failed, the event and error counts, which tools ran and how many failed (when the agent sends traces), and how many milestones the agent reported. For example:

```
Session summary (automatic): Claude Code (mbp) [claude-code] on api-server.
Outcome: done. Ran 72m 0s. Ended 2026-10-09T13:12:00.000Z.
Events: 31, errors: 2.
Tools: Bash×12 (2 failed), Read×9, Edit×4.
Milestones reported: 2.
```

An agent can find these with `recall` using the tag `session-summary` plus the project name.

- **Free text is opt-in.** Every agent that can `recall` can read every note, and titles and summaries are text an agent or adapter wrote freely, which can contain anything. Set `MC_MEMORY_WRITEBACK_TEXT=1` to also include the last few reported milestones and the last summary. They are passed through a filter that masks obvious credentials, which is best effort, not a guarantee. Text that came from a prompt is left out even then; add `MC_MEMORY_WRITEBACK_PROMPTS=1` to include it.
- **Built from facts, not a transcript.** No model is called. The note is only as informative as what the adapter and the agent reported. An agent that calls `remember` itself writes a better handoff.
- **Thin sessions are skipped.** A session under two minutes with no tool calls and nothing reported leaves no note.
- **One note per session.** Ending a session twice updates the same note, and a slower, older update can never replace a newer one.
- **Yours are safe.** The server marks the notes it writes. If an agent writes a note with the same key using `remember`, the agent's note wins and the server leaves it alone. Cleanup only ever deletes the server's own notes, even if an agent used the same tag.
- **Cleanup.** Automatic notes older than `MC_MEMORY_WRITEBACK_DAYS` (default 30) are deleted a few at a time as new ones are written.
- **Cost on ingest.** The note is written while the session-end request is handled, with a two-second cap on how long that request waits, and it never fails the request. On a platform that freezes the function after it responds, a slow write can be cut short, and the next session end retries it.
- **Off switch.** Set `MC_MEMORY_WRITEBACK=0` to stop writing them.

## How to use it well

An agent only writes a note if it is told to. Put a standing instruction where your agents will read it, for example:

> Before starting work, call `recall` with the project's tag. When you make a decision, hit a gotcha, or hand work off, call `remember` with a short note, a stable `key` where it is a living status, and the project as a tag.

Good notes are decisions, handoffs, and "do not redo this" warnings. Poor notes are transcripts and anything an agent could re-derive from the code.

## What it is not

- **Mostly not automatic.** Apart from the session notes above, nothing writes notes. A decision or handoff is only recorded if an agent calls `remember`.
- **Not injected.** Nothing places notes into an agent's context at the start of a session. The agent has to call `recall`.
- **Not semantic.** Search is substring matching. A query for "auth" will not find a note that says "login".
- **No lifecycle.** Notes do not expire, merge or get summarized. Delete stale ones from the database.
- **Not a replacement for a knowledge base.** If you already run one, keep using it. This store is for the coordination notes that belong with the fleet's status.

## Where it is meant to go (proposal, not built)

The notes table works for coordination but is the weakest part of the product. The proposed direction for 1.1, not yet decided or built:

1. A single memory interface, `remember`, `recall` and `forget`, with the MCP tools unchanged, so the backend can change without touching agents.
2. **Postgres stays the default backend**, because it needs no setup and works on every deployment target.
3. Optional backends chosen by configuration, for example a **Git repository** of Markdown files (notes are reviewed, versioned and editable by people, which suits durable decisions and house rules, but it is slower and a poor fit for high-volume scratch notes) and an adapter for an external memory service such as Cortex.
4. Richer automatic notes, for example a model-written summary of the session (not built; it would add a model call and a cost).

Open questions: whether a backend is chosen globally or per tag, who may write to a Git-backed store (a token that can write to a repository is a real credential), and how conflicts are handled when two agents write the same key.
