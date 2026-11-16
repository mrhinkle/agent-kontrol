---
name: context-handoff
key: master.context-handoff
description: >
  Wrap up a long session before starting a fresh chat to shrink the context window — without losing
  in-flight work. Use when the user says "shrink the context window," "start a new chat," "let's do a
  handoff," "can I just archive this," "wrap this up," "new session," or asks whether it's safe to
  close/archive the current conversation. Inventories uncommitted, unpushed and in-flight work,
  finishes what the session is already authorized to finish, writes a structured handoff (to project
  memory where the user keeps one) so the next session picks up the thread, and tells the user plainly
  when it's actually safe to start fresh — distinct from just archiving blind.
category: Meta
owner: mark-hinkle
version: 1.1.1
last_updated: 2026-11-02
metadata: {"hermes": {"tags": ["context-window", "handoff", "session", "memory", "cowork"]}}
tags: [recovery, claude-cowork]
---

# Context Handoff

A long session accumulates state a fresh chat can't see: uncommitted edits, open PRs missing a final
push, worktrees with real unreviewed work, decisions made in chat but never written anywhere durable.
"Just archive it" loses all of that. This skill is the checklist that turns "shrink the context
window" into an actual safe handoff — cheap to run (minutes, not a new project), and it should be run
*before* the user starts the next chat, not after.

## When NOT to use this

- The session did read-only work (research, review, answering questions) with nothing written to disk
  or committed anywhere — there's nothing to hand off; a plain summary in chat is enough.
- The user is mid-task and just wants a shorter answer — that's normal conciseness, not a handoff.

## Procedure

### 1. Find everything touched this session

Don't rely on memory of what you did — check the actual filesystem/git state, the same way you'd
verify before ending a shift:

```bash
# Every git worktree/repo you touched this session, not just the last one
git worktree list   # per repo, if worktrees were used
git status --short   # per repo/worktree — uncommitted edits?
gh pr list --author @me --state open   # PRs you opened that might still need a final push/attestation
