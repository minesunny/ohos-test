import { randomUUID } from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

import {
  type Rk3568ClientDevice,
  type Rk3568ClientToServerMessage,
  type Rk3568ServerClientState,
  type Rk3568ServerDeviceState,
  type Rk3568ServerToClientMessage,
  type Rk3568StartTaskMessage,
} from "@/types/rk3568-client";

type HubClientState = {
  clientId: string;
  name: string;
  connectedAt: string;
  lastSeenAt: string;
  socket: WebSocket;
  devices: Map<string, Rk3568ServerDeviceState>;
};

type HubRuntime = {
  host: string;
  port: number;
  wss: WebSocketServer;
  clients: Map<string, HubClientState>;
  socketToClientId: Map<WebSocket, string>;
};

type HubGlobal = typeof globalThis & {
  __rk3568ClientHub?: HubRuntime;
};

type DeviceAssignment = {
  clientId: string;
  clientName: string;
  deviceSerial: string;
};

type HubHandlers = {
  onTopologyChange?: () => void;
  onTaskLog?: (event: { clientId: string; taskId: string; line: string; isError: boolean }) => void;
  onTaskStatus?: (event: {
    clientId: string;
    taskId: string;
    status: "running" | "success" | "failed";
    message?: string;
    resultArchiveName?: string;
    resultArchivePath?: string;
    resultReportEntries?: string[];
  }) => void;
  onClientDisconnected?: (event: { clientId: string; occupiedTaskIds: string[] }) => void;
};

let handlers: HubHandlers = {};

function nowIso(): string {
  return new Date().toISOString();
}

function getHost(): string {
  return process.env.RK3568_CLIENT_WS_HOST?.trim() || "0.0.0.0";
}

function getPort(): number {
  const raw = process.env.RK3568_CLIENT_WS_PORT?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return 3770;
}

function normalizeClientId(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    return `rk-client-${randomUUID().slice(0, 8)}`;
  }
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 64) || `rk-client-${randomUUID().slice(0, 8)}`;
}

function normalizeClientName(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }
  return value.slice(0, 64);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDeviceStatus(raw: unknown): "online" | "offline" | "unknown" {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "online") {
    return "online";
  }
  if (normalized === "offline") {
    return "offline";
  }
  return "unknown";
}

function parseClientMessage(raw: string): Rk3568ClientToServerMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isObject(parsed) || typeof parsed.type !== "string") {
    return undefined;
  }

  if (parsed.type === "client-hello") {
    return {
      type: "client-hello",
      clientId: typeof parsed.clientId === "string" ? parsed.clientId : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  }

  if (parsed.type === "device-report") {
    const devicesRaw = Array.isArray(parsed.devices) ? parsed.devices : [];
    const devices: Rk3568ClientDevice[] = [];
    for (const item of devicesRaw) {
      if (!isObject(item)) {
        continue;
      }
      const serial = typeof item.serial === "string" ? item.serial.trim() : "";
      if (!serial) {
        continue;
      }
      devices.push({
        serial,
        status: parseDeviceStatus(item.status),
      });
    }
    return {
      type: "device-report",
      devices,
    };
  }

  if (parsed.type === "task-log") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
    const line = typeof parsed.line === "string" ? parsed.line : "";
    if (!taskId || !line) {
      return undefined;
    }
    return {
      type: "task-log",
      taskId,
      line,
      isError: Boolean(parsed.isError),
    };
  }

  if (parsed.type === "task-status") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
    const status = typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : "";
    if (!taskId || (status !== "running" && status !== "success" && status !== "failed")) {
      return undefined;
    }
    return {
      type: "task-status",
      taskId,
      status,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      resultArchiveName: typeof parsed.resultArchiveName === "string" ? parsed.resultArchiveName : undefined,
      resultArchivePath: typeof parsed.resultArchivePath === "string" ? parsed.resultArchivePath : undefined,
      resultReportEntries: Array.isArray(parsed.resultReportEntries)
        ? parsed.resultReportEntries.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  }

  if (parsed.type === "ping") {
    return { type: "ping" };
  }
  if (parsed.type === "pong") {
    return { type: "pong" };
  }
  return undefined;
}

