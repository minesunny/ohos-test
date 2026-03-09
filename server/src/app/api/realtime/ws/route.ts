import { NextRequest, NextResponse } from "next/server";

import { requireApiUser } from "@/lib/auth";
import { ensureRealtimeWsServer, getRealtimeWsPublicUrl } from "@/lib/realtime-ws";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireApiUser(request);
    if ("response" in auth) {
      return auth.response;
    }

    const runtime = ensureRealtimeWsServer();
    const url = getRealtimeWsPublicUrl(request.url);
    return NextResponse.json({
      url,
      port: runtime.port,
      host: runtime.host,
      startedAt: runtime.startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to initialize realtime websocket.",
      },
      { status: 500 },
    );
  }
}
