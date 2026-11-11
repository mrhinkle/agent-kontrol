import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { assembleBrief, formatBriefText } from "../../src/lib/brief";
import { setSqlForTests } from "../../src/lib/db";
import {
  classifyGitHubResponse,
  githubAppJwt,
  githubReadClient,
  GitHubCallError,
  GitHubListTruncatedError,
  installationAuthorizer,
  normalizePem,
  type GhIssue,
  type GhPull,
} from "../../src/lib/github-read";
import { githubWriteClient } from "../../src/lib/github-write";
import {
  formatReducerFailureLines,
  memoryReducerLock,
  memoryTransitionStore,
  sqlReducerLock,
  sqlTransitionStore,
} from "../../src/lib/reducer-store";
import {
  blockedByIssueNumbers,
  CANONICAL_EVENT_IDS,
  CATALOGUE,
  CONSUMERS,
  handlerFor,
  nextBackoffSeconds,
  productionReducerDeps,
  reduceEvent,
  reducerMarker,
  reducerMode,
  renderReducerCatalogueMarkdown,
  transitionKey,
  type ReducerDeps,
  type ReducerEvent,
  type ReducerGitHub,
} from "../../src/lib/reducers";
import { SWEEP_CONDITIONS } from "../../src/lib/sweep-logic";

