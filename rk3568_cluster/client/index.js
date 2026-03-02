#!/usr/bin/env node
const { execFile, spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

function nowIso() {
  return new Date().toISOString();
}

function trimOrUndefined(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolvePathFrom(baseDir, input, fallback) {
  const value = trimOrUndefined(input) || fallback;
  if (!value) {
    return baseDir;
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(baseDir, value);
}

function parsePositiveInt(input, fallback) {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

const baseDir = __dirname;
const serverWsUrl = process.env.RK3568_SERVER_WS_URL || "ws://127.0.0.1:3770";
const clientId = trimOrUndefined(process.env.RK3568_CLIENT_ID) || `rk-client-${os.hostname()}-${randomUUID().slice(0, 8)}`;
const clientName = trimOrUndefined(process.env.RK3568_CLIENT_NAME) || os.hostname();
const hdcPollIntervalMs = parsePositiveInt(process.env.RK3568_HDC_POLL_INTERVAL_MS, 5000);
const reconnectDelayMs = parsePositiveInt(process.env.RK3568_CLIENT_RECONNECT_MS, 3000);
const xtsEnvDir = resolvePathFrom(baseDir, process.env.RK3568_XTS_ENV_DIR, "../xts_env");
const workDir = resolvePathFrom(baseDir, process.env.RK3568_CLIENT_WORK_DIR, "./runtime");
const artifactCacheDir = path.join(workDir, "artifact-cache");
const tasksRootDir = path.join(workDir, "tasks");
const composeFile = path.join(xtsEnvDir, "docker-compose.env.yml");
const tddHostDir = trimOrUndefined(process.env.RK3568_TDD_HOST_DIR)
  ? resolvePathFrom(baseDir, process.env.RK3568_TDD_HOST_DIR, "")
  : path.join(xtsEnvDir, "TDD");

const IMAGE_ARTIFACT_PATTERN = /artifacts-dayu200-(?!.*_tdd)[^"'<>\\\s]*-version-dayu200\.tar\.gz/i;
const TDD_ARTIFACT_PATTERN = /artifacts-dayu200_tdd-[^"'<>\\\s]*-version-dayu200_tdd\.tar\.gz/i;
const IMAGE_ARTIFACT_URL_PATTERN = /https?:\/\/dcp\.openharmony\.cn\/Artifacts\/dayu200\/[0-9-]+\/version\/Artifacts-dayu200-[^"'<>\\\s]*-version-dayu200\.tar\.gz/gi;
const TDD_ARTIFACT_URL_PATTERN = /https?:\/\/dcp\.openharmony\.cn\/Artifacts\/dayu200_tdd\/[0-9-]+\/version\/Artifacts-dayu200_tdd-[^"'<>\\\s]*-version-dayu200_tdd\.tar\.gz/gi;
const IMAGE_ARTIFACT_PATH_PATTERN = /\/?Artifacts\/dayu200\/[0-9-]+\/version\/Artifacts-dayu200-[^"'<>\\\s]*-version-dayu200\.tar\.gz/gi;
const TDD_ARTIFACT_PATH_PATTERN = /\/?Artifacts\/dayu200_tdd\/[0-9-]+\/version\/Artifacts-dayu200_tdd-[^"'<>\\\s]*-version-dayu200_tdd\.tar\.gz/gi;
const ARTIFACT_BASE_PATH_PATTERN = /\/?Artifacts\/([a-z0-9_-]+)\/([a-z0-9_-]+)/gi;

let ws = null;
let reconnectTimer = null;
let devicePollTimer = null;
const runningTasks = new Map();

function log(message) {
  console.log(`[rk3568-client][${nowIso()}] ${message}`);
}

function logError(message) {
  console.error(`[rk3568-client][${nowIso()}] ${message}`);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function decodeUriSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function forceHttpsForDcp(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.hostname === "dcp.openharmony.cn" && parsed.protocol !== "https:") {
      parsed.protocol = "https:";
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function normalizeArtifactText(raw) {
  return String(raw || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u003a/gi, ":")
    .replace(/\\\//g, "/")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normalizeCandidateUrl(raw, runlistUrl) {
  const cleaned = String(raw || "")
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

function buildArtifactDownloadUrl(target, buildNumber) {
  const normalizedTarget = String(target || "").trim();
  const normalizedBuild = String(buildNumber || "").trim();
  if (!normalizedTarget || !normalizedBuild) {
    return undefined;
  }
  return forceHttpsForDcp(
    `https://dcp.openharmony.cn/Artifacts/${normalizedTarget}/${normalizedBuild}/version/Artifacts-${normalizedTarget}-${normalizedBuild}-version-${normalizedTarget}.tar.gz`,
  );
}

function collectArtifactCandidatesFromBasePath(rawText) {
  const text = normalizeArtifactText(rawText);
  const urls = Array.from(text.matchAll(ARTIFACT_BASE_PATH_PATTERN))
    .map((matched) => buildArtifactDownloadUrl(matched[1] || "", matched[2] || ""))
    .filter(Boolean);
  return Array.from(new Set(urls));
}

function collectArtifactCandidates(rawText, runlistUrl) {
  const text = normalizeArtifactText(rawText);
  const directUrls = [
    ...Array.from(text.matchAll(IMAGE_ARTIFACT_URL_PATTERN)).map((item) => item[0]),
    ...Array.from(text.matchAll(TDD_ARTIFACT_URL_PATTERN)).map((item) => item[0]),
  ].map((item) => forceHttpsForDcp(item));

  const directPaths = [
    ...Array.from(text.matchAll(IMAGE_ARTIFACT_PATH_PATTERN)).map((item) => item[0]),
    ...Array.from(text.matchAll(TDD_ARTIFACT_PATH_PATTERN)).map((item) => item[0]),
  ]
    .map((item) => forceHttpsForDcp(`https://dcp.openharmony.cn${item.startsWith("/") ? item : `/${item}`}`));

  const tokenPattern = /(?:https?:\/\/|\/\/|\/|\.\.?\/)?[^\s"'<>`]*artifacts-[^\s"'<>`]*?\.tar\.gz(?:\?[^\s"'<>`]*)?/gi;
  const normalizedFromTokens = Array.from(text.matchAll(tokenPattern))
    .map((item) => normalizeCandidateUrl(item[0], runlistUrl))
    .filter(Boolean);

  const fromBasePaths = collectArtifactCandidatesFromBasePath(text);
  return Array.from(new Set([...directUrls, ...directPaths, ...normalizedFromTokens, ...fromBasePaths]));
}

function collectArtifactCandidatesFromUnknown(value, runlistUrl) {
  const candidates = [];
  const queue = [value];
  const visited = new Set();

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

    for (const item of Object.values(current)) {
      queue.push(item);
    }
  }

  return Array.from(new Set(candidates));
}

function matchesArtifact(url, pattern) {
  return pattern.test(decodeUriSafe(url));
}

function pickArtifactsFromCandidates(candidates) {
  const imageArtifactUrl = candidates.find((item) => matchesArtifact(item, IMAGE_ARTIFACT_PATTERN));
  const tddArtifactUrl = candidates.find((item) => matchesArtifact(item, TDD_ARTIFACT_PATTERN));
  if (!imageArtifactUrl) {
    throw new Error("Cannot find dayu200 image artifact URL.");
  }
  if (!tddArtifactUrl) {
    throw new Error("Cannot find dayu200_tdd artifact URL.");
  }
  return { imageArtifactUrl, tddArtifactUrl };
}

function extractEventIdFromRunlistUrl(runlistUrl) {
  const matched = String(runlistUrl).match(/\/workbench\/cicd\/detail\/([^/?#]+)\/runlist/i);
  if (!matched || !matched[1]) {
    return undefined;
  }
  return matched[1].trim() || undefined;
}

function buildCurlHeaderArgs() {
  const args = [];
  const auth = trimOrUndefined(process.env.DCP_AUTHORIZATION);
  const cookie = trimOrUndefined(process.env.DCP_COOKIE);
  const token = trimOrUndefined(process.env.DCP_TOKEN);
  if (auth) {
    args.push("-H", `Authorization: ${auth}`);
  }
  if (cookie) {
    args.push("-H", `Cookie: ${cookie}`);
  }
  if (token) {
    args.push("-H", `x-auth-token: ${token}`);
  }
  return args;
}

function execCurl(args, timeoutMs = 0, maxBuffer = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      args,
      { timeout: timeoutMs, maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error([stderr.trim(), stdout.trim(), error.message].filter(Boolean).join("\n")));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function curlGetText(url) {
  const result = await execCurl([
    "-sS",
    "-L",
    "--fail",
    "--connect-timeout",
    "15",
    "--max-time",
    "120",
    ...buildCurlHeaderArgs(),
    forceHttpsForDcp(url),
  ], 130000, 30 * 1024 * 1024);
  return result.stdout;
}

async function discoverArtifactsFromEventApi(runlistUrl) {
  const eventId = extractEventIdFromRunlistUrl(runlistUrl);
  if (!eventId) {
    throw new Error("Cannot parse event id from pipeline URL.");
  }
  const eventApiUrl = `https://dcp.openharmony.cn/api/codecheckAccess/ci-portal/v1/event/${eventId}`;
  const raw = await curlGetText(eventApiUrl);
  const payload = JSON.parse(raw);
  const candidates = Array.from(new Set([
    ...collectArtifactCandidates(raw, runlistUrl),
    ...collectArtifactCandidatesFromUnknown(payload, runlistUrl),
  ]));
  if (candidates.length === 0) {
    throw new Error("No artifact URLs found in event api response.");
  }
  return pickArtifactsFromCandidates(candidates);
}

async function discoverArtifacts(runlistUrl) {
  const normalizedRunlist = forceHttpsForDcp(runlistUrl);
  try {
    return await discoverArtifactsFromEventApi(normalizedRunlist);
  } catch (error) {
    const eventError = error instanceof Error ? error.message : String(error);
    const html = await curlGetText(normalizedRunlist);
    const candidates = collectArtifactCandidates(html, normalizedRunlist);
    if (candidates.length === 0) {
      throw new Error(`No artifact URLs found. event-api-error: ${eventError}`);
    }
    return pickArtifactsFromCandidates(candidates);
  }
}

function buildCacheFilePath(url, prefix) {
  const digest = createHash("sha256").update(url).digest("hex");
  let ext = ".bin";
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".tar.gz")) {
      ext = ".tar.gz";
    } else {
      const parsedExt = path.extname(pathname);
      if (parsedExt) {
        ext = parsedExt;
      }
    }
  } catch {
    ext = ".bin";
  }
  return path.join(artifactCacheDir, `${prefix}-${digest}${ext}`);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function downloadWithCache(url, destination, prefix, onLog) {
  const cachePath = buildCacheFilePath(url, prefix);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  if (!(await fileExists(cachePath))) {
    const tmpPath = `${cachePath}.tmp-${Date.now()}`;
    onLog(`cache miss: ${url}`);
    await execCurl([
      "-sS",
      "-L",
      "--fail",
      "--connect-timeout",
      "15",
      "--max-time",
      "7200",
      ...buildCurlHeaderArgs(),
      "-o",
      tmpPath,
      url,
    ], 2 * 60 * 60 * 1000, 10 * 1024 * 1024);
    await fs.rename(tmpPath, cachePath);
    onLog(`cache saved: ${cachePath}`);
  } else {
    onLog(`cache hit: ${cachePath}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(cachePath, destination);
}

function execShell(command, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", command],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs || 0,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error([stderr.trim(), stdout.trim(), error.message].filter(Boolean).join("\n")));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function emitBufferedLines(buffer, onLine) {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const remaining = lines.pop() || "";
  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned) {
      continue;
    }
    onLine(cleaned);
  }
  return remaining;
}

function execStreaming(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: options.env || process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timeoutTimer = null;

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      stdout += text;
      if (options.onStdoutLine) {
        stdoutBuffer = emitBufferedLines(stdoutBuffer + text, options.onStdoutLine);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      stderr += text;
      if (options.onStderrLine) {
        stderrBuffer = emitBufferedLines(stderrBuffer + text, options.onStderrLine);
      }
    });

    child.on("error", (error) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (stdoutBuffer.trim() && options.onStdoutLine) {
        options.onStdoutLine(stdoutBuffer.trim());
      }
      if (stderrBuffer.trim() && options.onStderrLine) {
        options.onStderrLine(stderrBuffer.trim());
      }
      if (code === 0 && !signal) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error([
        stderr.trim(),
        stdout.trim(),
        signal ? `signal: ${signal}` : "",
        typeof code === "number" ? `exit code: ${code}` : "",
      ].filter(Boolean).join("\n")));
    });
  });
}

async function findDirectoryByName(startDir, dirName) {
  const result = await execShell(`find ${shellEscape(startDir)} -type d -name ${shellEscape(dirName)} | head -n 1`);
  const found = result.stdout.trim();
  if (!found) {
    throw new Error(`Cannot find directory '${dirName}' under ${startDir}`);
  }
  return found;
}

async function resolveImageDir(extractRoot) {
  const result = await execShell(
    `find ${shellEscape(extractRoot)} -type f -name MiniLoaderAll.bin | head -n 1`,
  );
  const filePath = result.stdout.trim();
  if (filePath) {
    return path.dirname(filePath);
  }
  const fallback = await execShell(`find ${shellEscape(extractRoot)} -mindepth 1 -maxdepth 2 -type d | head -n 1`);
  const dir = fallback.stdout.trim();
  if (!dir) {
    throw new Error(`Cannot locate image directory under ${extractRoot}`);
  }
  return dir;
}

function sendJson(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function sendTaskLog(taskId, line, isError = false) {
  sendJson({
    type: "task-log",
    taskId,
    line,
    isError,
  });
}

function sendTaskStatus(taskId, status, message, extra = {}) {
  sendJson({
    type: "task-status",
    taskId,
    status,
    message,
    ...extra,
  });
}

async function parseHdcDevices() {
  try {
    const { stdout } = await execShell("hdc list targets -v");
    const devices = new Map();
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const parts = line.split(/\s+/);
      const serial = parts[0];
      if (!serial || serial.toLowerCase() === "empty") {
        continue;
      }
      const lowLine = line.toLowerCase();
      let status = "unknown";
      if (lowLine.includes("connected") || lowLine.includes("online")) {
        status = "online";
      } else if (lowLine.includes("offline")) {
        status = "offline";
      }
      devices.set(serial, { serial, status });
    }
    return Array.from(devices.values());
  } catch (error) {
    logError(`hdc list targets failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function reportDevices() {
  const devices = await parseHdcDevices();
  sendJson({
    type: "device-report",
    devices,
  });
}

async function runTask(message) {
  const taskId = message.taskId;
  const deviceSerial = String(message.deviceSerial || "").trim();
  if (!taskId || !deviceSerial) {
    return;
  }
  if (runningTasks.has(taskId) || Array.from(runningTasks.values()).includes(deviceSerial)) {
    sendTaskStatus(taskId, "failed", `Task rejected: device ${deviceSerial} is busy in client.`);
    return;
  }

  runningTasks.set(taskId, deviceSerial);
  sendTaskStatus(taskId, "running", `Task accepted by client ${clientName}.`);
  sendTaskLog(taskId, `Task accepted. device=${deviceSerial}, pipeline=${message.pipelineUrl}`);

  const taskRoot = path.join(tasksRootDir, taskId);
  const mountRoot = path.join(taskRoot, "mounts");
  const mounts = {
    tests: path.join(mountRoot, "tests"),
    images: path.join(mountRoot, "images"),
    reports: path.join(mountRoot, "reports"),
    downloads: path.join(mountRoot, "downloads"),
  };
  const artifactDir = path.join(taskRoot, "artifacts");
  const extractRoot = path.join(taskRoot, "extract");
  const imageArchivePath = path.join(artifactDir, "Artifacts-dayu200.tar.gz");
  const tddArchivePath = path.join(artifactDir, "Artifacts-dayu200_tdd.tar.gz");
  const imageExtractPath = path.join(extractRoot, "image");
  const tddExtractPath = path.join(extractRoot, "tdd");

  try {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.mkdir(imageExtractPath, { recursive: true });
    await fs.mkdir(tddExtractPath, { recursive: true });
    await fs.mkdir(mounts.tests, { recursive: true });
    await fs.mkdir(mounts.images, { recursive: true });
    await fs.mkdir(mounts.reports, { recursive: true });
    await fs.mkdir(mounts.downloads, { recursive: true });

    sendTaskLog(taskId, "Resolving artifact URLs from pipeline...");
    const artifacts = await discoverArtifacts(message.pipelineUrl);
    sendTaskLog(taskId, `Resolved image artifact: ${artifacts.imageArtifactUrl}`);
    sendTaskLog(taskId, `Resolved tdd artifact: ${artifacts.tddArtifactUrl}`);

    await downloadWithCache(artifacts.imageArtifactUrl, imageArchivePath, "dayu200-image", (line) => {
      sendTaskLog(taskId, line);
    });
    await downloadWithCache(artifacts.tddArtifactUrl, tddArchivePath, "dayu200-tdd", (line) => {
      sendTaskLog(taskId, line);
    });

    sendTaskLog(taskId, "Extracting artifacts...");
    await execShell(`tar -xzf ${shellEscape(imageArchivePath)} -C ${shellEscape(imageExtractPath)}`);
    await execShell(`tar -xzf ${shellEscape(tddArchivePath)} -C ${shellEscape(tddExtractPath)}`);

    const testsSource = await findDirectoryByName(tddExtractPath, "tests");
    const imageSource = await resolveImageDir(imageExtractPath);
    sendTaskLog(taskId, `tests source: ${testsSource}`);
    sendTaskLog(taskId, `image source: ${imageSource}`);

    await execShell(`rm -rf ${shellEscape(mounts.tests)}/* ${shellEscape(mounts.images)}/* || true`);
    await execShell(`cp -a ${shellEscape(testsSource)}/. ${shellEscape(mounts.tests)}/`);
    await execShell(`cp -a ${shellEscape(imageSource)}/. ${shellEscape(mounts.images)}/`);

    sendTaskLog(taskId, "Starting task container via docker-compose.env.yml ...");
    const taskCase = trimOrUndefined(message.testCaseName);
    const testCommand = taskCase
      ? `./start.sh run -p rk3568 -t UT -ts ${shellEscape(taskCase)}`
      : "./start.sh run -p rk3568 -t UT";

    const runScript = [
      "set -euo pipefail",
      "echo \"[task] begin flash\"",
      "/opt/tools/flash/flash.sh \"$TEST_IMAGE_DIR\"",
      "echo \"[task] begin start.sh\"",
      "cd /workspace/TDD/testfwk_developer_test",
      testCommand,
    ].join("\n");

    const composeCommand = [
      "docker compose",
      `-f ${shellEscape(composeFile)}`,
      `run --rm -T --name ${shellEscape(`ohos-rk-task-${taskId.slice(0, 8)}`)}`,
      "tdd-env",
      "bash -lc",
      shellEscape(runScript),
    ].join(" ");

    await execStreaming(composeCommand, {
      cwd: xtsEnvDir,
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: `rk3568-task-${taskId.slice(0, 8)}`,
        TDD_HOST_DIR: tddHostDir,
        TEST_CASES_HOST_DIR: mounts.tests,
        IMAGE_HOST_DIR: mounts.images,
        REPORTS_HOST_DIR: mounts.reports,
        DOWNLOAD_HOST_DIR: mounts.downloads,
        DEVICE_SN: deviceSerial,
        PREPARED_REPOS_ONLY: process.env.PREPARED_REPOS_ONLY || "1",
      },
      timeoutMs: 4 * 60 * 60 * 1000,
      onStdoutLine: (line) => sendTaskLog(taskId, line, false),
      onStderrLine: (line) => sendTaskLog(taskId, line, true),
    });

    sendTaskLog(taskId, "Task finished successfully.");
    sendTaskStatus(taskId, "success", "RK3568 test completed on client.");
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    sendTaskLog(taskId, `Task failed: ${messageText}`, true);
    sendTaskStatus(taskId, "failed", messageText);
  } finally {
    runningTasks.delete(taskId);
    void reportDevices();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectServer();
  }, reconnectDelayMs);
}

function startDevicePolling() {
  if (devicePollTimer) {
    clearInterval(devicePollTimer);
  }
  devicePollTimer = setInterval(() => {
    void reportDevices();
  }, hdcPollIntervalMs);
}

function stopDevicePolling() {
  if (!devicePollTimer) {
    return;
  }
  clearInterval(devicePollTimer);
  devicePollTimer = null;
}

function handleServerMessage(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf-8"));
  } catch {
    return;
  }
  if (!parsed || typeof parsed.type !== "string") {
    return;
  }
  if (parsed.type === "ping") {
    sendJson({ type: "pong" });
    return;
  }
  if (parsed.type === "start-task") {
    void runTask(parsed);
  }
}

function connectServer() {
  log(`connecting server: ${serverWsUrl}`);
  ws = new WebSocket(serverWsUrl, {
    handshakeTimeout: 15000,
  });

  ws.on("open", () => {
    log(`connected as ${clientId} (${clientName})`);
    sendJson({
      type: "client-hello",
      clientId,
      name: clientName,
      version: "0.1.0",
    });
    void reportDevices();
    startDevicePolling();
  });

  ws.on("message", (message) => {
    handleServerMessage(message);
  });

  ws.on("close", () => {
    logError("server connection closed");
    stopDevicePolling();
    scheduleReconnect();
  });

  ws.on("error", (error) => {
    logError(`server connection error: ${error.message}`);
  });
}

async function bootstrap() {
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(artifactCacheDir, { recursive: true });
  await fs.mkdir(tasksRootDir, { recursive: true });

  try {
    await fs.access(composeFile);
  } catch (error) {
    throw new Error(`compose file not found: ${composeFile}. ${error instanceof Error ? error.message : String(error)}`);
  }

  log(`xts env dir: ${xtsEnvDir}`);
  log(`work dir: ${workDir}`);
  log(`server ws: ${serverWsUrl}`);
  connectServer();
}

bootstrap().catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
