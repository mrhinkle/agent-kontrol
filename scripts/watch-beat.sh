#!/usr/bin/env bash
# watch-beat.sh — post one freshly computed liveness beat and exit.
#
# Reads one JSON object from stdin:
#   { "source", "status", "detail", "beat_at" }
# It does not queue, save, or replay an observation. A failed post prints
# one short line and exits 0 so a dead-man parent keeps running.
#
# Environment:
#   WATCH_API_URL      Full POST URL. https:// is required. http:// is
#                      allowed only when the host is localhost, 127.0.0.1,
#                      or ::1 (tests and a local server).
#   WATCH_CREDENTIAL   akc_ agent credential with watch:write, bound to the
#                      source in the body. This script never prints it.
#
# The credential is handed to curl in a mode-600 header file (`-H @file`),
# not on the curl command line, and it is unset before curl runs.
# Connect timeout is 5 seconds. Total time is 10 seconds.
# curl's own config file is ignored (`-q`). Redirects are not followed.

set -u

say() {
  local msg="$1"
  if [[ -n "${secret:-}" ]]; then
    msg="${msg//"$secret"/redacted}"
  fi
  printf '%s\n' "${msg:0:200}" >&2
}

url_is_allowed() {
  local url="$1"
  [[ -n "$url" ]] || return 1
  [[ "$url" != *$'\n'* && "$url" != *$'\r'* ]] || return 1
  [[ "$url" != *"@"* ]] || return 1
  local rest host inner
  if [[ "$url" == https://* ]]; then
    rest="${url#https://}"
    [[ -n "$rest" && "$rest" != /* ]] || return 1
    return 0
  fi
  if [[ "$url" != http://* ]]; then
    return 1
  fi
  rest="${url#http://}"
  [[ -n "$rest" && "$rest" != /* ]] || return 1
  host="${rest%%/*}"
  host="${host%%\?*}"
  if [[ "$host" == \[*\]* ]]; then
    inner="${host#\[}"
    inner="${inner%%\]*}"
    [[ "$inner" == "::1" ]] || return 1
    return 0
  fi
  host="${host%%:*}"
  [[ "$host" == "localhost" || "$host" == "127.0.0.1" ]] || return 1
  return 0
}

json_object_file() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "rb") as handle:
    raw = handle.read()
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError:
    sys.exit(2)
stripped = text.lstrip()
if not stripped:
    sys.exit(2)
try:
    value, end = json.JSONDecoder().raw_decode(stripped)
except json.JSONDecodeError:
    sys.exit(2)
if not isinstance(value, dict):
    sys.exit(2)
if stripped[end:].strip():
    sys.exit(2)
PY
}

success_body() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path, "rb") as handle:
        value = json.loads(handle.read().decode("utf-8"))
except Exception:
    sys.exit(2)
if not isinstance(value, dict) or value.get("ok") is not True:
    sys.exit(2)
PY
}

cleanup() {
  rm -f "${bodyfile:-}" "${hdr:-}" "${resp:-}" "${errfile:-}"
}
trap cleanup EXIT

secret="${WATCH_CREDENTIAL-}"
bodyfile=""
hdr=""
resp=""
errfile=""

umask 077
bodyfile="$(mktemp)"
cat > "$bodyfile"

if [[ -z "${WATCH_API_URL-}" ]]; then
  say "watch-beat: missing WATCH_API_URL"
  exit 0
fi
if [[ -z "$secret" || "$secret" == *$'\n'* || "$secret" == *$'\r'* ]]; then
  say "watch-beat: missing WATCH_CREDENTIAL"
  exit 0
fi
if ! url_is_allowed "$WATCH_API_URL"; then
  say "watch-beat: non-https url refused"
  exit 0
fi
if ! json_object_file "$bodyfile" >/dev/null 2>&1; then
  say "watch-beat: invalid input"
  exit 0
fi

hdr="$(mktemp)"
resp="$(mktemp)"
errfile="$(mktemp)"
printf '%s\n' "Authorization: Bearer ${secret}" > "$hdr"
unset WATCH_CREDENTIAL

http_code="$(
  curl -q --silent --show-error \
    --connect-timeout 5 \
    --max-time 10 \
    --header @"$hdr" \
    --header "Content-Type: application/json" \
    --data-binary @"$bodyfile" \
    --output "$resp" \
    --write-out '%{http_code}' \
    -- "$WATCH_API_URL" 2>"$errfile"
)"
curl_status=$?

if [[ "$curl_status" -ne 0 ]]; then
  case "$curl_status" in
    28) say "watch-beat: timeout" ;;
    7) say "watch-beat: connection refused" ;;
    6) say "watch-beat: dns failure" ;;
    35|51|58|59|60|77|80|82|83|90|91) say "watch-beat: tls failure" ;;
    *) say "watch-beat: request failed" ;;
  esac
  exit 0
fi

case "$http_code" in
  2??) ;;
  *)
    say "watch-beat: non-2xx"
    exit 0
    ;;
esac

if ! success_body "$resp" >/dev/null 2>&1; then
  say "watch-beat: invalid success response"
  exit 0
fi

exit 0
