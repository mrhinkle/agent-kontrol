#!/usr/bin/env bash
# morning-brief.sh — one screen, once a day: what shipped in the last 24h, what is
# stuck and why, whether the coordinator is actually working, and the decisions
# only the owner can make.
#
#   scripts/morning-brief.sh                 # text, last 24h, repos from the dashboard or config
#   scripts/morning-brief.sh --window 72     # a Monday brief that covers the weekend
#   scripts/morning-brief.sh --json          # the same facts as JSON (for /api/brief and tests)
#   scripts/morning-brief.sh --repo owner/a --repo owner/b   # override the repo list
#   scripts/morning-brief.sh --no-dashboard  # never call MC_URL; GitHub only
#
# Config: the `brief` block of progress.config.json (see docs/VELOCITY.md).
# Env:    MC_URL + MC_TOKEN (optional) read the watched-repo list, the
#         coordinator's events, and GET /api/decisions?shape=brief. A live
#         database replaces the DECISIONS section (an empty list is real).
#         A failed call keeps the GitHub label sweep. Without the env the
#         brief is GitHub-only and says so.
# Needs:  gh (authenticated), jq, curl.
#
# Why this exists: a dashboard you have to remember to open tells you about a
# stall three days late. The brief is pushed, it is the same every day, and it
# separates three things that get conflated: throughput (merges), flow (is
# anything stuck, for how long, and on which check) and ownership (what is
# waiting on a human). It also refuses to call a coordinator "alive" because a
# telemetry heartbeat arrived; only a work event counts.

set -euo pipefail

WINDOW_H=24
AS_JSON=0
USE_DASHBOARD=1
OVERRIDE_REPOS=()
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/progress.config.json" ]]; then
  DEFAULT_CONFIG="$SCRIPT_DIR/progress.config.json"
else
  DEFAULT_CONFIG="$(dirname "$SCRIPT_DIR")/progress.config.json"
fi
CONFIG_FILE="${MC_PROGRESS_CONFIG:-$DEFAULT_CONFIG}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --window) WINDOW_H="$2"; shift 2 ;;
    --json) AS_JSON=1; shift ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --repo) OVERRIDE_REPOS+=("$2"); shift 2 ;;
    --no-dashboard) USE_DASHBOARD=0; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) printf 'morning-brief: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done

for bin in gh jq curl; do
  command -v "$bin" >/dev/null 2>&1 || { printf 'morning-brief: %s is required\n' "$bin" >&2; exit 1; }
done
[[ -f "$CONFIG_FILE" ]] || { printf 'morning-brief: config not found: %s\n' "$CONFIG_FILE" >&2; exit 1; }
jq empty "$CONFIG_FILE" >/dev/null 2>&1 || { printf 'morning-brief: config is not valid JSON: %s\n' "$CONFIG_FILE" >&2; exit 1; }

