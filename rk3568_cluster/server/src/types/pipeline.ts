export type PipelineRunStatus =
  | "triggered"
  | "running"
  | "success"
  | "failed"
  | "unknown";

export type PipelineResultSource = "comment-sync" | "manual" | "unknown";

export type PipelineRun = {
  id: string;
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  prTitle: string;
  triggerCommentBody: string;
  triggerCommentId?: string | number;
  triggerCommentUrl?: string;
  triggeredBy: string;
  triggeredAt: string;
  status: PipelineRunStatus;
  resultSource: PipelineResultSource;
  resultCommentId?: string | number;
  resultCommentBody?: string;
  resultCommentUrl?: string;
  resultMessage?: string;
  pipelineUrl?: string;
  pipelineTasks?: string[];
  completedAt?: string;
  lastSyncedAt?: string;
};

export type PipelineRunStore = {
  runs: PipelineRun[];
};
