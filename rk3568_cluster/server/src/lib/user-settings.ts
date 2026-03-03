import {
  DEFAULT_GITCODE_API_BASE,
  type GitCodeConfig,
  normalizeTargetKey,
  parseTargetItem,
  type GitCodeRepositoryTarget,
} from "@/lib/gitcode";
import { getAuthDb } from "@/lib/sqlite";

type UserGitCodeSettingsRow = {
  user_id: number;
  gitcode_token: string;
  repository_owner: string;
  repository_name: string;
  api_base: string;
  updated_at: string;
};

type UserGitCodeTargetRow = {
  repository_owner: string;
  repository_name: string;
  position: number;
};

export type UserGitCodeSettings = {
  userId: number;
  gitcodeToken: string;
  apiBase: string;
  repositoryTargets: GitCodeRepositoryTarget[];
  updatedAt: string;
};

type EffectiveSettings = {
  settings: UserGitCodeSettings;
  source: "user" | "env";
};

type SaveUserGitCodeSettingsInput = {
  gitcodeToken: string;
  repositoryTargets: Array<{
    owner: string;
    repo: string;
  }>;
  apiBase?: string;
};

type ResolveGitCodeConfigInput = {
  owner?: string | null;
  repo?: string | null;
  target?: string | null;
};

type ResolvedRepository = {
  owner: string;
  repo: string;
  key: string;
};

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
}

function normalizeApiBase(value: string | undefined): string {
  const normalized = normalizeText(value).replace(/\/$/, "");
  return normalized || DEFAULT_GITCODE_API_BASE;
}

function dedupeTargets(targets: GitCodeRepositoryTarget[]): GitCodeRepositoryTarget[] {
  const map = new Map<string, GitCodeRepositoryTarget>();
  for (const target of targets) {
    if (!map.has(target.key)) {
      map.set(target.key, target);
    }
  }
  return Array.from(map.values());
}

function parseTargetsFromRaw(raw: string): GitCodeRepositoryTarget[] {
  return dedupeTargets(
    raw
      .split(/[\n,;]+/)
      .map((item) => parseTargetItem(item))
      .filter((item): item is GitCodeRepositoryTarget => Boolean(item)),
  );
}

function mapTargetsInput(
  targets: Array<{
    owner: string;
    repo: string;
  }>,
): GitCodeRepositoryTarget[] {
  return dedupeTargets(
    targets
      .map((item) => parseTargetItem(`${item.owner}/${item.repo}`))
      .filter((item): item is GitCodeRepositoryTarget => Boolean(item)),
  );
}

function ensureHasTargets(targets: GitCodeRepositoryTarget[]): void {
  if (targets.length === 0) {
    throw new Error("至少需要配置一个仓库（owner/repo）。");
  }
}

function readEnvFallbackSettings(userId: number): UserGitCodeSettings | null {
  const token = normalizeText(process.env.GITCODE_TOKEN);
  let targets = parseTargetsFromRaw(normalizeText(process.env.GITCODE_TARGETS));
  if (targets.length === 0) {
    const owner = normalizeText(process.env.GITCODE_OWNER);
    const repo = normalizeText(process.env.GITCODE_REPO);
    if (owner && repo) {
      const parsed = parseTargetItem(`${owner}/${repo}`);
      if (parsed) {
        targets = [parsed];
      }
    }
  }

  if (!token || targets.length === 0) {
    return null;
  }

  return {
    userId,
    gitcodeToken: token,
    apiBase: normalizeApiBase(process.env.GITCODE_API_BASE),
    repositoryTargets: targets,
    updatedAt: "",
  };
}

function readUserSettingsRow(userId: number): UserGitCodeSettingsRow | undefined {
  const db = getAuthDb();
  return db
    .prepare(`
      SELECT user_id, gitcode_token, repository_owner, repository_name, api_base, updated_at
      FROM user_gitcode_settings
      WHERE user_id = ?
      LIMIT 1
    `)
    .get<UserGitCodeSettingsRow>(userId);
}

function readUserTargets(userId: number): GitCodeRepositoryTarget[] {
  const db = getAuthDb();
  const rows = db
    .prepare(`
      SELECT repository_owner, repository_name, position
      FROM user_gitcode_targets
      WHERE user_id = ?
      ORDER BY position ASC, repository_owner ASC, repository_name ASC
    `)
    .all<UserGitCodeTargetRow>(userId);

  return dedupeTargets(
    rows
      .map((row) => parseTargetItem(`${row.repository_owner}/${row.repository_name}`))
      .filter((item): item is GitCodeRepositoryTarget => Boolean(item)),
  );
}

function persistUserTargets(userId: number, targets: GitCodeRepositoryTarget[]): void {
  const db = getAuthDb();
  db.prepare("DELETE FROM user_gitcode_targets WHERE user_id = ?").run(userId);
  const insert = db.prepare(`
    INSERT INTO user_gitcode_targets (user_id, repository_owner, repository_name, position)
    VALUES (?, ?, ?, ?)
  `);
  targets.forEach((target, index) => {
    insert.run(userId, target.owner, target.repo, index);
  });
}

function migrateLegacySingleTarget(userId: number, row: UserGitCodeSettingsRow): GitCodeRepositoryTarget[] {
  const fallback = parseTargetItem(`${row.repository_owner}/${row.repository_name}`);
  if (!fallback) {
    return [];
  }
  persistUserTargets(userId, [fallback]);
  return [fallback];
}

