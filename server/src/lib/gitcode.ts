import { execFile } from "node:child_process";

import {
  type GitCodeApiError,
  type GitCodePullRequest,
  type GitCodePullRequestComment,
} from "@/types/gitcode";

type QueryValue = string | number | boolean | null | undefined;

type QueryRecord = Record<string, QueryValue>;

type HttpMethod = "GET" | "POST";

type GitCodeRequestOptions = {
  method?: HttpMethod;
  query?: QueryRecord;
  body?: QueryRecord;
};

type CurlResponse = {
  status: number;
  body: string;
};

export type GitCodeConfig = {
  apiBase: string;
  owner: string;
  repo: string;
  token?: string;
};

export type GitCodeRepositoryTarget = {
  key: string;
  owner: string;
  repo: string;
};

export type PullRequestFilterState = "open" | "closed" | "all";

type PullRequestListOptions = {
  page?: number;
  perPage?: number;
};

const API_BASE_CANDIDATES = [
  "https://api.gitcode.com/api/v5",
  "https://gitcode.com/api/v5",
];

export const DEFAULT_GITCODE_API_BASE = API_BASE_CANDIDATES[0];

class GitCodeHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function normalizeBase(url: string): string {
  return url.replace(/\/$/, "");
}

function getRequiredEnv(...keys: string[]): string {
  const value = keys
    .map((key) => process.env[key]?.trim())
    .find((candidate) => Boolean(candidate));

  if (!value) {
    throw new Error(`Missing required environment variable: ${keys.join(" or ")}`);
  }

  return value;
}

export function normalizeTargetKey(owner: string, repo: string): string {
  return `${owner.trim()}/${repo.trim()}`;
}

export function parseTargetItem(rawItem: string): GitCodeRepositoryTarget | undefined {
  const item = rawItem.trim();
  if (!item) {
    return undefined;
  }

  const slashIndex = item.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= item.length - 1) {
    return undefined;
  }

  const owner = item.slice(0, slashIndex).trim();
  const repo = item.slice(slashIndex + 1).trim();
  if (!owner || !repo) {
    return undefined;
  }

  return {
    key: normalizeTargetKey(owner, repo),
    owner,
    repo,
  };
}

function parseTargetsFromEnv(raw: string): GitCodeRepositoryTarget[] {
  const parsed = raw
    .split(/[\n,;]+/)
    .map((item) => parseTargetItem(item))
    .filter((item): item is GitCodeRepositoryTarget => Boolean(item));

  const deduped = new Map<string, GitCodeRepositoryTarget>();
  for (const item of parsed) {
    if (!deduped.has(item.key)) {
      deduped.set(item.key, item);
    }
  }

  return Array.from(deduped.values());
}

function getConfiguredTargetsFromEnv(): GitCodeRepositoryTarget[] {
  const rawTargets = process.env.GITCODE_TARGETS?.trim();
  if (rawTargets) {
    const parsed = parseTargetsFromEnv(rawTargets);
    if (parsed.length > 0) {
      return parsed;
    }
    throw new Error(
      "Invalid GITCODE_TARGETS. Use comma/newline separated owner/repo entries.",
    );
  }

  const owner = getRequiredEnv("GITCODE_OWNER");
  const repo = getRequiredEnv("GITCODE_REPO");

  return [
    {
      key: normalizeTargetKey(owner, repo),
      owner,
      repo,
    },
  ];
}

function getApiBaseFromEnv(): string {
  return normalizeBase(
    process.env.GITCODE_API_BASE?.trim()
    || DEFAULT_GITCODE_API_BASE,
  );
}

function getTokenFromEnv(): string {
  return getRequiredEnv("GITCODE_TOKEN");
}

export function listGitCodeRepositoryTargetsFromEnv(): GitCodeRepositoryTarget[] {
  return getConfiguredTargetsFromEnv();
}

export function getGitCodeConfigsFromEnv(): GitCodeConfig[] {
  const token = getTokenFromEnv();
  const apiBase = getApiBaseFromEnv();
  return getConfiguredTargetsFromEnv().map((target) => ({
    apiBase,
    owner: target.owner,
    repo: target.repo,
    token,
  }));
}

export function getGitCodeConfigFromEnv(): GitCodeConfig {
  return getGitCodeConfigsFromEnv()[0]!;
}

export function getGitCodeConfigFromEnvByTarget(target?: string): GitCodeConfig {
  const configs = getGitCodeConfigsFromEnv();
  if (!target?.trim()) {
    return configs[0]!;
  }

  const expected = parseTargetItem(target);
  if (!expected) {
    throw new Error(`Invalid target: ${target}. Use owner/repo.`);
  }

  const matched = configs.find(
    (config) => normalizeTargetKey(config.owner, config.repo) === expected.key,
  );

  if (!matched) {
    throw new Error(`Unknown repository target: ${expected.key}`);
  }

  return matched;
}

export function getGitCodeConfigFromEnvForRepository(owner: string, repo: string): GitCodeConfig {
  const key = normalizeTargetKey(owner, repo);
  return getGitCodeConfigFromEnvByTarget(key);
}

function createSearchParams(values: QueryRecord): URLSearchParams {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    params.set(key, String(value));
  });
  return params;
}

