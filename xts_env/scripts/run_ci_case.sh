#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[ci-case] $*"
}

die() {
  echo "[ci-case] Error: $*" >&2
  exit 1
}

print_highlight() {
  local color_code="$1"
  shift
  if [[ -n "${NO_COLOR:-}" ]]; then
    printf '%s\n' "$*"
  else
    printf '\033[%sm%s\033[0m\n' "${color_code}" "$*"
  fi
}

usage() {
  cat <<'EOF'
用法:
  ./scripts/run_ci_case.sh <ci_ref> [options]

说明:
  传入流水线 runlist URL、event API URL 或 event id，脚本会解析出镜像包和 TDD 用例包，
  复用/启动 docker-compose.env.yml 中的 tdd-env 容器，并在容器内执行测试命令。

参数:
  <ci_ref>                     流水线引用，支持:
                               - https://.../workbench/cicd/detail/<event_id>/runlist
                               - https://.../api/codecheckAccess/ci-portal/v1/event/<event_id>
                               - <event_id>
  -t, --task-type <type>      指定测试类型，默认 UT
  -tp, --test-part <name>     指定部件，可独立使用
  -tm, --module <name>        指定模块，需结合 -tp 使用
  -ts, --suite <name>         指定测试套，可独立使用
  -tc, --test-case <name>     指定测试用例，需结合 -ts 使用
  -cov, --coverage <value>    覆盖率执行参数
  -ra, --random <value>       C++ 用例乱序执行参数
  -pd, --partdeps <value>     二级依赖部件执行参数
  --repeat <count>            设置执行次数
  -hl, --history-list <n>     显示最近 n 条历史记录
  -rh, --run-history <n>      执行第 n 条历史记录
  --retry                     重跑上次失败用例
  --device-sn <sn>            设备序列号
  --device-ip <ip>            设备 IP
  --device-port <port>        设备端口，默认 8710
  --product-form <name>       产品形态，默认 rk3568
  --command <cmd>             自定义容器内执行命令，覆盖默认 start.sh 命令
  --skip-flash                跳过刷机，只执行测试命令
  -h, --help                  查看帮助

依赖环境变量:
  DCP_AUTHORIZATION / DCP_COOKIE / DCP_TOKEN
    访问 DCP event API 或私有制品时可通过这些变量透传认证头。
EOF
}

shell_quote() {
  printf '%q' "$1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_xts_env_dir() {
  local candidate="${OHOS_TDD_COMPOSE_DIR:-}"
  if [[ -n "${candidate}" ]]; then
    [[ -d "${candidate}" ]] || die "Compose directory not found: ${candidate}"
    [[ -f "${candidate}/docker-compose.env.yml" ]] || die "docker-compose.env.yml not found in: ${candidate}"
    (cd "${candidate}" && pwd -P)
    return
  fi

  if [[ -f "${PWD}/docker-compose.env.yml" ]]; then
    (cd "${PWD}" && pwd -P)
    return
  fi

  if [[ -f "${PWD}/xts_env/docker-compose.env.yml" ]]; then
    (cd "${PWD}/xts_env" && pwd -P)
    return
  fi

  (cd "${SCRIPT_DIR}/.." && pwd -P)
}

derive_compose_project_name() {
  python3 - "$1" <<'PY'
import hashlib
import os
import re
import sys

xts_env_dir = os.path.realpath(sys.argv[1])
parent_name = os.path.basename(os.path.dirname(xts_env_dir)) or os.path.basename(xts_env_dir) or "xts_env"
base = re.sub(r"[^a-z0-9]+", "_", parent_name.lower()).strip("_") or "xts_env"
digest = hashlib.sha1(xts_env_dir.encode("utf-8")).hexdigest()[:10]
project_name = f"{base}_{digest}"
if not re.match(r"^[a-z0-9]", project_name):
    project_name = f"p_{project_name}"
print(project_name[:63])
PY
}

read_compose_project_name_from_env_file() {
  local env_file="$1"
  [[ -f "${env_file}" ]] || return 0
  python3 - "${env_file}" <<'PY'
import pathlib
import sys

env_file = pathlib.Path(sys.argv[1])
for raw_line in env_file.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key.strip() != "COMPOSE_PROJECT_NAME":
        continue
    value = value.strip().strip('"').strip("'")
    if value:
        print(value)
    break
PY
}

XTS_ENV_DIR="$(resolve_xts_env_dir)"
COMPOSE_FILE="${XTS_ENV_DIR}/docker-compose.env.yml"
if [[ -f "${XTS_ENV_DIR}/scripts/download_and_unpack.py" ]]; then
  ARCHIVE_HELPER="${XTS_ENV_DIR}/scripts/download_and_unpack.py"
else
  ARCHIVE_HELPER="${SCRIPT_DIR}/download_and_unpack.py"
fi
ENV_FILE_COMPOSE_PROJECT_NAME="$(read_compose_project_name_from_env_file "${XTS_ENV_DIR}/.env")"
COMPOSE_PROJECT_NAME_EFFECTIVE="${OHOS_TDD_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-${ENV_FILE_COMPOSE_PROJECT_NAME:-$(derive_compose_project_name "${XTS_ENV_DIR}")}}}"
SERVICE_NAME="${OHOS_TDD_ENV_SERVICE:-tdd-env}"
CONTAINER_NAME_HINT="${OHOS_TDD_ENV_CONTAINER:-}"
CONTAINER_REF=""
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

ci_ref=""
product_form="${PRODUCT_FORM:-}"
task_type="${TASK_TYPE:-}"
test_part="${TEST_PART:-}"
device_ip="${DEVICE_IP:-}"
device_port="${DEVICE_PORT:-}"
device_sn="${DEVICE_SN:-}"
test_module="${TEST_MODULE:-}"
test_suite_name="${TEST_SUITE_NAME:-}"
test_case_name="${TEST_CASE:-}"
coverage_value="${TEST_COVERAGE:-}"
random_value="${TEST_RANDOM:-}"
partdeps_value="${TEST_PARTDEPS:-}"
repeat_count="${TEST_REPEAT:-}"
history_list="${TEST_HISTORYLIST:-}"
run_history="${TEST_RUNHISTORY:-}"
retry_mode="${TEST_RETRY:-}"
custom_command=""
skip_flash=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -t|--task-type)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      task_type="$2"
      shift 2
      ;;
    -tp|--test-part|--part)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      test_part="$2"
      shift 2
      ;;
    -tm|--module|--test-module)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      test_module="$2"
      shift 2
      ;;
    -ts|--suite|--case|--suite-name|--test-suite)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      test_suite_name="$2"
      shift 2
      ;;
    -tc|--test-case|--case-name|--test-case-name)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      test_case_name="$2"
      shift 2
      ;;
    -cov|--coverage)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      coverage_value="$2"
      shift 2
      ;;
    -ra|--random)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      random_value="$2"
      shift 2
      ;;
    -pd|--partdeps|--part-deps)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      partdeps_value="$2"
      shift 2
      ;;
    --repeat)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      repeat_count="$2"
      shift 2
      ;;
    -hl|--history-list)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      history_list="$2"
      shift 2
      ;;
    -rh|--run-history)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      run_history="$2"
      shift 2
      ;;
    --retry)
      retry_mode=1
      shift
      ;;
    --device-sn)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      device_sn="$2"
      shift 2
      ;;
    --device-ip)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      device_ip="$2"
      shift 2
      ;;
    --device-port)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      device_port="$2"
      shift 2
      ;;
    --product-form)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      product_form="$2"
      shift 2
      ;;
    --command)
      [[ "$#" -ge 2 ]] || die "Option $1 requires a value."
      custom_command="$2"
      shift 2
      ;;
    --skip-flash)
      skip_flash=1
      shift
      ;;
    --)
      shift
      if [[ "$#" -gt 0 && -z "${custom_command}" ]]; then
        custom_command="$*"
        shift "$#"
      fi
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      if [[ -z "${ci_ref}" ]]; then
        ci_ref="$1"
      elif [[ -z "${custom_command}" ]]; then
        custom_command="$1"
      else
        die "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -n "${ci_ref}" ]] || {
  usage >&2
  die "Missing <ci_ref>."
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_command docker
require_command python3
require_command curl
require_command tar
require_command find

