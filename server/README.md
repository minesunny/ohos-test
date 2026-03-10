# RK3568 Server

`server` 是独立的 Next.js 应用，负责：

- GitCode PR 与流水线管理
- RK3568 任务队列与设备分配
- 通过 WebSocket 与 `client` 通信
- 实时日志聚合与任务状态展示

## 运行

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

访问：`http://localhost:3000`

## 构建

```bash
pnpm lint
pnpm build
```

## Docker

```bash
docker pull "${OHOS_TEST_SERVER_IMAGE:-ohos-test-server:latest}"

docker run --rm -p 3000:3000 \
  --env-file .env.local \
  -e AUTH_COOKIE_SECURE=false \
  -v "$(pwd)/../data:/app/data" \
  "${OHOS_TEST_SERVER_IMAGE:-ohos-test-server:latest}"
```
