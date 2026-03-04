#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "${script_dir}/.." && pwd)"
export DOCKER_CONFIG="${DOCKER_CONFIG:-${project_dir}/.docker-config}"
mkdir -p "${DOCKER_CONFIG}"

if command -v docker-compose >/dev/null 2>&1; then
  # docker-compose v1 (python) may import incompatible user-site packages from ~/.local.
  export PYTHONNOUSERSITE=1
  exec docker-compose "$@"
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose "$@"
fi

echo "Error: neither 'docker compose' nor 'docker-compose' was found in PATH." >&2
exit 1
