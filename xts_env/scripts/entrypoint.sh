#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[tdd] $*"
}

die() {
  echo "[tdd] Error: $*" >&2
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

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_truthy() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

git_repo() {
  local repo_dir="$1"
  shift
  git -c safe.directory="${repo_dir}" -C "${repo_dir}" "$@"
}

clone_repo() {
  local repo_url="$1"
  local target_dir="$2"
  local branch="$3"

  if [[ -d "${target_dir}/.git" ]]; then
    log "Repository already exists: ${target_dir}"
    return
  fi

  if [[ -e "${target_dir}" && ! -d "${target_dir}" ]]; then
    log "Path exists but is not a directory: ${target_dir}"
    exit 1
  fi

  if [[ -d "${target_dir}" ]] && [[ -n "$(ls -A "${target_dir}")" ]]; then
    log "Directory is not empty and not a git repo, skip clone: ${target_dir}"
    return
  fi

  local clone_args=()
  if [[ -n "${branch}" ]]; then
    clone_args+=(--branch "${branch}")
  fi

  log "Cloning ${repo_url} -> ${target_dir}"
  git clone --depth 1 "${clone_args[@]}" "${repo_url}" "${target_dir}"
}

ensure_repo_commit() {
  local repo_dir="$1"
  local commit="$2"
  local label="$3"
  local branch="${4:-}"

  if [[ -z "${commit}" ]]; then
    return 0
  fi
  if [[ ! -d "${repo_dir}/.git" ]]; then
    return 0
  fi

  if ! git_repo "${repo_dir}" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    log "Fetching ${label} commit ${commit}"
    if [[ -n "${branch}" ]]; then
      git_repo "${repo_dir}" fetch --depth 200 origin "${branch}"
    else
      git_repo "${repo_dir}" fetch --depth 200 origin '+refs/heads/*:refs/remotes/origin/*'
    fi
  fi

  if ! git_repo "${repo_dir}" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    log "Deepen ${label} history to reach commit ${commit}"
    git_repo "${repo_dir}" fetch --unshallow origin || \
      git_repo "${repo_dir}" fetch --depth 2000 origin '+refs/heads/*:refs/remotes/origin/*'
  fi

  local current_commit
  current_commit="$(git_repo "${repo_dir}" rev-parse HEAD)"
  if [[ "${current_commit}" != "${commit}" ]]; then
    log "Checkout ${label} to commit ${commit}"
    git_repo "${repo_dir}" checkout --detach "${commit}"
  fi
}

ensure_xdevice_layout() {
  local tdd_root="$1"

  if [[ -d "${tdd_root}/testfwk_xdevice" && ! -e "${tdd_root}/xdevice" ]]; then
    ln -s testfwk_xdevice "${tdd_root}/xdevice"
  fi

  if [[ -d "${tdd_root}/xdevice" && ! -e "${tdd_root}/testfwk_xdevice" ]]; then
    ln -s xdevice "${tdd_root}/testfwk_xdevice"
  fi
}

copy_prepared_repo_if_needed() {
  local source_dir="$1"
  local target_dir="$2"
  local label="$3"
  local marker_path="${4:-}"

  if [[ ! -d "${source_dir}" ]]; then
    return
  fi

  if [[ -e "${target_dir}" && ! -d "${target_dir}" ]]; then
    die "Path exists but is not a directory: ${target_dir}"
  fi

  if [[ ! -e "${target_dir}" ]]; then
    mkdir -p "$(dirname "${target_dir}")"
    cp -R "${source_dir}" "${target_dir}"
    log "Seeded ${label} from image to ${target_dir}"
    return
  fi

  if [[ -d "${target_dir}" ]] && [[ -z "$(ls -A "${target_dir}")" ]]; then
    copy_dir_content "${source_dir}" "${target_dir}"
    log "Seeded ${label} into empty directory ${target_dir}"
    return
  fi

  if [[ -n "${marker_path}" ]] && [[ ! -e "${target_dir}/${marker_path}" ]]; then
    copy_dir_content "${source_dir}" "${target_dir}"
    log "Seeded ${label} into incomplete directory ${target_dir}"
  fi
}

seed_prepared_frameworks() {
  local tdd_root="$1"
  local prepared_root="${PREPARED_TDD_ROOT:-/opt/tdd-prepared}"

  copy_prepared_repo_if_needed \
    "${prepared_root}/testfwk_developer_test" \
    "${tdd_root}/testfwk_developer_test" \
    "testfwk_developer_test" \
    "start.sh"
  copy_prepared_repo_if_needed \
    "${prepared_root}/xdevice" \
    "${tdd_root}/xdevice" \
    "xdevice"
  ensure_xdevice_layout "${tdd_root}"
}

ensure_prepared_frameworks() {
  local tdd_root="$1"
  local dev_repo_dir="${tdd_root}/testfwk_developer_test"
  local xdevice_dir="${tdd_root}/xdevice"
  local xdevice_alt_dir="${tdd_root}/testfwk_xdevice"

  if [[ ! -d "${dev_repo_dir}" || ! -e "${dev_repo_dir}/start.sh" ]]; then
    die "Missing ${dev_repo_dir}. Provide prepared repositories on host or rebuild image with baked TDD repositories."
  fi

  if [[ ! -d "${xdevice_dir}" && ! -d "${xdevice_alt_dir}" ]]; then
    die "Missing xdevice repository under ${tdd_root}. Provide prepared repositories on host or rebuild image with baked TDD repositories."
  fi

  ensure_xdevice_layout "${tdd_root}"
}

prepare_framework_repos() {
  local tdd_root="$1"
  local prepared_only="$2"
  local dev_dir="${tdd_root}/testfwk_developer_test"
  local xdevice_dir="${tdd_root}/xdevice"
  local xdevice_alt_dir="${tdd_root}/testfwk_xdevice"

  seed_prepared_frameworks "${tdd_root}"

  if [[ "${prepared_only}" == "1" ]]; then
    ensure_prepared_frameworks "${tdd_root}"
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    log "git is not available in container; fallback to prepared repositories mode."
    ensure_prepared_frameworks "${tdd_root}"
    return
  fi

  clone_repo "${DEV_REPO_URL}" "${dev_dir}" "${DEV_REPO_BRANCH}"
  ensure_repo_commit "${dev_dir}" "${DEV_REPO_COMMIT}" "testfwk_developer_test" "${DEV_REPO_BRANCH}"
  ensure_xdevice_layout "${tdd_root}"

  if [[ ! -d "${xdevice_dir}/.git" && ! -d "${xdevice_alt_dir}/.git" ]]; then
    clone_repo "${XDEVICE_REPO_URL}" "${xdevice_dir}" "${XDEVICE_REPO_BRANCH}"
  fi

  if [[ -d "${xdevice_dir}/.git" ]]; then
    ensure_repo_commit "${xdevice_dir}" "${XDEVICE_REPO_COMMIT}" "xdevice" "${XDEVICE_REPO_BRANCH}"
  elif [[ -d "${xdevice_alt_dir}/.git" ]]; then
    ensure_repo_commit "${xdevice_alt_dir}" "${XDEVICE_REPO_COMMIT}" "xdevice" "${XDEVICE_REPO_BRANCH}"
  fi

  ensure_prepared_frameworks "${tdd_root}"
}

download_payload() {
  local url="$1"
  local dest_dir="$2"
  local label="$3"
  local result=""

  if [[ -z "${url}" ]]; then
    return 0
  fi

  echo "[tdd] Downloading ${label}: ${url}" >&2
  if ! result="$(python3 /opt/tdd-tools/download_and_unpack.py --url "${url}" --dest "${dest_dir}")"; then
    if result="$(find_existing_download_payload "${dest_dir}")"; then
      echo "[tdd] Failed to download ${label}, fallback to existing payload: ${result}" >&2
      printf "%s\n" "${result}"
      return 0
    fi
    die "Failed to download ${label} from ${url}. Check DNS/proxy settings or pre-populate ${dest_dir}."
  fi
  echo "[tdd] ${label} prepared at: ${result}" >&2
  printf "%s\n" "${result}"
}

copy_dir_content() {
  local src_dir="$1"
  local dst_dir="$2"
  mkdir -p "${dst_dir}"
  cp -R "${src_dir}/." "${dst_dir}/"
}

find_existing_download_payload() {
  local dest_dir="$1"
  local extracted_dir="${dest_dir}/extracted"
  local child_count=""
  local first_child=""
  local archive_file=""

  if [[ -d "${extracted_dir}" ]] && [[ -n "$(find "${extracted_dir}" -mindepth 1 -print -quit)" ]]; then
    child_count="$(find "${extracted_dir}" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
    first_child="$(find "${extracted_dir}" -mindepth 1 -maxdepth 1 | head -n 1 || true)"
    if [[ "${child_count}" == "1" && -d "${first_child}" ]]; then
      printf "%s\n" "${first_child}"
    else
      printf "%s\n" "${extracted_dir}"
    fi
    return 0
  fi

  archive_file="$(find "${dest_dir}" -maxdepth 1 -type f | head -n 1 || true)"
  if [[ -n "${archive_file}" ]]; then
    printf "%s\n" "${archive_file}"
    return 0
  fi

  return 1
}

link_hdc_binary() {
  local binary_path="$1"
  if [[ ! -f "${binary_path}" ]]; then
    return 1
  fi
  chmod +x "${binary_path}" || true
  ln -sf "${binary_path}" /usr/local/bin/hdc
  export hdc_std="${binary_path}"
  log "HDC linked: ${binary_path}"
  return 0
}

find_and_link_hdc() {
  local source_path="$1"
  local candidate=""

  if [[ -z "${source_path}" ]]; then
    return 1
  fi

  if [[ -f "${source_path}" ]]; then
    case "$(basename "${source_path}")" in
      hdc|hdc_std)
        link_hdc_binary "${source_path}" && return 0
        ;;
    esac
    return 1
  fi

  if [[ -d "${source_path}" ]]; then
    candidate="$(find "${source_path}" -type f \( -name "hdc" -o -name "hdc_std" \) | head -n 1 || true)"
    if [[ -n "${candidate}" ]]; then
      link_hdc_binary "${candidate}" && return 0
    fi
  fi
  return 1
}

