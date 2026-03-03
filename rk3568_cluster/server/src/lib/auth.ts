import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";
import { getAuthDb } from "@/lib/sqlite";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72;

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
};

type UserPublicRow = {
  id: number;
  username: string;
  created_at: string;
};

type SessionUserRow = {
  id: number;
  username: string;
  created_at: string;
};

type AuthResult<T> =
  | {
    ok: true;
    value: T;
  }
  | {
    ok: false;
    error: string;
    status: number;
  };

export type AuthUser = {
  id: number;
  username: string;
  createdAt: string;
};

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function validateUsername(value: string): string | null {
  if (!value) {
    return "用户名不能为空。";
  }
  if (!USERNAME_PATTERN.test(value)) {
    return "用户名需为 3-32 位，仅支持字母、数字、下划线。";
  }
  return null;
}

function validatePassword(value: string): string | null {
  if (!value) {
    return "密码不能为空。";
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位。`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return `密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位。`;
  }
  return null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hashHex] = storedHash.split(":");
  if (!salt || !hashHex) {
    return false;
  }

  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function toAuthUser(row: UserPublicRow | SessionUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    createdAt: row.created_at,
  };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createSessionToken(): string {
  return randomBytes(32).toString("hex");
}

function createSessionExpiresAt(): string {
  return new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
}

function cleanupExpiredSessions(): void {
  const db = getAuthDb();
  const now = new Date().toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}

function findUserByUsername(username: string): UserRow | undefined {
  const db = getAuthDb();
  return db
    .prepare("SELECT id, username, password_hash, created_at FROM users WHERE username = ? LIMIT 1")
    .get<UserRow>(username);
}

function findUserById(id: number): UserPublicRow | undefined {
  const db = getAuthDb();
  return db
    .prepare("SELECT id, username, created_at FROM users WHERE id = ? LIMIT 1")
    .get<UserPublicRow>(id);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}

export async function registerUser(
  usernameRaw: string,
  passwordRaw: string,
): Promise<AuthResult<AuthUser>> {
  const username = normalizeUsername(usernameRaw);
  const password = passwordRaw.trim();

  const usernameError = validateUsername(username);
  if (usernameError) {
    return { ok: false, error: usernameError, status: 400 };
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return { ok: false, error: passwordError, status: 400 };
  }

  if (findUserByUsername(username)) {
    return { ok: false, error: "用户名已存在。", status: 409 };
  }

  const db = getAuthDb();
  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);

  try {
    const result = db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, passwordHash, now);
    const userId = Number(result.lastInsertRowid);
    const user = findUserById(userId);
    if (!user) {
      return { ok: false, error: "注册成功但读取用户失败。", status: 500 };
    }
    return { ok: true, value: toAuthUser(user) };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { ok: false, error: "用户名已存在。", status: 409 };
    }
    throw error;
  }
}

export async function loginUser(
  usernameRaw: string,
  passwordRaw: string,
): Promise<AuthResult<AuthUser>> {
  const username = normalizeUsername(usernameRaw);
  const password = passwordRaw.trim();

  if (!username || !password) {
    return { ok: false, error: "用户名和密码不能为空。", status: 400 };
  }

  const user = findUserByUsername(username);
  if (!user) {
    return { ok: false, error: "用户名或密码错误。", status: 401 };
  }

  if (!verifyPassword(password, user.password_hash)) {
    return { ok: false, error: "用户名或密码错误。", status: 401 };
  }

  return {
    ok: true,
    value: {
      id: user.id,
      username: user.username,
      createdAt: user.created_at,
    },
  };
}

export function createSessionForUser(userId: number): string {
  cleanupExpiredSessions();
  const db = getAuthDb();
  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = new Date().toISOString();
  const expiresAt = createSessionExpiresAt();
  db
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(tokenHash, userId, now, expiresAt);
  return token;
}

export function revokeSessionToken(token: string | undefined): void {
  if (!token) {
    return;
  }
  const db = getAuthDb();
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
}

function parseBooleanLike(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function shouldUseSecureCookie(request?: NextRequest): boolean {
  const forced = parseBooleanLike(process.env.AUTH_COOKIE_SECURE);
  if (forced !== undefined) {
    return forced;
  }

  const forwardedProto = request?.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto === "https") {
    return true;
  }
  if (forwardedProto === "http") {
    return false;
  }

  const requestProtocol = request?.nextUrl.protocol.replace(":", "").toLowerCase();
  if (requestProtocol === "https") {
    return true;
  }
  if (requestProtocol === "http") {
    return false;
  }

  return process.env.NODE_ENV === "production";
}

export function applySessionCookie(response: NextResponse, token: string, request?: NextRequest): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse, request?: NextRequest): void {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: 0,
  });
}

export function getSessionTokenFromRequest(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

export function getCurrentUserFromRequest(request: NextRequest): AuthUser | null {
  cleanupExpiredSessions();

  const token = getSessionTokenFromRequest(request);
  if (!token) {
    return null;
  }

  const db = getAuthDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(`
      SELECT users.id AS id, users.username AS username, users.created_at AS created_at
      FROM sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
      LIMIT 1
    `)
    .get<SessionUserRow>(hashSessionToken(token), now);

  if (!row) {
    return null;
  }
  return toAuthUser(row);
}

export async function requireApiUser(
  request: NextRequest,
): Promise<{ user: AuthUser } | { response: NextResponse }> {
  const user = getCurrentUserFromRequest(request);
  if (!user) {
    return {
      response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    };
  }
  return { user };
}
