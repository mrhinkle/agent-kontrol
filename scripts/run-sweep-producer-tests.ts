/**
 * Tests for scripts/sweep-producer.sh (#79) with a stub gh and a local ingest
 * server. No database, no live GitHub, no real credential. Every captured
 * observation also passes the intake validators in sweep-evidence.ts.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { checkPrSnapshotObservation, checkQueueObservation } from "../src/lib/sweep-evidence";
import { FAKE_TOKEN, Fixture, IngestServer, baseConfig, repoConfig, runProducer, sha, type CtxFixture, type Json, type PrFixture } from "./sweep-producer-fixtures";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-producer-"));
const REPO = "Acme/Widgets";
const OTHER = "acme/gadgets";
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    throw e;
  }
}

function valid(kind: string, obs: Json): void {
  const checked = kind === "sweep.queue" ? checkQueueObservation(obs) : checkPrSnapshotObservation(obs);
  assert.ok(checked.ok, `${kind} passes the intake validator: ${JSON.stringify(checked)}`);
}

function envelopes(stdout: string): Json[] {
  return stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function noSecret(...texts: string[]): void {
  for (const t of texts) assert.ok(!t.includes(FAKE_TOKEN), "the token never appears in output or state");
}

function stateText(fx: Fixture): string {
  if (!fs.existsSync(fx.state)) return "";
  return fs.readdirSync(fx.state).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(fx.state, f), "utf8")).join("\n");
}

// The producer's subject lock file: <state>/<sha256(kind|subject)[:32]>.flock.
function lockFile(fx: Fixture, kindSubject: string): string {
  return path.join(fx.state, crypto.createHash("sha256").update(kindSubject).digest("hex").slice(0, 32) + ".flock");
}
const QUEUE_SUBJECT = "sweep.queue|queue:issues:acme/widgets";

/** Another process holding flock(2) on the file until killed. Resolves once it holds it. */
function holdLock(file: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("perl", ["-MFcntl=:flock", "-e",
      'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; $| = 1; print "held\n"; sleep 600', file],
      { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout!.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`lock holder exited ${code}`)));
  });
}

/** True when no process holds the lock (taken and released at once). */
function lockFree(file: string): boolean {
  const r = spawnSync("perl", ["-MFcntl=:flock", "-e",
    'open(my $fh, ">>", $ARGV[0]) or exit 2; exit(flock($fh, LOCK_EX | LOCK_NB) ? 0 : 1)', file]);
  return r.status === 0;
}

