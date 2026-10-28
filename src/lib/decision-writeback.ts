/**
 * Post the decision onto the GitHub issue the row key names, then remove
 * the decision labels. The target is only `github:<owner/repo>#<n>` on the
 * key. `repo`, `number`, and anything in the request are ignored.
 *
 * Tests inject a client. With no GH_TOKEN or GITHUB_TOKEN, no request is made.
 */

import { isDecisionLabel } from "./decisions";
import type { Decision } from "./decisions";
import {
  DECISION_MARKER,
  buildDecisionComment,
  githubTargetFromKey,
} from "./decision-format";
import { DECISION_LABEL_PATTERNS } from "./progress-config";

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

export interface GitHubWriteClient {
  getIssue(repo: string, number: number): Promise<GitHubIssueSnapshot>;
  listComments(repo: string, number: number): Promise<{ body: string }[]>;
  createComment(repo: string, number: number, body: string): Promise<void>;
  removeLabel(repo: string, number: number, name: string): Promise<void>;
}

export type WritebackOutcome =
  | { status: "written"; commented: boolean; labels_removed: string[] }
  | { status: "not_written"; reason: string }
  | { status: "no_target" };

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
      const out: { body: string }[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const res = await request(
          "GET",
          `/repos/${repoPath(repo)}/issues/${number}/comments?per_page=100&page=${page}`,
        );
        const json = (await res.json()) as unknown;
        if (!Array.isArray(json) || json.length === 0) break;
        for (const item of json) {
          const body = item && typeof item === "object" ? (item as { body?: unknown }).body : "";
          out.push({ body: typeof body === "string" ? body : "" });
        }
        if (json.length < 100) break;
      }
      return out;
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

/**
 * Comment and unlabel the issue named by `row.key`. A closed issue is not
 * commented. A comment that already contains the marker is not posted again.
 * Label removal runs after the comment, so a retry that fails on labels
 * does not post a second comment.
 */
export async function writeDecisionBack(row: Pick<Decision, "key" | "actor_id" | "decided_at" | "decision">): Promise<WritebackOutcome> {
  const target = githubTargetFromKey(row.key);
  if (!target) return { status: "no_target" };
  const client = activeClient();
  if (!client) return { status: "not_written", reason: "no token" };
  try {
    const issue = await client.getIssue(target.repo, target.number);
    if (issue.state === "closed") return { status: "not_written", reason: "issue closed" };
    const comments = await client.listComments(target.repo, target.number);
    const markerPresent = comments.some((comment) => comment.body.includes(DECISION_MARKER));
    if (!markerPresent) {
      await client.createComment(
        target.repo,
        target.number,
        buildDecisionComment({
          who: row.actor_id ?? "unknown",
          date: row.decided_at ?? new Date().toISOString(),
          text: row.decision ?? "",
        }),
      );
    }
    const labels = issue.labels
      .map((label) => label.name)
      .filter((name) => isDecisionLabel(name, DECISION_LABEL_PATTERNS));
    for (const name of labels) {
      await client.removeLabel(target.repo, target.number, name);
    }
    return { status: "written", commented: !markerPresent, labels_removed: labels };
  } catch (err) {
    const reason = err instanceof GitHubWriteError ? err.reason : "network error";
    return { status: "not_written", reason };
  }
}
