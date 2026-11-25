/**
 * Every GitHub call the hosted progress collector makes goes through this file.
 *
 * Callers pass `fetch`, so tests hand in a fake and never reach api.github.com.
 * The token is the deployment's GH_TOKEN (or GITHUB_TOKEN); it is sent only in
 * the Authorization header and never logged or returned.
 *
 * Three failures stop work instead of becoming a missing number:
 * - 401: the token is refused. `GitHubAuthError`.
 * - 429, a 403 that says it is a rate limit, or a GraphQL RATE_LIMITED error.
 *   `GitHubRateLimitError`.
 * - The hard deadline passed before the next call. `CollectDeadlineError`.
 * Anything else is an ordinary failure the caller turns into null or "unavailable".
 */

import { githubAppJwt } from "../github-read";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_FETCH_TIMEOUT_MS = 20_000;
/** GitHub's search API allows 30 requests a minute. collect-progress.sh used 2.2 s. */
export const SEARCH_SPACING_MS = 2_200;
/** collect-progress.sh waited 30 s before its one retry of a failed search. */
export const SEARCH_RETRY_DELAY_MS = 30_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubAuthError extends Error {
  readonly name = "GitHubAuthError";
  constructor() {
    super("github_auth");
  }
}

export class GitHubRateLimitError extends Error {
  readonly name = "GitHubRateLimitError";
  constructor() {
    super("github_rate_limited");
  }
}

export class CollectDeadlineError extends Error {
  readonly name = "CollectDeadlineError";
  constructor() {
    super("collect_deadline");
  }
}

/** This repo used up its own time cap. The run skips it and moves on. */
export class RepoTimeCapError extends Error {
  readonly name = "RepoTimeCapError";
  constructor() {
    super("repo_time_cap");
  }
}

/** A request is not started unless at least this much time is left before the deadline. */
export const MIN_REQUEST_MS = 1_000;

/** A call that failed for an ordinary reason (5xx, 404, 422, network, bad JSON). */
export class GitHubRequestError extends Error {
  readonly name = "GitHubRequestError";
  constructor(readonly status: number) {
    super(`github request failed (${status})`);
  }
}

/**
 * The read-only GitHub App has no installation on this owner. Its repos are
 * unavailable (`app_not_installed`), never zeros. Not a run-ending error.
 */
export class GitHubAppNotInstalledError extends Error {
  readonly name = "GitHubAppNotInstalledError";
  constructor(readonly owner: string) {
    super("app_not_installed");
  }
}

/**
 * The installation lookup or token mint failed for this owner (not a 401, not
 * "not installed"). Cached for the run; the owner's repos are skipped.
 */
export class GitHubAppTokenError extends Error {
  readonly name = "GitHubAppTokenError";
  constructor(readonly owner: string, readonly status: number) {
    super("app_token_failed");
  }
}

/** Errors that end the batch rather than becoming a null field. */
export function isAbort(err: unknown): boolean {
  return err instanceof GitHubAuthError || err instanceof GitHubRateLimitError ||
    err instanceof CollectDeadlineError || err instanceof RepoTimeCapError;
}

/** Errors a repo's collection must not swallow into a null field. */
export function mustPropagate(err: unknown): boolean {
  return isAbort(err) || err instanceof GitHubAppNotInstalledError || err instanceof GitHubAppTokenError;
}

/**
 * How the collector authenticates. `app`: a read-only GitHub App, with an
 * installation token minted per owner. `token`: one GH_TOKEN for everything.
 */
export type GitHubCredentials =
  | { kind: "token"; token: string }
  | { kind: "app"; appId: string; privateKey: string };

/**
 * The collector's App settings, read directly from MC_GITHUB_APP_ID and
 * MC_GITHUB_APP_PRIVATE_KEY. Deliberately not `githubAppConfig()` from
 * github-read.ts: that also needs MC_GITHUB_APP_BOT_LOGIN and turns the
 * reducers (#80) on, which this read-only App must not do.
 */
