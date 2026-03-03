import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import {
  getEffectiveUserGitCodeSettings,
  saveUserGitCodeSettings,
} from "@/lib/user-settings";

type RepositoryTargetInput =
  | {
    owner?: string;
    repo?: string;
  }
  | string;

type SaveSettingsBody = {
  gitcodeToken?: string;
  repositoryTargets?: RepositoryTargetInput[] | string;
  repositoryOwner?: string;
  repositoryName?: string;
  apiBase?: string;
};

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
}

function parseRepositoryTargetInput(
  item: RepositoryTargetInput,
): { owner: string; repo: string } | null {
  if (typeof item === "string") {
    const value = normalizeText(item);
    if (!value) {
      return null;
    }

    const slashIndex = value.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= value.length - 1) {
      throw new Error(`Invalid repository target: ${item}`);
    }

    const owner = value.slice(0, slashIndex).trim();
    const repo = value.slice(slashIndex + 1).trim();
    if (!owner || !repo) {
      throw new Error(`Invalid repository target: ${item}`);
    }
    return { owner, repo };
  }

  const owner = normalizeText(item.owner);
  const repo = normalizeText(item.repo);
  if (!owner && !repo) {
    return null;
  }
  if (!owner || !repo) {
    throw new Error("owner and repo must be provided together.");
  }
  return { owner, repo };
}

function parseRepositoryTargets(body: SaveSettingsBody): Array<{ owner: string; repo: string }> {
  if (Array.isArray(body.repositoryTargets)) {
    return body.repositoryTargets
      .map((item) => parseRepositoryTargetInput(item))
      .filter((item): item is { owner: string; repo: string } => Boolean(item));
  }

  if (typeof body.repositoryTargets === "string") {
    return body.repositoryTargets
      .split(/[\n,;]+/)
      .map((item) => parseRepositoryTargetInput(item))
      .filter((item): item is { owner: string; repo: string } => Boolean(item));
  }

  const owner = normalizeText(body.repositoryOwner);
  const repo = normalizeText(body.repositoryName);
  if (!owner && !repo) {
    return [];
  }
  if (!owner || !repo) {
    throw new Error("owner and repo must be provided together.");
  }
  return [{ owner, repo }];
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const effective = getEffectiveUserGitCodeSettings(auth.user.id);
    if (!effective) {
      return NextResponse.json({
        hasSettings: false,
        source: "none",
      });
    }

    return NextResponse.json({
      hasSettings: true,
      source: effective.source,
      settings: {
        repositoryTargets: effective.settings.repositoryTargets,
        gitcodeToken: effective.settings.gitcodeToken,
        apiBase: effective.settings.apiBase,
        updatedAt: effective.settings.updatedAt,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to read account settings.",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as SaveSettingsBody;
    const repositoryTargets = parseRepositoryTargets(body);
    const settings = saveUserGitCodeSettings(auth.user.id, {
      gitcodeToken: body.gitcodeToken || "",
      repositoryTargets,
      apiBase: body.apiBase,
    });

    return NextResponse.json({
      settings: {
        repositoryTargets: settings.repositoryTargets,
        gitcodeToken: settings.gitcodeToken,
        apiBase: settings.apiBase,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save account settings.";
    const status = /不能为空|至少需要|invalid repository target|owner and repo must|owner\/repo|must/i.test(message)
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
