#!/bin/bash
# Usage (as fleet): proxyctl.sh start <logname> <hosts> | stop
S=/tmp/akegress191-spike
case $1 in
start) setsid python3 -I $S/akproxy.py 47191 $S/$2 "$3" </dev/null >$S/proxy.out 2>&1 & echo $! > $S/proxy.pid; sleep 1; ss -ltnH "sport = :47191" | awk '{print "listening", $4}';;
stop) [ -f $S/proxy.pid ] && kill "$(cat $S/proxy.pid)" 2>/dev/null; rm -f $S/proxy.pid; sleep 1; ss -ltnH "sport = :47191" | grep -q . && echo "STILL LISTENING" || echo "proxy stopped";;
esac
