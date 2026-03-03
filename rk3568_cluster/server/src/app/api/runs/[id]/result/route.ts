import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { updateRun } from "@/lib/run-store";
import { type PipelineRunStatus } from "@/types/pipeline";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

type ManualResultBody = {
  status?: PipelineRunStatus;
  message?: string;
};

const ALLOWED_STATUS: PipelineRunStatus[] = [
  "triggered",
  "running",
  "success",
  "failed",
  "unknown",
];

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireApiUser(request);
  if ("response" in auth) {
    return auth.response;
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Run id is required." }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as ManualResultBody;
  const status = body.status;

  if (!status || !ALLOWED_STATUS.includes(status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const message = body.message?.trim();

  const run = await updateRun(id, (current) => {
    const isCompleted = status === "success" || status === "failed";

    return {
      ...current,
      status,
      resultSource: "manual",
      resultMessage: message || current.resultMessage,
      completedAt: isCompleted ? now : undefined,
      lastSyncedAt: now,
    };
  });

  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({ run });
}
