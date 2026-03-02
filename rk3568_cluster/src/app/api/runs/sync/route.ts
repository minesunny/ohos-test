import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { syncPendingRuns } from "@/lib/pipeline-sync";
import { resolveGitCodeConfigForUser } from "@/lib/user-settings";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const payload = (await request.json().catch(() => ({}))) as {
      maxCount?: number;
      target?: string;
      owner?: string;
      repo?: string;
    };

    const maxCount =
      Number.isInteger(payload.maxCount) && (payload.maxCount ?? 0) > 0
        ? Math.min(payload.maxCount ?? 30, 100)
        : 30;

    const { config } = resolveGitCodeConfigForUser(auth.user.id, {
      target: payload.target,
      owner: payload.owner,
      repo: payload.repo,
    });
    const runs = await syncPendingRuns(config, maxCount);

    return NextResponse.json({
      synced: runs.length,
      target: `${config.owner}/${config.repo}`,
      runs,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to sync pending runs.";
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
