# Repository Guidelines

## Project Structure & Module Organization
This repository provides Dockerized OpenHarmony TDD execution with two service modes.

- `Dockerfile`: multi-target image build (`tdd-env`, `tdd-auto`).
- `docker-compose.env.yml`: compose file for `tdd-env`.
- `docker-compose.auto.yml`: compose file for `tdd-auto`.
- `scripts/entrypoint.sh`: runtime bootstrap (validate prepared repos, configure XML, run tests).
- `scripts/configure_user_config.py`: updates `user_config.xml` for IP/port/SN/test paths.
- `scripts/download_and_unpack.py`: fetches and extracts suite/image archives.
- `scripts/prepare_tdd_workspace.sh`: clones required TDD framework repos on host.
- `tools/hdc/`: bundled `hdc` binary and required shared library.
- `tools/flash/`: bundled `flash.sh` and `upgrade_tool` package.
- `wheels/offline_deps.json`: source-of-truth config for offline package download.
- `wheels/`: generated offline Python wheels used during image build.
- `TDD/`, `tests/`, `images/`, `reports/`, `downloads/`: runtime-mounted workspace directories.

## Build, Test, and Development Commands
- `./scripts/prepare_offline_deps.sh`: render requirements from `wheels/offline_deps.json` and download packages into `wheels/`.
- `./scripts/prepare_tdd_workspace.sh`: prepare `TDD/testfwk_developer_test` and `TDD/xdevice` on host.
- `docker build -f Dockerfile --target tdd-env -t ohos-tdd-env:latest .`: build manual env image.
- `docker build -f Dockerfile --target tdd-auto -t ohos-tdd-auto:latest .`: build auto-run image.
- `docker compose -f docker-compose.env.yml up -d tdd-env`: start persistent environment container.
- `docker compose -f docker-compose.env.yml exec tdd-env bash`: enter container and run tests manually.
- `docker compose -f docker-compose.auto.yml run --rm tdd-auto`: auto-prepare and run suite (`run -p rk3568` default).
- `docker compose -f docker-compose.auto.yml run --rm tdd-auto run --help`: smoke-check non-interactive startup.
- `docker compose -f docker-compose.env.yml exec tdd-env hdc -v`: verify bundled `hdc`.

## Coding Style & Naming Conventions
- Shell: Bash with `set -euo pipefail`; use lowercase snake_case function names.
- Python: PEP 8, 4-space indentation, explicit argument parsing, small helpers.
- Keep environment variable names uppercase (`PRODUCT_FORM`, `TEST_SUITE_NAME`, `PREPARED_REPOS_ONLY`, `TEST_IMAGE_DIR`, `REPORTS_DIR`, `DEV_REPO_COMMIT`).
- Keep scripts idempotent so repeated container starts are safe.

## Testing Guidelines
- Use smoke tests for wrapper changes (no dedicated unit test suite in this repo).
- Minimum validation after changes:
- `docker compose -f docker-compose.env.yml build tdd-env`
- `docker compose -f docker-compose.auto.yml build tdd-auto`
- `docker compose -f docker-compose.auto.yml run --rm tdd-auto run --help`
- `docker compose -f docker-compose.env.yml exec tdd-env bash -lc 'hdc -v && test -x /opt/tools/flash/flash.sh'`

## Commit & Pull Request Guidelines
- Follow Conventional Commits, e.g. `fix(entrypoint): default to non-interactive rk3568 run`.
- Keep PRs focused; include changed files, executed commands, and key output.
- When behavior changes, update `.env.example` and `README.md` in the same PR.

## Security & Configuration Tips
- Do not commit device serials, private IPs, credentials, or proxy secrets.
- Store local overrides in `.env`; treat `.env.example` as the public template.
