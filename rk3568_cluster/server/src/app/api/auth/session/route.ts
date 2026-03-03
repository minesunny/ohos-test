import { NextRequest, NextResponse } from "next/server";

import { getCurrentUserFromRequest } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const user = getCurrentUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ authenticated: false });
    }
    return NextResponse.json({ authenticated: true, user });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "读取会话失败。",
      },
      { status: 500 },
    );
  }
}
