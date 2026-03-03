import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { getRk3568TaskById, getRk3568TaskLogById } from "@/lib/rk3568-test";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

function parsePositiveInt(input: string | null): number | undefined {
  if (!input) {
    return undefined;
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireApiUser(request);
  if ("response" in auth) {
    return auth.response;
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Task id is required." }, { status: 400 });
  }

  try {
    const task = await getRk3568TaskById(id);
    if (!task) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    const url = new URL(request.url);
    const includeLog = url.searchParams.get("includeLog") === "1";
    if (!includeLog) {
      return NextResponse.json({ task });
    }

    const fullLog = url.searchParams.get("fullLog") === "1";
    const logLines = parsePositiveInt(url.searchParams.get("logLines")) || 300;
    const maxLines = fullLog ? 0 : Math.min(logLines, 2000);
    const log = await getRk3568TaskLogById(id, maxLines);
    return NextResponse.json({
      task,
      log,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch RK3568 task.",
      },
      { status: 500 },
    );
  }
}
