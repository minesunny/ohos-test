import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { syncRunWithGitCode } from "@/lib/pipeline-sync";
import {
  createRk3568Task,
  enqueueRk3568Task,
  listRk3568Tasks,
} from "@/lib/rk3568-test";
import { getRunById } from "@/lib/run-store";
import { resolveGitCodeConfigForUser } from "@/lib/user-settings";

type StartRk3568Body = {
  runId?: string;
  pipelineUrl?: string;
  prNumber?: number;
  repositoryOwner?: string;
  repositoryName?: string;
  testType?: "tdd";
  testCaseName?: string;
  requestedDeviceSerial?: string;
};

function parsePositiveInt(input: string | null | undefined): number | undefined {
  if (!input) {
    return undefined;
  }
  const value = Number(input);
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

function isValidPipelineUrl(value: string): boolean {
  return /^https?:\/\/dcp\.openharmony\.cn\/workbench\/cicd\/detail\/[a-z0-9_-]+\/runlist/i.test(value);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const targetInput = request.nextUrl.searchParams.get("target");
    const target = parseTarget(targetInput);
    if (targetInput && !target) {
      return NextResponse.json({ error: "Invalid target. Use owner/repo." }, { status: 400 });
    }

    const prNumber = parsePositiveInt(request.nextUrl.searchParams.get("prNumber"));
    const limit = parsePositiveInt(request.nextUrl.searchParams.get("limit"));
    const pipelineUrlInput = request.nextUrl.searchParams.get("pipelineUrl")?.trim();
    if (pipelineUrlInput && !isValidPipelineUrl(pipelineUrlInput)) {
      return NextResponse.json({ error: "Invalid pipeline URL." }, { status: 400 });
    }
    const tasks = await listRk3568Tasks({
      repositoryOwner: target?.owner,
      repositoryName: target?.repo,
      prNumber,
      pipelineUrl: pipelineUrlInput || undefined,
      limit,
    });

    return NextResponse.json({ tasks });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch RK3568 tasks.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const body = (await request.json().catch(() => ({}))) as StartRk3568Body;
    const testType = body.testType || "tdd";
    if (testType !== "tdd") {
      return NextResponse.json({ error: "Only TDD test type is supported currently." }, { status: 400 });
    }

    let runId = body.runId?.trim();
    let pipelineUrl = body.pipelineUrl?.trim();
    let repositoryOwner = body.repositoryOwner?.trim();
    let repositoryName = body.repositoryName?.trim();
    let prNumber = body.prNumber;

    if (runId) {
      let run = await getRunById(runId);
      if (!run) {
        runId = undefined;
      } else {
        if (run.status !== "success") {
          const { config } = resolveGitCodeConfigForUser(auth.user.id, {
            owner: run.repositoryOwner,
            repo: run.repositoryName,
          });
          try {
            run = await syncRunWithGitCode(config, run.id);
          } catch {
            // Keep original status and return a clear validation error below.
          }
        }

        if (run.status !== "success") {
          return NextResponse.json({ error: "Only successful pipeline run can start RK3568 test." }, { status: 400 });
        }
        if (!run.pipelineUrl) {
          return NextResponse.json({ error: "Selected run has no pipeline URL." }, { status: 400 });
        }

        pipelineUrl = run.pipelineUrl;
        repositoryOwner = run.repositoryOwner;
        repositoryName = run.repositoryName;
        prNumber = run.prNumber;
      }
    }

    if (!pipelineUrl || !isValidPipelineUrl(pipelineUrl)) {
      return NextResponse.json({ error: "Invalid pipeline URL." }, { status: 400 });
    }
    if (!repositoryOwner || !repositoryName) {
      return NextResponse.json({ error: "repositoryOwner/repositoryName is required." }, { status: 400 });
    }
    if (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0) {
      return NextResponse.json({ error: "Valid prNumber is required." }, { status: 400 });
    }
    const resolvedPrNumber = Number(prNumber);

    const task = await createRk3568Task({
      runId,
      repositoryOwner,
      repositoryName,
      prNumber: resolvedPrNumber,
      pipelineUrl,
      testCaseName: body.testCaseName,
      requestedDeviceSerial: body.requestedDeviceSerial,
    });

    enqueueRk3568Task(task.id);

    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to start RK3568 test task.",
      },
      { status: 500 },
    );
  }
}
