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
