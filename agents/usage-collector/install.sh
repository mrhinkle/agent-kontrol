#!/usr/bin/env bash
# Install the usage collector as a launchd agent on the Mac Mini.
# Mirrors agents/progress-collector/install.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
LABEL="com.missioncontrol.usage-collector"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
INSTALL_DIR="${HOME}/.mission-control"
INSTALLED_DIR="${INSTALL_DIR}/usage-collector"
# collect_usage.py imports sibling modules (cron_parse, prices, pricing) from its
# own directory, so it must run from INSTALLED_DIR alongside them.
INSTALLED_PY="${INSTALLED_DIR}/collect_usage.py"
ENV_FILE="${HOME}/.claude/mission-control.env"
LOG_FILE="${HOME}/Library/Logs/mc-usage-collector.log"
DOMAIN="gui/$(id -u)"
INTERVAL_SECONDS="${MC_USAGE_INTERVAL:-1800}"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Removed ${LABEL}."
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
: "${MC_URL:?Set MC_URL}"
: "${MC_TOKEN:?Set MC_TOKEN}"
MC_URL="${MC_URL%/}"

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }

mkdir -p "$INSTALL_DIR" "$INSTALLED_DIR"
cp "$HERE/"*.py "$INSTALLED_DIR/"
chmod +x "$INSTALLED_PY"

# Ensure env file has MC_URL / MC_TOKEN (names only documented here)
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$(xml_escape "$INSTALLED_PY")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$INSTALLED_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MC_URL</key><string>$(xml_escape "$MC_URL")</string>
    <key>MC_TOKEN</key><string>$(xml_escape "$MC_TOKEN")</string>
    <key>MC_ENV_FILE</key><string>$(xml_escape "$ENV_FILE")</string>
  </dict>
  <key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_FILE")</string>
</dict></plist>
EOF

chmod 600 "$PLIST"
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed ${LABEL} every ${INTERVAL_SECONDS}s → ${MC_URL}/api/usage/ingest"