WORK_ROOT="${WORK_ROOT:-/workspace}"
TDD_ROOT="${TDD_ROOT:-${WORK_ROOT}/TDD}"
TEST_CASES_DIR="${TEST_CASES_DIR:-${WORK_ROOT}/tests}"
TEST_IMAGE_DIR="${TEST_IMAGE_DIR:-${WORK_ROOT}/images}"
REPORTS_DIR="${REPORTS_DIR:-${TDD_ROOT}/testfwk_developer_test/reports}"
DOWNLOAD_ROOT="${DOWNLOAD_ROOT:-${WORK_ROOT}/downloads}"
PRODUCT_FORM="${PRODUCT_FORM:-rk3568}"
TASK_TYPE="${TASK_TYPE:-UT}"
RK3568_IMAGE_URL="${RK3568_IMAGE_URL:-}"
TDD_CASES_URL="${TDD_CASES_URL:-}"
TEST_PART="${TEST_PART:-}"
TEST_MODULE="${TEST_MODULE:-}"
TEST_SUITE_NAME="${TEST_SUITE_NAME:-}"
TEST_CASE="${TEST_CASE:-}"
TEST_COVERAGE="${TEST_COVERAGE:-}"
TEST_RANDOM="${TEST_RANDOM:-}"
TEST_PARTDEPS="${TEST_PARTDEPS:-}"
TEST_REPEAT="${TEST_REPEAT:-}"
TEST_HISTORYLIST="${TEST_HISTORYLIST:-}"
TEST_RUNHISTORY="${TEST_RUNHISTORY:-}"
TEST_RETRY="${TEST_RETRY:-0}"
HDC_URL="${HDC_URL:-}"
HDC_BINARY_PATH="${HDC_BINARY_PATH:-}"
DEV_REPO_URL="${DEV_REPO_URL:-https://gitcode.com/openharmony/testfwk_developer_test.git}"
XDEVICE_REPO_URL="${XDEVICE_REPO_URL:-https://gitcode.com/openharmony/testfwk_xdevice.git}"
DEV_REPO_BRANCH="${DEV_REPO_BRANCH:-}"
XDEVICE_REPO_BRANCH="${XDEVICE_REPO_BRANCH:-}"
DEV_REPO_COMMIT="${DEV_REPO_COMMIT:-359ee0ff6224bd609858a2ab02b6c492e777ac0c}"
XDEVICE_REPO_COMMIT="${XDEVICE_REPO_COMMIT:-05b7d77ec52f8b6b17e2741f989c32fcf12184e2}"
PREPARED_REPOS_ONLY="${PREPARED_REPOS_ONLY:-1}"

