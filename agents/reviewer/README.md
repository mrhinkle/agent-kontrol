# Claude Reviewer runner

`agents/reviewer/` is the Claude Reviewer from [ROLES.md](../../docs/ROLES.md#reviewer) as an Agent
Kontrol consumer of the `pr_review` ready queue (#176, Part 2). One run:

1. reads `GET /api/sweep/queues?classification=pr_review` with the AK credential (the preflight);
2. takes `ready_items` only from rows for its configured queue ids that are `complete: true`, not
   `stale`, and whose `repo` matches the configured repo. Anything else counts `queue_unknown`.
   There is no fallback GitHub search;
3. resolves the GitHub App's bot login (`GET /app`) and refuses to run (exit 78) unless the
   registry lists it with vendor `claude`;
4. for each candidate, Tier C first, then `green_since` oldest first (null last, by PR number):
   re-reads the pull, resolves every commit's vendor, and skips `same_vendor` and
   `provenance_unknown`. It also skips a head it already reviewed, and checks the size limits
   and the day's budget;
5. fetches `refs/pull/N/head` and the base SHA into a fresh temporary clone over HTTPS with the
   installation token. It verifies the fetched head, checks out detached at that head, and
   runs `claude -p` read-only inside `sandbox-exec`;
6. validates the model's JSON and builds the evidence body itself. The model never writes the
   header, marker or verdict;
7. re-reads the pull. In `live` mode it posts one `COMMENT` review pinned to the reviewed head.
   In `dry-run` mode it writes the would-be body to the state dir instead;
8. sends exactly one `status` receipt to `POST /api/ingest`.

It is **off by default** and nothing in this repository installs, enables or schedules it.

```bash
python3 -m agents.reviewer.claude_reviewer --config /path/to/reviewer.config.json
```

Python 3.9+ standard library, `git`, `/usr/bin/openssl` for RS256, `/usr/bin/sandbox-exec` (macOS
only; on any other OS the runner refuses with exit 78), and the `claude` CLI.

Exit codes: `0` done (also when disabled, or when another run holds the lock); `1` the AK
preflight failed; `2` the config is invalid; `78` refused (App identity, `/app` failure,
registry, platform, sandbox or `openssl`).

## Config

Copy [`reviewer.config.example.json`](reviewer.config.example.json). Unknown fields are rejected.
No secret value goes in the JSON; every credential is a path to a file outside the repository.

| Field | Meaning |
| --- | --- |
| `enabled` | `false` exits 0 without opening any secret file or socket and sends no receipt |
| `mode` | `dry-run` does everything except the review POST and writes would-be bodies; `live` posts |
| `ak_url` | AK origin (https, or http on loopback) |
| `ak_credential_file` | `MC_URL`/`MC_TOKEN` literal assignments, parsed like `scripts/import-velocity.py`. `MC_URL` must match `ak_url`. The token is `MC_TOKEN` or an `akc_` credential with `progress:read` and `status:write` |
| `github_app_id` | the Claude reviewer App's id |
| `github_app_key_file` | the App's private key (PEM). Only `openssl` reads it; its path is the only part in argv |
| `registry_path` | fleet identities registry: `{"identities": [{"login", "vendor", "tier"}]}`, lower-case logins |
| `state_dir` | ledgers, receipts, would-be bodies, the lock |
| `queues` | non-empty `[{queue, repo}]`; queue ids unique across all repos |
| `lenses` | optional; allowlisted values in allowlist order, without `adversarial` (added on Tier C) |
| `model_mid` / `model_top` | `--model` for Tier A/B and Tier C (the example uses the CLI aliases `sonnet` and `opus`) |
| `claude_path` | default `claude` (resolved on `PATH`) |
| `claude_timeout_seconds` | default 900 |
| `claude_oauth_token_file` | a file holding a token from `claude setup-token`. It is passed only as `CLAUDE_CODE_OAUTH_TOKEN` in the subprocess environment |
| `openssl_path` | default `/usr/bin/openssl` |
| `daily_cap_usd` | required, no default; decimal USD from `total_cost_usd` |
| `daily_max_reviews` | default 40; counts every charged Claude invocation |
| `max_clone_bytes` | default 200000000; `size-pack` × 1024 after fetch |
| `max_diff_lines` | default 5000; GitHub `additions + deletions`, checked before clone |
| `schedule_minutes` | default 15; the receipt's `scheduled_at` is the run start floored to this |

## What the subprocess can do

The argv is fixed (AC 86). The prompt goes on stdin and `cwd` is the clone:

```
/usr/bin/sandbox-exec -p <rendered sandbox.sb> <claude_path> -p --output-format json --model <model>
  --permission-mode plan --strict-mcp-config --mcp-config {"mcpServers":{}}
  --allowedTools Read Grep Glob "Bash(git log:*)" "Bash(git diff:*)" "Bash(git show:*)"
    "Bash(git blame:*)" "Bash(git ls-files:*)" "Bash(ls:*)"
  --disallowedTools Edit Write NotebookEdit WebFetch WebSearch Agent "Bash(gh:*)" "Bash(curl:*)"
    "Bash(wget:*)" "Bash(git push:*)" "Bash(git commit:*)" "Bash(git reset:*)" "Bash(git checkout:*)" "Bash(rm:*)"
```

The environment is built from scratch: an isolated `HOME`, `CLAUDE_CONFIG_DIR` and `TMPDIR` inside
the run's temporary directory, plus the OAuth token. `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`,
the installation token and the AK token are never present.
[`sandbox.sb`](sandbox.sb) denies reads and writes under `/Users`, `/private/var/folders`,
`/private/tmp`, `/Volumes` and `/opt/homebrew/etc`. The exceptions are the clone, the isolated
HOME, and (read-only) the Claude CLI install directory. Parent directories get metadata only.
Everything else on disk stays readable, so the App key, AK credential, OAuth token file, registry
and `state_dir` must resolve (after symlinks) under one of the denied roots, for example
`~/.config/claude-reviewer/`. The runner checks this before any review and refuses the run
otherwise (exit 78).
The runner does not run the PR's tests; green CI is already a readiness condition.

Git runs with `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, an empty global config in the
isolated HOME and an empty `credential.helper`. Only the https protocol is allowed. Hooks go to
`/dev/null`. The installation token travels only as `http.extraHeader` through
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`. It never appears in argv, a remote
URL or a config file.

## Evidence body

The model returns JSON only:
`{lenses: {<lens>: {status: cleared|finding, summary}}, findings: [{severity, path, line, summary}]}`.
The runner rejects the whole result for any of these:

- duplicate keys, non-finite numbers, or unknown or missing fields or lenses;
- empty or over-500-character strings, or control characters;
- the strings `review-evidence:v1`, `Review evidence`, `Reviewed head`, `VERDICT`, `<!--` or
  `-->` anywhere in model text;
- more than 100 findings, a non-normalized repo-relative path, or a non-positive line.

A single fenced ```` ```json ```` block is unwrapped; any other surrounding text is rejected. Any
`critical`/`high` finding, or any lens with status `finding`, gives `VERDICT: REQUEST_CHANGES`.
Otherwise the verdict is `APPROVE`. `result: pass` appears iff the verdict is `APPROVE`.

```
<!-- review-evidence:v1
head-sha: <head SHA reviewed>
result: pass|fail
-->
## Review evidence
Reviewed head: <head SHA>
Reviewer: <registered bot login> (vendor claude)
Tier: <A|B|C>
- <lens>: cleared | <finding summary>      (one line per configured lens, in order; adversarial on Tier C)
### Findings
- <severity> <path>:<line> <finding>       (or "- none")
VERDICT: APPROVE | REQUEST_CHANGES
```

The review is submitted with `event: COMMENT`, so the App never counts as a GitHub approval.
The verdict lives in the body. On Tier C a Claude review is one evidence unit, never a full
review. The receipt counts those posts as `tier_c_partial`, because the gate also needs a second
vendor and a top-tier identity.

## Reducer caveat

A posted review is **not** evidence that Agent Kontrol recorded it. `src/lib/reducers.ts` records
`review-evidence` only after a `pull_request_review.submitted` webhook reaches
`POST /api/webhooks/github`. The reducer then re-reads the pull and records the review only when
the review's head is the pull's current head. All of that happens only with `MC_REDUCERS`
enabled, which stays as the owner set it. Per D1, if the App does not deliver
`pull_request_review` webhooks, the reducer path is informational only. Neither a successful
POST nor the receipt claims reducer recording; the receipt reports only the HTTP outcome of the
post.

## Failure table

Outcomes are mutually exclusive per candidate. The runner records the outcome for the affected
repo or PR in `state_dir/outcomes.jsonl` and in the receipt counter, then continues with the
next candidate and with independent queues. A rate limit with `Retry-After` ≤ 60 s is honoured
once (one sleep, one resend); a second rate limit, or a longer wait, is `rate_limit`. A redirect
is never followed and counts `github_error`, as does a transport error or a malformed 2xx body.

| Call | Credential | Status / condition | Outcome |
| --- | --- | --- | --- |
| `GET /app` | App JWT | 401 | `token_revoked`, exit 78 |
| `GET /app` | App JWT | any other non-2xx, redirect, missing or malformed `slug` | `github_error`, exit 78 |
| `GET /app` | App JWT | `openssl` missing or failing (cannot sign) | `not_installed`, exit 78 |
| `GET /app` | App JWT | login not registered with vendor `claude` | exit 78, nothing posted, one `error` event |
| `GET /repos/{o}/{r}/installation` | App JWT | 404, or no installation id | `not_installed` |
| `GET /repos/{o}/{r}/installation` | App JWT | 401 | `token_revoked` |
| `GET /repos/{o}/{r}/installation` | App JWT | 403 | `missing_permission` |
| `GET /repos/{o}/{r}/installation` | App JWT | 429 or secondary rate limit | `rate_limit` |
| `GET /repos/{o}/{r}/installation` | App JWT | other non-2xx | `github_error` |
| `POST /app/installations/{id}/access_tokens` | App JWT | 401, 403, 404, or no token in the body | `token_revoked` |
| `POST /app/installations/{id}/access_tokens` | App JWT | 429 or secondary rate limit | `rate_limit` |
| `POST /app/installations/{id}/access_tokens` | App JWT | other non-2xx | `github_error` |
| `GET /repos/{o}/{r}/pulls/{n}` | installation | 404 | `not_ready` (absent pull) |
| `GET /repos/{o}/{r}/pulls/{n}` | installation | closed or draft / head ≠ queued head | `not_ready` / `head_moved` |
| `GET /repos/{o}/{r}/pulls/{n}/commits` | installation | any failure, or `commits` ≥ 250 | `provenance_unknown` |
| `GET /repos/{o}/{r}/pulls/{n}` and `/reviews` | installation | 401 | `token_revoked` |
| `GET /repos/{o}/{r}/pulls/{n}/reviews` | installation | 403 or 404 | `missing_permission` |
| `GET /repos/{o}/{r}/pulls/{n}` | installation | 403 | `missing_permission` |
| any repository read | installation | 429 or secondary rate limit | `rate_limit` |
| any repository read | installation | other non-2xx | `github_error` |
| clone fetch (`git fetch` over HTTPS) | installation (`http.extraHeader`) | HTTP 401 | `token_revoked` |
| clone fetch | installation | HTTP 403 or 404 | `missing_permission` |
| clone fetch | installation | HTTP 429 | `rate_limit` |
| clone fetch | installation | any other failure | `github_error` |
| clone fetch | installation | fetched head ≠ queued head | `head_moved` |
| `POST /repos/{o}/{r}/pulls/{n}/reviews` | installation | 401 | `token_revoked` |
| `POST /repos/{o}/{r}/pulls/{n}/reviews` | installation | 403 | `missing_permission` |
| `POST /repos/{o}/{r}/pulls/{n}/reviews` | installation | 404 | `not_installed` |
| `POST /repos/{o}/{r}/pulls/{n}/reviews` | installation | 429 or secondary rate limit | `rate_limit` |
| `POST /repos/{o}/{r}/pulls/{n}/reviews` | installation | other non-2xx | `github_error` |

Other per-candidate outcomes: `same_vendor`, `provenance_unknown`, `invalid_input` (several tier
labels, or Tier C without a `top` registration), `already_reviewed`, `escalate` (size limits, or
two invalid outputs at one head), `invalid_output`, `invalid_cost`, and `not_installed`
(`claude` missing or unstartable: no further Claude invocations that run). `budget_stop` is a
0/1 flag; the remaining items wait for the next UTC day.

## Money

`total_cost_usd` and `daily_cap_usd` are parsed as `decimal.Decimal` from the JSON text. Spend
goes to `state_dir/spend-YYYY-MM-DD.json` (UTC), which is atomically replaced under the run lock.
Every invocation with a valid cost is charged, even if its output is later rejected. Before each
review the runner stops (`budget_stop`) in three cases:

- spend + the median of the last ten charged invocations would exceed the cap (the estimate is
  $1.00 with fewer than ten);
- the day's invocation count has reached `daily_max_reviews`;
- the day is halted.

A missing, negative or non-finite cost halts the day (`invalid_cost`). So does any invocation
that ends without a readable cost (timeout, non-zero exit, malformed envelope), counted
`invalid_output`. Fail closed.

## State dir

| File | Contents |
| --- | --- |
| `reviews.jsonl` | one line per successful live POST, written before it is counted `posted`. A review found on GitHub without a line gets a `reconciled: true` line first |
| `would-be.jsonl`, `would-be/*.md` | dry-run records and bodies. A head with a would-be record is not re-reviewed in dry-run |
| `spend-YYYY-MM-DD.json` | the daily spend ledger |
| `invalid-output.json` | invalid-output count per (repo, PR, head); escalates at 2 |
| `outcomes.jsonl` | per-candidate outcomes, rotated at 10,000 lines |
| `receipts.jsonl` | one line per receipt attempt: `scheduled_at`, `observed_at`, `receipt_http_status`, `app_login`, `mode`, `detail`. This is the export `retirement_report` reads |
| `errors.log` | bounded local error lines (fixed categories only) |

Ledger lines carry `repo`, `number`, `head_sha`, `tier`, `green_since`, `posted_at`,
`waited_minutes`, `app_login`, `provenance`, `phase` and `scheduled_at`. No file holds prompt text,
diff content or a secret.

The receipt (`agent_id: claude-reviewer`, `kind: status`) carries only bounded non-negative
integers and ISO timestamps in `detail`: every outcome counter above, plus `ready`, `reviewed`,
`posted`, `tier_c_partial`, `budget_stop`, `spend_microusd_today`, `oldest_ready_minutes`,
`sla_breaches`, `scheduled_at` and `started_at`. SLA breaches are Tier A/B over 4 h and Tier C
over 12 h since `green_since`; a null `green_since` never breaches. This runner sends no other
message.

## Tests

```bash
python3 -m unittest tests.unit.test_claude_reviewer -v
```

The tests use a loopback AK/GitHub stub, a `file://` bare repository, a stub `claude`, a stub
`sandbox-exec`, and a throwaway RSA key verified with `openssl dgst -verify`. They fail on any
non-loopback socket, any `gh` invocation or any secret in argv. They also run the secret scan
and the dry-run no-review-POST check. The real `sandbox-exec` read-boundary test runs only on
macOS. **No local test, CI run or dry-run proves the real App, registry entry, trust list or
live identity.**

## Activation (owner only)

None of this is done by a PR, a lane or CI.

1. **D1**: create the GitHub App (Pull requests: write, Contents: read, Checks: read, Metadata:
   read) and install it on the repos to review. Register its `<slug>[bot]` login in the fleet
   identities registry as vendor `claude`, tier `top`. Record whether it delivers
   `pull_request_review` webhooks to `POST /api/webhooks/github`.
2. **D2**: set `daily_cap_usd`.
3. **D3**: choose the host (MacBook or Mac Mini).
4. **D5**: decide which repos' evidence gates trust the App (separate per-repo PRs).
5. Put the App key, the AK credential (`progress:read` + `status:write`) and the
   `claude setup-token` output in files readable only by the scheduler's account. Keep them out
   of the Claude CLI install directory; the sandbox denies the model everything else.
6. Write the config with `"enabled": true, "mode": "dry-run"`. Install one of the inert
   examples (`docs/examples/claude-reviewer.launchd.plist.example` or
   `docs/examples/claude-reviewer.cron.example`) by hand.
7. Switch to `live` only after the retirement sequence below says so and D1, D2, D3, D4 and D5
   are recorded as resolved on #176.

## Retiring the desktop `pr-review-loop`

Owner-run operational acceptance; it cannot make a PR or CI green. A missing run is a failure.
Tier C PRs reviewed by the runner do not count as fully reviewed.

1. **Dry-run phase.** Run in `dry-run` on the 15-minute schedule for 7 consecutive days while the
   desktop `pr-review-loop` stays enabled. Every scheduled run needs a receipt, and the would-be
   bodies go in the state dir. Build the artifact:
   ```bash
   python3 -m agents.reviewer.retirement_report --schedule schedule-dry-run.txt \
     --state-dir <state_dir> --receipts <state_dir>/receipts.jsonl --phase dry-run --out dry-run.jsonl
   ```
   `--schedule` lists every `scheduled_at` (ISO UTC, one per line). Exit 0 means every scheduled
   run has a receipt line (AC 92). Check `receipt_http_status` in each record: a non-2xx status
   means the run happened but AK did not accept its receipt. Exit 1 means runs are missing
   (records are still written with `missing_run: true`). Exit 2 means malformed input.
   Reconciled `reviews.jsonl` lines (`reconciled: true`) are never counted as posts (AC 84).
2. **Owner review.** Read `dry-run.jsonl` and compare the `would_be` bodies with the desktop loop's
   comments on the same PRs.
3. **Switch.** Disable the `pr-review-loop` scheduled task in the Claude desktop app. Then set
   the runner to `live` the same day. Move `~/.claude/pr-review-loop/` to
   `~/.claude/fleet/archive/pr-review-loop-<date>/`, keeping the logs and `state.json`, and record
   the move in Cortex.
4. **Live acceptance.** Seven consecutive `live` days (`--phase live`), all of:
   - [ ] a receipt for every scheduled run (a missing run is a failure, recorded with
         `missing_run: true`);
   - [ ] ≥ 10 evidence reviews posted, every one by the registered Claude App login, none on a PR
         with a Claude-resolved commit;
   - [ ] zero reviews posted under a User-type login by the runner;
   - [ ] no review-SLA breach where the runner had budget left and the queue was complete.

If live acceptance fails, re-enable the desktop loop and set the runner back to `dry-run`.
Nothing is deleted.

## Rollback

Set `"enabled": false` and remove any schedule first. Keep `state_dir` and the spend ledgers for
audit. If credentials are suspect, uninstall the App or revoke its key. List every posted review
from `reviews.jsonl` (repo, PR, head SHA, bot login) on #176 for the owner to dismiss. Rollback
never deletes review history.
