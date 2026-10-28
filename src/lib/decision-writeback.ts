/**
 * Post the decision onto the GitHub issue the row key names, then remove
 * the decision labels. The target is only `github:<owner/repo>#<n>` on the
 * key. `repo`, `number`, and anything in the request are ignored.
 *
 * Tests inject a client. With no GH_TOKEN or GITHUB_TOKEN, no request is made.
 */

import {
  claimDecisionWriteback,
  decisionWritebackClaimHeld,
  getDecision,
  isDecisionLabel,
  releaseDecisionWriteback,
  setDecisionWriteback,
  WRITEBACK_LOCK_LEASE_SECONDS,
  type Decision,
} from "./decisions";
import {
  buildDecisionComment,
  commentRecordsThisDecision,
  githubTargetFromKey,
} from "./decision-format";
import { DECISION_LABEL_PATTERNS } from "./progress-config";

export { WRITEBACK_LOCK_LEASE_SECONDS };

/** A crashed writer keeps the lock only this long, so a retry can finish label removal. */
const WRITEBACK_LOCK_WAIT_MS = 20_000;

export class GitHubWriteError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "GitHubWriteError";
  }
}

export interface GitHubIssueSnapshot {
  state: string;
  labels: { name: string }[];
}

export interface GitHubComment {
  body: string;
  author?: string | null;
}

export interface GitHubWriteClient {
  getIssue(repo: string, number: number): Promise<GitHubIssueSnapshot>;
  listComments(repo: string, number: number): Promise<GitHubComment[]>;
  createComment(repo: string, number: number, body: string): Promise<void>;
  removeLabel(repo: string, number: number, name: string): Promise<void>;
  /** Login of the token. Absent or a failure means author is not checked. */
  viewer?(): Promise<string | null>;
}

export type WritebackOutcome =
  | { status: "written"; commented: boolean; labels_removed: string[] }
  | { status: "not_written"; reason: string }
  | { status: "no_target" }
  | { status: "superseded" };

let clientOverride: { client: GitHubWriteClient | null } | null = null;

/** `null` forces no client, even when a token is set. Call with no override via `clear`. */
export function setGitHubWriteClientForTests(client: GitHubWriteClient | null): void {
  clientOverride = { client };
}

export function clearGitHubWriteClientForTests(): void {
  clientOverride = null;
}

function githubToken(): string | null {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return token ? token : null;
}

function activeClient(): GitHubWriteClient | null {
  if (clientOverride) return clientOverride.client;
  const token = githubToken();
  if (!token) return null;
  return githubWriteClient(globalThis.fetch.bind(globalThis), token);
}

export function githubWriteClient(fetchImpl: typeof fetch, token: string): GitHubWriteClient {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "agent-kontrol",
    "x-github-api-version": "2022-11-28",
  };

  function repoPath(repo: string): string {
    const slash = repo.indexOf("/");
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);
    return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  async function request(method: string, path: string, body?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: body ? { ...headers, "content-type": "application/json" } : headers,
        body,
      });
    } catch {
      throw new GitHubWriteError("network error");
    }
    if (!res.ok) {
      if (res.status === 403) throw new GitHubWriteError("403");
      if (res.status === 404) throw new GitHubWriteError("404");
      throw new GitHubWriteError(`http ${res.status}`);
    }
    return res;
  }

  return {
    async getIssue(repo, number) {
      const res = await request("GET", `/repos/${repoPath(repo)}/issues/${number}`);
      const json = (await res.json()) as { state?: unknown; labels?: unknown };
      const labels = Array.isArray(json.labels) ? json.labels : [];
      return {
        state: typeof json.state === "string" ? json.state : "",
        labels: labels
          .map((label) => (label && typeof label === "object" ? (label as { name?: unknown }).name : null))
          .filter((name): name is string => typeof name === "string")
          .map((name) => ({ name })),
      };
    },
    async listComments(repo, number) {
      const out: GitHubComment[] = [];
      // GitHub returns oldest comments first. Keep paging past the first
      // thousand so a retry still finds an older canonical comment.
      for (let page = 1; page <= 30; page += 1) {
        const res = await request(
          "GET",
          `/repos/${repoPath(repo)}/issues/${number}/comments?per_page=100&page=${page}`,
        );
        const json = (await res.json()) as unknown;
        if (!Array.isArray(json) || json.length === 0) break;
        for (const item of json) {
          const record = item && typeof item === "object" ? item as { body?: unknown; user?: { login?: unknown } } : {};
          const body = typeof record.body === "string" ? record.body : "";
          const login = record.user && typeof record.user.login === "string" ? record.user.login : null;
          out.push({ body, author: login });
        }
        if (json.length < 100) break;
      }
      return out;
    },
    async viewer() {
      try {
        const res = await request("GET", "/user");
        const json = (await res.json()) as { login?: unknown };
        return typeof json.login === "string" ? json.login : null;
      } catch {
        return null;
      }
    },
    async createComment(repo, number, body) {
      await request("POST", `/repos/${repoPath(repo)}/issues/${number}/comments`, JSON.stringify({ body }));
    },
    async removeLabel(repo, number, name) {
      try {
        await request("DELETE", `/repos/${repoPath(repo)}/issues/${number}/labels/${encodeURIComponent(name)}`);
      } catch (err) {
        if (err instanceof GitHubWriteError && err.reason === "404") return;
        throw err;
      }
    },
  };
}

