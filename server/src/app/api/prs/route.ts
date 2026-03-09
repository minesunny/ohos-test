import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import {
  type GitCodeConfig,
  listPullRequestComments,
  listPullRequests,
  type PullRequestFilterState,
} from "@/lib/gitcode";
import {
  hasUnpairedOldestPipelineUrl,
  inferPipelineRunsByUrl,
  parseStatusFromComment,
  sortCommentsDesc,
} from "@/lib/pipeline-comment";
import { isSameCommentId, normalizeCommentId, resolveCommentActorName } from "@/lib/gitcode-comment";
import { listRuns } from "@/lib/run-store";
import { listRepositoryTargetsForUser, resolveGitCodeConfigForUser } from "@/lib/user-settings";
import { type GitCodePullRequest } from "@/types/gitcode";
import { type PipelineRun } from "@/types/pipeline";

const MAX_FETCH_PAGES = 5;
const FETCH_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 8;
const COMMENT_PAGE_SIZE = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;

type PrFilters = {
  prNumber: string;
  title: string;
  issue: string;
  author: string;
  owner: string;
  repo: string;
};

type DashboardPrItem = GitCodePullRequest & {
  issueNumber?: number;
  runCount: number;
  latestRun?: PipelineRun;
  runs: PipelineRun[];
};

type PaginatedPrItem = {
  pr: GitCodePullRequest;
  issueNumber?: number;
  localRuns: PipelineRun[];
};

function normalizeState(state: string | null): PullRequestFilterState {
  if (state === "closed" || state === "all") {
    return state;
  }
  return "open";
}

function normalizeText(raw: string | null): string {
  return (raw || "").trim().toLowerCase();
}

function normalizeRawText(raw: string | null): string {
  return (raw || "").trim();
}

function normalizeNumberKeyword(raw: string | null): string {
  return (raw || "").trim().replace(/^#/, "");
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return value;
}

function getRelatedIssueNumber(pr: GitCodePullRequest): number | undefined {
  if (!Number.isInteger(pr.close_related_issue)) {
    return undefined;
  }

  const issueNumber = Number(pr.close_related_issue);
  if (issueNumber <= 0) {
    return undefined;
  }

  return issueNumber;
}

function matchesFilters(pr: GitCodePullRequest, filters: PrFilters): boolean {
  const issueNumber = getRelatedIssueNumber(pr);
  const authorRaw = `${pr.user?.login || ""} ${pr.user?.name || ""}`.toLowerCase();

  if (filters.prNumber && !String(pr.number).includes(filters.prNumber)) {
    return false;
  }

  if (filters.title && !pr.title.toLowerCase().includes(filters.title)) {
    return false;
  }

  if (filters.issue && !String(issueNumber || "").includes(filters.issue)) {
    return false;
  }

  if (filters.author && !authorRaw.includes(filters.author)) {
    return false;
  }

  return true;
}

function getLatestRun(runs: PipelineRun[]): PipelineRun | undefined {
  return runs.slice().sort((a, b) => (a.triggeredAt > b.triggeredAt ? -1 : 1))[0];
}

function buildRunsByPrNumber(runs: PipelineRun[]): Map<number, PipelineRun[]> {
  const map = new Map<number, PipelineRun[]>();

  for (const run of runs) {
    const current = map.get(run.prNumber) || [];
    current.push(run);
    map.set(run.prNumber, current);
  }

  for (const [key, value] of map.entries()) {
    map.set(key, value.slice().sort((a, b) => (a.triggeredAt > b.triggeredAt ? -1 : 1)));
  }

  return map;
}

async function fetchPullRequestsForDashboard(
  config: GitCodeConfig,
  state: PullRequestFilterState,
): Promise<GitCodePullRequest[]> {
  const result: GitCodePullRequest[] = [];
  const seen = new Set<number>();

  for (let page = 1; page <= MAX_FETCH_PAGES; page += 1) {
    const batch = await listPullRequests(config, state, {
      page,
      perPage: FETCH_PER_PAGE,
    });

    for (const pr of batch) {
      if (seen.has(pr.id)) {
        continue;
      }
      seen.add(pr.id);
      result.push(pr);
    }

    if (batch.length < FETCH_PER_PAGE) {
      break;
    }
  }

  return result;
}

async function fetchRecentCommentsForHistory(
  config: GitCodeConfig,
  prNumber: number,
) {
  const comments = [];

  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const batch = await listPullRequestComments(config, prNumber, page, COMMENT_PAGE_SIZE);
    comments.push(...batch);

    const hasMore = batch.length === COMMENT_PAGE_SIZE;
    if (!hasMore) {
      break;
    }

    if (!hasUnpairedOldestPipelineUrl(comments)) {
      break;
    }
  }

  return comments;
}

