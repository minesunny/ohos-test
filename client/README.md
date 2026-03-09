# RK3568 Client Agent

`client` 负责连接 `server`、上报设备状态、执行 RK3568 测试任务并实时回传日志。

## 功能

- 启动后通过 WebSocket 向 `server` 注册 client
- 周期执行 `hdc list targets -v` 上报设备状态
- 接收 `server` 下发的 `start-task`
- 客户端侧解析流水线产物链接、下载并使用本地缓存
- 每个任务通过 `xts_env/docker-compose.env.yml` 启动独立容器执行
- 任务日志与状态实时通过 WebSocket 回传 `server`

## 使用

```bash
cd client
cp .env.example .env
pnpm install
pnpm start
```

或：

```bash
npm install
npm start
```

## 关键环境变量

- `RK3568_SERVER_WS_URL`：server 的 ws 地址（默认 `ws://127.0.0.1:3770`）
- `RK3568_XTS_ENV_DIR`：`xts_env` 目录路径
- `RK3568_CLIENT_WORK_DIR`：任务数据与缓存目录
- `RK3568_CLIENT_ID` / `RK3568_CLIENT_NAME`：client 标识

## 依赖前置

- 可用的 `docker` / `docker compose`
- `hdc` 命令可执行
- `xts_env/TDD` 已准备好测试框架仓库