export function collectorAppCredentials(env: Record<string, string | undefined> = process.env): GitHubCredentials | null {
  const appId = env.MC_GITHUB_APP_ID?.trim() ?? "";
  const privateKey = env.MC_GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
  if (!appId || !privateKey) return null;
  return { kind: "app", appId, privateKey };
}

/**
 * What the hosted collector authenticates with: the read-only App when both of
 * its variables are set, else GH_TOKEN, else GITHUB_TOKEN, else nothing (503).
 */
export function collectorCredentials(env: Record<string, string | undefined> = process.env): GitHubCredentials | null {
  const app = collectorAppCredentials(env);
  if (app) return app;
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || "";
  return token ? { kind: "token", token } : null;
}

/** A minted installation token is reused until this close to its expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface ProgressGitHubOptions {
  /** Shorthand for `credentials: { kind: "token", token }`. */
  token?: string;
  credentials?: GitHubCredentials;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  searchSpacingMs?: number;
  searchRetryDelayMs?: number;
  /**
   * Epoch ms. No GitHub request or wait runs past it: each request's timeout is
   * clipped to the time left, and none starts with under MIN_REQUEST_MS left.
   */
  hardDeadline?: number;
}

export interface SearchPage {
  total_count: number | null;
  items: Record<string, unknown>[];
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimited(status: number, headers: Headers, text: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (headers.get("x-ratelimit-remaining") === "0") return true;
  if (headers.get("retry-after")) return true;
  return /rate limit/i.test(text);
}

type OwnerAuth =
  | { kind: "token"; token: string; expiresAt: number }
  | { kind: "not_installed" }
  | { kind: "failed"; status: number };

export class ProgressGitHub {
  private readonly credentials: GitHubCredentials;
  private readonly ownerAuth = new Map<string, OwnerAuth>();
  /** Installation tokens minted this run, for tests and sizing. */
  mints = 0;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly searchSpacingMs: number;
  private readonly searchRetryDelayMs: number;
  private readonly hardDeadline: number;
  private repoDeadline = Number.POSITIVE_INFINITY;
  private lastSearchAt: number | null = null;
  /** Number of HTTP requests sent. Reported for sizing, never a secret. */
  calls = 0;
  searches = 0;

  constructor(opts: ProgressGitHubOptions) {
    const credentials = opts.credentials ?? (opts.token !== undefined ? { kind: "token" as const, token: opts.token } : null);
    if (!credentials) throw new Error("ProgressGitHub needs a token or App credentials");
    this.credentials = credentials;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
    this.searchSpacingMs = opts.searchSpacingMs ?? SEARCH_SPACING_MS;
    this.searchRetryDelayMs = opts.searchRetryDelayMs ?? SEARCH_RETRY_DELAY_MS;
    this.hardDeadline = opts.hardDeadline ?? Number.POSITIVE_INFINITY;
  }

  /** Per-repo time cap (epoch ms), or null to clear it. */
  setRepoDeadline(at: number | null): void {
    this.repoDeadline = at ?? Number.POSITIVE_INFINITY;
  }

  /** The error for whichever limit is nearer. */
  private limitError(): Error {
    return this.repoDeadline < this.hardDeadline ? new RepoTimeCapError() : new CollectDeadlineError();
  }

  /** Milliseconds left before the nearer of the run deadline and the repo cap. */
  private remaining(): number {
    return Math.min(this.hardDeadline, this.repoDeadline) - this.now();
  }

  /** Throws unless `ms` more (at least MIN_REQUEST_MS) fits before the nearer deadline. */
  private reserve(ms: number): void {
    if (this.remaining() < Math.max(ms, MIN_REQUEST_MS)) throw this.limitError();
  }

  /** Sleeps only when the whole wait fits before the deadline; never sleeps past it. */
  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.reserve(ms + MIN_REQUEST_MS);
    await this.sleep(ms);
  }

  /** The timeout a request started now gets: never past the deadline. */
  requestTimeoutMs(): number {
    return Math.min(this.timeoutMs, this.remaining());
  }

