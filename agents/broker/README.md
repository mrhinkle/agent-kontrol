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

Every field is required.

- `bind` is exactly `127.0.0.1`. Any other address is refused before a socket is created.
- `port` is an integer from 1 to 65535. `0` is rejected in the file. Tests pass an ephemeral port only through the in-memory server API.
- `providers` is an absolute path of a provider config, as described above.
- `placeholder_ttl_seconds` is a positive integer. A placeholder is expired when the monotonic clock is greater than or equal to `minted_at + ttl`.
- `upstream_timeout_seconds` is a positive integer. It bounds the upstream connection, including the TLS handshake.
- `max_request_body_bytes` is a positive integer. A request with a known length over the limit is refused with `413` before any upstream connection. A chunked body that crosses the limit while it is already streaming aborts both connections.
- `services` is a non-empty list. Each service object has exactly these fields:
  - `name`: 1–40 characters from `[a-z0-9-]`, unique among services.
  - `upstream`: an `https://` origin with no path, query, fragment, or userinfo. TLS verification stays on. Redirects are not followed.
  - `header`: the header the upstream uses for its credential. The name is matched without case sensitivity.
  - `template`: the header value, containing the text `{secret}` once. The usual form is `Bearer {secret}`.
  - `secret`: a `secretref://` reference. A literal key is refused at startup. The value is resolved once, through the provider file, before the socket is created, and is not resolved again per request.
  - `methods`: a non-empty list of uppercase method tokens.
  - `path_prefixes`: a non-empty list of prefixes that start with `/`. After the path is normalized, it must start with one of them. `/api/v1/` matches `/api/v1/x` and does not match `/api/v1` or `/api/v1x`.

If resolution fails, the process exits non-zero and names the service and the provider. It does not print the secret. Each request writes one JSON line to the logger `ak.broker` with the keys `service`, `method`, `prefix`, `status`, and `reason`. That line does not include the target, a header value, the body, the secret, or a placeholder.

Stopping the process drops every placeholder, because they live only in memory. A later start resolves secrets again and will not accept placeholders minted by the previous process.

### launchd

Operator recipe. This plist has not been loaded.

Status: not run

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

Status: not run

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
