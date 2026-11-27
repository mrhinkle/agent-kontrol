#!/bin/bash
# Child probe launched by the tested CLI (hook / MCP server). Appends to $AK_CHILD_LOG (default $HOME/child.log).
# The three probes run concurrently so a CLI that exits early still lets them finish (<= 10 s).
L="${AK_CHILD_LOG:-$HOME/child.log}"
chain="$$:$(cat /proc/$$/comm)"; p=$PPID
for i in 1 2 3 4 5; do [ "$p" -gt 1 ] 2>/dev/null || break; chain="$chain <- $p:$(cat /proc/$p/comm 2>/dev/null)"; p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null); done
{ echo "child uid=$(id -u) ancestry=$chain"; echo "proxy_env=$( [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ] && echo set || echo unset )"; } >> "$L"
for u in https://github.com:443/ https://example.com:443/; do
  ( out=$(curl -sS -o /dev/null -m 10 -w '%{http_code} %{remote_ip}' "$u" 2>&1); rc=$?
    echo "child-curl pid=$BASHPID parent=$$ url=$u exit=$rc result=$(echo "$out" | tr '\n' ' ' | cut -c1-160)" >> "$L" ) &
done
( out=$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy curl --noproxy '*' -sS -o /dev/null -w '%{http_code} %{remote_ip}' -m 10 https://example.com 2>&1); rc=$?
  echo "bypass pid=$BASHPID parent=$$ exit=$rc result=$(echo "$out" | tr '\n' ' ' | cut -c1-160)" >> "$L" ) &
wait
exec timeout 5 cat >/dev/null
