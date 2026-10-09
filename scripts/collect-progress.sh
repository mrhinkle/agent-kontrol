#!/usr/bin/env bash
# collect-progress.sh — one collection tick for the Agent Kontrol progress board.
#
# Sweeps each configured repo with the GitHub API, then POSTs a single snapshot
# per repo to /api/progress/ingest. The dashboard never calls GitHub itself; this
# script owns the entire API budget.
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
# from scripts/). Each becomes a "repo|display label|blocked label" entry.
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
repo_lines="$(jq -r '.repos[]? | [.repo, .label, (.blockedLabel // "")] | join("|")' "$CONFIG_FILE")"
while IFS= read -r line; do
  if [[ -n "$line" ]]; then REPOS+=("$line"); fi
done <<<"$repo_lines"

if [[ "${#REPOS[@]}" -eq 0 ]]; then
  printf 'collect-progress: no repos configured in %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

LANE_BOT_PREFIX="$(jq -r '.laneBotPrefix // "agent-lanes-"' "$CONFIG_FILE")"
SHARED_BOT_PREFIXES_JSON="$(jq -c '.sharedBotPrefixes // []' "$CONFIG_FILE")"

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

# ------------------------------------------------------------- one live tick

collect_repo() {
  local repo="$1" label="$2" blocked_label="$3" since="$4"
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

  jq -n \
    --arg repo "$repo" --arg label "$label" \
    --argjson open_issues "$open_issues" --argjson open_prs "$open_prs" \
    --argjson blocked "$blocked" \
    --argjson merged "$merged_24h" --argjson closed "$closed_24h" --argjson opened "$opened_24h" \
    --argjson tc "$total_created" --argjson tcl "$total_closed" --argjson tm "$total_merged" \
    --argjson lane "$lane_mix" --argjson stalled "$stalled" \
    --arg since_date "$since_date" \
    '{
      repo: $repo, label: $label,
      open_issues: $open_issues, open_prs: $open_prs, blocked_issues: $blocked,
      merged_prs_24h: $merged, issues_closed_24h: $closed, issues_opened_24h: $opened,
      total_issues_created: $tc, total_issues_closed: $tcl, total_prs_merged: $tm,
      detail: { lane_mix: $lane, stalled_prs: $stalled, notes: ["window from \($since_date)"] }
    }'
}

run_tick() {
  local now since payloads=()
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  since="$(iso_days_ago 1)"

  for entry in "${REPOS[@]}"; do
    IFS='|' read -r repo label blocked_label <<<"$entry"
    payloads+=("$(collect_repo "$repo" "$label" "$blocked_label" "$since")")
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
      local repo label blocked_label tc tcl tm
      IFS='|' read -r repo label blocked_label <<<"$entry"
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

# ------------------------------------------------------------ repo list from the dashboard

# Ask the dashboard which repos to sweep, so adding one in Settings needs no edit on
# this machine. If the dashboard is unreachable, has no saved list yet, or returns
# something unusable, keep the list read from the local config file above.
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
  if [[ "$(jq -r '.source // empty' <<<"$body" 2>/dev/null)" != "database" ]]; then
    log "repos: no saved list on the dashboard, using ${#REPOS[@]} from the local config"; return 0
  fi
  lines="$(jq -r '.repos[]? | [.repo, .label, (.blockedLabel // "")] | join("|")' <<<"$body" 2>/dev/null || true)"
  if [[ -z "$lines" ]]; then
    log "repos: dashboard list was empty, using ${#REPOS[@]} from the local config"; return 0
  fi
  REPOS=()
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then REPOS+=("$line"); fi
  done <<<"$lines"
  log "repos: ${#REPOS[@]} from the dashboard"
}

# ------------------------------------------------------------------- dispatch

refresh_repos_from_dashboard

if [[ "$MODE" == "backfill" ]]; then
  run_backfill "$BACKFILL_DAYS"
else
  run_tick
fi
