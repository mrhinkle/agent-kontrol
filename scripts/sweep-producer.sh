#!/usr/bin/env bash
# sweep-producer.sh — sweeper evidence (#79) for one repository.
#
# Measures the repository on GitHub and POSTs two observations to /api/ingest:
#   sweep.queue        open issues classified ready / raw from the explicit config
#   sweep.pr_snapshot  every open PR (at most 200) with head, checks, and review start
#
#   ./sweep-producer.sh --repo owner/name             # one collection, posts when enabled
#   ./sweep-producer.sh --repo owner/name --dry-run   # print the envelopes, post nothing
#
# Disabled by default. Nothing is posted unless the config file exists and sets
# "enabled": true. --dry-run never posts and never writes state. A repo that the
# config does not map is unconfigured: nothing is emitted and readiness is never
# guessed. There is no backfill: an observation is always the current state.
#
# Config: MC_SWEEP_PRODUCER_CONFIG, else sweep-producer.config.json beside this
# script. See sweep-producer.config.example.json; the example is not installed policy.
# Credentials: MC_URL and MC_TOKEN from the environment or MC_ENV_FILE.
# State: MC_SWEEP_STATE_DIR (per-subject sequence numbers and lock files; never a token).
# MC_SWEEP_LOCK_WAIT: seconds to wait for a subject held by another run (default 300).
# Requires: gh (authenticated), jq, curl, perl (bounded timeouts and the flock(2) subject lock).
#
# Every failure is a newer complete:false observation, never a zero. An unacked
# POST is retried later with the same seq and the exact same bytes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${MC_SWEEP_PRODUCER_CONFIG:-$SCRIPT_DIR/sweep-producer.config.json}"
ENV_FILE="${MC_ENV_FILE:-$HOME/.claude/mission-control.env}"
STATE_DIR="${MC_SWEEP_STATE_DIR:-$HOME/.local/state/agent-kontrol/sweep-producer}"
GH_TIMEOUT="${MC_SWEEP_GH_TIMEOUT:-60}"
HTTP_TIMEOUT="${MC_SWEEP_HTTP_TIMEOUT:-20}"
LOCK_WAIT="${MC_SWEEP_LOCK_WAIT:-300}"

ISSUE_CAP=1000   # open issues measured per repo; more is an incomplete observation
PR_CAP=200       # the intake's PRS_MAX
REFS_CAP=50      # the intake's REFS_MAX; counts stay exact

log() { printf '[%s] sweep-producer: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

REPO=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO="${2:-}"; shift 2 || { echo "--repo needs owner/name" >&2; exit 2; } ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (there is no backfill mode)" >&2; exit 2 ;;
  esac
done
if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$ ]]; then
  echo "--repo owner/name is required" >&2; exit 2
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  log "not configured (no $CONFIG_FILE); nothing emitted"; exit 0
fi

# ----------------------------------------------------------------- config

