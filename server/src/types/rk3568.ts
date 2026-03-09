export type Rk3568TestType = "tdd";

export type Rk3568TestStatus =
  | "queued"
  | "running"
  | "success"
  | "failed";

export type Rk3568TestTask = {
  id: string;
  runId?: string;
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  pipelineUrl: string;
  testType: Rk3568TestType;
  testCaseName?: string;
  status: Rk3568TestStatus;
  message?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  taskDir: string;
  logPath: string;
  requestedDeviceSerial?: string;
  assignedClientId?: string;
  assignedClientName?: string;
  assignedDeviceSerial?: string;
  executionMode?: "remote-client";
  dispatchedAt?: string;
  imageArtifactUrl?: string;
  tddArtifactUrl?: string;
  imageArchivePath?: string;
  tddArchivePath?: string;
  imagePath?: string;
  resultReportEntries?: string[];
  resultArchivePath?: string;
  resultArchiveName?: string;
  resultArchivedAt?: string;
};

export type Rk3568TestStore = {
  tasks: Rk3568TestTask[];
};
