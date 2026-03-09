import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { listRuns } from "@/lib/run-store";

function parsePrNumber(raw: string | null): number | undefined {
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function parseTarget(raw: string | null): { owner: string; repo: string } | undefined {
  if (!raw) {
    return undefined;
  }

  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  const index = value.indexOf("/");
  if (index <= 0 || index >= value.length - 1) {
    return undefined;
  }

  const owner = value.slice(0, index).trim();
  const repo = value.slice(index + 1).trim();
  if (!owner || !repo) {
    return undefined;
  }

  return { owner, repo };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const prNumber = parsePrNumber(request.nextUrl.searchParams.get("prNumber"));
    const targetInput = request.nextUrl.searchParams.get("target");
    const target = parseTarget(targetInput);
    if (targetInput && !target) {
      return NextResponse.json({ error: "Invalid target. Use owner/repo." }, { status: 400 });
    }

    const runs = (await listRuns(prNumber)).filter((run) => {
      if (!target) {
        return true;
      }
      return run.repositoryOwner === target.owner && run.repositoryName === target.repo;
    });

    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch runs.",
      },
      { status: 500 },
    );
  }
}
