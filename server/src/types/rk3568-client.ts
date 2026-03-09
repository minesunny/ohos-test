export type Rk3568DeviceStatus = "online" | "offline" | "unknown";

export type Rk3568ClientDevice = {
  serial: string;
  status: Rk3568DeviceStatus;
};

export type Rk3568ServerDeviceState = {
  serial: string;
  status: Rk3568DeviceStatus;
  clientId: string;
  clientName: string;
  occupiedByTaskId?: string;
  updatedAt: string;
};

export type Rk3568ServerClientState = {
  clientId: string;
  name: string;
  connectedAt: string;
  lastSeenAt: string;
  deviceCount: number;
  onlineDeviceCount: number;
};

export type Rk3568ClientHelloMessage = {
  type: "client-hello";
  clientId?: string;
  name?: string;
  version?: string;
};

export type Rk3568ClientDeviceReportMessage = {
  type: "device-report";
  devices: Rk3568ClientDevice[];
};

export type Rk3568ClientTaskLogMessage = {
  type: "task-log";
  taskId: string;
  line: string;
  isError?: boolean;
};

export type Rk3568ClientTaskStatusMessage = {
  type: "task-status";
  taskId: string;
  status: "running" | "success" | "failed";
  message?: string;
  resultArchiveName?: string;
  resultArchivePath?: string;
  resultReportEntries?: string[];
};

export type Rk3568ClientToServerMessage =
  | Rk3568ClientHelloMessage
  | Rk3568ClientDeviceReportMessage
  | Rk3568ClientTaskLogMessage
  | Rk3568ClientTaskStatusMessage
  | { type: "ping" }
  | { type: "pong" };

export type Rk3568StartTaskMessage = {
  type: "start-task";
  taskId: string;
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  pipelineUrl: string;
  testCaseName?: string;
  deviceSerial: string;
};

export type Rk3568ServerToClientMessage =
  | Rk3568StartTaskMessage
  | { type: "server-hello"; at: string; clientId: string; message: string }
  | { type: "ping"; at: string }
  | { type: "pong"; at: string };
