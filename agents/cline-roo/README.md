# cline-roo — Cline / Roo Code watcher

`cline_roo_watcher.py` is a daemon, the same shape as
[`codex_watcher.py`](../codex/codex_watcher.py): neither Cline nor Roo
Code (a Cline fork) exposes a session API, so it watches their on-disk
task folders and reports `session_start` / `heartbeat` / `session_end` off
file mtimes. One process covers both, reported as separate platforms
(`cline`, `roo-code`), because they share the same on-disk layout.

**Paths below are per each project's own public docs as of 2026-10, not
verified against a live install** — neither extension is installed on the
machine this was built on. If nothing ever reports, check what your editor
actually uses and set `VSCODE_GLOBAL_STORAGE_DIRS`.

## What it watches

Each VS Code extension keeps its data under VS Code's `globalStorage`,
one task per subdirectory of `<globalStorage>/<extension-id>/tasks/`:

| Platform | Extension id | Confirmed by |
| --- | --- | --- |
| `cline` | `saoudrizwan.claude-dev` | [Cline's own troubleshooting docs](https://docs.cline.bot/troubleshooting/task-history-recovery) |
| `roo-code` | `rooveterinaryinc.roo-cline` | Roo Code's deepwiki ([state management](https://deepwiki.com/RooCodeInc/Roo-Code/2.3-state-management-and-storage), [task persistence](https://deepwiki.com/RooCodeInc/Roo-Code/5.3-task-persistence-and-history)) |

Default `globalStorage` roots scanned, one per editor that can host these
extensions (VS Code itself is confirmed; the forks are inferred, not
independently verified):

| OS | Root |
| --- | --- |
| macOS | `~/Library/Application Support/<editor>/User/globalStorage` |
| Linux | `~/.config/<editor>/User/globalStorage` |
| Windows | `%APPDATA%\<editor>\User\globalStorage` |

`<editor>` is one of `Code`, `Code - Insiders`, `Cursor`, `Windsurf`.

Cline's docs also mention a 4.x shared data directory, `~/.cline`, that
newer installs migrate to; the watcher also checks `~/.cline/tasks`
directly (override with `CLINE_SHARED_DIR`) as a best-effort second path,
since the exact migrated layout isn't confirmed here either.

If none of this matches your setup, set `VSCODE_GLOBAL_STORAGE_DIRS` to a
comma-separated list of the actual `globalStorage` directories your editor
uses, and the watcher scans those instead of the defaults.

## Install on this Mac

```bash
cd agents/cline-roo
./install.sh
```

The script prompts for `MC_URL` and `MC_TOKEN` unless they're already in
the environment or in `~/.mission-control/cline-roo.env` /
`~/.claude/mission-control.env`. It then:

1. Copies `cline_roo_watcher.py` to `~/.mission-control/cline_roo_watcher.py`
2. Writes `~/.mission-control/cline-roo.env` (mode `600`)
3. Writes `~/Library/LaunchAgents/com.missioncontrol.cline-roo.plist` (mode `600`)
4. Loads the agent with `launchctl` (`bootstrap`, falling back to `load`)

Re-running is safe. Logs: `~/Library/Logs/cline-roo.log`.

## Running it directly (any OS)

```bash
MC_URL=https://your-deploy.vercel.app MC_TOKEN=secret python3 cline_roo_watcher.py
```

Stdlib-only Python 3.9+. No `install.sh` equivalent is provided for
Linux/Windows; run it under systemd, Task Scheduler, or `nohup ... &`
yourself.

## Limitations

- Coarse, like the Codex watcher: activity is inferred from file mtimes,
  not from the extension's actual turn state.
- A task folder with no files inside it yet (just created) falls back to
  the folder's own mtime.
- Reports the editor host's hostname, not which editor (VS Code vs.
  Cursor vs. Windsurf) a given task came from — if you run more than one
  on the same machine, both are reported under the same `cline`/`roo-code`
  agent id.