# Env file fallback, same as the collector.
if [[ -z "${MC_URL:-}" && -f "$HOME/.claude/mission-control.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$HOME/.claude/mission-control.env"; set +a
fi

# ------------------------------------------------------------------ thresholds
cfg() { jq -r "$1 // empty" "$CONFIG_FILE"; }
STUCK_PR_HOURS="$(cfg '.brief.stuckPrHours')";      STUCK_PR_HOURS="${STUCK_PR_HOURS:-48}"
STALE_ISSUE_DAYS="$(cfg '.brief.staleIssueDays')";  STALE_ISSUE_DAYS="${STALE_ISSUE_DAYS:-21}"
COORD_ID="$(cfg '.brief.coordinator.agentId')"
COORD_MAX_H="$(cfg '.brief.coordinator.maxSilenceHours')"; COORD_MAX_H="${COORD_MAX_H:-3}"
COORD_WORK_KINDS="$(cfg '.brief.coordinator.workKinds')"
# Work means output: a round ended, a milestone or status was posted. turn_start and error
# are activity without output and do not count (docs/VELOCITY.md).
COORD_WORK_KINDS="${COORD_WORK_KINDS:-session_end|milestone|status}"
DECISION_LABELS_JSON="$(jq -c '.brief.decisionLabels // []' "$CONFIG_FILE")"

# BSD date (macOS) and GNU date both understood.
iso_ago() { # hours -> ISO8601 UTC
  if date -u -v-1H +%s >/dev/null 2>&1; then date -u -v-"$1"H +%Y-%m-%dT%H:%M:%SZ; else date -u -d "-$1 hours" +%Y-%m-%dT%H:%M:%SZ; fi
}
SINCE="$(iso_ago "$WINDOW_H")"
STALE_BEFORE="$(iso_ago $(( STALE_ISSUE_DAYS * 24 )))"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOCAL_NOW="$(date '+%a %Y-%m-%d %H:%M %Z')"

# ------------------------------------------------------------------- repo list
# [{repo,label,short,blockedLabel}] from the dashboard when reachable, else config.
REPOS_JSON=""
REPO_SOURCE="config"
if [[ ${#OVERRIDE_REPOS[@]} -gt 0 ]]; then
  REPOS_JSON="$(printf '%s\n' "${OVERRIDE_REPOS[@]}" | jq -R . | jq -s 'map({repo:., label:(split("/")[1]), short:(split("/")[1]), blockedLabel:null})')"
  REPO_SOURCE="flags"
elif [[ "$USE_DASHBOARD" -eq 1 && -n "${MC_URL:-}" && -n "${MC_TOKEN:-}" ]]; then
  # A reachable dashboard is authoritative, including when its list is empty:
  # an operator who cleared Settings meant it. Only an unreachable or malformed
  # response falls back to the local file.
  if body="$(curl -fsS -m 20 -H "Authorization: Bearer $MC_TOKEN" "${MC_URL%/}/api/settings/repos" 2>/dev/null)" \
     && echo "$body" | jq -e '.repos|type=="array"' >/dev/null 2>&1; then
    REPOS_JSON="$(echo "$body" | jq -c '[.repos[] | {repo, label, short, blockedLabel}]')"
    REPO_SOURCE="dashboard"
  fi
fi
if [[ -z "$REPOS_JSON" ]]; then
  REPOS_JSON="$(jq -c '[.repos[] | {repo, label, short, blockedLabel}]' "$CONFIG_FILE")"
fi

# ------------------------------------------------------------------ gh helpers
# The search API allows 30 requests/min. Each repo costs three searches
# (merged, opened, closed); everything else is a plain list. On a 403/429 wait
# once and retry rather than publish a brief with holes in it.
gh_retry() {
  local out
  if out="$("$@" 2>&1)"; then printf '%s' "$out"; return 0; fi
  if echo "$out" | grep -qiE 'rate limit|403|429|abuse'; then
    sleep 35
    "$@"
  else
    printf '%s\n' "$out" >&2; return 1
  fi
}

# fetch <limit> <cmd...> — runs a gh list command, records a failure or a
# truncated page in REPO_ERRORS instead of returning a comforting empty list.
# A brief with a hole says so and exits 2; it never prints a zero it did not measure.
# fetch is called inside $(...), so it records errors in a file, not a shell array.
ERR_FILE="$(mktemp -t morning-brief-errors)"
trap 'rm -f "$ERR_FILE"' EXIT
fetch() {
  local limit="$1"; shift
  local out what
  what="$(printf '%s' "$*" | sed -E 's/ --json.*//; s/^gh //')"
  if ! out="$(gh_retry "$@")"; then
    printf '%s failed\n' "$what" >>"$ERR_FILE"; printf '[]'; return 0
  fi
  if ! jq -e 'type=="array"' >/dev/null 2>&1 <<<"$out"; then
    printf '%s returned non-JSON\n' "$what" >>"$ERR_FILE"; printf '[]'; return 0
  fi
  # The gh call asks for limit+1 rows; more than `limit` back means the page
  # was cut, exactly `limit` means complete.
  if [[ "$(jq 'length' <<<"$out")" -gt "$limit" ]]; then
    printf '%s truncated at %s\n' "$what" "$limit" >>"$ERR_FILE"
  fi
  printf '%s' "$out"
}

hours_between() { # iso_a iso_b -> hours (float), b-a
  jq -n --arg a "$1" --arg b "$2" 'def ts: sub("\\.[0-9]+(?=Z$)"; "") | fromdateiso8601; (($b|ts) - ($a|ts)) / 3600'
}

# ------------------------------------------------------------- per-repo sweep
repo_results="[]"
while IFS= read -r entry; do
  repo="$(echo "$entry" | jq -r .repo)"
  label="$(echo "$entry" | jq -r .label)"
  short="$(echo "$entry" | jq -r .short)"
  blocked_label="$(echo "$entry" | jq -r '.blockedLabel // empty')"

  : >"$ERR_FILE"
  merged="$(fetch 500 gh pr list -R "$repo" --state merged --search "merged:>=$SINCE" --limit 501 \
             --json number,title,createdAt,mergedAt,author,url)"
  opened="$(fetch 1000 gh issue list -R "$repo" --state all --search "created:>=$SINCE" --limit 1001 --json number)"
  closed="$(fetch 1000 gh issue list -R "$repo" --state closed --search "closed:>=$SINCE" --limit 1001 --json number)"
  opened_n="$(jq 'length' <<<"$opened")"; closed_n="$(jq 'length' <<<"$closed")"

  # One GraphQL list covers open count, stale, blocked and decision labels.
  open_issues="$(fetch 2000 gh issue list -R "$repo" --state open --limit 2001 \
                  --json number,title,createdAt,updatedAt,labels,url)"
  open_prs="$(fetch 500 gh pr list -R "$repo" --state open --limit 501 \
               --json number,title,createdAt,updatedAt,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,url,author,labels)"
  errors_json="$(jq -R . <"$ERR_FILE" | jq -s -c 'map(select(length>0))')"

  one="$(jq -n \
    --arg repo "$repo" --arg label "$label" --arg short "$short" --arg blocked "$blocked_label" \
    --arg since "$SINCE" --arg now "$NOW_ISO" --arg stale_before "$STALE_BEFORE" \
    --argjson stuck_h "$STUCK_PR_HOURS" --argjson decision_labels "$DECISION_LABELS_JSON" \
    --argjson merged "$merged" --argjson opened "$opened_n" --argjson closed "$closed_n" \
    --argjson issues "$open_issues" --argjson prs "$open_prs" --argjson errors "$errors_json" '
    def ts: sub("\\.[0-9]+(?=Z$)"; "") | fromdateiso8601;
    def hours(a; b): ((b|ts) - (a|ts)) / 3600;
    def median: if length == 0 then null else (sort | if length % 2 == 1 then .[length/2|floor] else (.[length/2-1] + .[length/2]) / 2 end) end;
    def bad_check: (.conclusion // .state // "") | ascii_upcase | IN("FAILURE","ERROR","TIMED_OUT","ACTION_REQUIRED","CANCELLED","STARTUP_FAILURE");
    def pending_check: ((.conclusion // "") == "" ) and ((.status // .state // "") | ascii_upcase | IN("PENDING","QUEUED","IN_PROGRESS","EXPECTED"));
    def check_name: (.name // .context // "check");

    ($issues | map(select(.labels | any(.name == $blocked and $blocked != "")))) as $blocked_issues
    | ($issues | map(select(.updatedAt < $stale_before))) as $stale
    | def is_decision_label($n): $decision_labels | any(. as $p | ($p == $n) or (($p|endswith("*")) and ($n|startswith($p[:-1]))));
    (($issues + $prs) | map(select((.labels // []) | any(is_decision_label(.name))))
        | map({repo: $repo, repo_short: $short, number, title, url, kind: (if has("isDraft") then "pr" else "issue" end),
               age_hours: hours(.createdAt; $now), age_days: (hours(.createdAt; $now) / 24 | floor),
               labels: [.labels[].name | select(is_decision_label(.))]})) as $decisions
    | ($prs | map(. + {age_h: hours(.createdAt; $now),
                       idle_h: hours(.updatedAt; $now),
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
    | (($errors|length) > 0) as $incomplete
    | {
        repo: $repo, label: $label, short: $short,
        incomplete: $incomplete, errors: $errors,
        merged_prs: ($merged|length),
        median_lead_hours: ([$merged[] | hours(.createdAt; .mergedAt)] | median),
        issues_opened: $opened, issues_closed: $closed, net_backlog: ($opened - $closed),
        open_issues: ($issues|length), open_prs: ($prs|length), drafts: ([$prs[]|select(.isDraft)]|length),
        stale_issues: ($stale|length),
        stale_ratio: (if ($issues|length) > 0 then (($stale|length) / ($issues|length)) else null end),
        blocked_label: (if $blocked == "" then null else $blocked end),
        blocked_issues: (if $blocked == "" then null else ($blocked_issues|length) end),
        stuck_prs: $stuck,
        decisions: $decisions,
        merged_list: [$merged[] | {number, title, url, author: .author.login, lead_hours: hours(.createdAt; .mergedAt)}]
      }
    # An incomplete repo keeps only its identity and its errors. Every measured
    # field is null: a number we did not measure is not a zero.
    | if $incomplete then with_entries(if (.key | IN("repo","label","short","incomplete","errors")) then . else .value = null end) else . end')"
  repo_results="$(jq -c --argjson one "$one" '. + [$one]' <<<"$repo_results")"
done < <(jq -c '.[]' <<<"$REPOS_JSON")

# ------------------------------------------------------------ coordinator check
# A heartbeat proves the daemon that posts heartbeats is up. Nothing more.
# Liveness here means: a work event (session, milestone, status) within
# maxSilenceHours. Telemetry-only is reported as exactly that.
coordinator="$(jq -n --arg id "${COORD_ID:-}" '{configured: ($id != ""), agent_id: (if $id == "" then null else $id end)}')"
if [[ -n "$COORD_ID" && "$USE_DASHBOARD" -eq 1 && -n "${MC_URL:-}" && -n "${MC_TOKEN:-}" ]]; then
  if fleet="$(curl -fsS -m 20 -H "Authorization: Bearer $MC_TOKEN" "${MC_URL%/}/api/fleet" 2>/dev/null)"; then
    coordinator="$(jq -c --arg id "$COORD_ID" --arg now "$NOW_ISO" --argjson max_h "$COORD_MAX_H" --arg kinds "$COORD_WORK_KINDS" '
      def ts: sub("\\.[0-9]+(?=Z$)"; "") | fromdateiso8601;
    def hours(a; b): ((b|ts) - (a|ts)) / 3600;
      ((.agents // []) | map(select(.id == $id)) | .[0]) as $a
      | ([.events[] | select(.agent_id == $id)] | sort_by(.created_at) | reverse) as $ev
      | ("^(" + $kinds + ")$") as $kinds_re
      | ($ev | map(select(.kind | test($kinds_re))) | .[0]) as $work
      | ($ev | map(select(hours(.created_at; $now) <= $max_h)) ) as $recent
      | ($recent | map(select(.kind | test($kinds_re))) | .[0]) as $recent_work
      | ($recent | map(select(.kind == "error")) | length) as $recent_errors
      | ($ev | .[0]) as $any
      | {configured: true, agent_id: $id,
         found: ($a != null),
         last_seen_at: ($a.last_seen_at // null),
         last_seen_hours: (if $a.last_seen_at then ([0, hours($a.last_seen_at; $now)] | max) else null end),
         last_work_at: ($work.created_at // null),
         last_work_kind: ($work.kind // null),
         last_work_hours: (if $work then hours($work.created_at; $now) else null end),
         last_any_kind: ($any.kind // null),
         max_silence_hours: $max_h,
         recent_errors: $recent_errors,
         verdict: (if $a == null then "unknown: agent not registered"
                   elif $recent_work != null then "working: last work event " + ((hours($recent_work.created_at; $now)*10|floor)/10|tostring) + "h ago"
                   elif $recent_errors > 0 then "FAILING: " + ($recent_errors|tostring) + " error event(s) in the last " + ($max_h|tostring) + "h and no completed work"
                   elif $work != null then "NOT WORKING: last work event " + ((hours($work.created_at; $now))|floor|tostring) + "h ago (limit " + ($max_h|tostring) + "h)"
                   else "NOT WORKING: no work event in the dashboard window (only " + ($any.kind // "nothing") + ")" end)}' <<<"$fleet")"
  else
    coordinator="$(jq -c '. + {verdict: "unknown: dashboard unreachable"}' <<<"$coordinator")"
  fi
elif [[ -n "$COORD_ID" ]]; then
  coordinator="$(jq -c '. + {verdict: "unknown: no dashboard credentials (MC_URL/MC_TOKEN)"}' <<<"$coordinator")"
fi

# The DECISIONS section is the table when the dashboard can serve it.
# demo:false is authoritative, including an empty list. A failed call, or
# demo mode, keeps the GitHub sweep already stored on each repo.
if [[ "$USE_DASHBOARD" -eq 1 && -n "${MC_URL:-}" && -n "${MC_TOKEN:-}" ]]; then
  if table_body="$(curl -fsS -m 20 -H "Authorization: Bearer $MC_TOKEN" \
      "${MC_URL%/}/api/decisions?shape=brief&limit=1000" 2>/dev/null)" \
     && echo "$table_body" | jq -e '.demo == false and (.decisions | type == "array")' >/dev/null 2>&1; then
    table_decisions="$(echo "$table_body" | jq -c '.decisions')"
    # BEGIN table-decisions-jq
    TABLE_DECISIONS_JQ='map(if .incomplete then . else . as $section | .decisions = [$table[] | select(.repo == $section.repo)] end)'
    # END table-decisions-jq
    repo_results="$(jq -c --argjson table "$table_decisions" "$TABLE_DECISIONS_JQ" <<<"$repo_results")"
  fi
fi

# ------------------------------------------------------------------- assemble
brief="$(jq -n --arg at "$NOW_ISO" --argjson window "$WINDOW_H" --arg repo_source "$REPO_SOURCE" \
            --argjson repos "$repo_results" --argjson coordinator "$coordinator" \
            --argjson stuck_h "$STUCK_PR_HOURS" --argjson stale_d "$STALE_ISSUE_DAYS" '
  {
    generated_at: $at, window_hours: $window, repo_source: $repo_source,
    thresholds: {stuck_pr_hours: $stuck_h, stale_issue_days: $stale_d},
    coordinator: $coordinator,
    incomplete_repos: [$repos[] | select(.incomplete) | {repo, errors}],
    totals: ([$repos[] | select(.incomplete | not)] as $ok | {
      merged_prs: ([$ok[].merged_prs] | add // 0),
      issues_opened: ([$ok[].issues_opened] | add // 0),
      issues_closed: ([$ok[].issues_closed] | add // 0),
      net_backlog: ([$ok[].net_backlog] | add // 0),
      stuck_prs: ([$ok[].stuck_prs | length] | add // 0),
      decisions: ([$ok[].decisions | length] | add // 0),
      repos_counted: ($ok|length), repos_total: ($repos|length)
    }),
    repos: $repos,
    stuck_prs: ([$repos[] | select(.incomplete | not) | .stuck_prs[]] | sort_by(-.age_hours)),
    decisions: ([$repos[] | select(.incomplete | not) | .decisions[]] | sort_by(-.age_hours))
  }')"

n_incomplete="$(jq '.incomplete_repos|length' <<<"$brief")"
if [[ "$AS_JSON" -eq 1 ]]; then
  jq . <<<"$brief"
  [[ "$n_incomplete" -eq 0 ]] && exit 0 || exit 2
fi

# ---------------------------------------------------------------------- text
pad() { local s="$1" n="$2"; printf '%-*s' "$n" "${s:0:$n}"; }

echo "MORNING BRIEF — $LOCAL_NOW — last ${WINDOW_H}h  (repos from $REPO_SOURCE)"
echo

t_merged="$(jq -r .totals.merged_prs <<<"$brief")"
t_closed="$(jq -r .totals.issues_closed <<<"$brief")"
t_opened="$(jq -r .totals.issues_opened <<<"$brief")"
t_net="$(jq -r .totals.net_backlog <<<"$brief")"
if   [[ "$t_net" -gt 0 ]]; then verdict="the queue grew by $t_net"
elif [[ "$t_net" -lt 0 ]]; then verdict="the queue shrank by ${t_net#-}"
else verdict="the queue held level"; fi
rc="$(jq -r .totals.repos_counted <<<"$brief")"; rt="$(jq -r .totals.repos_total <<<"$brief")"
if [[ "$n_incomplete" -gt 0 ]]; then
  echo "!! DATA INCOMPLETE for $n_incomplete of $rt repos; totals below cover $rc repos only."
  jq -r '.incomplete_repos[] | "   \(.repo): \(.errors | join("; "))"' <<<"$brief"
  echo
fi
echo "$t_merged PRs merged, $t_closed issues closed, $t_opened opened — $verdict."
echo

coord_conf="$(jq -r .coordinator.configured <<<"$brief")"
if [[ "$coord_conf" == "true" ]]; then
  cv="$(jq -r .coordinator.verdict <<<"$brief")"
  cid="$(jq -r .coordinator.agent_id <<<"$brief")"
  seen="$(jq -r '.coordinator.last_seen_hours // empty | (. * 10 | floor) / 10' <<<"$brief")"
  case "$cv" in NOT*|FAILING*) mark="!!";; working*) mark="ok";; *) mark="??";; esac
  echo "COORDINATOR  [$mark] $cid — $cv${seen:+  (telemetry seen ${seen}h ago)}"
  echo
fi

printf '%-14s %7s %9s %6s %6s %6s %6s %8s\n' "REPO" "merged" "issues±" "net" "open" "stale" "stuck" "lead-med"
jq -r '.repos[] | if .incomplete then [ "!! " + .label, "-", "-", "-", "-", "-", "-", "-" ] else [ .label, .merged_prs, ("+\(.issues_opened)/-\(.issues_closed)"),
                   (if .net_backlog > 0 then "+\(.net_backlog)" else (.net_backlog|tostring) end),
                   .open_issues,
                   (if .stale_ratio == null then "-" else "\(.stale_ratio * 100 | floor)%" end),
                   (.stuck_prs|length),
                   (if .median_lead_hours == null then "-" else "\(.median_lead_hours * 10 | floor / 10)h" end) ] end | @tsv' <<<"$brief" \
| while IFS=$'\t' read -r l m i n o s k h; do printf '%-14s %7s %9s %6s %6s %6s %6s %8s\n' "${l:0:14}" "$m" "$i" "$n" "$o" "$s" "$k" "$h"; done
echo "  stale = open issue untouched ${STALE_ISSUE_DAYS}d+ · stuck = non-draft PR open ${STUCK_PR_HOURS}h+ or blocked/dirty · lead-med = median hours PR open→merge"
echo

n_stuck="$(jq -r .totals.stuck_prs <<<"$brief")"
if [[ "$n_stuck" -eq 0 ]]; then
  echo "STUCK PRs: none."
else
  echo "STUCK PRs ($n_stuck) — oldest first"
  jq -r '.stuck_prs[] | "  \(.repo) #\(.number)  \(.age_days)d  \(.reason)\n      \(.title[0:78])  \(.url)"' <<<"$brief"
fi
echo

n_dec="$(jq -r .totals.decisions <<<"$brief")"
if [[ "$n_dec" -eq 0 ]]; then
  if [[ "$(jq 'length' <<<"$DECISION_LABELS_JSON")" -eq 0 ]]; then
    echo "DECISIONS FOR YOU: not tracked (set brief.decisionLabels in progress.config.json)."
  else
    echo "DECISIONS FOR YOU: none open."
  fi
else
  echo "DECISIONS FOR YOU ($n_dec) — oldest first; each one is work nobody else can unblock"
  jq -r '.decisions[] | "  \(.repo_short) \(if .kind == "pr" then "PR " else "" end)#\(.number)  \(.age_days)d  [\(.labels|join(","))]  \(.title[0:70])\n      \(.url)"' <<<"$brief"
fi
echo

jq -r '.repos[] | select(.merged_prs > 0) | "SHIPPED — \(.label):", (.merged_list[] | "  #\(.number)  \(.title[0:80])  (\(.author), \(.lead_hours*10|floor/10)h)")' <<<"$brief"

[[ "$n_incomplete" -eq 0 ]] && exit 0 || exit 2