  /**
   * One request. Returns the parsed JSON body on 2xx. Throws GitHubAuthError on 401,
   * GitHubRateLimitError on a rate limit, GitHubRequestError otherwise.
   */
  async request(method: "GET" | "POST", pathOrUrl: string, body?: unknown, owner?: string): Promise<unknown> {
    return this.exchange(method, pathOrUrl, body, await this.authorization(owner));
  }

  /**
   * The Authorization header for a call about `owner`'s repos. With App
   * credentials, an installation token for that owner, minted once and reused
   * until a minute before it expires.
   */
  private async authorization(owner: string | undefined): Promise<string> {
    if (this.credentials.kind === "token") return `Bearer ${this.credentials.token}`;
    if (!owner) throw new Error("an App-authenticated call needs the repo owner");
    const key = owner.toLowerCase();
    const cached = this.ownerAuth.get(key);
    if (cached?.kind === "not_installed") throw new GitHubAppNotInstalledError(owner);
    if (cached?.kind === "failed") throw new GitHubAppTokenError(owner, cached.status);
    if (cached?.kind === "token" && cached.expiresAt > this.now() + TOKEN_REFRESH_MARGIN_MS) return `Bearer ${cached.token}`;
    const minted = await this.mint(owner);
    this.ownerAuth.set(key, minted);
    if (minted.kind === "not_installed") throw new GitHubAppNotInstalledError(owner);
    if (minted.kind === "failed") throw new GitHubAppTokenError(owner, minted.status);
    return `Bearer ${minted.token}`;
  }

  /** The App JWT. A key that cannot sign is the run's auth failure, like a 401. */
  private appJwt(): string {
    if (this.credentials.kind !== "app") throw new GitHubAuthError();
    try {
      return `Bearer ${githubAppJwt(this.credentials.appId, this.credentials.privateKey, this.now())}`;
    } catch {
      throw new GitHubAuthError();
    }
  }

  /**
   * Installation lookup (user, then org) and token mint for one owner. A 401 on
   * an /app endpoint is GitHubAuthError (bad App ID or key). 404 on both lookups
   * is not installed. Other failures are cached as failed for this run.
   */
  private async mint(owner: string): Promise<OwnerAuth> {
    const jwt = this.appJwt();
    const name = encodeURIComponent(owner);
    let installation: unknown = null;
    for (const path of [`users/${name}/installation`, `orgs/${name}/installation`]) {
      try {
        installation = await this.exchange("GET", path, undefined, jwt);
        break;
      } catch (err) {
        if (!(err instanceof GitHubRequestError)) throw err;
        if (err.status !== 404) return { kind: "failed", status: err.status };
      }
    }
    const id = (installation as { id?: unknown } | null)?.id;
    if (installation === null) return { kind: "not_installed" };
    if (typeof id !== "number" || !Number.isSafeInteger(id)) return { kind: "failed", status: 200 };
    let minted: unknown;
    try {
      minted = await this.exchange("POST", `app/installations/${id}/access_tokens`, undefined, jwt);
    } catch (err) {
      if (!(err instanceof GitHubRequestError)) throw err;
      return { kind: "failed", status: err.status };
    }
    const body = minted as { token?: unknown; expires_at?: unknown } | null;
    if (typeof body?.token !== "string" || body.token.length === 0) return { kind: "failed", status: 200 };
    const expires = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    this.mints += 1;
    return { kind: "token", token: body.token, expiresAt: Number.isFinite(expires) ? expires : this.now() + 50 * 60_000 };
  }

