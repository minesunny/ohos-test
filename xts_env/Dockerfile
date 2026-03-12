FROM python:3.10-slim AS pydeps

WORKDIR /tmp

COPY wheels /opt/wheels

RUN python -m venv /opt/venv && \
    python - <<'PY'
import json
from pathlib import Path

config_path = Path("/opt/wheels/offline_deps.json")
requirements_path = Path("/tmp/requirements-offline.txt")

if not config_path.is_file():
    raise SystemExit(f"offline deps config not found: {config_path}")

with config_path.open("r", encoding="utf-8") as config_file:
    config = json.load(config_file)

if not isinstance(config, dict):
    raise SystemExit("offline deps config must be a JSON object")

requirements = []
seen = set()
for key in ("files", "dependencies"):
    values = config.get(key, [])
    if not isinstance(values, list):
        raise SystemExit(f"offline deps config key '{key}' must be a list")
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise SystemExit(
                f"offline deps config key '{key}' contains invalid entry: {value!r}"
            )
        spec = value.strip()
        if spec in seen:
            continue
        seen.add(spec)
        requirements.append(spec)

if not requirements:
    raise SystemExit("offline deps config contains no package specs")

requirements_path.write_text("\n".join(requirements) + "\n", encoding="utf-8")
PY
RUN test -n "$(find /opt/wheels -maxdepth 1 -type f \( -name '*.whl' -o -name '*.tar.gz' \) -print -quit)" || \
    (echo "offline packages not found under /opt/wheels; run ./scripts/prepare_offline_deps.sh first" >&2 && exit 1)
RUN \
    /opt/venv/bin/pip install --no-cache-dir --no-index --find-links=/opt/wheels \
    -r /tmp/requirements-offline.txt && \
    find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + && \
    rm -rf /root/.cache/pip /opt/wheels /tmp/requirements-offline.txt

FROM python:3.10 AS compat-libs

FROM python:3.10-slim AS frameworks

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG DEV_REPO_URL=https://gitcode.com/openharmony/testfwk_developer_test.git
ARG XDEVICE_REPO_URL=https://gitcode.com/openharmony/testfwk_xdevice.git
ARG DEV_REPO_BRANCH=""
ARG XDEVICE_REPO_BRANCH=""
ARG DEV_REPO_COMMIT=359ee0ff6224bd609858a2ab02b6c492e777ac0c
ARG XDEVICE_REPO_COMMIT=05b7d77ec52f8b6b17e2741f989c32fcf12184e2

ENV HTTP_PROXY="${HTTP_PROXY}"
ENV HTTPS_PROXY="${HTTPS_PROXY}"
ENV NO_PROXY="${NO_PROXY}"
ENV http_proxy="${http_proxy}"
ENV https_proxy="${https_proxy}"
ENV no_proxy="${no_proxy}"

RUN set -eux; \
    PROXY="${http_proxy:-${HTTP_PROXY:-}}"; \
    HTTPS_PROXY_VALUE="${https_proxy:-${HTTPS_PROXY:-}}"; \
    if [ -n "${PROXY}" ] || [ -n "${HTTPS_PROXY_VALUE}" ]; then \
      { \
        [ -n "${PROXY}" ] && printf 'Acquire::http::Proxy "%s";\n' "${PROXY}"; \
        [ -n "${HTTPS_PROXY_VALUE}" ] && printf 'Acquire::https::Proxy "%s";\n' "${HTTPS_PROXY_VALUE}"; \
      } > /etc/apt/apt.conf.d/99proxy; \
    fi; \
    apt-get -o Acquire::Retries=5 update && \
    apt-get -o Acquire::Retries=5 install -y --fix-missing --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/tdd-prepared

