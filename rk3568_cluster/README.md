# GitCode PR 管理界面 (Next.js + React + TypeScript + Shadcn UI)

一个面向 GitCode 仓库的 PR 管理台：

- 查看每个 PR 状态（open/closed/all）
- 一键在 PR 评论区发送 `start build` 触发流水线
- 记录每次触发流水线的信息（触发时间、触发人、触发评论）
- 同步并记录流水线结果（自动解析评论关键词 + 手动标记兜底）
- 成功流水线可直接发起 RK3568 测试（TDD，可选指定用例）
- 统一使用 shadcn/ui 组件风格实现页面交互
- 支持基于 SQLite 的注册/登录会话认证
- 支持账户级 GitCode 设置（Token、多仓库列表）
- 搜索支持 owner 与仓库名分开输入

## 技术栈

- Next.js (App Router)
- React + TypeScript
- Tailwind CSS
- shadcn/ui
- SQLite（`data/auth.sqlite`）

## 运行方式

1. 安装依赖

```bash
pnpm install
```

确保系统已安装 `curl`（服务端通过 `curl` 调用 GitCode API）。

2. 配置环境变量

```bash
cp .env.example .env.local
```

并填写：

- `GITCODE_TARGETS`: 多仓库配置，支持逗号或换行分隔，格式 `owner/repo`
  - 示例：`OpenHarmony/arkcompiler_ets_runtime,OpenHarmony/arkui_ace_engine`
- `GITCODE_OWNER`: 单仓库兼容配置（当未配置 `GITCODE_TARGETS` 时使用）
- `GITCODE_REPO`: 单仓库兼容配置（当未配置 `GITCODE_TARGETS` 时使用）
- `GITCODE_TOKEN`: GitCode 访问令牌（GitCode OpenAPI 网关要求，查询和触发都需要）
- `GITCODE_API_BASE`: 可选，默认 `https://api.gitcode.com/api/v5`
- `RK3568_BASE_DIR`: 可选，默认 `/home/maien/TDD`
- `RK3568_FLASH_SCRIPT`: 可选，默认 `~/ark-standalone-build/flash.sh`
- `REALTIME_WS_PORT`: 可选，默认 `3765`（页面数据和 RK3568 日志 websocket 推送端口）
- `REALTIME_WS_HOST`: 可选，默认 `0.0.0.0`
- `REALTIME_WS_PUBLIC_HOST`: 可选，默认自动取当前页面 host
- `NEXT_PUBLIC_REALTIME_WS_URL`: 可选，前端直连 websocket 地址（配置后优先使用）
- `DCP_AUTHORIZATION` / `DCP_COOKIE` / `DCP_TOKEN`: 可选，DCP 页面需要鉴权时用于抓取产物地址与下载

页面支持通过搜索栏分别输入 `owner` 与仓库名，查询并切换到对应仓库的 PR 与构建历史。

3. 启动开发环境

```bash
pnpm dev
```

浏览器打开 `http://localhost:3000`。
首次访问会跳转到 `/auth`，先注册账号后即可登录。
登录后可在页面右上角打开“账户设置”，配置 GitCode Token 与仓库列表（`owner/repo`，支持多条）。

## Docker 镜像

构建镜像：

```bash
docker build -t rk3568_cluster:latest .
```

运行容器（将本地 `data/` 挂载到容器，持久化 sqlite 与运行记录）：

```bash
# Ensure mounted data dir is writable by container user(uid=1001)
mkdir -p data && chmod 777 data

docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -e AUTH_COOKIE_SECURE=false \
  -v "$(pwd)/data:/app/data" \
  rk3568_cluster:latest
```

如果使用明文 HTTP（例如局域网 IP + 端口映射）访问，建议设置 `AUTH_COOKIE_SECURE=false`。

使用 Docker Compose（宿主机端口固定 `80`）：

```bash
mkdir -p data
PUID="$(id -u)" PGID="$(id -g)" docker compose up -d --build
```

停止并删除容器：

```bash
docker compose down
```

如果需要走代理（示例为本机 `http://172.16.1.1:7890`）：

