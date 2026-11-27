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

`mc_dispatcher.py` imports `ak_pointers.py` and `run_telemetry.py` from its own
folder. Deploy all three files together; the dispatcher does not start without
either of them.

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
     folder (exclusive create; the process umask is never changed) and is
     swapped in with `os.replace`; the file is read again just before the swap
     and the swap is refused if it changed. Known limit: POSIX has no
     compare-and-swap rename, so an edit that lands between that last read and
     the swap (or the unlink, when cleanup removes a file the dispatcher
     created) is overwritten. The same applies to cleanup. This is why the
     worktree must be reserved for the dispatcher while a task runs.
   The worktree's `HEAD` is read before the block is written, so nothing can
   fail between the write and the start of step 4's cleanup guard.
3. Run: headless CLI in the worktree, in a new session with stdin from
   `/dev/null`, so the CLI and everything it starts share one process group
   of their own. The prompt tells the worker the block is temporary dispatch
   metadata not to edit, stage, or commit. When the CLI exits (success or
   error), times out, or the wait is interrupted by an exception, that process
   group gets `SIGTERM`, then `SIGKILL` after 5 seconds, before cleanup runs
   and before the worktree lock is released. Background children the CLI left
   behind are stopped this way. If members are still there 5 seconds after
   `SIGKILL`, the task fails. A process that deliberately moves itself out of
   the group (`setsid`, `setpgid`, or a daemonizing double fork into a new
   session) is not tracked and is unsupported; this is process-group
   bookkeeping, not a sandbox.
   The CLI does not inherit the dispatcher's environment. See
   [Child environment](#child-environment).
   - `claude -p "<prompt>" --output-format json --permission-mode acceptEdits`
     (cost captured from `total_cost_usd`)
   - `codex exec --sandbox workspace-write --json "<prompt>"`
   - `grok -p "<prompt>" --output-format json`
4. Clean up, whatever the worker did (success, failure, timeout, crash), once
   its process group is stopped: the
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
   `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`, optionally followed by
   ` — <reason>`. The verdict is appended to the result. A configured reviewer
   is required, and the review fails closed: the task is done only if the
   reviewer is a known platform whose CLI is on `PATH`, exits 0, and its last
   non-blank line is exactly `VERDICT: APPROVE`, starting at column 0 and not
   inside an unclosed ```` ``` ```` or `~~~` code fence (no earlier line
   holding a conflicting verdict). REQUEST_CHANGES, an unknown platform, a missing CLI,
   a non-zero exit or timeout, or a missing or malformed final verdict marks
   the task failed with the reason. With no `reviewer_platform` the worker's
   own result decides. Review runs only after a successful worker and a clean
   step 4. Not addressed here: a reviewer of the same vendor as the worker is
   still accepted.
6. Report: `PATCH /api/tasks/<id>` with status, result summary, and cost.

Each worker and review invocation also sends one best-effort `run_complete`
event with `detail.schema: "mc.run.v2"`, after the CLI's process group is
stopped and before step 4's cleanup. It contains a new run UUID, role,
start/end timestamps, measured subprocess wall time, sanitized outcome/error
class, task ID, and available finalized per-model token counts. Reporting
failure cannot change the task result. Prompts, task titles, responses,
commands, paths, credentials, free-text errors, and costs are excluded from
this additional event.

`duration_ms` is run duration, including tools and waits; it is not model
inference latency. Claude and Grok per-model usage is preferred over their
aggregate usage, so subagent totals are counted once. Input tokens include
cache reads and writes; Codex input already includes its cache reads.
Unavailable counts stay absent, and Grok's incomplete-usage flag is retained.
Resume/continue arguments suppress token export and mark the usage scope
`session_cumulative`, because those totals cannot safely be assigned to this
invocation. Interactive sessions outside this dispatcher are not instrumented.

Codex worker runs use the supported `--sandbox workspace-write`; Codex review
runs use `-s read-only`. Correct any explicit per-machine override that still
contains the retired `--full-auto` flag during approved activation. This
source change does not install or enable telemetry on any machine.

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
- `MC_TASK_TIMEOUT` (default 1h) stops runaway runs. The CLI's whole process
  group is stopped on timeout and on every other exit, so its children cannot
  keep writing after cleanup or into the next task. Children that detach into
  their own session or group are not covered (see step 3).
- Autonomy flags are conservative defaults (`acceptEdits`, `--sandbox workspace-write`
  sandboxed). Raise them per-machine via `MC_CLAUDE_ARGS` / `MC_CODEX_ARGS`
  only if you accept the blast radius.
- Anything requiring judgment or credentials beyond the repo should be an
  interactive Cowork/Claude session, not a dispatched task.

## Child environment

Dispatcher-launched CLIs and direct-mode CLIs (`ak_skill_launch.py direct`)
start with an allowlisted environment, not a copy of the dispatcher's. A
child receives:

- base process names, when the dispatcher has them: `PATH`, `HOME`, `USER`,
  `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `TZ`, `SSH_AUTH_SOCK`,
  `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and the lower-case
  forms `http_proxy`, `https_proxy`, `no_proxy`, `all_proxy`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, and every name
  starting with `LC_` or `XDG_`
- non-secret Agent Kontrol settings: `MC_URL`, `MC_AGENT`, `MC_AGENT_NAME`,
  `MC_TRACES`, `MC_TRACE_CAPTURE_CONTENT`
- that CLI's own prefix: `ANTHROPIC_` and `CLAUDE_` for Claude (`claude` and
  `claude-code`), `OPENAI_` and `CODEX_` for Codex, `XAI_` and `GROK_` for
  Grok

`MC_TOKEN` and `MC_EVENT_TOKEN` are never passed. The same is true of
`MC_DASHBOARD_PASSWORD`, `MC_COOKIE_SECRET`, `MC_OAUTH_SECRET`,
`CRON_SECRET`, `MC_CHILD_ENV_ALLOW`, and any other `MC_` name.

`MC_CHILD_ENV_ALLOW` adds names. It is a comma-separated list read from the
dispatcher's environment; whitespace around an entry is ignored. An entry is
an exact name, or a prefix ending in one `*`. `FLEET_*` passes
`FLEET_DISPATCH_TOKEN` and does not pass `FLEET`. A bare `*` or a `*`
anywhere but the end is ignored. A name on the never-pass list is still
omitted when the allow list matches it. Per-machine argv overrides
(`MC_CLAUDE_ARGS`, `MC_CODEX_ARGS`, `MC_GROK_ARGS`) are read by the
dispatcher and are not passed through as environment variables.

`main_worker_exec` is deny-only. The worker under `fleet-dispatch.sh` has
the never-pass names removed and then execs; the wrapper's other variables
stay, including a dispatch token this repository does not know. Moving that
path onto the allowlist is later work. The fleet-mode controller is
unchanged: it is the operator's wrapper, not an agent, and it still receives
the dispatcher's environment.

The Claude Code hook still loads `~/.claude/mission-control.env` itself when
that file exists, so telemetry from a dispatched `claude` run keeps working
there. Where `MC_TOKEN` was supplied only through the dispatcher's
environment, hook telemetry from dispatched Claude runs stops. A child
running as the same OS user can still read `~/.claude/mission-control.env`
and `~/.mission-control/env` on disk.

## Secret broker (fail closed)

With the secret broker (`agents/broker/`) enabled, a dispatched CLI gets an
`akp_` placeholder and a loopback base URL for each granted service, not
that service's key. The broker swaps in the real key when the CLI calls
`http://127.0.0.1:<port>/<service>/...`.

Two settings, both read from the dispatcher's environment and never passed
to a CLI (they are `MC_` names):

- `MC_BROKER_SOCKET`: the absolute path of the broker's `admin_socket`. The
  broker refuses to start unless that socket's directory is a real directory
  owned by the broker's user with no group or other write bit (for example
  `~/.mission-control/broker`, mode `0700`), so never a shared directory such
  as `/tmp`.
  Surrounding whitespace is trimmed. Unset or blank turns the broker off,
  and a CLI gets `build_child_env` only, exactly as without a broker. A
  relative path is a configuration error and fails every task.
