#!/bin/bash
# Usage (as lane user): dims.sh <proxy|os|combo>   allowlist for all: api.openai.com, github.com
M=$1; S=/tmp/akegress191-spike
E=(env -i PATH=/usr/bin:/bin HOME=/home/akegress191 LANG=C.UTF-8)
[ "$M" != os ] && E+=(HTTPS_PROXY=http://127.0.0.1:47191 https_proxy=http://127.0.0.1:47191 HTTP_PROXY=http://127.0.0.1:47191 http_proxy=http://127.0.0.1:47191)
echo "dims mech=$M uid=$(id -u) date=$(date -u +%FT%TZ)"
c(){ local id=$1; shift; out=$("${E[@]}" curl -sS -o /dev/null -m 10 -w '%{http_code} %{remote_ip} redirect=%{redirect_url}' "$@" 2>&1); echo "$id exit=$? :: curl $* :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"; }
GH=$(getent ahostsv4 github.com | awk 'NR==1{print $1}'); OA=$(getent ahostsv4 api.openai.com | awk 'NR==1{print $1}')
c D-allow https://github.com:443/
c D-block https://example.com:443/
c D-subdomain https://api.github.com:443/
c D-alias https://www.github.com:443/
c D-redirect -L https://github.com/git/git/raw/master/README.md
c D-redirect-nofollow https://github.com/git/git/raw/master/README.md
c D-port https://github.com:8443/
c D-ipliteral -k https://$GH:443/
c D-plainhttp-allowed http://github.com/
c D-plainhttp-blocked http://example.com/
c D-host-header -H 'Host: example.com' https://github.com:443/
c D-sni-connect-to-github --connect-to example.com:443:github.com:443 https://example.com/
c D-front-cdn --connect-to example.com:443:$OA:443 https://example.com/
c D-ipv4-block -4 https://example.com/
c D-ipv6-block -6 https://example.com/
c D-ipv6-allow -6 https://api.openai.com/v1/models
c D-ipv4-allow -4 https://api.openai.com/v1/models
[ "$M" != os ] && echo "D-front-proxy :: python3 front.py 47191 api.openai.com example.com :: $(python3 -I $S/front.py 47191 api.openai.com example.com 2>&1 | tr '\n' ' ')"
echo "D-uid-sudo :: sudo -n true :: $(sudo -n true 2>&1 | head -1) exit=$?"
echo "D-icmp :: ping -c1 -W2 1.1.1.1 :: $(ping -c1 -W2 1.1.1.1 2>&1 | tail -2 | tr '\n' ' ')"
echo "D-dns-channel :: getent hosts ak191-probe-<ts>.example.com (query relayed by systemd-resolved, uid systemd-resolve) :: exit $(getent hosts ak191-probe-$(date +%s).example.com >/dev/null; echo $?) (2 = NXDOMAIN answered by upstream)"
echo "D-dns-resolve-blocked-name :: getent hosts example.com :: $(getent hosts example.com | head -1)"