/**
 * Failure cases F1–F16 for deterministic reducers. GitHub is a fake.
 * These tests try to make a retry, an echo, or a stale head succeed.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);
const MAIN = "c".repeat(40);
const NEW = "d".repeat(40);
const BOT = "agent-kontrol[bot]";

afterEach(() => {
  setSqlForTests(null);
});

function pull(over: Partial<GhPull> = {}): GhPull {
  return {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    headSha: A,
    headRef: "feature",
    baseRef: "main",
    fork: false,
    maintainerCanModify: true,
    mergeableState: "behind",
    mergeable: true,
    reviewers: ["octocat"],
    ...over,
  };
}

function issue(over: Partial<GhIssue> = {}): GhIssue {
  return { number: 12, state: "open", body: "", labels: [], ...over };
}

function event(over: Partial<ReducerEvent> = {}): ReducerEvent {
  return {
    delivery_id: "d1",
    event: "pull_request",
    action: "opened",
    repo: "acme/app",
    number: 7,
    head_sha: A,
    payload: { sender: { login: "octocat" } },
    received_at: "2026-11-10T12:00:00.000Z",
    ...over,
  };
}

function harness(mode: ReducerDeps["mode"] = "on") {
  let now = Date.parse("2026-11-10T12:00:00.000Z");
  const store = memoryTransitionStore();
  const calls: string[] = [];
  const github: ReducerGitHub = {
    botLogin: () => BOT,
    getRepo: async () => { throw new Error("unexpected getRepo"); },
    getPull: async () => { throw new Error("unexpected getPull"); },
    getIssue: async () => { throw new Error("unexpected getIssue"); },
    listOpenPulls: async () => { throw new Error("unexpected listOpenPulls"); },
    listOpenIssues: async () => { throw new Error("unexpected listOpenIssues"); },
    listComments: async () => { throw new Error("unexpected listComments"); },
    branchProtected: async () => { throw new Error("unexpected branchProtected"); },
    requiredContexts: async () => { throw new Error("unexpected requiredContexts"); },
    checkConclusions: async () => { throw new Error("unexpected checkConclusions"); },
    comment: async () => { throw new Error("unexpected comment"); },
    removeLabel: async () => { throw new Error("unexpected removeLabel"); },
    mergeBaseIntoPull: async () => { throw new Error("unexpected merge"); },
    requestReviewers: async () => { throw new Error("unexpected reviewers"); },
  };
  const deps: ReducerDeps = {
    mode,
    now: () => now,
    botLogin: BOT,
    store,
    locks: memoryReducerLock(),
    github,
    sleep: async (ms) => { now += ms; },
    lockWaitMs: 1_000,
    lockPollMs: 10,
    lockTtlMs: 60_000,
    blockedLabel: "blocked",
    decisionLabels: ["needs-owner", "owner-gate-*", "decision"],
    causedByWindowMs: 120_000,
  };
  return {
    deps,
    store,
    github,
    calls,
    setNow: (value: number) => { now = value; },
    advance: (ms: number) => { now += ms; },
    note: (name: string) => { calls.push(name); },
  };
}

describe("reducer catalogue", () => {
  it("names every canonical id, keeps handlers separate from the catalogue, and matches the generated docs", () => {
    const src = fs.readFileSync("src/lib/reducers.ts", "utf8");
    const handlerSrc = src.slice(src.indexOf("export function handlerFor"), src.indexOf("function catalogueId"));
    const gate = [
      "pull_request.opened",
      "pull_request.synchronize",
      "pull_request.ready_for_review",
      "pull_request.closed",
      "issues.closed",
      "issues.labeled",
      "push",
      "check_suite.completed",
      "pull_request_review.submitted",
    ];
    const markdown = renderReducerCatalogueMarkdown();
    const docs = fs.readFileSync("docs/EVENTS.md", "utf8");
    const region = docs.slice(docs.indexOf("<!-- reducer-catalogue:start -->"), docs.indexOf("<!-- reducer-catalogue:end -->"));
    for (const id of gate) {
      assert.ok(CANONICAL_EVENT_IDS.includes(id as (typeof CANONICAL_EVENT_IDS)[number]), id);
      assert.match(markdown, new RegExp(`\\| ${id.replace(".", "\\.")} \\|`));
      assert.match(region, new RegExp(id.replace(".", "\\.")));
    }
    assert.ok(region.includes(markdown), "checked-in catalogue matches the generator");
    for (const row of CATALOGUE) {
      assert.ok((CONSUMERS as readonly string[]).includes(row.consumer), row.id);
      assert.equal(typeof handlerFor(row.id), "function", row.id);
      if (!row.id.startsWith("sweep:")) assert.match(handlerSrc, new RegExp(`case "${row.id}"`));
      if (!row.id.startsWith("sweep:")) assert.equal(row.writes, row.id === "issues.closed" || row.id === "push");
      if (row.id.startsWith("sweep:")) assert.equal(row.writes, false);
    }
    assert.equal(handlerFor("not-an-event"), undefined);
    assert.equal(handlerFor("sweep:nope"), undefined);
    assert.equal(handlerFor("sweep:pr-stuck"), handlerFor("sweep:pr-stuck-cleared"));
    assert.notEqual(handlerFor("pull_request.opened"), handlerFor("push"));
    assert.doesNotMatch(handlerSrc, /CATALOGUE/);
    assert.doesNotMatch(src, /gh_events/);
    assert.doesNotMatch(src, /openai|anthropic|generateText|@ai-sdk/i);
    assert.match(fs.readFileSync("scripts/generate-reducer-docs.ts", "utf8"), /renderReducerCatalogueMarkdown/);
  });

  it("keeps the reducer tables in schema.sql and the changelog migration", () => {
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const migration = fs.readFileSync("supabase/migrations/20261110_reducer_transitions.sql", "utf8");
    const apply = fs.readFileSync("scripts/apply-schema.mjs", "utf8");
    for (const sql of [schema, migration]) {
      assert.match(sql, /create table if not exists reducer_transitions/i);
      assert.match(sql, /transition_key text primary key check \(char_length\(transition_key\) between 1 and 500\)/i);
      assert.match(sql, /status in \('started', 'half_done', 'done', 'failed', 'skipped', 'dropped'\)/i);
      assert.match(sql, /attempts >= 0 and attempts <= 5/i);
      assert.match(sql, /create table if not exists reducer_locks/i);
      assert.match(sql, /expires_at timestamptz not null/i);
    }
    assert.match(apply, /schema\.sql/);
    assert.doesNotMatch(apply, /migrations/);
  });
});

describe("reducer helpers", () => {
  it("treats unset, blank, 0, and unknown flag values as off", () => {
    const env = (flag?: string): NodeJS.ProcessEnv => ({ NODE_ENV: "test", MC_REDUCERS: flag });
    assert.equal(reducerMode(env()), "off");
    assert.equal(reducerMode(env("")), "off");
    assert.equal(reducerMode(env("0")), "off");
    assert.equal(reducerMode(env("  ")), "off");
    assert.equal(reducerMode(env("yes")), "off");
    assert.equal(reducerMode(env("dry")), "dry");
    assert.equal(reducerMode(env("1")), "on");
    assert.equal(reducerMode(env(" on ")), "on");
    assert.equal(productionReducerDeps(env()).mode, "off");
  });

  it("doubles backoff from 30s and lets a longer Retry-After win past the cap", () => {
    assert.equal(nextBackoffSeconds(1, null), 30);
    assert.equal(nextBackoffSeconds(2, null), 60);
    assert.equal(nextBackoffSeconds(3, null), 120);
    assert.equal(nextBackoffSeconds(4, null), 240);
    assert.equal(nextBackoffSeconds(5, null), 480);
    assert.equal(nextBackoffSeconds(6, null), 600);
    assert.equal(nextBackoffSeconds(1, 10), 30);
    assert.equal(nextBackoffSeconds(2, 5_000), 5_000);
  });

  it("parses same-repo blockers and ignores code, quotes, other repos, and bad numbers", () => {
    const cases: Array<[string, number[]]> = [
      ["Blocked by #15", [15]],
      ["Blocked by #15, #16 and #17", [15, 16, 17]],
      ["See ```\nBlocked by #4\n```\nBlocked by #5", [5]],
      ["Use `Blocked by #8` then Blocked by #9", [9]],
      ["> Blocked by #3\nBlocked by #4", [4]],
      ["  > Blocked by #3\nBlocked by #4", [4]],
      ["Blocked by other/repo#12 and #13", [13]],
      ["Blocked by #, #0, and #12abc", []],
      ["blocked by #2.", [2]],
    ];
    for (const [body, expect] of cases) {
      assert.deepEqual(blockedByIssueNumbers(body), expect, body);
    }
  });
});

describe("reducer failure cases", () => {
  it("F1 replays one opened event as one transition and one read", async () => {
    const h = harness();
    let reads = 0;
    h.github.getPull = async () => { reads += 1; return pull(); };
    const first = await reduceEvent(event(), h.deps);
    const second = await reduceEvent(event(), h.deps);
    assert.equal(first.outcome, "done");
    assert.deepEqual(first.emitted, ["work-item"]);
    assert.equal(first.row?.steps.work_item && (first.row.steps.work_item as { kind: string }).kind, "work-item");
    assert.equal(second.replay, true);
    assert.equal(second.transition_key, first.transition_key);
    assert.equal(reads, 1);
    assert.equal(h.store.rows().length, 1);
  });

  it("F2 creates no state when closed arrives before the pull or issue exists", async () => {
    const closedPull = harness();
    closedPull.github.getPull = async () => null;
    const pullResult = await reduceEvent(event({ action: "closed", delivery_id: "close-pull" }), closedPull.deps);
    assert.equal(pullResult.outcome, "no_state");
    assert.equal(closedPull.store.rows().length, 0);

    const closedIssue = harness();
    closedIssue.github.getIssue = async () => issue({ number: 15, state: "open" });
    const issueResult = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "close-issue",
    }), closedIssue.deps);
    assert.equal(issueResult.outcome, "no_state");
    assert.equal(closedIssue.store.rows().length, 0);
  });

  it("F3 records a malformed payload once and does not call GitHub again", async () => {
    const h = harness();
    const bad = event({ number: null, delivery_id: "bad" });
    const first = await reduceEvent(bad, h.deps);
    const second = await reduceEvent(bad, h.deps);
    assert.equal(first.outcome, "dropped");
    assert.equal(first.reason, "malformed");
    assert.equal(first.attempts, 0);
    assert.equal(second.replay, true);
    assert.equal(h.store.rows().length, 1);

    const push = harness();
    const pushResult = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: "nope", delivery_id: "bad-push",
    }), push.deps);
    assert.equal(pushResult.reason, "malformed");

    const checks = harness();
    checks.github.getRepo = async () => ({ defaultBranch: "main" });
    checks.github.requiredContexts = async () => ["ci"];
    checks.github.checkConclusions = async () => ({ ci: "success" });
    const checkResult = await reduceEvent(event({
      event: "check_suite", action: "completed", number: null, head_sha: A, delivery_id: "cs",
    }), checks.deps);
    assert.equal(checkResult.outcome, "done");
    assert.deepEqual(checkResult.emitted, ["contexts-green"]);
  });

  it("F4 serializes two events for one PR and lets two repos overlap", async () => {
    const same = harness();
    same.deps.now = () => Date.now();
    same.deps.sleep = undefined;
    same.deps.lockWaitMs = 2_000;
    let current = 0;
    let max = 0;
    same.github.getPull = async () => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 40));
      current -= 1;
      return pull();
    };
    await Promise.all([
      reduceEvent(event({ delivery_id: "a" }), same.deps),
      reduceEvent(event({ delivery_id: "b", head_sha: B }), same.deps),
    ]);
    assert.equal(max, 1);

    const both = harness();
    both.deps.now = () => Date.now();
    both.deps.sleep = undefined;
    both.deps.lockWaitMs = 2_000;
    let live = 0;
    let peak = 0;
    both.github.getPull = async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 40));
      live -= 1;
      return pull();
    };
    await Promise.all([
      reduceEvent(event({ delivery_id: "a", repo: "acme/app" }), both.deps),
      reduceEvent(event({ delivery_id: "b", repo: "other/app" }), both.deps),
    ]);
    assert.equal(peak, 2);
  });

  it("F6 drops the bot echo and still processes a human comment and label in the same second", async () => {
    const h = harness();
    const pr = pull();
    const merges: string[] = [];
    const reviewers: string[][] = [];
    h.github.getRepo = async () => ({ defaultBranch: "main" });
    h.github.listOpenPulls = async () => [pr];
    h.github.branchProtected = async () => false;
    h.github.getPull = async () => pull({ headSha: pr.headSha, reviewers: pr.reviewers });
    h.github.mergeBaseIntoPull = async (_repo, _number, sha) => {
      const parent = await h.store.get(transitionKey("push", "acme/app", null, MAIN));
      assert.equal(parent?.status, "started");
      merges.push(sha);
      pr.headSha = NEW;
    };
    h.github.requestReviewers = async (_repo, _number, logins) => { reviewers.push(logins); };
    h.github.getIssue = async (_repo, number) => issue({ number, labels: number === 7 ? ["needs-owner"] : [] });

    const pushed = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "push-1",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), h.deps);
    assert.equal(pushed.outcome, "done");
    assert.deepEqual(pushed.emitted, ["update-branch"]);
    assert.deepEqual(merges, [A]);
    assert.deepEqual(reviewers, [["octocat"]]);

    const echoPush = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: NEW, delivery_id: "echo-push",
      payload: { ref: "refs/heads/feature", sender: { login: BOT } },
    }), h.deps);
    assert.equal(echoPush.reason, "echo");
    assert.deepEqual(merges, [A]);

    const echoSync = await reduceEvent(event({
      action: "synchronize", head_sha: NEW, delivery_id: "echo-sync",
      payload: { sender: { login: BOT } },
    }), h.deps);
    assert.equal(echoSync.reason, "echo");
    assert.deepEqual(merges, [A]);

    const comment = await reduceEvent(event({
      event: "issue_comment", action: "created", head_sha: null, delivery_id: "human-comment",
      payload: { sender: { login: "octocat" } },
    }), h.deps);
    assert.equal(comment.outcome, "done");
    assert.deepEqual(comment.emitted, ["comment-seen"]);
    assert.notEqual(comment.reason, "echo");

    const label = await reduceEvent(event({
      event: "issues", action: "labeled", head_sha: null, delivery_id: "human-label",
      payload: { sender: { login: "octocat" }, label: { name: "needs-owner" } },
    }), h.deps);
    assert.deepEqual(label.emitted, ["decision-label-added"]);

    h.github.listOpenPulls = async () => { throw new Error("non-default must not list pulls"); };
    const humanPush = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: B, delivery_id: "human-push",
      payload: { ref: "refs/heads/feature", sender: { login: "octocat" } },
    }), h.deps);
    assert.equal(humanPush.reason, "non_default");
    assert.deepEqual(merges, [A]);
  });

  it("F7 does not double-comment when the label write fails or the comment response is lost", async () => {
    const bodies: string[] = [];
    let labelFails = true;
    let labelCalls = 0;
    const h = harness();
    h.github.getIssue = async (_repo, number) => {
      if (number === 15) return issue({ number: 15, state: "closed" });
      return issue({ number: 12, body: "Blocked by #15", labels: ["blocked"] });
    };
    h.github.listOpenIssues = async () => [issue({ number: 12, body: "Blocked by #15", labels: ["blocked"] })];
    h.github.listComments = async () => bodies.map((body) => ({ body }));
    h.github.comment = async (_repo, _number, body) => { bodies.push(body); };
    h.github.removeLabel = async () => {
      labelCalls += 1;
      if (labelFails) throw new GitHubCallError(500, "http", null);
    };

    const first = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "unblock",
    }), h.deps);
    assert.equal(first.outcome, "half_done");
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /agent-kontrol-reducer:v1/);
    assert.match(bodies[0], /Unblocked: #15 closed\./);
    assert.equal(labelCalls, 1);

    labelFails = false;
    const second = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "unblock",
    }), h.deps);
    assert.equal(second.outcome, "done");
    assert.equal(bodies.length, 1);
    assert.equal(labelCalls, 2);
    assert.deepEqual(second.emitted, ["became-unblocked"]);

    const lost = harness();
    const lostBodies: string[] = [];
    lost.github.getIssue = h.github.getIssue;
    lost.github.listOpenIssues = h.github.listOpenIssues;
    lost.github.listComments = async () => lostBodies.map((body) => ({ body }));
    lost.github.comment = async (_repo, _number, body) => {
      lostBodies.push(body);
      throw new GitHubCallError(0, "http", null);
    };
    lost.github.removeLabel = async () => {};
    const lostFirst = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "lost",
    }), lost.deps);
    assert.equal(lostFirst.outcome, "failed");
    lost.advance(120_000);
    const lostSecond = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "lost",
    }), lost.deps);
    assert.equal(lostSecond.outcome, "done");
    assert.equal(lostBodies.length, 1);

    const reverse = harness();
    const reverseBodies: string[] = [];
    let reverseLabels = 0;
    const key = transitionKey("issues.closed", "acme/app", 15, "reverse");
    await reverse.store.insert({
      transition_key: key,
      reducer: "issues.closed",
      repo: "acme/app",
      number: 15,
      head_sha: null,
      status: "half_done",
      reason: null,
      steps: { deliveries: ["reverse"], dependents: { "12": { unlabel: true } } },
      attempts: 1,
    }, "2026-11-10T12:00:00.000Z");
    reverse.github.getIssue = h.github.getIssue;
    reverse.github.listOpenIssues = h.github.listOpenIssues;
    reverse.github.listComments = async () => reverseBodies.map((body) => ({ body }));
    reverse.github.comment = async (_repo, _number, body) => { reverseBodies.push(body); };
    reverse.github.removeLabel = async () => { reverseLabels += 1; };
    const finished = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "reverse",
    }), reverse.deps);
    assert.equal(finished.outcome, "done");
    assert.equal(reverseBodies.length, 1);
    assert.equal(reverseLabels, 0);
  });

  it("F8 does not merge a head that moved, and does not compare the PR head to the push sha", async () => {
    const moved = harness();
    let reads = 0;
    const merges: string[] = [];
    moved.github.getRepo = async () => ({ defaultBranch: "main" });
    moved.github.listOpenPulls = async () => [pull()];
    moved.github.branchProtected = async () => false;
    moved.github.getPull = async () => {
      reads += 1;
      return pull({ headSha: reads === 1 ? A : B });
    };
    moved.github.mergeBaseIntoPull = async (_repo, _number, sha) => { merges.push(sha); };
    const result = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "move",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), moved.deps);
    assert.equal(result.outcome, "done");
    assert.deepEqual(result.emitted, []);
    assert.deepEqual(merges, []);
    assert.equal(moved.store.rows().some((row) => row.reason === "stale_head"), true);

    const stable = harness();
    const seen: string[] = [];
    const pr = pull();
    stable.github.getRepo = async () => ({ defaultBranch: "main" });
    stable.github.listOpenPulls = async () => [pr];
    stable.github.branchProtected = async () => false;
    stable.github.getPull = async () => pull({ headSha: pr.headSha });
    stable.github.mergeBaseIntoPull = async (_repo, _number, sha) => { seen.push(sha); pr.headSha = NEW; };
    stable.github.requestReviewers = async () => {};
    await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "stable",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), stable.deps);
    assert.deepEqual(seen, [A]);
  });

  it("F9 unblocks only when every same-repo blocker outside code and quotes is closed", async () => {
    async function run(body: string, blockerState: "open" | "closed" | "missing") {
      const h = harness();
      const comments: string[] = [];
      h.github.getIssue = async (_repo, number) => {
        if (number === 15) return issue({ number: 15, state: "closed" });
        if (number === 16) {
          if (blockerState === "missing") return null;
          return issue({ number: 16, state: blockerState });
        }
        return issue({ number: 12, body, labels: ["blocked"] });
      };
      h.github.listOpenIssues = async () => [issue({ number: 12, body, labels: ["blocked"] })];
      h.github.listComments = async () => comments.map((text) => ({ body: text }));
      h.github.comment = async (_repo, _number, text) => { comments.push(text); };
      h.github.removeLabel = async (_repo, _number, label) => { assert.equal(label, "blocked"); };
      const result = await reduceEvent(event({
        event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: `b-${comments.length}-${body.length}`,
      }), h.deps);
      return { result, comments };
    }
    const blocked = await run("Blocked by #15, #16", "open");
    assert.equal(blocked.comments.length, 0);
    const ready = await run("Blocked by #15 and #16", "closed");
    assert.equal(ready.comments.length, 1);
    assert.deepEqual(ready.result.emitted, ["became-unblocked"]);
    const coded = await run("```\nBlocked by #15\n```", "closed");
    assert.equal(coded.comments.length, 0);
    const quoted = await run("> Blocked by #15", "closed");
    assert.equal(quoted.comments.length, 0);
    const other = await run("Blocked by other/repo#15", "closed");
    assert.equal(other.comments.length, 0);

    const reopened = harness();
    let writes = 0;
    reopened.github.getIssue = async () => issue({ number: 15, state: "open", body: "Blocked by #15" });
    reopened.github.comment = async () => { writes += 1; };
    const again = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "reopened",
    }), reopened.deps);
    assert.equal(again.outcome, "no_state");
    assert.equal(writes, 0);
    assert.equal(reopened.store.rows().length, 0);
  });

  it("F10 keeps acme/app#12 and other/app#12 apart, and folds Acme/App onto acme/app", async () => {
    const h = harness();
    h.github.getPull = async () => pull({ number: 12 });
    const left = await reduceEvent(event({ repo: "acme/app", number: 12, delivery_id: "left" }), h.deps);
    const right = await reduceEvent(event({ repo: "other/app", number: 12, delivery_id: "right" }), h.deps);
    assert.notEqual(left.transition_key, right.transition_key);
    assert.match(left.transition_key ?? "", /acme\/app#12/);
    assert.match(right.transition_key ?? "", /other\/app#12/);

    const folded = harness();
    folded.github.getPull = async () => pull({ number: 12 });
    const lower = await reduceEvent(event({ repo: "acme/app", number: 12, delivery_id: "fold-1" }), folded.deps);
    const upper = await reduceEvent(event({ repo: "Acme/App", number: 12, delivery_id: "fold-2" }), folded.deps);
    assert.equal(lower.transition_key, upper.transition_key);
    assert.equal(upper.replay, true);
    assert.equal(folded.store.rows().length, 1);
  });

  it("F11 records auth and rate-limit failures, honors Retry-After, and stops at five", async () => {
    const h = harness();
    let calls = 0;
    h.github.getPull = async () => {
      calls += 1;
      throw new GitHubCallError(403, "missing_permission", null);
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await reduceEvent(event({ delivery_id: "perm" }), h.deps);
      assert.equal(result.outcome, "failed");
      assert.equal(result.reason, "missing_permission");
      const row = h.store.rows()[0];
      if (row.steps.next_attempt_at) h.setNow(Date.parse(row.steps.next_attempt_at) + 1);
    }
    assert.equal(calls, 5);
    const stopped = await reduceEvent(event({ delivery_id: "perm" }), h.deps);
    assert.equal(calls, 5);
    assert.equal(stopped.row?.steps.terminal, true);
    assert.equal(stopped.attempts, 5);
    const lines = formatReducerFailureLines([{
      transition_key: stopped.transition_key ?? "",
      reducer: stopped.row?.reducer ?? "",
      repo: "acme/app",
      number: 7,
      reason: "missing_permission",
      attempts: 5,
    }]);
    assert.match(lines[0], /REDUCER FAILURES \(1\) — retry cap reached/);
    assert.match(lines[1], /acme\/app #7  pull_request.opened  missing_permission  attempts=5/);

    const limited = harness();
    limited.github.getPull = async () => { throw new GitHubCallError(429, "rate_limit", 5_000); };
    const rate = await reduceEvent(event({ delivery_id: "rate" }), limited.deps);
    const wait = Date.parse(rate.row?.steps.next_attempt_at ?? "") - limited.deps.now();
    assert.ok(wait >= 5_000_000);
    const early = await reduceEvent(event({ delivery_id: "rate" }), limited.deps);
    assert.equal(early.replay, true);

    const missing = harness();
    missing.github.getPull = async () => { throw new GitHubCallError(404, "not_installed", null); };
    const installed = await reduceEvent(event({ delivery_id: "inst" }), missing.deps);
    assert.equal(installed.reason, "not_installed");
    assert.equal(installed.outcome, "failed");
  });

  it("F12 stays off without GitHub, and dry records a plan until the flag is on", async () => {
    const off = harness("off");
    const skipped = await reduceEvent(event({ number: null, delivery_id: "off-1" }), off.deps);
    const again = await reduceEvent(event({ number: null, delivery_id: "off-1" }), off.deps);
    assert.equal(skipped.reason, "skipped-by-flag");
    assert.equal(skipped.transition_key, "flag-off:off-1");
    assert.equal(again.replay, true);
    assert.equal(off.store.rows().length, 1);

    off.deps.mode = "on";
    off.github.getPull = async () => pull();
    const later = await reduceEvent(event({ delivery_id: "off-1" }), off.deps);
    assert.equal(later.outcome, "done");
    assert.deepEqual(later.emitted, ["work-item"]);

    const dry = harness("dry");
    let writes = 0;
    dry.github.getIssue = async (_repo, number) => number === 15
      ? issue({ number: 15, state: "closed" })
      : issue({ number: 12, body: "Blocked by #15" });
    dry.github.listOpenIssues = async () => [issue({ number: 12, body: "Blocked by #15" })];
    dry.github.listComments = async () => [];
    dry.github.comment = async () => { writes += 1; };
    dry.github.removeLabel = async () => { writes += 1; };
    const planned = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "dry-1",
    }), dry.deps);
    assert.equal(planned.outcome, "skipped");
    assert.equal(planned.reason, "dry_run");
    assert.equal(writes, 0);
    const plan = planned.row?.steps.planned as { actions?: Array<{ action: string }> };
    assert.ok(plan.actions?.some((action) => action.action === "comment"));
    const replay = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "dry-1",
    }), dry.deps);
    assert.equal(replay.replay, true);

    dry.deps.mode = "on";
    dry.github.comment = async (_repo, _number, body) => { writes += 1; assert.match(body, /reducer:v1/); };
    dry.github.removeLabel = async () => { writes += 1; };
    const armed = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "dry-1",
    }), dry.deps);
    assert.equal(armed.outcome, "done");
    assert.equal(writes, 2);
  });

  it("F13 refuses unsafe update-branch cases and merges with expected_head_sha only", async () => {
    async function pushCase(pr: GhPull, protectedBranch = false) {
      const h = harness();
      const merges: string[] = [];
      h.github.getRepo = async () => ({ defaultBranch: "main" });
      h.github.listOpenPulls = async () => [pr];
      h.github.branchProtected = async () => protectedBranch;
      h.github.getPull = async () => pull({ ...pr, headSha: pr.headSha });
      h.github.mergeBaseIntoPull = async (_repo, _number, sha) => { merges.push(sha); };
      h.github.requestReviewers = async () => {};
      const result = await reduceEvent(event({
        event: "push", action: "", number: null, head_sha: MAIN, delivery_id: `p-${pr.headSha}-${pr.mergeableState}`,
        payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
      }), h.deps);
      return { result, merges, h };
    }
    const draft = await pushCase(pull({ draft: true }));
    assert.deepEqual(draft.merges, []);
    assert.equal(draft.h.store.rows().some((row) => row.reason === "draft"), true);
    const fork = await pushCase(pull({ fork: true, maintainerCanModify: false }));
    assert.deepEqual(fork.merges, []);
    assert.equal(fork.h.store.rows().some((row) => row.reason === "fork"), true);
    const current = await pushCase(pull({ mergeableState: "clean", mergeable: true }));
    assert.deepEqual(current.merges, []);
    assert.equal(current.h.store.rows().some((row) => row.reason === "up_to_date"), true);
    const conflict = await pushCase(pull({ mergeable: false, mergeableState: "dirty" }));
    assert.deepEqual(conflict.merges, []);
    assert.deepEqual(conflict.result.emitted, ["update-branch-conflict"]);
    const guarded = await pushCase(pull(), true);
    assert.deepEqual(guarded.merges, []);
    assert.equal(guarded.h.store.rows().some((row) => row.reason === "protected"), true);

    const feature = harness();
    feature.github.getRepo = async () => ({ defaultBranch: "main" });
    feature.github.listOpenPulls = async () => { throw new Error("must not list"); };
    const ignored = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "feature",
      payload: { ref: "refs/heads/feature", sender: { login: "octocat" } },
    }), feature.deps);
    assert.equal(ignored.reason, "non_default");

    const review = harness();
    let merges = 0;
    let reviewCalls = 0;
    const pr = pull();
    review.github.getRepo = async () => ({ defaultBranch: "main" });
    review.github.listOpenPulls = async () => [pr];
    review.github.branchProtected = async () => false;
    review.github.getPull = async () => pull({ headSha: pr.headSha, reviewers: ["octocat"] });
    review.github.mergeBaseIntoPull = async () => { merges += 1; pr.headSha = NEW; };
    review.github.requestReviewers = async () => {
      reviewCalls += 1;
      if (reviewCalls === 1) throw new GitHubCallError(500, "http", null);
    };
    const half = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "review",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), review.deps);
    assert.equal(half.outcome, "half_done");
    assert.equal(merges, 1);
    const done = await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "review",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), review.deps);
    assert.equal(done.outcome, "done");
    assert.equal(merges, 1);
    assert.equal(reviewCalls, 2);

    const lost = harness();
    const lostPr = pull();
    let lostMerges = 0;
    lost.github.getRepo = async () => ({ defaultBranch: "main" });
    lost.github.listOpenPulls = async () => [lostPr];
    lost.github.branchProtected = async () => false;
    lost.github.getPull = async () => pull({ headSha: lostPr.headSha });
    lost.github.mergeBaseIntoPull = async () => {
      lostMerges += 1;
      lostPr.headSha = NEW;
      throw new GitHubCallError(0, "http", null);
    };
    lost.github.requestReviewers = async () => { throw new Error("must not re-request after a lost merge"); };
    await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "lost-merge",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), lost.deps);
    await reduceEvent(event({
      event: "push", action: "", number: null, head_sha: MAIN, delivery_id: "lost-merge",
      payload: { ref: "refs/heads/main", sender: { login: "octocat" } },
    }), lost.deps);
    assert.equal(lostMerges, 1);
  });

  it("F14 releases the lock on throw and replaces an expired holder", async () => {
    const crashed = harness();
    let released = false;
    const inner = memoryReducerLock();
    crashed.deps.locks = {
      tryAcquire: (key, ttl, now) => inner.tryAcquire(key, ttl, now),
      release: async (key, token) => { released = true; await inner.release(key, token); },
    };
    crashed.github.getPull = async () => { throw new Error("boom"); };
    const failed = await reduceEvent(event(), crashed.deps);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.reason, "error");
    assert.equal(released, true);
    crashed.deps.lockWaitMs = 0;
    crashed.github.getPull = async () => pull();
    const next = await reduceEvent(event({ delivery_id: "after-throw", head_sha: B }), crashed.deps);
    assert.notEqual(next.outcome, "busy");

    const locks = memoryReducerLock();
    await locks.tryAcquire("acme/app#7", 1_000, 0);
    const held = harness();
    held.deps.locks = locks;
    held.deps.now = () => 500;
    held.deps.lockWaitMs = 0;
    held.github.getPull = async () => pull();
    const busy = await reduceEvent(event(), held.deps);
    assert.equal(busy.outcome, "busy");
    assert.equal(held.store.rows().length, 0);
    held.deps.now = () => 5_000;
    const taken = await reduceEvent(event(), held.deps);
    assert.equal(taken.outcome, "done");
  });

  it("F15 ignores deleted history and answers from the GitHub re-read", async () => {
    const src = fs.readFileSync("src/lib/reducers.ts", "utf8");
    assert.doesNotMatch(src, /gh_events/);
    async function once(history: () => unknown) {
      const h = harness();
      Object.defineProperty(h.deps, "history", { get: history });
      h.github.getPull = async () => pull({ merged: true, state: "closed" });
      return reduceEvent(event({ action: "closed", delivery_id: "hist" }), h.deps);
    }
    let hits = 0;
    const left = await once(() => { hits += 1; throw new Error("old history"); });
    const right = await once(() => { hits += 1; return ["ancient"]; });
    assert.equal(hits, 0);
    assert.equal(left.outcome, right.outcome);
    assert.deepEqual(left.emitted, right.emitted);
    assert.deepEqual(left.emitted, ["pr-merged"]);
  });

  it("F16 routes sweep rows through the catalogue and does not write to GitHub", async () => {
    const h = harness();
    for (const name of SWEEP_CONDITIONS) {
      for (const suffix of ["", "-cleared"]) {
        const condition = `${name}${suffix}`;
        const result = await reduceEvent(event({
          delivery_id: `sweep:${condition}:abc:e1:s1`,
          event: condition,
          action: "",
          number: null,
          head_sha: null,
        }), h.deps);
        assert.equal(result.outcome, "done", condition);
        assert.equal(result.reason, "routed");
        assert.equal(CATALOGUE.find((row) => row.id === `sweep:${condition}`)?.writes, false);
      }
    }
    const unknown = await reduceEvent(event({
      delivery_id: "sweep:nope:abc:e1",
      event: "nope",
      action: "",
      number: null,
      head_sha: null,
    }), h.deps);
    assert.equal(unknown.reason, "uncatalogued");
    assert.equal(h.store.rows().some((row) => row.reducer === "uncatalogued"), true);
  });

  it("records draft opens, stale reviews, decision labels, and not-green checks without writing", async () => {
    const draft = harness();
    draft.github.getPull = async () => pull({ draft: true });
    const opened = await reduceEvent(event(), draft.deps);
    assert.equal(opened.reason, "draft");
    assert.equal(opened.row?.steps.work_item, undefined);

    const ready = harness();
    ready.github.getPull = async () => pull({ draft: false });
    const reviewReady = await reduceEvent(event({ action: "ready_for_review", delivery_id: "ready" }), ready.deps);
    assert.deepEqual(reviewReady.emitted, ["work-item"]);

    const stale = harness();
    stale.github.getPull = async () => pull({ headSha: B });
    const review = await reduceEvent(event({
      event: "pull_request_review", action: "submitted", delivery_id: "rev",
    }), stale.deps);
    assert.equal(review.reason, "stale_head");

    const labeled = harness();
    labeled.github.getIssue = async () => issue({ labels: ["bug"] });
    const notDecision = await reduceEvent(event({
      event: "issues", action: "labeled", head_sha: null, delivery_id: "bug",
      payload: { label: { name: "bug" } },
    }), labeled.deps);
    assert.equal(notDecision.reason, "not_decision_label");

    const removed = harness();
    removed.github.getIssue = async () => issue({ labels: [] });
    const unlabeled = await reduceEvent(event({
      event: "issues", action: "unlabeled", head_sha: null, delivery_id: "off-label",
      payload: { label: { name: "needs-owner" } },
    }), removed.deps);
    assert.deepEqual(unlabeled.emitted, ["decision-label-removed"]);

    const red = harness();
    red.github.getPull = async () => pull({ baseRef: "main" });
    red.github.requiredContexts = async () => ["ci"];
    red.github.checkConclusions = async () => ({ ci: "failure" });
    const notGreen = await reduceEvent(event({
      event: "check_suite", action: "completed", delivery_id: "red",
    }), red.deps);
    assert.equal(notGreen.reason, "checks_not_green");
    red.github.checkConclusions = async () => ({ ci: "success" });
    const later = await reduceEvent(event({
      event: "check_suite", action: "completed", delivery_id: "green",
    }), red.deps);
    assert.deepEqual(later.emitted, ["contexts-green"]);

    const custom = harness();
    let removedLabel = "";
    custom.deps.blockedLabel = "dependency-blocked";
    custom.github.getIssue = async (_repo, number) => number === 15
      ? issue({ number: 15, state: "closed" })
      : issue({ number: 12, body: "Blocked by #15" });
    custom.github.listOpenIssues = async () => [issue({ number: 12, body: "Blocked by #15" })];
    custom.github.listComments = async () => [{ body: reducerMarker(`${transitionKey("issues.closed", "acme/app", 15, "mark")}:dep#12`) }];
    custom.github.comment = async () => { throw new Error("marker already posted"); };
    custom.github.removeLabel = async (_repo, _number, label) => { removedLabel = label; };
    const marked = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "mark",
    }), custom.deps);
    assert.equal(marked.outcome, "done");
    assert.equal(removedLabel, "dependency-blocked");

    const truncated = harness();
    truncated.github.getIssue = async () => issue({ number: 15, state: "closed" });
    truncated.github.listOpenIssues = async () => { throw new GitHubListTruncatedError(); };
    truncated.github.comment = async () => { throw new Error("partial unblock"); };
    const capped = await reduceEvent(event({
      event: "issues", action: "closed", number: 15, head_sha: null, delivery_id: "cap",
    }), truncated.deps);
    assert.equal(capped.reason, "issue_list_truncated");
  });
});

describe("github installation client", () => {
  it("classifies permission, rate limit, and update-branch 422 without a network call", () => {
    const now = Date.parse("2026-11-10T12:00:00.000Z");
    const headers = (retry: string | null) => new Headers(retry ? { "retry-after": retry } : {});
    assert.equal(classifyGitHubResponse(403, "no", headers(null), now)?.reason, "missing_permission");
    assert.equal(classifyGitHubResponse(404, "missing", headers(null), now)?.reason, "missing_permission");
    assert.equal(classifyGitHubResponse(401, "bad", headers(null), now)?.reason, "token_revoked");
    assert.equal(classifyGitHubResponse(422, "nope", headers(null), now)?.reason, "http");
    const limited = classifyGitHubResponse(403, "secondary rate limit", headers("90"), now);
    assert.equal(limited?.reason, "rate_limit");
    assert.equal(limited?.retryAfterSeconds, 90);
    assert.equal(normalizePem("a\\nb"), "a\nb");
  });

  it("uses the installation token and sends only expected_head_sha", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = githubAppJwt("1", pem, Date.now());
    assert.equal(jwt.split(".").length, 3);
    const seen: string[] = [];
    let updateBody = "";
    const fetchImpl: typeof fetch = async (url, init) => {
      const target = String(url);
      seen.push(`${init?.method ?? "GET"} ${target}`);
      assert.ok(target.startsWith("https://api.github.com"));
      if (target.endsWith("/installation")) return Response.json({ id: 9 });
      if (target.endsWith("/access_tokens")) return Response.json({ token: "installation-token", expires_at: "2099-01-01T00:00:00.000Z" });
      if (target.includes("/issues?state=open")) {
        return Response.json([
          { number: 1, state: "open", body: "", labels: [], pull_request: { url: "https://api.github.com/pulls/1" } },
          { number: 2, state: "open", body: "Blocked by #1", labels: [{ name: "blocked" }] },
        ]);
      }
      if (target.endsWith("/update-branch")) {
        updateBody = String(init?.body ?? "");
        return new Response("expected head", { status: 422 });
      }
      if (target.endsWith("/comments")) return new Response("unprocessable", { status: 422 });
      return new Response("missing", { status: 404 });
    };
    const config = { appId: "1", privateKey: pem, botLogin: BOT };
    const auth = installationAuthorizer(config, fetchImpl);
    const read = githubReadClient(auth, fetchImpl);
    const issues = await read.listOpenIssues("acme/app");
    assert.deepEqual(issues.map((row) => row.number), [2]);
    const write = githubWriteClient(auth, fetchImpl);
    await assert.rejects(() => write.mergeBaseIntoPull("acme/app", 7, A), (error: unknown) => {
      assert.ok(error instanceof GitHubCallError);
      assert.equal(error.reason, "stale_head");
      return true;
    });
    assert.equal(updateBody, JSON.stringify({ expected_head_sha: A }));
    assert.equal(updateBody.includes("rebase"), false);
    assert.equal(updateBody.includes("force"), false);
    await assert.rejects(() => write.comment("acme/app", 7, "hello"), (error: unknown) => {
      assert.ok(error instanceof GitHubCallError);
      assert.equal(error.reason, "http");
      return true;
    });
    const missing = installationAuthorizer(config, async () => new Response("no", { status: 404 }));
    await assert.rejects(() => missing.tokenFor("acme/app"), (error: unknown) => {
      assert.ok(error instanceof GitHubCallError);
      assert.equal(error.reason, "not_installed");
      return true;
    });
    assert.ok(seen.every((line) => line.includes("https://api.github.com")));
  });
});

describe("reducer store and brief", () => {
  it("inserts transitions with on conflict do nothing and takes only an expired lock", async () => {
    const texts: string[] = [];
    setSqlForTests(async (strings, ...values) => {
      const text = strings.join(" ");
      texts.push(text);
      if (text.includes("insert into reducer_locks")) return [{ token: values[1] }];
      if (text.includes("insert into reducer_transitions")) {
        return [{
          transition_key: values[0], reducer: values[1], repo: values[2], number: values[3],
          head_sha: values[4], status: values[5], reason: values[6], steps: {}, attempts: values[8],
          created_at: "2026-11-10T00:00:00.000Z", updated_at: "2026-11-10T00:00:00.000Z",
        }];
      }
      return [];
    });
    const store = sqlTransitionStore();
    const inserted = await store.insert({
      transition_key: "k", reducer: "push", repo: "acme/app", number: null, head_sha: A,
      status: "started", reason: null, steps: {}, attempts: 1,
    }, "2026-11-10T00:00:00.000Z");
    assert.equal(inserted.inserted, true);
    const lock = sqlReducerLock();
    const got = await lock.tryAcquire("acme/app#7", 1_000, 0);
    assert.equal(got.ok, true);
    await lock.release("acme/app#7", got.ok ? got.token : "");
    assert.ok(texts.some((text) => text.includes("on conflict (transition_key) do nothing")));
    assert.ok(texts.some((text) => text.includes("make_interval") && text.includes("expires_at <= now()")));
    assert.ok(texts.some((text) => text.includes("delete from reducer_locks")));
    assert.deepEqual(formatReducerFailureLines([]), []);
  });

  it("prints reducer failures only when the retry cap has rows", () => {
    const brief = assembleBrief({
      generatedAt: "2026-11-10T12:00:00Z",
      windowHours: 24,
      repoSource: "config",
      stuckPrHours: 48,
      staleIssueDays: 21,
      coordinator: { configured: false, agent_id: null },
      repos: [],
    });
    const quiet = formatBriefText(brief, { decisionLabels: [] });
    assert.equal(quiet.includes("REDUCER FAILURES"), false);
    const loud = formatBriefText({
      ...brief,
      reducer_failures: [{
        transition_key: "k", reducer: "issues.closed", repo: "acme/app", number: 15,
        reason: "missing_permission", attempts: 5,
      }],
    }, { decisionLabels: [] });
    assert.match(loud, /REDUCER FAILURES \(1\) — retry cap reached/);
    assert.match(loud, /acme\/app #15  issues\.closed  missing_permission  attempts=5/);

    const src = fs.readFileSync("scripts/morning-brief.sh", "utf8");
    execFileSync("bash", ["-n", "scripts/morning-brief.sh"]);
    const fn = src.slice(src.indexOf("# BEGIN reducer_failure_lines"), src.indexOf("# END reducer_failure_lines"));
    const run = (payload: unknown) => execFileSync("bash", ["-c", `${fn}\nreducer_failure_lines`], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    assert.equal(run({}), "");
    assert.equal(run({ reducer_failures: [] }), "");
    const printed = run({
      reducer_failures: [{ repo: "acme/app", number: 15, reducer: "issues.closed", reason: "missing_permission", attempts: 5 }],
    });
    assert.match(printed, /REDUCER FAILURES \(1\) — retry cap reached/);
    assert.match(printed, /acme\/app #15  issues.closed  missing_permission  attempts=5/);
  });
});