COMPOSE_CMD=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  die "Neither 'docker compose' nor 'docker-compose' is available."
fi

compose_in_xts_env() {
  (
    cd "${XTS_ENV_DIR}"
    "${COMPOSE_CMD[@]}" -p "${COMPOSE_PROJECT_NAME_EFFECTIVE}" -f "${COMPOSE_FILE}" "$@"
  )
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_truthy() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

validate_test_selection_args() {
  [[ -n "${custom_command}" ]] && return

  if [[ -n "${test_module}" && -z "${test_part}" ]]; then
    die "-tm/--module cannot be used without -tp/--test-part."
  fi
  if [[ -n "${test_case_name}" && -z "${test_suite_name}" ]]; then
    die "-tc/--test-case cannot be used without -ts/--suite."
  fi
  if [[ -n "${repeat_count}" ]] && ! is_positive_integer "${repeat_count}"; then
    die "--repeat must be a positive integer."
  fi
  if [[ -n "${history_list}" ]] && ! is_positive_integer "${history_list}"; then
    die "-hl/--history-list must be a positive integer."
  fi
  if [[ -n "${run_history}" ]] && ! is_positive_integer "${run_history}"; then
    die "-rh/--run-history must be a positive integer."
  fi
}

container_compose_workdir() {
  local container_name="$1"
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "${container_name}" 2>/dev/null || true
}

container_compose_config_file() {
  local container_name="$1"
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "${container_name}" 2>/dev/null || true
}

container_compose_project() {
  local container_name="$1"
  docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "${container_name}" 2>/dev/null || true
}

container_matches_selected_compose() {
  local container_name="$1"
  local working_dir config_file
  working_dir="$(container_compose_workdir "${container_name}")"
  config_file="$(container_compose_config_file "${container_name}")"
  [[ "${working_dir}" == "${XTS_ENV_DIR}" || "${config_file}" == "${COMPOSE_FILE}" ]]
}

find_conflicting_named_container() {
  if [[ -n "${CONTAINER_NAME_HINT}" ]] && docker container inspect "${CONTAINER_NAME_HINT}" >/dev/null 2>&1; then
    if ! container_matches_selected_compose "${CONTAINER_NAME_HINT}"; then
      printf '%s\n' "${CONTAINER_NAME_HINT}"
      return 0
    fi
  fi
  return 1
}

find_container_by_compose_workdir() {
  local ref=""
  ref="$(
    docker ps -aq \
      --filter "label=com.docker.compose.project.working_dir=${XTS_ENV_DIR}" \
      --filter "label=com.docker.compose.service=${SERVICE_NAME}" \
      | head -n 1 || true
  )"
  [[ -n "${ref}" ]] || return 1
  printf '%s\n' "${ref}"
}