RUN set -eux; \
    clone_repo() { \
      repo_url="$1"; \
      target_dir="$2"; \
      branch="$3"; \
      if [ -n "$branch" ]; then \
        git clone --depth 1 --branch "$branch" "$repo_url" "$target_dir"; \
      else \
        git clone --depth 1 "$repo_url" "$target_dir"; \
      fi; \
    }; \
    ensure_commit() { \
      repo_dir="$1"; \
      commit="$2"; \
      branch="$3"; \
      if [ -z "$commit" ]; then \
        return 0; \
      fi; \
      if ! git -C "$repo_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then \
        if [ -n "$branch" ]; then \
          git -C "$repo_dir" fetch --depth 200 origin "$branch"; \
        else \
          git -C "$repo_dir" fetch --depth 200 origin '+refs/heads/*:refs/remotes/origin/*'; \
        fi; \
      fi; \
      if ! git -C "$repo_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then \
        git -C "$repo_dir" fetch --unshallow origin || \
          git -C "$repo_dir" fetch --depth 2000 origin '+refs/heads/*:refs/remotes/origin/*'; \
      fi; \
      current_commit="$(git -C "$repo_dir" rev-parse HEAD)"; \
      if [ "$current_commit" != "$commit" ]; then \
        git -C "$repo_dir" checkout --detach "$commit"; \
      fi; \
    }; \
    clone_repo "$DEV_REPO_URL" testfwk_developer_test "${DEV_REPO_BRANCH:-}"; \
    clone_repo "$XDEVICE_REPO_URL" xdevice "${XDEVICE_REPO_BRANCH:-}"; \
    ensure_commit testfwk_developer_test "$DEV_REPO_COMMIT" "${DEV_REPO_BRANCH:-}"; \
    ensure_commit xdevice "$XDEVICE_REPO_COMMIT" "${XDEVICE_REPO_BRANCH:-}"; \
    ln -s xdevice testfwk_xdevice

FROM python:3.10-slim AS base

COPY --from=pydeps /opt/venv /opt/venv
COPY --from=compat-libs /usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0 /usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0
COPY --from=frameworks /opt/tdd-prepared /opt/tdd-prepared
COPY tools/ps/ps /bin/ps
COPY tools/hdc/hdc /opt/tools/hdc/hdc
COPY tools/hdc/libusb_shared.so /opt/tools/hdc/libusb_shared.so
COPY tools/flash/flash.sh /opt/tools/flash/flash.sh
COPY tools/flash/upgrade_tool_v2.17.zip /opt/tools/flash/upgrade_tool_v2.17.zip
COPY scripts/entrypoint.sh /usr/local/bin/tdd-entrypoint
COPY scripts/configure_user_config.py /opt/tdd-tools/configure_user_config.py
COPY scripts/download_and_unpack.py /opt/tdd-tools/download_and_unpack.py
COPY scripts/run_framework.py /opt/tdd-tools/run_framework.py

RUN python - <<'PY'
from pathlib import Path
import zipfile

zip_path = Path("/opt/tools/flash/upgrade_tool_v2.17.zip")
target_dir = Path("/opt/tools/flash/upgrade_tool_v2.17")
target_dir.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(zip_path, "r") as zf:
    zf.extractall(target_dir)
zip_path.unlink(missing_ok=True)
PY

RUN chmod +x \
    /bin/ps \
    /opt/tools/hdc/hdc \
    /opt/tools/flash/flash.sh \
    /opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool \
    /opt/tdd-tools/run_framework.py \
    /usr/local/bin/tdd-entrypoint && \
    ln -sf /usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0 /usr/lib/x86_64-linux-gnu/libatomic.so.1 && \
    ln -sf /opt/tools/hdc/hdc /usr/local/bin/hdc && \
    ln -sf /usr/local/bin/python3 /usr/local/bin/python

ENV PATH=/opt/venv/bin:$PATH
ENV LD_LIBRARY_PATH=/opt/tools/hdc
ENV PREPARED_TDD_ROOT=/opt/tdd-prepared
WORKDIR /workspace

FROM base AS tdd-env

CMD ["/bin/bash"]

FROM base AS tdd-auto

ENTRYPOINT ["/usr/local/bin/tdd-entrypoint"]
CMD ["run"]
