/**
 * Tests for scripts/sweep-producer.sh (#79) with a stub gh and a local ingest
 * server. No database, no live GitHub, no real credential. Every captured
 * observation also passes the intake validators in sweep-evidence.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPrSnapshotObservation, checkQueueObservation } from "../src/lib/sweep-evidence";
import { FAKE_TOKEN, Fixture, IngestServer, baseConfig, repoConfig, runProducer, sha, type Json, type PrFixture } from "./sweep-producer-fixtures";

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

const ok = (name: string): PrFixture["contexts"] => [{ kind: "check", name }];
const green = (): NonNullable<PrFixture["contexts"]> => [{ kind: "check", name: "CI" }, { kind: "status", name: "Postgres" }];

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
    assert.ok(!fs.readdirSync(fx.state).some((f) => f.endsWith(".lock")), "locks released");
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