resolve_artifact_urls() {
  local reference="$1"
  CI_REFERENCE="${reference}" python3 - <<'PY'
import json
import os
import re
import sys
import urllib.parse
import urllib.request

IMAGE_ARTIFACT_PATTERN = re.compile(r"artifacts-dayu200-(?!.*_tdd)[^\"'<>\\\s]*-version-dayu200\.tar\.gz", re.I)
TDD_ARTIFACT_PATTERN = re.compile(r"artifacts-dayu200_tdd-[^\"'<>\\\s]*-version-dayu200_tdd\.tar\.gz", re.I)
IMAGE_ARTIFACT_URL_PATTERN = re.compile(
    r"https?:\/\/dcp\.openharmony\.cn\/Artifacts\/dayu200\/[0-9-]+\/version\/Artifacts-dayu200-[^\"'<>\\\s]*-version-dayu200\.tar\.gz",
    re.I,
)
TDD_ARTIFACT_URL_PATTERN = re.compile(
    r"https?:\/\/dcp\.openharmony\.cn\/Artifacts\/dayu200_tdd\/[0-9-]+\/version\/Artifacts-dayu200_tdd-[^\"'<>\\\s]*-version-dayu200_tdd\.tar\.gz",
    re.I,
)
IMAGE_ARTIFACT_PATH_PATTERN = re.compile(
    r"\/?Artifacts\/dayu200\/[0-9-]+\/version\/Artifacts-dayu200-[^\"'<>\\\s]*-version-dayu200\.tar\.gz",
    re.I,
)
TDD_ARTIFACT_PATH_PATTERN = re.compile(
    r"\/?Artifacts\/dayu200_tdd\/[0-9-]+\/version\/Artifacts-dayu200_tdd-[^\"'<>\\\s]*-version-dayu200_tdd\.tar\.gz",
    re.I,
)
ARTIFACT_BASE_PATH_PATTERN = re.compile(r"\/?Artifacts\/([a-z0-9_-]+)\/([a-z0-9_-]+)", re.I)
TOKEN_PATTERN = re.compile(r"(?:https?:\/\/|\/\/|\/|\.\.?\/)?[^\s\"'<>`]*artifacts-[^\s\"'<>`]*?\.tar\.gz(?:\?[^\s\"'<>`]*)?", re.I)
RUNLIST_PATTERN = re.compile(r"/workbench/cicd/detail/([^/?#]+)/runlist", re.I)
EVENT_API_PATTERN = re.compile(r"/api/codecheckAccess/ci-portal/v1/event/([^/?#]+)", re.I)


def force_https_for_dcp(url_value: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url_value)
    except Exception:
        return url_value
    if parsed.hostname == "dcp.openharmony.cn" and parsed.scheme != "https":
        parsed = parsed._replace(scheme="https")
    return urllib.parse.urlunparse(parsed)


def normalize_artifact_text(raw: str) -> str:
    text = str(raw or "")
    text = re.sub(r"\\u002f", "/", text, flags=re.I)
    text = re.sub(r"\\u003a", ":", text, flags=re.I)
    text = text.replace("\\/", "/")
    text = re.sub(r"&quot;", "\"", text, flags=re.I)
    text = re.sub(r"&#39;|&apos;", "'", text, flags=re.I)
    text = re.sub(r"&lt;", "<", text, flags=re.I)
    text = re.sub(r"&gt;", ">", text, flags=re.I)
    text = re.sub(r"&amp;", "&", text, flags=re.I)
    return text


def build_headers():
    headers = {
        "User-Agent": "ohos-test-runner/1.0",
    }
    auth = os.environ.get("DCP_AUTHORIZATION", "").strip()
    cookie = os.environ.get("DCP_COOKIE", "").strip()
    token = os.environ.get("DCP_TOKEN", "").strip()
    if auth:
        headers["Authorization"] = auth
    if cookie:
        headers["Cookie"] = cookie
    if token:
        headers["x-auth-token"] = token
    return headers


def fetch_text(url: str) -> str:
    request = urllib.request.Request(force_https_for_dcp(url), headers=build_headers())
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read().decode("utf-8", errors="replace")


def build_artifact_download_url(target: str, build_number: str) -> str | None:
    target = str(target or "").strip()
    build_number = str(build_number or "").strip()
    if not target or not build_number:
        return None
    url = f"https://dcp.openharmony.cn/Artifacts/{target}/{build_number}/version/Artifacts-{target}-{build_number}-version-{target}.tar.gz"
    return force_https_for_dcp(url)


def normalize_candidate_url(raw: str, base_url: str) -> str | None:
    cleaned = str(raw or "").strip().strip("\"'`()[],;")
    if not cleaned:
        return None
    if re.match(r"^https?://", cleaned, re.I):
        return force_https_for_dcp(cleaned)
    if cleaned.startswith("//"):
        base = urllib.parse.urlparse(base_url)
        scheme = base.scheme or "https"
        return force_https_for_dcp(f"{scheme}:{cleaned}")
    if cleaned.startswith("/"):
        return force_https_for_dcp(urllib.parse.urljoin("https://dcp.openharmony.cn/", cleaned))
    if re.search(r"(?:^|/)?Artifacts/", cleaned, re.I) or re.search(r"artifacts-.*\.tar\.gz", cleaned, re.I):
        normalized = cleaned.lstrip("./")
        return force_https_for_dcp(urllib.parse.urljoin("https://dcp.openharmony.cn/", normalized))
    return None


def collect_from_base_paths(text: str):
    urls = []
    for matched in ARTIFACT_BASE_PATH_PATTERN.finditer(text):
        candidate = build_artifact_download_url(matched.group(1), matched.group(2))
        if candidate:
            urls.append(candidate)
    return urls


def collect_artifact_candidates(raw_text: str, base_url: str):
    text = normalize_artifact_text(raw_text)
    urls = []
    urls.extend(force_https_for_dcp(item.group(0)) for item in IMAGE_ARTIFACT_URL_PATTERN.finditer(text))
    urls.extend(force_https_for_dcp(item.group(0)) for item in TDD_ARTIFACT_URL_PATTERN.finditer(text))
    urls.extend(
        force_https_for_dcp(f"https://dcp.openharmony.cn{item.group(0) if item.group(0).startswith('/') else '/' + item.group(0)}")
        for item in IMAGE_ARTIFACT_PATH_PATTERN.finditer(text)
    )
    urls.extend(
        force_https_for_dcp(f"https://dcp.openharmony.cn{item.group(0) if item.group(0).startswith('/') else '/' + item.group(0)}")
        for item in TDD_ARTIFACT_PATH_PATTERN.finditer(text)
    )
    for item in TOKEN_PATTERN.finditer(text):
        candidate = normalize_candidate_url(item.group(0), base_url)
        if candidate:
            urls.append(candidate)
    urls.extend(collect_from_base_paths(text))
    deduped = []
    seen = set()
    for url in urls:
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def collect_artifact_candidates_from_unknown(value, base_url: str):
    candidates = []
    queue = [value]
    visited = set()
    while queue:
      current = queue.pop()
      if isinstance(current, str):
          candidates.extend(collect_artifact_candidates(current, base_url))
          continue
      if current is None:
          continue
      if isinstance(current, (int, float, bool)):
          continue
      current_id = id(current)
      if current_id in visited:
          continue
      visited.add(current_id)
      if isinstance(current, list):
          queue.extend(current)
          continue
      if isinstance(current, dict):
          queue.extend(current.values())
    deduped = []
    seen = set()
    for url in candidates:
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def matches_artifact(url: str, pattern) -> bool:
    return bool(pattern.search(urllib.parse.unquote(url)))


def pick_artifacts(candidates):
    image_url = next((item for item in candidates if matches_artifact(item, IMAGE_ARTIFACT_PATTERN)), None)
    tdd_url = next((item for item in candidates if matches_artifact(item, TDD_ARTIFACT_PATTERN)), None)
    if not image_url:
        raise RuntimeError("Cannot find dayu200 image artifact URL.")
    if not tdd_url:
        raise RuntimeError("Cannot find dayu200_tdd artifact URL.")
    return image_url, tdd_url


def synthetic_runlist_url(event_id: str) -> str:
    return f"https://dcp.openharmony.cn/workbench/cicd/detail/{event_id}/runlist"


def extract_runlist_event_id(value: str) -> str | None:
    matched = RUNLIST_PATTERN.search(str(value))
    if not matched:
        return None
    event_id = matched.group(1).strip()
    return event_id or None


def extract_event_api_id(value: str) -> str | None:
    matched = EVENT_API_PATTERN.search(str(value))
    if not matched:
        return None
    event_id = matched.group(1).strip()
    return event_id or None


def parse_candidates(raw_text: str, base_url: str):
    candidates = collect_artifact_candidates(raw_text, base_url)
    try:
        payload = json.loads(raw_text)
    except Exception:
        payload = None
    if payload is not None:
        for item in collect_artifact_candidates_from_unknown(payload, base_url):
            if item not in candidates:
                candidates.append(item)
    return candidates


def discover_from_event_api_url(api_url: str, base_url: str):
    raw = fetch_text(api_url)
    candidates = parse_candidates(raw, base_url)
    if not candidates:
        raise RuntimeError("No artifact URLs found in event api response.")
    return pick_artifacts(candidates)


def discover(reference: str):
    ref = str(reference or "").strip()
    if not ref:
        raise RuntimeError("CI reference is empty.")

    if re.match(r"^https?://", ref, re.I):
        normalized = force_https_for_dcp(ref)
        event_id = extract_runlist_event_id(normalized)
        if event_id:
            try:
                return discover_from_event_api_url(
                    f"https://dcp.openharmony.cn/api/codecheckAccess/ci-portal/v1/event/{event_id}",
                    normalized,
                )
            except Exception as exc:
                event_error = str(exc)
                raw = fetch_text(normalized)
                candidates = parse_candidates(raw, normalized)
                if not candidates:
                    raise RuntimeError(f"No artifact URLs found. event-api-error: {event_error}")
                return pick_artifacts(candidates)

        event_api_id = extract_event_api_id(normalized)
        if event_api_id:
            return discover_from_event_api_url(normalized, synthetic_runlist_url(event_api_id))

        raw = fetch_text(normalized)
        candidates = parse_candidates(raw, normalized)
        if not candidates:
            raise RuntimeError("No artifact URLs found in provided URL response.")
        return pick_artifacts(candidates)

    if re.match(r"^[A-Za-z0-9_-]+$", ref):
        api_url = f"https://dcp.openharmony.cn/api/codecheckAccess/ci-portal/v1/event/{ref}"
        return discover_from_event_api_url(api_url, synthetic_runlist_url(ref))

    raise RuntimeError("Unsupported CI reference. Use runlist URL, event API URL, or event id.")


try:
    image_url, tdd_url = discover(os.environ["CI_REFERENCE"])
except Exception as exc:
    print(f"resolve-artifacts failed: {exc}", file=sys.stderr)
    sys.exit(1)

print(image_url)
print(tdd_url)
PY
}

