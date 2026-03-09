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

FROM python:3.10-slim AS base

COPY --from=pydeps /opt/venv /opt/venv
COPY --from=compat-libs /usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0 /usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0
COPY tools/hdc/hdc /opt/tools/hdc/hdc
COPY tools/hdc/libusb_shared.so /opt/tools/hdc/libusb_shared.so
COPY tools/flash/flash.sh /opt/tools/flash/flash.sh
COPY tools/flash/upgrade_tool_v2.17.zip /opt/tools/flash/upgrade_tool_v2.17.zip
COPY scripts/entrypoint.sh /usr/local/bin/tdd-entrypoint
COPY scripts/configure_user_config.py /opt/tdd-tools/configure_user_config.py
COPY scripts/download_and_unpack.py /opt/tdd-tools/download_and_unpack.py

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
    /opt/tools/hdc/hdc \
    /opt/tools/flash/flash.sh \
    /opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool \
    /usr/local/bin/tdd-entrypoint && \
    ln -sf /usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0 /usr/lib/x86_64-linux-gnu/libatomic.so.1 && \
    ln -sf /opt/tools/hdc/hdc /usr/local/bin/hdc && \
    ln -sf /usr/local/bin/python3 /usr/local/bin/python

ENV PATH=/opt/venv/bin:$PATH
ENV LD_LIBRARY_PATH=/opt/tools/hdc
WORKDIR /workspace

FROM base AS tdd-env

CMD ["/bin/bash"]

FROM base AS tdd-auto

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/local/bin/tdd-entrypoint"]
CMD ["run"]
