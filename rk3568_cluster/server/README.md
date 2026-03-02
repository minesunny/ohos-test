# RK3568 Server

`server` 负责 GitCode 管理、任务编排、设备分配与日志聚合。

当前 server 应用代码位于仓库根目录（Next.js App），`server` 目录用于承载服务端角色说明与后续拆分迁移。

## server 职责

- 维护 RK3568 任务队列
- 管理 client 注册设备（可用/占用状态）
- 为任务分配可用设备并下发执行指令
- 接收 client 回传的实时日志和任务状态

## 运行

在仓库根目录运行：

```bash
pnpm install
pnpm dev
```

或在 `server/` 目录运行：

```bash
./start.sh
```