container_exists() {
  local ref
  ref="$(resolve_container_ref || true)"
  [[ -n "${ref}" ]]
}

container_running() {
  local ref="${CONTAINER_REF:-}"
  if [[ -z "${ref}" ]]; then
    ref="$(resolve_container_ref || true)"
  fi
  [[ -n "${ref}" ]] || return 1
  [[ "$(docker inspect -f '{{.State.Running}}' "${ref}" 2>/dev/null || true)" == "true" ]]
}

resolve_container_ref() {
  local ref=""
  ref="$(compose_in_xts_env ps -q "${SERVICE_NAME}" 2>/dev/null | head -n 1 || true)"
  if [[ -n "${ref}" ]]; then
    printf '%s\n' "${ref}"
    return 0
  fi

  ref="$(find_container_by_compose_workdir || true)"
  if [[ -n "${ref}" ]]; then
    printf '%s\n' "${ref}"
    return 0
  fi

  if [[ -n "${CONTAINER_NAME_HINT}" ]] && docker container inspect "${CONTAINER_NAME_HINT}" >/dev/null 2>&1; then
    if container_matches_selected_compose "${CONTAINER_NAME_HINT}"; then
      printf '%s\n' "${CONTAINER_NAME_HINT}"
      return 0
    fi
  fi

  return 1
}

ensure_container_running() {
  local conflicting_container=""
  local container_project=""
  conflicting_container="$(find_conflicting_named_container || true)"
  if [[ -n "${conflicting_container}" ]]; then
    die "Container ${conflicting_container} belongs to compose dir $(container_compose_workdir "${conflicting_container}"), current compose dir is ${XTS_ENV_DIR}. Run the script from the target project directory, or remove/recreate the old container first."
  fi

  CONTAINER_REF="$(resolve_container_ref || true)"
  if container_exists; then
    container_project="$(container_compose_project "${CONTAINER_REF}")"
    if [[ -n "${container_project}" && "${container_project}" != "${COMPOSE_PROJECT_NAME_EFFECTIVE}" ]]; then
      log "Reusing legacy container from same compose dir: ${CONTAINER_REF} (project=${container_project})"
    fi
    if container_running; then
      log "Container already exists and is running: ${CONTAINER_REF}"
      return
    fi
    log "Starting existing container: ${CONTAINER_REF}"
    docker start "${CONTAINER_REF}" >/dev/null
    return
  fi

  log "Creating container from $(basename "${COMPOSE_FILE}")"
  compose_in_xts_env up -d "${SERVICE_NAME}"
  CONTAINER_REF="$(resolve_container_ref || true)"
  [[ -n "${CONTAINER_REF}" ]] || die "Cannot resolve container for service ${SERVICE_NAME} after compose up."
}

load_container_context() {
  local inspect_json
  inspect_json="$(docker inspect "${CONTAINER_REF}")"
  INSPECT_JSON="${inspect_json}" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["INSPECT_JSON"])[0]
env = {}
for item in payload.get("Config", {}).get("Env", []):
    if "=" not in item:
        continue
    key, value = item.split("=", 1)
    env[key] = value

mounts = {}
for item in payload.get("Mounts", []):
    destination = item.get("Destination", "")
    source = item.get("Source", "")
    if destination:
        mounts[destination] = source

work_root = env.get("WORK_ROOT", "/workspace")
tdd_root = env.get("TDD_ROOT", f"{work_root}/TDD")
tests_dir = env.get("TEST_CASES_DIR", f"{work_root}/tests")
images_dir = env.get("TEST_IMAGE_DIR", f"{work_root}/images")
download_root = env.get("DOWNLOAD_ROOT", f"{work_root}/downloads")
reports_dir = env.get("REPORTS_DIR", f"{tdd_root}/testfwk_developer_test/reports")

pairs = [
    ("WORK_ROOT", work_root),
    ("TDD_ROOT", tdd_root),
    ("TEST_CASES_DIR", tests_dir),
    ("TEST_IMAGE_DIR", images_dir),
    ("DOWNLOAD_ROOT", download_root),
    ("REPORTS_DIR", reports_dir),
    ("PRODUCT_FORM", env.get("PRODUCT_FORM", "")),
    ("DEVICE_IP", env.get("DEVICE_IP", "")),
    ("DEVICE_PORT", env.get("DEVICE_PORT", "")),
    ("DEVICE_SN", env.get("DEVICE_SN", "")),
    ("TASK_TYPE", env.get("TASK_TYPE", "")),
    ("TEST_PART", env.get("TEST_PART", "")),
    ("DEV_REPO_COMMIT", env.get("DEV_REPO_COMMIT", "")),
    ("TEST_MODULE", env.get("TEST_MODULE", "")),
    ("TEST_SUITE_NAME", env.get("TEST_SUITE_NAME", "")),
    ("TEST_CASE", env.get("TEST_CASE", "")),
    ("TEST_COVERAGE", env.get("TEST_COVERAGE", "")),
    ("TEST_RANDOM", env.get("TEST_RANDOM", "")),
    ("TEST_PARTDEPS", env.get("TEST_PARTDEPS", "")),
    ("TEST_REPEAT", env.get("TEST_REPEAT", "")),
    ("TEST_HISTORYLIST", env.get("TEST_HISTORYLIST", "")),
    ("TEST_RUNHISTORY", env.get("TEST_RUNHISTORY", "")),
    ("TEST_RETRY", env.get("TEST_RETRY", "")),
    ("TDD_HOST_DIR", mounts.get(tdd_root, "")),
    ("TEST_CASES_HOST_DIR", mounts.get(tests_dir, "")),
    ("IMAGE_HOST_DIR", mounts.get(images_dir, "")),
    ("DOWNLOAD_HOST_DIR", mounts.get(download_root, "")),
    ("REPORTS_HOST_DIR", mounts.get(reports_dir, "")),
]

for key, value in pairs:
    print(f"{key}\t{value}")
PY
}

