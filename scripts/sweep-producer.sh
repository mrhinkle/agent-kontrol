#!/usr/bin/env bash
# sweep-producer.sh — sweeper evidence (#79) for one repository.
#
# Measures the repository on GitHub and POSTs two observations to /api/ingest:
#   sweep.queue        open issues classified ready / raw from the explicit config
#   sweep.pr_snapshot  every open PR (at most 200) with head, checks, and review start
# and a third when the repo's config sets "pr_review": {"enabled": true, ...}:
#   sweep.queue        pr_review: open non-draft PRs green at head with no review at
#                      that head by a configured reviewer login (#176)
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
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
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

# pr_review, when present, is exactly {enabled, queue, reviewer_logins}. Logins
# are lower-cased before they are checked, and may not repeat after that. When
# any repo has pr_review, every queue id in the file (issue and pr_review, all
# repos) must be distinct after lower-casing: sweep_queues.queue is one key.
CONFIG_OK='
  def strs: type == "array" and all(.[]; type == "string" and length > 0 and length <= 100);
  def qid: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$");
  def login: type == "string" and (ascii_downcase | test("^[a-z0-9][a-z0-9-]{0,38}(\\[bot\\])?$"));
  def prreview:
    type == "object"
    and (keys == ["enabled", "queue", "reviewer_logins"])
    and (.enabled | type == "boolean")
    and (.queue | qid)
    and (.reviewer_logins | type == "array" and length <= 50 and all(.[]; login))
    and ((.reviewer_logins | map(ascii_downcase) | unique | length) == (.reviewer_logins | length));
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
    and ((.review_start // {status_context: "x"}) | type == "object" and (.status_context | type == "string" and length > 0 and length <= 100))
    and ((has("pr_review") | not) or (.pr_review | prreview)))
  and (([.repos[] | .queue, (.pr_review.queue // empty)] | map(ascii_downcase)) as $q
       | ($q | unique | length) == ($q | length))
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
  if [[ "$MC_TOKEN" == *'"'* || "$MC_TOKEN" == *\\* || "$MC_TOKEN" == *[[:cntrl:]]* ]]; then
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
              ... on CheckRun {
                databaseId name status conclusion startedAt completedAt
                checkSuite { app { databaseId slug } workflowRun { databaseId runNumber createdAt event workflow { databaseId name } } }
              }
              ... on StatusContext { context state createdAt creator { login } }
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

# One pull request's reviews, paged from the start until hasNextPage is false.
# Not the snapshot's reviews(last: 100) window: every review is read (#176).
REVIEWS_QUERY='query SweepPrReviews($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number headRefOid
      reviews(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { state commit { oid } author { login } }
      }
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
  gh_settle $? "$errf" "$out"
}

# gh_reviews_page <number> <cursor> <outfile> — one SweepPrReviews page, same contract.
gh_reviews_page() {
  local number="$1" cursor="$2" out="$3" errf
  errf="$(mktemp "$TMP_DIR/gh-err.XXXXXX")"
  if [[ -n "$cursor" ]]; then
    bounded "$GH_TIMEOUT" gh api graphql -f "query=$REVIEWS_QUERY" -f "owner=$OWNER" -f "name=$NAME" -F "number=$number" -f "cursor=$cursor" >"$out" 2>"$errf"
  else
    bounded "$GH_TIMEOUT" gh api graphql -f "query=$REVIEWS_QUERY" -f "owner=$OWNER" -f "name=$NAME" -F "number=$number" >"$out" 2>"$errf"
  fi
  gh_settle $? "$errf" "$out"
}

# gh_settle <rc> <errfile> <outfile> — classify a finished gh call into GH_ERR.
gh_settle() {
  local rc="$1" errf="$2" out="$3"
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
# on the commit GitHub reports for the head. Repeated attempts of one name
# reduce to the current run for that producer before the names are combined.
# A check run and a commit status stay separate, and both have to pass.
# Different apps stay separate. A GitHub Actions result also stays tied to
# its workflow and event, so a different workflow cannot hide a failure.
# The current attempt is the newest run whose run number, run id, and run
# creation time agree, including a queued run that has not started. A later
# completion on an older run does not replace it. A missing context, a
# truncated list, no configured list, the wrong head, or an attempt whose
# producer or ordering is ambiguous is "unknown", never green. A published
# review counts only at the current head. started:false needs the configured
# review-start status context and a complete context list at the head;
# without that source, review is omitted (unknown). A skipped check from
# another app is not that signal.
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
  def num($v): if $v | type == "number" then $v else null end;
  def txt($v): if $v | type == "string" and $v != "" then $v else null end;
  def ts($v):
    if $v == null then null
    else try ($v | fromdateiso8601) catch (
      if ($v | test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z$")) then
        (($v | sub("\\.\\d+Z$"; "Z") | fromdateiso8601)
          + (($v | capture("\\.(?<f>\\d+)Z").f + "000" | .[0:3] | tonumber) / 1000))
      else null end) end;
  def attempt:
    if type != "object" then null
    elif .__typename == "CheckRun" then
      (txt(.name) | if . == null then null else lc end) as $n
      | if $n == null then null
        else {
          typ: "check", n: $n, s: ctxstate,
          app: num(.checkSuite.app.databaseId),
          slug: (txt(.checkSuite.app.slug) | if . == null then null else lc end),
          run: num(.checkSuite.workflowRun.databaseId),
          runn: num(.checkSuite.workflowRun.runNumber),
          rcreated: ts(txt(.checkSuite.workflowRun.createdAt)),
          event: (txt(.checkSuite.workflowRun.event) | if . == null then null else lc end),
          wf: num(.checkSuite.workflowRun.workflow.databaseId),
          wfname: (txt(.checkSuite.workflowRun.workflow.name) | if . == null then null else lc end),
          id: num(.databaseId),
          started: ts(txt(.startedAt))
        } end
    elif .__typename == "StatusContext" then
      (txt(.context) | if . == null then null else lc end) as $n
      | if $n == null then null
        else {
          typ: "status", n: $n, s: ctxstate,
          creator: (txt(.creator.login) | if . == null then null else lc end),
          created: ts(txt(.createdAt))
        } end
    else null end;
  def producer:
    if .typ == "status" then (if .creator == null then null else "status|\(.creator)" end)
    else
      (if .slug == "github-actions" or .run != null or .runn != null or .wf != null or .wfname != null or .event != null or .rcreated != null then true else false end) as $actions
      | if (.app == null and .slug == null) then null
        elif $actions then
          if ((.wf == null and .wfname == null) or .event == null) then null
          else "check|app:\(.app // .slug)|wf:\(.wf // .wfname)|ev:\(.event)" end
        else "check|app:\(.app // .slug)" end
    end;
  def ord($a; $b):
    if $a == null or $b == null then null
    elif $a > $b then 1 elif $a < $b then -1 else 0 end;
  # Run number, run id, and run creation time have to agree. A later completion is not an order.
  def run_order($a; $b):
    (ord($a.runn; $b.runn)) as $rn
    | (ord($a.run; $b.run)) as $ri
    | (ord($a.rcreated; $b.rcreated)) as $rc
    | if $rn == null or $ri == null then null
      elif ($rn != 0 and $ri != 0 and $rn != $ri) or ($rn == 0 and $ri != 0) or ($ri == 0 and $rn != 0) then "conflict"
      elif $rc != null and $rc != 0 and (
        ($rn != 0 and $rc != $rn) or ($ri != 0 and $rc != $ri) or ($rn == 0 and $ri == 0)
      ) then "conflict"
      elif $rn == 0 and $ri == 0 then 0
      else (if $rn == 0 then $ri else $rn end) end;
  def beats($a; $b):
    if $a.typ == "status" then
      (ord($a.created; $b.created)) as $c
      | if $c == null or $c == 0 then null else $c == 1 end
    elif ($a.event != null and ($a.wf != null or $a.wfname != null)) then
      (run_order($a; $b)) as $runord
      | if $runord == "conflict" or $runord == null then null
        elif $runord == 1 then true
        elif $runord == -1 then false
        else
          (ord($a.id; $b.id)) as $id
          | (ord($a.started; $b.started)) as $st
          | if $id == null or $id == 0 then null
            elif $st != null and $st != 0 and $st != $id then null
            else $id == 1 end
        end
    else
      (ord($a.id; $b.id)) as $id
      | (ord($a.started; $b.started)) as $st
      | if $id == null or $id == 0 then null
        elif $st != null and $st != 0 and $st != $id then null
        else $id == 1 end
    end;
  def pick($g):
    if ($g | length) == 1 then $g[0]
    elif $g[0].typ == "status" then
      if any($g[]; .created == null) or (($g | map(.created) | unique | length) != ($g | length)) then null
      else
        [range(0; $g | length) as $i
          | select(all(range(0; $g | length); . as $j | $j == $i or beats($g[$i]; $g[$j]) == true))
          | $i]
        | if length == 1 then $g[.[0]] else null end
      end
    elif any($g[]; .id == null) or (if $g[0].event != null then any($g[]; .run == null or .runn == null) else false end) then null
    else
      [range(0; $g | length) as $i
        | select(all(range(0; $g | length); . as $j | $j == $i or beats($g[$i]; $g[$j]) == true))
        | $i]
      | if length == 1 then $g[.[0]] else null end
    end;
  def bucket($items):
    if ($items | length) <= 1 then [$items[] | {n, typ, s}]
    elif any($items[]; producer == null) then [{n: $items[0].n, typ: $items[0].typ, s: "unknown"}]
    else
      [ $items | group_by(producer)[]
        | pick(.) as $cur
        | if $cur == null then {n: .[0].n, typ: .[0].typ, s: "unknown"} else {n: $cur.n, typ: $cur.typ, s: $cur.s} end ]
    end;
  def contributions($nodes):
    [ $nodes[] | attempt | select(. != null) ]
    | group_by([.typ, .n])
    | [ .[] | bucket(.) ]
    | add // [];
  (($cfg.required_checks // []) | map(lc)) as $req
  | (($cfg.review_start.status_context // null) | if . == null then null else lc end) as $rctx
  | .headRefOid as $head
  | (.commits.nodes[0].commit // null) as $c
  | (if $c != null and ($c.oid | sha) then $c.oid else null end) as $coid
  | (if $coid == null then {complete: false, list: []}
     elif $c.statusCheckRollup == null then {complete: true, list: []}
     elif ($c.statusCheckRollup.contexts.nodes | type) != "array" then {complete: false, list: []}
     else {complete: ($c.statusCheckRollup.contexts.pageInfo.hasNextPage == false),
           list: contributions($c.statusCheckRollup.contexts.nodes)} end) as $x
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

# collect_prs <outfile> — writes the snapshot body without seq, and keeps a copy
# for the pr_review queue, which is derived from this same collection.
collect_prs() {
  collect_pr_snapshot "$1"
  cp "$1" "$TMP_DIR/pr-snapshot.json"
}

collect_pr_snapshot() {
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

# ------------------------------------------------------------ pr_review queue

REVIEWS_PAGE_OK='
  def sha: type == "string" and test("^([0-9a-f]{40}|[0-9a-f]{64})$");
  .data.repository.pullRequest as $p
  | ($p | type == "object")
  and ($p.number == $n)
  and ($p.headRefOid | sha)
  and ($p.reviews.pageInfo.hasNextPage | type == "boolean")
  and (($p.reviews.pageInfo.hasNextPage | not) or ($p.reviews.pageInfo.endCursor | type == "string" and length > 0))
  and ($p.reviews.nodes | type == "array")
  and all($p.reviews.nodes[];
    type == "object"
    and (.state | type == "string")
    and (.commit == null or (.commit | type == "object"))
    and (.author == null or (.author | type == "object")))
'

# A review suppresses readiness only when it is submitted (not PENDING), at the
# PR's current head, and by a configured reviewer login. A null author never does.
REVIEW_SUPPRESSES='
  any(.[];
    .state != "PENDING"
    and ((.commit // {}).oid // null) == $head
    and (((.author // {}).login // null) as $l | $l != null and ($l | type == "string") and (($l | ascii_downcase) | IN($logins[]))))
'

# page_reviews <number> <head> <nodes-file> — 0 with every review node of the PR;
# else REVIEW_ERR. Any failed, malformed, truncated, or moved page fails the whole read.
REVIEW_ERR=""
page_reviews() {
  local number="$1" head="$2" nodes="$3" cursor="" page=0 out seen=$'\n'
  : >"$nodes"
  # Pages are read until hasNextPage is false (AC 26/81), with no count cap. A
  # cursor GitHub already returned would loop forever, so it counts as truncation.
  while :; do
    page=$((page + 1))
    out="$TMP_DIR/reviews-$number-$page.json"
    if ! gh_reviews_page "$number" "$cursor" "$out"; then REVIEW_ERR="$GH_ERR"; return 1; fi
    if ! jq -e --argjson n "$number" "$REVIEWS_PAGE_OK" "$out" >/dev/null 2>&1; then
      if jq -e '.data.repository.pullRequest.reviews.pageInfo.hasNextPage == true' "$out" >/dev/null 2>&1; then
        REVIEW_ERR="a review page for PR #$number is truncated (no cursor)"
      else
        REVIEW_ERR="malformed GitHub response"
      fi
      return 1
    fi
    if [[ "$(jq -r '.data.repository.pullRequest.headRefOid' "$out")" != "$head" ]]; then
      REVIEW_ERR="a PR head moved during collection"; return 1
    fi
    jq -c '.data.repository.pullRequest.reviews.nodes[]' "$out" >>"$nodes"
    [[ "$(jq -r '.data.repository.pullRequest.reviews.pageInfo.hasNextPage' "$out")" == "true" ]] || return 0
    cursor="$(jq -r '.data.repository.pullRequest.reviews.pageInfo.endCursor' "$out")"
    case "$seen" in *$'\n'"$cursor"$'\n'*)
      REVIEW_ERR="a review page for PR #$number is truncated (repeated cursor)"; return 1;;
    esac
    seen+="$cursor"$'\n'
  done
}

# collect_pr_review <outfile> — the pr_review queue, from the snapshot this run
# just collected plus every review of each candidate PR. Anything that makes
# the snapshot incomplete, or a non-draft PR whose required checks are unknown,
# makes this incomplete. A known red or pending check only excludes the PR.
collect_pr_review() {
  local result="$1" snap="$TMP_DIR/pr-snapshot.json" observed queue logins number head nodes suppressed="$TMP_DIR/suppressed.txt" unknown
  queue="$(jq -r '.pr_review.queue | ascii_downcase' <<<"$REPO_CFG")"
  logins="$(jq -c '.pr_review.reviewer_logins | map(ascii_downcase)' <<<"$REPO_CFG")"
  observed="$(jq -r '.observed_at // empty' "$snap" 2>/dev/null)"
  [[ -n "$observed" ]] || observed="$(now_iso)"
  review_fail() {
    jq -nc --arg source "$SOURCE" --arg queue "$queue" --arg repo "$REPO" --arg at "$observed" --arg err "$1" \
      --argjson stale "$STALE_AFTER" \
      '{source: $source, queue: $queue, classification: "pr_review", repo: $repo, observed_at: $at,
        complete: false, error: ($err | .[:300]), ready_items: [], stale_after_minutes: $stale}' >"$result"
  }
  if [[ ! -s "$snap" ]]; then review_fail "the PR snapshot was not collected"; return 0; fi
  if ! jq -e '.complete == true and (.prs | type == "array")' "$snap" >/dev/null 2>&1; then
    review_fail "$(jq -r '.error // "the PR snapshot is incomplete"' "$snap" 2>/dev/null || echo "the PR snapshot is incomplete")"
    return 0
  fi
  unknown="$(jq -r '[.prs[] | select(.draft | not) | select(.required_checks.state == "unknown") | .number] | sort | first // empty' "$snap")"
  if [[ -n "$unknown" ]]; then review_fail "required checks are unknown for PR #$unknown"; return 0; fi
  : >"$suppressed"
  while read -r number head; do
    [[ -n "$number" ]] || continue
    nodes="$TMP_DIR/reviews-$number.jsonl"
    if ! page_reviews "$number" "$head" "$nodes"; then review_fail "$REVIEW_ERR"; return 0; fi
    if jq -se --arg head "$head" --argjson logins "$logins" "$REVIEW_SUPPRESSES" "$nodes" >/dev/null 2>&1; then
      printf '%s\n' "$number" >>"$suppressed"
    fi
  done < <(jq -r '.prs[] | select((.draft | not) and .required_checks.state == "success") | "\(.number) \(.head_sha)"' "$snap")
  jq -c --arg source "$SOURCE" --arg queue "$queue" --arg repo "$REPO" --arg at "$observed" \
    --argjson stale "$STALE_AFTER" --argjson cap "$REFS_CAP" \
    --argjson sup "$(jq -sc '.' "$suppressed")" '
    (.prs | sort_by(.number)) as $all
    | [$all[] | select((.draft | not) and .required_checks.state == "success" and ((.number | IN($sup[])) | not))] as $ready
    | {source: $source, queue: $queue, classification: "pr_review", repo: $repo, observed_at: $at, complete: true,
       ready: {count: ($ready | length), refs: ($ready[:$cap] | map("#\(.number)"))},
       raw: {count: ($all | length), refs: ($all[:$cap] | map("#\(.number)"))},
       ready_items: ($ready[:$cap] | map({number, head_sha})),
       stale_after_minutes: $stale}' "$snap" >"$result" || review_fail "classification failed"
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
if [[ "$(jq -r '.pr_review.enabled // false' <<<"$REPO_CFG")" == "true" ]]; then
  emit sweep.queue "queue:$(jq -r '.pr_review.queue | ascii_downcase' <<<"$REPO_CFG")" collect_pr_review || rc=1
fi
exit $rc
