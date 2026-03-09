import {
  type GitCodeConfig,
  listPullRequestComments,
} from "@/lib/gitcode";
import {
  extractPipelineCommentEvents,
  hasUnpairedOldestPipelineUrl,
  inferPipelineRunsByUrl,
} from "@/lib/pipeline-comment";
import { getRunById, listRuns, updateRun } from "@/lib/run-store";
import { isSameCommentId, resolveCommentActorName } from "@/lib/gitcode-comment";
import { type PipelineRun } from "@/types/pipeline";

const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 12;

type PullRequestComment = Awaited<ReturnType<typeof listPullRequestComments>>[number];

function getOldestCommentTimeMs(comments: PullRequestComment[]): number | undefined {
  let oldest: number | undefined;

  for (const comment of comments) {
    const timeMs = Date.parse(comment.created_at);
    if (!Number.isFinite(timeMs)) {
      continue;
    }
    if (oldest === undefined || timeMs < oldest) {
      oldest = timeMs;
    }
  }

  return oldest;
}

async function fetchRecentCommentsForRun(config: GitCodeConfig, run: PipelineRun): Promise<PullRequestComment[]> {
  const comments: PullRequestComment[] = [];
  const triggeredAtMs = Date.parse(run.triggeredAt);

  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const batch = await listPullRequestComments(config, run.prNumber, page, COMMENT_PAGE_SIZE);
    comments.push(...batch);

    const hasMore = batch.length === COMMENT_PAGE_SIZE;
    if (!hasMore) {
      break;
    }

    const oldestCommentMs = getOldestCommentTimeMs(comments);
    const needOlderForRunTime = Number.isFinite(triggeredAtMs)
      && typeof oldestCommentMs === "number"
      && Number.isFinite(oldestCommentMs)
      && oldestCommentMs > triggeredAtMs;
    const needOlderForBoundary = hasUnpairedOldestPipelineUrl(comments);

    if (!needOlderForRunTime && !needOlderForBoundary) {
      break;
    }
  }

  return comments;
}

function isEventAfterRun(
  run: PipelineRun,
  event: ReturnType<typeof extractPipelineCommentEvents>[number],
  triggeredAtMs: number,
): boolean {
  if (run.triggerCommentId && isSameCommentId(event.comment.id, run.triggerCommentId)) {
    return false;
  }

  const createdAtMs = Date.parse(event.comment.created_at);
  if (Number.isFinite(triggeredAtMs) && Number.isFinite(createdAtMs) && createdAtMs < triggeredAtMs) {
    return false;
  }

  return true;
}

function findInferredRunForCurrent(
  run: PipelineRun,
  comments: PullRequestComment[],
) {
  const events = extractPipelineCommentEvents(comments);
  if (events.length === 0) {
    return undefined;
  }

  const inferredRuns = inferPipelineRunsByUrl(comments);
  if (inferredRuns.length === 0) {
    return undefined;
  }

  const triggeredAtMs = Date.parse(run.triggeredAt);

  const startEvent = run.pipelineUrl
    ? events.find((event) => event.url === run.pipelineUrl && isEventAfterRun(run, event, triggeredAtMs))
      || events.find((event) => event.url === run.pipelineUrl)
    : events.find((event) => isEventAfterRun(run, event, triggeredAtMs));

  if (!startEvent) {
    return undefined;
  }

  const matchedByStart = inferredRuns.find((item) => isSameCommentId(item.startComment.id, startEvent.comment.id));
  if (matchedByStart) {
    return matchedByStart;
  }

  const fallback = inferredRuns.find((item) => {
    if (run.triggerCommentId && isSameCommentId(item.startComment.id, run.triggerCommentId)) {
      return false;
    }

    const startAtMs = Date.parse(item.startComment.created_at);
    if (Number.isFinite(triggeredAtMs) && Number.isFinite(startAtMs) && startAtMs < triggeredAtMs) {
      return false;
    }

    return item.url === startEvent.url;
  });

  return fallback;
}

export async function syncRunWithGitCode(
  config: GitCodeConfig,
  runId: string,
): Promise<PipelineRun> {
  const run = await getRunById(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const comments = await fetchRecentCommentsForRun(config, run);
  const matched = findInferredRunForCurrent(run, comments);
  const now = new Date().toISOString();

  const updated = await updateRun(runId, (current) => {
    if (!matched) {
      return {
        ...current,
        lastSyncedAt: now,
      };
    }

    const resultComment = matched.endComment || (matched.forcedTermination ? matched.startComment : undefined);
    const nextStatus = matched.status;
    const isCompleted = nextStatus === "success" || nextStatus === "failed";
    const inferredTriggeredBy = resolveCommentActorName(matched.startComment, current.triggeredBy);
    const shouldBackfillTriggeredBy = /^(unknown|system)$/i.test(current.triggeredBy.trim());

    return {
      ...current,
      status: nextStatus,
      triggeredBy: shouldBackfillTriggeredBy ? inferredTriggeredBy : current.triggeredBy,
      triggerCommentId: current.triggerCommentId || matched.startComment.id,
      triggerCommentUrl: current.triggerCommentUrl || matched.startComment.html_url,
      resultSource: "comment-sync",
      resultCommentId: resultComment?.id || current.resultCommentId,
      resultCommentBody: resultComment?.body || current.resultCommentBody,
      resultCommentUrl: resultComment?.html_url || current.resultCommentUrl,
      resultMessage: matched.message || current.resultMessage,
      pipelineUrl: matched.url || current.pipelineUrl,
      pipelineTasks: matched.pipelineTasks || current.pipelineTasks,
      completedAt: isCompleted
        ? resultComment?.created_at || matched.startComment.created_at
        : undefined,
      lastSyncedAt: now,
    };
  });

  if (!updated) {
    throw new Error(`Run not found during update: ${runId}`);
  }

  return updated;
}

export async function syncPendingRuns(
  config: GitCodeConfig,
  maxCount = 30,
): Promise<PipelineRun[]> {
  const runs = await listRuns();

  const pending = runs
    .filter((run) => run.repositoryOwner === config.owner && run.repositoryName === config.repo)
    .filter((run) => run.status === "triggered" || run.status === "running" || run.status === "unknown")
    .slice(0, maxCount);

  const results: PipelineRun[] = [];

  for (const run of pending) {
    try {
      const updated = await syncRunWithGitCode(config, run.id);
      results.push(updated);
    } catch {
      // Skip individual run failures to avoid aborting bulk sync.
    }
  }

  return results;
}