function isPendingStatus(status: PipelineRun["status"]): boolean {
  return status === "triggered" || status === "running" || status === "unknown";
}

function shouldBackfillTriggeredBy(triggeredBy: string): boolean {
  const normalized = triggeredBy.trim().toLowerCase();
  return normalized === "" || normalized === "unknown" || normalized === "system";
}

function findLastRunIndex(
  runs: PipelineRun[],
  matcher: (run: PipelineRun) => boolean,
): number {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (matcher(runs[index]!)) {
      return index;
    }
  }
  return -1;
}

function findPendingRunForTemplate(
  runs: PipelineRun[],
  parsedRun: PipelineRun,
): number {
  const parsedAtMs = Date.parse(parsedRun.triggeredAt);
  const maxGapMs = 30 * 60 * 1000;

  if (!Number.isFinite(parsedAtMs)) {
    return -1;
  }

  return findLastRunIndex(runs, (run) => {
    if (!isPendingStatus(run.status)) {
      return false;
    }

    const runAtMs = Date.parse(run.triggeredAt);
    if (!Number.isFinite(runAtMs) || runAtMs > parsedAtMs) {
      return false;
    }

    return parsedAtMs - runAtMs <= maxGapMs;
  });
}

function commentToTemplateRun(
  comment: Awaited<ReturnType<typeof fetchRecentCommentsForHistory>>[number],
  pr: GitCodePullRequest,
  config: GitCodeConfig,
): PipelineRun | undefined {
  const commentBody = typeof comment.body === "string" ? comment.body : "";
  const parsed = parseStatusFromComment(commentBody);
  if (!parsed) {
    return undefined;
  }
  const isTemplateComment = parsed.status === "running"
    && Boolean(parsed.pipelineUrl)
    && Boolean(parsed.pipelineTasks?.length);
  if (!isTemplateComment) {
    return undefined;
  }

  const triggeredBy = resolveCommentActorName(comment, "system");

  return {
    id: `comment-${pr.number}-${comment.id}`,
    repositoryOwner: config.owner,
    repositoryName: config.repo,
    prNumber: pr.number,
    prTitle: pr.title,
    triggerCommentBody: commentBody,
    triggerCommentId: comment.id,
    triggerCommentUrl: comment.html_url,
    triggeredBy,
    triggeredAt: comment.created_at,
    status: parsed.status,
    resultSource: "comment-sync",
    resultMessage: parsed.message,
    pipelineUrl: parsed.pipelineUrl,
    pipelineTasks: parsed.pipelineTasks,
    completedAt: undefined,
    lastSyncedAt: comment.updated_at || comment.created_at,
  };
}

