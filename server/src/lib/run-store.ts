import { promises as fs } from "node:fs";
import path from "node:path";

import { notifyPrsUpdated } from "@/lib/realtime-ws";
import { type PipelineRun, type PipelineRunStore } from "@/types/pipeline";

const DATA_DIR = path.join(process.cwd(), "data");
const RUNS_FILE = path.join(DATA_DIR, "pipeline-runs.json");

let writeQueue: Promise<void> = Promise.resolve();

function createRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(RUNS_FILE);
  } catch {
    const initial: PipelineRunStore = { runs: [] };
    await fs.writeFile(RUNS_FILE, `${JSON.stringify(initial, null, 2)}\n`, "utf-8");
  }
}

async function readStoreUnsafe(): Promise<PipelineRunStore> {
  await ensureStoreFile();
  const raw = await fs.readFile(RUNS_FILE, "utf-8");
  if (!raw.trim()) {
    return { runs: [] };
  }

  try {
    const parsed = JSON.parse(raw) as PipelineRunStore;
    if (!Array.isArray(parsed.runs)) {
      return { runs: [] };
    }
    return parsed;
  } catch {
    return { runs: [] };
  }
}

async function writeStoreUnsafe(store: PipelineRunStore): Promise<void> {
  await ensureStoreFile();
  const tempFile = `${RUNS_FILE}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  await fs.rename(tempFile, RUNS_FILE);
}

async function withStoreWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const task = writeQueue.then(work, work);
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function listRuns(prNumber?: number): Promise<PipelineRun[]> {
  const store = await readStoreUnsafe();
  const runs =
    prNumber === undefined
      ? store.runs
      : store.runs.filter((run) => run.prNumber === prNumber);

  return runs.sort((a, b) => (a.triggeredAt > b.triggeredAt ? -1 : 1));
}

export async function getRunById(id: string): Promise<PipelineRun | undefined> {
  const store = await readStoreUnsafe();
  return store.runs.find((run) => run.id === id);
}

type CreateRunInput = {
  repositoryOwner: string;
  repositoryName: string;
  prNumber: number;
  prTitle: string;
  triggerCommentBody: string;
  triggerCommentId?: string | number;
  triggerCommentUrl?: string;
  triggeredBy: string;
  triggeredAt?: string;
};

export async function createRun(input: CreateRunInput): Promise<PipelineRun> {
  return withStoreWriteLock(async () => {
    const store = await readStoreUnsafe();

    const run: PipelineRun = {
      id: createRunId(),
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      triggerCommentBody: input.triggerCommentBody,
      triggerCommentId: input.triggerCommentId,
      triggerCommentUrl: input.triggerCommentUrl,
      triggeredBy: input.triggeredBy,
      triggeredAt: input.triggeredAt ?? new Date().toISOString(),
      status: "triggered",
      resultSource: "unknown",
    };

    store.runs.push(run);
    await writeStoreUnsafe(store);
    notifyPrsUpdated(`${run.repositoryOwner}/${run.repositoryName}`, "run-created");
    return run;
  });
}

export async function updateRun(
  id: string,
  updater: (run: PipelineRun) => PipelineRun,
): Promise<PipelineRun | undefined> {
  return withStoreWriteLock(async () => {
    const store = await readStoreUnsafe();
    const index = store.runs.findIndex((run) => run.id === id);

    if (index === -1) {
      return undefined;
    }

    const updated = updater(store.runs[index]!);
    store.runs[index] = updated;
    await writeStoreUnsafe(store);
    notifyPrsUpdated(`${updated.repositoryOwner}/${updated.repositoryName}`, "run-updated");
    return updated;
  });
}
