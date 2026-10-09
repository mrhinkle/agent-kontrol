#!/usr/bin/env bash
# Install the Mission Control unified discovery daemon (mc_agent.py) as a
# launchd agent on this Mac. Idempotent: re-running unloads, rewrites, reloads.
#
# Usage:
#   ./install.sh                          # prompts for MC_URL and MC_TOKEN
#   MC_URL=https://... MC_TOKEN=secret ./install.sh
#
# Never hardcode credentials in this file. Values come from the environment,
# an existing env file, or an interactive prompt.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.missioncontrol.mc-agent"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
INSTALL_DIR="${HOME}/.mission-control"
INSTALLED_PY="${INSTALL_DIR}/mc_agent.py"
ENV_FILE="${INSTALL_DIR}/mc-agent.env"
LOG_FILE="${HOME}/Library/Logs/mc-agent.log"
UID_NUM="$(id -u)"

# mc-agent watches codex itself; a standalone codex watcher would double-report.
CODEXWATCHER_PLIST="${HOME}/Library/LaunchAgents/com.missioncontrol.codexwatcher.plist"
if [[ -f "$CODEXWATCHER_PLIST" ]]; then
  echo "WARNING: $CODEXWATCHER_PLIST exists — the standalone codex watcher will" >&2
  echo "double-report Codex sessions alongside mc-agent. Unload it with:" >&2
  echo "  launchctl bootout gui/$(id -u)/com.missioncontrol.codexwatcher" >&2
fi
DOMAIN="gui/${UID_NUM}"

xml_escape() {
  # Escape values written into the launchd plist.
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e "s/'/\&apos;/g" \
    -e 's/"/\&quot;/g'
}

load_existing_env() {
  local f line k v
  for f in "${ENV_FILE}" "${HOME}/.claude/mission-control.env" "${HOME}/.mission-control/env"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line#"${line%%[![:space:]]*}"}"
      [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
      k="${line%%=*}"
      v="${line#*=}"
      v="${v%\"}"
      v="${v#\"}"
      v="${v%\'}"
      v="${v#\'}"
      case "$k" in
        MC_URL)   : "${MC_URL:=$v}" ;;
        MC_TOKEN) : "${MC_TOKEN:=$v}" ;;
      esac
    done < "$f"
  done
}

prompt_secret() {
  local var="$1" prompt="$2" value=""
  if [[ -t 0 ]]; then
    if [[ "$var" == "MC_TOKEN" ]]; then
      read -r -s -p "$prompt" value
      # Newline must go to stderr: stdout is captured by $() and a leading
      # newline would corrupt the token.
      echo >&2
    else
      read -r -p "$prompt" value
    fi
    printf '%s' "$value"
  else
    echo "Set ${var} (or run interactively to be prompted)." >&2
    exit 1
  fi
}

load_existing_env

if [[ -z "${MC_URL:-}" ]]; then
  MC_URL="$(prompt_secret MC_URL "Mission Control URL (e.g. https://your-deploy.vercel.app): ")"
fi
if [[ -z "${MC_TOKEN:-}" ]]; then
  MC_TOKEN="$(prompt_secret MC_TOKEN "Mission Control token: ")"
fi

MC_URL="${MC_URL%/}"
if [[ -z "$MC_URL" || -z "$MC_TOKEN" ]]; then
  echo "MC_URL and MC_TOKEN are required." >&2
  exit 1
fi
case "$MC_URL" in
  http://*|https://*) ;;
  *)
    echo "MC_URL must start with http:// or https://" >&2
    exit 1
    ;;
esac

PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" && -x /usr/bin/python3 ]]; then
  PYTHON="/usr/bin/python3"
fi
if [[ -z "$PYTHON" ]]; then
  echo "python3 not found on PATH." >&2
  exit 1
fi
if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "python3 3.9+ is required (found $("$PYTHON" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))'))." >&2
  exit 1
fi

if [[ ! -f "${HERE}/mc_agent.py" ]]; then
  echo "mc_agent.py not found next to install.sh (${HERE})." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "${HERE}/mc_agent.py" "$INSTALLED_PY"
chmod 755 "$INSTALLED_PY"

{
  printf 'MC_URL=%s\n' "$MC_URL"
  printf 'MC_TOKEN=%s\n' "$MC_TOKEN"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Wrote ${ENV_FILE}"

# Unload a previous copy so a re-run is a clean replace.
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
fi
if [[ -f "$PLIST" ]]; then
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
fi

MC_URL_XML="$(xml_escape "$MC_URL")"
MC_TOKEN_XML="$(xml_escape "$MC_TOKEN")"
PYTHON_XML="$(xml_escape "$PYTHON")"
SCRIPT_XML="$(xml_escape "$INSTALLED_PY")"
HOME_XML="$(xml_escape "$HOME")"
LOG_XML="$(xml_escape "$LOG_FILE")"
PATH_XML="$(xml_escape "${HOME}/.local/bin:${HOME}/.grok/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON_XML}</string>
    <string>${SCRIPT_XML}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$INSTALL_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MC_URL</key>
    <string>${MC_URL_XML}</string>
    <key>MC_TOKEN</key>
    <string>${MC_TOKEN_XML}</string>
    <key>MC_POLL_SECONDS</key>
    <string>30</string>
    <key>HOME</key>
    <string>${HOME_XML}</string>
    <key>PATH</key>
    <string>${PATH_XML}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_XML}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_XML}</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"
echo "Wrote ${PLIST}"

if ! launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
  launchctl load "$PLIST"
fi

echo "Loaded ${LABEL}"
echo "Logs: ${LOG_FILE}"
echo "Re-run this script any time to update the daemon or credentials."