function mergeRuns(localRuns: PipelineRun[], parsedRuns: PipelineRun[]): PipelineRun[] {
  const merged = localRuns.map((run) => ({ ...run }));
  const indexByCommentId = new Map<string, number>();

  merged.forEach((run, index) => {
    const commentId = normalizeCommentId(run.triggerCommentId);
    if (commentId) {
      indexByCommentId.set(commentId, index);
    }
  });

  for (const parsedRun of parsedRuns) {
    const commentId = normalizeCommentId(parsedRun.triggerCommentId);

    if (!commentId) {
      merged.push(parsedRun);
      continue;
    }

    const existingIndex = indexByCommentId.get(commentId);
    if (existingIndex === undefined) {
      const pendingIndex = findPendingRunForTemplate(merged, parsedRun);
      if (pendingIndex !== -1) {
        const current = merged[pendingIndex]!;
        merged[pendingIndex] = {
          ...current,
          triggeredBy: shouldBackfillTriggeredBy(current.triggeredBy) ? parsedRun.triggeredBy : current.triggeredBy,
          status: parsedRun.status,
          resultSource: current.resultSource === "manual" ? "manual" : "comment-sync",
          resultMessage: current.resultMessage || parsedRun.resultMessage,
          pipelineUrl: current.pipelineUrl || parsedRun.pipelineUrl,
          pipelineTasks: current.pipelineTasks || parsedRun.pipelineTasks,
          lastSyncedAt: parsedRun.lastSyncedAt || current.lastSyncedAt,
        };
        indexByCommentId.set(commentId, pendingIndex);
      } else {
        merged.push(parsedRun);
        indexByCommentId.set(commentId, merged.length - 1);
      }
      continue;
    }

    const current = merged[existingIndex]!;
    const shouldOverrideStatus =
      current.status === "triggered" || current.status === "unknown" || current.resultSource === "unknown";

    merged[existingIndex] = {
      ...current,
      triggeredBy: shouldBackfillTriggeredBy(current.triggeredBy) ? parsedRun.triggeredBy : current.triggeredBy,
      status: shouldOverrideStatus ? parsedRun.status : current.status,
      resultSource: current.resultSource === "manual" ? "manual" : "comment-sync",
      resultCommentId: current.resultCommentId || parsedRun.resultCommentId,
      resultCommentBody: current.resultCommentBody || parsedRun.resultCommentBody,
      resultCommentUrl: current.resultCommentUrl || parsedRun.resultCommentUrl,
      resultMessage: current.resultMessage || parsedRun.resultMessage,
      pipelineUrl: current.pipelineUrl || parsedRun.pipelineUrl,
      pipelineTasks: current.pipelineTasks || parsedRun.pipelineTasks,
      completedAt: current.completedAt || parsedRun.completedAt,
      lastSyncedAt: parsedRun.lastSyncedAt || current.lastSyncedAt,
    };
  }

  return merged.sort((a, b) => (a.triggeredAt > b.triggeredAt ? -1 : 1));
}

function findRunIndexForInferredStatus(
  runs: PipelineRun[],
  inferred: ReturnType<typeof inferPipelineRunsByUrl>[number],
): number {
  const byTriggerCommentId = findLastRunIndex(
    runs,
    (run) => isSameCommentId(run.triggerCommentId, inferred.startComment.id),
  );
  if (byTriggerCommentId !== -1) {
    return byTriggerCommentId;
  }

  const byPipelineUrl = findLastRunIndex(
    runs,
    (run) => run.pipelineUrl === inferred.url,
  );
  if (byPipelineUrl !== -1) {
    return byPipelineUrl;
  }

  const startAtMs = Date.parse(inferred.startComment.created_at);
  const maxGapMs = 30 * 60 * 1000;

  return findLastRunIndex(runs, (run) => {
    if (!isPendingStatus(run.status)) {
      return false;
    }

    const triggeredAtMs = Date.parse(run.triggeredAt);
    if (!Number.isFinite(startAtMs) || !Number.isFinite(triggeredAtMs)) {
      return true;
    }

    if (triggeredAtMs > startAtMs) {
      return false;
    }

    return startAtMs - triggeredAtMs <= maxGapMs;
  });
}

function applyCommentStatusUpdates(
  runs: PipelineRun[],
  comments: Awaited<ReturnType<typeof fetchRecentCommentsForHistory>>,
): PipelineRun[] {
  const inferredRuns = inferPipelineRunsByUrl(comments);
  const updated = runs.map((run) => ({ ...run }));

  for (const inferred of inferredRuns) {
    const targetIndex = findRunIndexForInferredStatus(updated, inferred);
    if (targetIndex === -1) {
      continue;
    }

    const target = updated[targetIndex]!;
    const resultComment = inferred.endComment || (inferred.forcedTermination ? inferred.startComment : undefined);
    const isCompleted = inferred.status === "success" || inferred.status === "failed";
    const inferredTriggeredBy = resolveCommentActorName(inferred.startComment, target.triggeredBy);

    updated[targetIndex] = {
      ...target,
      triggeredBy: shouldBackfillTriggeredBy(target.triggeredBy) ? inferredTriggeredBy : target.triggeredBy,
      triggerCommentId: target.triggerCommentId || inferred.startComment.id,
      triggerCommentUrl: target.triggerCommentUrl || inferred.startComment.html_url,
      status: inferred.status,
      resultSource: target.resultSource === "manual" ? "manual" : "comment-sync",
      resultCommentId: resultComment?.id || target.resultCommentId,
      resultCommentBody: resultComment?.body || target.resultCommentBody,
      resultCommentUrl: resultComment?.html_url || target.resultCommentUrl,
      resultMessage: inferred.message || target.resultMessage,
      pipelineUrl: target.pipelineUrl || inferred.url,
      pipelineTasks: target.pipelineTasks || inferred.pipelineTasks,
      completedAt: isCompleted
        ? resultComment?.created_at || inferred.startComment.created_at
        : undefined,
      lastSyncedAt:
        resultComment?.updated_at
        || resultComment?.created_at
        || inferred.startComment.updated_at
        || inferred.startComment.created_at,
    };
  }

  return updated.sort((a, b) => (a.triggeredAt > b.triggeredAt ? -1 : 1));
}

