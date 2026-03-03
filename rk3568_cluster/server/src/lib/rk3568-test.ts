import { promises as fs } from "node:fs";
import path from "node:path";

import {
  configureRk3568ClientHubHandlers,
  dispatchRk3568TaskToClient,
  ensureRk3568ClientHub,
  listRk3568Clients,
  listRk3568Devices,
  releaseRk3568DeviceByTaskId,
  reserveRk3568DeviceForTask,
} from "@/lib/rk3568-client-hub";
import { notifyRkTaskLog, notifyRkTaskUpdated } from "@/lib/realtime-ws";
import {
  type Rk3568ServerClientState,
  type Rk3568ServerDeviceState,
} from "@/types/rk3568-client";
import { type Rk3568TestStore, type Rk3568TestTask } from "@/types/rk3568";

const DATA_DIR = path.join(process.cwd(), "data");
const TASKS_FILE = path.join(DATA_DIR, "rk3568-tests.json");
const TASK_RUNTIME_DIR = path.join(DATA_DIR, "rk3568-tasks");

let writeQueue: Promise<void> = Promise.resolve();
const queuedTaskIds = new Set<string>();
let dispatching = false;
let hubBound = false;

type CreateTaskInput = {
  runId?: string;
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  pipelineUrl: string;
  testCaseName?: string;
  requestedDeviceSerial?: string;
};

type ListTaskOptions = {
  repositoryOwner?: string;
  repositoryName?: string;
  prNumber?: number;
  pipelineUrl?: string;
  limit?: number;
};

function createTaskId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TASK_RUNTIME_DIR, { recursive: true });
  try {
    await fs.access(TASKS_FILE);
  } catch {
    const initial: Rk3568TestStore = { tasks: [] };
    await fs.writeFile(TASKS_FILE, `${JSON.stringify(initial, null, 2)}\n`, "utf-8");
  }
}

