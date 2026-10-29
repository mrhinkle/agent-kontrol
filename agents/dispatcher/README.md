# Dispatcher — the harness daemon

One process per machine. It polls Agent Kontrol for queued tasks, runs them
headless on whichever agent CLIs the machine has (`claude`, `codex`, `grok`),
and reports results + cost back. Queue a task on the Tasks page (or via the
`create_task` MCP tool from any agent) and it gets picked up within
`MC_POLL_SECONDS`.

## Quick start

```bash
mkdir -p ~/.mission-control
MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret \
  nohup python3 mc_dispatcher.py >> ~/.mission-control/dispatcher.log 2>&1 &
```

It auto-detects which CLIs are installed. Override with
`MC_PLATFORMS=claude-code,codex`.

## Usage change: one linked worktree per task

Every task must name `project`, and `MC_WORKDIR/<project>` must be the top
folder of a linked git worktree (`git worktree add`). This is stricter than
before, on purpose, to keep the fleet rule of one working directory per agent:

- A task with no `project` used to run in `MC_WORKDIR` itself. It now fails.
- A task whose `project` is a main checkout (where `.git` is a folder) used to
  run in that checkout. It now fails. Create a worktree and point the task at it:

  ```bash
  git -C ~/Code/agent-kontrol worktree add ~/Code/wt/ak-84 -b lane/ak-84 origin/main
  # task.project = "wt/ak-84"
  ```

- `project` is a relative path below `MC_WORKDIR`: no leading `/`, no `.` or
  `..` part, no empty part, no backslash, and no symlink anywhere below
  `MC_WORKDIR`. It must also fit the skill lane rule, 1-100 characters of
  letters, digits, and `. _ : / -`, starting with a letter or digit, because
  `project` is the lane name the pointer lookup uses.

The dispatcher does not create, move, or delete worktrees. You make the
worktree, you merge or delete it.

## How a task runs

1. Claim: `POST /api/tasks/claim` — atomic, so two machines never grab the same task.
2. Prepare, before any CLI starts. Any failure here marks the task failed and
   launches nothing:
   - Resolve `project` as above and check it is a linked worktree top folder.
   - Lock the worktree: `flock` on `ak-dispatch.lock` in that worktree's own git
     dir (`.git/worktrees/<name>/`). The lock is held through the worker, the
     AGENTS.md cleanup, and the review. A second dispatched task on the same
     worktree, from this or another dispatcher process on the host, fails with
     "already running". Different worktrees run in parallel. The lock only
     coordinates dispatchers: it does not stop you or an interactive agent from
     editing the same folder, so reserve the worktree for the dispatcher while a
     task runs.
   - Fetch skill pointers: `GET /api/skills/pointers?lane=<project>&runtime=<r>`
     with the same bearer token, where `r` is `claude` for `claude-code`,
     `codex` for `codex`, `grok` for `grok`. Only `lane` and `runtime` are sent;
     no file content leaves the machine. The response is capped at 256 KB and
     the block at 64 KB, and is checked: `lane` and `runtime` must echo the
     request, `empty` must match `block`, a non-empty `block` must be exactly one
     `<!-- ak-skills:begin -->` … `<!-- ak-skills:end -->` block, and
     `demo: true` (a deployment with no database) is refused. An HTTP error,
     a timeout, or a bad response fails the task.
   - Write the block into the worktree's `AGENTS.md`, using the same marker rules
     as `applyPointerBlock` (`ak_pointers.py` is the stdlib port): append,
     replace in place, collapse duplicates, or remove when the block is empty;
     text outside the markers, CRLF line ends, and the file mode are kept. A
     missing file with an empty block stays missing. A symlinked, directory,
     special, non-UTF-8, or over-1 MB `AGENTS.md`, or one with an unpaired or
     nested marker, fails the task. The write goes to a temp file in the same
     folder and is swapped in with `os.replace`; the file is read again just
     before the swap and the swap is refused if it changed.
3. Run: headless CLI in the worktree. The prompt tells the worker the block is
   temporary dispatch metadata not to edit, stage, or commit.
   - `claude -p "<prompt>" --output-format json --permission-mode acceptEdits`
     (cost captured from `total_cost_usd`)
   - `codex exec --full-auto "<prompt>"`
   - `grok -p "<prompt>"`
4. Clean up, whatever the worker did (success, failure, timeout, crash): the
   injected block comes out and the managed region goes back to what it held
   before, byte for byte when the worker did not touch `AGENTS.md`. Worker edits
   elsewhere in the file and in other files stay. If the block or the text right
   next to it was edited, or the markers are now malformed, the file is left
   exactly as the worker left it and the task fails with the reason; remove the
   block by hand. The dispatcher then checks the git index and `HEAD`: if the
   block was staged or committed there, the task fails. It does not unstage or
   rewrite commits, and it does not inspect commits before `HEAD`, so a block
   committed and then removed again in a later commit is not caught.
5. Review (optional): if the task has `reviewer_platform`, the reviewer runs
   **read-only** with a skeptical-reviewer prompt and must end with
   `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`. The verdict is appended
   to the result; REQUEST_CHANGES marks the task failed so you triage it.
   Review runs only after a clean step 4. Known limit, unchanged here: a
   reviewer that exits non-zero does not fail the task (it fails open).
6. Report: `PATCH /api/tasks/<id>` with status, result summary, and cost.

## launchd (run at login on macOS)

Save as `~/Library/LaunchAgents/com.mission-control.dispatcher.plist`, then
`launchctl load` it:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mission-control.dispatcher</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>/Users/YOU/Code/agent-kontrol/agents/dispatcher/mc_dispatcher.py</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mc-dispatcher.log</string>
  <key>StandardErrorPath</key><string>/tmp/mc-dispatcher.log</string>
</dict></plist>
```

Put `MC_URL`/`MC_TOKEN` in `~/.claude/mission-control.env` (the dispatcher
reads it when it starts, same as the Claude Code hook) so secrets stay out of
the plist. Importing `mc_dispatcher` reads no file; only `main()` does.

## Safety model

- Workers only run in a linked worktree strictly below `MC_WORKDIR`, one
  dispatched task per worktree at a time (see above).
- Reviewers always run read-only.
- `MC_TASK_TIMEOUT` (default 1h) kills runaway runs. Only the CLI process is
  killed; a child it started that keeps writing after cleanup is not tracked.
- Autonomy flags are conservative defaults (`acceptEdits`, `--full-auto`
  sandboxed). Raise them per-machine via `MC_CLAUDE_ARGS` / `MC_CODEX_ARGS`
  only if you accept the blast radius.
- Anything requiring judgment or credentials beyond the repo should be an
  interactive Cowork/Claude session, not a dispatched task.

## Tests

`python3 -m unittest tests.unit.test_dispatcher_skills -v` (also part of
`npm run test:unit:py`). Real temp git worktrees, a fake API, a fake CLI.