CONFIG_OK='
  def strs: type == "array" and all(.[]; type == "string" and length > 0 and length <= 100);
  type == "object"
  and (.enabled | type == "boolean")
  and (.source | type == "string" and test("^[a-z0-9][a-z0-9._-]{0,63}$"))
  and ((.agent_id // "x") | type == "string" and length > 0 and length <= 100)
  and ((.stale_after_minutes // 30) | type == "number" and . == floor and . >= 5 and . <= 1440)
  and (.repos | type == "object")
  and all(.repos[];
    type == "object"
    and (.queue | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"))
    and (.ready_labels | strs and length > 0)
    and (.blocked_labels | strs)
    and ((.raw_exclude_labels // []) | strs)
    and ((.required_checks // []) | strs)
    and ((.review_start // {status_context: "x"}) | type == "object" and (.status_context | type == "string" and length > 0 and length <= 100)))
'
if ! jq -e "$CONFIG_OK" "$CONFIG_FILE" >/dev/null 2>&1; then
  log "config $CONFIG_FILE is invalid; nothing emitted"; exit 3
fi
ENABLED="$(jq -r '.enabled' "$CONFIG_FILE")"
if [[ "$ENABLED" != "true" && $DRY_RUN -eq 0 ]]; then
  log "disabled (config enabled is not true); nothing emitted"; exit 0
fi

# Repo keys match case-insensitively, the way GitHub does. Label and context
# names are compared lower-cased. More than one matching key is ambiguous.
REPO_CFG="$(jq -c --arg r "$REPO" '
  [.repos | to_entries[] | select((.key | ascii_downcase) == ($r | ascii_downcase)) | .value] as $m
  | if ($m | length) == 1 then $m[0] else null end' "$CONFIG_FILE")"
if [[ "$REPO_CFG" == "null" ]]; then
  log "$REPO is not mapped in the config; unconfigured, nothing emitted"; exit 0
fi
SOURCE="$(jq -r '.source' "$CONFIG_FILE")"
AGENT_ID="$(jq -r '.agent_id // .source' "$CONFIG_FILE")"
STALE_AFTER="$(jq -r '.stale_after_minutes // 30' "$CONFIG_FILE")"
OWNER="${REPO%%/*}"
NAME="${REPO#*/}"

if [[ $DRY_RUN -eq 0 ]]; then
  # Same rule as collect-progress.sh: an explicit environment value wins over the file.
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line#"${line%%[![:space:]]*}"}"
      [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
      key="${line%%=*}"; val="${line#*=}"
      val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
      case "$key" in
        MC_URL)   : "${MC_URL:=$val}" ;;
        MC_TOKEN) : "${MC_TOKEN:=$val}" ;;
      esac
    done < "$ENV_FILE"
    unset line key val
  fi
  if [[ -z "${MC_URL:-}" || -z "${MC_TOKEN:-}" ]]; then
    log "MC_URL or MC_TOKEN is not set; nothing emitted"; exit 3
  fi
  if [[ ! "$MC_URL" =~ ^https?:// ]]; then
    log "MC_URL must be an http(s) URL; nothing emitted"; exit 3
  fi
  if [[ "$MC_TOKEN" == *'"'* || "$MC_TOKEN" == *\\* ]]; then
    log "MC_TOKEN has a character this script cannot send; nothing emitted"; exit 3
  fi
fi

for bin in gh jq curl perl; do
  command -v "$bin" >/dev/null || { log "missing required command: $bin"; exit 1; }
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sweep-producer.XXXXXX")"
# The subject lock is a kernel lock on fd 9 (see lock_subject). Exit closes the
# fd and releases it; cleanup never removes a lock file.
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# bounded <seconds> <cmd...> — SIGALRM survives exec, so the command is killed at the limit.
# fd 9 is closed for the child so an orphaned gh never holds the subject lock.
bounded() {
  local secs="$1"; shift
  perl -e 'alarm shift @ARGV; exec @ARGV or exit 127' "$secs" "$@" 9>&-
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ------------------------------------------------------------------ GitHub

ISSUES_QUERY='query SweepIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number labels(first: 50) { totalCount nodes { name } } }
    }
  }
}'

# The same read again, named apart so a log or fixture can tell the passes apart.
ISSUES_VERIFY_QUERY="${ISSUES_QUERY/query SweepIssues(/query SweepIssuesVerify(}"

PRS_QUERY='query SweepPrs($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url isDraft createdAt mergeable headRefOid
        commits(last: 1) { nodes { commit { oid statusCheckRollup {
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        } } } }
        reviews(last: 100) { totalCount nodes { state commit { oid } } }
      }
    }
  }
}'

PR_HEADS_QUERY='query SweepPrHeads($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number headRefOid }
    }
  }
}'

GH_ERR=""
# gh_graphql <query> <after> <outfile> — 0 with a parsed page, else GH_ERR is a short
# classified reason. stderr and the body are never echoed.
gh_graphql() {
  local query="$1" after="$2" out="$3" errf rc
  errf="$(mktemp "$TMP_DIR/gh-err.XXXXXX")"
  if [[ -n "$after" ]]; then
    bounded "$GH_TIMEOUT" gh api graphql -f "query=$query" -f "owner=$OWNER" -f "name=$NAME" -f "after=$after" >"$out" 2>"$errf"
  else
    bounded "$GH_TIMEOUT" gh api graphql -f "query=$query" -f "owner=$OWNER" -f "name=$NAME" >"$out" 2>"$errf"
  fi
  rc=$?
  if [[ $rc -ne 0 ]]; then
    if grep -qi 'rate limit' "$errf" "$out" 2>/dev/null; then GH_ERR="GitHub rate limited"
    elif [[ $rc -eq 142 ]]; then GH_ERR="GitHub request timed out after ${GH_TIMEOUT}s"
    else GH_ERR="GitHub API request failed (exit $rc)"; fi
    return 1
  fi
  if ! jq -e 'type == "object" and (has("errors") | not) and (.data.repository | type == "object")' "$out" >/dev/null 2>&1; then
    if jq -e '[.errors[]?.type] | any(. == "RATE_LIMITED")' "$out" >/dev/null 2>&1; then GH_ERR="GitHub rate limited"
    else GH_ERR="malformed GitHub response"; fi
    return 1
  fi
}

# ------------------------------------------------------------ observations

ISSUES_PAGE_OK='
  .data.repository.issues as $i
  | ($i.totalCount | type == "number")
  and ($i.pageInfo.hasNextPage | type == "boolean")
  and (($i.pageInfo.hasNextPage | not) or ($i.pageInfo.endCursor | type == "string" and length > 0))
  and ($i.nodes | type == "array")
  and all($i.nodes[];
    (.number | type == "number" and . > 0 and . == floor)
    and (.labels.totalCount | type == "number")
    and (.labels.nodes | type == "array")
    and all(.labels.nodes[]; .name | type == "string"))
'

# Input: every collected issue node. Ready has a ready label and no blocked
# label. Raw has none of the ready, blocked, or raw-exclude labels. Counts are
# the whole measured set; refs are the lowest numbers, capped.
CLASSIFY='
  def lc: ascii_downcase;
  ($cfg.ready_labels | map(lc)) as $R
  | ($cfg.blocked_labels | map(lc)) as $B
  | (($cfg.raw_exclude_labels // []) | map(lc)) as $X
  | if (map(.number) | unique | length) != length then {error: "an issue appeared twice while paging"}
    elif length != $first or $first != $last then {error: "the open issue set changed during collection"}
    elif any(.[]; .labels.totalCount > (.labels.nodes | length)) then {error: "an issue has more than 50 labels"}
    else
      (map({n: .number, l: [.labels.nodes[].name | lc]}) | sort_by(.n)) as $all
      | ($all | map(select(any(.l[]; IN($R[])) and (any(.l[]; IN($B[])) | not)))) as $ready
      | ($all | map(select((any(.l[]; IN($R[]) or IN($B[]) or IN($X[]))) | not))) as $raw
      | {
          ready: {count: ($ready | length), refs: ($ready[:$cap] | map("#\(.n)"))},
          raw: {count: ($raw | length), refs: ($raw[:$cap] | map("#\(.n)"))}
        }
    end
'

# collect_queue <outfile> — writes the observation body without seq.
# page_issues <query> <nodes-file> — 0 with every open issue node; else ISSUE_ERR.
# ISSUE_FIRST and ISSUE_LAST are the totalCount on the first and last page.
ISSUE_ERR=""; ISSUE_FIRST=""; ISSUE_LAST=""
page_issues() {
  local query="$1" nodes="$2" after="" page=0 out
  ISSUE_FIRST=""; ISSUE_LAST=""
  : >"$nodes"
  while :; do
    page=$((page + 1))
    if (( page > ISSUE_CAP / 100 + 1 )); then ISSUE_ERR="more than $ISSUE_CAP open issues"; return 1; fi
    out="$TMP_DIR/issues-$page.json"
    if ! gh_graphql "$query" "$after" "$out"; then ISSUE_ERR="$GH_ERR"; return 1; fi
    if ! jq -e "$ISSUES_PAGE_OK" "$out" >/dev/null 2>&1; then ISSUE_ERR="malformed GitHub response"; return 1; fi
    # Every read, the verification read included, must carry each issue's whole label set.
    if jq -e 'any(.data.repository.issues.nodes[]; .labels.totalCount != (.labels.nodes | length))' "$out" >/dev/null 2>&1; then
      ISSUE_ERR="an issue has more than 50 labels"; return 1
    fi
    ISSUE_LAST="$(jq '.data.repository.issues.totalCount' "$out")"
    [[ -z "$ISSUE_FIRST" ]] && ISSUE_FIRST="$ISSUE_LAST"
    if (( ISSUE_LAST > ISSUE_CAP )); then ISSUE_ERR="more than $ISSUE_CAP open issues"; return 1; fi
    jq -c '.data.repository.issues.nodes[]' "$out" >>"$nodes"
    [[ "$(jq -r '.data.repository.issues.pageInfo.hasNextPage' "$out")" == "true" ]] || return 0
    after="$(jq -r '.data.repository.issues.pageInfo.endCursor' "$out")"
  done
}

# Issue numbers, label totals, and lower-cased label names, sorted: what classification reads.
ISSUE_KEY='map([.number, .labels.totalCount, ([.labels.nodes[].name | ascii_downcase] | sort)]) | sort'

# collect_queue <outfile> — writes the observation body without seq. The set
# is read twice; it is complete only when both reads match exactly, so an
# issue that closed, opened, or changed labels while paging is never mixed in.
collect_queue() {
  local result="$1" nodes="$TMP_DIR/issues.jsonl" again="$TMP_DIR/issues-verify.jsonl" first last counts observed queue
  observed="$(now_iso)"
  queue="$(jq -r '.queue | ascii_downcase' <<<"$REPO_CFG")"
  queue_fail() {
    jq -nc --arg source "$SOURCE" --arg queue "$queue" --arg repo "$REPO" --arg at "$observed" --arg err "$1" \
      --argjson stale "$STALE_AFTER" \
      '{source: $source, queue: $queue, classification: "issue_dispatch", repo: $repo, observed_at: $at,
        complete: false, error: ($err | .[:300]), stale_after_minutes: $stale}' >"$result"
  }
  if ! page_issues "$ISSUES_QUERY" "$nodes"; then queue_fail "$ISSUE_ERR"; return 0; fi
  first="$ISSUE_FIRST"; last="$ISSUE_LAST"
  if ! page_issues "$ISSUES_VERIFY_QUERY" "$again"; then queue_fail "$ISSUE_ERR"; return 0; fi
  if [[ "$ISSUE_FIRST" != "$last" || "$ISSUE_LAST" != "$last" ]] \
    || [[ "$(jq -sc "$ISSUE_KEY" "$nodes" 2>/dev/null)" != "$(jq -sc "$ISSUE_KEY" "$again" 2>/dev/null)" ]]; then
    queue_fail "the open issue set changed during collection"; return 0
  fi
  counts="$(jq -sc --argjson cfg "$REPO_CFG" --argjson first "$first" --argjson last "$last" --argjson cap "$REFS_CAP" "$CLASSIFY" "$nodes")"
  if [[ -z "$counts" ]]; then queue_fail "classification failed"; return 0; fi
  if jq -e 'has("error")' >/dev/null <<<"$counts"; then queue_fail "$(jq -r '.error' <<<"$counts")"; return 0; fi
  jq -nc --arg source "$SOURCE" --arg queue "$queue" --arg repo "$REPO" --arg at "$observed" \
    --argjson stale "$STALE_AFTER" --argjson c "$counts" \
    '{source: $source, queue: $queue, classification: "issue_dispatch", repo: $repo, observed_at: $at,
      complete: true, ready: $c.ready, raw: $c.raw, stale_after_minutes: $stale}' >"$result"
}

PRS_PAGE_OK='
  def sha: type == "string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$");
  .data.repository.pullRequests as $p
  | ($p.totalCount | type == "number")
  and ($p.pageInfo.hasNextPage | type == "boolean")
  and (($p.pageInfo.hasNextPage | not) or ($p.pageInfo.endCursor | type == "string" and length > 0))
  and ($p.nodes | type == "array")
  and all($p.nodes[];
    (.number | type == "number" and . > 0 and . == floor)
    and (.headRefOid | sha)
    and (.isDraft | type == "boolean")
    and (.createdAt | type == "string" and test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$"))
    and (.mergeable | IN("MERGEABLE", "CONFLICTING", "UNKNOWN"))
    and ((.commits.nodes // []) | type == "array")
    and ((.reviews.nodes // []) | type == "array"))
'

PR_HEADS_PAGE_OK='
  .data.repository.pullRequests as $p
  | ($p.totalCount | type == "number")
  and ($p.pageInfo.hasNextPage | type == "boolean")
  and (($p.pageInfo.hasNextPage | not) or ($p.pageInfo.endCursor | type == "string" and length > 0))
  and ($p.nodes | type == "array")
  and all($p.nodes[]; (.number | type == "number") and (.headRefOid | type == "string"))
'

# One PR node to one intake row. Checks are the configured required contexts
# on the commit GitHub reports for the head: a context that is missing, a
# truncated context list, or no configured list is "unknown", never green. A
# published review counts only at the current head. started:false needs the
# configured review-start status context and a complete context list at the
# head; without that source, review is omitted (unknown).
PR_ROW='
  def lc: ascii_downcase;
  def sha: type == "string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$");
  def ctxstate:
    if .__typename == "CheckRun" then
      (if .status != "COMPLETED" then "pending"
       elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "success"
       else "failure" end)
    elif .__typename == "StatusContext" then
      (if .state == "SUCCESS" then "success" elif (.state | IN("PENDING", "EXPECTED")) then "pending" else "failure" end)
    else "unknown" end;
  def ctxname: (if .__typename == "CheckRun" then .name elif .__typename == "StatusContext" then .context else null end)
    | if type == "string" then lc else null end;
  (($cfg.required_checks // []) | map(lc)) as $req
  | (($cfg.review_start.status_context // null) | if . == null then null else lc end) as $rctx
  | .headRefOid as $head
  | (.commits.nodes[0].commit // null) as $c
  | (if $c != null and ($c.oid | sha) then $c.oid else null end) as $coid
  | (if $coid == null then {complete: false, list: []}
     elif $c.statusCheckRollup == null then {complete: true, list: []}
     elif ($c.statusCheckRollup.contexts.nodes | type) != "array" then {complete: false, list: []}
     else {complete: ($c.statusCheckRollup.contexts.pageInfo.hasNextPage == false),
           list: [$c.statusCheckRollup.contexts.nodes[] | {n: ctxname, s: ctxstate}]} end) as $x
  | (if ($req | length) == 0 or ($x.complete | not) or $coid != $head then "unknown"
     else [$req[] as $r | [$x.list[] | select(.n == $r) | .s]] as $per
       | if any($per[]; length == 0) or any($per[][]; . == "unknown") then "unknown"
         elif any($per[][]; . == "failure") then "failure"
         elif any($per[][]; . == "pending") then "pending"
         else "success" end
     end) as $state
  | ((.reviews.nodes // []) | any(.[]; .state != "PENDING" and .commit.oid == $head)) as $reviewedAtHead
  | (if $reviewedAtHead then {started: true, head_sha: $head}
     elif $rctx != null and $x.complete and $coid == $head then
       (if any($x.list[]; .n == $rctx) then {started: true, head_sha: $head} else {started: false, head_sha: $head} end)
     else null end) as $review
  | ((.title // "") | if type == "string" then gsub("[\u0000-\u001f\u007f]"; " ") | .[:100] else "" end) as $title
  | {
      number,
      title: (if $title == "" then null else $title end),
      url: (if (.url | type) == "string" and (.url | startswith("https://")) and (.url | length) <= 300 then .url else null end),
      draft: .isDraft,
      opened_at: .createdAt,
      mergeable: (.mergeable | lc),
      head_sha: $head,
      required_checks: (if $coid == null then {state: "unknown"} else {state: $state, head_sha: $coid} end),
      review: $review
    }
  | with_entries(select(.value != null))
'

# collect_prs <outfile> — writes the snapshot body without seq.
collect_prs() {
  local result="$1" nodes="$TMP_DIR/prs.jsonl" heads="$TMP_DIR/heads.jsonl" after="" page=0 first="" total out observed rows
  observed="$(now_iso)"
  pr_fail() {
    jq -nc --arg source "$SOURCE" --arg repo "$REPO" --arg at "$observed" --arg err "$1" --argjson stale "$STALE_AFTER" \
      '{source: $source, repo: $repo, observed_at: $at, complete: false, error: ($err | .[:300]), stale_after_minutes: $stale}' >"$result"
  }
  : >"$nodes"
  while :; do
    page=$((page + 1))
    if (( page > PR_CAP / 50 + 1 )); then pr_fail "more than $PR_CAP open PRs"; return 0; fi
    out="$TMP_DIR/prs-$page.json"
    if ! gh_graphql "$PRS_QUERY" "$after" "$out"; then pr_fail "$GH_ERR"; return 0; fi
    if ! jq -e "$PRS_PAGE_OK" "$out" >/dev/null 2>&1; then pr_fail "malformed GitHub response"; return 0; fi
    total="$(jq '.data.repository.pullRequests.totalCount' "$out")"
    [[ -z "$first" ]] && first="$total"
    if (( total > PR_CAP )); then pr_fail "more than $PR_CAP open PRs"; return 0; fi
    jq -c '.data.repository.pullRequests.nodes[]' "$out" >>"$nodes"
    [[ "$(jq -r '.data.repository.pullRequests.pageInfo.hasNextPage' "$out")" == "true" ]] || break
    after="$(jq -r '.data.repository.pullRequests.pageInfo.endCursor' "$out")"
  done
  if ! jq -se --argjson first "$first" --argjson last "$total" \
      'length == $first and $first == $last and (map(.number) | unique | length) == length' "$nodes" >/dev/null 2>&1; then
    pr_fail "the open PR set changed during collection"; return 0
  fi

  # Second pass: the open set and every head must be unchanged since the first.
  : >"$heads"; after=""; page=0
  while :; do
    page=$((page + 1))
    if (( page > PR_CAP / 100 + 1 )); then pr_fail "more than $PR_CAP open PRs"; return 0; fi
    out="$TMP_DIR/heads-$page.json"
    if ! gh_graphql "$PR_HEADS_QUERY" "$after" "$out"; then pr_fail "$GH_ERR"; return 0; fi
    if ! jq -e "$PR_HEADS_PAGE_OK" "$out" >/dev/null 2>&1; then pr_fail "malformed GitHub response"; return 0; fi
    jq -c '.data.repository.pullRequests.nodes[] | [.number, .headRefOid]' "$out" >>"$heads"
    [[ "$(jq -r '.data.repository.pullRequests.pageInfo.hasNextPage' "$out")" == "true" ]] || break
    after="$(jq -r '.data.repository.pullRequests.pageInfo.endCursor' "$out")"
  done
  if [[ "$(jq -sc 'sort' "$heads")" != "$(jq -sc 'map([.number, .headRefOid]) | sort' "$nodes")" ]]; then
    pr_fail "a PR head or the open PR set moved during collection"; return 0
  fi

  if ! rows="$(jq -sc --argjson cfg "$REPO_CFG" "map($PR_ROW) | sort_by(.number)" "$nodes" 2>/dev/null)" || [[ -z "$rows" ]]; then
    pr_fail "malformed GitHub response"; return 0
  fi
  jq -nc --arg source "$SOURCE" --arg repo "$REPO" --arg at "$observed" --argjson stale "$STALE_AFTER" --argjson prs "$rows" \
    '{source: $source, repo: $repo, observed_at: $at, complete: true, stale_after_minutes: $stale, prs: $prs}' >"$result"
}

# ----------------------------------------------------------- state and POST

subject_id() {
  if command -v shasum >/dev/null; then printf '%s' "$1" | shasum -a 256 | cut -c1-32
  else printf '%s' "$1" | sha256sum | cut -c1-32; fi
}

# lock_subject <id> — one producer per subject at a time, for the whole
# collect-and-post, so a later collection always gets the higher seq. This
# shell opens <id>.flock on fd 9 and perl takes flock(2) on that shared open
# file description, which stays locked after perl exits until this shell closes
# fd 9 or dies. The kernel releases it on any exit, so there is no owner file,
# no stale-owner recovery, and no window that strands the lock. The file is
# never removed: removing it would let two holders lock different inodes.
# Waits up to MC_SWEEP_LOCK_WAIT seconds (0 tries once); a waiter whose shell
# is killed stops within one poll. One lock at a time.
lock_subject() {
  exec 9>>"$STATE_DIR/$1.flock" || return 1
  if ! perl -MFcntl=:flock -MTime::HiRes=time -e '
      my ($wait, $shell) = @ARGV;
      exit 2 unless defined $wait && $wait =~ /^\d+$/;
      open(my $fh, ">>&=9") or exit 2;
      my $deadline = time + $wait;
      # A waiter whose producer died is orphaned (new parent): it gives up
      # rather than wait on, or take, the lock for nobody.
      until (getppid() == $shell && flock($fh, LOCK_EX | LOCK_NB)) {
        exit 1 if getppid() != $shell || time >= $deadline;
        select(undef, undef, undef, 0.2);
      }
      exit(getppid() == $shell ? 0 : 1)' "$LOCK_WAIT" "$$"; then
    exec 9>&-
    return 1
  fi
}

unlock_subject() { exec 9>&-; }

write_state() {  # write_state <file> <json> — atomic replace
  local tmp
  tmp="$(mktemp "$STATE_DIR/.state.XXXXXX")" || return 1
  printf '%s\n' "$2" >"$tmp" && mv -f "$tmp" "$1"
}

POST_RESULT=""
# post_body <body-file> — POST_RESULT is applied, replay, older, rejected:<code>, or retry:<why>.
post_body() {
  local body="$1" resp code
  resp="$(mktemp "$TMP_DIR/resp.XXXXXX")"
  # The substitution's subshell drops fd 9 first, so a run killed mid-POST
  # releases the subject lock without waiting for an orphaned curl.
  code="$(exec 9>&-; printf 'header = "Authorization: Bearer %s"\n' "$MC_TOKEN" |
    curl -sS -K - -o "$resp" -w '%{http_code}' --connect-timeout 5 --max-time "$HTTP_TIMEOUT" \
      -X POST "${MC_URL%/}/api/ingest" -H "Content-Type: application/json" --data-binary "@$body" 2>/dev/null)" || code="000"
  case "$code" in
    200)
      POST_RESULT="$(jq -r 'if .ok == true and (.outcome | IN("applied", "replay", "older")) then .outcome else "retry:unrecognized 200 body" end' "$resp" 2>/dev/null || echo "retry:unrecognized 200 body")" ;;
    000) POST_RESULT="retry:transport failure" ;;
    408|429|5??) POST_RESULT="retry:HTTP $code" ;;
    *) POST_RESULT="rejected:HTTP $code $(jq -r '.code // .error // "" | tostring | .[:60]' "$resp" 2>/dev/null || true)" ;;
  esac
}

# emit <kind> <subject> <collector-fn> — collect under the subject lock, assign
# the next seq, persist the exact body as pending, POST, then settle. A pending
# body from an earlier run is retried first, byte for byte.
emit() {
  local kind="$1" subject="$2" collector="$3" id state_file state last pending_seq body status=0
  id="$(subject_id "$kind|$subject")"
  state_file="$STATE_DIR/$id.json"

  if [[ $DRY_RUN -eq 1 ]]; then
    last="$(jq -r '.last_seq // 0' "$state_file" 2>/dev/null || echo 0)"
    "$collector" "$TMP_DIR/obs.json"
    jq -c --arg agent "$AGENT_ID" --arg kind "$kind" --argjson seq "$((last + 1))" \
      '{agent_id: $agent, kind: $kind, observation: (. + {seq: $seq})}' "$TMP_DIR/obs.json"
    return 0
  fi

  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR" 2>/dev/null
  if ! lock_subject "$id"; then log "$kind $subject: another producer holds the lock; skipped"; return 1; fi
  state="$(cat "$state_file" 2>/dev/null || echo '{}')"
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$state" || { log "$kind $subject: state file is unreadable; not posting"; unlock_subject "$id"; return 1; }
  last="$(jq -r '.last_seq // 0' <<<"$state")"

  if jq -e '.pending.body | type == "string"' >/dev/null <<<"$state"; then
    pending_seq="$(jq -r '.pending.seq' <<<"$state")"
    jq -j '.pending.body' <<<"$state" >"$TMP_DIR/pending.json"
    post_body "$TMP_DIR/pending.json"
    case "$POST_RESULT" in
      retry:*) log "$kind $subject: retry of seq $pending_seq not acknowledged (${POST_RESULT#retry:}); kept for the next run"
               unlock_subject "$id"; return 1 ;;
      applied|replay) log "$kind $subject: seq $pending_seq acknowledged on retry ($POST_RESULT)" ;;
      older) log "$kind $subject: STALE — the server already holds a newer seq than $pending_seq"; status=1 ;;
      *) log "$kind $subject: REJECTED seq $pending_seq: ${POST_RESULT#rejected:}"; status=1 ;;
    esac
    write_state "$state_file" "$(jq -c --arg o "$POST_RESULT" '{last_seq, last_outcome: $o}' <<<"$state")"
  fi

  "$collector" "$TMP_DIR/obs.json"
  body="$TMP_DIR/body.json"
  jq -c --arg agent "$AGENT_ID" --arg kind "$kind" --argjson seq "$((last + 1))" \
    '{agent_id: $agent, kind: $kind, observation: (. + {seq: $seq})}' "$TMP_DIR/obs.json" >"$body"
  if ! write_state "$state_file" "$(jq -nc --argjson seq "$((last + 1))" --rawfile b "$body" '{last_seq: $seq, pending: {seq: $seq, body: $b}}')"; then
    log "$kind $subject: could not persist seq $((last + 1)); not posting"; unlock_subject "$id"; return 1
  fi
  post_body "$body"
  case "$POST_RESULT" in
    applied) log "$kind $subject: seq $((last + 1)) applied ($(jq -r '.observation | if .complete then "complete" else "incomplete: " + .error end' "$body"))" ;;
    retry:*) log "$kind $subject: seq $((last + 1)) not acknowledged (${POST_RESULT#retry:}); kept for the next run"
             unlock_subject "$id"; return 1 ;;
    replay|older) log "$kind $subject: STALE — the server answered $POST_RESULT for new seq $((last + 1)); state is behind the server"; status=1 ;;
    *) log "$kind $subject: REJECTED seq $((last + 1)): ${POST_RESULT#rejected:}"; status=1 ;;
  esac
  write_state "$state_file" "$(jq -nc --argjson seq "$((last + 1))" --arg o "$POST_RESULT" '{last_seq: $seq, last_outcome: $o}')"
  unlock_subject "$id"
  return $status
}

# --------------------------------------------------------------- dispatch

rc=0
emit sweep.queue "queue:$(jq -r '.queue | ascii_downcase' <<<"$REPO_CFG")" collect_queue || rc=1
emit sweep.pr_snapshot "pr:$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')" collect_prs || rc=1
exit $rc
