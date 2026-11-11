import { createSign } from "node:crypto";

/**
 * Installation-token reads for reducers (#80).
 *
 * Every GitHub read goes through this file. Callers pass fetch. Tests pass a
 * fake and never reach api.github.com. A 404 from the installation lookup is
 * `not_installed`. A 404 on one issue or pull, after a token was issued, is
 * an absent resource (null), which is how a closed event before open creates
 * no state. A 403, or a 404 on any other route, is `missing_permission`.
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_FETCH_TIMEOUT_MS = 15_000;
export const GITHUB_PAGE_CAP = 10;

export type GitHubFailureReason =
  | "missing_permission"
  | "rate_limit"
  | "not_installed"
  | "token_revoked"
  | "stale_head"
  | "http";

export class GitHubCallError extends Error {
  readonly name = "GitHubCallError";

  constructor(
    readonly status: number,
    readonly reason: GitHubFailureReason,
    readonly retryAfterSeconds: number | null,
  ) {
    super(reason);
  }
}

/** The list hit the page cap while the last page was still full. */
export class GitHubListTruncatedError extends Error {
  readonly name = "GitHubListTruncatedError";

  constructor() {
    super("github list truncated");
  }
}

export type MergeableState = "behind" | "clean" | "dirty" | "blocked" | "unknown" | "draft" | "unstable";

export interface GhPull {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  fork: boolean;
  maintainerCanModify: boolean;
  mergeableState: MergeableState;
  /** True, false, or null when GitHub has not computed it yet. */
  mergeable: boolean | null;
  reviewers: string[];
}

export interface GhIssue {
  number: number;
  state: "open" | "closed";
  body: string;
  labels: string[];
}

export interface GhComment {
  body: string;
}

export interface GitHubReadClient {
  botLogin(): string;
  getRepo(repo: string): Promise<{ defaultBranch: string }>;
  getPull(repo: string, number: number): Promise<GhPull | null>;
  getIssue(repo: string, number: number): Promise<GhIssue | null>;
  listOpenPulls(repo: string): Promise<GhPull[]>;
  listOpenIssues(repo: string): Promise<GhIssue[]>;
  listComments(repo: string, number: number): Promise<GhComment[]>;
  branchProtected(repo: string, branch: string): Promise<boolean>;
  requiredContexts(repo: string, branch: string): Promise<string[]>;
  checkConclusions(repo: string, sha: string): Promise<Record<string, string>>;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  botLogin: string;
}

export function githubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.MC_GITHUB_APP_ID?.trim() ?? "";
  const privateKey = env.MC_GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
  const botLogin = env.MC_GITHUB_APP_BOT_LOGIN?.trim() ?? "";
  if (!appId || !privateKey || !botLogin) return null;
  return { appId, privateKey, botLogin };
}

export function normalizePem(key: string): string {
  const trimmed = key.trim();
  return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
}

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** RS256 JWT for the GitHub App. `iat` is 60s behind `nowMs` so clock skew is tolerated. */
export function githubAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(nowMs / 1000) - 60;
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(normalizePem(privateKey)).toString("base64url");
  return `${data}.${signature}`;
}

export function repoPath(repo: string): string {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash !== repo.lastIndexOf("/")) {
    throw new GitHubCallError(400, "http", null);
  }
  return `${encodeURIComponent(repo.slice(0, slash))}/${encodeURIComponent(repo.slice(slash + 1))}`;
}

/** Seconds from Retry-After (delta or HTTP-date) or X-RateLimit-Reset, when either is set. */
export function retryAfterSeconds(headers: Headers, nowMs: number): number | null {
  const retry = headers.get("retry-after");
  if (retry) {
    const trimmed = retry.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const when = Date.parse(trimmed);
    if (Number.isFinite(when)) return Math.max(0, Math.ceil((when - nowMs) / 1000));
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset.trim())) {
    return Math.max(0, Number(reset.trim()) - Math.floor(nowMs / 1000));
  }
  return null;
}

export function classifyGitHubResponse(status: number, body: string, headers: Headers, nowMs: number): GitHubCallError | null {
  if (status >= 200 && status < 300) return null;
  const retry = retryAfterSeconds(headers, nowMs);
  const secondary = /secondary rate limit/i.test(body) || (status === 403 && retry != null && /rate limit/i.test(body));
  if (status === 429 || secondary) return new GitHubCallError(status, "rate_limit", retry);
  if (status === 401) return new GitHubCallError(status, "token_revoked", null);
  if (status === 403 || status === 404) return new GitHubCallError(status, "missing_permission", null);
  return new GitHubCallError(status, "http", retry);
}

interface Fetched {
  status: number;
  headers: Headers;
  body: string;
}

async function send(fetchImpl: typeof fetch, method: string, url: string, headers: Record<string, string>, body?: string): Promise<Fetched> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new GitHubCallError(0, "http", null);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new GitHubCallError(response.status, "http", null);
  }
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text };
}

export interface GitHubAuthorizer {
  tokenFor(repo: string): Promise<{ token: string; botLogin: string }>;
}

