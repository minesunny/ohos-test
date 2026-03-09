import { type GitCodePullRequestComment } from "@/types/gitcode";
import { type PipelineRunStatus } from "@/types/pipeline";
import { normalizeCommentId } from "@/lib/gitcode-comment";

export type ParsedPipelineStatus = {
  status: PipelineRunStatus;
  message: string;
  pipelineUrl?: string;
  pipelineTasks?: string[];
};

export type PipelineCommentEvent = {
  comment: GitCodePullRequestComment;
  url: string;
  parsed: ParsedPipelineStatus;
};

export type InferredPipelineRun = {
  url: string;
  status: "running" | "success" | "failed";
  message: string;
  startComment: GitCodePullRequestComment;
  endComment?: GitCodePullRequestComment;
  pipelineTasks?: string[];
  forcedTermination?: boolean;
};

const SUCCESS_KEYWORDS = [
  "build success",
  "pipeline success",
  "build passed",
  "success",
  "passed",
  "构建成功",
  "已成功",
  "执行成功",
  "门禁通过",
  "验证通过",
  "检查通过",
];

const FAILED_KEYWORDS = [
  "build failed",
  "pipeline failed",
  "failed",
  "failure",
  "abort",
  "cancel",
  "中止",
  "终止",
  "自动中止",
  "构建失败",
  "未通过",
  "执行失败",
  "门禁失败",
  "验证失败",
  "检查失败",
];

const RUNNING_KEYWORDS = [
  "start build",
  "building",
  "running",
  "queued",
  "in progress",
  "进行中",
  "排队",
  "构建中",
  "开始构建",
  "全量重新构建",
  "门禁构建开始",
  "重置所有关联pr的验证状态",
  "重置所有关联 pr 的验证状态",
];

const RUNLIST_URL_PATTERN = /https?:\/\/dcp\.openharmony\.cn\/workbench\/cicd\/detail\/[a-z0-9_-]+\/runlist/gi;
const GATE_START_TASKS_PATTERN = /包含静态检查、代码编译和测试\s*[【\[]([^】\]]+)[】\]]/;

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function compareCommentAsc(a: GitCodePullRequestComment, b: GitCodePullRequestComment): number {
  if (a.created_at === b.created_at) {
    const leftId = normalizeCommentId(a.id) || "";
    const rightId = normalizeCommentId(b.id) || "";
    return leftId.localeCompare(rightId);
  }
  return a.created_at > b.created_at ? 1 : -1;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() || text.trim();
}

function normalizeCommentForUrl(body: string): string {
  return body.replace(/workbench\/\s*cicd/gi, "workbench/cicd");
}

export function extractPipelineUrl(body: string): string | undefined {
  const normalized = normalizeCommentForUrl(body);
  const matched = normalized.match(RUNLIST_URL_PATTERN);
  return matched?.[0];
}

export function extractPipelineTasks(body: string): string[] | undefined {
  const fullWidthMatch = body.match(/【([^】]+)】/);
  const asciiCandidate = body.match(/\[([^\]]+)\]/)?.[1];
  const asciiIsTaskList = Boolean(
    asciiCandidate
      && /[，,]/.test(asciiCandidate)
      && /(编译|测试|build|test)/i.test(asciiCandidate),
  );
  const value = fullWidthMatch?.[1] || (asciiIsTaskList ? asciiCandidate : undefined);

  if (!value) {
    return undefined;
  }

  const tasks = value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (tasks.length === 0) {
    return undefined;
  }

  return Array.from(new Set(tasks));
}

function parseGateStartTemplate(body: string): {
  tasks?: string[];
  url?: string;
} | undefined {
  const normalizedForUrl = normalizeCommentForUrl(body);
  const normalized = normalizedForUrl.replace(/\s+/g, "");

  const isTemplateComment = normalized.includes("门禁构建开始")
    && normalized.includes("包含静态检查、代码编译和测试")
    && normalized.includes("跟踪门禁进展");

  if (!isTemplateComment) {
    return undefined;
  }

  const tasksRaw = body.match(GATE_START_TASKS_PATTERN)?.[1];
  const tasks = tasksRaw
    ? tasksRaw
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;

  const url = extractPipelineUrl(normalizedForUrl);

  return {
    tasks: tasks && tasks.length > 0 ? Array.from(new Set(tasks)) : undefined,
    url,
  };
}

