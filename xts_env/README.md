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
- `scripts/run_ci_case.sh`：传入 CI/runlist 参数，自动解析制品、复用 `tdd-env`、刷机并执行用例
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
- `PREPARED_REPOS_ONLY`：手动环境模式默认 `1`，只使用镜像内置或宿主机已有仓库
- `AUTO_PREPARED_REPOS_ONLY`：自动模式默认 `1`，不在容器内 clone，优先使用镜像构建时已打包的 TDD 框架仓库
- `DEVICE_IP` / `DEVICE_PORT` / `DEVICE_SN`：设备连接参数
- `TEST_CASES_DIR`：容器内测试用例目录（默认 `/workspace/tests`）
- `TEST_IMAGE_DIR`：容器内测试镜像目录（默认 `/workspace/images`）
- `REPORTS_DIR`：容器内报告目录（默认 `/workspace/TDD/testfwk_developer_test/reports`）
- `DEV_REPO_COMMIT`：`testfwk_developer_test` 固定 commit（默认 `359ee0ff6224bd609858a2ab02b6c492e777ac0c`）
- `XDEVICE_REPO_COMMIT`：`xdevice` 固定 commit（默认 `05b7d77ec52f8b6b17e2741f989c32fcf12184e2`）
- `COMPOSE_PROJECT_NAME`：可选；当你在多份 checkout 中直接执行 `docker compose` / `docker-compose` 时，建议为每份工程设置唯一值，避免因为目录都叫 `xts_env` 而串到同一组容器

宿主机挂载目录（compose 文件中可改）：

- `TEST_CASES_HOST_DIR`：默认 `./tests`
- `IMAGE_HOST_DIR`：默认 `./images`
- `REPORTS_HOST_DIR`：默认 `./reports`
- `DOWNLOAD_HOST_DIR`：默认 `./downloads`
- `USB_BUS_HOST_DIR`：默认 `/dev/bus/usb`
- `USB_BUS_CONTAINER_DIR`：默认 `/dev/bus/usb`
- `UDEV_RUN_HOST_DIR`：默认 `/run/udev`
- `UDEV_RUN_CONTAINER_DIR`：默认 `/run/udev`

`run_ci_case.sh` 额外会在 `DOWNLOAD_HOST_DIR` 下使用这些缓存目录：

- `ci-cache/archives/`：按制品 URL hash 缓存下载后的压缩包
- `ci-cache/extracted/`：按制品 URL hash 缓存解压结果
- `ci-runs/<run_id>/manifest.env`：记录单次执行使用的 URL、缓存路径和挂载目录

如需代理访问仓库/下载源，设置 `http_proxy`、`https_proxy`。

## 在镜像外准备依赖（推荐）

```bash
./scripts/prepare_offline_deps.sh
```

说明：该命令读取 `wheels/offline_deps.json`，在宿主机执行 `pip download`，将依赖下载到 `wheels/`，并自动生成 `requirements-offline.txt`。Docker 构建阶段只使用本地离线包，不再联网安装。

`offline_deps.json` 字段说明：

- `files`：要下载的主包（例如 `xdevice==6.0.7.210`）
- `dependencies`：显式固定的依赖版本（例如 `paramiko==4.0.0`）

## 在宿主机准备 TDD 仓库（可选）

```bash
./scripts/prepare_tdd_workspace.sh
```

该脚本会在 `TDD/` 下准备：

- `testfwk_developer_test`
- `xdevice`（并自动兼容 `testfwk_xdevice` 目录名）

并默认 checkout 到固定 commit（可在 `.env` 里修改 `DEV_REPO_COMMIT`、`XDEVICE_REPO_COMMIT`）。

如果镜像已按当前 `Dockerfile` 构建完成，`tdd-env` / `tdd-auto` 会优先使用镜像里内置的仓库副本，并在宿主机挂载目录缺失时自动落地到 `TDD/`。

## 拉取镜像

```bash
docker compose -f docker-compose.env.yml pull tdd-env
docker compose -f docker-compose.auto.yml pull tdd-auto
```

默认镜像名：

- `ohos-tdd-env:latest`
- `ohos-tdd-auto:latest`

如需切换仓库地址或 tag，可在 `.env` 中覆盖 `OHOS_TDD_ENV_IMAGE`、`OHOS_TDD_AUTO_IMAGE`。

## 挂载目录说明

- 报告目录：`./reports` <-> `${REPORTS_DIR}`
- 测试镜像目录：`./images` <-> `${TEST_IMAGE_DIR}`
- 测试用例目录：`./tests` <-> `${TEST_CASES_DIR}`
- USB 总线目录：`${USB_BUS_HOST_DIR}` <-> `${USB_BUS_CONTAINER_DIR}`
- udev 运行目录：`${UDEV_RUN_HOST_DIR}` <-> `${UDEV_RUN_CONTAINER_DIR}`（只读）

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

也可以直接通过 CI 地址拉取镜像/用例并执行：