mkdir -p "${WORK_ROOT}" "${TDD_ROOT}" "${TEST_CASES_DIR}" "${TEST_IMAGE_DIR}" "${DOWNLOAD_ROOT}"

if [[ -n "${RK3568_IMAGE_URL}" ]]; then
  rk3568_payload_path="$(download_payload "${RK3568_IMAGE_URL}" "${DOWNLOAD_ROOT}/rk3568" "rk3568 image package")"
  if [[ -d "${rk3568_payload_path}" ]]; then
    copy_dir_content "${rk3568_payload_path}" "${TEST_IMAGE_DIR}"
    log "RK3568 images prepared at ${TEST_IMAGE_DIR}"
  elif [[ -f "${rk3568_payload_path}" ]]; then
    cp -f "${rk3568_payload_path}" "${TEST_IMAGE_DIR}/"
    log "RK3568 image file copied to ${TEST_IMAGE_DIR}"
  fi
fi

if [[ -n "${TDD_CASES_URL}" ]]; then
  payload_path="$(download_payload "${TDD_CASES_URL}" "${DOWNLOAD_ROOT}/tdd_cases" "tdd cases package")"
  if [[ -d "${payload_path}" ]]; then
    if [[ -n "${TEST_SUITE_NAME}" ]]; then
      suite_source="$(find "${payload_path}" -type d -name "${TEST_SUITE_NAME}" | head -n 1 || true)"
      if [[ -n "${suite_source}" ]]; then
        copy_dir_content "${suite_source}" "${TEST_CASES_DIR}/${TEST_SUITE_NAME}"
        log "Suite '${TEST_SUITE_NAME}' prepared at ${TEST_CASES_DIR}/${TEST_SUITE_NAME}"
      else
        log "Suite '${TEST_SUITE_NAME}' not found in payload, copied all extracted cases."
        copy_dir_content "${payload_path}" "${TEST_CASES_DIR}"
      fi
    else
      copy_dir_content "${payload_path}" "${TEST_CASES_DIR}"
      log "Copied all extracted cases to ${TEST_CASES_DIR}"
    fi
  elif [[ -f "${payload_path}" ]]; then
    cp -f "${payload_path}" "${TEST_CASES_DIR}/"
    log "Downloaded case file copied to ${TEST_CASES_DIR}"
  fi
