# Secret broker references

A secret reference names a value that stays on the host. The reference itself is not a secret. Dispatched lanes receive placeholders. This directory is the resolution layer those later slices call. It does not listen on the network.

A reference has the form `secretref://<provider>/<source>/<name>`.

- `provider` is `file` or `exec`.
- `source` is 1–64 characters from `[A-Za-z0-9_-]`.
- `name` is 1–200 characters from `[A-Za-z0-9_.-]`, with `/` between segments. A segment cannot be `.` or `..`.

Whitespace, non-ASCII text, `%`, `?`, `#`, and empty segments are rejected.

## API

```text
parse_reference(text: str) -> tuple[str, str, str]   # (provider, source, name)
load_config(path: str) -> dict
resolve(ref, config, environ=None, config_path=None) -> str
```

`environ` is the only mapping `exec` reads recipe variables from. It defaults to `os.environ`. Production callers pass `config_path`. Every such call reopens that file, checks it, parses it, and validates it before use. A call without `config_path` uses `config` as a snapshot and is for tests.

Provider configs and recipe executables are trusted host-admin inputs. They are never accepted from tasks or agents. Enabling a new recipe needs Mark's decision.

Failures raise `ValueError`. The message is one fixed sentence and does not include the reference text, a path, argv, command output, or the resolved value.

## Config

JSON object. The only top-level keys are `file` and `exec`. Both are optional and at least one is required. Ids use the `source` grammar.

`file` maps a source id to an absolute path. `exec` maps a recipe id to:

- `argv`: non-empty list of strings. At least one element contains `{name}`. The first element is non-empty. `{name}` is replaced by the complete reference name, as literal text, with no shell.
- `env`: optional list of variable names (`[A-Za-z_][A-Za-z0-9_]*`). Default `[]`.
- `timeout_seconds`: optional integer from 1 to 300. Default `10`.

The name grammar allows a leading `-`, so a recipe should put `--` before `{name}` wherever the target command accepts it.

Unknown keys, duplicate JSON members, `NaN`, `Infinity`, and a boolean `timeout_seconds` are rejected.

The child environment is `PATH`, `HOME`, `USER`, `LANG`, and `TMPDIR` when they are set, plus the recipe's `env` names when they are set. Unset names are omitted. A recipe cannot override the five base names. Every `MC_*` name is omitted even when listed. Stdout and stderr are captured, not forwarded. Each stream is capped at 1,048,576 bytes. Stdout must be strict UTF-8. Exactly one trailing `\n` is removed.

`load_config` checks the config file, and every resolve checks a `file` source, before reading it: a regular file, not a symlink, opened with `O_NOFOLLOW`, owner equal to the effective uid, mode exactly `0600` or `0400`.

Copy `providers.example.json`, replace the operator substitutions, and `chmod 600` the copy.

## Recipes

Each recipe ends with a status line. A recipe that has not been executed on a host uses the not-yet-run status. A recipe that has been executed names the calendar date and the host.

### Plain mode-600 file (default)

Zero-setup default. One `KEY=VALUE` file, owned by the broker user. Blank lines and lines whose first non-whitespace character is `#` are ignored. The first `=` splits the key from the value. This provider has no argv and no env, because it never executes a command.

```bash
install -m 600 /dev/null /var/lib/agent-kontrol/secrets.env
```

```json
{
  "file": {
    "default": "/var/lib/agent-kontrol/secrets.env"
  }
}
```

Example reference: `secretref://file/default/OPENROUTER_API_KEY`

Status: not run

### 1Password service account

The broker replaces `{name}` with the complete reference name. `OP_SERVICE_ACCOUNT_TOKEN` is listed because the child does not inherit the broker environment. The JSON names the variable; it does not contain the token.

Command: `op read "op://{name}"`

```json
{
  "argv": ["op", "read", "op://{name}"],
  "env": ["OP_SERVICE_ACCOUNT_TOKEN"]
}
```

Example reference: `secretref://exec/onepassword/Prod/OpenRouter/credential`

Status: not run

### macOS Keychain

Command: `security find-generic-password -s <service> -a <account> -w`

`<service>` is an operator substitution: replace it with the Keychain service before enabling the recipe. `<account>` is an operator substitution when the account is fixed. The JSON below passes the complete reference name in the account position with `{name}`.

