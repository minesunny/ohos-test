"use client";

import * as React from "react";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ExternalLink,
  Loader2,
  LogOut,
  Moon,
  Play,
  RefreshCw,
  Search,
  Sun,
  UserCircle2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { type PipelineRun, type PipelineRunStatus } from "@/types/pipeline";
import { type Rk3568ServerClientState, type Rk3568ServerDeviceState } from "@/types/rk3568-client";
import { type Rk3568TestTask } from "@/types/rk3568";

type PullRequestItem = {
  id: number;
  number: number;
  title: string;
  issueNumber?: number;
  state: "open" | "closed" | "merged";
  html_url: string;
  updated_at: string;
  user: {
    login: string;
    name?: string;
  };
  runCount: number;
  latestRun?: PipelineRun;
  runs: PipelineRun[];
};

type RepositoryTarget = {
  key: string;
  owner: string;
  repo: string;
};

type PullRequestListResponse = {
  repository: {
    owner: string;
    repo: string;
  };
  repositories: RepositoryTarget[];
  selectedTarget: string;
  filters?: {
    prNumber: string;
    title: string;
    issue: string;
    author: string;
    owner: string;
    repo: string;
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  prs: PullRequestItem[];
  error?: string;
};

type StateFilter = "open" | "closed" | "all";
type ThemeMode = "light" | "dark";

type SearchFilters = {
  prNumber: string;
  title: string;
  issue: string;
  author: string;
  owner: string;
  repo: string;
};

type RepositoryTargetInput = {
  owner: string;
  repo: string;
};

type AccountSettings = {
  repositoryTargets: RepositoryTarget[];
  gitcodeToken: string;
  apiBase: string;
  updatedAt?: string;
};

type AccountSettingsResponse = {
  hasSettings: boolean;
  source: "user" | "env" | "none";
  settings?: AccountSettings;
};

type SaveAccountSettingsResponse = {
  settings: AccountSettings;
};

type Rk3568TasksResponse = {
  tasks: Rk3568TestTask[];
};

type Rk3568CreateResponse = {
  task: Rk3568TestTask;
};

type Rk3568RerunResponse = {
  task: Rk3568TestTask;
  rerunFromTaskId: string;
};

type Rk3568TaskDetailResponse = {
  task: Rk3568TestTask;
  log?: string;
};

type Rk3568DevicesResponse = {
  clientWsUrl: string;
  clients: Rk3568ServerClientState[];
  devices: Rk3568ServerDeviceState[];
};

type RealtimeConfigResponse = {
  url: string;
  port: number;
  host: string;
  startedAt: string;
};

type SessionResponse = {
  authenticated: boolean;
  user?: {
    id: number;
    username: string;
    createdAt: string;
  };
};

type RealtimeServerMessage =
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

const RUN_STATUS_LABELS: Record<PipelineRunStatus, string> = {
  triggered: "已触发",
  running: "执行中",
  success: "成功",
  failed: "失败",
  unknown: "未知",
};

const RUN_STATUS_STYLES: Record<PipelineRunStatus, string> = {
  triggered: "state-run-triggered",
  running: "state-run-running",
  success: "state-run-success",
  failed: "state-run-failed",
  unknown: "state-run-unknown",
};

const RK3568_STATUS_LABELS: Record<Rk3568TestTask["status"], string> = {
  queued: "排队中",
  running: "执行中",
  success: "成功",
  failed: "失败",
};

const RK3568_STATUS_STYLES: Record<Rk3568TestTask["status"], string> = {
  queued: "state-rk-queued",
  running: "state-rk-running",
  success: "state-rk-success",
  failed: "state-rk-failed",
};

const RK3568_DEVICE_STATUS_LABELS: Record<Rk3568ServerDeviceState["status"], string> = {
  online: "在线",
  offline: "离线",
  unknown: "未知",
};

const RK3568_DEVICE_STATUS_STYLES: Record<Rk3568ServerDeviceState["status"], string> = {
  online: "border-emerald-300 bg-emerald-50 text-emerald-700",
  offline: "border-zinc-300 bg-zinc-100 text-zinc-600",
  unknown: "border-amber-300 bg-amber-50 text-amber-700",
};

type RkProgressStatus = "pending" | "running" | "success" | "failed";

type RkProgressStep = {
  id: number;
  label: string;
};

const RK_PROGRESS_STEPS: RkProgressStep[] = [
  { id: 1, label: "解析产物" },
  { id: 2, label: "下载产物" },
  { id: 3, label: "解压准备" },
  { id: 4, label: "刷写镜像" },
  { id: 5, label: "执行测试" },
];

const PR_STATE_STYLES: Record<PullRequestItem["state"], string> = {
  open: "state-pr-open",
  closed: "state-pr-closed",
  merged: "state-pr-merged",
};

type ReasonRule = {
  label: string;
  matcher: RegExp;
};

const CHECK_REASON_RULES: ReasonRule[] = [
  { label: "CodeCheck", matcher: /\bcode\s*check\b|\bcodecheck\b/i },
  { label: "BundleCheck", matcher: /\bbundle\s*check\b|\bbundlecheck\b/i },
  { label: "部件依赖Check", matcher: /部件依赖|\bdependency\s*check\b|\bdependencycheck\b/i },
  { label: "XTSCheck", matcher: /\bxts\s*check\b|\bxtscheck\b/i },
];

const COMPILE_TEST_REASON_RULES: ReasonRule[] = [
  { label: "Device", matcher: /\bdevice\b|设备/i },
  { label: "Emulator", matcher: /\bemulator\b|模拟器/i },
];

const SYSTEM_REASON_RULES: ReasonRule[] = [
  { label: "强制终止", matcher: /强制终止|自动中止|任务已中止|任务中止|abort|cancel/i },
  { label: "超时", matcher: /超时|timeout/i },
];

const STATIC_CHECK_CATEGORY_PATTERN = /静态检查|static\s*check/i;
const COMPILE_TEST_CATEGORY_PATTERN = /编译测试|编译与测试|compile\s*(?:and|&)?\s*test|build\s*(?:and|&)?\s*test/i;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripHtml(raw: string): string {
  return decodeHtmlEntities(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatusToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_-]/g, "");
}

function extractFirstTableAfter(raw: string, marker: RegExp): string | undefined {
  const decoded = decodeHtmlEntities(raw);
  const matched = marker.exec(decoded);
  if (!matched || matched.index < 0) {
    return undefined;
  }

  const tail = decoded.slice(matched.index);
  const table = tail.match(/<table[\s\S]*?<\/table>/i);
  return table?.[0];
}

function extractHeaderCells(tableHtml: string): string[] {
  const headerRow = tableHtml.match(/<thead[^>]*>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>[\s\S]*?<\/thead>/i)?.[1]
    || tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i)?.[1]
    || "";

  return Array.from(headerRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi))
    .map((match) => stripHtml(match[1] || ""))
    .filter(Boolean);
}

function extractBodyRows(tableHtml: string): string[][] {
  const tbody = tableHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || tableHtml;
  const rows = Array.from(tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));

  return rows
    .map((row) =>
      Array.from(row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
        .map((cell) => stripHtml(cell[1] || ""))
        .filter(Boolean),
    )
    .filter((cells) => cells.length > 0);
}

function findColumnIndex(headers: string[], patterns: RegExp[], fallback: number): number {
  const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
  return index >= 0 ? index : fallback;
}

function normalizeStaticCheckLabel(value: string): string {
  if (/\bcode\s*check\b|\bcodecheck\b/i.test(value)) return "CodeCheck";
  if (/\bbundle\s*check\b|\bbundlecheck\b/i.test(value)) return "BundleCheck";
  if (/部件依赖|\bdependency\s*check\b|\bdependencycheck\b/i.test(value)) return "部件依赖Check";
  if (/\bxts\s*check\b|\bxtscheck\b/i.test(value)) return "XTSCheck";
  return value.trim();
}

function isStatusFailure(value: string): boolean {
  const raw = value.trim();
  if (!raw) {
    return false;
  }
  const token = normalizeStatusToken(raw);
  if (!token) {
    return false;
  }

  if (/^(pending|running|queued|na|n\/a|--|ignore|ignored|skip|skipped)$/i.test(token)) {
    return false;
  }

  if (/(nopass|notpass|unpass)/i.test(token)) {
    return true;
  }

  return /fail|failed|error|失败|未通过|abort|cancel|中止|终止/i.test(raw);
}

function extractStructuredFailureTags(raw: string): string[] {
  const tags: string[] = [];

  const staticTable = extractFirstTableAfter(raw, STATIC_CHECK_CATEGORY_PATTERN);
  if (staticTable) {
    const headers = extractHeaderCells(staticTable);
    const rows = extractBodyRows(staticTable);
    const checkTypeIndex = findColumnIndex(
      headers,
      [/check\s*type/i, /检查类型|检查项/i],
      1,
    );
    const resultIndex = findColumnIndex(
      headers,
      [/^result$/i, /结果/i],
      2,
    );

    for (const row of rows) {
      const checkTypeRaw = row[checkTypeIndex] || row[1] || "";
      const resultRaw = row[resultIndex] || row[2] || "";
      if (!isStatusFailure(resultRaw)) {
        continue;
      }
      const label = normalizeStaticCheckLabel(checkTypeRaw) || "静态检查";
      tags.push(`静态检查:${label}`);
    }
  }

  const compileTable = extractFirstTableAfter(raw, COMPILE_TEST_CATEGORY_PATTERN);
  if (compileTable) {
    const headers = extractHeaderCells(compileTable);
    const rows = extractBodyRows(compileTable);
    const deviceIndex = findColumnIndex(
      headers,
      [/^device$/i, /设备/i],
      1,
    );
    const resultIndex = findColumnIndex(
      headers,
      [/build\s*result/i, /^result$/i, /编译结果|构建结果|结果/i],
      2,
    );

    for (const row of rows) {
      const device = (row[deviceIndex] || row[1] || "Device").trim();
      const resultRaw = row[resultIndex] || row[2] || "";
      if (!isStatusFailure(resultRaw)) {
        continue;
      }
      tags.push(`编译测试:${device || "Device"}`);
    }
  }

  return Array.from(new Set(tags));
}