fi

if ! command -v hdc >/dev/null 2>&1; then
  if [[ -n "${HDC_BINARY_PATH}" ]]; then
    find_and_link_hdc "${HDC_BINARY_PATH}" || true
  fi
fi

if ! command -v hdc >/dev/null 2>&1; then
  if [[ -n "${rk3568_payload_path:-}" ]]; then
    find_and_link_hdc "${rk3568_payload_path}" || true
  fi
fi

if ! command -v hdc >/dev/null 2>&1; then
  if [[ -n "${HDC_URL}" ]]; then
    hdc_payload_path="$(download_payload "${HDC_URL}" "${DOWNLOAD_ROOT}/hdc" "hdc package")"
    find_and_link_hdc "${hdc_payload_path}" || true
  fi
fi

prepare_framework_repos "${TDD_ROOT}" "${PREPARED_REPOS_ONLY}"
mkdir -p "${REPORTS_DIR}"

CONFIG_PATH="${TDD_ROOT}/testfwk_developer_test/config/user_config.xml"
if [[ -f "${CONFIG_PATH}" ]]; then
  config_cmd=(
    python3
    /opt/tdd-tools/configure_user_config.py
    --config "${CONFIG_PATH}"
    --tests-dir "${TEST_CASES_DIR}"
    --port "${DEVICE_PORT:-8710}"
  )

  if [[ -n "${DEVICE_IP:-}" ]]; then
    config_cmd+=(--ip "${DEVICE_IP}")
  fi

  if [[ -n "${DEVICE_SN:-}" ]]; then
    config_cmd+=(--sn "${DEVICE_SN}")
  fi

  "${config_cmd[@]}"
fi

if ! command -v hdc >/dev/null 2>&1; then
  log "Warning: hdc not found in PATH. Set HDC_URL or HDC_BINARY_PATH, or provide RK3568_IMAGE_URL with hdc binary."
fi

cd "${TDD_ROOT}/testfwk_developer_test"

