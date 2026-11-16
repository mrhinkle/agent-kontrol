#!/usr/bin/env bash
set -euo pipefail

MC_REPO="https://github.com/mrhinkle/agent-kontrol.git"
MC_DIR="./agent-kontrol"
MC_ROOT="$PWD"
MC_MODE=""
MC_START=1
MC_STEP="init"

# package.json "packageManager" is the only pin. An older pnpm already on PATH
# must not install: a pnpm 10 lockfile fails under pnpm 8/9 with --frozen-lockfile.
pnpm_package_json() {
  if [ -f "$MC_DIR/package.json" ]; then
    printf '%s\n' "$MC_DIR/package.json"
    return
  fi
  # run_pnpm is called after cd "$MC_DIR", so a relative MC_DIR no longer resolves.
  if [ -f "$MC_ROOT/$MC_DIR/package.json" ]; then
    printf '%s\n' "$MC_ROOT/$MC_DIR/package.json"
    return
  fi
  echo "quickstart: cannot find package.json for $MC_DIR" >&2
  exit 1
}

pnpm_pin() {
  local spec pkg
  pkg="$(pnpm_package_json)"
  spec="$(grep -E '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[^"]+"' "$pkg" | head -1 || true)"
  spec="${spec#*pnpm@}"
  spec="${spec%%\"*}"
  if [ -z "$spec" ]; then
    echo "quickstart: $pkg is missing packageManager pnpm@<version>" >&2
    exit 1
  fi
  printf '%s\n' "$spec"
}

# Run argv with the pinned pnpm. Use a matching binary when one is installed;
# otherwise fetch the pin with npx. Never run a different version silently.
run_pnpm() {
  local pin installed
  pin="$(pnpm_pin)"
  if command -v pnpm >/dev/null 2>&1; then
    installed="$(pnpm --version 2>/dev/null || true)"
    if [ "$installed" = "$pin" ]; then
      pnpm "$@"
      return
    fi
    echo "quickstart: found pnpm ${installed:-unknown}; using pnpm@${pin}" >&2
  fi
  npx --yes "pnpm@${pin}" "$@"
}

fail() {
  echo "quickstart: failed during step [$MC_STEP]: $*" >&2
  exit 1
}
trap 'fail "unexpected error"' ERR
set_step() { MC_STEP="$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --local) MC_MODE="local" ;;
    --dir) shift; MC_DIR="${1:?--dir requires a path}" ;;
    --no-start) MC_START=0 ;;
    *) echo "quickstart: unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

echo "agent-kontrol quickstart"
echo "  dir:   $MC_DIR"
echo "  mode:  ${MC_MODE:-auto (Docker if available)}"
echo ""

# Detect if we are already inside a clone.
in_clone() {
  [ -f package.json ] && grep -Eq '"name": *"(agent-kontrol|mission-control)"' package.json 2>/dev/null
}

set_step "prerequisites"
if [ "$MC_MODE" != "local" ]; then
  if docker compose version >/dev/null 2>&1; then
    MC_MODE="docker"
  fi
fi
if [ "${MC_MODE:-}" != "docker" ]; then
  # Fall back to local mode if Docker is unavailable (or --local given).
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "quickstart: no Docker Compose and no Node.js/npm found." >&2
    echo "  Install Docker (https://docs.docker.com/get-docker/) or Node.js >= 20 (https://nodejs.org), then re-run." >&2
    exit 1
  fi
  NODE_MAJOR="$(node -e 'const v=process.versions.node.split(".");console.log(Number(v[0]))')"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "quickstart: Node.js >= 20 required (found $(node --version)). Install from https://nodejs.org or use Docker." >&2
    exit 1
  fi
  MC_MODE="local"
fi
echo "mode: $MC_MODE"
echo ""

set_step "clone"
if in_clone; then
  MC_DIR="."
  echo "already inside a clone; using current directory"
else
  if [ -d "$MC_DIR" ] && [ -f "$MC_DIR/package.json" ] && grep -Eq '"name": *"(agent-kontrol|mission-control)"' "$MC_DIR/package.json" 2>/dev/null; then
    echo "reusing existing clone at $MC_DIR"
    (cd "$MC_DIR" && git pull --ff-only >/dev/null 2>&1) || echo "  (git pull failed; continuing with current checkout)"
  else
    command -v git >/dev/null 2>&1 || { echo "quickstart: git is required to clone the repo. Install git (https://git-scm.com) or download the repo manually." >&2; exit 1; }
    git clone --depth 1 "$MC_REPO" "$MC_DIR"
  fi
fi

set_step "env"
if [ ! -f "$MC_DIR/.env" ]; then
  rand_hex() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 24
    else
      head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
  }
  MC_TOKEN_VAL="$(rand_hex)"
  MC_DASH_VAL="$(rand_hex)"
  (
    umask 077
    {
      echo "MC_TOKEN=$MC_TOKEN_VAL"
      echo "MC_DASHBOARD_PASSWORD=$MC_DASH_VAL"
    } > "$MC_DIR/.env"
  )
  chmod 600 "$MC_DIR/.env"
  echo "created $MC_DIR/.env with a fresh MC_TOKEN and MC_DASHBOARD_PASSWORD"
else
  echo "$MC_DIR/.env already exists; leaving it untouched"
fi

if [ "$MC_MODE" = "docker" ]; then
  set_step "docker build"
  (cd "$MC_DIR" && docker compose up -d --build)

  set_step "health check"
  MC_PORT="${MC_PORT:-3000}"
  MC_URL="http://localhost:${MC_PORT}/login"
  MC_WAITED=0
  MC_OK=0
  while [ "$MC_WAITED" -lt 120 ]; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS -o /dev/null "$MC_URL" 2>/dev/null; then MC_OK=1; break; fi
    else
      if node -e "fetch('${MC_URL}').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then MC_OK=1; break; fi
    fi
    sleep 2
    MC_WAITED=$((MC_WAITED + 2))
  done
  if [ "$MC_OK" -ne 1 ]; then
    echo "quickstart: app did not respond at $MC_URL within 120s; check 'docker compose logs app'" >&2
    exit 1
  fi

  echo ""
  echo "agent-kontrol is up: $MC_URL"
  echo "Your dashboard password and agent token are in $MC_DIR/.env"
  echo "Install the agent hook with:"
  echo "  MC_URL=http://localhost:${MC_PORT} MC_TOKEN=\$(grep '^MC_TOKEN=' $MC_DIR/.env | cut -d= -f2) ./agents/claude-code/install.sh"
else
  set_step "pnpm install"
  (cd "$MC_DIR" && run_pnpm install --frozen-lockfile)
  echo ""
  echo "No DATABASE_URL set: the app will run in demo mode with sample data (no database)."
  if [ "$MC_START" = "1" ]; then
    set_step "pnpm run dev"
    cd "$MC_DIR"
    run_pnpm run dev
  else
    echo "Skipped starting (--no-start). Run 'pnpm run dev' inside $MC_DIR when ready."
  fi
fi
