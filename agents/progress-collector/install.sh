#!/usr/bin/env bash
# Install the progress collector as a launchd agent on this Mac.
#
# Runs scripts/collect-progress.sh every 15 minutes, which sweeps the configured
# repos and POSTs one snapshot per repo to /api/progress/ingest. Install it on a
# machine that stays awake, not a laptop, because every tick that
# doesn't run is a gap in history that cannot be recovered later.
#
# Idempotent: re-running unloads, rewrites, and reloads.
#
# Usage:
#   ./install.sh                                    # prompts for MC_URL / MC_TOKEN
#   MC_URL=https://... MC_TOKEN=secret ./install.sh
#   ./install.sh --uninstall
#
# There is deliberately no separate daily job. The board's history query takes
# the last tick of each UTC day, so the 23:45 UTC tick *is* the daily snapshot.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
LABEL="com.missioncontrol.progress-collector"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
INSTALL_DIR="${HOME}/.mission-control"
INSTALLED_SH="${INSTALL_DIR}/collect-progress.sh"
INSTALLED_CONFIG="${INSTALL_DIR}/progress.config.json"
ENV_FILE="${HOME}/.claude/mission-control.env"
LOG_FILE="${HOME}/Library/Logs/mc-progress-collector.log"
DOMAIN="gui/$(id -u)"
INTERVAL_SECONDS="${MC_PROGRESS_INTERVAL:-900}"

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

load_existing_env() {
  local f line k v
  for f in "$ENV_FILE" "${INSTALL_DIR}/mc-agent.env"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line#"${line%%[![:space:]]*}"}"
      [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
      k="${line%%=*}"; v="${line#*=}"
      v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
      case "$k" in
        MC_URL)   : "${MC_URL:=$v}" ;;
        MC_TOKEN) : "${MC_TOKEN:=$v}" ;;
      esac
    done < "$f"
  done
}

load_existing_env

if [[ -z "${MC_URL:-}" ]]; then
  [[ -t 0 ]] || { echo "Set MC_URL (or run interactively)." >&2; exit 1; }
  read -r -p "Mission Control URL (e.g. https://your-deploy.vercel.app): " MC_URL
fi
if [[ -z "${MC_TOKEN:-}" ]]; then
  [[ -t 0 ]] || { echo "Set MC_TOKEN (or run interactively)." >&2; exit 1; }
  read -r -s -p "Mission Control token: " MC_TOKEN; echo >&2
fi

MC_URL="${MC_URL%/}"
[[ -n "$MC_URL" && -n "$MC_TOKEN" ]] || { echo "MC_URL and MC_TOKEN are required." >&2; exit 1; }
case "$MC_URL" in http://*|https://*) ;; *) echo "MC_URL must start with http:// or https://" >&2; exit 1 ;; esac

for bin in gh jq curl; do
  command -v "$bin" >/dev/null || { echo "missing required command: $bin" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || {
  echo "gh is not authenticated on this machine. Run: gh auth login" >&2
  exit 1
}

[[ -f "${REPO_ROOT}/progress.config.json" ]] || {
  echo "progress.config.json not found under ${REPO_ROOT}" >&2; exit 1
}

[[ -f "${REPO_ROOT}/scripts/collect-progress.sh" ]] || {
  echo "scripts/collect-progress.sh not found under ${REPO_ROOT}" >&2; exit 1
}

mkdir -p "$INSTALL_DIR" "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs" "$(dirname "$ENV_FILE")"
cp "${REPO_ROOT}/scripts/collect-progress.sh" "$INSTALLED_SH"
chmod 755 "$INSTALLED_SH"
# The installed script runs outside the repo, so it gets its own copy of the
# watched-repo list. Edit progress.config.json in the repo, then re-run this installer.
cp "${REPO_ROOT}/progress.config.json" "$INSTALLED_CONFIG"

# The script reads this file itself, so credentials never enter the plist.
{
  printf 'MC_URL=%s\n' "$MC_URL"
  printf 'MC_TOKEN=%s\n' "$MC_TOKEN"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Wrote ${ENV_FILE}"

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
[[ -f "$PLIST" ]] && launchctl unload "$PLIST" >/dev/null 2>&1 || true

SCRIPT_XML="$(xml_escape "$INSTALLED_SH")"
HOME_XML="$(xml_escape "$HOME")"
LOG_XML="$(xml_escape "$LOG_FILE")"
PATH_XML="$(xml_escape "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_XML}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$INSTALL_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME_XML}</string>
    <key>PATH</key>
    <string>${PATH_XML}</string>
    <key>MC_PROGRESS_CONFIG</key>
    <string>$(xml_escape "$INSTALLED_CONFIG")</string>
  </dict>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
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

echo "Loaded ${LABEL} — collecting every ${INTERVAL_SECONDS}s"
echo "Logs: ${LOG_FILE}"
echo
echo "Seed the graph with real history (one-time, ~30 min, safe to re-run):"
echo "  ${INSTALLED_SH} --backfill 90"
