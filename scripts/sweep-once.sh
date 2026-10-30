#!/usr/bin/env bash
# Absence detection (#79): run the sweeper once and print the result.
#
#   MC_URL=https://<host> MC_TOKEN=... scripts/sweep-once.sh
#
# Manual, one shot. It posts POST /api/sweep with the MC_TOKEN bearer and
# prints the JSON. It installs nothing and schedules nothing; see
# docs/examples/absence-sweep.cron.example for an inert five-minute line.
# Exit 0 when the run completed, 1 when the request failed, 2 when any
# check came back unknown or retention failed.
set -euo pipefail

if [[ -z "${MC_URL:-}" || -z "${MC_TOKEN:-}" ]]; then
  echo "sweep-once: set MC_URL and MC_TOKEN" >&2
  exit 1
fi

if ! body="$(curl -fsS -m 60 -X POST -H "Authorization: Bearer $MC_TOKEN" "${MC_URL%/}/api/sweep")"; then
  echo "sweep-once: POST /api/sweep failed" >&2
  exit 1
fi

jq . <<<"$body"
if jq -e '(.checks | any(.state == "unknown")) or .retention.state != "ok"' >/dev/null <<<"$body"; then
  exit 2
fi