assign_context_from_container() {
  local line key value
  while IFS=$'\t' read -r key value; do
    case "${key}" in
      WORK_ROOT) WORK_ROOT="${value}" ;;
      TDD_ROOT) TDD_ROOT="${value}" ;;
      TEST_CASES_DIR) TEST_CASES_DIR="${value}" ;;
      TEST_IMAGE_DIR) TEST_IMAGE_DIR="${value}" ;;
      DOWNLOAD_ROOT) DOWNLOAD_ROOT="${value}" ;;
      REPORTS_DIR) REPORTS_DIR="${value}" ;;
      PRODUCT_FORM) CONTAINER_PRODUCT_FORM="${value}" ;;
      DEVICE_IP) CONTAINER_DEVICE_IP="${value}" ;;
      DEVICE_PORT) CONTAINER_DEVICE_PORT="${value}" ;;
      DEVICE_SN) CONTAINER_DEVICE_SN="${value}" ;;
      TASK_TYPE) CONTAINER_TASK_TYPE="${value}" ;;
      TEST_PART) CONTAINER_TEST_PART="${value}" ;;
      DEV_REPO_COMMIT) CONTAINER_DEV_REPO_COMMIT="${value}" ;;
      TEST_MODULE) CONTAINER_TEST_MODULE="${value}" ;;
      TEST_SUITE_NAME) CONTAINER_TEST_SUITE_NAME="${value}" ;;
      TEST_CASE) CONTAINER_TEST_CASE="${value}" ;;
      TEST_COVERAGE) CONTAINER_TEST_COVERAGE="${value}" ;;
      TEST_RANDOM) CONTAINER_TEST_RANDOM="${value}" ;;
      TEST_PARTDEPS) CONTAINER_TEST_PARTDEPS="${value}" ;;
      TEST_REPEAT) CONTAINER_TEST_REPEAT="${value}" ;;
      TEST_HISTORYLIST) CONTAINER_TEST_HISTORYLIST="${value}" ;;
      TEST_RUNHISTORY) CONTAINER_TEST_RUNHISTORY="${value}" ;;
      TEST_RETRY) CONTAINER_TEST_RETRY="${value}" ;;
      TDD_HOST_DIR) TDD_HOST_DIR="${value}" ;;
      TEST_CASES_HOST_DIR) TEST_CASES_HOST_DIR="${value}" ;;
      IMAGE_HOST_DIR) IMAGE_HOST_DIR="${value}" ;;
      DOWNLOAD_HOST_DIR) DOWNLOAD_HOST_DIR="${value}" ;;
      REPORTS_HOST_DIR) REPORTS_HOST_DIR="${value}" ;;
    esac
  done < <(load_container_context)
}

ensure_framework_ready() {
  local repo_root="${ACTIVE_TEST_REPO_DIR:-${TDD_ROOT}/testfwk_developer_test}"
  local xdevice_root="${ACTIVE_XDEVICE_DIR:-${TDD_ROOT}/xdevice}"
  local xdevice_alt_root="${ACTIVE_XDEVICE_ALT_DIR:-${TDD_ROOT}/testfwk_xdevice}"
  local check_script
  check_script=$(
    cat <<EOF
set -euo pipefail
test -x $(shell_quote "${repo_root}/start.sh")
if [[ ! -d $(shell_quote "${xdevice_root}") && ! -d $(shell_quote "${xdevice_alt_root}") ]]; then
  exit 1
fi
EOF
  )

  if docker exec "${CONTAINER_REF}" bash -lc "${check_script}" >/dev/null 2>&1; then
    return
  fi

  log "Framework repo is not ready inside container, restarting once to trigger entrypoint seeding"
  docker restart "${CONTAINER_REF}" >/dev/null
  sleep 2
  docker exec "${CONTAINER_REF}" bash -lc "${check_script}" >/dev/null 2>&1 || \
    die "Framework repositories are still not ready in container ${CONTAINER_REF}."
}

git_repo_head() {
  local repo_dir="$1"
  if [[ ! -d "${repo_dir}/.git" ]]; then
    return 1
  fi
  git -c safe.directory="${repo_dir}" -C "${repo_dir}" rev-parse HEAD 2>/dev/null
}

prepare_runtime_framework_repo() {
  local active_repo_dir="${ACTIVE_TEST_REPO_DIR:-${TDD_ROOT}/testfwk_developer_test}"
  local active_reports_dir="${ACTIVE_REPORTS_DIR:-${REPORTS_DIR}}"
  local script=""

  script=$(
    cat <<EOF
set -euo pipefail
mkdir -p $(shell_quote "${active_reports_dir}")
if [[ -L $(shell_quote "${active_repo_dir}/reports") ]]; then
  ln -sfn $(shell_quote "${active_reports_dir}") $(shell_quote "${active_repo_dir}/reports")
elif [[ -d $(shell_quote "${active_repo_dir}/reports") ]]; then
  rm -rf $(shell_quote "${active_repo_dir}/reports")
  ln -s $(shell_quote "${active_reports_dir}") $(shell_quote "${active_repo_dir}/reports")
elif [[ ! -e $(shell_quote "${active_repo_dir}/reports") ]]; then
  ln -s $(shell_quote "${active_reports_dir}") $(shell_quote "${active_repo_dir}/reports")
fi
EOF
  )

  docker exec "${CONTAINER_REF}" bash -lc "${script}" >/dev/null || \
    die "Failed to prepare runtime framework repository ${active_repo_dir}."
}

select_runtime_framework_repo() {
  local host_repo_dir="${TDD_HOST_DIR}/testfwk_developer_test"
  local desired_commit="${CONTAINER_DEV_REPO_COMMIT:-}"
  local host_commit=""
  local prepared_repo_dir="/opt/tdd-prepared/testfwk_developer_test"
  local prepared_xdevice_dir="/opt/tdd-prepared/xdevice"
  local prepared_xdevice_alt_dir="/opt/tdd-prepared/testfwk_xdevice"

  ACTIVE_TEST_REPO_DIR="${TDD_ROOT}/testfwk_developer_test"
  ACTIVE_XDEVICE_DIR="${TDD_ROOT}/xdevice"
  ACTIVE_XDEVICE_ALT_DIR="${TDD_ROOT}/testfwk_xdevice"
  ACTIVE_REPORTS_DIR="${REPORTS_DIR}"

  if [[ -z "${desired_commit}" ]]; then
    return
  fi

  host_commit="$(git_repo_head "${host_repo_dir}" || true)"
  if [[ -n "${host_commit}" && "${host_commit}" == "${desired_commit}" ]]; then
    return
  fi

  if docker exec "${CONTAINER_REF}" test -x "${prepared_repo_dir}/start.sh" >/dev/null 2>&1; then
    log "Mounted testfwk_developer_test is at ${host_commit:-unknown}, expected ${desired_commit}; use prepared framework repo from image."
    ACTIVE_TEST_REPO_DIR="${prepared_repo_dir}"
    ACTIVE_XDEVICE_DIR="${prepared_xdevice_dir}"
    ACTIVE_XDEVICE_ALT_DIR="${prepared_xdevice_alt_dir}"
    prepare_runtime_framework_repo
  else
    log "Mounted testfwk_developer_test is at ${host_commit:-unknown}, expected ${desired_commit}, but prepared framework repo is unavailable in container."
  fi
}

build_curl_args() {
  CURL_ARGS=(--location --fail --show-error --connect-timeout 15 --max-time 7200)
  if [[ -t 2 ]]; then
    CURL_ARGS+=(--progress-bar)
  else
    CURL_ARGS+=(--no-progress-meter)
  fi
  if [[ -n "${DCP_AUTHORIZATION:-}" ]]; then
    CURL_ARGS+=(-H "Authorization: ${DCP_AUTHORIZATION}")
  fi
  if [[ -n "${DCP_COOKIE:-}" ]]; then
    CURL_ARGS+=(-H "Cookie: ${DCP_COOKIE}")
  fi
  if [[ -n "${DCP_TOKEN:-}" ]]; then
    CURL_ARGS+=(-H "x-auth-token: ${DCP_TOKEN}")
  fi
}

file_size_bytes() {
  local target="$1"
  if [[ ! -e "${target}" ]]; then
    printf '0\n'
    return
  fi
  stat -c '%s' "${target}" 2>/dev/null || printf '0\n'
}

