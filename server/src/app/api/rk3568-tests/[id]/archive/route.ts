import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { getRk3568TaskById } from "@/lib/rk3568-test";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

function isArchivePathInTaskDir(taskDir: string, archivePath: string): boolean {
  const resolvedTaskDir = path.resolve(taskDir);
  const resolvedArchive = path.resolve(archivePath);
  const taskDirPrefix = resolvedTaskDir.endsWith(path.sep)
    ? resolvedTaskDir
    : `${resolvedTaskDir}${path.sep}`;
  return resolvedArchive.startsWith(taskDirPrefix);
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
    if (!task.resultArchivePath) {
      return NextResponse.json({ error: "Result archive is not ready." }, { status: 404 });
    }
    if (!isArchivePathInTaskDir(task.taskDir, task.resultArchivePath)) {
      return NextResponse.json({ error: "Invalid archive path." }, { status: 400 });
    }

    const archivePath = path.resolve(task.resultArchivePath);
    const stat = await fs.stat(archivePath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Result archive not found." }, { status: 404 });
    }

    const filename = (task.resultArchiveName || path.basename(archivePath)).replace(/"/g, "");
    const stream = createReadStream(archivePath);

    return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(stat.size),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to download RK3568 result archive.",
      },
      { status: 500 },
    );
  }
}
