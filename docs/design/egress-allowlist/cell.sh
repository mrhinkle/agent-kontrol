#!/bin/bash
# Usage (as the lane user): cell.sh <claude|codex|grok> <none|native|proxy|os|combo> <tag> [steer]
set -u
CLI=$1 MECH=$2 TAG=$3 STEER=${4:-}
S=/tmp/akegress191-spike
T=/home/akegress191/cells/$CLI-$MECH-$TAG
rm -rf "$T"; mkdir -p "$T/work"; cd "$T/work"; git init -q . 2>/dev/null
P="Reply with the single word OK."
ENV=(PATH=/home/akegress191/bin:/usr/bin:/bin HOME="$T" USER=akegress191 LOGNAME=akegress191 SHELL=/bin/bash TERM=dumb LANG=C.UTF-8 AK_CHILD_LOG="$T/child.log")
case $MECH in proxy|combo) ENV+=(HTTPS_PROXY=http://127.0.0.1:47191 https_proxy=http://127.0.0.1:47191 HTTP_PROXY=http://127.0.0.1:47191 http_proxy=http://127.0.0.1:47191);; esac
case $CLI in
claude)
  mkdir -p "$T/.claude"
  if [ "$MECH" = native ]; then SB=',"sandbox":{"enabled":true},"permissions":{"allow":["WebFetch(domain:api.anthropic.com)","WebFetch(domain:github.com)"]}'; else SB=; fi
  printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"%s/child.sh"}]}]}%s}\n' "$S" "$SB" > "$T/.claude/settings.json"
  ENV+=(ANTHROPIC_API_KEY=sk-ant-PLACEHOLDER-not-a-key)
  [ "$STEER" = steer ] && ENV+=(ANTHROPIC_BASE_URL=https://example.com)
  CMD=(claude -p "$P" --output-format json --permission-mode acceptEdits);;
codex)
  mkdir -p "$T/.codex"
  printf '[mcp_servers.akprobe]\ncommand = "%s/child.sh"\nstartup_timeout_sec = 45\n' "$S" > "$T/.codex/config.toml"
  ENV+=(CODEX_API_KEY=sk-PLACEHOLDER-not-a-key OPENAI_API_KEY=sk-PLACEHOLDER-not-a-key)
  [ "$STEER" = steer ] && ENV+=(OPENAI_BASE_URL=https://example.com/v1)
  CMD=(codex exec --sandbox workspace-write --json "$P");;
grok)
  env -i "${ENV[@]}" grok mcp add akprobe "$S/child.sh" >/dev/null 2>&1
  ENV+=(XAI_API_KEY=xai-PLACEHOLDER-not-a-key)
  [ "$MECH" = native ] && ENV+=(GROK_SANDBOX=workspace)
  CMD=(grok -p "$P" --output-format json);;
esac
echo "cell=$CLI-$MECH-$TAG steer=${STEER:-no} cwd=$T/work uid=$(id -u) user=$(id -un) root=no date=$(date -u +%FT%TZ)"
echo "argv: ${CMD[0]} $(printf '%q ' "${CMD[@]:1}" | sed "s/$(printf '%q' "$P" | sed 's/[][\.*^$/]/\\&/g')/<P1>/")"
echo "env-names: $(printf '%s\n' "${ENV[@]}" | cut -d= -f1 | tr '\n' ' ')"
TO=150; [ "$STEER" = steer ] && TO=60
start=$(date +%s)
env -i "${ENV[@]}" timeout "$TO" strace -f -qq -e trace=connect -e signal=none -o "$T/strace.txt" "${CMD[@]}" </dev/null >"$T/stdout" 2>"$T/stderr"
rc=$?
echo "exit=$rc elapsed=$(( $(date +%s) - start ))s timeout=${TO}s"
python3 -I $S/summarize.py "$T/strace.txt" "$T/stdout" "$T/stderr"
[ -f "$T/child.log" ] && sed 's/^/  /' "$T/child.log" || echo "  child.log: none (no child launched)"
