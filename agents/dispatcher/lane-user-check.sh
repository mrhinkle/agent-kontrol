#!/usr/bin/env bash
# lane-user-check.sh: prove that a lane user cannot read the secret files or
# reach the broker's admin socket (#193 AC4).
#
#   lane-user-check.sh <lane-user> <broker-config> <providers-config> <admin-socket> \
#       <env-file>... <file-provider-file>...
#
# Run it as root, or as the secrets user when a sudo rule lets that user run
# python3 as the lane user (the dispatcher's own rule does not, so every target
# is then INCONCLUSIVE). As the lane user it makes one non-mutating read of each
# file (at most one byte, discarded) and one bounded connect to the socket (2
# seconds, nothing sent). It never prints file contents. One line per target:
#
#   DENIED <path>        EACCES or EPERM on open or connect
#   READABLE <path>      the read or the connect succeeded
#   INCONCLUSIVE <path>  missing, malformed, refused, timed out, or not testable
#
# Exit 0 only when every line is DENIED, 1 otherwise, 64 for a usage error
# (fewer than five arguments, an option-like argument, or a duplicate).
set -u

usage() {
  echo "usage: lane-user-check.sh <lane-user> <broker-config> <providers-config> <admin-socket> <env-file>... <file-provider-file>..." >&2
  exit 64
}

[ "$#" -ge 5 ] || usage
for arg in "$@"; do
  case $arg in
    -*) usage ;;
  esac
done
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  for ((j = i + 1; j < ${#args[@]}; j++)); do
    [ "${args[i]}" != "${args[j]}" ] || usage
  done
done

lane=$1
shift

# Runs as the lane user. Exit 10 = DENIED, 11 = READABLE, anything else = INCONCLUSIVE.
# shellcheck disable=SC2016  # Python source, not shell
probe='
import errno, os, signal, socket, stat, sys
signal.alarm(5)
kind, path = sys.argv[1], sys.argv[2]
try:
    if kind == "file":
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOCTTY", 0))
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                sys.exit(12)
            os.read(fd, 1)
        finally:
            os.close(fd)
        sys.exit(11)
    if kind == "socket":
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2)
        try:
            s.connect(path)
        finally:
            s.close()
        sys.exit(11)
except OSError as e:
    sys.exit(10 if e.errno in (errno.EACCES, errno.EPERM) else 12)
except Exception:
    sys.exit(12)
sys.exit(12)
'

py=$(command -v python3 2>/dev/null || true)
case $py in
  /*) ;;
  *) py= ;;
esac

lane_ok=0
self_uid=$(id -u 2>/dev/null || true)
if lane_uid=$(id -u "$lane" 2>/dev/null); then
  case $lane_uid in
    '' | *[!0-9]*) ;;
    *)
      if [ "$lane_uid" -ne 0 ] && [ "$lane_uid" != "$self_uid" ]; then
        lane_ok=1
      fi
      ;;
  esac
fi

classify() {
  local kind=$1 path=$2 rc
  if [ "$lane_ok" -ne 1 ] || [ -z "$py" ]; then
    echo INCONCLUSIVE
    return
  fi
  case $path in
    /*) ;;
    *)
      echo INCONCLUSIVE
      return
      ;;
  esac
  sudo -n -u "$lane" -- "$py" -I -c "$probe" "$kind" "$path" </dev/null >/dev/null 2>&1
  rc=$?
  case $rc in
    10) echo DENIED ;;
    11) echo READABLE ;;
    *) echo INCONCLUSIVE ;;
  esac
}

status=0
report() {
  local kind=$1 path=$2 verdict
  verdict=$(classify "$kind" "$path")
  [ "$verdict" = DENIED ] || status=1
  printf '%s %s\n' "$verdict" "${path//[[:cntrl:]]/?}"
}

report file "$1"
report file "$2"
report socket "$3"
shift 3
for path in "$@"; do
  report file "$path"
done
exit "$status"
