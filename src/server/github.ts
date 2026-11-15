import crypto from "node:crypto";
import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { REPO_REGEX } from "../shared/constants.js";
import { tierForStars, type Tier } from "../shared/economics.js";

const MIN_REPO_AGE_MS = 60 * 60 * 1000;
const MIN_REPO_AGE_LABEL = "1 hour";

export class GithubError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "GITHUB_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GithubRepoData {
  githubId: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  language: string | null;
  topics: string[];
  license: string | null;
  defaultBranch: string;
  createdAt: string;
  pushedAt: string;
  sizeKb: number;
  isFork: boolean;
  isPrivate: boolean;
  isArchived: boolean;
  commitCount: number;
  lastCommitAt: string | null;
  healthScore: number;
  readme: string | null;
  readmeSha: string | null;
  readmeUrl: string | null;
}

interface ApiRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  homepage: string | null;
  stargazers_count: number;
  forks_count: number;
  subscribers_count?: number;
  watchers_count: number;
  open_issues_count: number;
  language: string | null;
  topics?: string[];
  license: { spdx_id?: string; name?: string } | null;
  default_branch: string;
  created_at: string;
  pushed_at: string;
  size: number;
  fork: boolean;
  private: boolean;
  archived: boolean;
}

const memoryCache = new Map<string, { data: GithubRepoData; at: number }>();
const CACHE_TTL = 1000 * 60 * 8;
const README_CACHE = new Map<string, { markdown: string; sha: string; url: string; at: number }>();

const githubBudget = {
  remaining: config.githubToken ? 5_000 : 60,
  resetAt: 0,
  limitedUntil: 0,
};

function recordGitHubBudget(headers: Headers): void {
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(remaining)) githubBudget.remaining = remaining;
  if (Number.isFinite(reset) && reset > 0) githubBudget.resetAt = reset * 1000;
  if (remaining === 0) {
    githubBudget.limitedUntil = Math.max(Date.now() + 30_000, githubBudget.resetAt);
  }
}

function apiBudgetAvailable(): boolean {
  const now = Date.now();
  if (githubBudget.resetAt > now) {
    if (githubBudget.limitedUntil > now) return false;
    if (!config.githubToken && githubBudget.remaining <= 4) return false;
  } else if (githubBudget.resetAt !== 0 && githubBudget.resetAt <= now) {
    githubBudget.remaining = config.githubToken ? 5_000 : 60;
    githubBudget.limitedUntil = 0;
  }
  return true;
}

export function normalizeRepo(input: string): string {
  let value = input.trim();
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (!/(^|\.)github\.com$/i.test(url.hostname)) {
        throw new GithubError("Only github.com repository URLs are supported.", 400, "INVALID_REPO");
      }
      value = url.pathname.replace(/^\/+|\/+$/g, "");
    }
  } catch (error) {
    if (error instanceof GithubError) throw error;
    throw new GithubError("Enter a valid GitHub repository URL or owner/repo.", 400, "INVALID_REPO");
  }
  value = value
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .replace(/^\/+/, "");
  const parts = value.split("/");
  if (parts.length > 2) value = parts.slice(0, 2).join("/");
  if (!REPO_REGEX.test(value)) {
    throw new GithubError("Use the format owner/repository.", 400, "INVALID_REPO");
  }
  return value;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "GitFi.fun/1.0 (+https://gitfi.fun)",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  return headers;
}

async function githubJson(url: string): Promise<{ body: unknown; headers: Headers }> {
  if (!apiBudgetAvailable()) {
    throw new GithubError(
      "GitHub's REST budget is exhausted. Falling back to the public repository page.",
      429,
      "GITHUB_RATE_LIMIT",
    );
  }
  const res = await fetch(url, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(12_000),
  });
  recordGitHubBudget(res.headers);
  if (res.status === 404) {
    throw new GithubError(
      "Repository not found. It may be private, deleted, or misspelled.",
      404,
      "REPO_NOT_FOUND",
    );
  }
  if (res.status === 403 || res.status === 429) {
    githubBudget.limitedUntil = Math.max(Date.now() + 60_000, githubBudget.resetAt);
    throw new GithubError(
      "GitHub is rate-limiting metadata requests. Try again in a minute.",
      429,
      "GITHUB_RATE_LIMIT",
    );
  }
  if (!res.ok) {
    throw new GithubError(`GitHub metadata request failed (${res.status}).`, 502, "GITHUB_UPSTREAM");
  }
  return { body: await res.json(), headers: res.headers };
}

