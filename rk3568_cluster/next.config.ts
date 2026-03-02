import type { NextConfig } from "next";

function parseAllowedDevOriginsFromEnv(): string[] {
  const raw = process.env.ALLOWED_DEV_ORIGINS;
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const allowedDevOrigins = Array.from(
  new Set([
    "172.16.1.2",
    ...parseAllowedDevOriginsFromEnv(),
  ]),
);

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins,
};

export default nextConfig;