const localTails = new Map<string, Promise<void>>();

/** One process, no database. Tests and demo mode use this queue. */
function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = localTails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  localTails.set(key, tail);
  void tail.finally(() => {
    if (localTails.get(key) === tail) localTails.delete(key);
  });
  return run;
}

function sameRevision(left: string, right: string): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return !Number.isNaN(a) && a === b;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claim one decided revision. Wait only while that same revision is still
 * decided and another writer holds the lock. A reopen, or any other revision
 * change, returns superseded so the caller does not contact GitHub.
 */
async function claimRevision(
  id: number,
  revision: string,
): Promise<{ ok: true; token: string } | { ok: false; outcome: WritebackOutcome }> {
  const deadline = Date.now() + WRITEBACK_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const token = await claimDecisionWriteback(id, revision);
    if (token) return { ok: true, token };
    const current = await getDecision(id);
    if (!current || current.status !== "decided" || !sameRevision(current.updated_at, revision)) {
      return { ok: false, outcome: { status: "superseded" } };
    }
    await delay(25);
  }
  return { ok: false, outcome: { status: "not_written", reason: "write-back busy" } };
}

async function postDecision(
  client: GitHubWriteClient,
  row: Pick<Decision, "actor_id" | "decided_at" | "decision">,
  target: { repo: string; number: number },
  stillHeld: () => Promise<boolean>,
): Promise<WritebackOutcome> {
  try {
    const issue = await client.getIssue(target.repo, target.number);
    if (issue.state === "closed") return { status: "not_written", reason: "issue closed" };
    const expected = buildDecisionComment({
      who: row.actor_id ?? "unknown",
      date: row.decided_at ?? new Date().toISOString(),
      text: row.decision ?? "",
    });
    let viewer: string | null = null;
    if (client.viewer) {
      try {
        viewer = await client.viewer();
      } catch {
        viewer = null;
      }
    }
    const comments = await client.listComments(target.repo, target.number);
    const already = comments.some((comment) => commentRecordsThisDecision(comment, expected, viewer));
    if (!already) {
      if (!(await stillHeld())) return { status: "superseded" };
      await client.createComment(target.repo, target.number, expected);
    }
    const labels = issue.labels
      .map((label) => label.name)
      .filter((name) => isDecisionLabel(name, DECISION_LABEL_PATTERNS));
    for (const name of labels) {
      if (!(await stillHeld())) return { status: "superseded" };
      await client.removeLabel(target.repo, target.number, name);
    }
    if (!(await stillHeld())) return { status: "superseded" };
    return { status: "written", commented: !already, labels_removed: labels };
  } catch (err) {
    const reason = err instanceof GitHubWriteError ? err.reason : "network error";
    return { status: "not_written", reason };
  }
}

/**
 * Comment and unlabel the issue named by `row.key`. A closed issue is not
 * commented. A comment counts as already posted only when it contains the
 * canonical decision text. The marker alone does not.
 *
 * The writer claims `row.updated_at` while the row is still decided, before
 * any GitHub call. Reopening conflicts until that claim is released. The
 * writeback stamp matches the same revision and `status = 'decided'`, and it
 * runs before the claim is released. A row that was reopened is not posted
 * and is not stamped.
 */
export async function writeDecisionBack(
  row: Pick<Decision, "id" | "key" | "actor_id" | "decided_at" | "decision" | "updated_at">,
): Promise<WritebackOutcome> {
  const target = githubTargetFromKey(row.key);
  if (!target) return { status: "no_target" };
  const client = activeClient();
  const revision = row.updated_at;
  if (!client) return publish(row.id, revision, null, target, row);
  return withLocalLock(row.key, () => publish(row.id, revision, client, target, row));
}

async function publish(
  id: number,
  revision: string,
  client: GitHubWriteClient | null,
  target: { repo: string; number: number },
  row: Pick<Decision, "actor_id" | "decided_at" | "decision">,
): Promise<WritebackOutcome> {
  const claimed = await claimRevision(id, revision);
  if (!claimed.ok) return claimed.outcome;
  const token = claimed.token;
  try {
    const outcome = client
      ? await postDecision(client, row, target, () => decisionWritebackClaimHeld(id, token, revision))
      : { status: "not_written" as const, reason: "no token" };
    if (outcome.status === "superseded") return outcome;
    const stamp = outcome.status === "written" ? "written" : "not_written";
    const stamped = await setDecisionWriteback(id, stamp, revision);
    if (!stamped) return { status: "superseded" };
    return outcome;
  } finally {
    await releaseDecisionWriteback(id, token);
  }
}
