import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import {
  createPullRequestComment,
  getPullRequest,
} from "@/lib/gitcode";
import { resolveCommentActorName } from "@/lib/gitcode-comment";
import { createRun } from "@/lib/run-store";
import { resolveGitCodeConfigForUser } from "@/lib/user-settings";

type RouteContext = {
  params: Promise<{ number: string }> | { number: string };
};

type TriggerRequestBody = {
  commentBody?: string;
  target?: string;
  owner?: string;
  repo?: string;
};

function parsePrNumber(input: string): number | undefined {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireApiUser(request);
  if ("response" in auth) {
    return auth.response;
  }

  const { number } = await context.params;
  const prNumber = parsePrNumber(number);

  if (!prNumber) {
    return NextResponse.json({ error: "Invalid PR number." }, { status: 400 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as TriggerRequestBody;

    const triggerCommand = body.commentBody?.trim() || "start build";
    const { config } = resolveGitCodeConfigForUser(auth.user.id, {
      target: body.target,
      owner: body.owner,
      repo: body.repo,
    });

    const [pr, comment] = await Promise.all([
      getPullRequest(config, prNumber),
      createPullRequestComment(config, prNumber, triggerCommand),
    ]);

    const run = await createRun({
      repositoryOwner: config.owner,
      repositoryName: config.repo,
      prNumber,
      prTitle: pr.title,
      triggerCommentBody: triggerCommand,
      triggerCommentId: comment.id,
      triggerCommentUrl: comment.html_url,
      triggeredBy: resolveCommentActorName(comment, auth.user.username || "unknown"),
      triggeredAt: comment.created_at,
    });

    return NextResponse.json({ run, comment });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to trigger pipeline.";
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
