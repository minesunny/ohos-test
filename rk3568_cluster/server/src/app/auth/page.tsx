"use client";

import * as React from "react";
import { Loader2, LockKeyhole, User } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

type AuthMode = "login" | "register";

type AuthResponse = {
  error?: string;
};

async function postJson<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => ({}))) as AuthResponse;
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data as T;
}

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = React.useState<AuthMode>("login");
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const isRegister = mode === "register";
  const title = isRegister ? "创建账号" : "账号登录";
  const submitLabel = isRegister ? "注册并登录" : "登录";

  const handleSubmit = React.useCallback(async () => {
    setError(null);

    const usernameValue = username.trim();
    const passwordValue = password.trim();
    const confirmValue = confirmPassword.trim();

    if (!usernameValue) {
      setError("请输入用户名。");
      return;
    }
    if (!passwordValue) {
      setError("请输入密码。");
      return;
    }
    if (isRegister && !confirmValue) {
      setError("请确认密码。");
      return;
    }
    if (isRegister && passwordValue !== confirmValue) {
      setError("两次密码不一致。");
      return;
    }

    setSubmitting(true);
    try {
      if (isRegister) {
        await postJson("/api/auth/register", {
          username: usernameValue,
          password: passwordValue,
          confirmPassword: confirmValue,
        });
      } else {
        await postJson("/api/auth/login", {
          username: usernameValue,
          password: passwordValue,
        });
      }
      router.replace("/");
      router.refresh();
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "请求失败";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [confirmPassword, isRegister, password, router, username]);

  const handlePasswordEnter = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          <div className="flex items-center rounded-md border border-input bg-background p-0.5">
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setError(null);
              }}
              className={`rounded px-2 py-1 text-xs transition ${
                !isRegister
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setError(null);
              }}
              className={`rounded px-2 py-1 text-xs transition ${
                isRegister
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              注册
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </div>
        )}

        <label className="mb-3 grid gap-1">
          <span className="text-xs text-muted-foreground">用户名</span>
          <div className="relative">
            <User className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={handlePasswordEnter}
              placeholder="3-32 位，字母数字下划线"
              autoComplete="username"
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            />
          </div>
        </label>

        <label className="mb-3 grid gap-1">
          <span className="text-xs text-muted-foreground">密码</span>
          <div className="relative">
            <LockKeyhole className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={handlePasswordEnter}
              placeholder="至少 8 位"
              autoComplete={isRegister ? "new-password" : "current-password"}
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            />
          </div>
        </label>

        {isRegister && (
          <label className="mb-3 grid gap-1">
            <span className="text-xs text-muted-foreground">确认密码</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onKeyDown={handlePasswordEnter}
              placeholder="再次输入密码"
              autoComplete="new-password"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none ring-ring placeholder:text-muted-foreground focus:ring-1"
            />
          </label>
        )}

        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="h-9 w-full"
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </main>
  );
}
