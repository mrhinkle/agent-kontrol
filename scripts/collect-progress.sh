#!/usr/bin/env bash
# collect-progress.sh — one collection tick for the Agent Kontrol progress board.
#
# Sweeps each configured repo with the GitHub API, then POSTs a single snapshot
# per repo to /api/progress/ingest and upserts label-sourced decisions to
# /api/decisions. The dashboard never calls GitHub itself; this script owns that budget.
# Each tick also writes morning-brief keys on detail (stuck_prs, median_lead_hours,
# stale_issues, drafts, merged). A failure of that extra sweep does not abort the tick.
#
#   ./collect-progress.sh                 # rolling tick (cron, every 15 min)
#   ./collect-progress.sh --daily         # same sweep, tagged kind=daily
#                                         # (not required: the board's history
#                                         #  takes the last tick of each UTC day)
#   ./collect-progress.sh --backfill 90   # seed 90 days of history, once
#   ./collect-progress.sh --dry-run       # print the payload, post nothing
#
# Config: MC_URL and MC_TOKEN, from the environment or ~/.claude/mission-control.env.
# Requires: gh (authenticated), jq, curl.
#
# Why cumulative totals as well as 24h counts: differencing two cumulative rows
# gives an exact count for any window, where summing overlapping rolling counts
# would double-count. The 24h fields are the day-one fallback, before there is a
# second row to difference against.

set -euo pipefail

# --------------------------------------------------------------------- config

# Watched repos come from progress.config.json at the repo root (one level up
# from scripts/). Each becomes a "repo|display label|blocked label|short" entry.
#
# The blocked label differs per repo and some repos have none, so the field is
# left empty: the board reports "not tracked" there rather than a false 0%.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# An installed copy keeps progress.config.json beside the script; a checkout keeps
# it one level up. MC_PROGRESS_CONFIG overrides both.
if [[ -f "$SCRIPT_DIR/progress.config.json" ]]; then
  DEFAULT_CONFIG="$SCRIPT_DIR/progress.config.json"
else
  DEFAULT_CONFIG="$(dirname "$SCRIPT_DIR")/progress.config.json"
fi
CONFIG_FILE="${MC_PROGRESS_CONFIG:-$DEFAULT_CONFIG}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  printf 'collect-progress: config file not found: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi
if ! jq empty "$CONFIG_FILE" >/dev/null 2>&1; then
  printf 'collect-progress: config file is not valid JSON: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

REPOS=()
repo_lines="$(jq -r '.repos[]? | [.repo, .label, (.blockedLabel // ""), (.short // "")] | join("|")' "$CONFIG_FILE")"
while IFS= read -r line; do
  if [[ -n "$line" ]]; then REPOS+=("$line"); fi
done <<<"$repo_lines"

if [[ "${#REPOS[@]}" -eq 0 ]]; then
  printf 'collect-progress: no repos configured in %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

LANE_BOT_PREFIX="$(jq -r '.laneBotPrefix // "agent-lanes-"' "$CONFIG_FILE")"
SHARED_BOT_PREFIXES_JSON="$(jq -c '.sharedBotPrefixes // []' "$CONFIG_FILE")"
DECISION_LABELS_JSON="$(jq -c '.brief.decisionLabels // []' "$CONFIG_FILE")"

STALLED_HOURS=24

# Cap the per-PR commit lookups behind lane attribution. One REST call each,
# against a 5000/hour budget, so this is generous — it exists to bound a
# pathological day, not a normal one.
LANE_PR_CAP="${LANE_PR_CAP:-80}"

# GitHub's search API allows 30 requests/minute. Stay under it with room to spare.
SEARCH_SLEEP="${SEARCH_SLEEP:-2.2}"

ENV_FILE="${MC_ENV_FILE:-$HOME/.claude/mission-control.env}"

# Fill MC_URL / MC_TOKEN from the env file only when they aren't already set.
# Sourcing the file outright would clobber an explicit `MC_URL=http://localhost:3210`
# on the command line and silently post to production instead.
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

