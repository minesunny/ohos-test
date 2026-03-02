import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { createRk3568Task, enqueueRk3568Task, getRk3568TaskById } from "@/lib/rk3568-test";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireApiUser(request);
  if ("response" in auth) {
    return auth.response;
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Task id is required." }, { status: 400 });
  }

  try {
    const sourceTask = await getRk3568TaskById(id);
    if (!sourceTask) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    const rerunTask = await createRk3568Task({
      runId: sourceTask.runId,
      repositoryOwner: sourceTask.repositoryOwner,
      repositoryName: sourceTask.repositoryName,
      prNumber: sourceTask.prNumber,
      pipelineUrl: sourceTask.pipelineUrl,
      testCaseName: sourceTask.testCaseName,
    });

    enqueueRk3568Task(rerunTask.id);

    return NextResponse.json({
      task: rerunTask,
      rerunFromTaskId: sourceTask.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to rerun RK3568 task.",
      },
      { status: 500 },
    );
  }
}
