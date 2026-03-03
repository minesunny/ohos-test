import { NextRequest, NextResponse } from "next/server";

import { applySessionCookie, createSessionForUser, loginUser } from "@/lib/auth";

type LoginBody = {
  username?: string;
  password?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as LoginBody;
    const result = await loginUser(body.username || "", body.password || "");
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const token = createSessionForUser(result.value.id);
    const response = NextResponse.json({ user: result.value });
    applySessionCookie(response, token, request);
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "登录失败。",
      },
      { status: 500 },
    );
  }
}