MODE="tick"
BACKFILL_DAYS=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --daily)    MODE="daily"; shift ;;
    --backfill) MODE="backfill"; BACKFILL_DAYS="${2:?--backfill needs a day count}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for bin in gh jq curl; do
  command -v "$bin" >/dev/null || { echo "missing required command: $bin" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated (run: gh auth login)" >&2; exit 1; }

if [[ $DRY_RUN -eq 0 ]]; then
  : "${MC_URL:?MC_URL is not set (put it in $ENV_FILE)}"
  : "${MC_TOKEN:?MC_TOKEN is not set (put it in $ENV_FILE)}"
fi

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

# ------------------------------------------------------------------ utilities

# search_count <query> — total_count for a GitHub issue/PR search, rate-limited.
# Retries once on failure; prints "null" if it still can't get an answer, so a
# transient error becomes a missing field rather than a wrong number.
search_count() {
  local q="$1" out
  for attempt in 1 2; do
    if out="$(gh api -X GET search/issues -f q="$q" -f per_page=1 --jq '.total_count' 2>/dev/null)"; then
      sleep "$SEARCH_SLEEP"
      printf '%s' "$out"
      return 0
    fi
    log "search failed (attempt $attempt): $q"
    sleep 30
  done
  printf 'null'
}

# search_page <query> — the full first page of a search, so callers can use
# .total_count and .items[] from one request.
search_page() {
  local q="$1" out
  for attempt in 1 2; do
    if out="$(gh api -X GET search/issues -f q="$q" -f per_page=100 2>/dev/null)"; then
      sleep "$SEARCH_SLEEP"
      printf '%s' "$out"
      return 0
    fi
    log "search failed (attempt $attempt): $q"
    sleep 30
  done
  printf '{"total_count":null,"items":[]}'
}

# lane_of <pr-commits-json> — which agent lane wrote this PR.
#
# Bot identities are the only trustworthy signal; the human author appears on
# every PR because the owner opens them. A repo that commits everything under
# one vendor-neutral bot yields "unattributed" — the vendor genuinely is not
# recoverable there, and a lane chart that guessed would be worse than one that
# admits the gap.
lane_of() {
  jq -r \
    --arg prefix "$LANE_BOT_PREFIX" \
    --argjson shared "$SHARED_BOT_PREFIXES_JSON" '
    # An explicit Agent-Vendor trailer wins: it is the only signal that survives
    # a repo where every lane shares one bot identity. Written at commit time by
    # a prepare-commit-msg hook that appends an Agent-Vendor trailer (not shipped
    # in this repo), so it only exists going forward - history before that stays
    # unattributed, honestly.
    ([ .[] | .commit.message
       | capture("(?im)^Agent-Vendor:[ \\t]+(?<v>[A-Za-z0-9][A-Za-z0-9._-]{0,31})[ \\t]*$")
       | .v | ascii_downcase ]) as $trailers
    | if ($trailers | length) > 0 then
        ($trailers | group_by(.) | max_by(length) | .[0])
      else
        # Otherwise fall back to bot identity, which distinguishes lanes only in
        # repos that gave each one its own bot. A bot whose name starts with a
        # shared prefix commits for several lanes, so it stays unattributed.
        [ .[] | (.author.login // .commit.author.name // "") ]
        | map(select(endswith("[bot]")))
        | map(sub("\\[bot\\]$"; ""))
        | map(. as $login
              | if any($shared[]; . as $p | $login | startswith($p)) then "unattributed"
                elif $login | startswith($prefix) then $login[($prefix | length):]
                else $login end)
        | if length == 0 then "human"
          else (group_by(.) | max_by(length) | .[0])
          end
      end
  ' 2>/dev/null || printf 'unattributed'
}

# lane_mix_for <repo> <newline-separated PR numbers>
lane_mix_for() {
  local repo="$1" numbers="$2" lane
  local -a lanes=()
  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
    lane="$(gh api "repos/$repo/pulls/$n/commits?per_page=100" 2>/dev/null | lane_of)"
    lanes+=("${lane:-unattributed}")
  done <<<"$numbers"

  if [[ ${#lanes[@]} -eq 0 ]]; then
    printf '{}'
    return 0
  fi
  printf '%s\n' "${lanes[@]}" |
    jq -R -s 'split("\n") | map(select(length > 0))
              | group_by(.) | map({key: .[0], value: length}) | from_entries' 2>/dev/null ||
    printf '{}'
}

iso_days_ago() {
  local n="$1"
  if date -u -v-1d >/dev/null 2>&1; then
    date -u -v-"${n}"d +%Y-%m-%dT%H:%M:%SZ   # BSD/macOS
  else
    date -u -d "$n days ago" +%Y-%m-%dT%H:%M:%SZ  # GNU
  fi
}

# date_from_epoch <unix-seconds> — UTC calendar date.
# Backfill derives every day from one anchor epoch captured before the loop
# starts. Recomputing "N days ago" inside the loop breaks whenever a long run
# crosses UTC midnight: the clock moves under it and a day gets skipped.
date_from_epoch() {
  local ts="$1"
  if date -u -r 0 >/dev/null 2>&1; then
    date -u -r "$ts" +%Y-%m-%d      # BSD/macOS
  else
    date -u -d "@$ts" +%Y-%m-%d     # GNU
  fi
}

post_payload() {
  local payload="$1"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '%s\n' "$payload" | jq .
    return 0
  fi
  local code
  code="$(curl -sS -o /tmp/mc-progress-resp.json -w '%{http_code}' \
    -X POST "${MC_URL%/}/api/progress/ingest" \
    -H "Authorization: Bearer $MC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")"
  if [[ "$code" != "200" ]]; then
    log "ingest failed: HTTP $code $(cat /tmp/mc-progress-resp.json)"
    return 1
  fi
  log "ingest ok: $(jq -c . /tmp/mc-progress-resp.json)"
}

# ------------------------------------------------------------- decisions

# Same label rule as scripts/morning-brief.sh. Age is not computed here: the
# table stores createdAt as opened_at and first_seen_at, and the API measures
# age when it builds the brief. A truncated or failed list must not withdraw,
# or a short page would close decisions that are still open.
# BEGIN decision-select-jq
DECISION_SELECT_JQ=$(cat <<'JQ'
def is_decision_label($n): $decision_labels | any(. as $p | ($p == $n) or (($p|endswith("*")) and ($n|startswith($p[:-1]))));
[($issues + $prs)[]
  | select((.labels // []) | any(is_decision_label(.name)))]
| map({
    key: ("github:" + $repo + "#" + (.number | tostring)),
    source: "github-label",
    repo: $repo,
    repo_short: $short,
    number,
    title,
    url,
    why: ([.labels[].name | select(is_decision_label(.))] | join(", ")),
    labels: [.labels[].name | select(is_decision_label(.))],
    kind: (if has("isDraft") then "pr" else "issue" end),
    opened_at: .createdAt,
    first_seen_at: .createdAt,
    requested_by: "collector",
    github_present: true
  })
JQ
)
# END decision-select-jq

post_decision() {
  local payload="$1"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '%s\n' "$payload" | jq -c . >&2
    return 0
  fi
  local code
  code="$(curl -sS -o /tmp/mc-decision-resp.json -w '%{http_code}' \
    -X POST "${MC_URL%/}/api/decisions" \
    -H "Authorization: Bearer $MC_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")"
  if [[ "$code" != "200" ]]; then
    log "decision upsert failed: HTTP $code $(cat /tmp/mc-decision-resp.json)"
    return 1
  fi
}

# Upsert every open issue and PR that carries a decision label, then withdraw
# the ones this repo no longer has. A missing key is an issue that closed or
# lost the label, so open, deferred, and decided rows become withdrawn. The
# stored decision text and decided_by stay. An upsert does not reopen a
# decided or deferred row unless force is set. The same upsert fills a null
# kind, labels, opened_at, or repo_short left by a row created before those
# columns existed. opened_at that is already set stays. Until that fill,
# morning-brief.sh keeps the GitHub sweep for the repo.
sync_repo_decisions() {
  local repo="$1" short="$2"
  if [[ "$(jq 'length' <<<"$DECISION_LABELS_JSON")" -eq 0 ]]; then
    return 0
  fi
  if [[ -z "$short" ]]; then short="${repo#*/}"; fi

  local issues prs
  if ! issues="$(gh issue list -R "$repo" --state open --limit 2001 --json number,title,createdAt,labels,url 2>/dev/null)"; then
    log "decisions: issue list failed for $repo; not withdrawing"
    return 0
  fi
  if ! prs="$(gh pr list -R "$repo" --state open --limit 501 --json number,title,createdAt,labels,url,isDraft 2>/dev/null)"; then
    log "decisions: pr list failed for $repo; not withdrawing"
    return 0
  fi
  if ! jq -e 'type=="array"' >/dev/null 2>&1 <<<"$issues" || ! jq -e 'type=="array"' >/dev/null 2>&1 <<<"$prs"; then
    log "decisions: non-JSON list for $repo; not withdrawing"
    return 0
  fi

  local truncated=0
  if [[ "$(jq 'length' <<<"$issues")" -gt 2000 || "$(jq 'length' <<<"$prs")" -gt 500 ]]; then
    truncated=1
    log "decisions: list truncated for $repo; upserting what we saw, not withdrawing"
  fi

  local bodies
  if ! bodies="$(jq -c \
    --arg repo "$repo" --arg short "$short" \
    --argjson decision_labels "$DECISION_LABELS_JSON" \
    --argjson issues "$issues" --argjson prs "$prs" \
    "$DECISION_SELECT_JQ")"; then
    log "decisions: filter failed for $repo; not withdrawing"
    return 0
  fi

  local seen='[]' failed=0 body key
  while IFS= read -r body; do
    [[ -z "$body" ]] && continue
    if ! post_decision "$body"; then failed=1; fi
    key="$(jq -r '.key' <<<"$body")"
    seen="$(jq -c --arg k "$key" '. + [$k]' <<<"$seen")"
  done < <(jq -c '.[]' <<<"$bodies")

  if [[ "$failed" -eq 1 || "$truncated" -eq 1 ]]; then
    return 0
  fi
  local reconcile
  reconcile="$(jq -n --arg repo "$repo" --argjson seen "$seen" \
    '{reconcile:{repo:$repo, source:"github-label", seen_keys:$seen}}')"
  post_decision "$reconcile" || log "decisions: reconcile failed for $repo"
}

# ------------------------------------------------------------- brief metrics
# The same stuck / stale / lead-time rules as scripts/morning-brief.sh.
# Fail open: return 1 and the caller posts the tick without these keys.
# BEGIN brief-metrics-jq
BRIEF_METRICS_JQ='
  def ts: sub("\\.[0-9]+(?=Z$)"; "") | fromdateiso8601;
  def hours(a; b): ((b|ts) - (a|ts)) / 3600;
  def median: if length == 0 then null else (sort | if length % 2 == 1 then .[length/2|floor] else (.[length/2-1] + .[length/2]) / 2 end) end;
  def bad_check: (.conclusion // .state // "") | ascii_upcase | IN("FAILURE","ERROR","TIMED_OUT","ACTION_REQUIRED","CANCELLED","STARTUP_FAILURE");
  def pending_check: ((.conclusion // "") == "") and ((.status // .state // "") | ascii_upcase | IN("PENDING","QUEUED","IN_PROGRESS","EXPECTED"));
  def check_name: (.name // .context // "check");
  ($issues | map(select(.updatedAt < $stale_before))) as $stale
  | ($prs | map(. + {age_h: hours(.createdAt; $now), idle_h: hours(.updatedAt; $now),
       failing: [ (.statusCheckRollup // [])[] | select(bad_check) | check_name ] | unique,
       pending: [ (.statusCheckRollup // [])[] | select(pending_check) | check_name ] | unique})) as $prs2
  | ($prs2 | map(select(.isDraft | not)
        | select(.age_h >= $stuck_h or (.mergeStateStatus | IN("DIRTY","BLOCKED","BEHIND","UNSTABLE")))
        | {repo: $short, number, title, url, author: .author.login, age_hours: .age_h, age_days: (.age_h/24|floor), idle_days: (.idle_h/24|floor),
           state: .mergeStateStatus, review: (.reviewDecision // null),
           reason: (if .mergeStateStatus == "DIRTY" then "merge conflict with base"
                    elif (.failing|length) > 0 then "failing: " + (.failing[0:3] | join(", "))
                    elif (.pending|length) > 0 then "waiting on: " + (.pending[0:3] | join(", "))
                    elif .reviewDecision == "CHANGES_REQUESTED" then "changes requested"
                    elif .reviewDecision == "REVIEW_REQUIRED" then "no review yet"
                    elif .mergeStateStatus == "BEHIND" then "behind base, needs update"
                    else "open " + ((.age_h/24|floor)|tostring) + "d with no blocker reported" end)})
      | sort_by(-.age_hours)) as $stuck
  | ([$merged[] | select(.createdAt != null and .mergedAt != null)]) as $merged_ok
  # merged keeps the 72h sweep. merged_list and median_lead_hours are the 24h
  # display fallback SnapshotDetail documents. A row at exactly 24h stays.
  | ([$merged_ok[] | select(hours(.mergedAt; $now) >= 0 and hours(.mergedAt; $now) <= 24)]) as $merged_24h
  | {
      stuck_prs: $stuck,
      median_lead_hours: ([$merged_24h[] | hours(.createdAt; .mergedAt)] | median),
      stale_issues: ($stale|length),
      stale_ratio: (if ($issues|length) > 0 then (($stale|length) / ($issues|length)) else null end),
      drafts: ([$prs[] | select(.isDraft)] | length),
      merged_list: [$merged_24h[] | {number, title, url, author: .author.login, lead_hours: hours(.createdAt; .mergedAt)}],
      merged: [$merged_ok[] | {number, title, url, author: .author.login, created_at: .createdAt, merged_at: .mergedAt}],
      notes: ([
        (if ($issues|length) >= 200 then "open issues truncated at 200" else empty end),
        (if ($prs|length) >= 100 then "open prs truncated at 100" else empty end),
        (if ($merged|length) >= 200 then "merged prs truncated at 200" else empty end)
      ])
    }'
# END brief-metrics-jq

brief_metrics() {
  local repo="$1" short="$2"
  local stuck_h stale_d now since72 stale_before issues prs merged
  stuck_h="$(jq -r '.brief.stuckPrHours // 48' "$CONFIG_FILE")" || return 1
  stale_d="$(jq -r '.brief.staleIssueDays // 21' "$CONFIG_FILE")" || return 1
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if date -u -v-1H +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    since72="$(date -u -v-72H +%Y-%m-%dT%H:%M:%SZ)"
  else
    since72="$(date -u -d '72 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
  fi
  stale_before="$(iso_days_ago "$stale_d")" || return 1
  issues="$(gh issue list -R "$repo" --state open --limit 200 --json number,updatedAt 2>/dev/null)" || return 1
  prs="$(gh pr list -R "$repo" --state open --limit 100 \
    --json number,title,createdAt,updatedAt,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,url,author 2>/dev/null)" || return 1
  merged="$(gh pr list -R "$repo" --state merged --search "merged:>=${since72}" --limit 200 \
    --json number,title,createdAt,mergedAt,author,url 2>/dev/null)" || return 1
  jq -nc \
    --arg short "$short" --arg now "$now" --arg stale_before "$stale_before" \
    --argjson stuck_h "$stuck_h" \
    --argjson issues "$issues" --argjson prs "$prs" --argjson merged "$merged" \
    "$BRIEF_METRICS_JQ"
}

# ------------------------------------------------------------- one live tick

collect_repo() {
  local repo="$1" label="$2" blocked_label="$3" since="$4" short="$5"
  local since_date="${since%%T*}"

  log "sweeping $repo"

  local open_issues open_prs blocked merged_24h closed_24h opened_24h
  local total_created total_closed total_merged

  open_issues="$(search_count "repo:$repo is:issue is:open")"
  open_prs="$(search_count "repo:$repo is:pr is:open")"
  if [[ -n "$blocked_label" ]]; then
    blocked="$(search_count "repo:$repo is:issue is:open label:\"$blocked_label\"")"
  else
    blocked=null   # no such label in this repo — not tracked, not zero
  fi
  closed_24h="$(search_count "repo:$repo is:issue closed:>=$since")"
  opened_24h="$(search_count "repo:$repo is:issue created:>=$since")"
  total_created="$(search_count "repo:$repo is:issue")"
  total_closed="$(search_count "repo:$repo is:issue is:closed")"
  total_merged="$(search_count "repo:$repo is:pr is:merged")"

  # Merged PRs in the window: one search that yields both the count and the
  # numbers, so lane attribution below costs no extra search budget.
  local merged_json merged_numbers
  merged_json="$(search_page "repo:$repo is:pr is:merged merged:>=$since")"
  merged_24h="$(jq '.total_count // null' <<<"$merged_json")"
  merged_numbers="$(jq -r '.items[]?.number' <<<"$merged_json" | head -n "$LANE_PR_CAP")"

  # Lane mix, counted in merged PRs — not commits, so a lane that lands one
  # careful PR isn't outranked by one that lands twenty tiny commits.
  #
  # It has to read the PR's own branch commits: these repos squash-merge, which
  # rewrites main's authorship to the PR owner, so every commit on main carries
  # the repo owner's name regardless of which agent wrote it.
  local lane_mix
  lane_mix="$(lane_mix_for "$repo" "$merged_numbers")"

  # Open PRs with no state change for a while — "clean but unobserved".
  local stalled
  stalled="$(
    gh pr list --repo "$repo" --state open --limit 100 \
      --json number,title,url,updatedAt,isDraft,statusCheckRollup 2>/dev/null |
      jq -c --argjson h "$STALLED_HOURS" '
        [ .[]
          | ((now - (.updatedAt | fromdateiso8601)) / 3600) as $idle
          | select($idle > $h)
          | {
              number, title, url,
              idle_hours: ($idle | floor),
              green: ((.statusCheckRollup // []) | length > 0
                      # A check still running has a null conclusion. Defaulting
                      # that to SUCCESS would report "green but stalled" for a
                      # PR that is simply mid-CI — the alert has to mean the
                      # checks actually finished and passed.
                      and (all(.[]; (.conclusion // .state // "")
                                    | ascii_upcase | . == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED"))),
              draft: .isDraft
            }
        ] | sort_by(-.idle_hours) | .[0:5]
      ' 2>/dev/null || echo '[]'
  )"

  local brief='{}'
  if brief="$(brief_metrics "$repo" "$short")"; then
    :
  else
    log "brief metrics unavailable for $repo; posting counts without them"
    brief='{}'
  fi

  jq -n \
    --arg repo "$repo" --arg label "$label" \
    --argjson open_issues "$open_issues" --argjson open_prs "$open_prs" \
    --argjson blocked "$blocked" \
    --argjson merged "$merged_24h" --argjson closed "$closed_24h" --argjson opened "$opened_24h" \
    --argjson tc "$total_created" --argjson tcl "$total_closed" --argjson tm "$total_merged" \
    --argjson lane "$lane_mix" --argjson stalled "$stalled" --argjson brief "$brief" \
    --arg since_date "$since_date" \
    '{
      repo: $repo, label: $label,
      open_issues: $open_issues, open_prs: $open_prs, blocked_issues: $blocked,
      merged_prs_24h: $merged, issues_closed_24h: $closed, issues_opened_24h: $opened,
      total_issues_created: $tc, total_issues_closed: $tcl, total_prs_merged: $tm,
      detail: (
        { lane_mix: $lane, stalled_prs: $stalled, notes: (["window from \($since_date)"] + ($brief.notes // [])) }
        + ($brief | del(.notes))
      )
    }'
}

# Sweeper evidence (#79): scripts/sweep-producer.sh, installed beside this
# script. It is off unless its own config (not this one, and not the dashboard
# repo list) sets enabled true and maps the repo. It runs as a child process,
# so its failure never stops this tick. Backfill never calls it.
SWEEP_PRODUCER="${MC_SWEEP_PRODUCER_SCRIPT:-$SCRIPT_DIR/sweep-producer.sh}"

run_sweep_producer() {
  local repo="$1"
  [[ -f "$SWEEP_PRODUCER" ]] || return 0
  local args=(--repo "$repo")
  if [[ $DRY_RUN -eq 1 ]]; then args+=(--dry-run); fi
  MC_URL="${MC_URL:-}" MC_TOKEN="${MC_TOKEN:-}" MC_ENV_FILE=/dev/null bash "$SWEEP_PRODUCER" "${args[@]}" </dev/null >&2
}

run_tick() {
  local now since payloads=()
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  since="$(iso_days_ago 1)"

  for entry in "${REPOS[@]}"; do
    IFS='|' read -r repo label blocked_label short <<<"$entry"
    payloads+=("$(collect_repo "$repo" "$label" "$blocked_label" "$since" "$short")")
    sync_repo_decisions "$repo" "$short" || log "decisions: sync failed for $repo"
    run_sweep_producer "$repo" || log "sweep producer: failed for $repo; the progress tick continues"
  done

  local body
  body="$(jq -n --arg at "$now" --arg kind "$MODE" \
    --argjson repos "$(printf '%s\n' "${payloads[@]}" | jq -s .)" \
    '{collected_at: $at, kind: $kind, repos: $repos}')"
  post_payload "$body"
}

# --------------------------------------------------------------- backfill

# GitHub can answer "how many issues existed on 2026-07-04" retroactively via
# created:<=DATE / closed:<=DATE, so the graph doesn't have to start empty.
# Queue depth and lane mix are NOT recoverable this way and stay null — the
# backfilled rows carry only the two cumulative lines they can honestly fill.
run_backfill() {
  local days="$1"
  local anchor_epoch
  anchor_epoch="$(date -u +%s)"
  log "backfilling $days days — roughly $(( days * ${#REPOS[@]} * 3 * 3 / 60 )) minutes"

  # Newest day first. A backfill that is interrupted — or simply still running —
  # then leaves a contiguous run of recent days, which is what every window and
  # the graph actually read. Filling oldest-first leaves the useful end empty
  # until the very last minute.
  for (( d=1; d<=days; d++ )); do
    local day at payloads=()
    day="$(date_from_epoch $(( anchor_epoch - d * 86400 )))"
    at="${day}T23:59:00Z"

    for entry in "${REPOS[@]}"; do
      local repo label blocked_label short tc tcl tm
      IFS='|' read -r repo label blocked_label short <<<"$entry"
      tc="$(search_count "repo:$repo is:issue created:<=$day")"
      tcl="$(search_count "repo:$repo is:issue is:closed closed:<=$day")"
      tm="$(search_count "repo:$repo is:pr is:merged merged:<=$day")"
      payloads+=("$(jq -n --arg repo "$repo" --arg label "$label" \
        --argjson tc "$tc" --argjson tcl "$tcl" --argjson tm "$tm" \
        '{repo: $repo, label: $label,
          total_issues_created: $tc, total_issues_closed: $tcl, total_prs_merged: $tm,
          detail: {notes: ["backfilled — queue depth and lane mix not recoverable"]}}')")
    done

    local body
    body="$(jq -n --arg at "$at" \
      --argjson repos "$(printf '%s\n' "${payloads[@]}" | jq -s .)" \
      '{collected_at: $at, kind: "backfill", repos: $repos}')"
    post_payload "$body" || log "backfill $day failed — continuing"
    log "backfilled $day"
  done
}

# ------------------------------------------------------------ owner discovery

# Ask the dashboard which GitHub owners to discover, run `gh repo list` for
# each, and post the raw lists. A failed, rate-limited, or empty list is
# reported as ok:false so the dashboard records last_error and leaves
# tracked repos alone. This never deletes a repo. Hide wins over pin is
# applied when the dashboard is read, not here. writable:false is an
# unavailable store, not an empty list. swept_at is taken before gh so a
# delayed older tick cannot overwrite a newer one.
discover_watched_owners() {
  local body owners owner listing errfile count truncated results status resp
  local err swept writable
  if [[ "${MC_REPOS_FROM_DASHBOARD:-1}" == "0" ]]; then
    log "owners: discovery skipped (dashboard list disabled)"; return 0
  fi
  if [[ -z "${MC_URL:-}" || -z "${MC_TOKEN:-}" ]]; then
    log "owners: discovery skipped (no MC_URL or MC_TOKEN)"; return 0
  fi
  if ! body="$(curl -fsS --max-time 15 -H "Authorization: Bearer $MC_TOKEN" "${MC_URL%/}/api/settings/owners" 2>/dev/null)"; then
    log "owners: dashboard unreachable, leaving tracked repos unchanged"; return 0
  fi
  writable="$(jq -r 'if has("writable") then (.writable|tostring) else "missing" end' <<<"$body" 2>/dev/null || echo missing)"
  if [[ "$writable" == "false" ]]; then
    log "owners: owner store is not writable; discovery skipped and tracked repos unchanged"
    return 0
  fi
  owners="$(jq -r '.owners[]?.owner // empty' <<<"$body" 2>/dev/null || true)"
  if [[ -z "$owners" ]]; then
    log "owners: none configured"; return 0
  fi
  results="[]"
  errfile="$(mktemp)"
  resp="$(mktemp)"
  while IFS= read -r owner; do
    [[ -n "$owner" ]] || continue
    swept="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [[ ! "$owner" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]]; then
      results="$(jq -c --arg owner "$owner" --arg swept "$swept" '. + [{owner:$owner, ok:false, error:"owner is not a safe GitHub login", swept_at:$swept}]' <<<"$results")" || true
      continue
    fi
    : >"$errfile"
    if listing="$(gh repo list "$owner" --limit 1000 --json name,pushedAt,isArchived,isFork 2>"$errfile")"; then
      if ! printf '%s\n' "$listing" | jq -e 'type=="array"' >/dev/null 2>&1; then
        err="$(tr '\n' ' ' <"$errfile" | head -c 400)"
        results="$(jq -c --arg owner "$owner" --arg err "${err:-gh repo list returned JSON that was not an array}" --arg swept "$swept" '. + [{owner:$owner, ok:false, error:$err, swept_at:$swept}]' <<<"$results")" || true
        continue
      fi
      count="$(jq 'length' <<<"$listing" 2>/dev/null || echo 0)"
      if [[ "${count:-0}" -eq 0 ]]; then
        err="$(tr '\n' ' ' <"$errfile" | head -c 400)"
        results="$(jq -c --arg owner "$owner" --arg err "${err:-gh repo list returned no repos}" --arg swept "$swept" '. + [{owner:$owner, ok:false, error:$err, swept_at:$swept}]' <<<"$results")" || true
        continue
      fi
      truncated=false
      if [[ "$count" -ge 1000 ]]; then truncated=true; fi
      results="$(jq -c --arg owner "$owner" --argjson repos "$listing" --argjson truncated "$truncated" --arg swept "$swept" '. + [{owner:$owner, ok:true, repos:$repos, truncated:$truncated, swept_at:$swept}]' <<<"$results")" || true
    else
      err="$(tr '\n' ' ' <"$errfile" | head -c 400)"
      results="$(jq -c --arg owner "$owner" --arg err "${err:-gh repo list failed}" --arg swept "$swept" '. + [{owner:$owner, ok:false, error:$err, swept_at:$swept}]' <<<"$results")" || true
    fi
  done <<<"$owners"
  rm -f "$errfile"
  if ! status="$(curl -sS -o "$resp" -w '%{http_code}' --max-time 30 \
      -H "Authorization: Bearer $MC_TOKEN" -H "Content-Type: application/json" \
      -d "$(jq -c -n --argjson results "$results" '{results:$results}')" \
      "${MC_URL%/}/api/settings/owners/discover")"; then
    log "owners: discovery post failed; tracked repos unchanged"
    rm -f "$resp"
    return 0
  fi
  if [[ "$status" != "200" ]]; then
    log "owners: discovery post returned $status; tracked repos unchanged"
  else
    local stale_owners applied
    stale_owners="$(jq -r '[.results[]? | select(.skipped == "stale") | .owner] | join(" ")' <"$resp" 2>/dev/null || true)"
    if [[ -n "$stale_owners" ]]; then
      log "owners: discovery skipped stale sweep for ${stale_owners}"
    fi
    applied="$(jq -r '[.results[]? | select(.skipped != "stale")] | length' <"$resp" 2>/dev/null || echo '?')"
    if [[ "$applied" != "0" ]]; then
      log "owners: discovery posted (${applied} results)"
    fi
  fi
  rm -f "$resp"
}

# ------------------------------------------------------------ repo list from the dashboard

# Ask the dashboard which repos to sweep, so adding one in Settings needs no edit on
# this machine. The dashboard's list wins whenever it can be reached, whether it is a
# list saved in Settings or the dashboard's own default (which may come from its
# environment), because both beat the example repos in a local copy of the config.
# If the dashboard is unreachable or returns something unusable, keep the list read
# from the local config file above.
# Set MC_REPOS_FROM_DASHBOARD=0 to ignore the dashboard and use the file only.
refresh_repos_from_dashboard() {
  local body lines line
  if [[ "${MC_REPOS_FROM_DASHBOARD:-1}" == "0" ]]; then
    log "repos: ${#REPOS[@]} from the local config (dashboard list disabled)"; return 0
  fi
  if [[ -z "${MC_URL:-}" || -z "${MC_TOKEN:-}" ]]; then
    log "repos: ${#REPOS[@]} from the local config (no MC_URL or MC_TOKEN)"; return 0
  fi
  if ! body="$(curl -fsS --max-time 15 -H "Authorization: Bearer $MC_TOKEN" "${MC_URL%/}/api/settings/repos" 2>/dev/null)"; then
    log "repos: dashboard unreachable, using ${#REPOS[@]} from the local config"; return 0
  fi
  lines="$(jq -r '.repos[]? | select(.gone != true) | [.repo, .label, (.blockedLabel // ""), (.short // "")] | join("|")' <<<"$body" 2>/dev/null || true)"
  if [[ -z "$lines" ]]; then
    if jq -e '.repos | type == "array" and any(.[]; .gone == true)' >/dev/null 2>&1 <<<"$body"; then
      REPOS=()
      log "repos: dashboard list is only gone repos; not sweeping them"
      return 0
    fi
    # An empty database list is the owner's answer (owners watched, nothing eligible yet),
    # not a missing list: sweep nothing rather than the local config's repos.
    if jq -e '.source == "database"' >/dev/null 2>&1 <<<"$body"; then
      REPOS=()
      log "repos: dashboard database list is empty; not sweeping local-config repos"
      return 0
    fi
    log "repos: dashboard list was empty, using ${#REPOS[@]} from the local config"; return 0
  fi
  REPOS=()
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then REPOS+=("$line"); fi
  done <<<"$lines"
  log "repos: ${#REPOS[@]} from the dashboard ($(jq -r '.source // "unknown"' <<<"$body" 2>/dev/null) list)"
}

# ------------------------------------------------------------------- dispatch

discover_watched_owners
refresh_repos_from_dashboard

if [[ "$MODE" == "backfill" ]]; then
  run_backfill "$BACKFILL_DAYS"
else
  run_tick
fi
