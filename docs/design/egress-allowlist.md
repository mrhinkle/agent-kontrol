# Per-lane egress allowlist: spike results (#191)

Status: spike finding, no code. Host tested: `fleet-lanes-1` (Linux) only, by owner decision of 2026-11-27. macOS was not tested.
Scope: `mc_dispatcher.run_cli` worker invocations. Direct mode in `agents/dispatcher/ak_skill_launch.py` is out of scope (C6): it is an operator-run path, not a dispatcher lane.

## One-page summary

**Question.** What can enforce a per-lane domain allowlist for `claude`, `codex` and `grok` as `run_cli` launches them, so that a lane cannot send what it can read to an arbitrary host?

**What was run.** On `fleet-lanes-1` (Ubuntu 26.04.1, kernel 7.0.0-44), as a throwaway lane user `akegress191` (UID 1003, non-root, fresh home): each CLI in the dispatcher's worker argv form, a `curl` child launched by the CLI itself, and the AC3 bypass command launched by the same child, under three mechanisms. A fourth, supplementary configuration (OS rule that only lets the lane UID reach the proxy) was run because it is the only design that blocked the bypass while keeping the CLI working. Every rule matched only UID 1003; nothing touched the `fleet` user, its lanes or sshd.

**Results (Linux).**

- **CLI-native settings do not enforce an allowlist.** Claude Code's `sandbox.enabled` disabled itself on this host (no `bwrap`, no `socat`) and printed "Commands will run WITHOUT sandboxing": it failed open. It never governs hooks or the CLI's own API traffic. Codex `--sandbox workspace-write` does not govern MCP-server children; one reached `example.com`. Its own sandboxed shell path (`codex sandbox`) could not start on this host (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`). Grok `GROK_SANDBOX=workspace` refused to start without `bwrap`: it failed closed, so its network policy could not be observed.
- **An `HTTPS_PROXY` CONNECT proxy alone is advisory.** The CLIs and inheriting children used it, and `example.com` got `blocked-by-proxy` (403, no upstream). The AC3 bypass reached `example.com` (HTTP 200) for every CLI where a child could be launched: `unexpectedly allowed`. Codex does not pass `HTTPS_PROXY` to MCP servers, so even an ordinary MCP child went direct.
- **An nftables owner-match rule (`meta skuid 1003`) on its own** blocked the child and the bypass (timeouts, drop counters) for `claude` and `codex`, and covered IPv4 and IPv6. Descendant coverage was tested only for the recorded child and bypass chains under the lane UID (CLI, then `sh`/MCP server, then `curl`). UID-changing processes and arbitrary other descendants were not tested. But its matching model is IP-based. The DNS alias `www.github.com`, the IP literal and **domain fronting** were all allowed: `curl --connect-to example.com:443:<api.openai.com IP>:443 https://example.com/` returned HTTP 200 from `example.com`, because both sites share Cloudflare addresses.
- **nftables lock-to-proxy plus the allowlisting proxy (supplementary)** blocked the child (`blocked-by-proxy`) and the bypass (`blocked`) for claude and codex. It blocked subdomain, alias, redirect, port, IP-literal and plain-HTTP. Its limits: domain fronting through an allowed CONNECT tunnel still reached `example.com` (HTTP 200), because the proxy does not check TLS SNI; DNS is not governed (queries for arbitrary names leave the host through `systemd-resolved`, under its own UID); proxy client-side IPv6 was not tested; grok child and bypass, codex shell-tool children, review mode, UID-changing processes, arbitrary descendants, loopback listeners other than the proxy, proxy-down, DNS-down and empty-allowlist behavior were not tested.
- `grok` child and bypass rows are `not tested`. Without credentials Grok stops at its auth check (HTTP 400 from `api.x.ai`) before it starts hooks or MCP servers (HTTP 400 seen only in the unrestricted debug record R-grok-debug), and no disposable credential was supplied (C13).

**Recommendation.**
- **Linux: `not feasible/unknown` today.** The best candidate is to lock the lane UID to the proxy with nftables and have the proxy check the CONNECT host, the TLS SNI and the DNS path. The missing evidence is SNI/domain-fronting, DNS channel, credentialed grok and codex shell-tool child rows, and review-mode rows. Drafted follow-up: Appendix I.
- **macOS: `not feasible/unknown`.** Nothing was tested on macOS, by owner decision. No per-user `pf` mechanism has been shown to distinguish the lane user (D3). Drafted follow-up: Appendix I.

**Cleanup.** The user, its home directory, the temporary folder, the nft table and the proxy processes were all removed. Against the 19:03Z before-resume snapshot, the firewall, proxy, route, DNS, module and CLI-settings sections of the after snapshot are identical (`diff -u` empty), and the account files are byte-identical to the original 06:13Z pre-spike hashes. Against the original 06:13Z snapshot, the CLI-settings section is **not** identical: `fleet`'s `~/.codex/config.toml` hash changed (`95ba52f1…` to `b9e4eb77…`). That change is not from the spike and is covered by the named C16 exception X1 in Appendix E.

## Appendix A. Definitions, host and conventions

**Vocabulary (C8/D5).**
- `allowed`: DNS, TCP and TLS completed and an HTTP response arrived from the target. Non-2xx is recorded as itself.
- `blocked`: refused or timed out before reaching the target.
- `blocked-by-proxy`: the proxy answered with its own status (403, header `X-AK-Proxy: deny`), and the proxy log shows `upstream: null`, so no upstream connection was made.
- `unexpectedly allowed`: any HTTP response from `example.com`. This fails the cell.
- `not tested`: no conclusion. The entry carries the setup that would have run and the reason it could not.

**Host.**
- `fleet-lanes-1`, Ubuntu 26.04.1 LTS, kernel `7.0.0-44-generic`, x86_64.
- `iptables v1.8.11 (nf_tables)`, `nftables v1.1.6`, `curl 8.18.0`, `Python 3.14.4`, `strace` (distribution package).
- `/proc` is mounted `hidepid=invisible`. `kernel.yama.ptrace_scope=1`. `kernel.apparmor_restrict_unprivileged_userns=1`.
- `bwrap` and `socat` are not installed. Installing them would be a system-wide package change, which was out of bounds.
- Network: eth0 has IPv4 `5.161.195.242/32` and IPv6 `2a01:4ff:f0:bedf::1/64`; tailscale0 is up. The resolver is the `systemd-resolved` stub at `127.0.0.53`, with upstreams `2a01:4ff:ff00::add:{1,2}` and `185.12.64.{1,2}`.
- Existing firewall: ufw over iptables-nft (tables `ip filter`, `ip6 filter`, `ip nat`, `ip6 nat`). `OUTPUT` policy is ACCEPT. No `OUTPUT` NAT rules.

**CLIs.** `claude 2.1.331 (Claude Code)`, `codex-cli 0.154.0`, `grok 1.0.77 (50ca579fa996)`. The program files were copied from the `fleet` user's install into the lane user's home: `/home/fleet` is mode 0700, so the lane user cannot run them in place. No login, auth file or config was copied.

**Lane user.** `akegress191`, UID/GID 1003, shell `/bin/bash`, not in `sudo`. `sudo -n true` as this user answered "I'm sorry akegress191. I'm afraid I can't do that". Every test ran as UID 1003 and not as root. Only the rule loads and the proxy's `ss` PID lookup used `sudo -n`, as `fleet`.

**Isolation (C14).** Every cell used a fresh `HOME=/home/akegress191/cells/<cli>-<mech>-<tag>` and a fresh CLI config directory under it. `~/.claude/mission-control.env` and `~/.mission-control/env` are absent for `fleet` both before and after the spike. The lane HOMEs never had them, so neither file was read or altered.

**Credentials (C13).** Class: none. No disposable credential was supplied. Each cell injected an obvious placeholder string through the environment: `ANTHROPIC_API_KEY`, `CODEX_API_KEY`/`OPENAI_API_KEY` or `XAI_API_KEY`, each set to a `...PLACEHOLDER-not-a-key` value. The providers answered with auth errors: Anthropic "Invalid API key", OpenAI `401 Unauthorized`, and xAI `400` "Incorrect API key provided". These are recorded as themselves. No `fleet` credential was copied or used.

**Prompt (D6).** Template `P1` is a one-sentence instruction asking for a one-word reply. SHA-256 of the exact bytes (no trailing newline): `ef7e7ff96d04cdcdb9a405d5319bdc1b52adabc168eea9179dfc1352aad79231`. Replay: substitute the P1 text for `<P1>` and check its hash. Mode: worker. Review mode (`--permission-mode default`, `-s read-only`, no extra args for grok) was not run, to keep spend down; every review-mode cell is `not tested`.

**Effective argv (C6).** `MC_CLAUDE_ARGS`, `MC_CODEX_ARGS` and `MC_GROK_ARGS` were unset, so `run_cli` uses its defaults:
- `claude -p <P1> --output-format json --permission-mode acceptEdits`
- `codex exec --sandbox workspace-write --json <P1>`
- `grok -p <P1> --output-format json`

Each ran under `env -i <listed names> timeout <T> strace -f -qq -e trace=connect -e signal=none -o <cell>/strace.txt <argv> </dev/null`, with the working directory set to a fresh `git init` directory `<cell>/work`. Environment names, values omitted: `PATH HOME USER LOGNAME SHELL TERM LANG AK_CHILD_LOG <placeholder key>`, plus `HTTPS_PROXY https_proxy HTTP_PROXY http_proxy` (all `http://127.0.0.1:47191`) for proxy and combo cells, plus `GROK_SANDBOX=workspace` for the grok native cell. `T` was 150 s, or 60 s for steered runs.

**How the child was launched (C9/D4).** The child is launched by the tested CLI, not by a model tool call, because there was no credential to obtain a model turn.
- Claude: a `SessionStart` hook in `<HOME>/.claude/settings.json`, so the chain is claude, then `sh`, then `child.sh`.
- Codex: a stdio MCP server `[mcp_servers.akprobe] command = "/tmp/akegress191-spike/child.sh"` in `<HOME>/.codex/config.toml`, so the chain is `codex`, then `child.sh`.
- Grok: `grok mcp add akprobe /tmp/akegress191-spike/child.sh` and a Claude-format `SessionStart` hook were both tried. Grok checks credentials before it starts either, so no child ran (record R-grok-hook).

`child.sh` logs its ancestry chain with PIDs. It then runs `curl https://github.com:443/`, `curl https://example.com:443/` and the AC3 bypass, all with `-m 10` (source in Appendix F). Each child record carries the parent CLI PID and the child PID from that chain, the proxy log line naming the client process and PID, and the strace `connect()` lines.

**Evidence that the CLI made the connection (C6).**
- Proxy cells: the proxy looks up each client socket with `sudo -n ss -tnpH` and logs `proc` (for example `(("claude",pid=49511,fd=8))`).
- OS and native cells: `strace -f` `connect()` lines attributed to the CLI PID, plus nft rule counters.

## Appendix B. Results matrix (54 rows)

Columns: ID | target (method, URL, port) | expected | mode / prompt | mechanism and setting | result | evidence (record IDs in Appendix C).

Target assignment (D2 residual): `cli` rows target the CLI's own provider request. The path is the CLI's choice. Claude's path is not observable through the TLS tunnel. Codex names `POST https://api.openai.com:443/v1/responses` (plus `wss://` on the same path) in its error. Grok's debug log names `GET https://api.x.ai:443/v1/models`. The D2 default URL `GET https://api.openai.com:443/v1/models` was also requested by `curl` in D-ipv4-allow. `child` rows target `GET https://example.com:443/` (expected blocked), with `GET https://github.com:443/` as the allowed control in the same record. `bypass` rows target `GET https://example.com:443/` through the AC3 command (expected blocked).

macOS reason, used in every macOS row: "owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27)". The setup that would have run: macOS `pf` anchor plus a per-user mechanism (D3), the allowlisting proxy, and the native settings, mirroring the Linux cells.

| ID | Target | Expected | Mode / prompt | Mechanism and setting | Result | Evidence |
|---|---|---|---|---|---|---|
| M-macos-claude-native-cli | host api.anthropic.com:443 | allowed | worker / P1 | ~/.claude/settings.json sandbox | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-native-child | GET https://example.com:443/ | blocked | worker / P1 | ~/.claude/settings.json sandbox | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-native-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | ~/.claude/settings.json sandbox | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-proxy-cli | host api.anthropic.com:443 | allowed | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-proxy-child | GET https://example.com:443/ | blocked-by-proxy | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-proxy-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-os-cli | host api.anthropic.com:443 | allowed | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-os-child | GET https://example.com:443/ | blocked | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-claude-os-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-native-cli | POST https://api.openai.com:443/v1/responses | allowed | worker / P1 | --sandbox workspace-write | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-native-child | GET https://example.com:443/ | blocked | worker / P1 | --sandbox workspace-write | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-native-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | --sandbox workspace-write | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-proxy-cli | POST https://api.openai.com:443/v1/responses | allowed | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-proxy-child | GET https://example.com:443/ | blocked-by-proxy | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-proxy-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-os-cli | POST https://api.openai.com:443/v1/responses | allowed | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-os-child | GET https://example.com:443/ | blocked | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-codex-os-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-native-cli | GET https://api.x.ai:443/v1/models | allowed | worker / P1 | --sandbox / GROK_SANDBOX profile | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-native-child | GET https://example.com:443/ | blocked | worker / P1 | --sandbox / GROK_SANDBOX profile | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-native-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | --sandbox / GROK_SANDBOX profile | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-proxy-cli | GET https://api.x.ai:443/v1/models | allowed | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-proxy-child | GET https://example.com:443/ | blocked-by-proxy | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-proxy-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | HTTPS_PROXY CONNECT proxy | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-os-cli | GET https://api.x.ai:443/v1/models | allowed | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-os-child | GET https://example.com:443/ | blocked | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-macos-grok-os-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | pf anchor + per-user mechanism | not tested | owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27) |
| M-linux-claude-native-cli | host api.anthropic.com:443 (path not observable) | allowed | worker / P1 | `<HOME>/.claude/settings.json` `"sandbox":{"enabled":true}` + `permissions.allow` `WebFetch(domain:api.anthropic.com)`, `WebFetch(domain:github.com)` | allowed (API answered "Invalid API key"; HTTP status not captured); the sandbox disabled itself: "Sandbox disabled: … bubblewrap (bwrap) not installed, socat not installed … Commands will run WITHOUT sandboxing" (fail open). The setting never governs the CLI's own API traffic. | R-claude-native |
| M-linux-claude-native-child | GET https://example.com:443/ | blocked | worker / P1 | same; the sandbox governs Bash-tool descendants only, never hooks | unexpectedly allowed (HTTP 200 from 2606:4700:10::ac42:93f3); github.com 200 | R-claude-native |
| M-linux-claude-native-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | unexpectedly allowed (HTTP 200) | R-claude-native |
| M-linux-claude-proxy-cli | host api.anthropic.com:443 via proxy 127.0.0.1:47191 | allowed | worker / P1 | akproxy, allowlist {api.anthropic.com, github.com} | allowed ("Invalid API key"; HTTP status not captured); proxy `allow api.anthropic.com:443 proc claude pid=49511 upstream 2607:6bc0::10`. The proxy also denied the CLI's own `downloads.claude.ai` and `http-intake.logs.us5.datadoghq.com`. | R-claude-proxy |
| M-linux-claude-proxy-child | GET https://example.com:443/ | blocked-by-proxy | worker / P1 | same; child inherits HTTPS_PROXY (`proxy_env=set`) | blocked-by-proxy: `curl: (7) CONNECT tunnel failed, response 403`; proxy `deny example.com:443 proc curl pid=49599 upstream null`; github.com 200 via proxy | R-claude-proxy |
| M-linux-claude-proxy-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | unexpectedly allowed (HTTP 200 direct from 2606:4700:10::ac42:93f3; no proxy log line) | R-claude-proxy |
| M-linux-claude-os-cli | host api.anthropic.com:443 (160.79.104.10, 2607:6bc0::10) | allowed | worker / P1 | nftables `table inet akegress191`, `meta skuid 1003`, allow sets = resolved IPs of api.anthropic.com and github.com, tcp/443 | allowed ("Invalid API key"; HTTP status not captured); strace: claude pid 65449 `connect 2607:6bc0::10:443`. CLI telemetry hosts 35.190.46.17 and 2600:1901:0:b25e:: were dropped. | R-claude-os |
| M-linux-claude-os-child | GET https://example.com:443/ | blocked | worker / P1 | same | blocked: `curl: (28) Connection timed out after 10001 milliseconds`; github.com 200 | R-claude-os |
| M-linux-claude-os-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | blocked: `curl: (28) Connection timed out after 10002 milliseconds` | R-claude-os |
| M-linux-codex-native-cli | POST https://api.openai.com:443/v1/responses | allowed | worker / P1 | argv `--sandbox workspace-write` (default `sandbox_workspace_write.network_access` unset) | allowed (`401 Unauthorized … url: https://api.openai.com/v1/responses`); the sandbox does not govern codex's own traffic | R-codex-native |
| M-linux-codex-native-child | GET https://example.com:443/ | blocked | worker / P1 | same; governs shell-tool descendants, not MCP-server descendants | unexpectedly allowed (MCP child: HTTP 200 from 2606:4700:10::6814:179a). Sandboxed-shell substitute `codex sandbox -c sandbox_mode="workspace-write" -- curl …` could not start (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, exit 1); no conclusion about its network policy. | R-codex-native, R-codex-sandbox |
| M-linux-codex-native-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | unexpectedly allowed (MCP child: HTTP 200) | R-codex-native |
| M-linux-codex-proxy-cli | POST https://api.openai.com:443/v1/responses via proxy | allowed | worker / P1 | akproxy, allowlist {api.openai.com, github.com} | allowed (401); proxy 13× `allow api.openai.com:443 proc codex`; `deny chatgpt.com:443 proc codex`; codex's `git-remote-http` descendant used the proxy (`allow github.com:443`) | R-codex-proxy |
| M-linux-codex-proxy-child | GET https://example.com:443/ | blocked-by-proxy | worker / P1 | same | unexpectedly allowed: codex starts MCP servers without HTTPS_PROXY (`proxy_env=unset`), so the child went direct: HTTP 200 from 2606:4700:10::6814:179a | R-codex-proxy |
| M-linux-codex-proxy-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | unexpectedly allowed (HTTP 200) | R-codex-proxy |
| M-linux-codex-os-cli | POST https://api.openai.com:443/v1/responses | allowed | worker / P1 | nftables as claude row, allow sets = api.openai.com and github.com IPs | allowed (401); counters `ak-allow4` 772 pkts, `ak-allow6` 163 pkts | R-codex-os |
| M-linux-codex-os-child | GET https://example.com:443/ | blocked | worker / P1 | same | blocked: `curl: (28) … after 10001 milliseconds`; github.com 200; `ak-drop` 70 pkts | R-codex-os |
| M-linux-codex-os-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | blocked: `curl: (28) … after 10004 milliseconds` | R-codex-os |
| M-linux-grok-native-cli | GET https://api.x.ai:443/v1/models | allowed | worker / P1 | env `GROK_SANDBOX=workspace` (built-in profile) | not tested: grok refused to start ("this sandbox could not enforce its deny list on Linux: bwrap exec failed … Refusing to start"), so no request was made and the profile's network policy could not be observed. It would need `bubblewrap` installed system-wide, which was out of bounds. Observed fail closed. | R-grok-native |
| M-linux-grok-native-child | GET https://example.com:443/ | blocked | worker / P1 | same | not tested: CLI refused to start; and without a credential grok launches no hook or MCP child (C13) | R-grok-native, R-grok-hook |
| M-linux-grok-native-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | not tested: as the child row | R-grok-native |
| M-linux-grok-proxy-cli | GET https://api.x.ai:443/v1/models via proxy | allowed | worker / P1 | akproxy, allowlist {api.x.ai, github.com} | allowed (auth error "Not signed in"; HTTP status not captured in this cell); proxy `allow api.x.ai:443 proc grok pid=64590 upstream 2606:4700::6812:1350`. The HTTP status cannot be seen through the tunnel. The same request returned `400` in the unrestricted debug record R-grok-debug. | R-grok-proxy |
| M-linux-grok-proxy-child | GET https://example.com:443/ | blocked-by-proxy | worker / P1 | same | not tested: `grok mcp add akprobe <child.sh>` was configured, but grok stops at its credential check before starting MCP servers or hooks; no disposable credential (C13) | R-grok-proxy, R-grok-hook |
| M-linux-grok-proxy-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | not tested: as the child row | R-grok-proxy |
| M-linux-grok-os-cli | GET https://api.x.ai:443/v1/models | allowed | worker / P1 | nftables, allow sets = api.x.ai and github.com IPs | allowed (auth error "Not signed in"; HTTP status not captured); strace `connect 2606:4700::6812:1350:443`; `ak-allow6` 32 pkts | R-grok-os |
| M-linux-grok-os-child | GET https://example.com:443/ | blocked | worker / P1 | same | not tested: no child without a credential (C13) | R-grok-os |
| M-linux-grok-os-bypass | GET https://example.com:443/ (AC3) | blocked | worker / P1 | same | not tested: no child without a credential (C13) | R-grok-os |

**Supplementary configuration S (not one of the 54 IDs).** nftables lock-to-proxy plus akproxy: the lane UID may reach only `127.0.0.53:53` and `127.0.0.1:47191`, and everything else is dropped. Record R-combo.

| Supplementary ID | Result |
|---|---|
| S-linux-claude-combo-cli | allowed ("Invalid API key"; HTTP status not captured); proxy 9× `allow api.anthropic.com:443 proc claude` |
| S-linux-claude-combo-child | blocked-by-proxy (403; proxy `deny example.com:443 proc curl`); github.com 200 |
| S-linux-claude-combo-bypass | blocked (`curl: (28) … after 10000 milliseconds`) |
| S-linux-codex-combo-cli | allowed (HTTP 401); proxy 13× `allow api.openai.com:443 proc codex` |
| S-linux-codex-combo-child | blocked (MCP child has no HTTPS_PROXY, so it is dropped: `curl: (28)`). Its github.com probe was blocked too: it fails closed, and an MCP server that needs the network would break. |
| S-linux-codex-combo-bypass | blocked (`curl: (28)`) |
| S-linux-grok-combo-cli | allowed (auth error "Not signed in"; HTTP status not captured); proxy 2× `allow api.x.ai:443 proc grok` |
| S-linux-grok-combo-child / -bypass | not tested (no credential, C13) |
| Counters after the three CLI cells | `ak-proxy` 1082 pkts, `ak-drop` 92 pkts, `ak-dns-udp` 15 pkts |

Limits of configuration S (Appendix D):
- Fronting through an allowed tunnel is `unexpectedly allowed`. `front.py` CONNECTed to api.openai.com, sent SNI and Host example.com, and got HTTP 200 with the example.com body.
- DNS is not governed. Lookups of arbitrary names reach upstream through `systemd-resolved` under its own UID.
- Proxy client-side IPv6 was not tested. The proxy listens on IPv4 loopback only.
- Not tested:
  - grok child and bypass;
  - codex shell-tool (non-MCP) children;
  - review-mode argv;
  - UID-changing processes and arbitrary descendants beyond the recorded chains;
  - loopback listeners other than the proxy;
  - proxy down, DNS down and an empty allowlist;
  - credentialed runs.

## Appendix C. Command records

Common to all records: host `fleet-lanes-1`, Ubuntu 26.04.1 LTS, kernel `7.0.0-44-generic`. User `akegress191`, UID 1003, not root. Timeouts are as stated. Proxy, where used: `http://127.0.0.1:47191`, run as `fleet` (UID 1000), not as the lane UID. CLI versions are as in Appendix A. Dates are UTC on 2026-11-27. Excerpts are redacted: placeholder keys are shown only as masked by the provider, and session IDs, request IDs and cf-ray values are dropped. Cell directory: `/home/akegress191/cells/<cell>/work`.

To replay a cell, recreate the user and the files in Appendix F, then run `sudo -n -u akegress191 /tmp/akegress191-spike/cell.sh <cli> <none|native|proxy|os|combo> <tag> [steer]` (P1 substituted in `cell.sh`). For proxy cells, first run `proxyctl.sh start <log> <hosts>`. For OS cells, first run `nft.sh add-os <hosts>`. For combo cells, run `nft.sh add-combo` and also start the proxy.

- **R-claude-native** (cell `claude-native-r1`, 19:06:33Z, timeout 150 s). exit=1, 2 s. Output `{"is_error":true,"terminal_reason":"api_error","result":"Invalid API key · Fix external API key"}` (HTTP status not captured). stderr: the sandbox-disabled warning quoted in the matrix. strace: pid 1058799 (claude) `connect 2607:6bc0::10:443`; pid 1058806 `connect 160.79.104.10:443`. Child: `ancestry=1058817:child.sh <- 1058816:sh <- 1058799:claude`; `proxy_env=unset`. `child-curl pid=1058846 url=https://github.com:443/ exit=0 result=200 140.82.113.4`; `child-curl pid=1058847 url=https://example.com:443/ exit=0 result=200 2606:4700:10::ac42:93f3`; `bypass pid=1058849 exit=0 result=200 2606:4700:10::ac42:93f3`.
- **R-claude-proxy** (cells `claude-proxy-r1`, 06:22:12Z, and `claude-proxy-r1s` steered; allowlist `api.anthropic.com,github.com`). r1: exit=1, 2 s. Output "Invalid API key · Fix external API key" (HTTP status not captured). Child `ancestry=49562:child.sh <- 49561:sh <- 49511:claude`, `proxy_env=set`. github.com `200 127.0.0.1` (through the proxy). example.com `exit=7 curl: (7) CONNECT tunnel failed, response 403`. bypass `exit=0 200 2606:4700:10::ac42:93f3`. Proxy log: `allow api.anthropic.com:443 proc claude pid=49511 upstream 2607:6bc0::10`; `allow github.com:443 proc curl pid=49589`; `deny example.com:443 proc curl pid=49599 upstream null`; `deny downloads.claude.ai:443 proc claude`; `deny http-intake.logs.us5.datadoghq.com:443 proc claude`. r1s, with `ANTHROPIC_BASE_URL=https://example.com`: the CLI's own request to example.com was `blocked-by-proxy` (10 `deny example.com:443 proc claude pid=49682`). The CLI retried until `timeout` (exit=124, 150 s). This ran under the earlier sequential `child.sh`, which has the same probes.
- **R-claude-os** (cells `claude-os-r1`, 06:26Z, and `claude-os-r1s` steered; nft allow sets from `getent ahosts api.anthropic.com github.com`). r1: exit=1, "Invalid API key" (HTTP status not captured). strace pid 65449 (claude) `connect 2607:6bc0::10:443`; pid 65449 `connect 35.190.46.17:443` and `2600:1901:0:b25e:::443` stayed in EINPROGRESS (dropped). Child `ancestry=65474:child.sh <- 65473:sh <- 65449:claude`. github.com `exit=0 200 140.82.114.3`. example.com `exit=28 Connection timed out after 10001 milliseconds`. bypass `exit=28 … after 10002 milliseconds`. r1s, with `ANTHROPIC_BASE_URL=https://example.com`: the CLI's own connections to the example.com addresses (pid 66423, EINPROGRESS) never completed, and there was no output before `timeout` 60 s: blocked. The rule counters for this pair were lost in the session interruption (Appendix E). The codex and grok OS records carry counters.
- **R-codex-native** (cell `codex-none-explore`, 06:21:06Z). No proxy and no nft rule, so the only mechanism is argv `--sandbox workspace-write`, which is the native setting. exit=1, 17 s. `turn.failed … unexpected status 401 Unauthorized: Incorrect API key provided: sk-PLACE************-key … url: https://api.openai.com/v1/responses`. MCP child `ancestry=47986:child.sh <- 47878:codex <- 47871:node`, `proxy_env=unset`. github.com 200 140.82.114.4. example.com `exit=0 200 2606:4700:10::6814:179a`. bypass `exit=0 200 2606:4700:10::ac42:93f3`.
- **R-codex-sandbox** (dir `codex-native-sbx`, 19:06:35Z, timeout 30 s each): `codex sandbox -c sandbox_mode="workspace-write" -- curl -sS -o /dev/null -m 10 -w '%{http_code} %{remote_ip}' <url>` for api.openai.com/v1/models, github.com and example.com, plus the AC3 bypass. All four printed `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, exit 1; curl never ran. Control `codex sandbox -c sandbox_mode="danger-full-access" -- curl … https://example.com` returned `200`, exit 0.
- **R-codex-proxy** (cell `codex-proxy-r3`, 19:05:59Z; allowlist `api.openai.com,github.com`). exit=1, 17 s, 401 as above. MCP child `ancestry=1057659:child.sh <- 1057539:codex`, `proxy_env=unset`. github.com 200 140.82.113.4 (direct). example.com `exit=0 200 2606:4700:10::6814:179a`. bypass `exit=0 200 2606:4700:10::ac42:93f3`. Proxy log: 13× `allow api.openai.com:443 proc codex`, 2× `allow github.com:443 proc git-remote-http`, `deny chatgpt.com:443 proc codex`. Earlier runs `codex-proxy-r1` and `r1s` (06:25Z) matched. In r1s, `OPENAI_BASE_URL=https://example.com/v1` was ignored by codex 0.154: the request still went to api.openai.com, so the steered codex sub-record is `not tested`.
- **R-codex-os** (cell `codex-os-r3`, 19:05:38Z). exit=1, 20 s, 401. MCP child `ancestry=1052416:child.sh <- 1051630:codex`. github.com `200 140.82.112.4`. example.com `exit=28 … 10001 ms`. bypass `exit=28 … 10004 ms`. Counters: `ak-dns-udp` 38, `ak-allow4` 772, `ak-allow6` 163, `ak-drop` 70 packets. Runs `codex-os-r1` and `r2` recorded the same CLI result, but codex closed the MCP child before the probes finished (`startup_timeout_sec = 8`, then sequential probes). Those runs led to the 45 s timeout and the concurrent `child.sh`.
- **R-grok-native** (cell `grok-native-r1`, 19:06:35Z, `GROK_SANDBOX=workspace`). exit=1, 0 s, no `connect()` in strace. stderr: `error: this sandbox could not enforce its deny list on Linux: bwrap exec failed: No such file or directory (os error 2). Install bubblewrap … Refusing to start with denied paths unprotected.` An unknown profile name gave `Custom sandbox profile 'bogus' not found. Define it in ~/.grok/sandbox.toml`.
- **R-grok-hook** (dir `grok-hookprobe`, 06:2xZ). A Claude-format `SessionStart` hook in `<HOME>/.claude/settings.json` was not loaded (`grok inspect`: `Hooks (None)`), and no child ran. A configured `grok mcp add akprobe` server did not start in any grok cell (`child.log: none`).
- **R-grok-proxy** (cell `grok-proxy-r1`, 06:25:39Z). exit=1, 0 s. `{"type":"error","message":"Not signed in. … set the XAI_API_KEY environment variable …"}`. Proxy: 2× `allow api.x.ai:443 proc grok pid=64590 upstream 2606:4700::6812:1350`.
- **R-grok-os** (cell `grok-os-r1`, 19:04:28Z). exit=1, 1 s, same message. strace pid 1043472 `connect 2606:4700::6812:1350:443`. Counters `ak-allow6` 32 packets, `ak-drop` 0.
- **R-grok-debug** (dir `grok-debug`, 19:10Z, no mechanism, argv plus `--debug-file <dir>/debug.log`). Log: `Fetching models from https://api.x.ai/v1/models` then `Failed to fetch models: 400 - {"code":"invalid-argument","error":"Incorrect API key provided …`. This record only identifies the request grok makes. It is not cited as the result of any matrix row.
- **R-combo** (19:08:59–19:09:47Z): as the S table, from cells `claude-combo-r1`, `codex-combo-r1` and `grok-combo-r1`, plus the dimension run below.

## Appendix D. Matching model and dimensions (AC4, C10, D7)

**Matching model.**
- akproxy: **exact host**, case-insensitive, one trailing dot stripped, on the CONNECT authority only. No parent-domain or wildcard match. Port must be `443`. IP literals and every non-CONNECT method (plain HTTP) are refused. It does not inspect TLS SNI, the HTTP `Host` header (encrypted inside the tunnel), DNS aliases or redirect targets. Each new host is a new CONNECT, judged on its own.
- nftables rule: **IP set** built by resolving the allowlisted names once at rule-load time (`getent ahostsv4`/`ahostsv6`), with `tcp dport 443` and `meta skuid 1003`. There is no hostname, parent-domain or wildcard notion at all. Anything that resolves to, or is pinned to, an allowed IP passes. IPs that rotate after load are dropped; the `github.com` A record changed between runs: 140.82.112.4, 140.82.113.3/.4, 140.82.114.3/.4.
- Combo: nftables limits the lane UID to the proxy and the DNS stub, so the effective model is the proxy's.

All dimension commands ran as UID 1003 with allowlist {api.openai.com, github.com}. The proxy and combo runs had the four proxy variables set; the OS run had none. Full command: `curl -sS -o /dev/null -m 10 -w '%{http_code} %{remote_ip} redirect=%{redirect_url}' <args>`. Dates: proxy 19:07:15Z, OS 19:07:23Z, combo 19:08:59Z.

| Dimension | Args / command | Policy expectation | Proxy | OS (nft) | Combo |
|---|---|---|---|---|---|
| allow | `https://github.com:443/` | allowed | 200 | 200 | 200 |
| block | `https://example.com:443/` | blocked | blocked-by-proxy (7, 403) | blocked (28) | blocked-by-proxy |
| subdomain | `https://api.github.com:443/` | blocked (not listed) | blocked-by-proxy | blocked (28; 140.82.114.5 not in set) | blocked-by-proxy |
| DNS alias | `https://www.github.com:443/` (CNAME to github.com) | blocked (not listed) | blocked-by-proxy | **allowed, 301** (same IP) | blocked-by-proxy |
| redirect | `-L https://github.com/git/git/raw/master/README.md` (302 to raw.githubusercontent.com) | first hop allowed, off-list target blocked | 302, then blocked-by-proxy | 302, then blocked (28) | 302, then blocked-by-proxy |
| non-443 port | `https://github.com:8443/` | blocked | blocked-by-proxy | blocked (28) | blocked-by-proxy |
| IP literal | `-k https://<github IPv4>:443/` | blocked | blocked-by-proxy | **allowed, 301** | blocked-by-proxy |
| plain HTTP | `http://github.com/`, `http://example.com/` | blocked | proxy 403 for both (GET refused, no upstream) | blocked (28) | proxy 403 |
| Host header | `-H 'Host: example.com' https://github.com:443/` | example.com not reached | github answered 301 to github.com | same | same |
| SNI mismatch | `--connect-to example.com:443:github.com:443 https://example.com/` | example.com not reached | TLS name error (60) | (60) | (60) |
| CDN fronting, curl | `--connect-to example.com:443:<api.openai.com IPv4>:443 https://example.com/` | blocked | blocked-by-proxy (CONNECT to IP literal) | **unexpectedly allowed, 200 from example.com** | blocked-by-proxy |
| CDN fronting, tunnel | `python3 -I front.py 47191 api.openai.com example.com` (CONNECT allowed host, then TLS SNI and Host example.com) | blocked | **unexpectedly allowed, 200, "Example Domain" body** | n/a | **unexpectedly allowed, 200** |
| IPv4 | `-4 https://example.com/`; `-4 https://api.openai.com/v1/models` | blocked; allowed | blocked-by-proxy; 401 | blocked; 401 | blocked-by-proxy; 401 |
| IPv6 | `-6 https://example.com/`; `-6 https://api.openai.com/v1/models` | blocked; allowed | curl could not reach the IPv4-only loopback proxy (7) for both: not tested for the proxy; upstream family is the proxy's choice (logs show v6 upstreams) | blocked; **401 via 2a06:98c1:58::f3** | as proxy |
| ICMP | `ping -c1 -W2 1.1.1.1` | blocked | not governed: 1 received | blocked: 0 received | blocked: 0 received |
| UID change | `sudo -n true` as lane | refused | refused | refused | refused |
| DNS channel | `getent hosts ak191-probe-<ts>.example.com` | blocked | **not governed**: NXDOMAIN came back from upstream, relayed by `systemd-resolved` under its own UID | **not governed** (same) | **not governed** (same) |
| descendants | child rows | recorded chains covered | only if the child inherits HTTPS_PROXY (claude yes, codex MCP no) | recorded child and bypass chains blocked; other descendants not tested | recorded chains blocked; other descendants not tested |

On Linux, the nftables table was `inet` family, so one chain covered IPv4 and IPv6. It ran at hook `output`, `priority filter - 10`, which is before ufw's `ip filter OUTPUT` / `ip6 filter OUTPUT` at `priority filter`. Its own policy was accept, and it dropped only `meta skuid 1003`. Because nftables base chains on the same hook all run, the ufw chains still saw every packet this chain accepted. The rules:

```
table inet akegress191 {
  set allow4 { type ipv4_addr; elements = { <getent ahostsv4 of each host> } }
  set allow6 { type ipv6_addr; elements = { <getent ahostsv6 of each host> } }
  chain out {
    type filter hook output priority -10; policy accept;
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.53 udp dport 53 counter accept comment "ak-dns-udp"
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.53 tcp dport 53 counter accept comment "ak-dns-tcp"
    meta skuid 1003 ip daddr @allow4 tcp dport 443 counter accept comment "ak-allow4"
    meta skuid 1003 ip6 daddr @allow6 tcp dport 443 counter accept comment "ak-allow6"
    meta skuid 1003 counter drop comment "ak-drop"
  }
}
```

The combo variant replaces the two allow rules with `meta skuid 1003 oifname "lo" ip daddr 127.0.0.1 tcp dport 47191 counter accept comment "ak-proxy"`. Drop was chosen over reject so that no new kernel module would load; the module list is unchanged (Appendix E). Inverse: `nft delete table inet akegress191`.

UID coverage, as tested: the recorded child and bypass chains (CLI, then `sh` or MCP server, then `curl`) ran under UID 1003 and were blocked under the OS and combo rules. `sudo -n true` as the lane user was refused. UID-changing processes (setuid or file-capability binaries, `su`, services started on the lane's behalf) and arbitrary other descendants were not tested. Traffic that other UIDs send on the lane's behalf is not covered: DNS through `systemd-resolved` was tested. Root daemons and any local listener the lane can reach on loopback (for example `127.0.0.1:8787`, `:5432`) were not tested, and the combo rule does not allow them.

## Appendix E. Snapshots, changes and cleanup (AC8, C16, D8)

**Snapshot command.** The snapshot script is `bash -s` over ssh as `fleet` (Appendix F). Its sections:
- `iptables-save` and `ip6tables-save` with counters zeroed and comments dropped;
- `nft -s list ruleset`;
- `nft list tables`;
- `ss -ltnupH`, with address and process name only;
- processes matching `proxy|squid|privoxy|mitm|socat|akegress`;
- `ip route show table all`, without local/broadcast and with `expires` stripped;
- `ip rule`, `/etc/resolv.conf`, `resolvectl dns/domain`;
- the lane user, `/home` listing and the account-file SHA-256s;
- `lsmod` names;
- `/etc/environment` and `/etc/profile.d` proxy settings;
- SHA-256 of `fleet`'s `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.grok/config.toml`, `~/.bashrc` and `~/.profile`, and the presence of the two mission-control env files;
- spike temporary paths.

**Session interruption.** The original "before" snapshot was taken at 2026-11-27T06:13Z, before any change. The session then lost its network mid-run (around 06:27Z, during the claude OS cell) and its local scratch copy of that file was lost. When the session resumed, the coordinator checked the host: user `akegress191` and `/tmp/akegress191-spike` existed, there were no owner-match iptables or nft rules, and there were no spike processes.

A fresh "before-resume" snapshot was then taken at 19:03Z. It was taken with the user and the temporary folder still present, because they were needed for the remaining cells. Its firewall, listener, route, DNS, module and settings sections are the authoritative baseline. The account sections were checked against the original 06:13Z values, which were read into the session before the loss:
- `/etc/passwd` `86b488c7…71f1`
- `/etc/group` `be24add7…1575`
- `/etc/shadow` `4e105664…490e`
- `/etc/gshadow` `56ca0adf…6552`
- `/etc/subuid` = `/etc/subgid` `e3c1a1f1…3ecf2`
- `/home` contained `fleet`, `reviewer`

**After snapshot (19:11Z), compared with before-resume.**
- Policy sections (everything except users, temporary paths and listeners): `diff -u` is **empty**.
- Users section compared with the original 06:13Z values: **identical**. The account-file hashes are back to the pre-spike values, the `subuid`/`subgid` entries `useradd` added are gone, and `/home` holds `fleet` and `reviewer`.
- Spike temporary paths: `none`.
- Listeners: one line differs, `tcp 127.0.0.1:55409 postgres`. It belongs to a `fleet` lane's Postgres: it was present at 06:13Z, absent at 19:03Z and present at 19:11Z. The spike started no Postgres. The after listener set equals the original 06:13Z set.
- CLI settings compared with the original 06:13Z values: **not identical**. `fleet`'s `~/.codex/config.toml` hash went from `95ba52f1…` (06:13Z) to `b9e4eb77…` (19:03Z) and stayed there through 19:11Z. The change is real. It is covered by exception X1 below, not counted as a clean result.

**C16 exception X1: `fleet`'s `~/.codex/config.toml`.**
- Change: SHA-256 `95ba52f1…` (06:13Z) to `b9e4eb77…` (19:03Z and 19:11Z). File mtime, per the coordinator's host check: 2026-11-27 06:25:28Z.
- Content, per the coordinator's host check: the fleet lanes' Headroom block only (`model_provider = "headroom"`, `[model_providers.headroom]`, and `trust_level` entries for `/home/fleet/Code/cos-public` and `/home/fleet/Code/chatterbuilt`). It contains no spike path, no spike user and no spike setting.
- The mtime falls inside the spike's codex proxy window (06:25:02–06:25:36Z), so the timing alone does not clear the spike. The process evidence does. Every spike codex run ran as UID 1003, which cannot traverse `/home/fleet` (mode `drwx------ fleet fleet`). Each run had `HOME=/home/akegress191/cells/<cell>` and no `CODEX_HOME` in its environment: the recorded `env-names` lines list only `PATH HOME USER LOGNAME SHELL TERM LANG AK_CHILD_LOG CODEX_API_KEY OPENAI_API_KEY` plus the proxy names. So codex used the throwaway `<cell>/.codex`, where `cell.sh` wrote that cell's `config.toml`. Fleet's own Codex lanes are the remaining writer.
- Granted by Mark (owner) on 2026-11-27, in the coordinator's session, as C16 requires. Recorded by the coordinator (Claude, merge captain for agent-kontrol).
- Rollback owner: Codex, as fleet-lanes coordinator for The-AIE lanes on `fleet-lanes-1`, which owns `/home/fleet/.codex/config.toml`. The spike made no change there to undo; if that file must be restored, Codex restores it from the fleet lanes' own setup (the Headroom provider block and the trusted-project entries).

**Changes made and how each was undone.**

| # | Change (as `fleet` via `sudo -n` unless noted) | Inverse | Verified |
|---|---|---|---|
| 1 | `useradd -m -d /home/akegress191 -s /bin/bash -c "egress spike 191 throwaway" akegress191` (UID/GID 1003; also added `/etc/subuid` and `/etc/subgid` ranges 231072:65536) | `pkill -u akegress191; userdel -r akegress191` | `id akegress191`: no such user; account hashes equal the original |
| 2 | Copied CLI program files to `/home/akegress191/opt/{claude,codex,grok}` and wrappers to `~/bin`; per-cell HOMEs under `~/cells` | removed with the home (`userdel -r`) | `/home/akegress191` absent |
| 3 | `/tmp/akegress191-spike` (scripts, proxy logs), owned by `fleet` | `rm -rf /tmp/akegress191-spike` | absent |
| 4 | `python3 -I akproxy.py 47191 …` bound to `127.0.0.1:47191`, run as `fleet`, started and stopped once per proxy or combo set (about 10 times) | `kill <pid>` (`proxyctl.sh stop`) | `ss -ltnH 'sport = :47191'` empty; no akproxy process |
| 5 | `nft -f` adding `table inet akegress191` (OS variant: 4 loads; combo: 1 load) | `nft delete table inet akegress191` after each set | `nft list tables` shows only `ip filter`, `ip6 filter`, `ip nat`, `ip6 nat` |

The spike changed no iptables rule, ufw rule, route, resolver, sysctl, kernel module, package, CLI setting, credential or file of the `fleet` user. The one change observed in a `fleet` file during the window, `~/.codex/config.toml`, was not made by the spike and is covered by exception X1 above. Nothing was changed on the Mac or the Mac Mini.

## Appendix F. Harness sources (for re-runs)

SHA-256 of the files used in the 19:0xZ runs:
- `akproxy.py` `dd4ba73e…8691`
- `child.sh` `6767f974…15f4` (the concurrent version; the 06:2xZ runs used an earlier sequential version with the same probes)
- `nft.sh` `d79f9276…5546`
- `dims.sh` `1f05b474…cd89`
- `front.py` `c98fbb31…4e45`
- `cell.sh` `b5c5ca01…b1e`

The key parts follow.

`akproxy.py` (run `python3 -I akproxy.py <port> <log> <host,host>`):

```python
import ipaddress, json, select, socket, subprocess, sys, threading, time
PORT, LOG, ALLOW = int(sys.argv[1]), sys.argv[2], {h.strip().lower() for h in sys.argv[3].split(",") if h.strip()}
lock = threading.Lock()
def log(**rec):
    rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with lock, open(LOG, "a") as f: f.write(json.dumps(rec, sort_keys=True) + "\n")
def client_proc(cport):  # names the client process and PID (C6/D4)
    out = subprocess.run(["sudo", "-n", "ss", "-tnpH", "state", "established",
                          f"( sport = :{cport} and dport = :{PORT} )"], capture_output=True, text=True, timeout=5).stdout
    return out.split("users:")[1].strip() if "users:" in out else "unknown"
def deny(c, why, rec):
    body = f"akegress191-proxy denied: {why}\n".encode()
    c.sendall(b"HTTP/1.1 403 Forbidden\r\nX-AK-Proxy: deny\r\nContent-Type: text/plain\r\nContent-Length: "
              + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
    log(decision="deny", reason=why, upstream=None, **rec)
def handle(c, addr):
    rec = {"client": f"{addr[0]}:{addr[1]}", "proc": client_proc(addr[1])}
    try:
        c.settimeout(15); buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < 65536:
            d = c.recv(4096)
            if not d: return
            buf += d
        parts = buf.split(b"\r\n", 1)[0].decode("latin-1").split()
        method, target = (parts[0], parts[1]) if len(parts) >= 2 else ("?", "?")
        rec.update(method=method, target=target)
        if method != "CONNECT": return deny(c, "non-CONNECT method", rec)
        host, _, port = target.rpartition(":"); host = host.strip("[]").lower().rstrip("."); rec["host"] = host
        try:
            ipaddress.ip_address(host); return deny(c, "IP literal", rec)
        except ValueError: pass
        if port != "443": return deny(c, "port not 443", rec)
        if host not in ALLOW: return deny(c, "host not in allowlist", rec)
        try: u = socket.create_connection((host, 443), timeout=10)
        except OSError as e:
            c.sendall(b"HTTP/1.1 502 Bad Gateway\r\nX-AK-Proxy: upstream-failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return log(decision="allow-upstream-failed", reason=type(e).__name__, upstream=None, **rec)
        rec["upstream"] = u.getpeername()[0]
        c.sendall(b"HTTP/1.1 200 Connection Established\r\nX-AK-Proxy: allow\r\n\r\n")
        log(decision="allow", reason="exact host match", **rec)
        socks = [c, u]; c.settimeout(None); u.settimeout(None)
        while True:
            r, _, _ = select.select(socks, [], [], 60)
            if not r: break
            for s in r:
                d = s.recv(65536)
                if not d: return
                (u if s is c else c).sendall(d)
    except Exception as e: log(decision="error", reason=type(e).__name__, upstream=None, **rec)
    finally: c.close()
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT)); srv.listen(64)
log(decision="start", reason=f"listening 127.0.0.1:{PORT} allow={sorted(ALLOW)}", upstream=None)
while True:
    conn, a = srv.accept(); threading.Thread(target=handle, args=(conn, a), daemon=True).start()
```

`child.sh` (launched by the CLI; appends to `$AK_CHILD_LOG`):

```bash
#!/bin/bash
L="${AK_CHILD_LOG:-$HOME/child.log}"
chain="$$:$(cat /proc/$$/comm)"; p=$PPID
for i in 1 2 3 4 5; do [ "$p" -gt 1 ] 2>/dev/null || break; chain="$chain <- $p:$(cat /proc/$p/comm 2>/dev/null)"; p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null); done
{ echo "child uid=$(id -u) ancestry=$chain"; echo "proxy_env=$( [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ] && echo set || echo unset )"; } >> "$L"
for u in https://github.com:443/ https://example.com:443/; do
  ( out=$(curl -sS -o /dev/null -m 10 -w '%{http_code} %{remote_ip}' "$u" 2>&1); rc=$?
    echo "child-curl pid=$BASHPID parent=$$ url=$u exit=$rc result=$(echo "$out" | tr '\n' ' ' | cut -c1-160)" >> "$L" ) &
done
( out=$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy curl --noproxy '*' -sS -o /dev/null -w '%{http_code} %{remote_ip}' -m 10 https://example.com 2>&1); rc=$?
  echo "bypass pid=$BASHPID parent=$$ exit=$rc result=$(echo "$out" | tr '\n' ' ' | cut -c1-160)" >> "$L" ) &
wait
exec timeout 5 cat >/dev/null
```

Per-CLI child launcher config, written into the fresh cell HOME:
- claude: `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/tmp/akegress191-spike/child.sh"}]}]}}`, with `,"sandbox":{"enabled":true},"permissions":{"allow":["WebFetch(domain:api.anthropic.com)","WebFetch(domain:github.com)"]}` added for native.
- codex: `[mcp_servers.akprobe]` / `command = "/tmp/akegress191-spike/child.sh"` / `startup_timeout_sec = 45`.
- grok: `grok mcp add akprobe /tmp/akegress191-spike/child.sh`.

`front.py` CONNECTs to an allowed host, then wraps TLS with `server_hostname=<other host>` and sends `GET /` with `Host: <other host>`.

## Appendix G. Failure modes (AC6, C11)

| Failure mode | Mark | Evidence or decision |
|---|---|---|
| Missing or stale CLI | not tested | Not exercised. `run_cli` returns `unavailable` on `FileNotFoundError`, but no enforcement interaction was run. |
| Unavailable platform | escalate | Owner: Mark. macOS was not tested. Decision needed: name a disposable macOS host and approve a root `pf` anchor there, or accept "Linux only". |
| DNS failure | not tested | Not exercised. |
| Unavailable proxy | not tested | Not exercised directly. Closest observation: under combo, the codex MCP child, which never received HTTPS_PROXY, timed out on every target. |
| Empty allowlist | not tested | Not exercised. |
| Overlapping hosts | escalate | Owner: Mark. `example.com` and `api.openai.com` share Cloudflare addresses (`104.20.23.154`/`172.66.147.243` and `162.159.140.245`/`172.66.0.243` are all Cloudflare anycast). The IP-based nft rule allowed `example.com` through an allowed IP (HTTP 200), and the proxy allowed it through an allowed CONNECT name (HTTP 200). Decision needed: require SNI/Host verification, or terminate TLS, before any enforce claim. |
| Conflicting CLI, proxy and OS decisions | fail closed (combo), with one exception | Under combo, the OS drop overrode the codex decision to start MCP servers without the proxy: the child could not reach any host. Exception: the Claude native sandbox reported enabled in settings but disabled itself at run time (fail open, with a warning). An enforcement design must not count CLI-native settings. |
| Redirects | fail closed | The off-list redirect target `raw.githubusercontent.com` was blocked by the proxy, nft and combo; only the allowed first hop answered (302). |
| IPv4/IPv6 differences | fail closed (nft, combo) / not tested (proxy client side) | The nft `inet` table covered both families (IPv6 allowed for listed IPs; example.com blocked on both). The proxy listens on IPv4 loopback only; `curl -6` could not reach it, so the proxy's client-side IPv6 behavior is not tested. Its upstream family varied (IPv6 upstreams in the logs). |
| Partial cleanup | escalate | It happened: a network interruption mid-spike left the lane user and temp folder behind, with no rules or processes (coordinator check). Owner: Mark. Decision needed: whether an enforcement slice must ship a reconciler that finds and removes orphaned `akegress*` tables, users and listeners at dispatcher start. |

## Appendix H. Verification

Run these from the worktree root (D11). Base `974dc9d`. The only changed path is `docs/design/egress-allowlist.md`.

```bash
D=docs/design/egress-allowlist.md
grep -o -E '^\| M-(macos|linux)-(claude|codex|grok)-(native|proxy|os)-(cli|child|bypass) \|' "$D" | sort | uniq | wc -l   # 54
```

Reviewer re-runs (D11):
- `M-linux-claude-proxy-cli`, allow: record R-claude-proxy, `cell.sh claude proxy <tag>` with the proxy allowing `api.anthropic.com,github.com`.
- `M-linux-claude-proxy-child`, block: the same run's child line and proxy `deny example.com` entry.
- `M-linux-claude-os-bypass`, bypass: record R-claude-os, `nft.sh add-os api.anthropic.com,github.com` then `cell.sh claude os <tag>`.

No CI job and no existing test (`tests/unit/test_child_env.py` covers environment projection only) establishes host network isolation.

## Appendix I. Recommendations and drafted follow-ups (AC7, C12, D9)

### Linux: `not feasible/unknown`

Enforce-with-X is not supported by this evidence. The closest candidate is: a per-lane UID (#193), plus an nftables `inet` output chain matching `meta skuid <lane>` that allows only the DNS stub and a loopback allowlisting proxy and drops everything else, plus the proxy. Under that candidate the bypass was blocked for claude and codex and every listed dimension except two passed.

Missing or failing evidence:
1. SNI and domain fronting: `unexpectedly allowed` (HTTP 200 from example.com through an allowed CONNECT tunnel).
2. DNS channel: open through `systemd-resolved`.
3. grok child and bypass: `not tested` (C13).
4. codex shell-tool child (as opposed to MCP child): `not tested`; the codex sandbox could not start here.
5. review-mode argv: `not tested`.
6. Proxy client-side IPv6: `not tested`.
7. Credentialed runs: `not tested`.

Blast radius if shipped as is: a lane can still exfiltrate to any site that shares a CDN edge with an allowed host, and through DNS queries.

**Drafted follow-up (not filed): "Linux lane egress: UID lock-to-proxy with SNI-checked allowlist"**

- **Problem.** #191 showed that `HTTPS_PROXY` alone is bypassed by any child that unsets it. It showed that an nftables IP allowlist is bypassed by DNS aliases, IP literals and CDN domain fronting. It also showed that even UID lock-to-proxy leaks through SNI fronting and DNS. Lanes can read source and tokens (#189, #190), so they need a real egress boundary.
- **Proposed solution.** For each lane UID from #193, the dispatcher host installs one `table inet ak_lane_<uid>`. The chain is `type filter hook output priority -10; policy accept`, matching `meta skuid <uid>`. It allows only `127.0.0.53:53` and the proxy port and drops the rest. Every change has an exact inverse and a startup reconciler. A stdlib host-side CONNECT proxy, running as a different UID, enforces an exact-host allowlist per lane. Before relaying, it peeks at the TLS ClientHello and refuses when the SNI is absent or differs from the CONNECT host. Lane DNS goes to a resolver that answers only allowlisted names (or the lane gets no DNS, and the proxy resolves). The dispatcher sets the proxy variables in the child environment, and the OS rule makes them mandatory.
- **Alternatives considered.** CLI-native sandboxes: they failed open or could not start, and do not govern hooks, MCP or the CLI's own traffic. A plain IP allowlist in nftables: alias, IP literal and fronting bypasses. A TLS-terminating proxy: it needs a CA in every CLI trust store, a broader change. Per-lane network namespaces or containers: out of scope for #191.
- **Acceptance criteria.**
  1. Re-run the #191 Linux matrix plus the dimension table against the new mechanism. The proxy, child and bypass rows show `allowed`/`blocked-by-proxy`/`blocked` for all three CLIs, with disposable credentials (C13) so that grok and codex shell-tool children run.
  2. `front.py <port> <allowed> example.com` gets a proxy refusal.
  3. `getent hosts <random>.example.com` as the lane UID fails without an upstream query.
  4. Review-mode argv rows pass.
  5. Proxy down, DNS down and empty allowlist each fail closed.
  6. Before and after canonical snapshots diff empty, and the reconciler removes a deliberately orphaned table and user.
- **Affected area.** `agents/broker/` (proxy), `agents/dispatcher/mc_dispatcher.py` (`run_cli` env overlay), host setup docs, and a new `docs/design/egress-allowlist.md` revision.
- **Tier.** C: root firewall rules on dispatcher hosts, plus security-boundary code.

### macOS: `not feasible/unknown`

Nothing was tested on macOS: the owner limited the spike to the Linux host fleet-lanes-1 (2026-11-27). No per-user mechanism paired with `pf` has been shown to distinguish the lane user (D3). Missing evidence: every one of the 27 macOS rows, the `pf` anchor and table, the per-user mechanism, all dimensions, and cleanup.

**Drafted follow-up (not filed): "macOS lane egress: find a per-user enforcement point"**

- **Problem.** macOS dispatcher hosts (the MacBook and the Mac Mini) run lanes. #191 produced no evidence that anything on macOS can force a lane user's traffic through an allowlist. `pf` has no owner match comparable to `meta skuid` for outbound filtering.
- **Proposed solution.** On a disposable macOS host the owner names, test these candidates: (a) a `pf` anchor with `user <lane>` rules on outbound TCP, routing to or allowing only a loopback proxy, verifying the `user` keyword against real lane traffic; (b) a Network Extension content filter scoped by audit token or UID; (c) running lanes in a Linux VM that uses the Linux design. Use the same 27-row matrix, dimension table and snapshot/inverse discipline as #191.
- **Alternatives considered.** HTTPS_PROXY only: #191 showed it is advisory. CLI-native sandboxes: they did not govern hooks or MCP on Linux; macOS Seatbelt profiles were untested. Declare macOS dispatch unsupported for secret-bearing lanes: a fallback the owner may choose.
- **Acceptance criteria.**
  1. All 27 macOS rows are run, or `not tested` with a reason.
  2. The `pf` anchor, table and rules are recorded, with a test showing the per-user match distinguishes the lane user from another user.
  3. The dimension table is complete, including SNI fronting and DNS.
  4. Before and after `pfctl -sa`, proxy and settings snapshots diff empty.
  5. The recommendation follows C12/D9.
- **Affected area.** `docs/design/egress-allowlist.md` (a new macOS section) only.
- **Tier.** C: root `pf` changes on a host the owner names.
