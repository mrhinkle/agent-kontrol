#!/bin/bash
# Usage (as fleet, uses sudo -n): nft.sh add-os <host,...> | add-combo | show | del
set -u
case $1 in
add-os)
  v4=$(for h in ${2//,/ }; do getent ahostsv4 $h | awk '{print $1}'; done | sort -u | paste -sd, -)
  v6=$(for h in ${2//,/ }; do getent ahostsv6 $h | awk '{print $1}' | grep -v '^::ffff:'; done | sort -u | paste -sd, -)
  e6=${v6:+elements = { $v6 }}
  sudo -n nft -f - <<NFT
table inet akegress191 {
  set allow4 { type ipv4_addr; elements = { $v4 } }
  set allow6 { type ipv6_addr; $e6 }
  chain out {
    type filter hook output priority -10; policy accept;
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.53 udp dport 53 counter accept comment "ak-dns-udp"
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.53 tcp dport 53 counter accept comment "ak-dns-tcp"
    meta skuid 1003 ip daddr @allow4 tcp dport 443 counter accept comment "ak-allow4"
    meta skuid 1003 ip6 daddr @allow6 tcp dport 443 counter accept comment "ak-allow6"
    meta skuid 1003 counter drop comment "ak-drop"
  }
}
NFT
  ;;
add-combo)
  sudo -n nft -f - <<NFT
table inet akegress191 {
  chain out {
    type filter hook output priority -10; policy accept;
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.53 udp dport 53 counter accept comment "ak-dns-udp"
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.53 tcp dport 53 counter accept comment "ak-dns-tcp"
    meta skuid 1003 oifname "lo" ip daddr 127.0.0.1 tcp dport 47191 counter accept comment "ak-proxy"
    meta skuid 1003 counter drop comment "ak-drop"
  }
}
NFT
  ;;
show) sudo -n nft list table inet akegress191 2>&1 ;;
del) sudo -n nft delete table inet akegress191 2>&1 ;;
esac
