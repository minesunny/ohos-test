import { NextRequest, NextResponse } from "next/server";

import { applySessionCookie, createSessionForUser, registerUser } from "@/lib/auth";

type RegisterBody = {
  username?: string;
  password?: string;
  confirmPassword?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as RegisterBody;
    const username = body.username || "";
    const password = body.password || "";
    const confirmPassword = body.confirmPassword || "";

    if (!confirmPassword) {
      return NextResponse.json({ error: "请确认密码。" }, { status: 400 });
    }
    if (password !== confirmPassword) {
      return NextResponse.json({ error: "两次密码不一致。" }, { status: 400 });
    }

    const result = await registerUser(username, password);
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
        error: error instanceof Error ? error.message : "注册失败。",
      },
      { status: 500 },
    );
  }
}
