#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-${ROOT_DIR}/wheels/offline_deps.json}"
REQ_FILE="${REQ_FILE:-${ROOT_DIR}/requirements-offline.txt}"
WHEELS_DIR="${WHEELS_DIR:-${ROOT_DIR}/wheels}"
if [[ -n "${PYTHON_BIN:-}" ]]; then
  PYTHON_BIN="${PYTHON_BIN}"
elif command -v python3.10 >/dev/null 2>&1; then
  PYTHON_BIN="python3.10"
else
  PYTHON_BIN="python3"
fi
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "offline deps config file not found: ${CONFIG_FILE}" >&2
  exit 1
fi

TMP_REQ_FILE="$(mktemp)"
cleanup() {
  rm -f "${TMP_REQ_FILE}"
}
trap cleanup EXIT

"${PYTHON_BIN}" - "${CONFIG_FILE}" "${TMP_REQ_FILE}" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
req_path = Path(sys.argv[2])

with config_path.open("r", encoding="utf-8") as config_file:
    config = json.load(config_file)

if not isinstance(config, dict):
    raise SystemExit("offline deps config must be a JSON object")


def load_entries(key):
    value = config.get(key, [])
    if not isinstance(value, list):
        raise SystemExit(f"offline deps config key '{key}' must be a list")
    entries = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise SystemExit(
                f"offline deps config key '{key}' contains an invalid entry: {item!r}"
            )
        entries.append(item.strip())
    return entries


requirements = []
seen = set()
for group in ("files", "dependencies"):
    for spec in load_entries(group):
        if spec in seen:
            continue
        seen.add(spec)
        requirements.append(spec)

if not requirements:
    raise SystemExit("offline deps config contains no package specs")

req_path.write_text("\n".join(requirements) + "\n", encoding="utf-8")
PY

mkdir -p "${WHEELS_DIR}"
cp "${TMP_REQ_FILE}" "${REQ_FILE}"
echo "[deps] Generated requirements file: ${REQ_FILE}"
echo "[deps] Using python: ${PYTHON_BIN}"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[deps] DRY_RUN=1, skip download."
  exit 0
fi

echo "[deps] Downloading offline dependencies to ${WHEELS_DIR}"
"${PYTHON_BIN}" -m pip download \
  --ignore-installed \
  --dest "${WHEELS_DIR}" \
  -r "${TMP_REQ_FILE}"
echo "[deps] Done."
