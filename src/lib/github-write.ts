import { GITHUB_API, GITHUB_API_VERSION, GitHubCallError, classifyGitHubResponse, repoPath, type GitHubAuthorizer } from "./github-read";

/**
 * Writes for reducers (#80). Merge-base only: PUT update-branch with
 * expected_head_sha. There is no rebase argument and no force flag.
 * A 422 from GitHub is stale_head: the caller must not merge that head.
 * Removing a label that is already gone (404) is success.
 */

const FETCH_TIMEOUT_MS = 15_000;

export interface GitHubWriteClient {
  comment(repo: string, number: number, body: string): Promise<void>;
  removeLabel(repo: string, number: number, label: string): Promise<void>;
  mergeBaseIntoPull(repo: string, number: number, expectedHeadSha: string): Promise<void>;
  requestReviewers(repo: string, number: number, reviewers: string[]): Promise<void>;
}

export function githubWriteClient(
  auth: GitHubAuthorizer,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): GitHubWriteClient {
  async function call(repo: string, method: string, path: string, body?: string, allow404 = false): Promise<void> {
    const issued = await auth.tokenFor(repo);
    let response: Response;
    try {
      response = await fetchImpl(`${GITHUB_API}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${issued.token}`,
          "user-agent": "agent-kontrol",
          "x-github-api-version": GITHUB_API_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubCallError(0, "http", null);
    }
    if (response.status >= 300 && response.status < 400) throw new GitHubCallError(response.status, "http", null);
    const text = await response.text();
    if (allow404 && response.status === 404) return;
    if (response.status === 422 && method === "PUT" && path.endsWith("/update-branch")) {
      throw new GitHubCallError(422, "stale_head", null);
    }
    const error = classifyGitHubResponse(response.status, text, response.headers, now());
    if (error) throw error;
  }

  return {
    comment(repo, number, body) {
      return call(repo, "POST", `/repos/${repoPath(repo)}/issues/${number}/comments`, JSON.stringify({ body }));
    },
    removeLabel(repo, number, label) {
      return call(
        repo,
        "DELETE",
        `/repos/${repoPath(repo)}/issues/${number}/labels/${encodeURIComponent(label)}`,
        undefined,
        true,
      );
    },
    mergeBaseIntoPull(repo, number, expectedHeadSha) {
      // Merge commit of the base into the PR branch. expected_head_sha is the
      // only field: GitHub rejects the call when the head has moved.
      return call(
        repo,
        "PUT",
        `/repos/${repoPath(repo)}/pulls/${number}/update-branch`,
        JSON.stringify({ expected_head_sha: expectedHeadSha }),
      );
    },
    requestReviewers(repo, number, reviewers) {
      if (reviewers.length === 0) return Promise.resolve();
      return call(
        repo,
        "POST",
        `/repos/${repoPath(repo)}/pulls/${number}/requested_reviewers`,
        JSON.stringify({ reviewers }),
      );
    },
  };
}