- `MC_BROKER_SERVICES`: comma-separated broker service names to grant to
  each task, in order. Entries are trimmed. An empty entry or a duplicate is
  a configuration error and fails every task. Ignored when the broker is
  off. Unset or blank with the broker on means no services: the dispatcher
  still checks `health`, mints nothing, and launches with no overlay.

Fail-closed rule. When `MC_BROKER_SOCKET` is set, any of these fails the
task with a result beginning `secret broker unavailable, no worker started`,
and no CLI starts: a missing socket, a refused connection, a 5-second
timeout, a failed `health`, `ok:false` from `mint`, a malformed or partial
grant (a missing service, an empty field, an extra or duplicate grant), or
a configuration error above. Nothing falls back to real keys.

Step order inside `run_task`:

1. worktree lock
2. broker `health`, then one `mint` for the task id `str(task["id"])`
3. pointer fetch and inject
4. running patch and ingest
5. worker
6. pointer cleanup
7. reviewer (same grants as the worker; no second mint)
8. result patch
9. `revoke_task`, exactly once whenever a mint request was sent, even when an
   earlier step raised or the mint response never arrived; then the lock is
   released

There are no retries. A failed revoke is logged to stderr by failure code
and changes neither the task outcome nor what runs; the placeholders still
expire at the broker's `placeholder_ttl_seconds`, and a broker restart
invalidates them all. Each grant sets its `env_key` to the placeholder and
its `env_base_url` to the loopback URL, overwriting any value already under
those names. Every API call, ingest payload, printed line, exception text
and task result has each placeholder and base URL replaced by
`[broker-redacted]` before it leaves the dispatcher; so does the worker
report embedded in the reviewer's prompt.

