#!/usr/bin/env bash
# Install the Mission Control hook for Claude Code on this machine.
# Usage: MC_URL=https://your-deploy.vercel.app MC_TOKEN=yourtoken ./install.sh
set -euo pipefail

if [[ -z "${MC_URL:-}" || -z "${MC_TOKEN:-}" ]]; then
  echo "Set MC_URL and MC_TOKEN first, e.g.:"
  echo "  MC_URL=https://mission-control.vercel.app MC_TOKEN=secret ./install.sh"
  exit 1
fi

mkdir -p ~/.claude
cp "$(dirname "$0")/mission_control_hook.py" ~/.claude/mission_control_hook.py
chmod +x ~/.claude/mission_control_hook.py

# The hook reads this file itself, so it works no matter how the app was
# launched (terminal, Dock, IDE). Re-running the installer updates it.
cat > ~/.claude/mission-control.env <<EOF
MC_URL=$MC_URL
MC_TOKEN=$MC_TOKEN
EOF
chmod 600 ~/.claude/mission-control.env
echo "Wrote ~/.claude/mission-control.env"

echo ""
echo "Hook script installed at ~/.claude/mission_control_hook.py"
echo "Now merge agents/claude-code/settings-fragment.json into ~/.claude/settings.json"
echo "(or ask Claude Code to do it: 'merge this hooks fragment into my settings')."