function normalizeForRows(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "|")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\u00a0/g, " ");
}

function splitRows(raw: string): string[] {
  return normalizeForRows(raw)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function getResultTokens(line: string): string[] {
  return line
    .split("|")
    .map((token) => token.trim())
    .filter(Boolean);
}

function isPendingOrZero(value: string): boolean {
  return /pending|running|进行中|排队|耗时\s*0|duration\s*[:=]?\s*0|\b0\s*(s|sec|min|m|h|hour)\b/i.test(value);
}

function isFailedValue(value: string): boolean {
  const normalized = normalizeStatusToken(value);
  if (/^(ignore|ignored|skip|skipped)$/i.test(normalized)) {
    return false;
  }
  if (/--/.test(value)) {
    return false;
  }
  if (isPendingOrZero(value)) {
    return false;
  }
  if (/(nopass|notpass|unpass)/i.test(normalized)) {
    return true;
  }
  return /fail|failed|error|失败|未通过|abort|cancel|中止|终止/i.test(value);
}

function isCheckPassLike(value: string): boolean {
  const normalized = normalizeStatusToken(value);
  if (/(nopass|notpass|unpass|fail|failed|error|abort|cancel)/i.test(normalized)) {
    return false;
  }
  if (/--/.test(value)) {
    return true;
  }
  if (isPendingOrZero(value)) {
    return true;
  }
  return /^(pass|passed|success|ok|na|n\/a)$/i.test(normalized) || /通过/i.test(value);
}

function hasFailedToken(tokens: string[]): boolean {
  return tokens.some((token) => isFailedValue(token) && !isCheckPassLike(token));
}

function findStaticCheckFailedTags(rows: string[]): string[] {
  const tags: string[] = [];

  for (const row of rows) {
    const categoryMatched = STATIC_CHECK_CATEGORY_PATTERN.test(row);
    const tokens = getResultTokens(row);
    const failed = hasFailedToken(tokens) || (isFailedValue(row) && !isCheckPassLike(row));

    if (!categoryMatched || !failed) {
      continue;
    }

    const rowMatchedRules = CHECK_REASON_RULES
      .filter((rule) => rule.matcher.test(row))
      .map((rule) => rule.label);

    if (rowMatchedRules.length === 0) {
      tags.push("静态检查");
      continue;
    }

    for (const label of rowMatchedRules) {
      tags.push(`静态检查:${label}`);
    }
  }

  if (tags.length > 0) {
    return Array.from(new Set(tags));
  }

  for (const rule of CHECK_REASON_RULES) {
    let failed = false;

    for (const row of rows) {
      if (!rule.matcher.test(row)) {
        continue;
      }
      const tokens = getResultTokens(row);
      const index = tokens.findIndex((token) => rule.matcher.test(token));
      const candidates = index >= 0 ? tokens.slice(index + 1) : tokens;
      if (hasFailedToken(candidates) || (isFailedValue(row) && !isCheckPassLike(row))) {
        failed = true;
        break;
      }
    }

    if (failed) {
      tags.push(`静态检查:${rule.label}`);
    }
  }

  return Array.from(new Set(tags));
}

function findCompileTestFailedTags(rows: string[]): string[] {
  const tags: string[] = [];

  for (const row of rows) {
    const categoryMatched = COMPILE_TEST_CATEGORY_PATTERN.test(row);
    const tokens = getResultTokens(row);
    const failed = hasFailedToken(tokens) || (isFailedValue(row) && !isCheckPassLike(row));

    if (!categoryMatched || !failed) {
      continue;
    }

    const matchedRules = COMPILE_TEST_REASON_RULES
      .filter((rule) => rule.matcher.test(row))
      .map((rule) => rule.label);

    if (matchedRules.length === 0) {
      tags.push("编译测试");
      continue;
    }

    for (const label of matchedRules) {
      tags.push(`编译测试:${label}`);
    }
  }

  if (tags.length > 0) {
    return Array.from(new Set(tags));
  }

  for (const rule of COMPILE_TEST_REASON_RULES) {
    let failed = false;

    for (const row of rows) {
      if (!rule.matcher.test(row)) {
        continue;
      }
      const tokens = getResultTokens(row);
      const index = tokens.findIndex((token) => rule.matcher.test(token));
      const candidates = index >= 0 ? tokens.slice(index + 1) : tokens;
      if (hasFailedToken(candidates) || hasFailedToken(tokens) || isFailedValue(row)) {
        failed = true;
        break;
      }
    }

    if (failed) {
      tags.push(`编译测试:${rule.label}`);
    }
  }

  return Array.from(new Set(tags));
}

function findSystemReasonTags(text: string): string[] {
  const tags: string[] = [];

  for (const rule of SYSTEM_REASON_RULES) {
    if (rule.matcher.test(text)) {
      tags.push(rule.label);
    }
  }

  return tags;
}

function toReasonFallbackLabel(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  const line = message
    .split(/\r?\n/)
    .find((item) => item.trim())
    ?.trim();

  if (!line) {
    return undefined;
  }

  if (/强制终止|自动中止|任务已中止|任务中止|abort|cancel/i.test(line)) {
    return "强制终止";
  }
  if (/超时|timeout/i.test(line)) {
    return "超时";
  }

  return line.length > 24 ? `${line.slice(0, 24)}...` : line;
}

function extractErrorReasonTags(run: PipelineRun): string[] {
  if (run.status !== "failed") {
    return [];
  }

  const text = [run.resultCommentBody, run.resultMessage, run.triggerCommentBody]
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) {
    return [];
  }

  const rows = splitRows(text);
  const systemTags = findSystemReasonTags(text);
  const structuredTags = extractStructuredFailureTags(text);
  const staticCheckTags = findStaticCheckFailedTags(rows);
  const compileTestTags = findCompileTestFailedTags(rows);
  const all = Array.from(
    new Set([...systemTags, ...structuredTags, ...staticCheckTags, ...compileTestTags]),
  );

  if (all.length > 0) {
    return all;
  }

  const fallback = toReasonFallbackLabel(run.resultMessage || run.resultCommentBody);
  return fallback ? [fallback] : [];
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRepositoryTargetsText(targets: RepositoryTarget[] | undefined): string {
  if (!targets || targets.length === 0) {
    return "";
  }
  return targets.map((item) => `${item.owner}/${item.repo}`).join("\n");
}

function parseRepositoryTargetsText(raw: string): {
  targets: RepositoryTargetInput[];
  invalidItems: string[];
} {
  const items = raw
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const targets: RepositoryTargetInput[] = [];
  const invalidItems: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const slashIndex = item.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= item.length - 1) {
      invalidItems.push(item);
      continue;
    }

    const owner = item.slice(0, slashIndex).trim();
    const repo = item.slice(slashIndex + 1).trim();
    if (!owner || !repo) {
      invalidItems.push(item);
      continue;
    }

    const key = `${owner}/${repo}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({ owner, repo });
  }

  return { targets, invalidItems };
}

function parseRkProgressLog(log: string, totalSteps: number): {
  latestStepIndex: number;
  stepLogs: string[];
} {
  const stepLogs = Array.from({ length: totalSteps }, () => [] as string[]);
  const lines = log ? log.split(/\r?\n/) : [];
  let latestStepIndex = -1;
  let currentStepIndex = 0;

  for (const line of lines) {
    const marker = line.match(/步骤\s*([1-9]\d*)\s*\/\s*([1-9]\d*)[:：]/i);
    if (marker) {
      const stepNo = Number(marker[1]);
      if (Number.isInteger(stepNo) && stepNo >= 1 && stepNo <= totalSteps) {
        currentStepIndex = stepNo - 1;
        latestStepIndex = currentStepIndex;
      }
    }

    if (line.trim()) {
      stepLogs[currentStepIndex]!.push(line);
    }
  }

  return {
    latestStepIndex,
    stepLogs: stepLogs.map((bucket) => bucket.join("\n").trim()),
  };
}

function buildRkProgressStatuses(
  task: Rk3568TestTask | null,
  latestStepIndex: number,
  totalSteps: number,
): RkProgressStatus[] {
  const statuses = Array.from({ length: totalSteps }, () => "pending" as RkProgressStatus);

  if (!task) {
    return statuses;
  }

  if (task.status === "queued") {
    statuses[0] = "running";
    return statuses;
  }

  if (task.status === "running") {
    if (latestStepIndex < 0) {
      statuses[0] = "running";
      return statuses;
    }

    for (let index = 0; index < latestStepIndex; index += 1) {
      statuses[index] = "success";
    }
    statuses[latestStepIndex] = "running";
    return statuses;
  }

  if (task.status === "success") {
    return statuses.map(() => "success");
  }

  if (latestStepIndex < 0) {
    statuses[0] = "failed";
    return statuses;
  }

  for (let index = 0; index < latestStepIndex; index += 1) {
    statuses[index] = "success";
  }
  statuses[latestStepIndex] = "failed";
  return statuses;
}

function normalizeClientError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "请求失败";
  }

  const message = error.message || "";
  const lower = message.toLowerCase();

  if (lower.includes("token not found") || lower.includes("unauthorized")) {
    return "GitCode Token 无效，请在账户设置里检查并更新。";
  }

  if (lower.includes("missing gitcode settings")) {
    return "请先在账户设置中配置 GitCode Token 与仓库列表（owner/repo）。";
  }

  if (lower.includes("owner and repo must")) {
    return "owner 与仓库名需要同时填写。";
  }

  if (
    lower.includes("unknown repository target")
    || lower.includes("invalid target")
    || lower.includes("invalid repository target")
  ) {
    return "仓库目标无效，请检查 owner / 仓库名 输入。";
  }

  if (lower.includes("failed to reach gitcode api") || lower.includes("fetch failed")) {
    return "连接 GitCode API 失败。请检查网络、Token 与账户设置中的仓库信息。";
  }

  return message;
}

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };

  if (response.status === 401 && typeof window !== "undefined") {
    window.location.assign("/auth");
    throw new Error("Unauthorized.");
  }

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload as T;
}

function StatusIcon({ status }: { status: PipelineRunStatus }) {
  if (status === "success") return <CheckCircle2 className="size-3.5" />;
  if (status === "failed") return <XCircle className="size-3.5" />;
  if (status === "running" || status === "triggered") {
    return <Loader2 className="size-3.5 animate-spin" />;
  }
  return <AlertCircle className="size-3.5" />;
}

function RkProgressStatusIcon({ status }: { status: RkProgressStatus }) {
  if (status === "success") return <CheckCircle2 className="size-3.5" />;
  if (status === "failed") return <XCircle className="size-3.5" />;
  if (status === "running") return <Loader2 className="size-3.5 animate-spin" />;
  return <AlertCircle className="size-3.5" />;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildRealtimeWsCandidates(primaryUrl: string): string[] {
  const candidates: string[] = [primaryUrl];

  if (typeof window === "undefined") {
    return uniqueStrings(candidates);
  }

  try {
    const parsed = new URL(primaryUrl);
    const pageHostname = window.location.hostname;
    const pageProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    if (parsed.hostname !== pageHostname) {
      const withPageHost = new URL(parsed.toString());
      withPageHost.hostname = pageHostname;
      candidates.push(withPageHost.toString());
    }

    if (parsed.protocol !== pageProtocol) {
      const withPageProtocol = new URL(parsed.toString());
      withPageProtocol.protocol = pageProtocol;
      candidates.push(withPageProtocol.toString());
    }

    const withHostAndProtocol = new URL(parsed.toString());
    withHostAndProtocol.hostname = pageHostname;
    withHostAndProtocol.protocol = pageProtocol;
    candidates.push(withHostAndProtocol.toString());
  } catch {
    return uniqueStrings(candidates);
  }

  return uniqueStrings(candidates);
}

async function openWebSocketCandidate(url: string, timeoutMs = 2500): Promise<WebSocket | undefined> {
  return await new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);

    const finalize = (result: WebSocket | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      finalize(undefined);
    }, timeoutMs);

    ws.onopen = () => {
      finalize(ws);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      finalize(undefined);
    };

    ws.onclose = () => {
      finalize(undefined);
    };
  });
}

function upsertRkTaskList(tasks: Rk3568TestTask[], task: Rk3568TestTask, limit = 12): Rk3568TestTask[] {
  const next = tasks.filter((item) => item.id !== task.id);
  next.push(task);
  next.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  return next.slice(0, limit);
}

function resolveInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const storedTheme = window.localStorage.getItem("theme");
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

export default function Home() {
  const [filter, setFilter] = React.useState<StateFilter>("open");
  const [themeMode, setThemeMode] = React.useState<ThemeMode>("light");
  const [searchFilters, setSearchFilters] = React.useState<SearchFilters>({
    prNumber: "",
    title: "",
    issue: "",
    author: "",
    owner: "",
    repo: "",
  });
  const [appliedSearchFilters, setAppliedSearchFilters] = React.useState<SearchFilters>({
    prNumber: "",
    title: "",
    issue: "",
    author: "",
    owner: "",
    repo: "",
  });
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(12);

  const [repository, setRepository] = React.useState<{ owner: string; repo: string } | null>(null);
  const [selectedTarget, setSelectedTarget] = React.useState("");
  const [pagination, setPagination] = React.useState({
    page: 1,
    pageSize: 12,
    total: 0,
    totalPages: 1,
  });
  const [prs, setPrs] = React.useState<PullRequestItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [expandedRows, setExpandedRows] = React.useState<Record<number, boolean>>({});
  const [triggeringPrNumber, setTriggeringPrNumber] = React.useState<number | null>(null);
  const [rkDialogOpen, setRkDialogOpen] = React.useState(false);
  const [rkDialogRun, setRkDialogRun] = React.useState<PipelineRun | null>(null);
  const [rkDialogPr, setRkDialogPr] = React.useState<{ number: number; title: string } | null>(null);
  const [rkTestCaseName, setRkTestCaseName] = React.useState("");
  const [rkRequestedDeviceSerial, setRkRequestedDeviceSerial] = React.useState("");
  const [rkClientWsUrl, setRkClientWsUrl] = React.useState("");
  const [rkClients, setRkClients] = React.useState<Rk3568ServerClientState[]>([]);
  const [rkDevices, setRkDevices] = React.useState<Rk3568ServerDeviceState[]>([]);
  const [rkDevicesLoading, setRkDevicesLoading] = React.useState(false);
  const [rkDevicesError, setRkDevicesError] = React.useState<string | null>(null);
  const [rkSubmitting, setRkSubmitting] = React.useState(false);
  const [rkRerunSubmitting, setRkRerunSubmitting] = React.useState(false);
  const [rkTasks, setRkTasks] = React.useState<Rk3568TestTask[]>([]);
  const [rkTasksLoading, setRkTasksLoading] = React.useState(false);
  const [rkSelectedTaskId, setRkSelectedTaskId] = React.useState<string | null>(null);
  const [rkTaskLog, setRkTaskLog] = React.useState("");
  const [rkTaskLogLoading, setRkTaskLogLoading] = React.useState(false);
  const [rkLogVisible, setRkLogVisible] = React.useState(true);
  const [rkSelectedLogStep, setRkSelectedLogStep] = React.useState<"all" | number>("all");
  const [wsConnected, setWsConnected] = React.useState(false);
  const [currentUsername, setCurrentUsername] = React.useState("");
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsSaving, setSettingsSaving] = React.useState(false);
  const [settingsError, setSettingsError] = React.useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = React.useState({
    gitcodeToken: "",
    repositoryTargetsText: "",
  });
  const rkLastConsoleLogRef = React.useRef("");
  const rkLogPreRef = React.useRef<HTMLPreElement | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const wsReconnectTimerRef = React.useRef<number | null>(null);
  const wsRefreshAtRef = React.useRef(0);
  const viewStateRef = React.useRef({
    filter: "open" as StateFilter,
    requestFilters: {
      prNumber: "",
      title: "",
      issue: "",
      author: "",
      owner: "",
      repo: "",
    },
    page: 1,
    pageSize: 12,
    selectedTarget: "",
    rkDialogOpen: false,
    rkDialogPrNumber: undefined as number | undefined,
    rkDialogPipelineUrl: undefined as string | undefined,
    rkSelectedTaskId: undefined as string | undefined,
  });

  const requestFilters = React.useMemo(
    () => ({
      prNumber: appliedSearchFilters.prNumber.trim(),
      title: appliedSearchFilters.title.trim(),
      issue: appliedSearchFilters.issue.trim(),
      author: appliedSearchFilters.author.trim(),
      owner: appliedSearchFilters.owner.trim(),
      repo: appliedSearchFilters.repo.trim(),
    }),
    [appliedSearchFilters],
  );

  const rkSelectedTask = React.useMemo(() => {
    if (!rkSelectedTaskId) {
      return null;
    }
    return rkTasks.find((task) => task.id === rkSelectedTaskId) || null;
  }, [rkSelectedTaskId, rkTasks]);

  const rkOnlineDevices = React.useMemo(
    () => rkDevices.filter((device) => device.status === "online"),
    [rkDevices],
  );

  const rkAvailableDevices = React.useMemo(
    () => rkDevices.filter((device) => device.status === "online" && !device.occupiedByTaskId),
    [rkDevices],
  );

  const rkSelectedDeviceState = React.useMemo(() => {
    if (!rkRequestedDeviceSerial) {
      return null;
    }
    return rkDevices.find((device) => device.serial === rkRequestedDeviceSerial) || null;
  }, [rkDevices, rkRequestedDeviceSerial]);

  const canRerunSelectedTask = Boolean(
    rkSelectedTask
      && rkSelectedTask.status !== "running"
      && rkSelectedTask.status !== "queued",
  );

  const rkProgressLog = React.useMemo(
    () => parseRkProgressLog(rkTaskLog, RK_PROGRESS_STEPS.length),
    [rkTaskLog],
  );

  const rkProgressStatuses = React.useMemo(
    () => buildRkProgressStatuses(rkSelectedTask, rkProgressLog.latestStepIndex, RK_PROGRESS_STEPS.length),
    [rkProgressLog.latestStepIndex, rkSelectedTask],
  );

  const rkDisplayedLog = React.useMemo(() => {
    if (!rkLogVisible) {
      return "";
    }
    if (rkSelectedLogStep === "all") {
      return rkTaskLog;
    }
    return rkProgressLog.stepLogs[rkSelectedLogStep] || "";
  }, [rkLogVisible, rkProgressLog.stepLogs, rkSelectedLogStep, rkTaskLog]);

  React.useEffect(() => {
    const initialTheme = resolveInitialTheme();
    document.documentElement.classList.toggle("dark", initialTheme === "dark");
    setThemeMode(initialTheme);
  }, []);

  const handleToggleTheme = React.useCallback(() => {
    setThemeMode((current) => {
      const nextTheme: ThemeMode = current === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", nextTheme === "dark");
      window.localStorage.setItem("theme", nextTheme);
      return nextTheme;
    });
  }, []);

  const handleLogout = React.useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/auth");
    }
  }, []);

  const loadAccountSettings = React.useCallback(async () => {
    const payload = await fetchJson<AccountSettingsResponse>("/api/account/settings");
    if (!payload.hasSettings || !payload.settings) {
      setSettingsDraft({
        gitcodeToken: "",
        repositoryTargetsText: "",
      });
      return;
    }

    const defaultTarget = payload.settings.repositoryTargets[0];
    setSettingsDraft({
      gitcodeToken: payload.settings.gitcodeToken,
      repositoryTargetsText: formatRepositoryTargetsText(payload.settings.repositoryTargets),
    });

    setSearchFilters((current) => {
      if (current.owner || current.repo || !defaultTarget) {
        return current;
      }
      return {
        ...current,
        owner: defaultTarget.owner,
        repo: defaultTarget.repo,
      };
    });
    setAppliedSearchFilters((current) => {
      if (current.owner || current.repo || !defaultTarget) {
        return current;
      }
      return {
        ...current,
        owner: defaultTarget.owner,
        repo: defaultTarget.repo,
      };
    });
  }, []);

  React.useEffect(() => {
    let active = true;

    const loadSession = async () => {
      try {
        const response = await fetch("/api/auth/session", { method: "GET" });
        const payload = (await response.json().catch(() => ({}))) as SessionResponse;

        if (!active) {
          return;
        }

        if (!response.ok || !payload.authenticated || !payload.user) {
          window.location.assign("/auth");
          return;
        }

        const username = payload.user.username;
        setCurrentUsername(username);
        setSearchFilters((current) => {
          if (current.author.trim()) {
            return current;
          }
          return {
            ...current,
            author: username,
          };
        });
        setAppliedSearchFilters((current) => {
          if (current.author.trim()) {
            return current;
          }
          return {
            ...current,
            author: username,
          };
        });
        await loadAccountSettings();
      } catch {
        if (active) {
          window.location.assign("/auth");
        }
      }
    };

    void loadSession();
    return () => {
      active = false;
    };
  }, [loadAccountSettings]);

  const handleApplySearch = React.useCallback(() => {
    setAppliedSearchFilters({
      prNumber: searchFilters.prNumber,
      title: searchFilters.title,
      issue: searchFilters.issue,
      author: searchFilters.author,
      owner: searchFilters.owner,
      repo: searchFilters.repo,
    });
    setPage(1);
  }, [searchFilters]);

  const handleOpenSettings = React.useCallback(() => {
    setSettingsError(null);
    setSettingsOpen(true);
  }, []);

  const handleSaveSettings = React.useCallback(async () => {
    setSettingsError(null);
    const gitcodeToken = settingsDraft.gitcodeToken.trim();
    const parsedTargets = parseRepositoryTargetsText(settingsDraft.repositoryTargetsText);

    if (!gitcodeToken) {
      setSettingsError("请填写 GitCode Token。");
      return;
    }
    if (parsedTargets.invalidItems.length > 0) {
      const sample = parsedTargets.invalidItems.slice(0, 3).join("、");
      setSettingsError(`仓库列表格式错误：${sample}。请使用 owner/repo 格式，一行一个。`);
      return;
    }
    if (parsedTargets.targets.length === 0) {
      setSettingsError("请至少填写一个仓库，格式为 owner/repo。");
      return;
    }

    setSettingsSaving(true);
    try {
      const payload = await fetchJson<SaveAccountSettingsResponse>("/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          gitcodeToken,
          repositoryTargets: parsedTargets.targets,
        }),
      });

      const defaultTarget = payload.settings.repositoryTargets[0];
      setSettingsDraft({
        gitcodeToken: payload.settings.gitcodeToken,
        repositoryTargetsText: formatRepositoryTargetsText(payload.settings.repositoryTargets),
      });

      setSearchFilters((current) => ({
        ...current,
        owner: defaultTarget?.owner || "",
        repo: defaultTarget?.repo || "",
      }));
      setAppliedSearchFilters((current) => ({
        ...current,
        owner: defaultTarget?.owner || "",
        repo: defaultTarget?.repo || "",
      }));
      setExpandedRows({});
      setPage(1);
      setSettingsOpen(false);
      setNotice("账户设置已保存");
    } catch (saveError) {
      setSettingsError(normalizeClientError(saveError));
    } finally {
      setSettingsSaving(false);
    }
  }, [settingsDraft.gitcodeToken, settingsDraft.repositoryTargetsText]);

  const handleSearchInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      handleApplySearch();
    },
    [handleApplySearch],
  );

  React.useEffect(() => {
    viewStateRef.current = {
      filter,
      requestFilters: {
        prNumber: requestFilters.prNumber,
        title: requestFilters.title,
        issue: requestFilters.issue,
        author: requestFilters.author,
        owner: requestFilters.owner,
        repo: requestFilters.repo,
      },
      page,
      pageSize,
      selectedTarget,
      rkDialogOpen,
      rkDialogPrNumber: rkDialogPr?.number,
      rkDialogPipelineUrl: rkDialogRun?.pipelineUrl,
      rkSelectedTaskId: rkSelectedTaskId || undefined,
    };
  }, [
    filter,
    requestFilters.author,
    requestFilters.issue,
    requestFilters.owner,
    requestFilters.prNumber,
    requestFilters.repo,
    requestFilters.title,
    page,
    pageSize,
    selectedTarget,
    rkDialogOpen,
    rkDialogPr?.number,
    rkDialogRun?.pipelineUrl,
    rkSelectedTaskId,
  ]);

  const loadData = React.useCallback(
    async (params: {
      state: StateFilter;
      filters: SearchFilters;
      targetPage: number;
      targetPageSize: number;
      target: string;
    }) => {
      const query = new URLSearchParams({
        state: params.state,
        prNumber: params.filters.prNumber,
        title: params.filters.title,
        issue: params.filters.issue,
        author: params.filters.author,
        owner: params.filters.owner,
        repo: params.filters.repo,
        page: String(params.targetPage),
        pageSize: String(params.targetPageSize),
      });
      const hasOwnerRepo = Boolean(params.filters.owner.trim() && params.filters.repo.trim());
      if (params.target.trim() && !hasOwnerRepo) {
        query.set("target", params.target.trim());
      }

      const payload = await fetchJson<PullRequestListResponse>(`/api/prs?${query.toString()}`);

      setRepository(payload.repository);
      setSelectedTarget((current) => (current === payload.selectedTarget ? current : payload.selectedTarget));
      setPagination(payload.pagination);
      setPrs(payload.prs);
    },
    [],
  );

  React.useEffect(() => {
    setLoading(true);
    setError(null);

    loadData({
      state: filter,
      filters: requestFilters,
      targetPage: page,
      targetPageSize: pageSize,
      target: selectedTarget,
    })
      .catch((loadError) => {
        setError(normalizeClientError(loadError));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [filter, requestFilters, page, pageSize, selectedTarget, loadData]);

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadRkDevices = React.useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setRkDevicesLoading(true);
      }
      try {
        const payload = await fetchJson<Rk3568DevicesResponse>("/api/rk3568-devices");
        const clients = payload.clients || [];
        const devices = payload.devices || [];
        setRkClientWsUrl(payload.clientWsUrl || "");
        setRkClients(clients);
        setRkDevices(devices);
        setRkDevicesError(null);
        setRkRequestedDeviceSerial((current) => {
          if (!current) {
            return "";
          }
          const found = devices.find((device) => device.serial === current);
          if (!found || found.status !== "online" || found.occupiedByTaskId) {
            return "";
          }
          return current;
        });
      } catch (loadError) {
        setRkDevicesError(normalizeClientError(loadError));
        if (!options?.silent) {
          setRkClients([]);
          setRkDevices([]);
        }
      } finally {
        if (!options?.silent) {
          setRkDevicesLoading(false);
        }
      }
    },
    [],
  );

  const loadRkTasks = React.useCallback(
    async (params: { prNumber: number; pipelineUrl?: string }) => {
      const query = new URLSearchParams({
        prNumber: String(params.prNumber),
        limit: "12",
      });
      if (selectedTarget.trim()) {
        query.set("target", selectedTarget.trim());
      }
      const pipelineUrl = params.pipelineUrl?.trim();
      if (pipelineUrl) {
        query.set("pipelineUrl", pipelineUrl);
      }

      const payload = await fetchJson<Rk3568TasksResponse>(`/api/rk3568-tests?${query.toString()}`);
      const tasks = payload.tasks || [];
      setRkTasks(tasks);
      setRkSelectedTaskId((current) => {
        if (current && tasks.some((task) => task.id === current)) {
          return current;
        }
        return tasks[0]?.id || null;
      });
    },
    [selectedTarget],
  );

  React.useEffect(() => {
    if (!rkDialogOpen) {
      return;
    }

    let active = true;
    const load = async (options?: { silent?: boolean }) => {
      if (!active) {
        return;
      }
      await loadRkDevices(options);
    };

    void load();
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadRkDevices, rkDialogOpen]);

  React.useEffect(() => {
    if (!rkDialogOpen || !rkDialogPr?.number) {
      return;
    }

    let active = true;
    const load = async () => {
      setRkTasksLoading(true);
      try {
        await loadRkTasks({
          prNumber: rkDialogPr.number,
          pipelineUrl: rkDialogRun?.pipelineUrl,
        });
      } catch {
        if (active) {
          setRkTasks([]);
          setRkSelectedTaskId(null);
        }
      } finally {
        if (active) {
          setRkTasksLoading(false);
        }
      }
    };

    void load();
    const fallbackTimer = !wsConnected
      ? window.setInterval(() => {
        void load();
      }, 5000)
      : null;

    return () => {
      active = false;
      if (fallbackTimer) {
        window.clearInterval(fallbackTimer);
      }
    };
  }, [rkDialogOpen, rkDialogPr?.number, rkDialogRun?.pipelineUrl, loadRkTasks, wsConnected]);

  React.useEffect(() => {
    if (!rkDialogOpen || !rkSelectedTaskId) {
      setRkTaskLog("");
      rkLastConsoleLogRef.current = "";
      return;
    }

    let active = true;
    const loadLog = async () => {
      setRkTaskLogLoading(true);
      try {
        const payload = await fetchJson<Rk3568TaskDetailResponse>(
          `/api/rk3568-tests/${rkSelectedTaskId}?includeLog=1&fullLog=1`,
        );
        if (active) {
          const nextLog = payload.log || "";
          setRkTaskLog(nextLog);
          if (nextLog) {
            const prevLog = rkLastConsoleLogRef.current;
            const appended = prevLog && nextLog.startsWith(prevLog)
              ? nextLog.slice(prevLog.length)
              : nextLog;
            const lines = appended
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            for (const line of lines) {
              console.log(`[RK3568][${rkSelectedTaskId.slice(0, 8)}] ${line}`);
            }
            rkLastConsoleLogRef.current = nextLog;
          }
        }
      } catch {
        if (active) {
          setRkTaskLog("");
          rkLastConsoleLogRef.current = "";
        }
      } finally {
        if (active) {
          setRkTaskLogLoading(false);
        }
      }
    };

    void loadLog();
    const fallbackTimer = !wsConnected
      ? window.setInterval(() => {
        void loadLog();
      }, 4000)
      : null;

    return () => {
      active = false;
      if (fallbackTimer) {
        window.clearInterval(fallbackTimer);
      }
    };
  }, [rkDialogOpen, rkSelectedTaskId, wsConnected]);

  React.useEffect(() => {
    setRkSelectedLogStep("all");
  }, [rkSelectedTaskId]);

  React.useEffect(() => {
    const pre = rkLogPreRef.current;
    if (!pre || !rkLogVisible) {
      return;
    }
    pre.scrollTop = pre.scrollHeight;
  }, [rkDisplayedLog, rkLogVisible]);

  const refreshPrDataFromRealtime = React.useCallback(() => {
    const current = viewStateRef.current;
    const now = Date.now();
    if (now - wsRefreshAtRef.current < 1200) {
      return;
    }
    wsRefreshAtRef.current = now;

    void loadData({
      state: current.filter,
      filters: current.requestFilters,
      targetPage: current.page,
      targetPageSize: current.pageSize,
      target: current.selectedTarget,
    }).catch((loadError) => {
      setError(normalizeClientError(loadError));
    });
  }, [loadData]);

  const handleRealtimeMessage = React.useCallback(
    (raw: string) => {
      let message: RealtimeServerMessage | undefined;
      try {
        message = JSON.parse(raw) as RealtimeServerMessage;
      } catch {
        return;
      }
      if (!message) {
        return;
      }

      if (message.type === "prs-updated") {
        const currentTarget = viewStateRef.current.selectedTarget.trim();
        if (currentTarget && currentTarget !== message.target) {
          return;
        }
        refreshPrDataFromRealtime();
        return;
      }

      if (message.type === "rk-task-updated") {
        const current = viewStateRef.current;
        if (!current.rkDialogOpen || !current.rkDialogPrNumber) {
          return;
        }
        if (message.task.prNumber !== current.rkDialogPrNumber) {
          return;
        }
        const currentTarget = current.selectedTarget.trim();
        if (currentTarget && currentTarget !== message.target) {
          return;
        }
        const currentPipelineUrl = current.rkDialogPipelineUrl?.trim();
        if (currentPipelineUrl && message.task.pipelineUrl !== currentPipelineUrl) {
          return;
        }

        setRkTasks((tasks) => upsertRkTaskList(tasks, message.task, 12));
        setRkSelectedTaskId((taskId) => taskId || message.task.id);
        return;
      }

      if (message.type === "rk-task-log") {
        const currentTaskId = viewStateRef.current.rkSelectedTaskId;
        if (!currentTaskId || currentTaskId !== message.taskId) {
          return;
        }

        const formattedLine = `[${message.at}] ${message.line}`;
        setRkTaskLog((current) => {
          const next = current ? `${current}\n${formattedLine}` : formattedLine;
          rkLastConsoleLogRef.current = next;
          return next;
        });
        if (message.isError) {
          console.error(`[RK3568][${message.taskId.slice(0, 8)}] ${message.line}`);
        } else {
          console.log(`[RK3568][${message.taskId.slice(0, 8)}] ${message.line}`);
        }
      }
    },
    [refreshPrDataFromRealtime],
  );

  const sendRealtimeSubscriptions = React.useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const current = viewStateRef.current;
    ws.send(
      JSON.stringify({
        type: "subscribe-prs",
        target: current.selectedTarget.trim() || undefined,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "subscribe-rk-pr",
        target: current.selectedTarget.trim() || undefined,
        prNumber: current.rkDialogOpen ? current.rkDialogPrNumber : undefined,
        pipelineUrl: current.rkDialogOpen ? current.rkDialogPipelineUrl : undefined,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "subscribe-rk-task",
        taskId: current.rkDialogOpen ? current.rkSelectedTaskId : undefined,
      }),
    );
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    const scheduleReconnect = () => {
      if (cancelled || wsReconnectTimerRef.current !== null) {
        return;
      }
      wsReconnectTimerRef.current = window.setTimeout(() => {
        wsReconnectTimerRef.current = null;
        void connectRealtime();
      }, 2200);
    };

    const connectRealtime = async () => {
      try {
        const config = await fetchJson<RealtimeConfigResponse>("/api/realtime/ws");
        if (cancelled) {
          return;
        }

        const candidates = buildRealtimeWsCandidates(config.url);
        let connectedWs: WebSocket | undefined;
        for (const candidate of candidates) {
          if (cancelled) {
            return;
          }
          const ws = await openWebSocketCandidate(candidate, 3000);
          if (ws) {
            connectedWs = ws;
            if (candidate !== config.url) {
              console.info(`[realtime] fallback ws connected: ${candidate}`);
            }
            break;
          }
        }

        if (!connectedWs) {
          if (!cancelled) {
            setWsConnected(false);
            scheduleReconnect();
          }
          return;
        }

        const ws = connectedWs;
        wsRef.current = ws;
        setWsConnected(true);
        sendRealtimeSubscriptions();

        ws.onmessage = (event) => {
          if (typeof event.data === "string") {
            handleRealtimeMessage(event.data);
            return;
          }

          if (event.data instanceof Blob) {
            void event.data.text().then((text) => {
              handleRealtimeMessage(text);
            });
            return;
          }

          const text = String(event.data || "");
          if (text) {
            handleRealtimeMessage(text);
          }
        };

        ws.onerror = () => {
          ws.close();
        };

        ws.onclose = () => {
          setWsConnected(false);
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
          if (!cancelled) {
            scheduleReconnect();
          }
        };
      } catch {
        setWsConnected(false);
        if (!cancelled) {
          scheduleReconnect();
        }
      }
    };

    void connectRealtime();

    return () => {
      cancelled = true;
      if (wsReconnectTimerRef.current !== null) {
        window.clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      setWsConnected(false);
    };
  }, [handleRealtimeMessage, sendRealtimeSubscriptions]);

  React.useEffect(() => {
    if (wsConnected) {
      return;
    }
    const timer = window.setInterval(() => {
      const current = viewStateRef.current;
      void loadData({
        state: current.filter,
        filters: current.requestFilters,
        targetPage: current.page,
        targetPageSize: current.pageSize,
        target: current.selectedTarget,
      }).catch(() => {
        // keep silent on background fallback refresh
      });
    }, 8000);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadData, wsConnected]);

  React.useEffect(() => {
    sendRealtimeSubscriptions();
  }, [selectedTarget, rkDialogOpen, rkDialogPr?.number, rkDialogRun?.pipelineUrl, rkSelectedTaskId, sendRealtimeSubscriptions]);

  const openRkDialog = React.useCallback((run: PipelineRun, pr: PullRequestItem) => {
    setRkDialogRun(run);
    setRkDialogPr({
      number: pr.number,
      title: pr.title,
    });
    setRkTestCaseName("");
    setRkRequestedDeviceSerial("");
    setRkDevicesError(null);
    setRkTasks([]);
    setRkSelectedTaskId(null);
    setRkTaskLog("");
    setRkSelectedLogStep("all");
    setRkLogVisible(true);
    rkLastConsoleLogRef.current = "";
    setRkDialogOpen(true);
  }, []);

  const closeRkDialog = React.useCallback(() => {
    setRkDialogOpen(false);
    setRkDialogRun(null);
    setRkDialogPr(null);
    setRkTestCaseName("");
    setRkRequestedDeviceSerial("");
    setRkClientWsUrl("");
    setRkClients([]);
    setRkDevices([]);
    setRkDevicesLoading(false);
    setRkDevicesError(null);
    setRkTasks([]);
    setRkSelectedTaskId(null);
    setRkTaskLog("");
    setRkSelectedLogStep("all");
    setRkLogVisible(true);
    rkLastConsoleLogRef.current = "";
  }, []);

  const handleRefresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadData({
        state: filter,
        filters: requestFilters,
        targetPage: page,
        targetPageSize: pageSize,
        target: selectedTarget,
      });
      setNotice("已刷新数据");
    } catch (refreshError) {
      setError(normalizeClientError(refreshError));
    } finally {
      setLoading(false);
    }
  }, [filter, loadData, page, pageSize, requestFilters, selectedTarget]);

  const handleTrigger = React.useCallback(
    async (prNumber: number) => {
      setTriggeringPrNumber(prNumber);
      setError(null);

      try {
        await fetchJson(`/api/prs/${prNumber}/trigger`, {
          method: "POST",
          body: JSON.stringify({
            commentBody: "start build",
            target: selectedTarget || undefined,
            owner: repository?.owner || requestFilters.owner || undefined,
            repo: repository?.repo || requestFilters.repo || undefined,
          }),
        });
        await loadData({
          state: filter,
          filters: requestFilters,
          targetPage: page,
          targetPageSize: pageSize,
          target: selectedTarget,
        });
        setExpandedRows((current) => ({ ...current, [prNumber]: true }));
        setNotice(`PR #${prNumber} 已触发流水线`);
      } catch (triggerError) {
        setError(normalizeClientError(triggerError));
      } finally {
        setTriggeringPrNumber(null);
      }
    },
    [filter, loadData, page, pageSize, repository?.owner, repository?.repo, requestFilters, selectedTarget],
  );

  const handleStartRk3568 = React.useCallback(async () => {
    if (!rkDialogRun?.pipelineUrl || !rkDialogPr || !repository) {
      setError("缺少必要信息，无法启动 RK3568 测试。");
      return;
    }

    const selectedSerial = rkRequestedDeviceSerial.trim();
    if (selectedSerial) {
      const selectedDevice = rkDevices.find((device) => device.serial === selectedSerial);
      if (!selectedDevice) {
        setError("所选设备不存在，请刷新设备列表后重试。");
        return;
      }
      if (selectedDevice.status !== "online" || selectedDevice.occupiedByTaskId) {
        setError("所选设备当前不可用，请重新选择可用设备。");
        return;
      }
    }

    setRkSubmitting(true);
    setError(null);

    try {
      const payload = await fetchJson<Rk3568CreateResponse>("/api/rk3568-tests", {
        method: "POST",
        body: JSON.stringify({
          runId: rkDialogRun.id,
          pipelineUrl: rkDialogRun.pipelineUrl,
          prNumber: rkDialogPr.number,
          repositoryOwner: repository.owner,
          repositoryName: repository.repo,
          testType: "tdd",
          testCaseName: rkTestCaseName.trim() || undefined,
          requestedDeviceSerial: selectedSerial || undefined,
        }),
      });

      await loadRkTasks({
        prNumber: rkDialogPr.number,
        pipelineUrl: rkDialogRun?.pipelineUrl,
      });
      setRkSelectedTaskId(payload.task.id);
      setNotice(`RK3568 测试任务已创建：${payload.task.id.slice(0, 8)}`);
    } catch (startError) {
      setError(normalizeClientError(startError));
    } finally {
      setRkSubmitting(false);
    }
  }, [loadRkTasks, repository, rkDialogPr, rkDialogRun, rkDevices, rkRequestedDeviceSerial, rkTestCaseName]);

  const handleRkRerun = React.useCallback(async () => {
    if (!rkSelectedTask || !rkDialogPr) {
      setError("请选择要重跑的 RK3568 任务。");
      return;
    }

    setRkRerunSubmitting(true);
    setError(null);

    try {
      const payload = await fetchJson<Rk3568RerunResponse>(
        `/api/rk3568-tests/${rkSelectedTask.id}/rerun`,
        { method: "POST" },
      );
      await loadRkTasks({
        prNumber: rkDialogPr.number,
        pipelineUrl: rkDialogRun?.pipelineUrl || rkSelectedTask.pipelineUrl,
      });
      setRkSelectedTaskId(payload.task.id);
      setRkSelectedLogStep("all");
      setRkLogVisible(true);
      setNotice(`已重新创建 RK3568 任务：${payload.task.id.slice(0, 8)}`);
    } catch (rerunError) {
      setError(normalizeClientError(rerunError));
    } finally {
      setRkRerunSubmitting(false);
    }
  }, [loadRkTasks, rkDialogPr, rkDialogRun, rkSelectedTask]);

  const hasPrevPage = pagination.page > 1;
  const hasNextPage = pagination.page < pagination.totalPages;
  const themeToggleLabel = themeMode === "dark" ? "切换到浅色主题" : "切换到深色主题";

  return (
    <div className="h-screen w-full bg-muted/40">
      <main className="flex h-full w-full min-w-0 flex-col gap-3 p-3 lg:min-h-0 lg:overflow-hidden lg:p-4">
          <header className="rounded-lg border border-border bg-card p-4 shadow-sm lg:sticky lg:top-0 lg:z-20">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-2xl font-semibold leading-none text-foreground">PR & Build History</p>
                <p className="mt-1 text-sm text-muted-foreground">{repository ? `${repository.owner} / ${repository.repo}` : "未配置仓库"}</p>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground">
                  共{" "}
                  <span className="font-semibold text-primary tabular-nums">{pagination.total}</span>{" "}
                  条
                </span>

                <Button
                  type="button"
                  onClick={handleToggleTheme}
                  title={themeToggleLabel}
                  aria-label={themeToggleLabel}
                  className="inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition hover:bg-muted"
                >
                  {themeMode === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  <span className="hidden text-xs sm:inline">{themeMode === "dark" ? "浅色" : "深色"}</span>
                </Button>

                <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-2.5">
                  <span className="relative inline-flex">
                    <Bell className="text-muted-foreground size-4" />
                    <span className="absolute -right-1 -top-1 inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  <UserCircle2 className="size-5 text-muted-foreground" />
                  <span className="max-w-[140px] truncate text-xs text-muted-foreground">
                    {currentUsername || "加载中..."}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleOpenSettings}
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    账户设置
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleLogout}
                    className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <LogOut className="size-3.5" />
                    退出
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
              <select
                value={filter}
                onChange={(event) => {
                  const next = event.target.value as StateFilter;
                  if (next === "open" || next === "closed" || next === "all") {
                    setFilter(next);
                    setPage(1);
                  }
                }}
                className="h-9 w-[120px] rounded-md border border-input bg-background px-2 text-sm text-foreground"
              >
                <option value="open">open</option>
                <option value="closed">close</option>
                <option value="all">all</option>
              </select>

              <div className="relative w-[140px]">
                <Search className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
                <input
                  value={searchFilters.prNumber}
                  onChange={(event) => {
                    setSearchFilters((current) => ({ ...current, prNumber: event.target.value }));
                  }}
                  onKeyDown={handleSearchInputKeyDown}
                  placeholder="PR号"
                  className="h-9 w-full rounded-md border border-input bg-background pl-7 pr-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                />
              </div>

              <input
                value={searchFilters.issue}
                onChange={(event) => {
                  setSearchFilters((current) => ({ ...current, issue: event.target.value }));
                }}
                onKeyDown={handleSearchInputKeyDown}
                placeholder="ISSUE号"
                className="h-9 w-[140px] rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
              />

              <input
                value={searchFilters.author}
                onChange={(event) => {
                  setSearchFilters((current) => ({ ...current, author: event.target.value }));
                }}
                onKeyDown={handleSearchInputKeyDown}
                placeholder="作者"
                className="h-9 w-[160px] rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
              />

              <input
                value={searchFilters.owner}
                onChange={(event) => {
                  setSearchFilters((current) => ({ ...current, owner: event.target.value }));
                }}
                onKeyDown={handleSearchInputKeyDown}
                placeholder="owner"
                className="h-9 w-[150px] rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
              />

              <input
                value={searchFilters.repo}
                onChange={(event) => {
                  setSearchFilters((current) => ({ ...current, repo: event.target.value }));
                }}
                onKeyDown={handleSearchInputKeyDown}
                placeholder="仓库名"
                className="h-9 w-[180px] rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
              />

              <Button
                type="button"
                onClick={handleRefresh}
                className="inline-flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition hover:bg-muted"
              >
                <RefreshCw className="size-3.5" />
                刷新
              </Button>

              <Button
                type="button"
                onClick={handleApplySearch}
                className="inline-flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                <Search className="size-3.5" />
                搜索
              </Button>
            </div>
          </header>

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {notice && (
            <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
              {notice}
            </div>
          )}

          <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card p-2.5 shadow-sm">
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/70 bg-background">
              <Table className="min-w-[1200px] table-fixed text-base">
                <colgroup>
                  <col className="w-[70px]" />
                  <col className="w-[360px]" />
                  <col className="w-[110px]" />
                  <col className="w-[130px]" />
                  <col className="w-[120px]" />
                  <col className="w-[100px]" />
                  <col className="w-[110px]" />
                  <col className="w-[170px]" />
                  <col className="w-[90px]" />
                </colgroup>
                <TableHeader className="bg-muted/70 sticky top-0 z-10 backdrop-blur-sm">
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="px-2 text-base font-semibold text-foreground">PR</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">标题</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">ISSUE</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">更新时间</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">作者</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">PR 状态</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">构建状态</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">操作</TableHead>
                    <TableHead className="px-2 text-base font-semibold text-foreground">历史</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={9} className="px-2 py-3 text-base text-muted-foreground">
                        加载中...
                      </TableCell>
                    </TableRow>
                  )}

                  {!loading && prs.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={9} className="px-2 py-3 text-base text-muted-foreground">
                        没有匹配的 PR。
                      </TableCell>
                    </TableRow>
                  )}

                  {!loading &&
                    prs.map((pr) => {
                      const latestStatus = pr.latestRun?.status || "unknown";
                      const isExpanded = Boolean(expandedRows[pr.number]);

                      return (
                        <React.Fragment key={pr.id}>
                          <TableRow className="border-border/60 text-base hover:bg-muted/50">
                            <TableCell className="px-2 py-2">
                              <a
                                href={pr.html_url}
                                target="_blank"
                                rel="noreferrer"
                                className="font-medium text-primary hover:text-primary/80"
                              >
                                #{pr.number}
                              </a>
                            </TableCell>

                            <TableCell className="px-2 py-2">
                              <a
                                href={pr.html_url}
                                target="_blank"
                                rel="noreferrer"
                                className="block truncate text-foreground hover:text-primary"
                                title={pr.title}
                              >
                                {pr.title}
                              </a>
                            </TableCell>

                            <TableCell className="px-2 py-2 text-muted-foreground">
                              {pr.issueNumber ? `#${pr.issueNumber}` : "-"}
                            </TableCell>
                            <TableCell className="px-2 py-2 text-muted-foreground">{formatDate(pr.updated_at)}</TableCell>
                            <TableCell className="px-2 py-2">
                              <span className="block truncate text-muted-foreground">{pr.user.name || pr.user.login}</span>
                            </TableCell>

                            <TableCell className="px-2 py-2">
                              <span
                                className={cn(
                                  "inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-base font-medium",
                                  PR_STATE_STYLES[pr.state],
                                )}
                              >
                                {pr.state}
                              </span>
                            </TableCell>

                            <TableCell className="px-2 py-2">
                              <span
                                className={cn(
                                  "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-base font-medium",
                                  RUN_STATUS_STYLES[latestStatus],
                                )}
                              >
                                <StatusIcon status={latestStatus} />
                                {RUN_STATUS_LABELS[latestStatus]}
                              </span>
                            </TableCell>

                            <TableCell className="px-2 py-2">
                              <Button
                                type="button"
                                onClick={() => handleTrigger(pr.number)}
                                disabled={triggeringPrNumber === pr.number}
                                className="inline-flex w-fit items-center gap-1 rounded-md bg-primary px-2 py-1 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                              >
                                {triggeringPrNumber === pr.number ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Play className="size-3.5" />
                                )}
                                start build
                              </Button>
                            </TableCell>

                            <TableCell className="px-2 py-2">
                              <Button
                                type="button"
                                onClick={() =>
                                  setExpandedRows((current) => ({
                                    ...current,
                                    [pr.number]: !current[pr.number],
                                  }))
                                }
                                className="rounded-md border border-border bg-background px-2 py-1 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                              >
                                {isExpanded ? "收起" : `历史(${pr.runCount})`}
                              </Button>
                            </TableCell>
                          </TableRow>

                          {isExpanded && (
                            <TableRow className="border-border/60 hover:bg-transparent">
                              <TableCell colSpan={9} className="p-0">
                                <div className="mx-2 mb-2 rounded-md border border-border bg-muted/30">
                                  <div className="grid grid-cols-[130px_110px_110px_minmax(240px,1fr)_280px] items-center gap-2 border-b border-border px-2 py-1.5 text-base font-semibold text-muted-foreground">
                                    <span>触发时间</span>
                                    <span>触发人</span>
                                    <span>状态</span>
                                    <span>结果</span>
                                    <span>流水线URL</span>
                                  </div>

                                  {pr.runs.length === 0 && (
                                    <div className="px-2 py-2 text-base text-muted-foreground">暂无构建历史。</div>
                                  )}

                                  {pr.runs.map((run) => {
                                    const errorTags = extractErrorReasonTags(run);
                                    return (
                                      <div
                                        key={run.id}
                                        className="grid grid-cols-[130px_110px_110px_minmax(240px,1fr)_280px] items-center gap-2 border-b border-border/60 px-2 py-1.5 text-base last:border-b-0"
                                      >
                                        <span className="text-muted-foreground">{formatDate(run.triggeredAt)}</span>
                                        <span className="truncate text-muted-foreground">{run.triggeredBy}</span>
                                        <span
                                          className={cn(
                                            "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-sm font-medium",
                                            RUN_STATUS_STYLES[run.status],
                                          )}
                                        >
                                          <StatusIcon status={run.status} />
                                          {RUN_STATUS_LABELS[run.status]}
                                        </span>
                                        <div
                                          className="flex min-h-6 flex-wrap items-center gap-1"
                                          title={run.resultMessage || run.triggerCommentBody}
                                        >
                                          {errorTags.length === 0 && <span className="text-muted-foreground/70">-</span>}
                                          {errorTags.map((tag) => (
                                            <span
                                              key={`${run.id}-${tag}`}
                                              className="tag-error"
                                            >
                                              {tag}
                                            </span>
                                          ))}
                                        </div>
                                        <div className="min-w-0">
                                          {run.pipelineUrl ? (
                                            <div className="flex flex-wrap items-center gap-1">
                                              <a
                                                href={run.pipelineUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                title={run.pipelineUrl}
                                                className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-sm text-primary hover:bg-primary/15"
                                              >
                                                <span>流水线URL</span>
                                                <ExternalLink className="size-3 shrink-0" />
                                              </a>
                                              {run.status === "success" && (
                                                <Button
                                                  type="button"
                                                  onClick={() => openRkDialog(run, pr)}
                                                  className="rounded border border-primary/30 bg-accent px-1.5 py-0.5 text-sm text-accent-foreground hover:bg-accent/80"
                                                >
                                                  RK3568测试
                                                </Button>
                                              )}
                                            </div>
                                          ) : (
                                            <span className="text-muted-foreground/70">-</span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      );
                    })}
                </TableBody>
              </Table>
            </div>

            <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-sm">
              <span className="text-muted-foreground">
                第 {pagination.page} / {pagination.totalPages} 页，共 {pagination.total} 条
              </span>

              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">每页</span>
                <select
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                  className="h-7 rounded border border-input bg-background px-1.5 text-sm text-foreground"
                >
                  {[10, 12, 20, 30, 50].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>

                <Button
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={!hasPrevPage}
                  className="rounded border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))}
                  disabled={!hasNextPage}
                  className="rounded border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  下一页
                </Button>
              </div>
            </div>
          </section>
      </main>

      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="关闭设置弹窗"
            className="absolute inset-0 bg-black/45"
            onClick={() => {
              if (!settingsSaving) {
                setSettingsOpen(false);
              }
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="账户设置"
            className="relative w-full max-w-lg rounded-xl border border-border bg-card p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-foreground">账户设置</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">配置当前账号使用的 GitCode 连接信息</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={settingsSaving}
                onClick={() => setSettingsOpen(false)}
                className="h-7 px-2 text-xs"
              >
                关闭
              </Button>
            </div>

            {settingsError && (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {settingsError}
              </div>
            )}

            <div className="mt-3 grid gap-2">
              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">GitCode Token</span>
                <input
                  value={settingsDraft.gitcodeToken}
                  onChange={(event) => {
                    setSettingsDraft((current) => ({
                      ...current,
                      gitcodeToken: event.target.value,
                    }));
                  }}
                  placeholder="输入 GitCode Token"
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-xs text-muted-foreground">仓库列表（owner/repo）</span>
                <textarea
                  value={settingsDraft.repositoryTargetsText}
                  onChange={(event) => {
                    setSettingsDraft((current) => ({
                      ...current,
                      repositoryTargetsText: event.target.value,
                    }));
                  }}
                  placeholder={"OpenHarmony/arkcompiler_ets_runtime\nOpenHarmony/arkcompiler_runtime_core"}
                  rows={5}
                  className="min-h-[120px] rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
                />
                <span className="text-[11px] text-muted-foreground">支持换行、逗号或分号分隔多个仓库。</span>
              </label>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={settingsSaving}
                onClick={() => setSettingsOpen(false)}
                className="h-8 px-3 text-xs"
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={settingsSaving}
                onClick={() => void handleSaveSettings()}
                className="h-8 px-3 text-xs"
              >
                {settingsSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      {rkDialogRun && rkDialogPr && rkDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="关闭弹窗"
            className="absolute inset-0 bg-black/45"
            onClick={closeRkDialog}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="RK3568 测试配置"
            className="relative flex h-[82vh] w-full max-w-[96vw] flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl"
          >
            <div className="flex flex-row items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-indigo-600">RK3568 Test</p>
                <h3 className="text-sm font-semibold text-slate-900">
                  PR #{rkDialogPr.number} RK3568 测试配置
                </h3>
                <p className="mt-0.5 text-xs text-zinc-600">{rkDialogPr.title}</p>
              </div>
              <Button
                type="button"
                onClick={closeRkDialog}
                className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:border-zinc-500"
              >
                关闭
              </Button>
            </div>

            <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
              <div className="grid gap-2">
                <label className="grid gap-1">
                  <span className="text-[11px] text-zinc-600">流水线 URL</span>
                  <input
                    value={rkDialogRun.pipelineUrl || ""}
                    readOnly
                    className="h-8 rounded border border-zinc-300 bg-zinc-50 px-2 text-xs text-zinc-700"
                  />
                </label>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-[11px] text-zinc-600">测试类型</span>
                    <select
                      value="tdd"
                      disabled
                      className="h-8 rounded border border-zinc-300 bg-zinc-50 px-2 text-xs text-zinc-700"
                    >
                      <option value="tdd">TDD</option>
                    </select>
                  </label>

                  <label className="grid gap-1">
                    <span className="text-[11px] text-zinc-600">测试用例名（可选）</span>
                    <input
                      value={rkTestCaseName}
                      onChange={(event) => setRkTestCaseName(event.target.value)}
                      placeholder="不填则执行 TDD 全量"
                      className="h-8 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-800"
                    />
                  </label>
                </div>

                <label className="grid gap-1">
                  <span className="text-[11px] text-zinc-600">指定设备（可选）</span>
                  <select
                    value={rkRequestedDeviceSerial}
                    onChange={(event) => setRkRequestedDeviceSerial(event.target.value)}
                    className="h-8 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-50"
                    disabled={rkDevicesLoading && rkDevices.length === 0}
                  >
                    <option value="">
                      自动分配（在线可用 {rkAvailableDevices.length} / 在线 {rkOnlineDevices.length}）
                    </option>
                    {rkDevices.map((device) => {
                      const disabled = device.status !== "online" || Boolean(device.occupiedByTaskId);
                      const occupied = device.occupiedByTaskId ? `占用:${device.occupiedByTaskId.slice(0, 8)}` : "空闲";
                      return (
                        <option key={`${device.clientId}:${device.serial}`} value={device.serial} disabled={disabled}>
                          {device.serial} · {device.clientName} · {RK3568_DEVICE_STATUS_LABELS[device.status]} · {occupied}
                        </option>
                      );
                    })}
                  </select>
                  {rkSelectedDeviceState && (
                    <span className="text-[10px] text-zinc-500">
                      当前选择: {rkSelectedDeviceState.serial} ({rkSelectedDeviceState.clientName})
                    </span>
                  )}
                  {!rkSelectedDeviceState && rkRequestedDeviceSerial && (
                    <span className="text-[10px] text-rose-600">所选设备当前不可用，已回退到自动分配。</span>
                  )}
                </label>

                <p className="text-[11px] text-zinc-600">
                  任务将自动执行：解析并下载 dayu200 镜像 + dayu200_tdd 用例、覆盖
                  <code className="px-1">/home/maien/TDD/tests</code>、执行烧录与
                  <code className="px-1">run -t UT</code>（可选
                  <code className="px-1">-ts 用例名</code>）。
                </p>

                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-zinc-700">设备状态</p>
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                      {rkDevicesLoading && <span>刷新中...</span>}
                      <span>客户端 {rkClients.length}</span>
                      <span>在线设备 {rkOnlineDevices.length}</span>
                      <span>可用设备 {rkAvailableDevices.length}</span>
                    </div>
                  </div>

                  {rkClientWsUrl && (
                    <p className="truncate text-[10px] text-zinc-500">
                      Client WS: <code className="px-1">{rkClientWsUrl}</code>
                    </p>
                  )}

                  {rkDevicesError && (
                    <p className="mt-1 rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
                      {rkDevicesError}
                    </p>
                  )}

                  {rkDevices.length === 0 ? (
                    <p className="mt-1 text-[10px] text-zinc-500">暂无客户端上报设备，任务会保持排队等待。</p>
                  ) : (
                    <div className="mt-1 max-h-28 space-y-1 overflow-auto pr-0.5">
                      {rkDevices.map((device) => (
                        <div
                          key={`${device.clientId}:${device.serial}`}
                          className="flex items-center justify-between rounded border border-zinc-200 bg-white px-2 py-1"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-[10px] text-zinc-700">{device.serial}</p>
                            <p className="truncate text-[10px] text-zinc-500">
                              {device.clientName} · 更新于 {formatDate(device.updatedAt)}
                            </p>
                          </div>
                          <div className="ml-2 flex items-center gap-1">
                            <span
                              className={cn(
                                "rounded-full border px-1.5 py-0.5 text-[10px]",
                                RK3568_DEVICE_STATUS_STYLES[device.status],
                              )}
                            >
                              {RK3568_DEVICE_STATUS_LABELS[device.status]}
                            </span>
                            <span className="rounded-full border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
                              {device.occupiedByTaskId ? `占用:${device.occupiedByTaskId.slice(0, 8)}` : "空闲"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={closeRkDialog}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:border-zinc-500"
                >
                  取消
                </Button>
                <Button
                  type="button"
                  onClick={handleStartRk3568}
                  disabled={rkSubmitting}
                  className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {rkSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  启动 RK3568 测试
                </Button>
              </div>

              <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
                <div className="flex min-h-0 flex-col rounded-md border border-zinc-200 bg-zinc-50 p-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-zinc-700">最近 RK3568 任务</p>
                    {rkTasksLoading && <span className="text-[10px] text-zinc-500">刷新中...</span>}
                  </div>
                  <div className="min-h-0 flex-1 space-y-1 overflow-auto pr-0.5">
                    {rkTasks.length === 0 && (
                      <p className="text-[11px] text-zinc-500">暂无任务。</p>
                    )}
                    {rkTasks.map((task) => (
                      <Button
                        key={task.id}
                        type="button"
                        onClick={() => setRkSelectedTaskId(task.id)}
                        className={cn(
                          "grid min-h-[72px] w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left",
                          rkSelectedTaskId === task.id
                            ? "border-indigo-300 bg-indigo-50"
                            : "border-zinc-200 bg-white hover:border-zinc-300",
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[11px] text-zinc-700" title={task.id}>
                            {task.id}
                          </p>
                          <p className="truncate text-[10px] text-zinc-500" title={task.message || "-"}>
                            {task.message || "-"}
                          </p>
                          <p
                            className="truncate text-[10px] text-zinc-500"
                            title={
                              task.assignedDeviceSerial
                                ? `执行设备 ${task.assignedDeviceSerial} (${task.assignedClientName || task.assignedClientId || "-"})`
                                : (task.requestedDeviceSerial
                                  ? `指定设备 ${task.requestedDeviceSerial}`
                                  : "自动分配设备")
                            }
                          >
                            {task.assignedDeviceSerial
                              ? `执行设备: ${task.assignedDeviceSerial} (${task.assignedClientName || task.assignedClientId || "-"})`
                              : (task.requestedDeviceSerial
                                ? `指定设备: ${task.requestedDeviceSerial}`
                                : "设备: 自动分配")}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px]",
                              RK3568_STATUS_STYLES[task.status],
                            )}
                          >
                            {RK3568_STATUS_LABELS[task.status]}
                          </span>
                          <span className="text-[10px] text-zinc-500">{formatDate(task.createdAt)}</span>
                        </div>
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="flex min-h-0 flex-col gap-3">
                  <div className="rounded-md border border-zinc-200 bg-zinc-50 p-2">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[11px] font-semibold text-zinc-700">测试进度</p>
                        <p className="text-[10px] text-zinc-500">
                          {rkSelectedTask ? (rkSelectedTask.message || RK3568_STATUS_LABELS[rkSelectedTask.status]) : "请选择任务查看执行进度"}
                        </p>
                        {rkSelectedTask && (
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                            <span className="rounded border border-zinc-300 bg-white px-1.5 py-0.5">
                              请求设备: {rkSelectedTask.requestedDeviceSerial || "自动分配"}
                            </span>
                            <span className="rounded border border-zinc-300 bg-white px-1.5 py-0.5">
                              执行设备: {rkSelectedTask.assignedDeviceSerial || "-"}
                            </span>
                            <span className="rounded border border-zinc-300 bg-white px-1.5 py-0.5">
                              执行客户端: {rkSelectedTask.assignedClientName || rkSelectedTask.assignedClientId || "-"}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          onClick={handleRkRerun}
                          disabled={!canRerunSelectedTask || rkRerunSubmitting}
                          className="inline-flex h-7 items-center gap-1 rounded border border-blue-300 bg-blue-50 px-2 text-[11px] text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          {rkRerunSubmitting ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                          重新跑
                        </Button>
                        {rkSelectedTask?.resultArchivePath ? (
                          <a
                            href={`/api/rk3568-tests/${rkSelectedTask.id}/archive`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-7 items-center rounded border border-emerald-300 bg-emerald-50 px-2 text-[11px] text-emerald-700 hover:bg-emerald-100"
                          >
                            下载结果 ZIP
                          </a>
                        ) : (
                          <span className="text-[10px] text-zinc-400">结果包未就绪</span>
                        )}
                        <Button
                          type="button"
                          onClick={() => {
                            setRkSelectedLogStep("all");
                            setRkLogVisible(true);
                          }}
                          className={cn(
                            "h-7 rounded border px-2 text-[11px]",
                            rkLogVisible && rkSelectedLogStep === "all"
                              ? "border-indigo-300 bg-indigo-100 text-indigo-700"
                              : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-500",
                          )}
                        >
                          全流程日志
                        </Button>
                        <Button
                          type="button"
                          onClick={() => setRkLogVisible((current) => !current)}
                          className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] text-zinc-700 hover:border-zinc-500"
                        >
                          {rkLogVisible ? "隐藏日志" : "显示日志"}
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                      {RK_PROGRESS_STEPS.map((step, index) => {
                        const status = rkProgressStatuses[index] || "pending";
                        const selected = rkLogVisible && rkSelectedLogStep === index;
                        return (
                          <Button
                            key={step.id}
                            type="button"
                            onClick={() => {
                              setRkSelectedLogStep(index);
                              setRkLogVisible(true);
                            }}
                            className={cn(
                              "flex h-auto flex-col items-start gap-1 rounded border px-2 py-2 text-left",
                              selected ? "ring-1 ring-indigo-400" : "",
                              status === "success" && "border-emerald-300 bg-emerald-50 text-emerald-700",
                              status === "running" && "border-blue-300 bg-blue-50 text-blue-700",
                              status === "failed" && "border-rose-300 bg-rose-50 text-rose-700",
                              status === "pending" && "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300",
                            )}
                          >
                            <span className="inline-flex items-center gap-1 text-[10px]">
                              <RkProgressStatusIcon status={status} />
                              Step {step.id}
                            </span>
                            <span className="text-xs font-medium">{step.label}</span>
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  {rkLogVisible ? (
                    <div className="flex min-h-0 flex-1 flex-col rounded-md border border-zinc-200 bg-zinc-900 p-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold text-zinc-100">
                          控制台日志
                          {rkSelectedTaskId ? ` (${rkSelectedTaskId.slice(0, 8)})` : ""}
                          {rkSelectedLogStep !== "all"
                            ? ` · 节点 ${rkSelectedLogStep + 1}: ${RK_PROGRESS_STEPS[rkSelectedLogStep]?.label || ""}`
                            : " · 全流程"}
                        </p>
                        <div className="flex items-center gap-2">
                          <span className={cn("text-[10px]", wsConnected ? "text-emerald-300" : "text-amber-300")}>
                            {wsConnected ? "WS已连接" : "WS断开，轮询中"}
                          </span>
                          {rkTaskLogLoading && <span className="text-[10px] text-zinc-400">刷新中...</span>}
                        </div>
                      </div>
                      <pre
                        ref={rkLogPreRef}
                        className="min-h-[260px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 text-[10px] leading-4 text-zinc-200"
                      >
                        {rkDisplayedLog || (rkSelectedLogStep === "all" ? "暂无日志输出。" : "该节点暂无日志。")}
                      </pre>
                    </div>
                  ) : (
                    <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-500">
                      当前已隐藏日志，仅显示进度节点状态。
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
