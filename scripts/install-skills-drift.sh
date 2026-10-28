#!/usr/bin/env bash
# Install the skills drift collector as a launchd agent on this Mac.
#
# Copies scripts/collect-skills-drift.mjs to ~/.mission-control/ and runs it hourly. The job
# sources ~/.claude/mission-control.env (MC_URL, MC_TOKEN) at run time, so the plist holds no
# secret. The collector itself only reads its environment.
#
# Idempotent: re-running rewrites the plist and reloads. Existing lines in the env file are kept.
#
# Usage:
#   ./install-skills-drift.sh                 # prompts for MC_URL / MC_TOKEN if the env file lacks them
#   MC_URL=https://... MC_TOKEN=secret ./install-skills-drift.sh
#   AK_MACHINE=mac-mini AK_SKILL_DRIFT_DIRS=~/.codex/skills ./install-skills-drift.sh   # optional overrides
#   ./install-skills-drift.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.missioncontrol.skills-drift"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
INSTALL_DIR="${HOME}/.mission-control"
INSTALLED_JS="${INSTALL_DIR}/collect-skills-drift.mjs"
ENV_FILE="${HOME}/.claude/mission-control.env"
LOG_FILE="${HOME}/Library/Logs/mc-skills-drift.log"
DOMAIN="gui/$(id -u)"
INTERVAL_SECONDS="${MC_SKILLS_DRIFT_INTERVAL:-3600}"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Removed ${LABEL}. The script and env file were left in place."
  exit 0
fi

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e "s/'/\&apos;/g" -e 's/"/\&quot;/g'
}

env_file_has() { [[ -f "$ENV_FILE" ]] && grep -q "^$1=" "$ENV_FILE"; }

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "node (18 or newer) is required" >&2; exit 1; }
(( $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') >= 18 )) || { echo "node 18 or newer is required" >&2; exit 1; }
[[ -f "${HERE}/collect-skills-drift.mjs" ]] || { echo "collect-skills-drift.mjs not found next to this script" >&2; exit 1; }
case "$INTERVAL_SECONDS" in ''|*[!0-9]*) echo "MC_SKILLS_DRIFT_INTERVAL must be a number of seconds" >&2; exit 1 ;; esac

mkdir -p "$INSTALL_DIR" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs" "$(dirname "$ENV_FILE")"

# Add MC_URL / MC_TOKEN to the env file only if it lacks them; never overwrite other lines.
if ! env_file_has MC_URL; then
  if [[ -z "${MC_URL:-}" ]]; then
    [[ -t 0 ]] || { echo "Set MC_URL (or run interactively)." >&2; exit 1; }
    read -r -p "Agent Kontrol URL (e.g. https://your-deploy.vercel.app): " MC_URL
  fi
  case "${MC_URL}" in https://*|http://localhost*|http://127.0.0.1*) ;; *) echo "MC_URL must be https (http only for localhost)" >&2; exit 1 ;; esac
  printf 'MC_URL=%s\n' "${MC_URL%/}" >> "$ENV_FILE"
fi
if ! env_file_has MC_TOKEN; then
  if [[ -z "${MC_TOKEN:-}" ]]; then
    [[ -t 0 ]] || { echo "Set MC_TOKEN (or run interactively)." >&2; exit 1; }
    read -r -s -p "Agent Kontrol token: " MC_TOKEN; echo >&2
  fi
  [[ -n "$MC_TOKEN" ]] || { echo "MC_TOKEN is required" >&2; exit 1; }
  printf 'MC_TOKEN=%s\n' "$MC_TOKEN" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

cp "${HERE}/collect-skills-drift.mjs" "$INSTALLED_JS"
chmod 755 "$INSTALLED_JS"

# Optional overrides are not secrets, so they may live in the plist.
EXTRA_ENV=""
for var in AK_MACHINE AK_SKILL_DRIFT_DIRS; do
  if [[ -n "${!var:-}" ]]; then
    EXTRA_ENV+="    <key>${var}</key>
    <string>$(xml_escape "${!var}")</string>
"
  fi
done

RUN_CMD="set -a; . \"\$HOME/.claude/mission-control.env\"; exec \"${NODE_BIN}\" \"\$HOME/.mission-control/collect-skills-drift.mjs\""

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$(xml_escape "$RUN_CMD")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$(xml_escape "$HOME")</string>
${EXTRA_ENV}  </dict>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null

if ! launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
  launchctl load "$PLIST"
fi

echo "Loaded ${LABEL}: collecting every ${INTERVAL_SECONDS}s"
echo "Logs: ${LOG_FILE}  (a non-zero exit shows there; see docs/MCP.md for exit codes)"