```bash
./scripts/run_ci_case.sh 'https://dcp.openharmony.cn/workbench/cicd/detail/<event_id>/runlist' \
  --device-sn <sn> \
  --suite <suite_name>
```

该脚本会：

1. 自动解析 dayu200 镜像包和 dayu200_tdd 用例包 URL
2. 优先复用环境变量或 `.env` 中的 `COMPOSE_PROJECT_NAME`；未设置时按当前 compose 目录绝对路径自动生成唯一 compose project name，并复用/创建对应的 `tdd-env` 容器，不再依赖固定全局容器名
3. 下载并显示进度/速度，命中缓存时直接复用
4. 解压制品并显示解压进度，命中解压缓存时直接复用
5. 把镜像、测试用例复制到容器挂载目录
6. 刷新 `user_config.xml`
7. 执行 `./start.sh run -p <product> -t <task_type>`，也支持 `--command` 覆盖

如果宿主机挂载的 `TDD/testfwk_developer_test` 仍停留在旧提交，`run_ci_case.sh` 会自动回退到镜像内置的 `testfwk_developer_test` / `xdevice` 执行，避免旧版 `start.sh` 干扰当前跑例。

## 方式二：自动执行测试套

```bash
docker compose -f docker-compose.auto.yml run --rm tdd-auto
```

自动模式会：

1. 按 `RK3568_IMAGE_URL` 下载镜像包到 `${DOWNLOAD_ROOT}/rk3568`，并同步到 `${TEST_IMAGE_DIR}`（可挂载到宿主机）
2. 按 `TDD_CASES_URL` 下载用例包到 `${DOWNLOAD_ROOT}/tdd_cases`，并准备到 `${TEST_CASES_DIR}`（可挂载到宿主机）
3. 将镜像内置的 `testfwk_developer_test` 与 `xdevice` 落地到 `${TDD_ROOT}`（若宿主机目录已存在则直接复用）
4. 根据 `TEST_SUITE_NAME` 过滤/准备测试用例目录
5. 执行：`./start.sh run -p ${PRODUCT_FORM}`（若配置 `TEST_SUITE_NAME` 则自动追加 `-ts`）

也可指定模块：

```bash
docker compose -f docker-compose.auto.yml run --rm -e TEST_MODULE=<模块名> tdd-auto
```

## 注意事项

- 运行侧 compose 采用拉镜像模式，不再在本地通过 compose 构建镜像。
- `tdd-env` / `tdd-auto` compose 不再固定 `container_name`。但如果你有多份工程且它们的 compose 目录都叫 `xts_env`，直接执行 `docker compose up` 时仍建议在各自 `.env` 中设置唯一 `COMPOSE_PROJECT_NAME`，否则 compose 默认项目名可能冲突。
- 如需自行产出镜像，可单独使用 `docker build` 基于 `Dockerfile` 构建并推送到你自己的仓库，再通过 `.env` 覆盖镜像名。
- 仓库默认不再内置 wheel/tar 包；构建前请先执行 `./scripts/prepare_offline_deps.sh` 下载离线包。
- 镜像已内置 `hdc`（`/usr/local/bin/hdc`）和依赖库，刷机工具位于 `/opt/tools/flash/`，`flash.sh` 位于 `/opt/tools/flash/flash.sh`。
- 主机侧也可直接使用 `tools/flash/flash.sh`；若未自动识别，手动设置 `UPGRADE_TOOL=<upgrade_tool路径>`。
- 自动模式会按顺序尝试获取 `hdc`：`HDC_BINARY_PATH` -> `RK3568_IMAGE_URL` 下载包内查找 -> `HDC_URL` 下载并查找。
- `tdd-env` 默认 `PREPARED_REPOS_ONLY=1`，容器内不会 clone 仓库；缺失仓库时会优先从镜像内置副本落地。
- `tdd-auto` 默认 `AUTO_PREPARED_REPOS_ONLY=1`，容器启动时不会联网 clone；缺失仓库时会从镜像内置副本落地到 `TDD/`。
- 自动执行型服务更适合使用 `docker compose run --rm tdd-auto`；旧版 `docker-compose up` 在容器快速退出时可能额外打印 Python traceback，这不是主故障点。
- 为避免上游仓库变动导致不稳定，默认固定到指定 commit；只有你主动修改 `.env` 的 commit 变量才会切换版本。
- `xdevice-aosp` 在当前可访问源不可用，镜像默认未安装。

容器内刷机示例：

```bash
docker compose -f docker-compose.env.yml exec tdd-env bash
/opt/tools/flash/flash.sh /path/to/rk3568/images
```

说明：

- 设备进入 `loader` 后，`hdc list targets` 通常不会再显示它；这时应以 `upgrade_tool ld` 的输出为准。
- 如果宿主机能看到 `loader`，容器里看不到，优先检查 `/dev/bus/usb` 和 `/run/udev` 两个挂载是否生效。
- 如果当前容器是旧版本遗留的固定名字实例（例如 `ohos-tdd-env`），更新 compose 配置后建议执行一次 `docker compose down` 再 `up -d`，或手动删除旧容器后重建。
