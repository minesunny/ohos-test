#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

TDD_ROOT="${TDD_ROOT:-${ROOT_DIR}/TDD}"
DEV_REPO_URL="${DEV_REPO_URL:-https://gitcode.com/openharmony/testfwk_developer_test.git}"
XDEVICE_REPO_URL="${XDEVICE_REPO_URL:-https://gitcode.com/openharmony/testfwk_xdevice.git}"
DEV_REPO_BRANCH="${DEV_REPO_BRANCH:-}"
XDEVICE_REPO_BRANCH="${XDEVICE_REPO_BRANCH:-}"
DEV_REPO_COMMIT="${DEV_REPO_COMMIT:-359ee0ff6224bd609858a2ab02b6c492e777ac0c}"
XDEVICE_REPO_COMMIT="${XDEVICE_REPO_COMMIT:-05b7d77ec52f8b6b17e2741f989c32fcf12184e2}"

git_repo() {
  local repo_dir="$1"
  shift
  git -c safe.directory="${repo_dir}" -C "${repo_dir}" "$@"
}

clone_if_missing() {
  local repo_url="$1"
  local target_dir="$2"
  local branch="$3"

  if [[ -d "${target_dir}/.git" ]]; then
    echo "[prep] repository already exists: ${target_dir}"
    return
  fi

  if [[ -e "${target_dir}" && ! -d "${target_dir}" ]]; then
    echo "[prep] path exists but is not a directory: ${target_dir}" >&2
    exit 1
  fi

  if [[ -d "${target_dir}" && -n "$(ls -A "${target_dir}")" ]]; then
    echo "[prep] non-empty directory is not a git repo: ${target_dir}" >&2
    exit 1
  fi

  local clone_args=(--depth 1)
  if [[ -n "${branch}" ]]; then
    clone_args+=(--branch "${branch}")
  fi

  echo "[prep] cloning ${repo_url} -> ${target_dir}"
  git clone "${clone_args[@]}" "${repo_url}" "${target_dir}"
}

checkout_commit() {
  local repo_dir="$1"
  local commit="$2"
  local label="$3"

  if [[ -z "${commit}" ]]; then
    return
  fi
  if [[ ! -d "${repo_dir}/.git" ]]; then
    return
  fi

  if ! git_repo "${repo_dir}" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    echo "[prep] fetching ${label} commit ${commit}"
    git_repo "${repo_dir}" fetch --depth 1 origin "${commit}"
  fi

  local current_commit
  current_commit="$(git_repo "${repo_dir}" rev-parse HEAD)"
  if [[ "${current_commit}" != "${commit}" ]]; then
    echo "[prep] checkout ${label} to commit ${commit}"
    git_repo "${repo_dir}" checkout --detach "${commit}"
  fi
}

link_xdevice_layout() {
  if [[ -d "${TDD_ROOT}/xdevice" && ! -e "${TDD_ROOT}/testfwk_xdevice" ]]; then
    ln -s xdevice "${TDD_ROOT}/testfwk_xdevice"
  fi
  if [[ -d "${TDD_ROOT}/testfwk_xdevice" && ! -e "${TDD_ROOT}/xdevice" ]]; then
    ln -s testfwk_xdevice "${TDD_ROOT}/xdevice"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  echo "[prep] git is required on host to prepare workspace" >&2
  exit 1
fi

mkdir -p "${TDD_ROOT}"
clone_if_missing "${DEV_REPO_URL}" "${TDD_ROOT}/testfwk_developer_test" "${DEV_REPO_BRANCH}"
checkout_commit "${TDD_ROOT}/testfwk_developer_test" "${DEV_REPO_COMMIT}" "testfwk_developer_test"

if [[ ! -d "${TDD_ROOT}/xdevice/.git" && ! -d "${TDD_ROOT}/testfwk_xdevice/.git" ]]; then
  clone_if_missing "${XDEVICE_REPO_URL}" "${TDD_ROOT}/xdevice" "${XDEVICE_REPO_BRANCH}"
fi

if [[ -d "${TDD_ROOT}/xdevice/.git" ]]; then
  checkout_commit "${TDD_ROOT}/xdevice" "${XDEVICE_REPO_COMMIT}" "xdevice"
elif [[ -d "${TDD_ROOT}/testfwk_xdevice/.git" ]]; then
  checkout_commit "${TDD_ROOT}/testfwk_xdevice" "${XDEVICE_REPO_COMMIT}" "xdevice"
fi

link_xdevice_layout
echo "[prep] workspace ready under ${TDD_ROOT}"