async function until(what: string, test: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Start the producer and return the child, so a test can SIGKILL it mid-run. */
function startProducer(fx: Fixture, args: string[], env: Record<string, string | undefined>): ChildProcess {
  return spawn("bash", [path.join(__dirname, "sweep-producer.sh"), ...args], { env: fx.env(env), stdio: "ignore" });
}

function kill9(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}

const ok = (name: string): PrFixture["contexts"] => [{ kind: "check", name }];
const green = (): NonNullable<PrFixture["contexts"]> => [{ kind: "check", name: "CI" }, { kind: "status", name: "Postgres" }];

/** GitHub Actions app and the agent-kontrol CI workflow, from the captured rollup. */
const ACTIONS = { appId: 15368, appSlug: "github-actions", workflowId: 379180191, workflowName: "CI", event: "pull_request" };
const OLD_RUN = { runId: 43804937161, runNumber: 437, runCreatedAt: "2026-11-16T04:34:38Z" };
const NEW_RUN = { runId: 43804958702, runNumber: 438, runCreatedAt: "2026-11-16T04:34:50Z" };
const CAPTURED_HEAD = "fa5b7bf2a327d42f0952360e558cd99dd602b4cd";

function ghCheck(over: Partial<CtxFixture> & Pick<CtxFixture, "name" | "checkId" | "runId" | "runNumber" | "runCreatedAt">): CtxFixture {
  return {
    kind: "check",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    startedAt: over.runCreatedAt,
    completedAt: over.runCreatedAt,
    ...ACTIONS,
    ...over,
  };
}

function commitStatus(name: string, state: string, createdAt: string, creator = "ci-bot"): CtxFixture {
  return { kind: "status", name, state, createdAt, creator };
}

/** PR 153 at fa5b7bf, attempts from the 2026-11-16 rollup. `progress` is the 04:36 observation; `success` is the 04:38 one. */
function capturedContexts(ci: "progress" | "success"): CtxFixture[] {
  const ciNew = ci === "progress"
    ? ghCheck({ name: "ci", checkId: 133093578520, ...NEW_RUN, status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-16T04:35:09Z", completedAt: null })
    : ghCheck({ name: "ci", checkId: 133093578520, ...NEW_RUN, conclusion: "SUCCESS", startedAt: "2026-11-16T04:35:09Z", completedAt: "2026-11-16T04:37:23Z" });
  return [
    ghCheck({ name: "ci", checkId: 133093417794, ...OLD_RUN, conclusion: "CANCELLED", startedAt: "2026-11-16T04:34:40Z", completedAt: "2026-11-16T04:34:54Z" }),
    ciNew,
    ghCheck({ name: "postgres", checkId: 133093417884, ...OLD_RUN, conclusion: "CANCELLED", startedAt: "2026-11-16T04:34:40Z", completedAt: "2026-11-16T04:34:53Z" }),
    ghCheck({ name: "postgres", checkId: 133093578323, ...NEW_RUN, conclusion: "SUCCESS", startedAt: "2026-11-16T04:35:09Z", completedAt: "2026-11-16T04:36:09Z" }),
    ghCheck({ name: "docker", checkId: 133093417504, ...OLD_RUN, conclusion: "CANCELLED", startedAt: "2026-11-16T04:34:40Z", completedAt: "2026-11-16T04:35:07Z" }),
    ghCheck({ name: "docker", checkId: 133093578653, ...NEW_RUN, conclusion: "SUCCESS", startedAt: "2026-11-16T04:35:09Z", completedAt: "2026-11-16T04:36:42Z" }),
    { kind: "check", name: "CodeRabbit", checkId: 133093144003, status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-11-16T04:33:47Z", completedAt: "2026-11-16T04:33:47Z", appId: 347564, appSlug: "coderabbitai" },
  ];
}

function standard(fx: Fixture, repo = REPO): void {
  fx.issues(repo, [
    { number: 1, labels: ["Dispatch-Ready"] },
    { number: 2, labels: [] },
    { number: 3, labels: ["BLOCKED", "dispatch-ready"] },
    { number: 4, labels: ["Decision"] },
    { number: 5, labels: ["bug"] },
  ]);
  fx.prs(repo, [{ number: 7, head: sha("h7"), contexts: green() }]);
}

async function main() {
  const server = await new IngestServer().start();
  const live = { MC_URL: server.url, MC_TOKEN: FAKE_TOKEN };
  const reset = () => server.reset();
  // Within one test, keep the server's seq memory: a retry run is not a new server.
  const next = () => { server.got.length = 0; server.script.length = 0; };

  await check("default-disabled: no config file means no GitHub call and no POST", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /not configured/);
    assert.deepEqual(fx.calls(), []);
    assert.equal(server.got.length, 0);
    assert.ok(!fs.existsSync(fx.state));
  });

  await check("default-disabled: enabled false (and the shipped example) posts nothing", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }, { enabled: false }));
    let r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /disabled/);
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, "sweep-producer.config.example.json"), "utf8"));
    assert.equal(example.enabled, false, "the example is inert");
    fx.config(example);
    r = await runProducer(fx, ["--repo", "example-owner/example-repo"], live);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /disabled/);
    for (const enabled of ["true", 1, null]) {
      fx.config(baseConfig({ [REPO]: repoConfig(REPO) }, { enabled }));
      r = await runProducer(fx, ["--repo", REPO], live);
      assert.equal(r.code, 3, `enabled ${JSON.stringify(enabled)} is an invalid config, not a yes`);
    }
    assert.deepEqual(fx.calls(), []);
    assert.equal(server.got.length, 0);
  });

  await check("unmapped repo and invalid config: unconfigured, nothing emitted", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx, OTHER);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    let r = await runProducer(fx, ["--repo", OTHER], live);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /not mapped/);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO, { ready_labels: [] }) }));
    r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 3, "no ready rule is not guessed");
    fx.config(baseConfig({ [REPO]: repoConfig(REPO, { blocked_labels: undefined }) }));
    r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 3, "blocked labels must be stated, even as []");
    assert.deepEqual(fx.calls(), []);
    assert.equal(server.got.length, 0);
  });

  await check("no backfill: the producer has no backfill mode", async () => {
    const fx = new Fixture(root);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const r = await runProducer(fx, ["--repo", REPO, "--backfill", "3"], live);
    assert.equal(r.code, 2);
    assert.deepEqual(fx.calls(), []);
  });

  await check("dry-run prints bounded envelopes, posts nothing, writes no state, needs no token", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ "ACME/widgets": repoConfig(REPO) }, { enabled: false }));
    const r = await runProducer(fx, ["--repo", REPO, "--dry-run"], { MC_URL: undefined, MC_TOKEN: undefined });
    assert.equal(r.code, 0, r.stderr);
    const out = envelopes(r.stdout);
    assert.deepEqual(out.map((e) => e.kind), ["sweep.queue", "sweep.pr_snapshot"]);
    for (const e of out) valid(e.kind, e.observation);
    assert.equal(server.got.length, 0);
    assert.ok(!fs.existsSync(fx.state));
  });

  await check("credentials: control and curl-config characters stop before collection or transport", async () => {
    // NUL cannot occur in an environment value. Exercise every other ASCII
    // control, including CR/LF/TAB/DEL, and retain the quote/backslash refusals.
    const forbidden = [...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)), "\x7f", '"', "\\"];
    for (const char of forbidden) {
      reset();
      const fx = new Fixture(root);
      standard(fx);
      fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
      const curlCalls = path.join(fx.dir, "curl-calls.log");
      fs.writeFileSync(path.join(fx.bin, "curl"),
        '#!/usr/bin/env bash\nprintf "called\\n" >> "$SWEEP_FIX_DIR/curl-calls.log"\nexit 97\n', { mode: 0o755 });
      const r = await runProducer(fx, ["--repo", REPO], { ...live, MC_TOKEN: `${FAKE_TOKEN}${char}suffix` });
      const label = `character code ${char.charCodeAt(0)}`;
      assert.deepEqual(fx.calls(), [], `${label}: refuse before GitHub collection`);
      assert.equal(fs.existsSync(curlCalls), false, `${label}: curl must not start`);
      assert.equal(server.got.length, 0, `${label}: no request`);
      assert.equal(fs.existsSync(fx.state), false, `${label}: no state or pending replay`);
      assert.equal(r.code, 3, label);
      assert.match(r.stderr, /MC_TOKEN has a character this script cannot send; nothing emitted/, label);
      assert.equal(r.stdout, "", label);
      noSecret(r.stdout, r.stderr);
    }
  });

  await check("queue: label rules, case normalization, raw excludes", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ "acme/WIDGETS": repoConfig(REPO, { queue: "Issues:Acme/Widgets", ready_labels: ["DISPATCH-READY"], raw_exclude_labels: ["DECISION"] }) }));
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    const [q] = server.of("sweep.queue");
    valid("sweep.queue", q);
    assert.equal(q.queue, "issues:acme/widgets");
    assert.equal(q.classification, "issue_dispatch");
    assert.equal(q.complete, true);
    assert.deepEqual(q.ready, { count: 1, refs: ["#1"] });
    assert.deepEqual(q.raw, { count: 2, refs: ["#2", "#5"] }, "blocked, ready, and excluded issues are not raw");
    assert.equal(server.got[0].auth, `Bearer ${FAKE_TOKEN}`);
  });

  await check("queue: a measured empty set is complete zeros", async () => {
    reset();
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    fx.prs(REPO, []);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    const [q] = server.of("sweep.queue");
    const [p] = server.of("sweep.pr_snapshot");
    valid("sweep.queue", q);
    valid("sweep.pr_snapshot", p);
    assert.deepEqual([q.complete, q.ready.count, q.raw.count], [true, 0, 0]);
    assert.deepEqual([p.complete, p.prs], [true, []]);
  });

  await check("queue: full counts across pages with refs capped at 50", async () => {
    reset();
    const fx = new Fixture(root);
    const list = Array.from({ length: 230 }, (_, i) => ({ number: 230 - i, labels: i % 2 === 0 ? ["dispatch-ready"] : [] }));
    fx.issues(REPO, list);
    fx.prs(REPO, []);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    const [q] = server.of("sweep.queue");
    valid("sweep.queue", q);
    assert.equal(q.ready.count, 115);
    assert.equal(q.raw.count, 115);
    assert.equal(q.ready.refs.length, 50);
    assert.equal(q.ready.refs[0], "#2", "refs are the lowest numbers");
    assert.equal(fx.calls().filter((c) => c.includes("SweepIssues ")).length, 3);
    assert.equal(fx.calls().filter((c) => c.includes("SweepIssuesVerify ")).length, 3, "the whole set is read a second time");
  });

  await check("queue failures are newer complete:false observations, never zeros", async () => {
    const cases: [string, (fx: Fixture) => void, RegExp][] = [
      ["cap", (fx) => fx.issues(REPO, [{ number: 1, labels: [] }], { total: 1001 }), /more than 1000 open issues/],
      ["set moved", (fx) => fx.issues(REPO, Array.from({ length: 150 }, (_, i) => ({ number: i + 1, labels: [] })), { lastTotal: 151 }), /changed during collection/],
      ["one closed and one opened while paging", (fx) => {
        const list = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, labels: [] as string[] }));
        fx.issues(REPO, list, { verify: [...list.filter((i) => i.number !== 120), { number: 151, labels: [] }] });
      }, /changed during collection/],
      ["labels changed while paging", (fx) => fx.issues(REPO, [{ number: 1, labels: [] }], { verify: [{ number: 1, labels: ["dispatch-ready"] }] }), /changed during collection/],
      ["verify read fails", (fx) => { fx.issues(REPO, [{ number: 1, labels: [] }]); fx.raw(REPO, "SweepIssuesVerify", "first", "", { exit: 1 }); }, /GitHub API request failed/],
      ["label overflow", (fx) => fx.issues(REPO, [{ number: 1, labels: ["x"], labelTotal: 51 }]), /more than 50 labels/],
      ["label overflow only on the verification read, visible names unchanged", (fx) => {
        const labels = ["dispatch-ready", ...Array.from({ length: 49 }, (_, i) => `other-${i}`)];
        fx.issues(REPO, [{ number: 1, labels, labelTotal: 50 }], { verify: [{ number: 1, labels, labelTotal: 51 }] });
      }, /more than 50 labels/],
      ["page 2 fails", (fx) => { fx.issues(REPO, Array.from({ length: 150 }, (_, i) => ({ number: i + 1, labels: ["dispatch-ready"] }))); fx.raw(REPO, "SweepIssues", "c1", null, { exit: 1 }); }, /GitHub API request failed/],
      ["rate limit", (fx) => fx.raw(REPO, "SweepIssues", "first", "", { exit: 1, stderr: "gh: API rate limit exceeded for user" }), /rate limited/],
      ["graphql rate limit", (fx) => fx.raw(REPO, "SweepIssues", "first", JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "x" }] })), /rate limited/],
      ["malformed", (fx) => fx.raw(REPO, "SweepIssues", "first", JSON.stringify({ data: { repository: { issues: { totalCount: 1, nodes: [{ number: "1" }] } } } })), /malformed/],
      ["not json", (fx) => fx.raw(REPO, "SweepIssues", "first", "<html>"), /malformed/],
    ];
    for (const [label, setup, error] of cases) {
      reset();
      const fx = new Fixture(root);
      fx.prs(REPO, []);
      setup(fx);
      fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
      const r = await runProducer(fx, ["--repo", REPO], live);
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      const [q] = server.of("sweep.queue");
      valid("sweep.queue", q);
      assert.equal(q.complete, false, label);
      assert.match(q.error, error, label);
      assert.ok(!("ready" in q) && !("raw" in q), `${label}: no fabricated counts`);
      assert.ok(!r.stderr.includes("rate limit exceeded for user"), `${label}: gh stderr is not echoed`);
      assert.equal(server.of("sweep.pr_snapshot")[0].complete, true, `${label}: the PR subject is independent`);
    }
  });

  await check("PRs: exact-head checks, review positive and authoritative negative", async () => {
    reset();
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    const h = (n: number) => sha(`head${n}`);
    fx.prs(REPO, [
      { number: 10, head: h(10), contexts: green(), createdAt: "2026-09-01T12:34:56Z", draft: true, mergeable: "CONFLICTING", title: "tab\there" },
      { number: 11, head: h(11), contexts: green(), reviews: [{ state: "APPROVED", oid: h(11) }] },
      { number: 12, head: h(12), contexts: green(), reviews: [{ state: "APPROVED", oid: sha("stale") }] },
      { number: 13, head: h(13), contexts: [...green(), { kind: "status", name: "review/started", state: "PENDING" }] },
      { number: 14, head: h(14), contexts: ok("ci") },
      { number: 15, head: h(15), contexts: [{ kind: "check", name: "ci", conclusion: "FAILURE" }, { kind: "status", name: "postgres" }] },
      { number: 16, head: h(16), contexts: [{ kind: "check", name: "ci", status: "IN_PROGRESS", conclusion: null }, { kind: "status", name: "postgres" }] },
      { number: 17, head: h(17), contexts: green(), contextsTruncated: true },
      { number: 18, head: h(18), commitOid: sha("previous"), contexts: green() },
      { number: 19, head: h(19), contexts: null },
      { number: 20, head: h(20), commitOid: null },
      { number: 21, head: h(21), contexts: green(), reviews: [{ state: "PENDING", oid: h(21) }] },
    ]);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    const [p] = server.of("sweep.pr_snapshot");
    valid("sweep.pr_snapshot", p);
    assert.equal(p.complete, true);
    const by = new Map<number, Json>(p.prs.map((x: Json) => [x.number, x]));
    const pr10 = by.get(10)!;
    assert.deepEqual([pr10.draft, pr10.mergeable, pr10.opened_at, pr10.title], [true, "conflicting", "2026-09-01T12:34:56Z", "tab here"], "raw createdAt, draft, mergeability");
    assert.deepEqual(pr10.required_checks, { state: "success", head_sha: h(10) }, "every configured context at head, case-insensitive");
    assert.deepEqual(pr10.review, { started: false, head_sha: h(10) }, "authoritative negative: no review-start context at a complete head");
    assert.deepEqual(by.get(11)!.review, { started: true, head_sha: h(11) }, "a published review at the exact head");
    assert.deepEqual(by.get(12)!.review, { started: false, head_sha: h(12) }, "an old-head review proves nothing; the configured source decides");
    assert.deepEqual(by.get(13)!.review, { started: true, head_sha: h(13) }, "review-start context present at head");
    assert.equal(by.get(14)!.required_checks.state, "unknown", "a missing required context is unknown, not green");
    assert.equal(by.get(15)!.required_checks.state, "failure");
    assert.equal(by.get(16)!.required_checks.state, "pending");
    assert.equal(by.get(17)!.required_checks.state, "unknown", "truncated contexts");
    assert.equal(by.get(17)!.review, undefined, "no negative from a truncated context list");
    assert.deepEqual(by.get(18)!.required_checks, { state: "unknown", head_sha: sha("previous") }, "checks are reported at the commit GitHub gave");
    assert.equal(by.get(18)!.review, undefined, "no negative when the rollup is not at head");
    assert.equal(by.get(19)!.required_checks.state, "unknown", "no rollup at all: required contexts missing");
    assert.deepEqual(by.get(19)!.review, { started: false, head_sha: h(19) });
    assert.deepEqual(by.get(20)!.required_checks, { state: "unknown" });
    assert.deepEqual(by.get(21)!.review, { started: false, head_sha: h(21) }, "a pending (unsubmitted) review is not a published review");
  });

  await check("PRs: current attempt per name and producer, not a stale run", async () => {
    const fx = new Fixture(root);
    async function states(required: string[] | undefined, list: PrFixture[]): Promise<Map<number, Json>> {
      reset();
      fx.clear(REPO);
      fx.issues(REPO, []);
      fx.prs(REPO, list);
      fx.config(baseConfig({ [REPO]: repoConfig(REPO, { required_checks: required }) }));
      const r = await runProducer(fx, ["--repo", REPO], live);
      assert.equal(r.code, 0, r.stderr);
      const [p] = server.of("sweep.pr_snapshot");
      valid("sweep.pr_snapshot", p);
      assert.equal(p.complete, true);
      return new Map(p.prs.map((row: Json) => [row.number, row]));
    }
    async function expectState(label: string, required: string[], contexts: CtxFixture[], state: string): Promise<void> {
      const head = sha(label);
      const by = await states(required, [
        { number: 1, head, contexts },
        { number: 2, head, contexts: [...contexts].reverse() },
      ]);
      assert.equal(by.get(1)!.required_checks.state, state, label);
      assert.equal(by.get(2)!.required_checks.state, state, `${label} reversed`);
      assert.equal(by.get(1)!.required_checks.head_sha, head, label);
    }

    const progress = capturedContexts("progress");
    let by = await states(["ci", "postgres", "docker"], [
      { number: 153, head: CAPTURED_HEAD, title: "Add deterministic event reducers with bounded recovery", contexts: progress },
      { number: 154, head: CAPTURED_HEAD, contexts: [...progress].reverse() },
    ]);
    assert.equal(by.get(153)!.required_checks.state, "pending", "cancelled ci does not fail the in-progress replacement");
    assert.equal(by.get(154)!.required_checks.state, "pending", "captured context order does not matter");
    assert.deepEqual(by.get(153)!.required_checks, { state: "pending", head_sha: CAPTURED_HEAD });
    assert.deepEqual(by.get(153)!.review, { started: false, head_sha: CAPTURED_HEAD }, "CodeRabbit skipped is not a review-start signal");

    by = await states(["postgres"], [{ number: 153, head: CAPTURED_HEAD, contexts: progress }]);
    assert.equal(by.get(153)!.required_checks.state, "success", "current postgres success is not the cancelled attempt");

    by = await states(["ci", "postgres", "docker"], [{ number: 153, head: CAPTURED_HEAD, contexts: capturedContexts("success") }]);
    assert.equal(by.get(153)!.required_checks.state, "success", "old cancelled, current success");

    const at = (hms: string) => `2026-11-16T${hms}Z`;
    await expectState("old success, current failure", ["ci"], [
      ghCheck({ name: "ci", checkId: 10, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS", completedAt: at("04:20:00") }),
      ghCheck({ name: "ci", checkId: 11, runId: 11, runNumber: 2, runCreatedAt: at("04:21:00"), conclusion: "FAILURE", startedAt: at("04:21:00"), completedAt: at("04:22:00") }),
    ], "failure");
    await expectState("queued attempt does not inherit an older success", ["ci"], [
      ghCheck({ name: "ci", checkId: 10, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS", completedAt: at("04:05:00") }),
      ghCheck({ name: "ci", checkId: 11, runId: 11, runNumber: 2, runCreatedAt: at("04:10:00"), status: "QUEUED", conclusion: null, startedAt: null, completedAt: null }),
    ], "pending");
    await expectState("older run that finishes later does not replace the newer success", ["ci"], [
      ghCheck({ name: "ci", checkId: 9000, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "FAILURE", completedAt: at("05:00:00") }),
      ghCheck({ name: "ci", checkId: 3, runId: 20, runNumber: 2, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS", startedAt: at("04:10:00"), completedAt: at("04:11:00") }),
    ], "success");
    await expectState("newer failure stands when the older success completes later", ["ci"], [
      ghCheck({ name: "ci", checkId: 2, runId: 20, runNumber: 2, runCreatedAt: at("04:10:00"), conclusion: "FAILURE", startedAt: at("04:10:00"), completedAt: at("04:12:00") }),
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS", completedAt: at("04:40:00") }),
    ], "failure");
    await expectState("a queued rerun inside the current run replaces that run's failure", ["ci"], [
      ghCheck({ name: "ci", checkId: 5, runId: 10, runNumber: 3, runCreatedAt: at("04:00:00"), conclusion: "FAILURE", completedAt: at("04:05:00") }),
      ghCheck({ name: "ci", checkId: 6, runId: 10, runNumber: 3, runCreatedAt: at("04:00:00"), status: "QUEUED", conclusion: null, startedAt: null, completedAt: null }),
    ], "pending");
    await expectState("three attempts keep the newest", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "CANCELLED", completedAt: at("04:01:00") }),
      ghCheck({ name: "ci", checkId: 2, runId: 11, runNumber: 2, runCreatedAt: at("04:02:00"), conclusion: "FAILURE", completedAt: at("04:03:00") }),
      ghCheck({ name: "ci", checkId: 3, runId: 12, runNumber: 3, runCreatedAt: at("04:04:00"), conclusion: "SUCCESS", completedAt: at("04:05:00") }),
    ], "success");

    await expectState("run number and run id disagree", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 100, runNumber: 4, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS" }),
      ghCheck({ name: "ci", checkId: 2, runId: 50, runNumber: 5, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS", startedAt: at("04:10:00") }),
    ], "unknown");
    await expectState("equal run numbers with different run ids", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 100, runNumber: 5, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS" }),
      ghCheck({ name: "ci", checkId: 2, runId: 101, runNumber: 5, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS", startedAt: at("04:10:00") }),
    ], "unknown");
    await expectState("run creation time contradicts the run number", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("05:00:00"), conclusion: "SUCCESS" }),
      ghCheck({ name: "ci", checkId: 2, runId: 20, runNumber: 2, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS", startedAt: at("04:10:00") }),
    ], "unknown");
    await expectState("duplicate attempts without a producer", ["ci"], [
      { kind: "check", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
      { kind: "check", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    ], "unknown");
    await expectState("duplicate actions runs without run identity", ["ci"], [
      { kind: "check", name: "ci", checkId: 1, status: "COMPLETED", conclusion: "SUCCESS", ...ACTIONS, runCreatedAt: at("04:00:00") },
      { kind: "check", name: "ci", checkId: 2, status: "COMPLETED", conclusion: "SUCCESS", ...ACTIONS, runCreatedAt: at("04:00:00") },
    ], "unknown");
    await expectState("check id and start time disagree", ["lint"], [
      { kind: "check", name: "lint", checkId: 8, status: "COMPLETED", conclusion: "SUCCESS", startedAt: at("04:00:00"), completedAt: at("04:01:00"), appId: 99, appSlug: "sidekick" },
      { kind: "check", name: "lint", checkId: 7, status: "COMPLETED", conclusion: "SUCCESS", startedAt: at("05:00:00"), completedAt: at("05:01:00"), appId: 99, appSlug: "sidekick" },
    ], "unknown");

    await expectState("two apps stay separate when each current attempt passes", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "CANCELLED", completedAt: at("04:01:00") }),
      ghCheck({ name: "ci", checkId: 2, runId: 20, runNumber: 2, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS", completedAt: at("04:11:00") }),
      { kind: "check", name: "ci", checkId: 3, status: "COMPLETED", conclusion: "SUCCESS", startedAt: at("04:00:00"), completedAt: at("04:01:00"), appId: 347564, appSlug: "coderabbitai" },
    ], "success");
    await expectState("another app's current failure is kept", ["ci"], [
      ghCheck({ name: "ci", checkId: 2, runId: 20, runNumber: 2, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS" }),
      { kind: "check", name: "ci", checkId: 4, status: "COMPLETED", conclusion: "FAILURE", startedAt: at("05:00:00"), completedAt: at("05:01:00"), appId: 347564, appSlug: "coderabbitai" },
    ], "failure");
    await expectState("a different workflow does not mask a failing one", ["build"], [
      ghCheck({ name: "build", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "CANCELLED", completedAt: at("04:01:00") }),
      ghCheck({ name: "build", checkId: 2, runId: 20, runNumber: 2, runCreatedAt: at("04:10:00"), conclusion: "SUCCESS", completedAt: at("04:11:00") }),
      ghCheck({ name: "build", checkId: 3, runId: 30, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "FAILURE", workflowId: 8, workflowName: "Lint" }),
    ], "failure");
    await expectState("same name on two events stays two contributions", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "FAILURE", event: "pull_request" }),
      ghCheck({ name: "ci", checkId: 2, runId: 11, runNumber: 4, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS", event: "push" }),
    ], "failure");
    await expectState("an updated status and the current check both have to pass", ["ci"], [
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS" }),
      commitStatus("ci", "FAILURE", at("03:00:00")),
      commitStatus("ci", "SUCCESS", at("04:30:00")),
    ], "success");
    await expectState("a stale successful status does not outvote the update, or the check", ["ci"], [
      commitStatus("ci", "SUCCESS", at("03:00:00")),
      commitStatus("ci", "FAILURE", at("04:30:00")),
      ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00"), conclusion: "SUCCESS" }),
    ], "failure");
    await expectState("fractional status time is later than the whole second", ["ci"], [
      commitStatus("ci", "SUCCESS", at("04:34:40")),
      commitStatus("ci", "PENDING", "2026-11-16T04:34:40.5Z"),
    ], "pending");
    await expectState("equal status timestamps are not a guess", ["ci"], [
      commitStatus("ci", "SUCCESS", at("04:30:00")),
      commitStatus("ci", "SUCCESS", at("04:30:00")),
    ], "unknown");
    await expectState("two status creators stay separate", ["ci"], [
      commitStatus("ci", "SUCCESS", at("04:30:00"), "alpha"),
      commitStatus("ci", "FAILURE", at("04:30:00"), "beta"),
    ], "failure");

    by = await states([], [{ number: 1, head: sha("none"), contexts: green() }]);
    assert.equal(by.get(1)!.required_checks.state, "unknown", "no configured names");
    by = await states(["ci", "postgres", "docker"], [{ number: 1, head: sha("miss"), contexts: [ghCheck({ name: "ci", checkId: 1, runId: 10, runNumber: 1, runCreatedAt: at("04:00:00") })] }]);
    assert.equal(by.get(1)!.required_checks.state, "unknown", "a missing required name");
    by = await states(["ci", "postgres", "docker"], [{ number: 1, head: CAPTURED_HEAD, contexts: capturedContexts("success"), contextsTruncated: true }]);
    assert.equal(by.get(1)!.required_checks.state, "unknown", "a truncated context list");
    assert.equal(by.get(1)!.review, undefined, "no review fact from a truncated list");
    by = await states(["postgres"], [{ number: 1, head: sha("roll"), commitOid: sha("previous"), contexts: capturedContexts("success") }]);
    assert.deepEqual(by.get(1)!.required_checks, { state: "unknown", head_sha: sha("previous") }, "rollup not at the head");
    assert.equal(by.get(1)!.review, undefined);
  });

  await check("PRs: without a configured review source, no review fact; without required checks, unknown", async () => {
    reset();
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    fx.prs(REPO, [
      { number: 1, head: sha("a1"), contexts: green() },
      { number: 2, head: sha("a2"), contexts: green(), reviews: [{ state: "COMMENTED", oid: sha("a2") }] },
    ]);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO, { review_start: undefined, required_checks: undefined }) }));
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    const [p] = server.of("sweep.pr_snapshot");
    valid("sweep.pr_snapshot", p);
    assert.equal(p.prs[0].review, undefined, "no published review is not proof that none started");
    assert.equal(p.prs[0].required_checks.state, "unknown");
    assert.deepEqual(p.prs[1].review, { started: true, head_sha: sha("a2") });
  });

  await check("PR failures: head movement, set change, caps, paging, malformed, rate limit", async () => {
    const two = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, head: sha(`m${i + 1}`), contexts: green() }));
    const cases: [string, (fx: Fixture) => void, RegExp][] = [
      ["head moved", (fx) => fx.prs(REPO, two(3), { heads: [[1, sha("m1")], [2, sha("moved")], [3, sha("m3")]] }), /head or the open PR set moved/],
      ["pr closed mid-run", (fx) => fx.prs(REPO, two(3), { heads: [[1, sha("m1")], [3, sha("m3")]] }), /moved during collection/],
      ["total changed", (fx) => fx.prs(REPO, two(60), { total: 61 }), /changed during collection/],
      ["over 200", (fx) => fx.prs(REPO, two(1), { total: 201 }), /more than 200 open PRs/],
      ["page 2 fails", (fx) => { fx.prs(REPO, two(60)); fx.raw(REPO, "SweepPrs", "p1", null, { exit: 1 }); }, /GitHub API request failed/],
      ["verify fails", (fx) => { fx.prs(REPO, two(2)); fx.raw(REPO, "SweepPrHeads", "first", "", { exit: 1, stderr: "secondary rate limit" }); }, /rate limited/],
      ["malformed head", (fx) => fx.prs(REPO, [{ number: 1, head: "NOT-A-SHA" }]), /malformed/],
      ["timeout", (fx) => { fx.prs(REPO, two(1)); fx.raw(REPO, "SweepPrs", "first", null, { sleep: 5 }); }, /timed out/],
    ];
    for (const [label, setup, error] of cases) {
      reset();
      const fx = new Fixture(root);
      fx.issues(REPO, []);
      setup(fx);
      fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
      const r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_GH_TIMEOUT: "2" });
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      const [p] = server.of("sweep.pr_snapshot");
      valid("sweep.pr_snapshot", p);
      assert.equal(p.complete, false, label);
      assert.match(p.error, error, label);
      assert.ok(!("prs" in p), `${label}: no partial list`);
      assert.equal(server.of("sweep.queue")[0].complete, true, `${label}: the queue subject is independent`);
    }
  });

  await check("per-repo isolation: one repo failing leaves another's evidence and seq alone", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.raw(OTHER, "SweepIssues", "first", "", { exit: 1 });
    fx.raw(OTHER, "SweepPrs", "first", "", { exit: 1 });
    fx.config(baseConfig({ [REPO]: repoConfig(REPO), [OTHER]: repoConfig(OTHER) }));
    const a = await runProducer(fx, ["--repo", OTHER], live);
    const b = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    const q = server.of("sweep.queue");
    assert.deepEqual(q.map((o) => [o.queue, o.seq, o.complete]), [[`issues:${OTHER}`, 1, false], ["issues:acme/widgets", 1, true]]);
  });

  await check("monotonic seq across overlapping invocations, later collection gets the higher seq", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.raw(REPO, "SweepIssues", "first", null, { sleep: 1 });
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const runs = await Promise.all([1, 2, 3].map(() => runProducer(fx, ["--repo", REPO], live)));
    for (const r of runs) assert.equal(r.code, 0, r.stderr);
    for (const kind of ["sweep.queue", "sweep.pr_snapshot"]) {
      const obs = server.of(kind);
      assert.deepEqual(obs.map((o) => o.seq), [1, 2, 3], `${kind}: one post per seq, in order`);
      const times = obs.map((o) => o.observed_at);
      assert.deepEqual([...times].sort(), times, `${kind}: observed_at never goes backwards as seq rises`);
    }
    const locks = fs.readdirSync(fx.state).filter((f) => f.endsWith(".flock"));
    assert.equal(locks.length, 2, "one lock file per subject, kept");
    for (const f of locks) assert.ok(lockFree(path.join(fx.state, f)), "locks released");
  });

  await check("subject lock: a live holder times the run out with no POST and keeps its lock", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    fs.mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    const file = lockFile(fx, QUEUE_SUBJECT);
    const holder = await holdLock(file);
    const inode = fs.statSync(file).ino;
    try {
      const started = Date.now();
      const r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "1" });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /sweep\.queue queue:issues:acme\/widgets: another producer holds the lock; skipped/);
      assert.ok(Date.now() - started >= 900, "waited the configured time");
      assert.equal(server.of("sweep.queue").length, 0, "no queue POST while another owner is live");
      assert.ok(!fx.calls().some((c) => c.includes("SweepIssues")), "no queue collection without the lock");
      assert.deepEqual(server.of("sweep.pr_snapshot").map((o) => o.seq), [1], "the PR subject is independent");
      assert.equal(fs.statSync(file).ino, inode, "the live owner's lock file is not unlinked or replaced");
      assert.ok(!lockFree(file), "the live owner still holds its lock after the timed-out run exits");
    } finally {
      await kill9(holder);
    }
    assert.ok(lockFree(file), "the kernel released the holder's lock on its death");
    next();
    const r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "0" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(server.of("sweep.queue").map((o) => o.seq), [1]);
    assert.equal(fs.statSync(file).ino, inode, "the run kept the lock file");
  });

  await check("subject lock: a waiter killed while waiting leaves no orphan to take the lock", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    fs.mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    const file = lockFile(fx, QUEUE_SUBJECT);
    const holder = await holdLock(file);
    const a = startProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "300" });
    const apid = a.pid!;
    // The waiter is perl with the producer shell's pid as its last argument.
    const waiters = () => spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" }).stdout
      .split("\n").filter((l) => l.includes("perl") && l.includes("LOCK_NB") && l.trim().endsWith(` ${apid}`));
    try {
      await until("the producer to wait on the lock", () => waiters().length === 1);
      await kill9(a);
      await until("the orphaned waiter to give up", () => waiters().length === 0, 3000);
    } finally {
      if (a.exitCode === null && a.signalCode === null) await kill9(a);
      for (const l of waiters()) process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
      await kill9(holder);
    }
    assert.ok(lockFree(file), "nobody holds the lock once the holder is gone");
    const r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "0" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(server.of("sweep.queue").map((o) => o.seq), [1], "the killed waiter never collected or posted");
  });

  await check("subject lock: competing recovery after a killed holder; an unlocked leftover never strands", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    fs.mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    // Leftovers of an interrupted acquisition: an unlocked lock file, and an
    // old-style lock directory with no pid. Neither is a lock.
    fs.writeFileSync(lockFile(fx, QUEUE_SUBJECT), "");
    fs.mkdirSync(lockFile(fx, QUEUE_SUBJECT).replace(/\.flock$/, ".lock"));
    let r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "0" });
    assert.equal(r.code, 0, r.stderr);
    r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "0" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(server.of("sweep.queue").map((o) => o.seq), [1, 2]);

    // A real holder dies by SIGKILL mid-collection; its gh child is orphaned and still running.
    next();
    fx.raw(REPO, "SweepIssues", "first", null, { sleep: 3 });
    const a = startProducer(fx, ["--repo", REPO], live);
    await until("the holder to be collecting", () => fx.calls().filter((c) => c.endsWith("SweepIssues first")).length >= 3);
    assert.ok(!lockFree(lockFile(fx, QUEUE_SUBJECT)), "the holder holds the lock");
    await kill9(a);
    assert.ok(lockFree(lockFile(fx, QUEUE_SUBJECT)), "released on death, before the orphaned gh finishes");
    fx.raw(REPO, "SweepIssues", "first", null, { sleep: 1 });
    const runs = await Promise.all([1, 2].map(() => runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "20" })));
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /STALE|REJECTED/);
    }
    assert.deepEqual(server.of("sweep.queue").map((o) => o.seq), [3, 4], "unique, strictly increasing queue seq");
    assert.deepEqual(server.of("sweep.pr_snapshot").map((o) => o.seq), [3, 4]);
    for (const o of server.got) assert.equal((o.body as Json).observation.seq > 0, true);
  });

  await check("subject lock: a holder killed after persisting a body is recovered by exactly one replay", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    // An ingest endpoint that accepts and never answers: the holder dies mid-POST.
    const sockets: net.Socket[] = [];
    const black = net.createServer((s) => sockets.push(s));
    await new Promise<void>((res) => black.listen(0, "127.0.0.1", () => res()));
    const blackUrl = `http://127.0.0.1:${(black.address() as net.AddressInfo).port}`;
    const a = startProducer(fx, ["--repo", REPO], { MC_URL: blackUrl, MC_TOKEN: FAKE_TOKEN, MC_SWEEP_HTTP_TIMEOUT: "30" });
    await until("the pending body to be durable", () => /"pending"/.test(stateText(fx)) && sockets.length > 0);
    const pending = JSON.parse(stateText(fx)).pending;
    assert.equal(pending.seq, 1);
    await kill9(a);
    assert.ok(lockFree(lockFile(fx, QUEUE_SUBJECT)), "released on death, before the orphaned curl times out");
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => black.close(() => res()));

    fx.raw(REPO, "SweepIssues", "first", null, { sleep: 1 });
    const runs = await Promise.all([1, 2].map(() => runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "20" })));
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      assert.doesNotMatch(run.stderr, /STALE|REJECTED/);
    }
    const queue = server.got.filter((g) => g.body.kind === "sweep.queue");
    assert.deepEqual(queue.map((g) => g.body.observation.seq), [1, 2, 3], "one replay, then unique strictly increasing seq");
    assert.equal(queue[0].raw, pending.body, "the replay is the persisted bytes");
    assert.deepEqual(server.of("sweep.pr_snapshot").map((o) => o.seq), [1, 2], "the PR subject was never reached by the killed run");
  });

  await check("exact replay: an unacknowledged POST is retried with the same seq and bytes first", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    server.script.push({ status: 503, body: { code: "internal_error" } }, { status: 429, body: { code: "rate_limited" } });
    let r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not acknowledged \(HTTP 503\); kept/);
    const firstQueue = server.got[0].raw;
    const firstPr = server.got[1].raw;
    noSecret(stateText(fx), r.stdout, r.stderr);
    // A changed world on the next run must not change the retried bytes.
    fx.issues(REPO, [{ number: 99, labels: ["dispatch-ready"] }]);
    next();
    r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.got[0].raw, firstQueue, "queue retry is byte-identical");
    assert.equal(server.got[1].body.observation.seq, 2);
    assert.deepEqual(server.got[1].body.observation.ready.refs, ["#99"]);
    assert.equal(server.got[2].raw, firstPr, "PR retry is byte-identical");
    assert.equal(server.got[3].body.observation.seq, 2);
    // A retry whose first attempt did land is a replay ack, not an error.
    next();
    server.script.push({ status: 200, body: { ok: true, outcome: "applied" } }, { status: 502 });
    r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 1);
    next();
    server.script.push({ status: 200, body: { ok: true, outcome: "applied" } }, { status: 200, body: { ok: true, outcome: "replay" } });
    r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /pr:acme\/widgets: seq 3 acknowledged on retry \(replay\)/);
    assert.equal(server.got[0].body.observation.seq, 4, "the queue moves on");
    assert.equal(server.got[1].body.observation.seq, 3);
    assert.equal(server.got[2].body.observation.seq, 4);
  });

  await check("transport failure keeps the pending body; the state never holds the token", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const r = await runProducer(fx, ["--repo", REPO], { MC_URL: "http://127.0.0.1:9", MC_TOKEN: FAKE_TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /transport failure/);
    const state = stateText(fx);
    assert.match(state, /"pending"/);
    noSecret(state, r.stderr);
    const files = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("sweep-producer."));
    for (const f of files) {
      const p = path.join(os.tmpdir(), f);
      if (fs.statSync(p).isDirectory()) for (const g of fs.readdirSync(p)) noSecret(fs.readFileSync(path.join(p, g), "utf8"));
    }
  });

  await check("rejected and stale answers are reported, not swallowed", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    server.script.push({ status: 400, body: { code: "validation_failed", error: "secret-ish detail that must not be dumped" } });
    server.script.push({ status: 200, body: { ok: true, outcome: "older" } });
    const r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /REJECTED seq 1: HTTP 400 validation_failed/);
    assert.match(r.stderr, /STALE/);
    assert.ok(!r.stderr.includes("secret-ish"), "the response body is not dumped");
    assert.doesNotMatch(stateText(fx), /"pending"/, "a rejected body is not retried forever");
    next();
    const again = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(server.got.map((g) => g.body.observation.seq), [2, 2], "the next run moves on to a new seq");
  });

  // ------------------------------------------------ pr_review queue (#176)
  const RQ = "reviews:acme/widgets";
  const BOT = "claude-reviewer[bot]";
  const prReview = (over: Json = {}) => ({ enabled: true, queue: "Reviews:Acme/Widgets", reviewer_logins: ["Claude-Reviewer[bot]"], ...over });
  const withReview = (over: Json = {}, repo = REPO) => baseConfig({ [repo]: repoConfig(repo, { pr_review: prReview(over) }) });
  const FIXED_DATE = '#!/usr/bin/env bash\ncase "$*" in *%Y*) echo 2026-11-23T12:00:00Z ;; *) echo 12:00:00 ;; esac\n';
  /** Run with pr_review and return the pr_review envelope (the third), after validating all three. */
  async function reviewQueue(fx: Fixture, cfg: Json, env: Record<string, string | undefined> = {}): Promise<Json> {
    fx.config(cfg);
    const r = await runProducer(fx, ["--repo", REPO, "--dry-run"], env);
    assert.equal(r.code, 0, r.stderr);
    const out = envelopes(r.stdout);
    assert.deepEqual(out.map((e) => e.kind), ["sweep.queue", "sweep.pr_snapshot", "sweep.queue"]);
    for (const e of out) valid(e.kind, e.observation);
    const q = out[2].observation;
    assert.equal(q.classification, "pr_review");
    assert.equal(q.queue, RQ);
    noSecret(r.stdout, r.stderr);
    return q;
  }

  await check("pr_review: omitted or disabled is byte-identical to the producer without it", async () => {
    const fx = new Fixture(root);
    standard(fx);
    fs.writeFileSync(path.join(fx.bin, "date"), FIXED_DATE, { mode: 0o755 });
    const run = async (cfg: Json, script?: string) => {
      fx.config(cfg);
      const r = await runProducer(fx, ["--repo", REPO, "--dry-run"], {}, script);
      assert.equal(r.code, 0, r.stderr);
      return r;
    };
    const omitted = await run(baseConfig({ [REPO]: repoConfig(REPO) }));
    const disabled = await run(withReview({ enabled: false }));
    assert.equal(disabled.stdout, omitted.stdout, "stdout is byte-identical");
    assert.equal(disabled.stderr, omitted.stderr);
    assert.deepEqual(envelopes(omitted.stdout).map((e) => e.kind), ["sweep.queue", "sweep.pr_snapshot"]);
    assert.ok(!fx.calls().some((c) => c.includes("SweepPrReviews")), "no review query when pr_review is off");
    // The producer as it was before #176, when this checkout has that commit.
    const base = spawnSync("git", ["show", "252fe31:scripts/sweep-producer.sh"], { encoding: "utf8" });
    if (base.status === 0) {
      const old = path.join(fx.dir, "sweep-producer.before-176.sh");
      fs.writeFileSync(old, base.stdout);
      const before = await run(baseConfig({ [REPO]: repoConfig(REPO) }), old);
      assert.equal(omitted.stdout, before.stdout, "omitted pr_review: byte-identical to the pre-#176 producer");
      assert.equal(disabled.stdout, before.stdout, "disabled pr_review: byte-identical to the pre-#176 producer");
    } else {
      console.log("  (pre-#176 producer not in this checkout; compared omitted with disabled only)");
    }
  });

  await check("pr_review: invalid config is rejected before any GitHub call, nothing posted", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    const bad: [string, Json][] = [
      ["missing reviewer_logins", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: { enabled: true, queue: RQ } }) })],
      ["missing queue", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: { enabled: true, reviewer_logins: [] } }) })],
      ["missing enabled", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: { queue: RQ, reviewer_logins: [] } }) })],
      ["unknown field", withReview({ lenses: ["tests"] })],
      ["enabled is a string", withReview({ enabled: "true" })],
      ["null pr_review", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: null }) })],
      ["array pr_review", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: [] }) })],
      ["queue invalid", withReview({ queue: "-bad" })],
      ["queue empty while disabled", withReview({ enabled: false, queue: "" })],
      ["queue equals the issue queue, case-folded", withReview({ queue: "ISSUES:acme/widgets" })],
      ["queue equals another repo's queue", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: prReview({ queue: `issues:${OTHER}` }) }), [OTHER]: repoConfig(OTHER) })],
      ["two repos share a pr_review queue", baseConfig({ [REPO]: repoConfig(REPO, { pr_review: prReview() }), [OTHER]: repoConfig(OTHER, { pr_review: prReview() }) })],
      ["two repos share an issue queue, no pr_review anywhere", baseConfig({ [REPO]: repoConfig(REPO, { queue: "issues:shared" }), [OTHER]: repoConfig(OTHER, { queue: "issues:shared" }) })],
      ["two repos share an issue queue case-folded, no pr_review anywhere", baseConfig({ [REPO]: repoConfig(REPO, { queue: "Issues:Shared" }), [OTHER]: repoConfig(OTHER, { queue: "issues:shared" }) })],
      ["logins not an array", withReview({ reviewer_logins: BOT })],
      ["logins not an array while disabled", withReview({ enabled: false, reviewer_logins: null })],
      ["login with a space", withReview({ reviewer_logins: ["claude bot"] })],
      ["login with a bad suffix", withReview({ reviewer_logins: ["claude[app]"] })],
      ["empty login", withReview({ reviewer_logins: [""] })],
      ["duplicate login after lower-casing", withReview({ reviewer_logins: ["Claude-Reviewer[bot]", "claude-reviewer[BOT]"] })],
      ["login not a string", withReview({ reviewer_logins: [7] })],
    ];
    for (const [label, cfg] of bad) {
      fx.config(cfg);
      for (const args of [["--repo", REPO], ["--repo", REPO, "--dry-run"]]) {
        const r = await runProducer(fx, args, live);
        assert.equal(r.code, 3, `${label} ${args.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, /invalid; nothing emitted/, label);
        assert.equal(r.stdout, "", label);
      }
    }
    assert.deepEqual(fx.calls(), [], "no GitHub collection");
    assert.equal(server.got.length, 0, "nothing posted");
    for (const ok of [withReview({ enabled: false }), withReview({ reviewer_logins: [] }), withReview({ reviewer_logins: ["a", "B-2", "x[bot]"] })]) {
      fx.config(ok);
      const r = await runProducer(fx, ["--repo", REPO, "--dry-run"], live);
      assert.equal(r.code, 0, `${JSON.stringify(ok)}: ${r.stderr}`);
    }
  });

  await check("pr_review: green at head, not draft, no suppressing review; red or pending excluded and still complete", async () => {
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    const h = (n: number) => sha(`rv${n}`);
    fx.prs(REPO, [
      { number: 100, head: h(100), contexts: green() },
      { number: 9, head: h(9), contexts: green() },
      { number: 20, head: h(20), contexts: [{ kind: "check", name: "ci", conclusion: "FAILURE" }, { kind: "status", name: "postgres" }] },
      { number: 21, head: h(21), contexts: [{ kind: "check", name: "ci", status: "IN_PROGRESS", conclusion: null }, { kind: "status", name: "postgres" }] },
      { number: 22, head: h(22), contexts: green(), draft: true },
      { number: 23, head: h(23), contexts: ok("ci"), draft: true },
      { number: 10, head: h(10), contexts: green() },
    ]);
    const q = await reviewQueue(fx, withReview());
    assert.equal(q.complete, true);
    assert.deepEqual(q.ready, { count: 3, refs: ["#9", "#10", "#100"] }, "numeric order, not lexical");
    assert.deepEqual(q.ready_items, [{ number: 9, head_sha: h(9) }, { number: 10, head_sha: h(10) }, { number: 100, head_sha: h(100) }]);
    assert.deepEqual(q.raw, { count: 7, refs: ["#9", "#10", "#20", "#21", "#22", "#23", "#100"] }, "raw is every open PR");
    assert.equal(q.repo, REPO);
    assert.equal(q.stale_after_minutes, 30);
    const reviewed = fx.calls().filter((c) => c.includes("SweepPrReviews")).map((c) => c.split(" ")[1]).sort();
    assert.deepEqual(reviewed, ["SweepPrReviews-10", "SweepPrReviews-100", "SweepPrReviews-9"], "reviews are read only for green non-draft candidates");
  });

  await check("pr_review: an unknown required check makes it incomplete, never zero", async () => {
    const cases: [string, PrFixture[], Json | undefined][] = [
      ["missing context", [{ number: 1, head: sha("u1"), contexts: green() }, { number: 2, head: sha("u2"), contexts: ok("ci") }], undefined],
      ["truncated contexts", [{ number: 1, head: sha("u1"), contexts: green(), contextsTruncated: true }], undefined],
      ["rollup not at head", [{ number: 1, head: sha("u1"), commitOid: sha("old"), contexts: green() }], undefined],
      ["no required checks configured", [{ number: 1, head: sha("u1"), contexts: green() }], { required_checks: [] }],
      ["required checks omitted", [{ number: 1, head: sha("u1"), contexts: green() }], { required_checks: undefined }],
    ];
    for (const [label, list, over] of cases) {
      const fx = new Fixture(root);
      fx.issues(REPO, []);
      fx.prs(REPO, list);
      const q = await reviewQueue(fx, baseConfig({ [REPO]: repoConfig(REPO, { ...(over ?? {}), pr_review: prReview() }) }));
      assert.equal(q.complete, false, label);
      assert.match(q.error, /required checks are unknown for PR #\d+/, label);
      assert.ok(!("ready" in q) && !("raw" in q), `${label}: no counts`);
      assert.deepEqual(q.ready_items, [], label);
    }
    // A draft with unknown checks cannot be ready, so it does not make the queue unmeasured.
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    fx.prs(REPO, [{ number: 1, head: sha("d1"), contexts: green() }, { number: 2, head: sha("d2"), contexts: ok("ci"), draft: true }]);
    const q = await reviewQueue(fx, withReview());
    assert.equal(q.complete, true);
    assert.deepEqual(q.ready.refs, ["#1"]);
  });

  await check("pr_review: only a submitted review at the current head by a listed login suppresses", async () => {
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    const h = (n: number) => sha(`sp${n}`);
    const at = (n: number, state: string, login: string | null) => ({ number: n, head: h(n), contexts: green(), reviews: [{ state, oid: h(n), login }] });
    fx.prs(REPO, [
      { number: 1, head: h(1), contexts: green(), reviews: [{ state: "COMMENTED", oid: sha("older"), login: BOT }] },
      at(2, "PENDING", BOT),
      at(3, "APPROVED", "someone-else"),
      at(4, "COMMENTED", null),
      { number: 5, head: h(5), contexts: green(), reviews: [{ state: "COMMENTED", oid: null, login: BOT }] },
      at(6, "COMMENTED", BOT),
      at(7, "CHANGES_REQUESTED", "CLAUDE-REVIEWER[bot]"),
      at(8, "DISMISSED", BOT),
      { number: 9, head: h(9), contexts: green(), reviews: [{ state: "PENDING", oid: h(9), login: BOT }, { state: "APPROVED", oid: h(9), login: "human" }, { state: "COMMENTED", oid: sha("x"), login: BOT }] },
    ]);
    const q = await reviewQueue(fx, withReview());
    assert.equal(q.complete, true);
    assert.deepEqual(q.ready.refs, ["#1", "#2", "#3", "#4", "#5", "#9"],
      "older head, PENDING, unlisted login, null author, and no commit do not suppress");
    assert.equal(q.raw.count, 9);
    const none = await reviewQueue(fx, withReview({ reviewer_logins: [] }));
    assert.equal(none.ready.count, 9, "an empty login list suppresses nothing");
  });

  await check("pr_review: reviews are paged in full with reviews(first: 100, after: $cursor)", async () => {
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    const head = sha("paged");
    const noise = Array.from({ length: 230 }, (_, i) => ({ state: "COMMENTED", oid: sha(`old${i}`), login: i % 2 ? BOT : "human" }));
    fx.prs(REPO, [
      { number: 5, head, contexts: green(), reviews: [...noise, { state: "COMMENTED", oid: head, login: BOT }] },
      { number: 6, head: sha("six"), contexts: green(), reviews: noise.slice(0, 150) },
    ]);
    const q = await reviewQueue(fx, withReview());
    assert.equal(q.complete, true);
    assert.deepEqual(q.ready.refs, ["#6"], "the matching review is on page 3, past any last-100 window");
    const seq = fx.calls().filter((c) => c.includes("SweepPrReviews")).map((c) => c.split(" ").slice(1).join(" "));
    assert.deepEqual(seq, ["SweepPrReviews-5 first", "SweepPrReviews-5 r1", "SweepPrReviews-5 r2", "SweepPrReviews-6 first", "SweepPrReviews-6 r1"]);
    const query = fx.query("SweepPrReviews");
    assert.match(query, /reviews\(first: 100, after: \$cursor\)/);
    assert.match(query, /pageInfo \{ hasNextPage endCursor \}/);
    assert.match(query, /author \{ login \}/);
    assert.doesNotMatch(query, /last:/);
  });

  await check("pr_review: snapshot and review-page failures make it incomplete", async () => {
    const two = () => [{ number: 1, head: sha("f1"), contexts: green() }, { number: 2, head: sha("f2"), contexts: green() }];
    const many = (n: number) => Array.from({ length: n }, () => ({ state: "COMMENTED", oid: sha("o"), login: "x" }));
    const cases: [string, (fx: Fixture) => void, RegExp][] = [
      ["snapshot head moved", (fx) => fx.prs(REPO, two(), { heads: [[1, sha("f1")], [2, sha("moved")]] }), /head or the open PR set moved/],
      ["snapshot over 200", (fx) => fx.prs(REPO, two(), { total: 201 }), /more than 200 open PRs/],
      ["snapshot GitHub failure", (fx) => { fx.prs(REPO, two()); fx.raw(REPO, "SweepPrs", "first", "", { exit: 1 }); }, /GitHub API request failed/],
      ["snapshot truncated page", (fx) => { fx.prs(REPO, two()); fx.raw(REPO, "SweepPrs", "first", JSON.stringify({ data: { repository: { pullRequests: { totalCount: 60, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } })); }, /malformed/],
      ["review page fails", (fx) => { fx.prs(REPO, two()); fx.raw(REPO, "SweepPrReviews-2", "first", "", { exit: 1 }); }, /GitHub API request failed/],
      ["review second page fails", (fx) => { fx.prs(REPO, [{ number: 1, head: sha("f1"), contexts: green(), reviews: many(150) }]); fx.raw(REPO, "SweepPrReviews-1", "r1", null, { exit: 1 }); }, /GitHub API request failed/],
      ["review page rate limited", (fx) => { fx.prs(REPO, two()); fx.raw(REPO, "SweepPrReviews-1", "first", "", { exit: 1, stderr: "API rate limit exceeded" }); }, /rate limited/],
      ["review page truncated (no cursor)", (fx) => {
        fx.prs(REPO, two());
        fx.raw(REPO, "SweepPrReviews-1", "first", JSON.stringify({ data: { repository: { pullRequest: { number: 1, headRefOid: sha("f1"), reviews: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } } }));
      }, /truncated/],
      ["review page malformed", (fx) => { fx.prs(REPO, two()); fx.raw(REPO, "SweepPrReviews-1", "first", JSON.stringify({ data: { repository: { pullRequest: null } } })); }, /malformed/],
      ["review page for another PR", (fx) => {
        fx.prs(REPO, two());
        fx.raw(REPO, "SweepPrReviews-1", "first", JSON.stringify({ data: { repository: { pullRequest: { number: 2, headRefOid: sha("f1"), reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }));
      }, /malformed/],
      ["head moved before the review read", (fx) => fx.prs(REPO, [{ number: 1, head: sha("f1"), contexts: green(), reviewHead: sha("pushed") }]), /head moved/],
      ["review cursor repeats", (fx) => {
        fx.prs(REPO, two());
        const pg = (c: string) => JSON.stringify({ data: { repository: { pullRequest: { number: 1, headRefOid: sha("f1"), reviews: { pageInfo: { hasNextPage: true, endCursor: c }, nodes: [] } } } } });
        fx.raw(REPO, "SweepPrReviews-1", "first", pg("loop"));
        fx.raw(REPO, "SweepPrReviews-1", "loop", pg("loop"));
      }, /repeated cursor/],
    ];
    for (const [label, setup, error] of cases) {
      const fx = new Fixture(root);
      fx.issues(REPO, []);
      setup(fx);
      const q = await reviewQueue(fx, withReview(), { MC_SWEEP_GH_TIMEOUT: "5" });
      assert.equal(q.complete, false, label);
      assert.match(q.error, error, label);
      assert.ok(!("ready" in q) && !("raw" in q), `${label}: never a zero`);
      assert.deepEqual(q.ready_items, []);
    }
  });

  await check("pr_review: reviews paginate until hasNextPage is false, with no count cap", async () => {
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    const filler = (n: number) => Array.from({ length: n }, () => ({ state: "COMMENTED", oid: sha("o"), login: "x" }));
    fx.prs(REPO, [
      { number: 1, head: sha("big1"), contexts: green(), reviews: [...filler(3100), { state: "APPROVED", oid: sha("big1"), login: BOT }] },
      { number: 2, head: sha("big2"), contexts: green(), reviews: filler(3101) },
    ]);
    const q = await reviewQueue(fx, withReview());
    assert.equal(q.complete, true, q.error);
    assert.deepEqual(q.ready_items, [{ number: 2, head_sha: sha("big2") }], "the suppressing review on page 32 is found");
  });

  await check("pr_review: refs and ready_items are the lowest 50; counts stay exact", async () => {
    const fx = new Fixture(root);
    fx.issues(REPO, []);
    fx.prs(REPO, Array.from({ length: 120 }, (_, i) => ({ number: 120 - i, head: sha(`c${120 - i}`), contexts: green(), draft: (120 - i) % 10 === 0 })));
    const q = await reviewQueue(fx, withReview());
    assert.equal(q.complete, true);
    assert.equal(q.ready.count, 108);
    assert.equal(q.raw.count, 120);
    assert.equal(q.ready.refs.length, 50);
    assert.equal(q.ready_items.length, 50);
    assert.deepEqual(q.ready_items.map((i: Json) => `#${i.number}`), q.ready.refs);
    assert.equal(q.ready.refs[0], "#1");
    assert.equal(q.ready.refs[49], "#55", "drafts 10..50 skipped");
    assert.equal(q.ready_items[49].head_sha, sha("c55"));
  });

  await check("pr_review: posted live as its own subject and seq; a held snapshot lock is incomplete", async () => {
    reset();
    const fx = new Fixture(root);
    standard(fx);
    fx.config(withReview());
    let r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    r = await runProducer(fx, ["--repo", REPO], live);
    assert.equal(r.code, 0, r.stderr);
    const queues = server.of("sweep.queue");
    assert.deepEqual(queues.map((o) => [o.classification, o.queue, o.seq]),
      [["issue_dispatch", "issues:acme/widgets", 1], ["pr_review", RQ, 1], ["issue_dispatch", "issues:acme/widgets", 2], ["pr_review", RQ, 2]]);
    for (const o of queues) valid("sweep.queue", o);
    assert.deepEqual(queues[1].ready_items, [{ number: 7, head_sha: sha("h7") }]);
    assert.equal(server.got[2].body.kind, "sweep.queue", "the pr_review envelope is third");
    assert.equal(server.got[2].auth, `Bearer ${FAKE_TOKEN}`);
    noSecret(stateText(fx), r.stdout, r.stderr);

    next();
    fs.mkdirSync(fx.state, { recursive: true, mode: 0o700 });
    const holder = await holdLock(lockFile(fx, "sweep.pr_snapshot|pr:acme/widgets"));
    try {
      r = await runProducer(fx, ["--repo", REPO], { ...live, MC_SWEEP_LOCK_WAIT: "0" });
    } finally {
      await kill9(holder);
    }
    assert.equal(r.code, 1);
    const [held] = server.of("sweep.queue").filter((o) => o.classification === "pr_review");
    valid("sweep.queue", held);
    assert.deepEqual([held.complete, held.error, held.seq], [false, "the PR snapshot was not collected", 3]);
  });

  await check("collect-progress: a tick runs the producer per repo; backfill never does; a producer failure keeps the tick", async () => {
    const fx = new Fixture(root);
    standard(fx);
    fx.config(baseConfig({ [REPO]: repoConfig(REPO) }));
    const progressCfg = path.join(fx.dir, "progress.config.json");
    fs.writeFileSync(progressCfg, JSON.stringify({ repos: [{ repo: REPO, label: "W" }] }));
    const collector = path.join(__dirname, "collect-progress.sh");
    const env = { MC_PROGRESS_CONFIG: progressCfg, MC_REPOS_FROM_DASHBOARD: "0", SEARCH_SLEEP: "0", MC_URL: undefined, MC_TOKEN: undefined };
    let r = await runProducer(fx, ["--backfill", "1", "--dry-run"], env, collector);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fx.calls().some((c) => c.includes(" Sweep")), "backfill makes no producer query");
    assert.match(r.stdout, /"kind": "backfill"/);
    r = await runProducer(fx, ["--dry-run"], env, collector);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fx.calls().some((c) => c.includes("SweepIssues")), "the tick ran the producer");
    assert.match(r.stdout, /"kind": "tick"/, "the progress payload is still printed");
    assert.match(r.stderr, /"kind":"sweep.queue"/, "producer dry-run output goes to stderr");
    fs.writeFileSync(path.join(fx.dir, "broken-producer.sh"), "exit 7\n");
    r = await runProducer(fx, ["--dry-run"], { ...env, MC_SWEEP_PRODUCER_SCRIPT: path.join(fx.dir, "broken-producer.sh") }, collector);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /sweep producer: failed for Acme\/Widgets; the progress tick continues/);
    assert.match(r.stdout, /"kind": "tick"/);
  });

  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} sweep-producer checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
