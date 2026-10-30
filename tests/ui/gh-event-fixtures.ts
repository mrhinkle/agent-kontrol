/**
 * Trimmed GitHub webhook payloads, one per accepted event, shaped after
 * docs.github.com "Webhook events and payloads". Shared by
 * tests/ui/webhook.test.ts and scripts/run-pg-tests.ts.
 */

export const REPO = "acme/widgets";
export const SHA_A = "6dcb09b5b57875f334f61aebed695e2e4193db5e";
export const SHA_B = "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c";

const repository = {
  id: 1296269,
  name: "widgets",
  full_name: REPO,
  private: false,
  owner: { login: "acme", id: 1, type: "Organization" },
};
const sender = { login: "octocat", id: 583231, type: "User" };
const installation = { id: 42 };

export interface EventFixture {
  event: string;
  payload: Record<string, unknown>;
  expect: { action: string | null; repo: string; number: number | null; head_sha: string | null };
}

export const EVENT_FIXTURES: EventFixture[] = [
  {
    event: "pull_request",
    payload: {
      action: "opened",
      number: 7,
      pull_request: { number: 7, state: "open", title: "Add widget", head: { ref: "feat", sha: SHA_A }, base: { ref: "main", sha: SHA_B } },
      repository,
      sender,
      installation,
    },
    expect: { action: "opened", repo: REPO, number: 7, head_sha: SHA_A },
  },
  {
    event: "pull_request_review",
    payload: {
      action: "submitted",
      review: { id: 80, state: "approved", body: "LGTM", commit_id: SHA_A },
      pull_request: { number: 7, head: { ref: "feat", sha: SHA_A }, base: { ref: "main", sha: SHA_B } },
      repository,
      sender,
    },
    expect: { action: "submitted", repo: REPO, number: 7, head_sha: SHA_A },
  },
  {
    event: "issues",
    payload: {
      action: "labeled",
      issue: { number: 12, title: "Bug", state: "open", labels: [{ name: "needs-owner" }] },
      label: { name: "needs-owner" },
      repository,
      sender,
    },
    expect: { action: "labeled", repo: REPO, number: 12, head_sha: null },
  },
  {
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" } },
      comment: { id: 99, body: "Robert'); DROP TABLE gh_events;-- $(rm -rf /) `id`" },
      repository,
      sender,
    },
    expect: { action: "created", repo: REPO, number: 7, head_sha: null },
  },
  {
    event: "check_suite",
    payload: {
      action: "completed",
      check_suite: {
        id: 5,
        head_branch: "feat",
        head_sha: SHA_A,
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 7, head: { ref: "feat", sha: SHA_A }, base: { ref: "main", sha: SHA_B } }],
      },
      repository,
      sender,
    },
    expect: { action: "completed", repo: REPO, number: 7, head_sha: SHA_A },
  },
  {
    event: "workflow_run",
    payload: {
      action: "completed",
      workflow_run: {
        id: 30433642,
        name: "CI",
        head_branch: "feat",
        head_sha: SHA_A,
        status: "completed",
        conclusion: "failure",
        pull_requests: [
          { number: 7, head: { ref: "feat", sha: SHA_A }, base: { ref: "main", sha: SHA_B } },
          { number: 8, head: { ref: "feat", sha: SHA_A }, base: { ref: "release", sha: SHA_B } },
        ],
      },
      workflow: { id: 1, name: "CI" },
      repository,
      sender,
    },
    expect: { action: "completed", repo: REPO, number: null, head_sha: SHA_A },
  },
  {
    event: "status",
    payload: {
      id: 214015194,
      sha: SHA_A,
      name: REPO,
      context: "ci/postgres",
      state: "success",
      branches: [{ name: "feat", commit: { sha: SHA_A } }],
      repository,
      sender,
    },
    expect: { action: null, repo: REPO, number: null, head_sha: SHA_A },
  },
  {
    event: "push",
    payload: {
      ref: "refs/heads/main",
      before: SHA_B,
      after: SHA_A,
      created: false,
      deleted: false,
      forced: false,
      commits: [{ id: SHA_A, message: "fix: quote ' and \" and \\ survive\nsecond line" }],
      head_commit: { id: SHA_A },
      repository,
      pusher: { name: "octocat" },
      sender,
    },
    expect: { action: null, repo: REPO, number: null, head_sha: SHA_A },
  },
];

export const PING_PAYLOAD = { zen: "Keep it logically awesome.", hook_id: 123, hook: { type: "App", events: ["pull_request"] } };