hash_text() {
  python3 - "$1" <<'PY'
import hashlib
import sys

print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest())
PY
}

guess_filename_from_url() {
  python3 - "$1" <<'PY'
import os
import sys
import urllib.parse

path = urllib.parse.urlparse(sys.argv[1]).path
name = os.path.basename(path)
print(name if name else "download.bin")
PY
}

human_bytes() {
  python3 - "$1" <<'PY'
import sys

value = float(sys.argv[1] or "0")
units = ["B", "KiB", "MiB", "GiB", "TiB"]
for unit in units:
    if value < 1024 or unit == units[-1]:
        if unit == "B":
            print(f"{int(value)}{unit}")
        else:
            print(f"{value:.1f}{unit}")
        break
    value /= 1024
PY
}

human_duration() {
  python3 - "$1" <<'PY'
import sys

seconds = float(sys.argv[1] or "0")
if seconds < 60:
    print(f"{seconds:.1f}s")
elif seconds < 3600:
    minutes = int(seconds // 60)
    remain = seconds - minutes * 60
    print(f"{minutes}m{remain:.0f}s")
else:
    hours = int(seconds // 3600)
    remain = seconds - hours * 3600
    minutes = int(remain // 60)
    secs = remain - minutes * 60
    print(f"{hours}h{minutes}m{secs:.0f}s")
PY
}

archive_cache_path() {
  local cache_root="$1"
  local kind="$2"
  local url="$3"
  local digest filename
  digest="$(hash_text "${url}")"
  filename="$(guess_filename_from_url "${url}")"
  printf '%s/%s-%s-%s\n' "${cache_root}" "${kind}" "${digest}" "${filename}"
}

extract_cache_path() {
  local cache_root="$1"
  local kind="$2"
  local url="$3"
  local digest
  digest="$(hash_text "${url}")"
  printf '%s/%s-%s\n' "${cache_root}" "${kind}" "${digest}"
}

clear_directory_contents() {
  local target_dir="$1"
  [[ -n "${target_dir}" ]] || die "Refusing to clear empty directory path."
  [[ "${target_dir}" != "/" ]] || die "Refusing to clear root directory."
  mkdir -p "${target_dir}"
  find "${target_dir}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

copy_dir_content() {
  local src_dir="$1"
  local dst_dir="$2"
  mkdir -p "${dst_dir}"
  cp -R "${src_dir}/." "${dst_dir}/"
}

host_path_to_container_path() {
  local host_path="$1"
  local host_root="$2"
  local container_root="$3"
  local rel_path=""

  case "${host_path}" in
    "${host_root}")
      printf '%s\n' "${container_root}"
      ;;
    "${host_root}/"*)
      rel_path="${host_path#"${host_root}"/}"
      printf '%s/%s\n' "${container_root}" "${rel_path}"
      ;;
    *)
      die "Cannot translate host path to container path: ${host_path}"
      ;;
  esac
}

prepare_mounts_in_container() {
  local tests_source_host="$1"
  local image_source_host="$2"
  local tests_source_container=""
  local image_source_container=""
  local script=""

  tests_source_container="$(host_path_to_container_path "${tests_source_host}" "${DOWNLOAD_HOST_DIR}" "${DOWNLOAD_ROOT}")"
  image_source_container="$(host_path_to_container_path "${image_source_host}" "${DOWNLOAD_HOST_DIR}" "${DOWNLOAD_ROOT}")"

  script=$(
    cat <<EOF
set -euo pipefail
mkdir -p $(shell_quote "${TEST_CASES_DIR}") $(shell_quote "${TEST_IMAGE_DIR}")
find $(shell_quote "${TEST_CASES_DIR}") -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find $(shell_quote "${TEST_IMAGE_DIR}") -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -R $(shell_quote "${tests_source_container}")/. $(shell_quote "${TEST_CASES_DIR}")/
cp -R $(shell_quote "${image_source_container}")/. $(shell_quote "${TEST_IMAGE_DIR}")/
chown -R $(shell_quote "${HOST_UID}:${HOST_GID}") $(shell_quote "${TEST_CASES_DIR}") $(shell_quote "${TEST_IMAGE_DIR}")
EOF
  )

  log "Prepare mounted tests dir in container: ${tests_source_container} -> ${TEST_CASES_DIR}"
  log "Prepare mounted images dir in container: ${image_source_container} -> ${TEST_IMAGE_DIR}"
  docker exec "${CONTAINER_REF}" bash -lc "${script}" || die "Failed to prepare mounted directories in container."
}

find_tests_source() {
  local extract_root="$1"
  local found
  found="$(find "${extract_root}" -type d -name tests | head -n 1 || true)"
  [[ -n "${found}" ]] || die "Cannot find tests directory under ${extract_root}"
  printf '%s\n' "${found}"
}

find_image_source() {
  local extract_root="$1"
  local loader_file
  loader_file="$(find "${extract_root}" -type f -name MiniLoaderAll.bin | head -n 1 || true)"
  if [[ -n "${loader_file}" ]]; then
    dirname "${loader_file}"
    return 0
  fi

  local fallback_dir
  fallback_dir="$(find "${extract_root}" -mindepth 1 -maxdepth 2 -type d | head -n 1 || true)"
  [[ -n "${fallback_dir}" ]] || die "Cannot locate image directory under ${extract_root}"
  printf '%s\n' "${fallback_dir}"
}

ensure_archive_extracted() {
  local archive_file="$1"
  local extract_root="$2"
  local label="$3"
  local result_path=""
  log "Prepare extracted ${label} cache: ${extract_root}"
  result_path="$(
    python3 "${ARCHIVE_HELPER}" \
      --archive "${archive_file}" \
      --extract-dir "${extract_root}"
  )" || die "Failed to extract ${label}: ${archive_file}"
  [[ -n "${result_path}" ]] || die "Extraction returned empty result for ${label}."
}

download_file() {
  local url="$1"
  local out_file="$2"
  local label="$3"
  local part_file="${out_file}.part"
  local start_ts end_ts elapsed total_size avg_speed
  local max_attempts="${DOWNLOAD_RETRY_COUNT:-8}"
  local attempt=1
  local sleep_seconds=3
  local current_size=0
  local curl_rc=0
  mkdir -p "$(dirname "${out_file}")"
  if [[ -s "${out_file}" ]]; then
    log "Reuse cached ${label}: ${out_file} (size=$(human_bytes "$(stat -c '%s' "${out_file}")"))"
    return
  fi

  start_ts="$(date +%s)"
  while (( attempt <= max_attempts )); do
    current_size="$(file_size_bytes "${part_file}")"
    if (( current_size > 0 )); then
      log "Resume ${label} download (attempt ${attempt}/${max_attempts}) from $(human_bytes "${current_size}"): ${url}"
    else
      log "Downloading ${label} (attempt ${attempt}/${max_attempts}): ${url}"
    fi

    curl_rc=0
    if curl \
      "${CURL_ARGS[@]}" \
      --continue-at - \
      --output "${part_file}" \
      "${url}"; then
      mv -f "${part_file}" "${out_file}"
      end_ts="$(date +%s)"
      elapsed=$(( end_ts - start_ts ))
      if (( elapsed <= 0 )); then
        elapsed=1
      fi
      total_size="$(file_size_bytes "${out_file}")"
      avg_speed=$(( total_size / elapsed ))
      log "Download done: ${label} size=$(human_bytes "${total_size}") avg_speed=$(human_bytes "${avg_speed}")/s time=$(human_duration "${elapsed}")"
      return
    else
      curl_rc=$?
    fi
    current_size="$(file_size_bytes "${part_file}")"

    if [[ "${curl_rc}" == "33" && -s "${part_file}" ]]; then
      log "Server does not support resume for ${label}; restart from scratch."
      rm -f "${part_file}"
      current_size=0
    fi

    if (( attempt == max_attempts )); then
      die "Failed to download ${label}: ${url} (curl_exit=${curl_rc}, partial=$(human_bytes "${current_size}"), part_file=${part_file})"
    fi

    log "Download interrupted for ${label} (curl_exit=${curl_rc}, partial=$(human_bytes "${current_size}")), retry in ${sleep_seconds}s"
    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
    if (( sleep_seconds < 30 )); then
      sleep_seconds=$((sleep_seconds * 2))
    fi
  done
}