Scope. The broker replaces only the variables its grants name. A platform's
own CLI login keys, which pass by prefix (`ANTHROPIC_*` for Claude, and so
on), and names listed in `MC_CHILD_ENV_ALLOW` are passed as before, and the
dispatcher does not fail a task because they are present. Once a service is
brokered, remove its real key from `MC_CHILD_ENV_ALLOW` and from the
dispatcher's environment.

Direct mode (`ak_skill_launch.py direct`) and fleet mode do not use the
broker yet: they call `build_child_env` directly and never open the socket.

To turn the broker off on a host: wait until no task is running, unset
`MC_BROKER_SOCKET`, restart the dispatcher, then stop the broker.

## Dispatch-ready handoff

`dispatch_ready_bridge.py` is the inert issue-to-task handoff. It does nothing
unless the caller passes `enabled: true`. One call selects one ready issue from
an injected snapshot, checks the mapped project is an existing linked worktree,
and may POST one `/api/tasks` create. The idempotency key is stable per
authority and issue. A private journal is fsynced before that POST. The
configured `actor_id` is only a label in that journal. The transport does not
authenticate it, and the bridge never treats the label as a credential
principal.

The invocation that durably saved a new `posting` row may POST that body once.
No later invocation POSTs an existing `posting` row. A restart, a lost reply,
a transport or HTTP failure, a malformed body, a failed acknowledgment save, a
failed halt save, a different actor label, a backward clock, and any age
inside or past 23 hours all take the same path: do not POST. The old 23-hour
automatic replay is gone. A create that reached the server and then lost its
reply is not retried, so that issue stays stuck until an operator reconciles
it. That is the availability cost of refusing a duplicate when no
authenticated scope can be proved.

Recovery lists `GET /api/tasks?status=all` with an explicit page size. Two
complete reads that show the same single matching row can bind that task. The
bind is evidence of a matching task, not evidence of who created it. Zero
matches halt as `unreconciled`. Several matches halt as `ambiguous_task`.
Absence does not prove the request never arrived, and the halted issue is not
selected again. A demo page, a malformed or incomplete page, and two scans
that disagree stay deferred and are not posted. A demo create response halts
the row only when that halt is saved. If the halt save fails, a later call
that still sees `posting` does not POST. The module reads no credentials and
writes no GitHub labels.

This does not start the lane. `mc_dispatcher.py` is unchanged, so it still
claims whatever the existing loop claims and it has no bridge stop check.
One ledger on one host is the whole scope. Cross-host processes with separate
journals are not coordinated and can still create a second task. An issue
with no P0, P1, or P2 label sorts last and is not enqueued: create priority
is 1 through 3, and 3 is already P2.

```bash
python3 -m unittest tests.unit.test_dispatch_ready_bridge -v
```

## Tests

`python3 -m unittest tests.unit.test_dispatcher_skills -v` (also part of
`npm run test:unit:py`). Real temp git worktrees, a fake API, a fake CLI.
`python3 -m unittest tests.unit.test_broker_dispatcher -v` covers the broker
admin socket and the dispatcher's broker path.
