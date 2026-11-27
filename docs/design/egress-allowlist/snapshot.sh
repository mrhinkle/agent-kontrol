#!/bin/bash
# Canonical AC8/D8 snapshot: policy state only; counters, timestamps and PIDs stripped.
set -u
sec(){ printf '\n=== %s ===\n' "$1"; }
sec "iptables-save (counters zeroed, comments dropped)"; sudo -n iptables-save | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]/[0:0]/'
sec "ip6tables-save"; sudo -n ip6tables-save | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]/[0:0]/'
sec "nft -s list ruleset (stateless)"; sudo -n nft -s list ruleset 2>/dev/null
sec "nft list tables"; sudo -n nft list tables 2>/dev/null
sec "TCP/UDP listeners (address, process name; pid/fd stripped)"; sudo -n ss -ltnupH | awk '{print $1, $5, $7}' | sed -E 's/pid=[0-9]+,//g; s/,?fd=[0-9]+//g' | sort -u
sec "proxy-like processes and lane-user processes"; sudo -n ps -eo user=,comm= | grep -Ei 'proxy|squid|privoxy|mitm|socat|akegress' | sort | uniq -c || echo none
sec "routes"; ip -4 route show table all | grep -Ev '^(local|broadcast) ' ; ip -6 route show table all | sed -E 's/ expires [0-9]+sec//' | grep -Ev '^(local|multicast|anycast) '
sec "rules"; ip -4 rule; ip -6 rule
sec "resolv.conf"; cat /etc/resolv.conf | grep -v '^#'
sec "resolvectl"; resolvectl dns; resolvectl domain
sec "users"; getent passwd akegress191 || echo "no akegress191 passwd"; getent group akegress191 || echo "no akegress191 group"; ls -1 /home; ls -1 /var/mail 2>/dev/null; sudo -n sha256sum /etc/passwd /etc/group /etc/shadow /etc/gshadow /etc/subuid /etc/subgid | awk '{print $1, $2}'
sec "kernel modules (names)"; lsmod | awk 'NR>1{print $1}' | sort
sec "environment and proxy settings"; sha256sum /etc/environment; ls -1 /etc/profile.d; grep -il proxy /etc/environment /etc/profile.d/* 2>/dev/null || echo "no proxy setting in /etc/environment or /etc/profile.d"
sec "fleet CLI settings (sha256 only)"; for f in ~/.claude/settings.json ~/.codex/config.toml ~/.grok/config.toml ~/.grok/settings.json ~/.bashrc ~/.profile ~/.claude/mission-control.env ~/.mission-control/env; do if [ -e "$f" ]; then sha256sum "$f" | awk '{print $1, $2}'; else echo "absent $f"; fi; done
sec "spike temp paths"; ls -d /tmp/akegress191* /home/akegress191 2>/dev/null || echo "none"