async function readStoreUnsafe(): Promise<Rk3568TestStore> {
  await ensureStoreFile();
  const raw = await fs.readFile(TASKS_FILE, "utf-8");
  if (!raw.trim()) {
    return { tasks: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Rk3568TestStore;
    if (!Array.isArray(parsed.tasks)) {
      return { tasks: [] };
    }
    return parsed;
  } catch {
    return { tasks: [] };
  }
}

async function writeStoreUnsafe(store: Rk3568TestStore): Promise<void> {
  await ensureStoreFile();
  const tempFile = `${TASKS_FILE}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  await fs.rename(tempFile, TASKS_FILE);
}

async function withStoreWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const task = writeQueue.then(work, work);
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function sortTasksDesc(tasks: Rk3568TestTask[]): Rk3568TestTask[] {
  return tasks
    .slice()
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
}

function taskPrefix(taskId: string): string {
  return `[RK3568][${taskId.slice(0, 8)}]`;
}

async function appendTaskLog(logPath: string, taskId: string, line: string, isError = false): Promise<void> {
  const output = `${taskPrefix(taskId)} ${line}`;
  if (isError) {
    console.error(output);
  } else {
    console.log(output);
  }

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `[${nowIso()}] ${line}\n`, "utf-8");
  notifyRkTaskLog(taskId, line, isError);
}

async function appendTaskLogSafe(logPath: string, taskId: string, line: string, isError = false): Promise<void> {
  try {
    await appendTaskLog(logPath, taskId, line, isError);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`${taskPrefix(taskId)} failed to write task log: ${details}`);
  }
}

function bindHubHandlers(): void {
  if (hubBound) {
    return;
  }

  ensureRk3568ClientHub();
  configureRk3568ClientHubHandlers({
    onTopologyChange: () => {
      triggerDispatch();
    },
    onTaskLog: ({ taskId, line, isError }) => {
      void (async () => {
        const task = await getRk3568TaskById(taskId);
        if (!task) {
          return;
        }
        await appendTaskLogSafe(task.logPath, taskId, line, isError);
      })();
    },
    onTaskStatus: (event) => {
      void handleClientTaskStatusEvent(event);
    },
    onClientDisconnected: (event) => {
      void handleClientDisconnected(event.clientId, event.occupiedTaskIds);
    },
  });

  hubBound = true;
}

async function handleClientDisconnected(clientId: string, occupiedTaskIds: string[]): Promise<void> {
  for (const taskId of occupiedTaskIds) {
    const task = await updateRk3568Task(taskId, (current) => {
      if (current.status !== "running") {
        return current;
      }
      return {
        ...current,
        status: "failed",
        message: `执行客户端 ${clientId} 已断开连接，任务中断。`,
        finishedAt: nowIso(),
      };
    });
    if (task) {
      await appendTaskLogSafe(task.logPath, task.id, `Client disconnected: ${clientId}`, true);
    }
  }
  triggerDispatch();
}

async function handleClientTaskStatusEvent(event: {
  taskId: string;
  status: "running" | "success" | "failed";
  message?: string;
  resultArchiveName?: string;
  resultArchivePath?: string;
  resultReportEntries?: string[];
}): Promise<void> {
  const task = await getRk3568TaskById(event.taskId);
  if (!task) {
    return;
  }

  if (event.status === "running") {
    const updated = await updateRk3568Task(task.id, (current) => ({
      ...current,
      status: "running",
      startedAt: current.startedAt || nowIso(),
      message: event.message || current.message || "客户端正在执行测试任务。",
    }));
    if (updated && event.message?.trim()) {
      await appendTaskLogSafe(updated.logPath, updated.id, event.message);
    }
    return;
  }

  releaseRk3568DeviceByTaskId(task.id);

  const success = event.status === "success";
  const updated = await updateRk3568Task(task.id, (current) => ({
    ...current,
    status: success ? "success" : "failed",
    message: event.message || (success ? "RK3568 测试完成。" : "RK3568 测试失败。"),
    finishedAt: nowIso(),
    resultArchiveName: event.resultArchiveName || current.resultArchiveName,
    resultArchivePath: event.resultArchivePath || current.resultArchivePath,
    resultReportEntries: event.resultReportEntries || current.resultReportEntries,
    resultArchivedAt: event.resultArchivePath ? nowIso() : current.resultArchivedAt,
  }));

  if (updated) {
    await appendTaskLogSafe(
      updated.logPath,
      updated.id,
      success ? "Client reported task success." : `Client reported task failed: ${updated.message}`,
      !success,
    );
  }

  triggerDispatch();
}

async function tryDispatchQueuedTasks(): Promise<void> {
  bindHubHandlers();

  for (const taskId of Array.from(queuedTaskIds)) {
    const task = await getRk3568TaskById(taskId);
    if (!task || task.status !== "queued") {
      queuedTaskIds.delete(taskId);
      continue;
    }

    const assignment = reserveRk3568DeviceForTask(task.id, task.requestedDeviceSerial);
    if (!assignment) {
      continue;
    }

    const dispatched = dispatchRk3568TaskToClient(assignment.clientId, {
      taskId: task.id,
      repositoryOwner: task.repositoryOwner,
      repositoryName: task.repositoryName,
      prNumber: task.prNumber,
      pipelineUrl: task.pipelineUrl,
      testCaseName: task.testCaseName,
      deviceSerial: assignment.deviceSerial,
    });

    if (!dispatched) {
      releaseRk3568DeviceByTaskId(task.id);
      continue;
    }

    queuedTaskIds.delete(task.id);

    const updated = await updateRk3568Task(task.id, (current) => ({
      ...current,
      status: "running",
      message: `任务已派发到客户端 ${assignment.clientName} (${assignment.clientId})，设备 ${assignment.deviceSerial}。`,
      startedAt: current.startedAt || nowIso(),
      executionMode: "remote-client",
      assignedClientId: assignment.clientId,
      assignedClientName: assignment.clientName,
      assignedDeviceSerial: assignment.deviceSerial,
      dispatchedAt: nowIso(),
    }));

    if (updated) {
      await appendTaskLogSafe(
        updated.logPath,
        updated.id,
        `Dispatched to client ${assignment.clientName} (${assignment.clientId}) with device ${assignment.deviceSerial}.`,
      );
    }
  }
}

function triggerDispatch(): void {
  if (dispatching) {
    return;
  }
  dispatching = true;
  void tryDispatchQueuedTasks().finally(() => {
    dispatching = false;
    if (queuedTaskIds.size > 0) {
      triggerDispatch();
    }
  });
}

export async function listRk3568Tasks(options: ListTaskOptions = {}): Promise<Rk3568TestTask[]> {
  bindHubHandlers();
  const store = await readStoreUnsafe();
  const filtered = store.tasks.filter((task) => {
    if (options.repositoryOwner && task.repositoryOwner !== options.repositoryOwner) {
      return false;
    }
    if (options.repositoryName && task.repositoryName !== options.repositoryName) {
      return false;
    }
    if (options.prNumber !== undefined && task.prNumber !== options.prNumber) {
      return false;
    }
    if (options.pipelineUrl && task.pipelineUrl !== options.pipelineUrl) {
      return false;
    }
    return true;
  });

  const sorted = sortTasksDesc(filtered);
  if (options.limit && options.limit > 0) {
    return sorted.slice(0, options.limit);
  }
  return sorted;
}

export async function getRk3568TaskById(id: string): Promise<Rk3568TestTask | undefined> {
  bindHubHandlers();
  const store = await readStoreUnsafe();
  return store.tasks.find((task) => task.id === id);
}

export async function getRk3568TaskLogById(id: string, maxLines = 300): Promise<string> {
  const task = await getRk3568TaskById(id);
  if (!task) {
    throw new Error("Task not found.");
  }

  try {
    const raw = await fs.readFile(task.logPath, "utf-8");
    if (!raw.trim()) {
      return "";
    }
    const lines = raw.split(/\r?\n/);
    if (maxLines > 0 && lines.length > maxLines) {
      return lines.slice(lines.length - maxLines).join("\n");
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export async function createRk3568Task(input: CreateTaskInput): Promise<Rk3568TestTask> {
  bindHubHandlers();
  return withStoreWriteLock(async () => {
    const store = await readStoreUnsafe();
    const id = createTaskId();
    const taskDir = path.join(TASK_RUNTIME_DIR, id);
    const task: Rk3568TestTask = {
      id,
      runId: input.runId,
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      prNumber: input.prNumber,
      pipelineUrl: input.pipelineUrl,
      testType: "tdd",
      testCaseName: input.testCaseName?.trim() || undefined,
      requestedDeviceSerial: input.requestedDeviceSerial?.trim() || undefined,
      status: "queued",
      message: "等待可用 RK3568 设备。",
      createdAt: nowIso(),
      taskDir,
      logPath: path.join(taskDir, "rk3568-test.log"),
      executionMode: "remote-client",
    };

    store.tasks.push(task);
    await writeStoreUnsafe(store);
    notifyRkTaskUpdated(task);
    await appendTaskLogSafe(task.logPath, task.id, "Task queued and waiting for available device.");
    return task;
  });
}

export async function updateRk3568Task(
  id: string,
  updater: (task: Rk3568TestTask) => Rk3568TestTask,
): Promise<Rk3568TestTask | undefined> {
  return withStoreWriteLock(async () => {
    const store = await readStoreUnsafe();
    const index = store.tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      return undefined;
    }

    const updated = updater(store.tasks[index]!);
    store.tasks[index] = updated;
    await writeStoreUnsafe(store);
    notifyRkTaskUpdated(updated);
    return updated;
  });
}

export function enqueueRk3568Task(taskId: string): void {
  bindHubHandlers();
  queuedTaskIds.add(taskId);
  triggerDispatch();
}

export function listRk3568RegisteredDevices(): Rk3568ServerDeviceState[] {
  bindHubHandlers();
  return listRk3568Devices();
}

export function listRk3568RegisteredClients(): Rk3568ServerClientState[] {
  bindHubHandlers();
  return listRk3568Clients();
}