  private async exchange(method: "GET" | "POST", pathOrUrl: string, body: unknown, authorization: string): Promise<unknown> {
    this.reserve(MIN_REQUEST_MS);
    const timeoutMs = this.requestTimeoutMs();
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GITHUB_API}/${pathOrUrl.replace(/^\//, "")}`;
    const controller = new AbortController();
    // Clipped below the normal timeout means the deadline, not GitHub, ends this request.
    const clipped = timeoutMs < this.timeoutMs;
    let cutOff = false;
    const timer = setTimeout(() => {
      cutOff = clipped;
      controller.abort();
    }, timeoutMs);
    this.calls += 1;
    let res: Response;
    let text: string;
    // The timer covers the whole exchange, body included, so nothing outlives the deadline.
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization,
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": "agent-kontrol-progress-collector",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch {
      // A request cut off by the deadline is the deadline, not a missing number.
      if (cutOff || this.remaining() <= 0) throw this.limitError();
      throw new GitHubRequestError(0);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new GitHubAuthError();
    if (isRateLimited(res.status, res.headers, text)) throw new GitHubRateLimitError();
    if (res.status < 200 || res.status >= 300) throw new GitHubRequestError(res.status);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubRequestError(res.status);
    }
  }

  /** GraphQL `data`. Any `errors` entry fails the call; RATE_LIMITED is a rate limit. */
  async graphql(query: string, variables: Record<string, unknown>, owner?: string): Promise<Record<string, unknown>> {
    const json = (await this.request("POST", "graphql", { query, variables }, owner)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") throw new GitHubRequestError(200);
    const errors = json.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      if (errors.some((e) => (e as { type?: unknown })?.type === "RATE_LIMITED")) throw new GitHubRateLimitError();
      throw new GitHubRequestError(200);
    }
    if (!json.data || typeof json.data !== "object") throw new GitHubRequestError(200);
    return json.data as Record<string, unknown>;
  }

  /** Waits so that two search calls start at least `searchSpacingMs` apart. */
  private async paceSearch(): Promise<void> {
    if (this.lastSearchAt !== null) {
      const wait = this.lastSearchAt + this.searchSpacingMs - this.now();
      await this.wait(wait);
    }
    this.reserve(MIN_REQUEST_MS);
    this.lastSearchAt = this.now();
    this.searches += 1;
  }

  /** One search page, retried once on an ordinary failure. Null when both attempts fail. */
  private async search(params: Record<string, string>, owner?: string): Promise<Record<string, unknown> | null> {
    const qs = new URLSearchParams(params).toString();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.paceSearch();
      try {
        const json = await this.request("GET", `search/issues?${qs}`, undefined, owner);
        if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
      } catch (err) {
        if (mustPropagate(err)) throw err;
      }
      if (attempt === 1) await this.wait(this.searchRetryDelayMs);
    }
    return null;
  }

  /**
   * total_count for a search, as `search_count` in collect-progress.sh:
   * retried once, and null (never 0) when it still cannot be answered.
   */
  async searchCount(q: string, owner?: string): Promise<number | null> {
    const json = await this.search({ q, per_page: "1" }, owner);
    const total = json?.total_count;
    return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null;
  }

  /** The first page of a search (`search_page`). total_count null and no items on failure. */
  async searchPage(q: string, extra: Record<string, string> = {}, owner?: string): Promise<SearchPage> {
    const json = await this.search({ q, per_page: "100", ...extra }, owner);
    const total = json?.total_count;
    if (!json || typeof total !== "number" || !Number.isInteger(total) || total < 0 || !Array.isArray(json.items)) {
      return { total_count: null, items: [] };
    }
    return { total_count: total, items: json.items.filter((i) => i && typeof i === "object") as Record<string, unknown>[] };
  }

  /** The same calls, authenticated for one owner's repos. */
  forOwner(owner: string): OwnerCalls {
    return {
      request: (method, path, body) => this.request(method, path, body, owner),
      graphql: (query, variables) => this.graphql(query, variables, owner),
      searchCount: (q) => this.searchCount(q, owner),
      searchPage: (q, extra) => this.searchPage(q, extra, owner),
    };
  }
}

/** GitHub calls bound to one repo owner's credentials. */
export interface OwnerCalls {
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>>;
  searchCount(q: string): Promise<number | null>;
  searchPage(q: string, extra?: Record<string, string>): Promise<SearchPage>;
}