count_files_in_dir() {
  local target_dir="$1"
  find "${target_dir}" -type f | wc -l | tr -d ' '
}

latest_report_path() {
  local reports_dir="$1"
  [[ -d "${reports_dir}" ]] || return 0
  find "${reports_dir}" -mindepth 1 -maxdepth 1 \( -type d -o -type f -o -type l \) \
    ! -name latest \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-
}

print_result_paths() {
  local host_reports_dir="${REPORTS_HOST_DIR:-}"
  local container_reports_dir="${ACTIVE_REPORTS_DIR:-${REPORTS_DIR:-}}"
  local latest_path=""

  print_highlight "1;36" "[ci-case] ===== Execution Results ====="
  if [[ -n "${host_reports_dir}" ]]; then
    print_highlight "1;33" "[ci-case] Host reports: ${host_reports_dir}"
    latest_path="$(latest_report_path "${host_reports_dir}")"
    if [[ -n "${latest_path}" ]]; then
      print_highlight "1;32" "[ci-case] Latest result: ${latest_path}"
    fi
  fi
  if [[ -n "${container_reports_dir}" ]]; then
    print_highlight "1;34" "[ci-case] Container reports: ${container_reports_dir}"
  fi
}

verify_prepared_mounts() {
  local tests_count image_count image_loader

  tests_count="$(count_files_in_dir "${TEST_CASES_HOST_DIR}")"
  image_count="$(count_files_in_dir "${IMAGE_HOST_DIR}")"
  image_loader="$(find "${IMAGE_HOST_DIR}" -type f -name MiniLoaderAll.bin | head -n 1 || true)"

  [[ "${tests_count}" != "0" ]] || die "No test files were copied into ${TEST_CASES_HOST_DIR}."
  [[ "${image_count}" != "0" ]] || die "No image files were copied into ${IMAGE_HOST_DIR}."

  if [[ -n "${image_loader}" ]]; then
    log "Image loader found: ${image_loader}"
  else
    log "Image files copied, but MiniLoaderAll.bin was not found under ${IMAGE_HOST_DIR}"
  fi
}

prepare_artifacts() {
  local image_url="$1"
  local tdd_url="$2"
  local run_id="$3"
  local run_root="${DOWNLOAD_HOST_DIR}/ci-runs/${run_id}"
  local cache_root="${DOWNLOAD_HOST_DIR}/ci-cache"
  local archive_cache_root="${cache_root}/archives"
  local extract_cache_root="${cache_root}/extracted"
  local image_archive
  local tdd_archive
  local image_extract
  local tdd_extract
  local tests_source
  local image_source

  image_archive="$(archive_cache_path "${archive_cache_root}" "dayu200-image" "${image_url}")"
  tdd_archive="$(archive_cache_path "${archive_cache_root}" "dayu200-tdd" "${tdd_url}")"
  image_extract="$(extract_cache_path "${extract_cache_root}" "dayu200-image" "${image_url}")"
  tdd_extract="$(extract_cache_path "${extract_cache_root}" "dayu200-tdd" "${tdd_url}")"

  mkdir -p "${run_root}" "${archive_cache_root}" "${extract_cache_root}" "${TEST_CASES_HOST_DIR}" "${IMAGE_HOST_DIR}" "${DOWNLOAD_HOST_DIR}"

  cat > "${run_root}/manifest.env" <<EOF
RUN_ID=${run_id}
IMAGE_ARTIFACT_URL=${image_url}
TDD_ARTIFACT_URL=${tdd_url}
IMAGE_ARCHIVE_CACHE=${image_archive}
TDD_ARCHIVE_CACHE=${tdd_archive}
IMAGE_EXTRACT_CACHE=${image_extract}
TDD_EXTRACT_CACHE=${tdd_extract}
TEST_CASES_HOST_DIR=${TEST_CASES_HOST_DIR}
IMAGE_HOST_DIR=${IMAGE_HOST_DIR}
EOF

  download_file "${image_url}" "${image_archive}" "image artifact"
  download_file "${tdd_url}" "${tdd_archive}" "tdd artifact"

  ensure_archive_extracted "${image_archive}" "${image_extract}" "image artifact"
  ensure_archive_extracted "${tdd_archive}" "${tdd_extract}" "tdd artifact"

  tests_source="$(find_tests_source "${tdd_extract}")"
  image_source="$(find_image_source "${image_extract}")"
  log "Resolved tests source: ${tests_source}"
  log "Resolved image source: ${image_source}"

  log "Preparing mounted test/image directories"
  prepare_mounts_in_container "${tests_source}" "${image_source}"

  verify_prepared_mounts
  log "Tests prepared: ${TEST_CASES_HOST_DIR} (files=$(count_files_in_dir "${TEST_CASES_HOST_DIR}"))"
  log "Images prepared: ${IMAGE_HOST_DIR} (files=$(count_files_in_dir "${IMAGE_HOST_DIR}"))"
  log "Run manifest: ${run_root}/manifest.env"
}

update_user_config_in_container() {
  local config_path="${ACTIVE_TEST_REPO_DIR:-${TDD_ROOT}/testfwk_developer_test}/config/user_config.xml"
  local cmd

  docker exec "${CONTAINER_REF}" test -f "${config_path}" >/dev/null 2>&1 || \
    die "Missing user_config.xml in container: ${config_path}"

  cmd="python3 /opt/tdd-tools/configure_user_config.py"
  cmd+=" --config $(shell_quote "${config_path}")"
  cmd+=" --tests-dir $(shell_quote "${TEST_CASES_DIR}")"
  cmd+=" --port $(shell_quote "${device_port}")"
  if [[ -n "${device_ip}" ]]; then
    cmd+=" --ip $(shell_quote "${device_ip}")"
  fi
  if [[ -n "${device_sn}" ]]; then
    cmd+=" --sn $(shell_quote "${device_sn}")"
  fi

  log "Refreshing user_config.xml inside container"
  docker exec "${CONTAINER_REF}" bash -lc "${cmd}"
}

