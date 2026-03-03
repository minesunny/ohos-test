# rk3568_cluster

`rk3568_cluster` 采用双目录结构：

- `server/`：Next.js 服务端与 UI（PR 管理、任务编排、设备调度、实时日志）
- `client/`：RK3568 设备代理（设备上报、任务执行、日志回传）

根目录只保留编排文件，不放业务实现代码。

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

在 `rk3568_cluster` 根目录执行：

```bash
mkdir -p server/data
docker compose up -d --build
```

服务默认映射到宿主机 `80` 端口。