function sendJson(socket: WebSocket, message: Rk3568ServerToClientMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function getRuntime(): HubRuntime | undefined {
  return (globalThis as HubGlobal).__rk3568ClientHub;
}

function withRuntime(): HubRuntime {
  return getRuntime() || ensureRk3568ClientHub();
}

function clearTaskOccupancy(client: HubClientState, taskId: string): void {
  for (const device of client.devices.values()) {
    if (device.occupiedByTaskId === taskId) {
      delete device.occupiedByTaskId;
      device.updatedAt = nowIso();
    }
  }
}

function updateClientDevices(client: HubClientState, devices: Rk3568ClientDevice[]): void {
  const seen = new Set<string>();
  const timestamp = nowIso();

  for (const input of devices) {
    const serial = input.serial.trim();
    if (!serial) {
      continue;
    }
    seen.add(serial);
    const current = client.devices.get(serial);
    client.devices.set(serial, {
      serial,
      status: input.status,
      clientId: client.clientId,
      clientName: client.name,
      occupiedByTaskId: current?.occupiedByTaskId,
      updatedAt: timestamp,
    });
  }

  for (const [serial, device] of client.devices.entries()) {
    if (seen.has(serial)) {
      continue;
    }
    if (device.occupiedByTaskId) {
      device.status = "offline";
      device.updatedAt = timestamp;
      continue;
    }
    client.devices.delete(serial);
  }
}

function closeAndRemoveClient(runtime: HubRuntime, clientId: string, reason: string): void {
  const client = runtime.clients.get(clientId);
  if (!client) {
    return;
  }

  const occupiedTaskIds = Array.from(new Set(
    Array.from(client.devices.values())
      .map((item) => item.occupiedByTaskId)
      .filter((item): item is string => Boolean(item)),
  ));

  runtime.clients.delete(clientId);
  runtime.socketToClientId.delete(client.socket);
  try {
    client.socket.close(1000, reason);
  } catch {
    // ignore close errors
  }

  if (occupiedTaskIds.length > 0) {
    handlers.onClientDisconnected?.({
      clientId,
      occupiedTaskIds,
    });
  }
  handlers.onTopologyChange?.();
}

function handleClientHello(runtime: HubRuntime, socket: WebSocket, payload: {
  clientId?: string;
  name?: string;
}): void {
  const clientId = normalizeClientId(payload.clientId);
  const name = normalizeClientName(payload.name, clientId);
  const existing = runtime.clients.get(clientId);
  if (existing && existing.socket !== socket) {
    closeAndRemoveClient(runtime, clientId, "replaced-by-new-session");
  }

  const previousId = runtime.socketToClientId.get(socket);
  if (previousId && previousId !== clientId) {
    closeAndRemoveClient(runtime, previousId, "client-id-updated");
  }

  const now = nowIso();
  const current: HubClientState = {
    clientId,
    name,
    connectedAt: existing?.connectedAt || now,
    lastSeenAt: now,
    socket,
    devices: existing?.devices || new Map<string, Rk3568ServerDeviceState>(),
  };

  runtime.clients.set(clientId, current);
  runtime.socketToClientId.set(socket, clientId);
  sendJson(socket, {
    type: "server-hello",
    at: now,
    clientId,
    message: "rk3568 server connected",
  });
  handlers.onTopologyChange?.();
}

function handleMessage(runtime: HubRuntime, socket: WebSocket, message: Rk3568ClientToServerMessage): void {
  if (message.type === "client-hello") {
    handleClientHello(runtime, socket, message);
    return;
  }

  const clientId = runtime.socketToClientId.get(socket);
  if (!clientId) {
    return;
  }

  const client = runtime.clients.get(clientId);
  if (!client) {
    return;
  }
  client.lastSeenAt = nowIso();

  if (message.type === "ping") {
    sendJson(socket, { type: "pong", at: nowIso() });
    return;
  }
  if (message.type === "pong") {
    return;
  }
  if (message.type === "device-report") {
    updateClientDevices(client, message.devices);
    handlers.onTopologyChange?.();
    return;
  }
  if (message.type === "task-log") {
    handlers.onTaskLog?.({
      clientId: client.clientId,
      taskId: message.taskId,
      line: message.line,
      isError: Boolean(message.isError),
    });
    return;
  }
  if (message.type === "task-status") {
    if (message.status === "success" || message.status === "failed") {
      clearTaskOccupancy(client, message.taskId);
      handlers.onTopologyChange?.();
    }
    handlers.onTaskStatus?.({
      clientId: client.clientId,
      taskId: message.taskId,
      status: message.status,
      message: message.message,
      resultArchiveName: message.resultArchiveName,
      resultArchivePath: message.resultArchivePath,
      resultReportEntries: message.resultReportEntries,
    });
  }
}

export function ensureRk3568ClientHub(): HubRuntime {
  const globalRuntime = globalThis as HubGlobal;
  if (globalRuntime.__rk3568ClientHub) {
    return globalRuntime.__rk3568ClientHub;
  }

  const runtime: HubRuntime = {
    host: getHost(),
    port: getPort(),
    wss: new WebSocketServer({
      host: getHost(),
      port: getPort(),
    }),
    clients: new Map<string, HubClientState>(),
    socketToClientId: new Map<WebSocket, string>(),
  };

  runtime.wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const parsed = parseClientMessage(raw.toString("utf-8"));
      if (!parsed) {
        return;
      }
      handleMessage(runtime, socket, parsed);
    });

    socket.on("close", () => {
      const clientId = runtime.socketToClientId.get(socket);
      if (!clientId) {
        return;
      }
      closeAndRemoveClient(runtime, clientId, "socket-closed");
    });

    socket.on("error", () => {
      const clientId = runtime.socketToClientId.get(socket);
      if (!clientId) {
        return;
      }
      closeAndRemoveClient(runtime, clientId, "socket-error");
    });
  });

  runtime.wss.on("error", (error) => {
    console.error("[rk3568-client-hub] websocket server error:", error.message);
  });

  globalRuntime.__rk3568ClientHub = runtime;
  return runtime;
}

