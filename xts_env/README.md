# OpenHarmony TDD Docker 使用说明

本仓库提供两套镜像/服务：

1. `tdd-env`：仅提供 TDD 运行环境，手动进入容器执行测试。
2. `tdd-auto`：容器启动后自动准备并执行测试套（支持配置下载地址和测试套名字）。

## 目录

- `Dockerfile`：多 target 构建（`tdd-env` / `tdd-auto`）
- `docker-compose.env.yml`：`tdd-env` 服务编排
- `docker-compose.auto.yml`：`tdd-auto` 服务编排
- `scripts/entrypoint.sh`：自动模式入口
- `scripts/download_and_unpack.py`：下载并解压（zip/tar 等）
- `scripts/configure_user_config.py`：更新 `user_config.xml`
- `scripts/prepare_offline_deps.sh`：宿主机预下载 Python 离线依赖
- `scripts/prepare_tdd_workspace.sh`：宿主机预拉取 TDD 框架仓库
- `tools/hdc/`：从本地 SDK 复制的 `hdc` 与依赖库
- `tools/flash/`：`flash.sh`、`upgrade_tool_v2.17_for_linux/upgrade_tool`
- `wheels/offline_deps.json`：离线依赖配置（记录待下载文件与依赖）
- `wheels/`：离线 Python 依赖下载目录（由脚本生成）

## 配置

复制并编辑环境变量：

```bash
cp .env.example .env
```

关键配置项：

- `RK3568_IMAGE_URL`：rk3568 镜像下载地址（自动模式可选）
- `TDD_CASES_URL`：TDD 用例包下载地址（自动模式可选）
- `TEST_SUITE_NAME`：测试套名字（例如 `unittest`）
- `HDC_URL`：hdc 二进制或压缩包下载地址（可选）
- `HDC_BINARY_PATH`：容器内已有 hdc/hdc_std 路径（可选）
- `PRODUCT_FORM`：产品形态，默认 `rk3568`
- `PREPARED_REPOS_ONLY`：默认 `1`，容器内不 clone，要求宿主机提前准备仓库
- `DEVICE_IP` / `DEVICE_PORT` / `DEVICE_SN`：设备连接参数
- `TEST_CASES_DIR`：容器内测试用例目录（默认 `/workspace/tests`）
- `TEST_IMAGE_DIR`：容器内测试镜像目录（默认 `/workspace/images`）
- `REPORTS_DIR`：容器内报告目录（默认 `/workspace/TDD/testfwk_developer_test/reports`）
- `DEV_REPO_COMMIT`：`testfwk_developer_test` 固定 commit（默认 `359ee0ff6224bd609858a2ab02b6c492e777ac0c`）
- `XDEVICE_REPO_COMMIT`：`xdevice` 固定 commit（默认 `05b7d77ec52f8b6b17e2741f989c32fcf12184e2`）

宿主机挂载目录（compose 文件中可改）：

- `TEST_CASES_HOST_DIR`：默认 `./tests`
- `IMAGE_HOST_DIR`：默认 `./images`
- `REPORTS_HOST_DIR`：默认 `./reports`
- `DOWNLOAD_HOST_DIR`：默认 `./downloads`

如需代理访问仓库/下载源，设置 `http_proxy`、`https_proxy`。

## 在镜像外准备依赖（推荐）

```bash
./scripts/prepare_offline_deps.sh
```

说明：该命令读取 `wheels/offline_deps.json`，在宿主机执行 `pip download`，将依赖下载到 `wheels/`，并自动生成 `requirements-offline.txt`。Docker 构建阶段只使用本地离线包，不再联网安装。

`offline_deps.json` 字段说明：

- `files`：要下载的主包（例如 `xdevice==6.0.7.210`）
- `dependencies`：显式固定的依赖版本（例如 `paramiko==4.0.0`）

## 在宿主机准备 TDD 仓库（Slim 路线必需）

