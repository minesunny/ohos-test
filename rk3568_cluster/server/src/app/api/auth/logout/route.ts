import { NextRequest, NextResponse } from "next/server";

import {
  clearSessionCookie,
  getSessionTokenFromRequest,
  revokeSessionToken,
} from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const token = getSessionTokenFromRequest(request);
    revokeSessionToken(token);

    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response, request);
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "退出登录失败。",
      },
      { status: 500 },
    );
  }
}
