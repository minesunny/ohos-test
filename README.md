# rk3568_cluster

项目已直接展开在仓库根目录，不再额外套一层 `rk3568_cluster`：

- `server/`：Next.js 服务端与 UI（PR 管理、任务编排、设备调度、实时日志）
- `client/`：RK3568 设备代理（设备上报、任务执行、日志回传）
- `data/`：运行时数据目录（SQLite、任务记录、缓存产物）

仓库根目录同时保留 `docker-compose.yml`、说明文档和运行时目录。

## 启动 server

```bash
cd server
pnpm install
cp .env.example .env.local
pnpm dev
```

## 启动 client

```bash
cd client
pnpm install
cp .env.example .env
pnpm start
```

## Docker Compose（server）

在仓库根目录执行：

```bash
mkdir -p data
docker compose pull
docker compose up -d
```

服务默认映射到宿主机 `80` 端口。

如需指定镜像，可在执行前设置 `OHOS_TEST_SERVER_IMAGE`。
