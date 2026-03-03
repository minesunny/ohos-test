import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { syncRunWithGitCode } from "@/lib/pipeline-sync";
import { getRunById } from "@/lib/run-store";
import { resolveGitCodeConfigForUser } from "@/lib/user-settings";

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
    return NextResponse.json({ error: "Run id is required." }, { status: 400 });
  }

  try {
    const run = await getRunById(id);
    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    const { config } = resolveGitCodeConfigForUser(auth.user.id, {
      owner: run.repositoryOwner,
      repo: run.repositoryName,
    });
    const updatedRun = await syncRunWithGitCode(config, id);
    return NextResponse.json({ run: updatedRun });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to sync run status.";
    const status = message.includes("Run not found")
      ? 404
      : /unknown repository target|invalid target|missing gitcode settings|owner and repo must/i.test(message)
        ? 400
        : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
