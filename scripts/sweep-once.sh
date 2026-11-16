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

if [[ "$MC_TOKEN" == *[[:cntrl:]]* ]]; then
  echo "sweep-once: MC_TOKEN must not contain control characters" >&2
  exit 1
fi
# Same bound as observe-scheduler.py MAX_SWEEP_CAPTURE. Bytes past this are
# not written and are not given to jq. This is a transfer cap, not a retention rule.
MAX_BODY=262144
umask 077
WORKDIR="$(mktemp -d)"
AUTH_HEADER="$WORKDIR/auth"
BODY_FILE="$WORKDIR/body"
FIFO="$WORKDIR/body.fifo"
trap 'rm -rf "$WORKDIR"' EXIT
printf 'Authorization: Bearer %s\n' "$MC_TOKEN" >"$AUTH_HEADER"
: >"$BODY_FILE"
mkfifo -m 0600 "$FIFO"

# Hold a write end so a curl that exits before opening the fifo cannot leave
# the reader blocked, and so the reader sees EOF only after curl has finished.
python3 -c '
import sys
fifo, dest, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
total = 0
with open(fifo, "rb") as src, open(dest, "wb") as out:
    while True:
        buf = src.read(8192)
        if not buf:
            break
        if total + len(buf) > limit:
            raise SystemExit(86)
        out.write(buf)
        total += len(buf)
' "$FIFO" "$BODY_FILE" "$MAX_BODY" &
reader=$!
exec 3>"$FIFO"

# -q must be first so curlrc cannot enable location or a proxy. --noproxy
# covers the environment. curl 8.18 refuses an empty --proto-redir set, so
# -all fails before the request. curl 8.7.1 rejects the joined
# --proto-redir=-all form. -http,-https is a separate argument that both
# accept, and it disables HTTP and HTTPS redirects. --max-redirs 0 does not
# follow a redirect. Only HTTP 200 within the body cap is a result.
set +e
http_code="$(curl -q --noproxy '*' --max-redirs 0 --proto-redir '-http,-https' -sS -m 60 \
  -o "$FIFO" -w '%{http_code}' -X POST -H "@$AUTH_HEADER" "${MC_URL%/}/api/sweep")"
curl_status=$?
exec 3>&-
wait "$reader"
reader_status=$?
set -e
if [[ "$curl_status" -ne 0 || "$reader_status" -ne 0 || "$http_code" != "200" ]]; then
  echo "sweep-once: POST /api/sweep failed" >&2
  exit 1
fi

if ! jq . <"$BODY_FILE"; then
  exit 1
fi
if jq -e '(.checks | any(.state == "unknown")) or .retention.state != "ok"' >/dev/null <"$BODY_FILE"; then
  exit 2
fi