export function parseStatusFromComment(body: string | null | undefined): ParsedPipelineStatus | undefined {
  const raw = typeof body === "string" ? body : "";
  const text = raw.trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  const headline = firstLine(raw).toLowerCase();

  const gateStart = parseGateStartTemplate(raw);
  if (gateStart) {
    return {
      status: "running",
      message: firstLine(raw),
      pipelineUrl: gateStart.url,
      pipelineTasks: gateStart.tasks,
    };
  }

  const pipelineUrl = extractPipelineUrl(raw);
  const pipelineTasks = undefined;

  if (/(门禁通过|构建通过|验证通过|检查通过)/.test(headline)) {
    return {
      status: "success",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (/(门禁失败|构建失败|验证失败|检查失败|未通过)/.test(headline)) {
    return {
      status: "failed",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  const headlineSuccess = includesAny(headline, SUCCESS_KEYWORDS);
  const headlineFailed = includesAny(headline, FAILED_KEYWORDS);
  const textSuccess = includesAny(text, SUCCESS_KEYWORDS);
  const textFailed = includesAny(text, FAILED_KEYWORDS);

  if (headlineSuccess && !headlineFailed) {
    return {
      status: "success",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (headlineFailed && !headlineSuccess) {
    return {
      status: "failed",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (textSuccess && !textFailed) {
    return {
      status: "success",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (textFailed && !textSuccess) {
    return {
      status: "failed",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (textSuccess && textFailed) {
    return {
      status: headlineFailed ? "failed" : "success",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (includesAny(text, SUCCESS_KEYWORDS)) {
    return {
      status: "success",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  if (includesAny(text, RUNNING_KEYWORDS) || Boolean(pipelineUrl)) {
    return {
      status: "running",
      message: firstLine(raw),
      pipelineUrl,
      pipelineTasks,
    };
  }

  return undefined;
}

function resolveResultStatus(parsed: ParsedPipelineStatus | undefined, body: string): {
  status: "running" | "success" | "failed";
  message: string;
} {
  if (parsed?.status === "success" || parsed?.status === "failed") {
    return {
      status: parsed.status,
      message: parsed.message,
    };
  }

  const normalized = body.toLowerCase();
  if (includesAny(normalized, FAILED_KEYWORDS)) {
    return {
      status: "failed",
      message: parsed?.message || firstLine(body),
    };
  }

  if (includesAny(normalized, SUCCESS_KEYWORDS)) {
    return {
      status: "success",
      message: parsed?.message || firstLine(body),
    };
  }

  return {
    status: "running",
    message: parsed?.message || firstLine(body),
  };
}

export function sortCommentsAsc(comments: GitCodePullRequestComment[]): GitCodePullRequestComment[] {
  return comments.slice().sort(compareCommentAsc);
}

export function sortCommentsDesc(comments: GitCodePullRequestComment[]): GitCodePullRequestComment[] {
  return comments.slice().sort((a, b) => compareCommentAsc(b, a));
}

export function extractPipelineCommentEvents(comments: GitCodePullRequestComment[]): PipelineCommentEvent[] {
  const ordered = sortCommentsAsc(comments);
  const events: PipelineCommentEvent[] = [];

  for (const comment of ordered) {
    const parsed = parseStatusFromComment(comment.body);
    if (!parsed?.pipelineUrl) {
      continue;
    }
    events.push({
      comment,
      url: parsed.pipelineUrl,
      parsed,
    });
  }

  return events;
}

export function hasUnpairedOldestPipelineUrl(comments: GitCodePullRequestComment[]): boolean {
  const events = extractPipelineCommentEvents(comments);
  if (events.length === 0) {
    return false;
  }

  const oldestUrl = events[0]!.url;
  let oldestBlockCount = 0;

  while (oldestBlockCount < events.length && events[oldestBlockCount]!.url === oldestUrl) {
    oldestBlockCount += 1;
  }

  return oldestBlockCount % 2 === 1;
}

export function inferPipelineRunsByUrl(comments: GitCodePullRequestComment[]): InferredPipelineRun[] {
  const events = extractPipelineCommentEvents(comments);
  const runs: InferredPipelineRun[] = [];

  for (let index = 0; index < events.length; index += 1) {
    const current = events[index]!;
    const next = events[index + 1];

    if (next && next.url === current.url) {
      const resolved = resolveResultStatus(next.parsed, next.comment.body);
      runs.push({
        url: current.url,
        status: resolved.status,
        message: resolved.message,
        startComment: current.comment,
        endComment: next.comment,
        pipelineTasks: current.parsed.pipelineTasks || next.parsed.pipelineTasks,
      });
      index += 1;
      continue;
    }

    const hasLaterRun = index < events.length - 1;
    if (hasLaterRun) {
      runs.push({
        url: current.url,
        status: "failed",
        message: "未检测到该流水线 URL 的结果评论，推断为强制终止。",
        startComment: current.comment,
        pipelineTasks: current.parsed.pipelineTasks,
        forcedTermination: true,
      });
      continue;
    }

    runs.push({
      url: current.url,
      status: "running",
      message: current.parsed.message || "流水线已触发，等待结果评论。",
      startComment: current.comment,
      pipelineTasks: current.parsed.pipelineTasks,
    });
  }

  return runs;
}