async function enrichWithCommentRuns(
  config: GitCodeConfig,
  items: PaginatedPrItem[],
): Promise<DashboardPrItem[]> {
  return await Promise.all(
    items.map(async (item) => {
      const comments = await fetchRecentCommentsForHistory(config, item.pr.number);
      const parsedRuns = sortCommentsDesc(comments)
        .map((comment) => commentToTemplateRun(comment, item.pr, config))
        .filter((run): run is PipelineRun => Boolean(run));

      const mergedRuns = mergeRuns(item.localRuns, parsedRuns);
      const runs = applyCommentStatusUpdates(mergedRuns, comments);
      const normalizedUser = {
        id: item.pr.user?.id ?? 0,
        login: item.pr.user?.login || item.pr.user?.name || "unknown",
        name: item.pr.user?.name,
      };

      return {
        ...item.pr,
        user: normalizedUser,
        issueNumber: item.issueNumber,
        runCount: runs.length,
        latestRun: getLatestRun(runs),
        runs,
      };
    }),
  );
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const state = normalizeState(request.nextUrl.searchParams.get("state"));
    const filters: PrFilters = {
      prNumber: normalizeNumberKeyword(request.nextUrl.searchParams.get("prNumber")),
      title: normalizeText(request.nextUrl.searchParams.get("title")),
      issue: normalizeNumberKeyword(request.nextUrl.searchParams.get("issue")),
      author: normalizeText(request.nextUrl.searchParams.get("author")),
      owner: normalizeRawText(request.nextUrl.searchParams.get("owner")),
      repo: normalizeRawText(request.nextUrl.searchParams.get("repo")),
    };
    const rawPage = parsePositiveInt(request.nextUrl.searchParams.get("page"), DEFAULT_PAGE);
    const pageSize = Math.min(
      parsePositiveInt(request.nextUrl.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );
    const selectedTargetInput = request.nextUrl.searchParams.get("target") || undefined;
    const resolved = resolveGitCodeConfigForUser(auth.user.id, {
      target: selectedTargetInput,
      owner: filters.owner || undefined,
      repo: filters.repo || undefined,
    });
    const config = resolved.config;
    const selectedTarget = resolved.selectedTarget;
    const repositories = listRepositoryTargetsForUser(auth.user.id, selectedTarget);
    const [prs, runs] = await Promise.all([
      fetchPullRequestsForDashboard(config, state),
      listRuns(),
    ]);

    const runsByPrNumber = buildRunsByPrNumber(
      runs.filter(
        (run) =>
          run.repositoryOwner === config.owner
          && run.repositoryName === config.repo,
      ),
    );

    const filtered = prs
      .filter((pr) => matchesFilters(pr, filters))
      .map((pr) => ({
        pr,
        issueNumber: getRelatedIssueNumber(pr),
        localRuns: runsByPrNumber.get(pr.number) || [],
      }));

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(rawPage, totalPages);
    const offset = (page - 1) * pageSize;
    const paginatedItems = filtered.slice(offset, offset + pageSize);
    const paginated = await enrichWithCommentRuns(config, paginatedItems);

    return NextResponse.json({
      repository: {
        owner: config.owner,
        repo: config.repo,
      },
      repositories,
      selectedTarget,
      state,
      filters: {
        ...filters,
        owner: config.owner,
        repo: config.repo,
      },
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
      prs: paginated,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to fetch pull requests.";
    const status =
      /unknown repository target|invalid target|missing gitcode settings|owner and repo must/i.test(message) ? 400 : 500;

    return NextResponse.json(
      {
        error: message,
      },
      { status },
    );
  }
}
