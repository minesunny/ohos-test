import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { notifyRkTaskLog, notifyRkTaskUpdated } from "@/lib/realtime-ws";
import { type Rk3568TestStore, type Rk3568TestTask } from "@/types/rk3568";

const DATA_DIR = path.join(process.cwd(), "data");
const TASKS_FILE = path.join(DATA_DIR, "rk3568-tests.json");

let writeQueue: Promise<void> = Promise.resolve();
let executionQueue: Promise<void> = Promise.resolve();

const IMAGE_ARTIFACT_PATTERN = /artifacts-dayu200-(?!.*_tdd)[^"'<>\\\s]*-version-dayu200\.tar\.gz/i;
const TDD_ARTIFACT_PATTERN = /artifacts-dayu200_tdd-[^"'<>\\\s]*-version-dayu200_tdd\.tar\.gz/i;
const IMAGE_ARTIFACT_URL_PATTERN = /https?:\/\/dcp\.openharmony\.cn\/Artifacts\/dayu200\/[0-9-]+\/version\/Artifacts-dayu200-[^"'<>\\\s]*-version-dayu200\.tar\.gz/gi;
const TDD_ARTIFACT_URL_PATTERN = /https?:\/\/dcp\.openharmony\.cn\/Artifacts\/dayu200_tdd\/[0-9-]+\/version\/Artifacts-dayu200_tdd-[^"'<>\\\s]*-version-dayu200_tdd\.tar\.gz/gi;
const IMAGE_ARTIFACT_PATH_PATTERN = /\/?Artifacts\/dayu200\/[0-9-]+\/version\/Artifacts-dayu200-[^"'<>\\\s]*-version-dayu200\.tar\.gz/gi;
const TDD_ARTIFACT_PATH_PATTERN = /\/?Artifacts\/dayu200_tdd\/[0-9-]+\/version\/Artifacts-dayu200_tdd-[^"'<>\\\s]*-version-dayu200_tdd\.tar\.gz/gi;
const ARTIFACT_BASE_PATH_PATTERN = /\/?Artifacts\/([a-z0-9_-]+)\/([a-z0-9_-]+)/gi;
const STALE_RUNNING_TASK_MS = 3 * 60 * 1000;

type CreateTaskInput = {
  runId?: string;
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  pipelineUrl: string;
  testCaseName?: string;
};

type ListTaskOptions = {
  repositoryOwner?: string;
  repositoryName?: string;
  prNumber?: number;
  pipelineUrl?: string;
  limit?: number;
};

type ExecShellOptions = {
  cwd?: string;
  timeoutMs?: number;
};

type ExecShellStreamOptions = ExecShellOptions & {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

type CurlExecOptions = {
  maxBuffer?: number;
  timeoutMs?: number;
};

type ReportSnapshotEntry = {
  isDirectory: boolean;
  mtimeMs: number;
};

type ReportSnapshot = Map<string, ReportSnapshotEntry>;

type ResultArchiveBundle = {
  archivePath: string;
  archiveName: string;
  reportEntries: string[];
};

type HdcTargetStatus = {
  connected: string[];
  offline: string[];
  unknown: string[];
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

function getBaseDir(): string {
  return process.env.RK3568_BASE_DIR?.trim() || "/home/maien/TDD";
}

function getDayu200BaseDir(): string {
  return path.join(getBaseDir(), "dayu200");
}

function getTestfwkDir(): string {
  return path.join(getBaseDir(), "testfwk_developer_test");
}

function getArtifactCacheDir(): string {
  const configured = process.env.RK3568_ARTIFACT_CACHE_DIR?.trim();
  if (configured) {
    return expandHome(configured);
  }
  return path.join(getBaseDir(), ".rk3568-artifact-cache");
}

function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }

  const home = process.env.HOME || "";
  if (!home) {
    return input;
  }

  if (input === "~") {
    return home;
  }

  if (input.startsWith("~/")) {
    return path.join(home, input.slice(2));
  }

  return input;
}

function getFlashScriptPath(): string {
  const raw = process.env.RK3568_FLASH_SCRIPT?.trim() || "~/ark-standalone-build/flash.sh";
  return expandHome(raw);
}

function getFetchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  const auth = process.env.DCP_AUTHORIZATION?.trim();
  const cookie = process.env.DCP_COOKIE?.trim();
  const token = process.env.DCP_TOKEN?.trim();

  if (auth) {
    headers.Authorization = auth;
  }
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (token) {
    headers["x-auth-token"] = token;
  }

  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
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

async function reconcileStaleRunningTasks(): Promise<void> {
  await withStoreWriteLock(async () => {
    const store = await readStoreUnsafe();
    let changed = false;
    const now = Date.now();

    for (let index = 0; index < store.tasks.length; index += 1) {
      const task = store.tasks[index]!;
      if (task.status !== "running") {
        continue;
      }

      const startedAtMs = Date.parse(task.startedAt || task.createdAt);
      if (!Number.isFinite(startedAtMs) || now - startedAtMs < STALE_RUNNING_TASK_MS) {
        continue;
      }

      let hasLog = false;
      try {
        const stat = await fs.stat(task.logPath);
        hasLog = stat.isFile() && stat.size > 0;
      } catch {
        hasLog = false;
      }

      if (hasLog) {
        continue;
      }

      store.tasks[index] = {
        ...task,
        status: "failed",
        message: "任务中断：未检测到日志输出，可能因目录权限或进程退出导致。",
        finishedAt: nowIso(),
      };
      changed = true;
    }

    if (changed) {
      await writeStoreUnsafe(store);
    }
  });
}

export async function listRk3568Tasks(options: ListTaskOptions = {}): Promise<Rk3568TestTask[]> {
  await reconcileStaleRunningTasks();
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
  await reconcileStaleRunningTasks();
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
  return withStoreWriteLock(async () => {
    const store = await readStoreUnsafe();
    const id = createTaskId();
    const timestamp = nowIso().replace(/[:.]/g, "-");
    const taskDir = path.join(getDayu200BaseDir(), `${timestamp}-${id.slice(0, 8)}`);
    const task: Rk3568TestTask = {
      id,
      runId: input.runId,
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      prNumber: input.prNumber,
      pipelineUrl: input.pipelineUrl,
      testType: "tdd",
      testCaseName: input.testCaseName?.trim() || undefined,
      status: "queued",
      createdAt: nowIso(),
      taskDir,
      logPath: path.join(taskDir, "rk3568-test.log"),
    };

    store.tasks.push(task);
    await writeStoreUnsafe(store);
    notifyRkTaskUpdated(task);
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

function normalizeArtifactText(raw: string): string {
  return raw
    .replace(/\\u002f/gi, "/")
    .replace(/\\u003a/gi, ":")
    .replace(/\\\//g, "/")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function forceHttpsForDcp(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    if (url.hostname === "dcp.openharmony.cn" && url.protocol !== "https:") {
      url.protocol = "https:";
      return url.toString();
    }
    return url.toString();
  } catch {
    return urlValue;
  }
}

function normalizeCandidateUrl(raw: string, runlistUrl: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/^[("'`]+/, "")
    .replace(/[)"'`;,]+$/, "");
  if (!cleaned) {
    return undefined;
  }

  try {
    if (/^https?:\/\//i.test(cleaned)) {
      return forceHttpsForDcp(new URL(cleaned).toString());
    }

    if (cleaned.startsWith("//")) {
      const runUrl = new URL(runlistUrl);
      return forceHttpsForDcp(`${runUrl.protocol}${cleaned}`);
    }

    if (cleaned.startsWith("/") || cleaned.startsWith("./") || cleaned.startsWith("../")) {
      return forceHttpsForDcp(new URL(cleaned, runlistUrl).toString());
    }

    if (/artifacts-.*\.tar\.gz/i.test(cleaned)) {
      return forceHttpsForDcp(new URL(cleaned, runlistUrl).toString());
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function decodeUriSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchesArtifact(value: string, pattern: RegExp): boolean {
  const decoded = decodeUriSafe(value);
  return pattern.test(decoded);
}

function extractEventIdFromRunlistUrl(runlistUrl: string): string | undefined {
  const matched = runlistUrl.match(/\/workbench\/cicd\/detail\/([^/?#]+)\/runlist/i);
  if (!matched?.[1]) {
    return undefined;
  }
  return matched[1].trim() || undefined;
}

function buildArtifactDownloadUrl(target: string, buildNumber: string): string | undefined {
  const normalizedTarget = target.trim();
  const normalizedBuildNumber = buildNumber.trim();
  if (!normalizedTarget || !normalizedBuildNumber) {
    return undefined;
  }

  return forceHttpsForDcp(
    `https://dcp.openharmony.cn/Artifacts/${normalizedTarget}/${normalizedBuildNumber}/version/Artifacts-${normalizedTarget}-${normalizedBuildNumber}-version-${normalizedTarget}.tar.gz`,
  );
}

function collectArtifactCandidatesFromBasePath(raw: string): string[] {
  const text = normalizeArtifactText(raw);
  const candidates = Array.from(text.matchAll(ARTIFACT_BASE_PATH_PATTERN))
    .map((matched) => buildArtifactDownloadUrl(matched[1] || "", matched[2] || ""))
    .filter((item): item is string => Boolean(item));

  return Array.from(new Set(candidates));
}

function collectArtifactCandidates(raw: string, runlistUrl: string): string[] {
  const text = normalizeArtifactText(raw);
  const directUrls = [
    ...Array.from(text.matchAll(IMAGE_ARTIFACT_URL_PATTERN)).map((item) => item[0]),
    ...Array.from(text.matchAll(TDD_ARTIFACT_URL_PATTERN)).map((item) => item[0]),
  ]
    .map((item) => forceHttpsForDcp(item))
    .filter(Boolean);

  const directPaths = [
    ...Array.from(text.matchAll(IMAGE_ARTIFACT_PATH_PATTERN)).map((item) => item[0]),
    ...Array.from(text.matchAll(TDD_ARTIFACT_PATH_PATTERN)).map((item) => item[0]),
  ]
    .map((item) => {
      const normalized = item.startsWith("/") ? item : `/${item}`;
      return forceHttpsForDcp(`https://dcp.openharmony.cn${normalized}`);
    })
    .filter(Boolean);

  const tokenPattern = /(?:https?:\/\/|\/\/|\/|\.\.?\/)?[^\s"'<>`]*artifacts-[^\s"'<>`]*?\.tar\.gz(?:\?[^\s"'<>`]*)?/gi;
  const matched = Array.from(text.matchAll(tokenPattern)).map((item) => item[0]);
  const normalizedFromTokens = matched
    .map((item) => normalizeCandidateUrl(item, runlistUrl))
    .filter((item): item is string => Boolean(item));

  const fromBasePaths = collectArtifactCandidatesFromBasePath(text);

  return Array.from(new Set([...directUrls, ...directPaths, ...normalizedFromTokens, ...fromBasePaths]));
}

function collectArtifactCandidatesFromUnknown(value: unknown, runlistUrl: string): string[] {
  const candidates: string[] = [];
  const queue: unknown[] = [value];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const current = queue.pop();
    if (typeof current === "string") {
      candidates.push(...collectArtifactCandidates(current, runlistUrl));
      continue;
    }

    if (!current || typeof current !== "object") {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const item of Object.values(current as Record<string, unknown>)) {
      queue.push(item);
    }
  }

  return Array.from(new Set(candidates));
}

function pickArtifactsFromCandidates(candidates: string[]): {
  imageArtifactUrl: string;
  tddArtifactUrl: string;
} {
  const imageArtifactUrl = candidates.find((item) => matchesArtifact(item, IMAGE_ARTIFACT_PATTERN));
  const tddArtifactUrl = candidates.find((item) => matchesArtifact(item, TDD_ARTIFACT_PATTERN));

  if (!imageArtifactUrl) {
    throw new Error("Cannot find dayu200 image artifact URL.");
  }

  if (!tddArtifactUrl) {
    throw new Error("Cannot find dayu200_tdd test artifact URL.");
  }

  return {
    imageArtifactUrl,
    tddArtifactUrl,
  };
}

async function discoverArtifactsFromEventApi(runlistUrl: string): Promise<{
  imageArtifactUrl: string;
  tddArtifactUrl: string;
  source: "event-api";
  sourceUrl: string;
}> {
  const eventId = extractEventIdFromRunlistUrl(runlistUrl);
  if (!eventId) {
    throw new Error("Cannot parse event id from pipeline URL.");
  }

  const eventApiUrl = `https://dcp.openharmony.cn/api/codecheckAccess/ci-portal/v1/event/${eventId}`;
  const raw = await curlGetText(eventApiUrl);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Event API response is not valid JSON.");
  }

  const candidates = Array.from(
    new Set([
      ...collectArtifactCandidates(raw, runlistUrl),
      ...collectArtifactCandidatesFromUnknown(payload, runlistUrl),
    ]),
  );

  if (candidates.length === 0) {
    throw new Error("No artifact URL found in event API payload.");
  }

  const artifacts = pickArtifactsFromCandidates(candidates);
  return {
    ...artifacts,
    source: "event-api",
    sourceUrl: eventApiUrl,
  };
}

async function discoverArtifacts(runlistUrl: string): Promise<{
  imageArtifactUrl: string;
  tddArtifactUrl: string;
  source: "event-api" | "runlist-page";
  sourceUrl: string;
}> {
  const normalizedRunlistUrl = forceHttpsForDcp(runlistUrl);
  try {
    return await discoverArtifactsFromEventApi(normalizedRunlistUrl);
  } catch (eventError) {
    const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
    const html = await curlGetText(normalizedRunlistUrl);
    const candidates = collectArtifactCandidates(html, normalizedRunlistUrl);
    if (candidates.length === 0) {
      throw new Error(`No artifact URL found. event-api: ${eventMessage}`);
    }

    const artifacts = pickArtifactsFromCandidates(candidates);
    return {
      ...artifacts,
      source: "runlist-page",
      sourceUrl: normalizedRunlistUrl,
    };
  }
}

async function downloadFile(url: string, destination: string): Promise<void> {
  await curlDownloadFile(url, destination);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

async function execShell(command: string, options: ExecShellOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 0,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = [stderr.trim(), stdout.trim(), error.message]
            .filter(Boolean)
            .join("\n");
          reject(new Error(details || "Command failed."));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function emitBufferedLines(buffer: string, onLine?: (line: string) => void): string {
  if (!onLine) {
    return buffer;
  }

  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const remaining = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    onLine(line);
  }
  return remaining;
}

function flushBufferedLine(buffer: string, onLine?: (line: string) => void): string {
  if (!onLine) {
    return buffer;
  }
  const line = buffer.trim();
  if (!line) {
    return "";
  }
  onLine(line);
  return "";
}

function appendCapped(base: string, chunk: string, maxLength = 1024 * 1024): string {
  if (!chunk || base.length >= maxLength) {
    return base;
  }
  const remaining = maxLength - base.length;
  return base + chunk.slice(0, remaining);
}

async function execShellStreaming(
  command: string,
  options: ExecShellStreamOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let killedByTimeout = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let hardKillTimer: NodeJS.Timeout | undefined;
    let stdoutFlushTimer: NodeJS.Timeout | undefined;
    let stderrFlushTimer: NodeJS.Timeout | undefined;

    const schedulePartialFlush = (channel: "stdout" | "stderr") => {
      if (channel === "stdout") {
        if (stdoutFlushTimer) {
          return;
        }
        stdoutFlushTimer = setTimeout(() => {
          stdoutFlushTimer = undefined;
          stdoutBuffer = flushBufferedLine(stdoutBuffer, options.onStdoutLine);
        }, 600);
        return;
      }

      if (stderrFlushTimer) {
        return;
      }
      stderrFlushTimer = setTimeout(() => {
        stderrFlushTimer = undefined;
        stderrBuffer = flushBufferedLine(stderrBuffer, options.onStderrLine);
      }, 600);
    };

    if ((options.timeoutMs ?? 0) > 0) {
      timeoutTimer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
      }, options.timeoutMs);
    }

    const clearTimers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
        hardKillTimer = undefined;
      }
      if (stdoutFlushTimer) {
        clearTimeout(stdoutFlushTimer);
        stdoutFlushTimer = undefined;
      }
      if (stderrFlushTimer) {
        clearTimeout(stderrFlushTimer);
        stderrFlushTimer = undefined;
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      stdout = appendCapped(stdout, text);
      stdoutBuffer = emitBufferedLines(stdoutBuffer + text, options.onStdoutLine);
      if (stdoutBuffer.trim()) {
        schedulePartialFlush("stdout");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      stderr = appendCapped(stderr, text);
      stderrBuffer = emitBufferedLines(stderrBuffer + text, options.onStderrLine);
      if (stderrBuffer.trim()) {
        schedulePartialFlush("stderr");
      }
    });

    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimers();

      stdoutBuffer = flushBufferedLine(stdoutBuffer, options.onStdoutLine);
      stderrBuffer = flushBufferedLine(stderrBuffer, options.onStderrLine);

      if (code === 0 && !signal) {
        resolve({ stdout, stderr });
        return;
      }

      const details = [
        killedByTimeout ? "Command timed out." : "",
        stderr.trim(),
        stdout.trim(),
        signal ? `signal: ${signal}` : "",
        typeof code === "number" ? `exit code: ${code}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      reject(new Error(details || "Command failed."));
    });
  });
}

function buildCurlHeaderArgs(headers: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (!key || !value) {
      continue;
    }
    args.push("-H", `${key}: ${value}`);
  }
  return args;
}

async function execCurl(args: string[], options: CurlExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      "curl",
      args,
      {
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        timeout: options.timeoutMs ?? 0,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = [stderr.trim(), stdout.trim(), error.message]
            .filter(Boolean)
            .join("\n");
          reject(new Error(details || "curl request failed."));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function curlGetText(url: string): Promise<string> {
  const args = [
    "-sS",
    "-L",
    "--fail",
    "--connect-timeout",
    "15",
    "--max-time",
    "120",
    ...buildCurlHeaderArgs(getFetchHeaders()),
    url,
  ];
  const result = await execCurl(args, { maxBuffer: 30 * 1024 * 1024, timeoutMs: 130 * 1000 });
  return result.stdout;
}

async function curlDownloadFile(url: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const args = [
    "-sS",
    "-L",
    "--fail",
    "--connect-timeout",
    "15",
    "--max-time",
    "7200",
    ...buildCurlHeaderArgs(getFetchHeaders()),
    "-o",
    destination,
    url,
  ];
  await execCurl(args, { timeoutMs: 2 * 60 * 60 * 1000 });
}

async function appendTaskLog(logPath: string, message: string): Promise<void> {
  const line = `[${nowIso()}] ${message}\n`;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, line, "utf-8");
}

async function appendTaskLogSafe(logPath: string, taskId: string, message: string): Promise<void> {
  try {
    await appendTaskLog(logPath, message);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logTaskToConsole(taskId, `write log file failed: ${details}`, true);
  }
}

function taskConsolePrefix(taskId: string): string {
  return `[RK3568][${taskId.slice(0, 8)}]`;
}

function logTaskToConsole(taskId: string, message: string, isError = false): void {
  const line = `${taskConsolePrefix(taskId)} ${message}`;
  if (isError) {
    console.error(line);
    return;
  }
  console.log(line);
}

async function logTaskMessage(logPath: string, taskId: string, message: string): Promise<void> {
  logTaskToConsole(taskId, message, false);
  await appendTaskLogSafe(logPath, taskId, message);
  notifyRkTaskLog(taskId, message, false);
}

async function logTaskError(logPath: string, taskId: string, message: string): Promise<void> {
  logTaskToConsole(taskId, message, true);
  await appendTaskLogSafe(logPath, taskId, message);
  notifyRkTaskLog(taskId, message, true);
}

async function logCommandResult(
  logPath: string,
  taskId: string,
  label: string,
  result: { stdout: string; stderr: string },
): Promise<void> {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  if (stdout) {
    logTaskToConsole(taskId, `${label} stdout:\n${stdout}`);
    await appendTaskLogSafe(logPath, taskId, `${label} stdout:\n${stdout}`);
  }
  if (stderr) {
    logTaskToConsole(taskId, `${label} stderr:\n${stderr}`, true);
    await appendTaskLogSafe(logPath, taskId, `${label} stderr:\n${stderr}`);
  }
}

async function assertWritableDirectory(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, fsConstants.W_OK);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`No write permission for directory: ${dir}. ${details}`);
  }
}

async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function findHistoricalArtifactArchive(
  currentTaskId: string,
  artifactUrl: string,
  artifactKind: "image" | "tdd",
): Promise<string | undefined> {
  const store = await readStoreUnsafe();
  const relatedTasks = store.tasks
    .filter((task) => task.id !== currentTaskId)
    .filter((task) =>
      artifactKind === "image"
        ? task.imageArtifactUrl === artifactUrl
        : task.tddArtifactUrl === artifactUrl)
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  for (const task of relatedTasks) {
    const archivePath = artifactKind === "image" ? task.imageArchivePath : task.tddArchivePath;
    if (!archivePath) {
      continue;
    }
    if (await fileExistsNonEmpty(archivePath)) {
      return archivePath;
    }
  }

  return undefined;
}

function resolveCacheExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".tar.gz")) {
      return ".tar.gz";
    }
    const ext = path.extname(pathname);
    if (ext) {
      return ext;
    }
  } catch {
    // fallback to default extension below
  }
  return ".bin";
}

function buildCacheFilePath(url: string, cacheKeyPrefix: string): string {
  const digest = createHash("sha256").update(url).digest("hex");
  const safePrefix = cacheKeyPrefix.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const ext = resolveCacheExtensionFromUrl(url);
  return path.join(getArtifactCacheDir(), `${safePrefix}-${digest}${ext}`);
}

async function downloadWithCache(
  url: string,
  destination: string,
  cacheKeyPrefix: string,
  logPath: string,
  taskId: string,
  seedArchivePath?: string,
): Promise<{ cachePath: string; cacheHit: boolean }> {
  const cachePath = buildCacheFilePath(url, cacheKeyPrefix);
  let cacheHit = await fileExistsNonEmpty(cachePath);

  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  if (cacheHit) {
    await logTaskMessage(logPath, taskId, `缓存命中: ${cachePath}`);
  } else {
    const hasSeedArchive = seedArchivePath ? await fileExistsNonEmpty(seedArchivePath) : false;
    if (hasSeedArchive && seedArchivePath) {
      await logTaskMessage(logPath, taskId, `缓存未命中，复用历史任务产物: ${seedArchivePath}`);
      await fs.copyFile(seedArchivePath, cachePath);
      await logTaskMessage(logPath, taskId, `历史产物已写入缓存: ${cachePath}`);
    } else {
      await logTaskMessage(logPath, taskId, `缓存未命中，开始下载: ${url}`);
      const tempPath = `${cachePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await downloadFile(url, tempPath);
        const stat = await fs.stat(tempPath);
        if (!stat.isFile() || stat.size <= 0) {
          throw new Error(`downloaded cache file is invalid: ${tempPath}`);
        }
        await fs.rename(tempPath, cachePath);
        await logTaskMessage(logPath, taskId, `缓存写入完成: ${cachePath}`);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    cacheHit = false;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(cachePath, destination);
  await logTaskMessage(
    logPath,
    taskId,
    `${cacheHit ? "使用缓存文件" : "下载并缓存后使用"}: ${destination}`,
  );

  return {
    cachePath,
    cacheHit,
  };
}

async function findImagePath(imageDir: string): Promise<string> {
  try {
    const stat = await fs.stat(imageDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${imageDir}`);
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Image directory does not exist: ${imageDir}. ${details}`);
  }

  const { stdout } = await execShell(
    `find ${shellEscape(imageDir)} -mindepth 1 | head -n 1`,
  );
  if (!stdout.trim()) {
    throw new Error(`Image directory is empty: ${imageDir}`);
  }

  return imageDir;
}

async function findTestsDir(tddDir: string): Promise<string> {
  const { stdout } = await execShell(
    `find ${shellEscape(tddDir)} -type d -name tests | head -n 1`,
  );
  const found = stdout.trim();
  if (!found) {
    throw new Error("Cannot find tests directory in dayu200_tdd artifact.");
  }
  return found;
}

function buildStartShCommand(testCaseName?: string): string {
  const testCommand = testCaseName?.trim()
    ? `run -t UT -ts ${testCaseName.trim()}`
    : "run -t UT";
  const escapedTestCommand = shellEscape(testCommand);
  const readyWaitSeconds = parsePositiveIntEnv("RK3568_START_SH_READY_WAIT_SECONDS", 10);

  return `
set -e
if command -v script >/dev/null 2>&1; then
  {
    printf '1\\n'
    sleep 1
    sleep ${readyWaitSeconds}
    printf '%s\\n' ${escapedTestCommand}
    sleep 2
    printf 'quit\\n'
    printf 'exit\\n'
  } | timeout --foreground 10800 script -qec "./start.sh" /dev/null
else
  {
    printf '1\\n'
    sleep 1
    sleep ${readyWaitSeconds}
    printf '%s\\n' ${escapedTestCommand}
    sleep 2
    printf 'quit\\n'
    printf 'exit\\n'
  } | timeout --foreground 10800 ./start.sh
fi
`;
}

function parseHdcTargets(raw: string): HdcTargetStatus {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const connected: string[] = [];
  const offline: string[] = [];
  const unknown: string[] = [];

  for (const line of lines) {
    if (/connected|online/i.test(line)) {
      connected.push(line);
      continue;
    }
    if (/offline/i.test(line)) {
      offline.push(line);
      continue;
    }
    unknown.push(line);
  }

  return { connected, offline, unknown };
}

async function readHdcTargetsRaw(): Promise<string> {
  try {
    const verbose = await execShell("hdc list targets -v");
    if (verbose.stdout.trim()) {
      return verbose.stdout;
    }
  } catch {
    // fall through to basic command
  }

  const basic = await execShell("hdc list targets");
  return basic.stdout;
}

async function waitForHdcOnline(
  logPath: string,
  taskId: string,
): Promise<void> {
  const timeoutSeconds = parsePositiveIntEnv("RK3568_DEVICE_WAIT_TIMEOUT_SECONDS", 180);
  const intervalSeconds = parsePositiveIntEnv("RK3568_DEVICE_WAIT_INTERVAL_SECONDS", 5);
  const timeoutMs = timeoutSeconds * 1000;
  const intervalMs = intervalSeconds * 1000;
  const startedAt = Date.now();

  await logTaskMessage(logPath, taskId, `等待设备在线 (timeout=${timeoutSeconds}s, interval=${intervalSeconds}s)...`);

  while (true) {
    let raw = "";
    try {
      raw = await readHdcTargetsRaw();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      await logTaskError(logPath, taskId, `读取 hdc 设备列表失败: ${details}`);
    }

    const parsed = parseHdcTargets(raw);
    if (parsed.connected.length > 0) {
      await logTaskMessage(logPath, taskId, `检测到在线设备: ${parsed.connected.join(" | ")}`);
      return;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      const statusText = raw.trim() || "empty";
      throw new Error(`Wait RK3568 device online timeout after ${timeoutSeconds}s. hdc targets: ${statusText}`);
    }

    const statusLine = raw.trim() || "no target";
    await logTaskMessage(logPath, taskId, `设备仍未在线，继续等待: ${statusLine}`);
    await sleep(intervalMs);
  }
}

function detectStartShFailure(stdout: string, stderr: string): string | undefined {
  const combined = `${stdout}\n${stderr}`;

  if (/Environment-0101021/i.test(combined) || /actually\s+0\s+devices?\s+were\s+found/i.test(combined)) {
    return "未检测到可用设备（Environment-0101021: 0 devices found）。请确认 RK3568 已上线后重试。";
  }

  return undefined;
}

function toPosixRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function collectReportSnapshot(reportsDir: string): Promise<ReportSnapshot> {
  const snapshot: ReportSnapshot = new Map();

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(currentDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
        return;
      }
      throw error;
    }

    for (const entryName of entries) {
      const absolutePath = path.join(currentDir, entryName);
      const relativePath = toPosixRelativePath(
        relativeDir ? path.join(relativeDir, entryName) : entryName,
      );

      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM") {
          continue;
        }
        throw error;
      }

      snapshot.set(relativePath, {
        isDirectory: stat.isDirectory(),
        mtimeMs: stat.mtimeMs,
      });

      if (stat.isDirectory()) {
        await walk(absolutePath, relativePath);
      }
    }
  }

  await walk(reportsDir, "");
  return snapshot;
}

function resolveChangedReportEntries(
  before: ReportSnapshot,
  after: ReportSnapshot,
): string[] {
  const changed = new Set<string>();

  for (const [relativePath, afterEntry] of after.entries()) {
    const beforeEntry = before.get(relativePath);
    const isChanged = !beforeEntry
      || beforeEntry.isDirectory !== afterEntry.isDirectory
      || Math.abs(beforeEntry.mtimeMs - afterEntry.mtimeMs) > 1;
    if (!isChanged) {
      continue;
    }

    const topLevel = relativePath.split("/")[0];
    if (topLevel) {
      changed.add(topLevel);
    }
  }

  return Array.from(changed).sort();
}

function resolveFallbackReportEntries(
  after: ReportSnapshot,
  minimumMtimeMs?: number,
): string[] {
  const latestMtimeByTopLevel = new Map<string, number>();

  for (const [relativePath, entry] of after.entries()) {
    const topLevel = relativePath.split("/")[0];
    if (!topLevel) {
      continue;
    }
    const current = latestMtimeByTopLevel.get(topLevel);
    if (current === undefined || entry.mtimeMs > current) {
      latestMtimeByTopLevel.set(topLevel, entry.mtimeMs);
    }
  }

  let candidates = Array.from(latestMtimeByTopLevel.entries());
  if (minimumMtimeMs) {
    candidates = candidates.filter(([, mtimeMs]) => mtimeMs >= minimumMtimeMs);
  }
  if (candidates.length === 0) {
    return [];
  }

  candidates.sort((a, b) => b[1] - a[1]);
  const latest = candidates[0]![1];
  return candidates
    .filter(([, mtimeMs]) => latest - mtimeMs <= 2_000)
    .map(([topLevel]) => topLevel);
}

async function createZipArchive(
  reportsDir: string,
  archivePath: string,
  reportEntries: string[],
): Promise<void> {
  if (reportEntries.length === 0) {
    throw new Error("No report entries to archive.");
  }

  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.rm(archivePath, { force: true });

  const escapedEntries = reportEntries.map((item) => shellEscape(item)).join(" ");
  const zipCommand = `cd ${shellEscape(reportsDir)} && zip -q -r ${shellEscape(archivePath)} ${escapedEntries}`;

  try {
    await execShell(zipCommand, { timeoutMs: 10 * 60 * 1000 });
    return;
  } catch (zipError) {
    const zipMessage = zipError instanceof Error ? zipError.message : String(zipError);
    throw new Error(`zip failed (${zipMessage})`);
  }
}

async function buildTaskResultArchive(
  task: Pick<Rk3568TestTask, "id" | "taskDir">,
  reportsDir: string,
  beforeSnapshot: ReportSnapshot | null,
  minimumMtimeMs?: number,
): Promise<ResultArchiveBundle | null> {
  if (!beforeSnapshot) {
    return null;
  }

  const afterSnapshot = await collectReportSnapshot(reportsDir);
  if (afterSnapshot.size === 0) {
    return null;
  }

  let reportEntries = resolveChangedReportEntries(beforeSnapshot, afterSnapshot);
  if (reportEntries.length === 0) {
    reportEntries = resolveFallbackReportEntries(afterSnapshot, minimumMtimeMs);
  }
  if (reportEntries.length === 0) {
    return null;
  }

  const archiveName = `rk3568-report-${task.id.slice(0, 8)}.zip`;
  const archivePath = path.join(task.taskDir, archiveName);
  await createZipArchive(reportsDir, archivePath, reportEntries);

  return {
    archivePath,
    archiveName,
    reportEntries,
  };
}

async function runTask(taskId: string): Promise<void> {
  const initial = await getRk3568TaskById(taskId);
  if (!initial) {
    return;
  }

  const logPath = initial.logPath;
  const baseDir = getBaseDir();
  const dayu200BaseDir = getDayu200BaseDir();
  const testsTargetDir = path.join(baseDir, "tests");
  const testfwkDir = getTestfwkDir();
  const reportsDir = path.join(testfwkDir, "reports");
  const flashScriptPath = getFlashScriptPath();
  let reportsSnapshotBeforeTest: ReportSnapshot | null = null;
  let testStepStartedAtMs: number | undefined;
  let resultArchive: ResultArchiveBundle | null = null;

  await updateRk3568Task(taskId, (task) => ({
    ...task,
    status: "running",
    message: "任务开始执行。",
    startedAt: nowIso(),
  }));

  try {
    await logTaskMessage(logPath, taskId, `Start RK3568 task: ${taskId}`);
    await logTaskMessage(logPath, taskId, `Pipeline URL: ${initial.pipelineUrl}`);

    await assertWritableDirectory(dayu200BaseDir);
    await assertWritableDirectory(initial.taskDir);
    try {
      await fs.access(testfwkDir, fsConstants.R_OK | fsConstants.X_OK);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`testfwk dir is not accessible: ${testfwkDir}. ${details}`);
    }

    try {
      await fs.access(flashScriptPath, fsConstants.X_OK);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`flash script is not executable: ${flashScriptPath}. ${details}`);
    }

    await logTaskMessage(logPath, taskId, `Task working directory: ${initial.taskDir}`);

    await logTaskMessage(logPath, taskId, "步骤 1/5: 解析流水线产物地址...");
    const artifacts = await discoverArtifacts(initial.pipelineUrl);
    await logTaskMessage(
      logPath,
      taskId,
      `Artifact source: ${artifacts.source === "event-api" ? "event API" : "runlist page"} (${artifacts.sourceUrl})`,
    );
    await logTaskMessage(logPath, taskId, `Image artifact URL: ${artifacts.imageArtifactUrl}`);
    await logTaskMessage(logPath, taskId, `TDD artifact URL: ${artifacts.tddArtifactUrl}`);

    const imageArchivePath = path.join(initial.taskDir, "Artifacts-dayu200.tar.gz");
    const tddArchivePath = path.join(initial.taskDir, "Artifacts-dayu200_tdd.tar.gz");
    const imageExtractDir = path.join(initial.taskDir, "image");
    const tddExtractDir = path.join(initial.taskDir, "tdd");

    await updateRk3568Task(taskId, (task) => ({
      ...task,
      imageArtifactUrl: artifacts.imageArtifactUrl,
      tddArtifactUrl: artifacts.tddArtifactUrl,
      imageArchivePath,
      tddArchivePath,
      message: "已解析产物地址，开始下载。",
    }));

    await logTaskMessage(logPath, taskId, "步骤 2/5: 下载镜像与测试用例...");
    await logTaskMessage(logPath, taskId, `Image artifact URL: ${artifacts.imageArtifactUrl}`);
    await logTaskMessage(logPath, taskId, `Image target path: ${imageArchivePath}`);
    const imageSeedArchive = await findHistoricalArtifactArchive(
      initial.id,
      artifacts.imageArtifactUrl,
      "image",
    );
    const imageCache = await downloadWithCache(
      artifacts.imageArtifactUrl,
      imageArchivePath,
      "dayu200-image",
      logPath,
      taskId,
      imageSeedArchive,
    );
    await logTaskMessage(
      logPath,
      taskId,
      `Image cache ${imageCache.cacheHit ? "hit" : "miss"}: ${imageCache.cachePath}`,
    );

    await logTaskMessage(logPath, taskId, `TDD artifact URL: ${artifacts.tddArtifactUrl}`);
    await logTaskMessage(logPath, taskId, `TDD target path: ${tddArchivePath}`);
    const tddSeedArchive = await findHistoricalArtifactArchive(
      initial.id,
      artifacts.tddArtifactUrl,
      "tdd",
    );
    const tddCache = await downloadWithCache(
      artifacts.tddArtifactUrl,
      tddArchivePath,
      "dayu200-tdd",
      logPath,
      taskId,
      tddSeedArchive,
    );
    await logTaskMessage(
      logPath,
      taskId,
      `TDD cache ${tddCache.cacheHit ? "hit" : "miss"}: ${tddCache.cachePath}`,
    );

    await logTaskMessage(logPath, taskId, "步骤 3/5: 解压镜像与测试用例...");
    await logTaskMessage(logPath, taskId, "Extracting image artifact...");
    await execShell(
      `mkdir -p ${shellEscape(imageExtractDir)} && tar -xzf ${shellEscape(imageArchivePath)} -C ${shellEscape(imageExtractDir)}`,
    ).then((result) => logCommandResult(logPath, taskId, "extract image", result));

    await logTaskMessage(logPath, taskId, "Extracting tdd artifact...");
    await execShell(
      `mkdir -p ${shellEscape(tddExtractDir)} && tar -xzf ${shellEscape(tddArchivePath)} -C ${shellEscape(tddExtractDir)}`,
    ).then((result) => logCommandResult(logPath, taskId, "extract tdd", result));

    await logTaskMessage(logPath, taskId, "Locating tests directory in tdd artifact...");
    const testsSourceDir = await findTestsDir(tddExtractDir);
    await logTaskMessage(logPath, taskId, `Found tests source: ${testsSourceDir}`);

    await logTaskMessage(logPath, taskId, `Copying tests directory to ${testsTargetDir} ...`);
    await execShell(
      `rm -rf ${shellEscape(testsTargetDir)} && cp -a ${shellEscape(testsSourceDir)} ${shellEscape(testsTargetDir)}`,
    ).then((result) => logCommandResult(logPath, taskId, "copy tests", result));

    await logTaskMessage(logPath, taskId, "Resolving flash image directory...");
    const imagePath = await findImagePath(imageExtractDir);
    await logTaskMessage(logPath, taskId, `Resolved image directory: ${imagePath}`);

    await updateRk3568Task(taskId, (task) => ({
      ...task,
      imagePath,
      message: "镜像与用例准备完成，开始烧录。",
    }));

    await logTaskMessage(logPath, taskId, "步骤 4/5: 刷写镜像...");
    await logTaskMessage(logPath, taskId, `Flashing image with: ${flashScriptPath} ${imagePath}`);
    let flashLogQueue: Promise<void> = Promise.resolve();
    await execShellStreaming(
      `${shellEscape(flashScriptPath)} ${shellEscape(imagePath)}`,
      {
        timeoutMs: 45 * 60 * 1000,
        onStdoutLine: (line) => {
          flashLogQueue = flashLogQueue.then(
            () => logTaskMessage(logPath, taskId, `flash stdout: ${line}`),
            () => logTaskMessage(logPath, taskId, `flash stdout: ${line}`),
          );
        },
        onStderrLine: (line) => {
          flashLogQueue = flashLogQueue.then(
            () => logTaskError(logPath, taskId, `flash stderr: ${line}`),
            () => logTaskError(logPath, taskId, `flash stderr: ${line}`),
          );
        },
      },
    );
    await flashLogQueue;

    await updateRk3568Task(taskId, (task) => ({
      ...task,
      message: "烧录完成，开始执行 TDD 测试。",
    }));

    await waitForHdcOnline(logPath, taskId);

    await logTaskMessage(logPath, taskId, "步骤 5/5: 执行 TDD 用例...");
    await logTaskMessage(logPath, taskId, `Running start.sh in ${testfwkDir} ...`);
    try {
      reportsSnapshotBeforeTest = await collectReportSnapshot(reportsDir);
    } catch (snapshotError) {
      const details = snapshotError instanceof Error ? snapshotError.message : String(snapshotError);
      reportsSnapshotBeforeTest = null;
      await logTaskError(logPath, taskId, `读取 reports 目录快照失败: ${details}`);
    }
    testStepStartedAtMs = Date.now();
    const startCommand = buildStartShCommand(initial.testCaseName);
    let streamLogQueue: Promise<void> = Promise.resolve();
    const startResult = await execShellStreaming(startCommand, {
      cwd: testfwkDir,
      timeoutMs: 3 * 60 * 60 * 1000,
      onStdoutLine: (line) => {
        streamLogQueue = streamLogQueue.then(
          () => logTaskMessage(logPath, taskId, `start.sh stdout: ${line}`),
          () => logTaskMessage(logPath, taskId, `start.sh stdout: ${line}`),
        );
      },
      onStderrLine: (line) => {
        streamLogQueue = streamLogQueue.then(
          () => logTaskError(logPath, taskId, `start.sh stderr: ${line}`),
          () => logTaskError(logPath, taskId, `start.sh stderr: ${line}`),
        );
      },
    });
    await streamLogQueue;
    const startFailure = detectStartShFailure(startResult.stdout, startResult.stderr);
    if (startFailure) {
      throw new Error(startFailure);
    }

    try {
      resultArchive = await buildTaskResultArchive(
        initial,
        reportsDir,
        reportsSnapshotBeforeTest,
        testStepStartedAtMs,
      );
      if (resultArchive) {
        await logTaskMessage(logPath, taskId, `测试结果已打包: ${resultArchive.archivePath}`);
      } else {
        await logTaskMessage(logPath, taskId, "未识别到新的测试结果文件，未生成下载包。");
      }
    } catch (archiveError) {
      const details = archiveError instanceof Error ? archiveError.message : String(archiveError);
      await logTaskError(logPath, taskId, `打包测试结果失败: ${details}`);
    }

    await logTaskMessage(logPath, taskId, "RK3568 test completed.");
    await updateRk3568Task(taskId, (task) => ({
      ...task,
      status: "success",
      message: "RK3568 测试完成。",
      finishedAt: nowIso(),
      resultReportEntries: resultArchive?.reportEntries || task.resultReportEntries,
      resultArchivePath: resultArchive?.archivePath || task.resultArchivePath,
      resultArchiveName: resultArchive?.archiveName || task.resultArchiveName,
      resultArchivedAt: resultArchive ? nowIso() : task.resultArchivedAt,
    }));
  } catch (error) {
    if (!resultArchive && reportsSnapshotBeforeTest) {
      try {
        resultArchive = await buildTaskResultArchive(
          initial,
          reportsDir,
          reportsSnapshotBeforeTest,
          testStepStartedAtMs,
        );
        if (resultArchive) {
          await logTaskMessage(logPath, taskId, `测试失败，但已打包结果: ${resultArchive.archivePath}`);
        }
      } catch (archiveError) {
        const details = archiveError instanceof Error ? archiveError.message : String(archiveError);
        await logTaskError(logPath, taskId, `打包测试结果失败: ${details}`);
      }
    }

    const message = error instanceof Error ? error.message : "RK3568 test failed.";
    await logTaskError(logPath, taskId, `Task failed: ${message}`);
    await updateRk3568Task(taskId, (task) => ({
      ...task,
      status: "failed",
      message,
      finishedAt: nowIso(),
      resultReportEntries: resultArchive?.reportEntries || task.resultReportEntries,
      resultArchivePath: resultArchive?.archivePath || task.resultArchivePath,
      resultArchiveName: resultArchive?.archiveName || task.resultArchiveName,
      resultArchivedAt: resultArchive ? nowIso() : task.resultArchivedAt,
    }));
  }
}

export function enqueueRk3568Task(taskId: string): void {
  executionQueue = executionQueue.then(
    () => runTask(taskId),
    () => runTask(taskId),
  );
}