validate_test_selection_args() {
  if [[ -n "${TEST_MODULE}" && -z "${TEST_PART}" ]]; then
    die "-tm requires -tp in auto mode."
  fi
  if [[ -n "${TEST_CASE}" && -z "${TEST_SUITE_NAME}" ]]; then
    die "-tc requires -ts in auto mode."
  fi
  if [[ -n "${TEST_REPEAT}" ]] && ! is_positive_integer "${TEST_REPEAT}"; then
    die "--repeat must be a positive integer."
  fi
  if [[ -n "${TEST_HISTORYLIST}" ]] && ! is_positive_integer "${TEST_HISTORYLIST}"; then
    die "-hl must be a positive integer."
  fi
  if [[ -n "${TEST_RUNHISTORY}" ]] && ! is_positive_integer "${TEST_RUNHISTORY}"; then
    die "-rh must be a positive integer."
  fi
}

latest_report_path() {
  local reports_dir="$1"
  [[ -d "${reports_dir}" ]] || return 0
  find "${reports_dir}" -mindepth 1 -maxdepth 1 \( -type d -o -type f -o -type l \) \
    ! -name latest \
    ! -name '*.zip' \
    -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-
}

archive_report_path() {
  local source_path="$1"
  [[ -n "${source_path}" ]] || return 0

  python3 - "${source_path}" <<'PY'
import pathlib
import shutil
import sys
import zipfile

source = pathlib.Path(sys.argv[1])
if not source.exists():
    sys.exit(0)

if source.suffix == ".zip":
    print(source)
    sys.exit(0)

zip_path = source.with_suffix(".zip")
if zip_path.exists():
    zip_path.unlink()

if source.is_dir():
    archive_path = shutil.make_archive(
        str(zip_path.with_suffix("")),
        "zip",
        root_dir=str(source.parent),
        base_dir=source.name,
    )
else:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(source, arcname=source.name)
    archive_path = str(zip_path)

print(archive_path)
PY
}

print_result_paths() {
  local latest_path=""
  local archived_path=""
  print_highlight "1;36" "[tdd] ===== Execution Results ====="
  print_highlight "1;33" "[tdd] Reports: ${REPORTS_DIR}"
  latest_path="$(latest_report_path "${REPORTS_DIR}")"
  if [[ -n "${latest_path}" ]]; then
    archived_path="$(archive_report_path "${latest_path}")"
    if [[ -n "${archived_path}" ]]; then
      print_highlight "1;32" "[tdd] Latest result: ${archived_path}"
    else
      print_highlight "1;32" "[tdd] Latest result: ${latest_path}"
    fi
  fi
}

run_and_report() {
  local rc=0
  if "$@"; then
    rc=0
  else
    rc=$?
  fi
  print_result_paths
  return "${rc}"
}

run_default() {
  local args=(run -p "${PRODUCT_FORM}" -t "${TASK_TYPE}")
  validate_test_selection_args
  if [[ -n "${TEST_PART:-}" ]]; then
    args+=(-tp "${TEST_PART}")
  fi
  if [[ -n "${TEST_MODULE:-}" ]]; then
    args+=(-tm "${TEST_MODULE}")
  fi
  if [[ -n "${TEST_SUITE_NAME:-}" ]]; then
    args+=(-ts "${TEST_SUITE_NAME}")
  fi
  if [[ -n "${TEST_CASE:-}" ]]; then
    args+=(-tc "${TEST_CASE}")
  fi
  if [[ -n "${TEST_COVERAGE:-}" ]]; then
    args+=(-cov "${TEST_COVERAGE}")
  fi
  if [[ -n "${TEST_RANDOM:-}" ]]; then
    args+=(-ra "${TEST_RANDOM}")
  fi
  if [[ -n "${TEST_PARTDEPS:-}" ]]; then
    args+=(-pd "${TEST_PARTDEPS}")
  fi
  if [[ -n "${TEST_REPEAT:-}" ]]; then
    args+=(--repeat "${TEST_REPEAT}")
  fi
  if [[ -n "${TEST_HISTORYLIST:-}" ]]; then
    args+=(-hl "${TEST_HISTORYLIST}")
  fi
  if [[ -n "${TEST_RUNHISTORY:-}" ]]; then
    args+=(-rh "${TEST_RUNHISTORY}")
  fi
  if is_truthy "${TEST_RETRY:-0}"; then
    args+=(--retry)
  fi
  run_and_report ./start.sh "${args[@]}"
}

if [[ "$#" -eq 0 ]]; then
  run_default
fi

case "$1" in
  run)
    shift
    if [[ "$#" -gt 0 ]]; then
      run_and_report ./start.sh run -p "${PRODUCT_FORM}" "$@"
      exit $?
    fi
    run_default
    ;;
  shell)
    exec /bin/bash
    ;;
  *)
    exec "$@"
    ;;
esac
