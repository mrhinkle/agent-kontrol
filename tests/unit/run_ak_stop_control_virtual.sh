#!/bin/sh
# Phase-1 virtual stop-control tests.
# Uses the already-local python:3.12-bookworm image. Refuses to pull.
# Private PID namespace (no --pid=host), no network, no extra capabilities,
# source mounted read-only, scratch only on the container tmpfs.
set -eu
here=$(dirname "$0")
root=$(CDPATH= cd "$here/../.." && pwd)
image=python:3.12-bookworm
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "$image is not present locally; refusing to pull" >&2
  exit 2
fi
exec docker run --rm \
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
  -e PYTHONPATH=/src \
  -v "$root/agents/dispatcher/ak_stop_control.py:/src/ak_stop_control.py:ro" \
  -v "$root/tests/unit/test_ak_stop_control.py:/src/test_ak_stop_control.py:ro" \
  "$image" \
  python -m unittest -v test_ak_stop_control
