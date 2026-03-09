import { WebSocket, WebSocketServer } from "ws";

import { type Rk3568TestTask } from "@/types/rk3568";

type ClientSubscription = {
  prsTarget?: string;
  rkTaskId?: string;
  rkPrNumber?: number;
  rkTarget?: string;
  rkPipelineUrl?: string;
};

type RealtimeRuntime = {
  wss: WebSocketServer;
  subscriptions: Map<WebSocket, ClientSubscription>;
  host: string;
  port: number;
  startedAt: string;
};

type RealtimeClientMessage =
  | { type: "subscribe-prs"; target?: string }
  | { type: "subscribe-rk-task"; taskId?: string }
  | { type: "subscribe-rk-pr"; target?: string; prNumber?: number; pipelineUrl?: string }
  | { type: "ping" };

export type RealtimeServerEvent =
  | {
    type: "hello";
    at: string;
    message: string;
  }
  | {
    type: "prs-updated";
    at: string;
    target: string;
    reason?: string;
  }
  | {
    type: "rk-task-updated";
    at: string;
    target: string;
    task: Rk3568TestTask;
  }
  | {
    type: "rk-task-log";
    at: string;
    taskId: string;
    line: string;
    isError?: boolean;
  };

type GlobalRuntime = typeof globalThis & {
  __rk3568RealtimeRuntime?: RealtimeRuntime;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTarget(input: string | undefined): string | undefined {
  const value = input?.trim();
  return value || undefined;
}

function parsePositiveInt(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isInteger(input) && input > 0) {
    return input;
  }
  if (typeof input !== "string") {
    return undefined;
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function parseClientMessage(raw: string): RealtimeClientMessage | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      target?: string;
      taskId?: string;
      prNumber?: number | string;
      pipelineUrl?: string;
    };
    if (parsed.type === "subscribe-prs") {
      return {
        type: "subscribe-prs",
        target: normalizeTarget(parsed.target),
      };
    }
    if (parsed.type === "subscribe-rk-task") {
      return {
        type: "subscribe-rk-task",
        taskId: parsed.taskId?.trim() || undefined,
      };
    }
    if (parsed.type === "subscribe-rk-pr") {
      return {
        type: "subscribe-rk-pr",
        target: normalizeTarget(parsed.target),
        prNumber: parsePositiveInt(parsed.prNumber),
        pipelineUrl: normalizeTarget(parsed.pipelineUrl),
      };
    }
    if (parsed.type === "ping") {
      return { type: "ping" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getConfiguredPort(): number {
  const raw = process.env.REALTIME_WS_PORT?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return 3765;
}

function getConfiguredHost(): string {
  return process.env.REALTIME_WS_HOST?.trim() || "0.0.0.0";
}

function sendJson(socket: WebSocket, payload: RealtimeServerEvent | { type: "pong"; at: string }): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function shouldDeliver(subscription: ClientSubscription, event: RealtimeServerEvent): boolean {
  if (event.type === "hello") {
    return true;
  }

  if (event.type === "prs-updated") {
    const target = normalizeTarget(subscription.prsTarget);
    if (!target) {
      return true;
    }
    return target === event.target;
  }

  if (event.type === "rk-task-log") {
    const taskId = subscription.rkTaskId?.trim();
    if (!taskId) {
      return false;
    }
    return taskId === event.taskId;
  }

  if (event.type === "rk-task-updated") {
    const taskId = subscription.rkTaskId?.trim();
    if (taskId && taskId === event.task.id) {
      return true;
    }

    const prNumber = subscription.rkPrNumber;
    if (!prNumber || prNumber !== event.task.prNumber) {
      return false;
    }

    const target = normalizeTarget(subscription.rkTarget);
    if (!target) {
      const pipelineUrl = subscription.rkPipelineUrl?.trim();
      if (!pipelineUrl) {
        return true;
      }
      return event.task.pipelineUrl === pipelineUrl;
    }
    if (target !== event.target) {
      return false;
    }

    const pipelineUrl = subscription.rkPipelineUrl?.trim();
    if (pipelineUrl && event.task.pipelineUrl !== pipelineUrl) {
      return false;
    }
    return true;
  }

  return false;
}

function getRuntime(): RealtimeRuntime | undefined {
  return (globalThis as GlobalRuntime).__rk3568RealtimeRuntime;
}

export function ensureRealtimeWsServer(): RealtimeRuntime {
  const globalRuntime = globalThis as GlobalRuntime;
  if (globalRuntime.__rk3568RealtimeRuntime) {
    return globalRuntime.__rk3568RealtimeRuntime;
  }

  const host = getConfiguredHost();
  const port = getConfiguredPort();
  const subscriptions = new Map<WebSocket, ClientSubscription>();
  const wss = new WebSocketServer({
    host,
    port,
  });

  const runtime: RealtimeRuntime = {
    wss,
    subscriptions,
    host,
    port,
    startedAt: nowIso(),
  };
  globalRuntime.__rk3568RealtimeRuntime = runtime;

  wss.on("connection", (socket) => {
    subscriptions.set(socket, {});
    sendJson(socket, {
      type: "hello",
      at: nowIso(),
      message: "realtime connected",
    });

    socket.on("message", (raw) => {
      const parsed = parseClientMessage(raw.toString("utf-8"));
      if (!parsed) {
        return;
      }

      const subscription = subscriptions.get(socket) || {};
      if (parsed.type === "ping") {
        sendJson(socket, { type: "pong", at: nowIso() });
        return;
      }
      if (parsed.type === "subscribe-prs") {
        subscription.prsTarget = parsed.target;
      } else if (parsed.type === "subscribe-rk-task") {
        subscription.rkTaskId = parsed.taskId;
      } else if (parsed.type === "subscribe-rk-pr") {
        subscription.rkPrNumber = parsed.prNumber;
        subscription.rkTarget = parsed.target;
        subscription.rkPipelineUrl = parsed.pipelineUrl;
      }
      subscriptions.set(socket, subscription);
    });

    socket.on("close", () => {
      subscriptions.delete(socket);
    });

    socket.on("error", () => {
      subscriptions.delete(socket);
    });
  });

  wss.on("error", (error) => {
    console.error("[realtime-ws] server error:", error.message);
  });

  return runtime;
}

export function getRealtimeWsPublicUrl(requestUrl: string): string {
  const explicit = process.env.NEXT_PUBLIC_REALTIME_WS_URL?.trim()
    || process.env.REALTIME_WS_PUBLIC_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const runtime = ensureRealtimeWsServer();
  const request = new URL(requestUrl);
  const protocol = request.protocol === "https:" ? "wss" : "ws";
  const hostname = process.env.REALTIME_WS_PUBLIC_HOST?.trim() || request.hostname;

  const isDefaultPort = (protocol === "ws" && runtime.port === 80)
    || (protocol === "wss" && runtime.port === 443);
  const portPart = isDefaultPort ? "" : `:${runtime.port}`;
  return `${protocol}://${hostname}${portPart}`;
}

export function publishRealtimeEvent(event: RealtimeServerEvent): void {
  const runtime = getRuntime() || ensureRealtimeWsServer();
  for (const [socket, subscription] of runtime.subscriptions.entries()) {
    if (socket.readyState !== WebSocket.OPEN) {
      continue;
    }
    if (!shouldDeliver(subscription, event)) {
      continue;
    }
    sendJson(socket, event);
  }
}

export function notifyPrsUpdated(target: string, reason?: string): void {
  publishRealtimeEvent({
    type: "prs-updated",
    at: nowIso(),
    target,
    reason,
  });
}

export function notifyRkTaskUpdated(task: Rk3568TestTask): void {
  publishRealtimeEvent({
    type: "rk-task-updated",
    at: nowIso(),
    target: `${task.repositoryOwner}/${task.repositoryName}`,
    task,
  });
}

export function notifyRkTaskLog(taskId: string, line: string, isError = false): void {
  publishRealtimeEvent({
    type: "rk-task-log",
    at: nowIso(),
    taskId,
    line,
    isError,
  });
}