function parseApiErrorMessage(payload: GitCodeApiError): string | undefined {
  if (payload.message) {
    return payload.message;
  }
  if (payload.error_message) {
    return payload.error_message;
  }
  if (payload.error) {
    return payload.error;
  }
  return undefined;
}

function getErrorMessage(status: number, body: string): string {
  const text = body.trim();

  if (!text) {
    return `GitCode request failed with status ${status}`;
  }

  try {
    const payload = JSON.parse(text) as GitCodeApiError;
    const apiMessage = parseApiErrorMessage(payload);
    if (apiMessage) {
      return apiMessage;
    }
  } catch {
    // fallback to plain text
  }

  return text;
}

function parseCurlOutput(stdout: string): CurlResponse {
  const markerIndex = stdout.lastIndexOf("\n");
  if (markerIndex < 0) {
    throw new Error("Unexpected curl output format.");
  }

  const statusLine = stdout.slice(markerIndex + 1).trim();
  if (!/^\d{3}$/.test(statusLine)) {
    throw new Error("Unexpected curl status code format.");
  }

  return {
    status: Number(statusLine),
    body: stdout.slice(0, markerIndex),
  };
}

async function curlRequest(
  url: string,
  method: HttpMethod,
  token: string,
  body?: QueryRecord,
): Promise<CurlResponse> {
  const args = [
    "-sS",
    "--connect-timeout",
    "8",
    "--max-time",
    "12",
    "-X",
    method,
    "-H",
    "Accept: application/json",
    "-H",
    `PRIVATE-TOKEN: ${token}`,
    "-H",
    `Authorization: Bearer ${token}`,
    "-w",
    "\n%{http_code}",
  ];

  if (method === "POST") {
    const payload = createSearchParams(body ?? {}).toString();
    args.push(
      "-H",
      "Content-Type: application/x-www-form-urlencoded",
      "--data",
      payload,
    );
  }

  args.push(url);

  return await new Promise<CurlResponse>((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr.trim() || error.message;
        reject(new Error(`curl request failed: ${details}`));
        return;
      }

      try {
        resolve(parseCurlOutput(stdout));
      } catch (parseError) {
        const details = stderr.trim();
        const message = parseError instanceof Error ? parseError.message : "parse error";
        reject(
          new Error(
            details ? `${message} (${details})` : message,
          ),
        );
      }
    });
  });
}

async function gitcodeRequest<T>(
  config: GitCodeConfig,
  path: string,
  options: GitCodeRequestOptions = {},
): Promise<T> {
  if (!config.token) {
    throw new Error("Missing GITCODE_TOKEN. GitCode API requires authentication.");
  }

  const method = options.method ?? "GET";
  const query: QueryRecord = {
    ...(options.query ?? {}),
  };

  const bases = [config.apiBase, ...API_BASE_CANDIDATES.map(normalizeBase)]
    .filter((base, index, array) => array.indexOf(base) === index);
  const queryString = createSearchParams(query).toString();

  let lastNetworkError: unknown;

  for (const base of bases) {
    const url = `${base}${path}${queryString ? `?${queryString}` : ""}`;

    try {
      const response = await curlRequest(url, method, config.token, options.body);

      if (response.status < 200 || response.status >= 300) {
        throw new GitCodeHttpError(
          getErrorMessage(response.status, response.body),
          response.status,
        );
      }

      try {
        return JSON.parse(response.body) as T;
      } catch {
        throw new Error("GitCode API returned non-JSON response.");
      }
    } catch (error) {
      if (error instanceof GitCodeHttpError) {
        throw error;
      }
      lastNetworkError = error;
    }
  }

  const message = lastNetworkError instanceof Error
    ? lastNetworkError.message
    : "unknown network error";

  throw new Error(`Failed to reach GitCode API: ${message}`);
}

export async function listPullRequests(
  config: GitCodeConfig,
  state: PullRequestFilterState = "open",
  options: PullRequestListOptions = {},
): Promise<GitCodePullRequest[]> {
  const page = Number.isInteger(options.page) && (options.page ?? 0) > 0
    ? options.page ?? 1
    : 1;
  const perPage = Number.isInteger(options.perPage) && (options.perPage ?? 0) > 0
    ? Math.min(options.perPage ?? 100, 100)
    : 100;

  return gitcodeRequest<GitCodePullRequest[]>(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/pulls`,
    {
      query: {
        state,
        sort: "updated",
        direction: "desc",
        page,
        per_page: perPage,
      },
    },
  );
}

export async function getPullRequest(
  config: GitCodeConfig,
  number: number,
): Promise<GitCodePullRequest> {
  return gitcodeRequest<GitCodePullRequest>(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/pulls/${number}`,
  );
}

export async function createPullRequestComment(
  config: GitCodeConfig,
  number: number,
  body: string,
): Promise<GitCodePullRequestComment> {
  return gitcodeRequest<GitCodePullRequestComment>(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/pulls/${number}/comments`,
    {
      method: "POST",
      body: {
        body,
      },
    },
  );
}

export async function listPullRequestComments(
  config: GitCodeConfig,
  number: number,
  page = 1,
  perPage = 100,
): Promise<GitCodePullRequestComment[]> {
  return gitcodeRequest<GitCodePullRequestComment[]>(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/pulls/${number}/comments`,
    {
      query: {
        page,
        per_page: perPage,
      },
    },
  );
}
