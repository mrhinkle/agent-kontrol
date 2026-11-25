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

/** A call that failed for an ordinary reason (5xx, 404, 422, network, bad JSON). */
export class GitHubRequestError extends Error {
  readonly name = "GitHubRequestError";
  constructor(readonly status: number) {
    super(`github request failed (${status})`);
  }
}

/** Errors that end the batch rather than becoming a null field. */
export function isAbort(err: unknown): boolean {
  return err instanceof GitHubAuthError || err instanceof GitHubRateLimitError || err instanceof CollectDeadlineError;
}

export interface ProgressGitHubOptions {
  token: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  searchSpacingMs?: number;
  searchRetryDelayMs?: number;
  /** Epoch ms. No call starts after it. */
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

export class ProgressGitHub {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly searchSpacingMs: number;
  private readonly searchRetryDelayMs: number;
  private readonly hardDeadline: number;
  private lastSearchAt: number | null = null;
  /** Number of HTTP requests sent. Reported for sizing, never a secret. */
  calls = 0;
  searches = 0;

  constructor(opts: ProgressGitHubOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
    this.searchSpacingMs = opts.searchSpacingMs ?? SEARCH_SPACING_MS;
    this.searchRetryDelayMs = opts.searchRetryDelayMs ?? SEARCH_RETRY_DELAY_MS;
    this.hardDeadline = opts.hardDeadline ?? Number.POSITIVE_INFINITY;
  }

  private checkDeadline(): void {
    if (this.now() > this.hardDeadline) throw new CollectDeadlineError();
  }

  /**
   * One request. Returns the parsed JSON body on 2xx. Throws GitHubAuthError on 401,
   * GitHubRateLimitError on a rate limit, GitHubRequestError otherwise.
   */
  async request(method: "GET" | "POST", pathOrUrl: string, body?: unknown): Promise<unknown> {
    this.checkDeadline();
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GITHUB_API}/${pathOrUrl.replace(/^\//, "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.calls += 1;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": "agent-kontrol-progress-collector",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new GitHubRequestError(0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
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
  async graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const json = (await this.request("POST", "graphql", { query, variables })) as Record<string, unknown> | null;
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
      if (wait > 0) await this.sleep(wait);
    }
    this.checkDeadline();
    this.lastSearchAt = this.now();
    this.searches += 1;
  }

  /** One search page, retried once on an ordinary failure. Null when both attempts fail. */
  private async search(params: Record<string, string>): Promise<Record<string, unknown> | null> {
    const qs = new URLSearchParams(params).toString();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.paceSearch();
      try {
        const json = await this.request("GET", `search/issues?${qs}`);
        if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
      } catch (err) {
        if (isAbort(err)) throw err;
      }
      if (attempt === 1) await this.sleep(this.searchRetryDelayMs);
    }
    return null;
  }

  /**
   * total_count for a search, as `search_count` in collect-progress.sh:
   * retried once, and null (never 0) when it still cannot be answered.
   */
  async searchCount(q: string): Promise<number | null> {
    const json = await this.search({ q, per_page: "1" });
    const total = json?.total_count;
    return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null;
  }

  /** The first page of a search (`search_page`). total_count null and no items on failure. */
  async searchPage(q: string, extra: Record<string, string> = {}): Promise<SearchPage> {
    const json = await this.search({ q, per_page: "100", ...extra });
    const total = json?.total_count;
    if (!json || typeof total !== "number" || !Number.isInteger(total) || total < 0 || !Array.isArray(json.items)) {
      return { total_count: null, items: [] };
    }
    return { total_count: total, items: json.items.filter((i) => i && typeof i === "object") as Record<string, unknown>[] };
  }
}