function toUserSettings(
  row: UserGitCodeSettingsRow,
  targets: GitCodeRepositoryTarget[],
): UserGitCodeSettings {
  return {
    userId: row.user_id,
    gitcodeToken: row.gitcode_token,
    apiBase: row.api_base,
    repositoryTargets: targets,
    updatedAt: row.updated_at,
  };
}

export function getUserGitCodeSettings(userId: number): UserGitCodeSettings | null {
  const row = readUserSettingsRow(userId);
  if (!row) {
    return null;
  }

  let targets = readUserTargets(userId);
  if (targets.length === 0) {
    targets = migrateLegacySingleTarget(userId, row);
  }
  if (targets.length === 0) {
    return null;
  }

  return toUserSettings(row, targets);
}

export function getEffectiveUserGitCodeSettings(userId: number): EffectiveSettings | null {
  const userSettings = getUserGitCodeSettings(userId);
  if (userSettings) {
    return { settings: userSettings, source: "user" };
  }

  const fallback = readEnvFallbackSettings(userId);
  if (!fallback) {
    return null;
  }
  return { settings: fallback, source: "env" };
}

export function getRequiredUserGitCodeSettings(userId: number): UserGitCodeSettings {
  const effective = getEffectiveUserGitCodeSettings(userId);
  if (!effective) {
    throw new Error("Missing GitCode settings. Please configure token/owner/repo in account settings.");
  }
  return effective.settings;
}

function validateSettingsInput(input: SaveUserGitCodeSettingsInput): GitCodeRepositoryTarget[] {
  if (!normalizeText(input.gitcodeToken)) {
    throw new Error("GitCode Token 不能为空。");
  }

  const targets = mapTargetsInput(input.repositoryTargets);
  ensureHasTargets(targets);
  return targets;
}

export function saveUserGitCodeSettings(
  userId: number,
  input: SaveUserGitCodeSettingsInput,
): UserGitCodeSettings {
  const targets = validateSettingsInput(input);
  const db = getAuthDb();
  const now = new Date().toISOString();
  const token = normalizeText(input.gitcodeToken);
  const apiBase = normalizeApiBase(input.apiBase);
  const firstTarget = targets[0]!;

  db
    .prepare(`
      INSERT INTO user_gitcode_settings (
        user_id, gitcode_token, repository_owner, repository_name, api_base, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        gitcode_token = excluded.gitcode_token,
        repository_owner = excluded.repository_owner,
        repository_name = excluded.repository_name,
        api_base = excluded.api_base,
        updated_at = excluded.updated_at
    `)
    .run(
      userId,
      token,
      firstTarget.owner,
      firstTarget.repo,
      apiBase,
      now,
    );

  persistUserTargets(userId, targets);
  return getRequiredUserGitCodeSettings(userId);
}

function findConfiguredTarget(
  targets: GitCodeRepositoryTarget[],
  key: string,
): GitCodeRepositoryTarget | undefined {
  return targets.find((item) => item.key === key);
}

function resolveRepositorySelection(
  settings: UserGitCodeSettings,
  input: ResolveGitCodeConfigInput,
): ResolvedRepository {
  const targets = settings.repositoryTargets;
  const defaultTarget = targets[0];
  if (!defaultTarget) {
    throw new Error("Missing GitCode repository settings.");
  }

  const targetRaw = normalizeText(input.target);
  if (targetRaw) {
    const parsed = parseTargetItem(targetRaw);
    if (!parsed) {
      throw new Error(`Invalid target: ${targetRaw}. Use owner/repo.`);
    }
    const matched = findConfiguredTarget(targets, parsed.key);
    if (!matched) {
      throw new Error(`Unknown repository target: ${parsed.key}`);
    }
    return {
      owner: matched.owner,
      repo: matched.repo,
      key: matched.key,
    };
  }

  const owner = normalizeText(input.owner);
  const repo = normalizeText(input.repo);
  if ((owner && !repo) || (!owner && repo)) {
    throw new Error("owner and repo must be provided together.");
  }

  if (owner && repo) {
    const key = normalizeTargetKey(owner, repo);
    const matched = findConfiguredTarget(targets, key);
    if (!matched) {
      throw new Error(`Unknown repository target: ${key}`);
    }
    return {
      owner: matched.owner,
      repo: matched.repo,
      key: matched.key,
    };
  }

  return {
    owner: defaultTarget.owner,
    repo: defaultTarget.repo,
    key: defaultTarget.key,
  };
}

export function resolveGitCodeConfigForUser(
  userId: number,
  input: ResolveGitCodeConfigInput = {},
): { config: GitCodeConfig; selectedTarget: string; defaultTarget: string } {
  const settings = getRequiredUserGitCodeSettings(userId);
  const selected = resolveRepositorySelection(settings, input);
  const defaultTarget = settings.repositoryTargets[0]!.key;

  return {
    config: {
      apiBase: settings.apiBase,
      owner: selected.owner,
      repo: selected.repo,
      token: settings.gitcodeToken,
    },
    selectedTarget: selected.key,
    defaultTarget,
  };
}

export function listRepositoryTargetsForUser(
  userId: number,
  selectedTarget?: string,
): GitCodeRepositoryTarget[] {
  const settings = getRequiredUserGitCodeSettings(userId);
  const targets = [...settings.repositoryTargets];
  const selected = normalizeText(selectedTarget);
  if (!selected) {
    return targets;
  }

  const index = targets.findIndex((item) => item.key === selected);
  if (index <= 0) {
    return targets;
  }

  const [picked] = targets.splice(index, 1);
  return [picked!, ...targets];
}