```bash
./scripts/prepare_tdd_workspace.sh
```

该脚本会在 `TDD/` 下准备：

- `testfwk_developer_test`
- `xdevice`（并自动兼容 `testfwk_xdevice` 目录名）

并默认 checkout 到固定 commit（可在 `.env` 里修改 `DEV_REPO_COMMIT`、`XDEVICE_REPO_COMMIT`）。

## 构建

```bash
docker compose -f docker-compose.env.yml build tdd-env
docker compose -f docker-compose.auto.yml build tdd-auto
```

## 挂载目录说明

- 报告目录：`./reports` <-> `${REPORTS_DIR}`
- 测试镜像目录：`./images` <-> `${TEST_IMAGE_DIR}`
- 测试用例目录：`./tests` <-> `${TEST_CASES_DIR}`

这样无论手动模式还是自动模式，报告、镜像、用例都可以直接在宿主机访问。

## 方式一：仅环境镜像（手动执行）

```bash
docker compose -f docker-compose.env.yml up -d tdd-env
docker compose -f docker-compose.env.yml exec tdd-env bash
```

`tdd-env` 启动时会做基础初始化（校验宿主机已准备仓库、更新 `user_config.xml`、按配置尝试准备 `hdc`），但不会自动执行测试。

进入容器后示例：

```bash
cd /workspace/TDD/testfwk_developer_test
./start.sh run -p rk3568
```

退出并停止：

```bash
docker compose -f docker-compose.env.yml down
```

## 方式二：自动执行测试套

```bash
docker compose -f docker-compose.auto.yml run --rm tdd-auto
```

自动模式会：

1. 按 `RK3568_IMAGE_URL` 下载镜像包到 `${DOWNLOAD_ROOT}/rk3568`，并同步到 `${TEST_IMAGE_DIR}`（可挂载到宿主机）
2. 按 `TDD_CASES_URL` 下载用例包到 `${DOWNLOAD_ROOT}/tdd_cases`，并准备到 `${TEST_CASES_DIR}`（可挂载到宿主机）
3. 根据 `TEST_SUITE_NAME` 过滤/准备测试用例目录
4. 执行：`./start.sh run -p ${PRODUCT_FORM}`（若配置 `TEST_SUITE_NAME` 则自动追加 `-ts`）

也可指定模块：

```bash
docker compose -f docker-compose.auto.yml run --rm -e TEST_MODULE=<模块名> tdd-auto
```

## 注意事项

- 镜像采用 `python:3.10-slim` + 多阶段构建，离线安装依赖，并且只复制必要工具文件以减少体积。
- 仓库默认不再内置 wheel/tar 包；构建前请先执行 `./scripts/prepare_offline_deps.sh` 下载离线包。
- 镜像已内置 `hdc`（`/usr/local/bin/hdc`）和依赖库，刷机工具位于 `/opt/tools/flash/`，`flash.sh` 位于 `/opt/tools/flash/flash.sh`。
- 主机侧也可直接使用 `tools/flash/flash.sh`；若未自动识别，手动设置 `UPGRADE_TOOL=<upgrade_tool路径>`。
- 自动模式会按顺序尝试获取 `hdc`：`HDC_BINARY_PATH` -> `RK3568_IMAGE_URL` 下载包内查找 -> `HDC_URL` 下载并查找。
- 默认 `PREPARED_REPOS_ONLY=1`，容器内不会 clone 仓库；请先执行 `./scripts/prepare_tdd_workspace.sh`。
- 为避免上游仓库变动导致不稳定，默认固定到指定 commit；只有你主动修改 `.env` 的 commit 变量才会切换版本。
- `xdevice-aosp` 在当前可访问源不可用，镜像默认未安装。

容器内刷机示例：

```bash
docker compose -f docker-compose.env.yml exec tdd-env bash
/opt/tools/flash/flash.sh /path/to/rk3568/images
```