build_default_test_command() {
  local cmd="./start.sh run -p $(shell_quote "${product_form}") -t $(shell_quote "${task_type}")"
  if [[ -n "${test_part}" ]]; then
    cmd+=" -tp $(shell_quote "${test_part}")"
  fi
  if [[ -n "${test_module}" ]]; then
    cmd+=" -tm $(shell_quote "${test_module}")"
  fi
  if [[ -n "${test_suite_name}" ]]; then
    cmd+=" -ts $(shell_quote "${test_suite_name}")"
  fi
  if [[ -n "${test_case_name}" ]]; then
    cmd+=" -tc $(shell_quote "${test_case_name}")"
  fi
  if [[ -n "${coverage_value}" ]]; then
    cmd+=" -cov $(shell_quote "${coverage_value}")"
  fi
  if [[ -n "${random_value}" ]]; then
    cmd+=" -ra $(shell_quote "${random_value}")"
  fi
  if [[ -n "${partdeps_value}" ]]; then
    cmd+=" -pd $(shell_quote "${partdeps_value}")"
  fi
  if [[ -n "${repeat_count}" ]]; then
    cmd+=" --repeat $(shell_quote "${repeat_count}")"
  fi
  if [[ -n "${history_list}" ]]; then
    cmd+=" -hl $(shell_quote "${history_list}")"
  fi
  if [[ -n "${run_history}" ]]; then
    cmd+=" -rh $(shell_quote "${run_history}")"
  fi
  if is_truthy "${retry_mode}"; then
    cmd+=" --retry"
  fi
  printf '%s\n' "${cmd}"
}

run_in_container() {
  local test_repo_dir="${ACTIVE_TEST_REPO_DIR:-${TDD_ROOT}/testfwk_developer_test}"
  local run_cmd
  local run_script=""
  local docker_exec_flags=(-i)

  if [[ -n "${custom_command}" ]]; then
    run_cmd="${custom_command}"
  else
    run_cmd="$(build_default_test_command)"
  fi

  run_script+=$'set -euo pipefail\n'
  run_script+=$'print_flash_diagnostics() {\n'
  run_script+=$'  echo "[ci-case] ----- flash diagnostics begin -----"\n'
  run_script+=$'  echo "[ci-case] user: $(id -u):$(id -g) $(id -un 2>/dev/null || true)"\n'
  run_script+=$'  echo "[ci-case] usb path:"\n'
  run_script+=$'  ls -ld /dev/bus/usb 2>&1 || true\n'
  run_script+=$'  echo "[ci-case] usb nodes sample:"\n'
  run_script+=$'  find /dev/bus/usb -maxdepth 2 -type c 2>/dev/null | head -n 10 || true\n'
  run_script+=$'  echo "[ci-case] udev path:"\n'
  run_script+=$'  ls -ld /run/udev 2>&1 || true\n'
  run_script+=$'  if command -v hdc >/dev/null 2>&1; then\n'
  run_script+=$'    echo "[ci-case] hdc list targets -v:"\n'
  run_script+=$'    hdc list targets -v 2>&1 || true\n'
  run_script+=$'  fi\n'
  run_script+=$'  if [ -x /opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool ]; then\n'
  run_script+=$'    echo "[ci-case] upgrade_tool ld:"\n'
  run_script+=$'    /opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool ld 2>&1 || true\n'
  run_script+=$'  fi\n'
  run_script+=$'  echo "[ci-case] ----- flash diagnostics end -----"\n'
  run_script+=$'}\n'
  if [[ "${skip_flash}" -eq 0 ]]; then
    run_script+=$'print_flash_diagnostics\n'
    run_script+="echo '[ci-case] Flash image from ${TEST_IMAGE_DIR}'"$'\n'
    run_script+="/opt/tools/flash/flash.sh $(shell_quote "${TEST_IMAGE_DIR}")"$'\n'
  fi
  run_script+="cd $(shell_quote "${test_repo_dir}")"$'\n'
  run_script+="printf '%s\\n' $(shell_quote "[ci-case] Execute: ${run_cmd}")"$'\n'
  run_script+="${run_cmd}"$'\n'

  if [[ -t 0 && -t 1 ]]; then
    docker_exec_flags=(-it)
  fi

  docker exec "${docker_exec_flags[@]}" "${CONTAINER_REF}" bash -lc "${run_script}"
}

build_curl_args

log "Using compose dir: ${XTS_ENV_DIR}"
log "Using compose project: ${COMPOSE_PROJECT_NAME_EFFECTIVE}"
log "Resolving artifact URLs from CI reference"
artifact_output="$(resolve_artifact_urls "${ci_ref}")"
mapfile -t artifact_lines <<<"${artifact_output}"
[[ "${#artifact_lines[@]}" -ge 2 ]] || die "Failed to resolve image and tdd artifact URLs."
image_artifact_url="${artifact_lines[0]}"
tdd_artifact_url="${artifact_lines[1]}"

log "Image artifact: ${image_artifact_url}"
log "TDD artifact: ${tdd_artifact_url}"

ensure_container_running
assign_context_from_container

[[ -n "${TDD_HOST_DIR:-}" ]] || die "Cannot resolve TDD host mount from container ${CONTAINER_REF}."
[[ -n "${TEST_CASES_HOST_DIR:-}" ]] || die "Cannot resolve tests host mount from container ${CONTAINER_REF}."
[[ -n "${IMAGE_HOST_DIR:-}" ]] || die "Cannot resolve images host mount from container ${CONTAINER_REF}."
[[ -n "${DOWNLOAD_HOST_DIR:-}" ]] || die "Cannot resolve downloads host mount from container ${CONTAINER_REF}."

product_form="${product_form:-${CONTAINER_PRODUCT_FORM:-rk3568}}"
device_ip="${device_ip:-${CONTAINER_DEVICE_IP:-}}"
device_port="${device_port:-${CONTAINER_DEVICE_PORT:-8710}}"
device_sn="${device_sn:-${CONTAINER_DEVICE_SN:-}}"
task_type="${task_type:-${CONTAINER_TASK_TYPE:-UT}}"
test_part="${test_part:-${CONTAINER_TEST_PART:-}}"
test_module="${test_module:-${CONTAINER_TEST_MODULE:-}}"
test_suite_name="${test_suite_name:-${CONTAINER_TEST_SUITE_NAME:-}}"
test_case_name="${test_case_name:-${CONTAINER_TEST_CASE:-}}"
coverage_value="${coverage_value:-${CONTAINER_TEST_COVERAGE:-}}"
random_value="${random_value:-${CONTAINER_TEST_RANDOM:-}}"
partdeps_value="${partdeps_value:-${CONTAINER_TEST_PARTDEPS:-}}"
repeat_count="${repeat_count:-${CONTAINER_TEST_REPEAT:-}}"
history_list="${history_list:-${CONTAINER_TEST_HISTORYLIST:-}}"
run_history="${run_history:-${CONTAINER_TEST_RUNHISTORY:-}}"
retry_mode="${retry_mode:-${CONTAINER_TEST_RETRY:-0}}"

validate_test_selection_args
select_runtime_framework_repo
ensure_framework_ready

run_id="$(date +%Y%m%d-%H%M%S)-$$"
prepare_artifacts "${image_artifact_url}" "${tdd_artifact_url}" "${run_id}"
update_user_config_in_container
run_status=0
if run_in_container; then
  run_status=0
else
  run_status=$?
fi
print_result_paths
exit "${run_status}"