export function configureRk3568ClientHubHandlers(nextHandlers: HubHandlers): void {
  handlers = {
    ...handlers,
    ...nextHandlers,
  };
}

export function getRk3568ClientHubPublicUrl(requestUrl: string): string {
  const explicit = process.env.RK3568_CLIENT_WS_PUBLIC_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const runtime = withRuntime();
  const request = new URL(requestUrl);
  const protocol = request.protocol === "https:" ? "wss" : "ws";
  const host = process.env.RK3568_CLIENT_WS_PUBLIC_HOST?.trim() || request.hostname;
  const isDefaultPort = (protocol === "ws" && runtime.port === 80) || (protocol === "wss" && runtime.port === 443);
  return `${protocol}://${host}${isDefaultPort ? "" : `:${runtime.port}`}`;
}

export function listRk3568Clients(): Rk3568ServerClientState[] {
  const runtime = withRuntime();
  return Array.from(runtime.clients.values())
    .map((client) => {
      const deviceList = Array.from(client.devices.values());
      return {
        clientId: client.clientId,
        name: client.name,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        deviceCount: deviceList.length,
        onlineDeviceCount: deviceList.filter((device) => device.status === "online").length,
      };
    })
    .sort((a, b) => (a.connectedAt > b.connectedAt ? -1 : 1));
}

export function listRk3568Devices(): Rk3568ServerDeviceState[] {
  const runtime = withRuntime();
  const devices: Rk3568ServerDeviceState[] = [];
  for (const client of runtime.clients.values()) {
    for (const device of client.devices.values()) {
      devices.push({ ...device });
    }
  }
  return devices.sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "online") {
        return -1;
      }
      if (b.status === "online") {
        return 1;
      }
    }
    return a.serial.localeCompare(b.serial);
  });
}

export function reserveRk3568DeviceForTask(taskId: string, preferredSerial?: string): DeviceAssignment | undefined {
  const runtime = withRuntime();
  const preferred = preferredSerial?.trim();

  const allDevices = Array.from(runtime.clients.values())
    .flatMap((client) => Array.from(client.devices.values()).map((device) => ({ client, device })))
    .filter(({ device }) => device.status === "online" && !device.occupiedByTaskId);

  const picked = preferred
    ? allDevices.find(({ device }) => device.serial === preferred)
    : allDevices[0];

  if (!picked) {
    return undefined;
  }

  picked.device.occupiedByTaskId = taskId;
  picked.device.updatedAt = nowIso();
  handlers.onTopologyChange?.();

  return {
    clientId: picked.client.clientId,
    clientName: picked.client.name,
    deviceSerial: picked.device.serial,
  };
}

export function releaseRk3568DeviceByTaskId(taskId: string): void {
  const runtime = withRuntime();
  let changed = false;
  for (const client of runtime.clients.values()) {
    for (const device of client.devices.values()) {
      if (device.occupiedByTaskId !== taskId) {
        continue;
      }
      delete device.occupiedByTaskId;
      device.updatedAt = nowIso();
      changed = true;
    }
  }
  if (changed) {
    handlers.onTopologyChange?.();
  }
}

export function dispatchRk3568TaskToClient(clientId: string, payload: Omit<Rk3568StartTaskMessage, "type">): boolean {
  const runtime = withRuntime();
  const client = runtime.clients.get(clientId);
  if (!client) {
    return false;
  }
  return sendJson(client.socket, {
    type: "start-task",
    ...payload,
  });
}
