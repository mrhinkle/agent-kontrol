#!/bin/sh
# No-signal stop control tests (#211), run in a private PID namespace.
#
# Usage: sh tests/unit/run_ak_stop_control_virtual.sh [unittest name ...]
# With no name it runs the whole suite. A name narrows the run, for example
#   test_ak_stop_control.StopControlTests.test_reused_pid_is_not_signalled
#
# Uses the already-local python:3.12-bookworm image and refuses to pull. CI
# pulls it in the step before. AK_STOP_CONTROL_IMAGE overrides the image for a
# manual run under another interpreter, such as python:3.9-slim.
#
# The interpreter is the container's PID 1 (no --init, no --pid=host). No
# network, no capabilities, no new privileges, nobody's uid, a read-only root,
# source mounted read-only, and scratch only on the container tmpfs.
set -eu
here=$(dirname "$0")
root=$(CDPATH='' cd "$here/../.." && pwd)
image=${AK_STOP_CONTROL_IMAGE:-python:3.12-bookworm}
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "$image is not present locally; refusing to pull" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  set -- test_ak_stop_control
fi
exec docker run --rm \
  --pull=never \
  --network none \
  --pids-limit 128 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --user 65534:65534 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  -e PYTHONUNBUFFERED=1 \
  -e HOME=/tmp \
  -e AK_STOP_CONTROL_VIRTUAL=1 \
  -v "$root/agents/dispatcher:/src/agents/dispatcher:ro" \
  -v "$root/tests/unit/test_ak_stop_control.py:/src/tests/unit/test_ak_stop_control.py:ro" \
  -w /src/tests/unit \
  "$image" \
  python -m unittest -v "$@"