export function installationAuthorizer(
  config: GitHubAppConfig,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): GitHubAuthorizer {
  const cache = new Map<number, { token: string; expiresAt: number }>();
  const appHeaders = (jwt: string): Record<string, string> => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "user-agent": "agent-kontrol",
    "x-github-api-version": GITHUB_API_VERSION,
  });

  return {
    async tokenFor(repo: string) {
      const jwt = githubAppJwt(config.appId, config.privateKey, now());
      const installation = await send(fetchImpl, "GET", `${GITHUB_API}/repos/${repoPath(repo)}/installation`, appHeaders(jwt));
      if (installation.status === 404) throw new GitHubCallError(404, "not_installed", null);
      const installError = classifyGitHubResponse(installation.status, installation.body, installation.headers, now());
      if (installError) {
        if (installError.reason === "missing_permission" && installError.status === 401) {
          throw new GitHubCallError(401, "token_revoked", null);
        }
        throw installError.status === 401 ? new GitHubCallError(401, "token_revoked", null) : installError;
      }
      const parsed = JSON.parse(installation.body) as { id?: unknown };
      const installationId = typeof parsed.id === "number" ? parsed.id : null;
      if (installationId == null) throw new GitHubCallError(0, "not_installed", null);
      const cached = cache.get(installationId);
      if (cached && cached.expiresAt > now() + 60_000) return { token: cached.token, botLogin: config.botLogin };
      const minted = await send(
        fetchImpl,
        "POST",
        `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
        appHeaders(jwt),
      );
      const mintError = classifyGitHubResponse(minted.status, minted.body, minted.headers, now());
      if (mintError) {
        throw mintError.reason === "missing_permission"
          ? new GitHubCallError(mintError.status, "token_revoked", mintError.retryAfterSeconds)
          : mintError;
      }
      const tokenBody = JSON.parse(minted.body) as { token?: unknown; expires_at?: unknown };
      if (typeof tokenBody.token !== "string") throw new GitHubCallError(0, "token_revoked", null);
      const expiresAt = typeof tokenBody.expires_at === "string" ? Date.parse(tokenBody.expires_at) : now() + 50 * 60_000;
      cache.set(installationId, { token: tokenBody.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 50 * 60_000 });
      return { token: tokenBody.token, botLogin: config.botLogin };
    },
  };
}

function mergeableState(value: unknown): MergeableState {
  switch (value) {
    case "behind":
    case "clean":
    case "dirty":
    case "blocked":
    case "draft":
    case "unstable":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function asPull(value: unknown): GhPull | null {
  if (!value || typeof value !== "object") return null;
  const json = value as Record<string, unknown>;
  const head = json.head && typeof json.head === "object" ? json.head as Record<string, unknown> : null;
  const base = json.base && typeof json.base === "object" ? json.base as Record<string, unknown> : null;
  if (typeof json.number !== "number" || !head || typeof head.sha !== "string" || typeof head.ref !== "string") return null;
  const headRepo = head.repo && typeof head.repo === "object" ? (head.repo as { full_name?: unknown }).full_name : null;
  const baseRepo = base?.repo && typeof base.repo === "object" ? (base.repo as { full_name?: unknown }).full_name : null;
  const fork = typeof headRepo === "string" && typeof baseRepo === "string" && headRepo.toLowerCase() !== baseRepo.toLowerCase();
  const reviewers: string[] = [];
  if (Array.isArray(json.requested_reviewers)) {
    for (const user of json.requested_reviewers) {
      if (user && typeof user === "object" && typeof (user as { login?: unknown }).login === "string") {
        reviewers.push((user as { login: string }).login);
      }
    }
  }
  return {
    number: json.number,
    state: json.state === "closed" ? "closed" : "open",
    merged: json.merged === true,
    draft: json.draft === true,
    headSha: head.sha,
    headRef: head.ref,
    baseRef: base && typeof base.ref === "string" ? base.ref : "",
    fork,
    maintainerCanModify: json.maintainer_can_modify !== false,
    mergeableState: mergeableState(json.mergeable_state),
    mergeable: json.mergeable === true ? true : json.mergeable === false ? false : null,
    reviewers,
  };
}

function asIssue(value: unknown): GhIssue | null {
  if (!value || typeof value !== "object") return null;
  const json = value as Record<string, unknown>;
  if (typeof json.number !== "number") return null;
  const labels: string[] = [];
  if (Array.isArray(json.labels)) {
    for (const label of json.labels) {
      if (typeof label === "string") labels.push(label);
      else if (label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
        labels.push((label as { name: string }).name);
      }
    }
  }
  return {
    number: json.number,
    state: json.state === "closed" ? "closed" : "open",
    body: typeof json.body === "string" ? json.body : "",
    labels,
  };
}

export function githubReadClient(
  auth: GitHubAuthorizer,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): GitHubReadClient {
  let bot = "";

  async function call(repo: string, method: string, path: string): Promise<Fetched> {
    const issued = await auth.tokenFor(repo);
    bot = issued.botLogin;
    return send(fetchImpl, method, `${GITHUB_API}${path}`, {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${issued.token}`,
      "user-agent": "agent-kontrol",
      "x-github-api-version": GITHUB_API_VERSION,
    });
  }

  function interpret(fetched: Fetched, absentIsNull: boolean): unknown {
    if (absentIsNull && fetched.status === 404) return null;
    const error = classifyGitHubResponse(fetched.status, fetched.body, fetched.headers, now());
    if (error) throw error;
    if (!fetched.body) return null;
    return JSON.parse(fetched.body) as unknown;
  }

  async function paged(repo: string, path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= GITHUB_PAGE_CAP; page += 1) {
      const joiner = path.includes("?") ? "&" : "?";
      const fetched = await call(repo, "GET", `${path}${joiner}per_page=100&page=${page}`);
      const json = interpret(fetched, false);
      if (!Array.isArray(json) || json.length === 0) return all;
      all.push(...json);
      if (json.length < 100) return all;
    }
    throw new GitHubListTruncatedError();
  }

  return {
    botLogin: () => bot,
    async getRepo(repo) {
      const json = interpret(await call(repo, "GET", `/repos/${repoPath(repo)}`), false) as { default_branch?: unknown };
      if (!json || typeof json.default_branch !== "string") throw new GitHubCallError(0, "http", null);
      return { defaultBranch: json.default_branch };
    },
    async getPull(repo, number) {
      const json = interpret(await call(repo, "GET", `/repos/${repoPath(repo)}/pulls/${number}`), true);
      return json == null ? null : asPull(json);
    },
    async getIssue(repo, number) {
      const json = interpret(await call(repo, "GET", `/repos/${repoPath(repo)}/issues/${number}`), true);
      return json == null ? null : asIssue(json);
    },
    async listOpenPulls(repo) {
      const rows = await paged(repo, `/repos/${repoPath(repo)}/pulls?state=open`);
      return rows.map(asPull).filter((row): row is GhPull => row !== null);
    },
    async listOpenIssues(repo) {
      const rows = await paged(repo, `/repos/${repoPath(repo)}/issues?state=open`);
      return rows
        .filter((row) => !row || typeof row !== "object" || !("pull_request" in row))
        .map(asIssue)
        .filter((row): row is GhIssue => row !== null && row.state === "open");
    },
    async listComments(repo, number) {
      const comments = await paged(repo, `/repos/${repoPath(repo)}/issues/${number}/comments`);
      return comments
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const body = (item as { body?: unknown }).body;
          return typeof body === "string" ? { body } : { body: "" };
        })
        .filter((item): item is GhComment => item !== null);
    },
    async branchProtected(repo, branch) {
      const fetched = await call(repo, "GET", `/repos/${repoPath(repo)}/branches/${encodeURIComponent(branch)}`);
      if (fetched.status === 404) return false;
      const json = interpret(fetched, false) as { protected?: unknown };
      return json?.protected === true;
    },
    async requiredContexts(repo, branch) {
      const fetched = await call(repo, "GET", `/repos/${repoPath(repo)}/branches/${encodeURIComponent(branch)}/protection`);
      if (fetched.status === 404) return [];
      const json = interpret(fetched, false) as {
        required_status_checks?: { contexts?: unknown; checks?: unknown };
      };
      const checks = json?.required_status_checks;
      const names: string[] = [];
      if (checks && Array.isArray(checks.contexts)) {
        for (const name of checks.contexts) if (typeof name === "string") names.push(name);
      }
      if (checks && Array.isArray(checks.checks)) {
        for (const check of checks.checks) {
          if (check && typeof check === "object" && typeof (check as { context?: unknown }).context === "string") {
            names.push((check as { context: string }).context);
          }
        }
      }
      return [...new Set(names)];
    },
    async checkConclusions(repo, sha) {
      const out: Record<string, string> = {};
      const runs = interpret(
        await call(repo, "GET", `/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
        false,
      ) as { check_runs?: unknown };
      if (runs && Array.isArray(runs.check_runs)) {
        for (const run of runs.check_runs) {
          if (!run || typeof run !== "object") continue;
          const name = (run as { name?: unknown }).name;
          const conclusion = (run as { conclusion?: unknown }).conclusion;
          if (typeof name !== "string") continue;
          out[name] = typeof conclusion === "string" ? conclusion : "pending";
        }
      }
      const status = interpret(
        await call(repo, "GET", `/repos/${repoPath(repo)}/commits/${encodeURIComponent(sha)}/status`),
        false,
      ) as { statuses?: unknown };
      if (status && Array.isArray(status.statuses)) {
        for (const item of status.statuses) {
          if (!item || typeof item !== "object") continue;
          const context = (item as { context?: unknown }).context;
          const state = (item as { state?: unknown }).state;
          if (typeof context === "string" && typeof state === "string" && out[context] == null) out[context] = state;
        }
      }
      return out;
    },
  };
}