async function fetchCommitInfo(
  fullName: string,
): Promise<{ count: number; lastCommitAt: string | null }> {
  if (!apiBudgetAvailable()) return { count: 0, lastCommitAt: null };
  try {
    const { body, headers } = await githubJson(
      `https://api.github.com/repos/${fullName}/commits?per_page=1`,
    );
    const commits = body as Array<{ commit?: { committer?: { date?: string } } }>;
    const lastCommitAt = commits[0]?.commit?.committer?.date ?? null;
    const link = headers.get("link");
    if (link) {
      const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      if (match?.[1]) return { count: Number(match[1]), lastCommitAt };
    }
    return { count: commits.length, lastCommitAt };
  } catch {
    return { count: 0, lastCommitAt: null };
  }
}

function parseNumber(html: string, pattern: RegExp, fallback = 0): number {
  const match = html.match(pattern);
  if (!match?.[1]) return fallback;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : fallback;
}

function parseBool(html: string, pattern: RegExp, fallback = false): boolean {
  const match = html.match(pattern);
  if (!match?.[1]) return fallback;
  return match[1] === "true";
}

async function latestCommitAt(fullName: string, branch: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://github.com/${fullName}/commits/${encodeURIComponent(branch)}.atom`,
      {
        headers: {
          "User-Agent": "GitFi.fun/1.0 (+https://gitfi.fun)",
          Accept: "application/atom+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return null;
    const feed = await res.text();
    const entry = feed.match(/<entry>[\s\S]*?<updated>([^<]+)<\/updated>/i);
    return entry?.[1] ? new Date(entry[1]).toISOString() : null;
  } catch {
    return null;
  }
}

async function latestCommitSha(fullName: string, branch: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://github.com/${fullName}/commits/${encodeURIComponent(branch)}.atom`,
      {
        headers: {
          "User-Agent": "GitFi.fun/1.0 (+https://gitfi.fun)",
          Accept: "application/atom+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return null;
    const feed = await res.text();
    const entry = feed.match(/<entry>[\s\S]*?<id>[^<]*Commit\/([a-f0-9]{40})<\/id>/i);
    return entry?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readmeAtCommit(fullName: string, sha: string): Promise<{
  markdown: string;
  sha: string;
  url: string;
} | null> {
  const names = ["README.md", "readme.md", "Readme.md", "README.MD"];
  for (const name of names) {
    try {
      const url = `https://raw.githubusercontent.com/${fullName}/${sha}/${name}`;
      const res = await fetch(`${url}?v=${Date.now()}`, {
        headers: {
          "User-Agent": "GitFi.fun/1.0 (+https://gitfi.fun)",
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const markdown = await res.text();
      if (!markdown.trim()) continue;
      const digest = crypto.createHash("sha256").update(markdown).digest("hex");
      const cacheKey = fullName.toLowerCase();
      README_CACHE.set(cacheKey, { markdown, sha: digest, url, at: Date.now() });
      return { markdown, sha: digest, url };
    } catch {
    }
  }
  return null;
}

async function loadGithubRepoFromHtml(
  input: string,
  opts: { requireReadme?: boolean; skipReadme?: boolean } = {},
): Promise<GithubRepoData> {
  const fullName = normalizeRepo(input);
  const page = await fetch(`https://github.com/${fullName}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; GitFi.fun/1.0; +https://gitfi.fun)",
      Accept: "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (page.status === 404) {
    throw new GithubError(
      "Repository not found. It may be private, deleted, or misspelled.",
      404,
      "REPO_NOT_FOUND",
    );
  }
  if (!page.ok) {
    throw new GithubError(
      "GitHub is temporarily unavailable. Try again in a moment.",
      502,
      "GITHUB_UPSTREAM",
    );
  }
  const html = await page.text();
  const isFork = parseBool(html, /"isFork":(true|false)/);
  const isArchived = parseBool(html, /"isArchived":(true|false)/);
  const isEmpty = parseBool(html, /"isEmpty":(true|false)/);
  const isPrivate = parseBool(html, /"isPrivate":(true|false)/);
  if (isPrivate) throw new GithubError("Private repositories are not supported.", 422, "REPO_PRIVATE");
  if (isFork) throw new GithubError("Forks cannot be tokenized. Launch the upstream repository.", 422, "REPO_FORK");
  if (isArchived) throw new GithubError("Archived repositories cannot be launched.", 422, "REPO_ARCHIVED");
  if (isEmpty) throw new GithubError("Empty repositories cannot be launched.", 422, "REPO_EMPTY");

  const branch = html.match(/"defaultBranch":"([^"]+)"/)?.[1] ?? "main";
  const stars = parseNumber(html, /"stargazerCount":(\d+)/);
  const forks = parseNumber(html, /"forksCount":(\d+)/);
  const watchers = parseNumber(html, /"watcherCount":(\d+)/);
  const openIssues = parseNumber(html, /"issueCount":(\d+)/);
  const commitCount = parseNumber(html, /"commitCount":"?(\d+)"?/);
  const createdAt =
    html.match(/"createdAt":"([^"]+)"/)?.[1] ?? new Date(Date.now() - 86_400_000).toISOString();
  const license = html.match(/"license":\{"spdxId":"([^"]+)"/)?.[1] ?? null;
  const description =
    html.match(/<meta name="description" content="([^"]*)"/)?.[1]?.replace(
      new RegExp(`\\s+-\\s+${fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"),
      "",
    ) ?? null;
  const pushedAt = (await latestCommitAt(fullName, branch)) ?? new Date().toISOString();
  const createdMs = Date.now() - new Date(createdAt).getTime();
  const pushedDays = (Date.now() - new Date(pushedAt).getTime()) / 86_400_000;
  if (createdMs < MIN_REPO_AGE_MS) {
    throw new GithubError(
      `Repositories must be at least ${MIN_REPO_AGE_LABEL} old before they can be indexed.`,
      422,
      "REPO_TOO_NEW",
    );
  }
  if (pushedDays > 730) {
    throw new GithubError(
      "This repository has been dormant for more than two years. Revive it before launching.",
      422,
      "REPO_INACTIVE",
    );
  }
  const [owner, name] = fullName.split("/") as [string, string];
  const githubId =
    parseNumber(html, /"repositoryId":(\d+)/) ||
    parseNumber(html, /"repo":\{"id":(\d+)/) ||
    crypto.createHash("sha1").update(fullName.toLowerCase()).digest().readUInt32BE(0);
  const health = healthScore({
    stars,
    forks,
    openIssues,
    sizeKb: 100,
    createdAt,
    pushedAt,
    commitCount,
    isArchived,
  });
  let readme: { markdown: string; sha: string; url: string } | null = null;
  if (!opts.skipReadme) {
    try {
      readme = await fetchReadme(fullName, branch, true);
    } catch (error) {
      if (opts.requireReadme) throw error;
    }
  }
  const data: GithubRepoData = {
    githubId,
    fullName,
    owner,
    name,
    description,
    homepage: null,
    stars,
    forks,
    watchers,
    openIssues,
    language: null,
    topics: [],
    license,
    defaultBranch: branch,
    createdAt,
    pushedAt,
    sizeKb: 100,
    isFork,
    isPrivate,
    isArchived,
    commitCount,
    lastCommitAt: pushedAt,
    healthScore: health,
    readme: readme?.markdown ?? null,
    readmeSha: readme?.sha ?? null,
    readmeUrl: readme?.url ?? null,
  };
  memoryCache.set(fullName.toLowerCase(), { data, at: Date.now() });
  return data;
}

export async function fetchReadmeAtLatestCommit(
  fullName: string,
  branch: string,
): Promise<{ markdown: string; sha: string; url: string } | null> {
  const sha = await latestCommitSha(fullName, branch);
  if (!sha) return null;
  return readmeAtCommit(fullName, sha);
}

function healthScore(input: {
  stars: number;
  forks: number;
  openIssues: number;
  sizeKb: number;
  createdAt: string;
  pushedAt: string;
  commitCount: number;
  isArchived: boolean;
}): number {
  let score = 44;
  const ageDays = Math.max(0, (Date.now() - new Date(input.createdAt).getTime()) / 86_400_000);
  const pushedDays = Math.max(0, (Date.now() - new Date(input.pushedAt).getTime()) / 86_400_000);
  if (pushedDays <= 14) score += 22;
  else if (pushedDays <= 45) score += 16;
  else if (pushedDays <= 120) score += 8;
  else if (pushedDays <= 365) score += 0;
  else score -= 18;
  if (input.commitCount >= 1000) score += 14;
  else if (input.commitCount >= 200) score += 11;
  else if (input.commitCount >= 30) score += 7;
  else if (input.commitCount >= 5) score += 3;
  else score -= 10;
  if (ageDays >= 365) score += 8;
  else if (ageDays >= 90) score += 5;
  else if (ageDays < 7) score -= 12;
  if (input.stars > 0) {
    const forkRatio = input.forks / input.stars;
    if (forkRatio >= 0.02 && forkRatio <= 0.4) score += 7;
    else if (forkRatio < 0.005) score -= 5;
  }
  if (input.stars >= 1000) score += 5;
  if (input.sizeKb < 8) score -= 15;
  if (input.isArchived) score -= 28;
  if (input.openIssues > input.stars * 0.5 + 50) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function healthLabel(score: number): "healthy" | "watch" | "degraded" {
  if (score >= 75) return "healthy";
  if (score >= 50) return "watch";
  return "degraded";
}

async function fetchReadme(
  fullName: string,
  defaultBranch: string,
  forceFresh = false,
): Promise<{ markdown: string; sha: string; url: string }> {
  const cacheKey = fullName.toLowerCase();
  const cached = README_CACHE.get(cacheKey);
  if (!forceFresh && cached && Date.now() - cached.at < CACHE_TTL) return cached;
  const branches = [...new Set([defaultBranch, "main", "master"].filter(Boolean))];
  const names = ["README.md", "readme.md", "Readme.md", "README.MD"];
  for (const branch of branches) {
    for (const name of names) {
      const encodedBranch = branch
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      const url = `https://raw.githubusercontent.com/${fullName}/${encodedBranch}/${name}`;
      try {
        const res = await fetch(`${url}?v=${forceFresh ? Date.now() : 1}`, {
          headers: {
            "User-Agent": "GitFi.fun/1.0 (+https://gitfi.fun)",
            "Cache-Control": forceFresh ? "no-cache" : "max-age=300",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const markdown = await res.text();
        if (!markdown.trim()) continue;
        if (markdown.length > 1_500_000) {
          throw new GithubError(
            "This README is too large to verify. Keep it under 1.5 MB.",
            422,
            "README_TOO_LARGE",
          );
        }
        const sha = crypto.createHash("sha256").update(markdown).digest("hex");
        const result = { markdown, sha, url };
        README_CACHE.set(cacheKey, { ...result, at: Date.now() });
        return result;
      } catch {
      }
    }
  }
  throw new GithubError(
    "No public README.md was found. Add a README to the default branch and try again.",
    422,
    "README_MISSING",
  );
}

export async function fetchReadmeFromApi(
  fullName: string,
  defaultBranch: string,
): Promise<{ markdown: string; sha: string; url: string } | null> {
  if (!apiBudgetAvailable()) return null;
  const branches = [...new Set([defaultBranch, "main", "master"].filter(Boolean))];
  const names = ["README.md", "readme.md", "Readme.md", "README.MD"];
  for (const branch of branches) {
    for (const name of names) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(branch)}`,
          {
            headers: {
              ...apiHeaders(),
              Accept: "application/vnd.github+json",
              "Cache-Control": "no-cache",
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) continue;
        const body = (await res.json()) as {
          type?: string;
          content?: string;
          encoding?: string;
          download_url?: string;
          sha?: string;
        };
        if (body.type !== "file" || !body.content) continue;
        const markdown =
          body.encoding === "base64"
            ? Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8")
            : body.content;
        if (!markdown.trim()) continue;
        if (markdown.length > 1_500_000) {
          throw new GithubError(
            "This README is too large to verify. Keep it under 1.5 MB.",
            422,
            "README_TOO_LARGE",
          );
        }
        const sha = crypto.createHash("sha256").update(markdown).digest("hex");
        const url = `https://github.com/${fullName}/blob/${branch}/${name}`;
        README_CACHE.set(fullName.toLowerCase(), { markdown, sha, url, at: Date.now() });
        return { markdown, sha, url };
      } catch (error) {
        if (error instanceof GithubError) throw error;
      }
    }
  }
  return null;
}

export async function loadGithubRepo(
  input: string,
  opts: { requireReadme?: boolean; forceFresh?: boolean; skipReadme?: boolean } = {},
): Promise<GithubRepoData> {
  const fullName = normalizeRepo(input);
  const cacheKey = fullName.toLowerCase();
  const cached = memoryCache.get(cacheKey);
  if (!opts.forceFresh && cached && Date.now() - cached.at < CACHE_TTL) {
    if (!opts.requireReadme || cached.data.readme) return cached.data;
  }
  if (!apiBudgetAvailable()) {
    return loadGithubRepoFromHtml(fullName, opts);
  }
  let repo: ApiRepo;
  try {
    const { body } = await githubJson(`https://api.github.com/repos/${fullName}`);
    repo = body as ApiRepo;
  } catch (error) {
    if (
      error instanceof GithubError &&
      (error.code === "GITHUB_RATE_LIMIT" || error.code === "GITHUB_UPSTREAM")
    ) {
      return loadGithubRepoFromHtml(fullName, opts);
    }
    throw error;
  }
  if (repo.private) throw new GithubError("Private repositories are not supported.", 422, "REPO_PRIVATE");
  if (repo.fork) throw new GithubError("Forks cannot be tokenized. Launch the upstream repository.", 422, "REPO_FORK");
  if (repo.archived) throw new GithubError("Archived repositories cannot be launched.", 422, "REPO_ARCHIVED");
  if (repo.size <= 0) throw new GithubError("Empty repositories cannot be launched.", 422, "REPO_EMPTY");
  if (!repo.default_branch) throw new GithubError("Repository has no default branch.", 422, "REPO_EMPTY");

  const pushedDays = Math.max(
    0,
    (Date.now() - new Date(repo.pushed_at).getTime()) / 86_400_000,
  );
  if (pushedDays > 730) {
    throw new GithubError(
      "This repository has been dormant for more than two years. Revive it before launching.",
      422,
      "REPO_INACTIVE",
    );
  }
  if (Date.now() - new Date(repo.created_at).getTime() < MIN_REPO_AGE_MS) {
    throw new GithubError(
      `Repositories must be at least ${MIN_REPO_AGE_LABEL} old before they can be indexed.`,
      422,
      "REPO_TOO_NEW",
    );
  }
  let commitInfo = await fetchCommitInfo(repo.full_name);
  if (commitInfo.count === 0 && repo.size < 8 && !apiBudgetAvailable()) {
    return loadGithubRepoFromHtml(fullName, opts);
  }
  if (commitInfo.count === 0 && repo.size < 8) {
    throw new GithubError("Repository has no meaningful commit history.", 422, "REPO_EMPTY");
  }
  const health = healthScore({
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    sizeKb: repo.size,
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    commitCount: commitInfo.count,
    isArchived: repo.archived,
  });
  let readme: { markdown: string; sha: string; url: string } | null = null;
  if (!opts.skipReadme) {
    try {
      readme = await fetchReadme(repo.full_name, repo.default_branch, opts.forceFresh);
    } catch (error) {
      if (opts.requireReadme) throw error;
    }
  }
  const data: GithubRepoData = {
    githubId: repo.id,
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    description: repo.description,
    homepage: repo.homepage,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count ?? repo.watchers_count,
    openIssues: repo.open_issues_count,
    language: repo.language,
    topics: repo.topics ?? [],
    license: repo.license?.spdx_id ?? repo.license?.name ?? null,
    defaultBranch: repo.default_branch,
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    sizeKb: repo.size,
    isFork: repo.fork,
    isPrivate: repo.private,
    isArchived: repo.archived,
    commitCount: commitInfo.count,
    lastCommitAt: commitInfo.lastCommitAt,
    healthScore: health,
    readme: readme?.markdown ?? null,
    readmeSha: readme?.sha ?? null,
    readmeUrl: readme?.url ?? null,
  };
  memoryCache.set(cacheKey, { data, at: Date.now() });
  return data;
}

export function getRawReadmeUrl(fullName: string, branch: string): string {
  return `https://raw.githubusercontent.com/${fullName}/${branch}/README.md`;
}

export function upsertRepo(data: GithubRepoData, opts: { forceReadme?: boolean } = {}): {
  repoId: string;
  tier: Tier;
} {
  const existing = db
    .prepare("SELECT * FROM repos WHERE full_name_lc = ?")
    .get(data.fullName.toLowerCase()) as
    | {
        id: string;
        stars: number;
        readme_md: string | null;
        readme_sha: string | null;
        star_velocity_1h: number;
        star_velocity_24h: number;
      }
    | undefined;
  const now = nowIso();
  const tier = tierForStars(data.stars);
  const id = existing?.id ?? `repo_${data.githubId}`;
  const readme = data.readme ?? (opts.forceReadme ? null : existing?.readme_md ?? null);
  db.prepare(
    `INSERT INTO repos(
      id, github_id, full_name, full_name_lc, owner, name, description, homepage, stars, forks,
      watchers, open_issues, language, topics_json, license, default_branch, github_created_at,
      pushed_at, commit_count, last_commit_at, size_kb, is_fork, is_private, is_archived,
      health_score, star_velocity_1h, star_velocity_24h, sync_state, last_synced_at, readme_md,
      readme_sha, readme_fetched_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(full_name_lc) DO UPDATE SET
      full_name = excluded.full_name, owner = excluded.owner, name = excluded.name,
      description = excluded.description, homepage = excluded.homepage, stars = excluded.stars,
      forks = excluded.forks, watchers = excluded.watchers, open_issues = excluded.open_issues,
      language = excluded.language, topics_json = excluded.topics_json, license = excluded.license,
      default_branch = excluded.default_branch, github_created_at = excluded.github_created_at,
      pushed_at = excluded.pushed_at, commit_count = excluded.commit_count,
      last_commit_at = excluded.last_commit_at, size_kb = excluded.size_kb,
      is_fork = excluded.is_fork, is_private = excluded.is_private, is_archived = excluded.is_archived,
      health_score = excluded.health_score, star_velocity_1h = excluded.star_velocity_1h,
      star_velocity_24h = excluded.star_velocity_24h, sync_state = 'ok',
      last_synced_at = excluded.last_synced_at,
      readme_md = COALESCE(excluded.readme_md, repos.readme_md),
      readme_sha = COALESCE(excluded.readme_sha, repos.readme_sha),
      readme_fetched_at = CASE WHEN excluded.readme_md IS NOT NULL THEN excluded.readme_fetched_at ELSE repos.readme_fetched_at END,
      updated_at = excluded.updated_at`,
  ).run(
    id,
    data.githubId,
    data.fullName,
    data.fullName.toLowerCase(),
    data.owner,
    data.name,
    data.description,
    data.homepage,
    data.stars,
    data.forks,
    data.watchers,
    data.openIssues,
    data.language,
    JSON.stringify(data.topics),
    data.license,
    data.defaultBranch,
    data.createdAt,
    data.pushedAt,
    data.commitCount,
    data.lastCommitAt,
    data.sizeKb,
    data.isFork ? 1 : 0,
    data.isPrivate ? 1 : 0,
    data.isArchived ? 1 : 0,
    data.healthScore,
    existing?.star_velocity_1h ?? 0,
    existing?.star_velocity_24h ?? 0,
    now,
    data.readme,
    data.readmeSha,
    data.readme ? now : null,
    now,
    now,
  );
  const lastSnapshot = db
    .prepare(
      "SELECT stars, taken_at FROM star_snapshots WHERE repo_id = ? ORDER BY taken_at DESC LIMIT 1",
    )
    .get(id) as { stars: number; taken_at: string } | undefined;
  if (!lastSnapshot || lastSnapshot.stars !== data.stars) {
    db.prepare(
      "INSERT INTO star_snapshots(repo_id, stars, taken_at) VALUES (?, ?, ?)",
    ).run(id, data.stars, now);
    if (lastSnapshot) {
      const delta = Math.max(0, data.stars - lastSnapshot.stars);
      const hours = Math.max(
        0.1,
        (Date.now() - new Date(lastSnapshot.taken_at).getTime()) / 3_600_000,
      );
      const plausible = delta <= Math.max(400, lastSnapshot.stars * 0.04);
      if (hours <= 2.5) {
        db.prepare("UPDATE repos SET star_velocity_1h = ? WHERE id = ?").run(
          plausible ? Math.min(500, Math.round(delta / hours)) : 0,
          id,
        );
      }
      if (hours <= 30) {
        db.prepare("UPDATE repos SET star_velocity_24h = ? WHERE id = ?").run(
          plausible ? Math.min(2_000, Math.round(delta / Math.max(1, hours))) : 0,
          id,
        );
      }
    }
  }
  return { repoId: id, tier };
}

export function markRepoHidden(fullNameLc: string, state: "hidden" | "missing" = "hidden"): void {
  const repo = db
    .prepare("SELECT id FROM repos WHERE full_name_lc = ?")
    .get(fullNameLc) as { id: string } | undefined;
  if (!repo) return;
  db.prepare(
    "UPDATE repos SET sync_state = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
  ).run(state, nowIso(), nowIso(), repo.id);
  db.prepare(
    "UPDATE tokens SET royalty_frozen = 1, updated_at = ? WHERE repo_id = ?",
  ).run(nowIso(), repo.id);
}

export function markRepoRestored(fullNameLc: string): void {
  const repo = db
    .prepare("SELECT id FROM repos WHERE full_name_lc = ?")
    .get(fullNameLc) as { id: string } | undefined;
  if (!repo) return;
  db.prepare("UPDATE repos SET sync_state = 'ok', updated_at = ? WHERE id = ?").run(
    nowIso(),
    repo.id,
  );
  db.prepare(
    "UPDATE tokens SET royalty_frozen = 0, updated_at = ? WHERE repo_id = ?",
  ).run(nowIso(), repo.id);
}

export function readmeContainsCode(markdown: string, code: string): boolean {
  return markdown.includes(code);
}

export async function syncRepo(repoId: string, force = false): Promise<GithubRepoData | null> {
  const repo = db
    .prepare("SELECT full_name_lc, full_name, last_synced_at FROM repos WHERE id = ?")
    .get(repoId) as { full_name_lc: string; full_name: string; last_synced_at: string | null } | undefined;
  if (!repo) return null;
  if (
    !force &&
    repo.last_synced_at &&
    Date.now() - new Date(repo.last_synced_at).getTime() < 1000 * 60 * 8
  ) {
    return null;
  }
  try {
    const data = await loadGithubRepo(repo.full_name, { forceFresh: true, skipReadme: true });
    upsertRepo(data);
    markRepoRestored(repo.full_name_lc);
    return data;
  } catch (error) {
    if (error instanceof GithubError && (error.code === "REPO_NOT_FOUND" || error.code === "REPO_PRIVATE")) {
      markRepoHidden(repo.full_name_lc, "hidden");
    }
    return null;
  }
}