```json
{
  "argv": [
    "security",
    "find-generic-password",
    "-s",
    "<service>",
    "-a",
    "{name}",
    "-w"
  ],
  "env": []
}
```

Example reference: `secretref://exec/keychain/openrouter-api-key`

Status: not run

### sops/age

Command: `sops -d --extract '["{name}"]' <file>`

`{name}` is replaced by the complete reference name. `<file>` is an operator substitution: replace it with the absolute path of the encrypted file. `HOME` is already passed to the child, so an age key under the home directory is visible without an `env` entry.

```json
{
  "argv": ["sops", "-d", "--extract", "[\"{name}\"]", "<file>"],
  "env": []
}
```

Example reference: `secretref://exec/sops/openrouter_api_key`

Status: not run

## Running the broker

The broker is a host process. It listens on `127.0.0.1` only.

```bash
python3 agents/broker/broker.py --config /var/lib/agent-kontrol/broker.json
```

The config file is JSON. It must be a regular file, not a symlink, owned by the effective uid, mode `0600` or `0400`. Copy `config.example.json`, replace the operator substitutions, and `chmod 600` the copy.

Every field is required except `audit`, which is described under [Audit events](#audit-events), and `github`, described under [GitHub tokens](#github-tokens).

- `bind` is exactly `127.0.0.1`. Any other address is refused before a socket is created.
- `port` is an integer from 1 to 65535. `0` is rejected in the file. Tests pass an ephemeral port only through the in-memory server API.
- `providers` is an absolute path of a provider config, as described above.
- `placeholder_ttl_seconds` is a positive integer. A placeholder is expired when the monotonic clock is greater than or equal to `minted_at + ttl`.
- `upstream_timeout_seconds` is a positive integer. It bounds the upstream connection, including the TLS handshake.
- `max_request_body_bytes` is a positive integer. A request with a known length over the limit is refused with `413` before any upstream connection. A chunked body that crosses the limit while it is already streaming aborts both connections.
- `services` is a non-empty list. Each service object has exactly these fields:
  - `name`: 1–40 characters from `[a-z0-9-]`, unique among services. `github` is reserved and refused.
  - `upstream`: an `https://` origin with no path, query, fragment, or userinfo. TLS verification stays on. Redirects are not followed.
  - `header`: the header the upstream uses for its credential. The name is matched without case sensitivity.
  - `template`: the header value, containing the text `{secret}` once. The usual form is `Bearer {secret}`.
  - `secret`: a `secretref://` reference. A literal key is refused at startup. The value is resolved once, through the provider file, before the socket is created, and is not resolved again per request.
  - `methods`: a non-empty list of uppercase method tokens.
  - `path_prefixes`: a non-empty list of prefixes that start with `/`. After the path is normalized, it must start with one of them. `/api/v1/` matches `/api/v1/x` and does not match `/api/v1` or `/api/v1x`.

If resolution fails, the process exits non-zero and names the service and the provider. It does not print the secret. Each request writes one JSON line to the logger `ak.broker` with the keys `service`, `method`, `prefix`, `status`, and `reason`. That line does not include the target, a header value, the body, the secret, or a placeholder.

Stopping the process drops every placeholder, because they live only in memory. A later start resolves secrets again and will not accept placeholders minted by the previous process.

### Audit events

With an `audit` block, the broker posts one event to Agent Kontrol for each request it answers on its HTTP port (#192). Without the block it posts nothing.

```json
"audit": {
  "url": "https://YOUR-DEPLOY.vercel.app",
  "token": "secretref://file/default/AK_BROKER_AUDIT_TOKEN"
}
```

- `url` is an `http://` or `https://` origin with no path, query, fragment, or userinfo. Events go to that origin plus exactly `/api/ingest`. Redirects are not followed.
- `token` is a `secretref://` reference. It resolves at startup, before the listening socket exists. The value must start with `akc_`, the prefix of an Agent Kontrol agent credential. Any other value, including `MC_TOKEN`, stops startup with `audit token must be an agent credential with only status:write`. A literal token or a malformed URL stops startup with `invalid broker config: audit`. No environment variable is read for the token, and neither error prints any part of it.

Issue the credential from **Settings** in Agent Kontrol:

1. Under agent credentials, set **Label** to something like `broker-audit-<host>`.
2. Under **Scopes**, select only `status:write`. That scope allows `POST /api/ingest` and nothing else the broker needs.
3. Leave **Expires** empty, or set a date and plan to rotate.
4. Create it and copy the token. It is shown once.
5. Store it in the provider the reference names, for example the mode-600 file: `AK_BROKER_AUDIT_TOKEN=akc_...`.

The broker does not check scopes. Check that the Settings row lists exactly `status:write`.

Each event is:

```json
{"agent_id":"broker-<short hostname>","platform":"other","kind":"broker_forwarded","detail":{"task_id":"…","service":"openrouter","method":"POST","path_prefix":"/api/v1/","status":200,"reason":null}}
```

`kind` is `broker_refused` for a refusal the broker generates and `broker_forwarded` when the request reached the upstream. The `detail` fields are listed in [API.md](../../docs/API.md#broker-audit-events). `task_id` comes only from the placeholder store, never from the request. An event never holds a header value, a placeholder, a body, the full path, the query, a secret, or the audit token.

Delivery never delays or changes a proxied response. One daemon thread drains a queue of 1,000 events. Each POST has one 5-second budget for connect, headers, and body, and is not retried. A full queue drops the event and counts `dropped_full`. A DNS failure, connection failure, timeout, redirect, non-2xx answer, or an answer that is not a JSON object drops the event and counts `delivery_failed`. While either counter is non-zero, the logger `ak.broker.audit` writes at most one line a minute, for example `{"audit":"degraded","dropped_full":3,"delivery_failed":0}`. Stopping the broker discards queued events.

To turn auditing off, remove the `audit` block, restart the broker, and revoke the credential in Settings.

### GitHub tokens

`git` and `gh` take no clean base-URL override, so the placeholder proxy cannot cover GitHub (#190). With a `github` block, the GitHub App's private key stays in the broker, and a lane gets an installation token scoped to its task's one repository, limited to the configured permissions, that expires within an hour. The lane does hold that token: a leaked token exposes one repository for at most an hour.

```json
"github": {
  "app_id": 123456,
  "private_key": "secretref://exec/keychain/AK_GITHUB_APP_KEY",
  "permissions": {"contents": "write", "pull_requests": "write"},
  "api": "https://api.github.com"
}
```

- `app_id` is a positive integer (not a boolean).
- `private_key` is a `secretref://` reference to the App's PEM private key. It resolves at startup, before either socket exists, and is kept apart from the service secrets. A literal key is refused. A single-line value may write the PEM's line breaks as `\n`, which is how a mode-600 env file holds it.
- `permissions` is a non-empty object of permission names (`[a-z_]+`) to `read` or `write`. The minimum for pushing a branch and opening a pull request is `{"contents": "write", "pull_requests": "write"}`. Every token gets exactly this set; per-task permissions are not supported.
- `api` is optional and defaults to `https://api.github.com`. It is an `https` origin with no path, query, fragment, or userinfo. TLS verification stays on and redirects are not followed.

A malformed block stops startup, before any socket is created.

**Signing.** The broker signs an RS256 JWT (`iss` = `app_id`, `iat` = now − 60 s, `exp` = now + 540 s) with `openssl dgst -sha256 -sign /dev/fd/<n>`. The PEM reaches `openssl` only through an inherited pipe: never argv, the environment, a log, or a file path on disk. `openssl` must be on the broker's `PATH`; if it is missing or fails, no token is issued (`github_unavailable`).

**Minting.** For a task granted a repository, the broker calls `GET /repos/{owner}/{repo}/installation` and then `POST /app/installations/{id}/access_tokens` with exactly `{"repositories":[name],"permissions":{…}}`. Each call runs under one `upstream_timeout_seconds` deadline covering name resolution, every address, connect, TLS, send, headers and body. Proxy variables are not consulted. The token is cached per task (never shared between tasks); concurrent requests share one mint, and a request at or after `expires_at − 300 s` mints a new one. A timeout, redirect, non-2xx answer, malformed JSON, missing token, unparseable `expires_at`, or a lifetime over 3,600 seconds returns `github_unavailable` and clears that task's cache.

**Endpoint.** `POST /_github/token` on the loopback port, with `Authorization: Bearer <github placeholder>`, `Content-Type: application/json` and exactly `{"repository":"<owner>/<name>"}`. Success is `200` and exactly `{"token":"…","expires_at":"<RFC 3339>"}`. The request target must be exactly `/_github/token`; a query, fragment, or any other path is `400 bad_request`. Checks run in this order: target and method, then the placeholder, and only then is any body byte read (a body has 10 seconds to arrive); then the body, configuration and repository. Refusals are `{"error":"<code>"}`: the placeholder codes (`401`), `bad_request` (`400`), `github_not_configured`, `github_no_repo` and `github_repo_mismatch` (`403`), and `github_unavailable` (`502`). Only the task's `github` placeholder opens the endpoint; a service placeholder is `401 bad_placeholder`. Each answer writes one `ak.broker` line and, with an `audit` block, one audit event (service `github`, path prefix `/_github/token`).

**Admin socket.** `mint` takes an optional `github_repo: "<owner>/<name>"`; `services` may be empty only when it is present, and may never contain `github`. With the block, the response gains `"github": {"placeholder": "akp_…", "broker_url": "http://127.0.0.1:<port>"}`. Without the block the repository is ignored, and `services: []` returns exactly `{"ok":true,"grants":[]}`. `revoke_task` also clears the task's cached token and sends `DELETE /installation/token` with it; a failed DELETE is logged as `{"github":"github_revoke_failed"}` and the revoke still succeeds. A token request holds its task's lock from choosing the token until the response is written, and `revoke_task` takes the same lock after revoking the placeholder, so a request not yet answered gets `401 revoked_placeholder` and no token, even when the DELETE fails.

**Dispatcher setting.** On every host whose broker has a `github` block, set `MC_BROKER_GITHUB=required` for the dispatcher. A supported remote then fails closed when the mint answer has no valid `github` grant (a stale or misconfigured broker), instead of starting the lane with no grant.

**How a lane pushes.** The dispatcher sets `git-credential-ak` (this directory, mode `0755`) as the only credential helper for `https://github.com`, through the child's environment only (see the dispatcher README). An HTTPS `git push`, `fetch` or `clone` of the task's repository asks the helper, which posts `AK_GITHUB_REPO` to the endpoint and answers git with `username=x-access-token` and the token. Any doubt (malformed input, a refusal, a bad response, an unreachable broker) means a non-zero exit and no credential; other hosts, other protocols, `store` and `erase` print nothing.

**Limits.**

- `gh` is not covered; it still uses whatever login the host has.
- SSH remotes get the grant, but SSH transport never calls a credential helper, so SSH pushes keep using the host's SSH keys.
- The token lives up to an hour and the lane holds it. Revoking the task deletes it early.
- The helper is the only one git's configuration supplies; a worker that deliberately runs `git -c credential.helper=…` or reads a credential store file is not stopped. Running lanes as a separate OS user is #193.
- GitHub Enterprise is supported only through `api`.

To turn it off: stop new claims, `revoke_task` each in-flight task, remove the block, and restart the broker and then the dispatcher. Every token that could have been issued has expired one hour later.

### launchd

Operator recipe. This plist has not been loaded.

Status: not yet run

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.peripety.ak-broker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/ABS/PATH/agents/broker/broker.py</string>
    <string>--config</string>
    <string>/ABS/PATH/broker.json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

`launchctl bootout` unloads the job. Unloading is not the same thing as leaving the plist in place.

```bash
launchctl bootout gui/$(id -u)/com.peripety.ak-broker
curl -sS -m 2 http://127.0.0.1:8765/
```

The curl command must fail to connect. Replace `8765` with the configured port.

### systemd

Operator recipe. This unit has not been started.

Status: not yet run

```ini
[Unit]
Description=Agent Kontrol secret broker

[Service]
ExecStart=/usr/bin/python3 /ABS/PATH/agents/broker/broker.py --config /ABS/PATH/broker.json
Restart=on-failure

[Install]
WantedBy=default.target
```

Save it as `~/.config/systemd/user/ak-broker.service`.

`systemctl --user stop ak-broker` ends the running process. `systemctl --user disable ak-broker` keeps a future login from starting it. If the unit was enabled, run both. Stopping alone leaves the enablement in place. Disabling alone leaves the current process running.

```bash
systemctl --user stop ak-broker
systemctl --user disable ak-broker
curl -sS -m 2 http://127.0.0.1:8765/
```

The curl command must fail to connect.

### Same OS user

A lane that runs as the same OS user as the broker can still read the broker's files and its process memory. The placeholder keeps the secret out of the lane's environment. It does not hide the broker from that user. Separating the OS user is #193.