```bash
mkdir -p /tmp/.docker
cat > /tmp/.docker/config.json <<'EOF'
{
  "proxies": {
    "default": {
      "httpProxy": "http://172.16.1.1:7890",
      "httpsProxy": "http://172.16.1.1:7890",
      "noProxy": "localhost,127.0.0.1,127.0.1.1"
    }
  }
}
EOF

DOCKER_CONFIG=/tmp/.docker docker build -t rk3568_cluster:latest .
```

## 流水线结果同步策略

触发时会在 PR 评论区写入 `start build`，并在本地 `data/pipeline-runs.json` 记录一条 run。

同步时会读取该 PR 后续评论，通过关键词识别状态：

- 成功：`success` / `passed` / `构建成功` / `通过`
- 失败：`failed` / `error` / `构建失败` / `失败`
- 进行中：`running` / `building` / `start build` / `进行中`
- 支持解析门禁评论中的任务清单（如 `【dayu200_xts_static编译, ...】`）与 `runlist` 链接，并展示在构建历史中
- 同时会按时间提取 `runlist` URL：同一 URL 连续出现两次视为一轮任务（触发评论 + 结果评论）
- 若某个 URL 只出现一次且后续已有新 URL，判定该轮为“失败（强制终止）”；若它是最新且仅出现一次，判定为“进行中”
- 评论分页会自动跨页补齐 URL 对，避免页边界导致误判

如果自动识别不准确，可在页面中手动“标记成功/标记失败”。

## RK3568 测试流程

在成功流水线记录点击 `RK3568测试` 按钮后，可在面板里配置：

- 测试类型：当前仅支持 `TDD`
- 测试用例名：可选；不填则执行 TDD 全量（`run -t UT`）

后端会按顺序执行：

- 优先从流水线 event API 提取并下载 `Artifacts-dayu200-...tar.gz` 与 `Artifacts-dayu200_tdd-...tar.gz`（失败时回退 runlist 页面解析）
- 产物下载带缓存：优先复用 `RK3568_ARTIFACT_CACHE_DIR`（默认 `/home/maien/TDD/.rk3568-artifact-cache`）中的缓存文件；缓存缺失时自动重新下载并写入缓存
- 若缓存缺失但历史任务已有相同产物 URL 的归档文件，会优先复用历史任务归档并回填缓存
- 下载到 `/home/maien/TDD/dayu200/<任务子目录>` 并解压
- 覆盖 `/home/maien/TDD/tests`
- 执行烧录命令 `~/ark-standalone-build/flash.sh <镜像目录>`
- 在 `/home/maien/TDD/testfwk_developer_test` 下自动驱动 `./start.sh`，执行 `run -t UT`（可选 `-ts <用例>`）
- `start.sh` 输出和任务日志会通过 websocket 实时推送到页面日志面板

## 主要 API

- `GET /api/prs?state=open|closed|all&owner=<owner>&repo=<repo>&target=owner/repo` 获取目标仓库 PR 列表（含最近 run，`owner/repo` 与 `target` 二选一）
- `POST /api/prs/:number/trigger` 触发目标仓库 PR 流水线（请求体可带 `target`）
- `GET /api/runs?prNumber=123` 获取触发记录
- `POST /api/runs/sync` 批量同步待处理 run（请求体可带 `target`）
- `POST /api/runs/:id/sync` 同步单条 run
- `POST /api/runs/:id/result` 手动更新 run 结果
- `GET /api/rk3568-tests?target=owner/repo&prNumber=123` 查询 RK3568 测试任务
- `POST /api/rk3568-tests` 创建 RK3568 测试任务
- `POST /api/rk3568-tests/:id/rerun` 基于已有任务参数重新创建并执行任务（配合下载缓存可快速重跑）
- `GET /api/realtime/ws` 初始化 websocket 地址（前端据此建立实时连接）

## 注意事项

- `GITCODE_TOKEN` 不会展示在前端，只在服务端 API 路由使用。
- `data/pipeline-runs.json` 是本地文件存储，适合单实例部署；若多实例部署建议替换为数据库。
