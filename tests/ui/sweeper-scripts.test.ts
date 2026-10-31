import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// Run the real entry points with an argv-observing curl fixture. No live
// credential, GitHub request, scheduler, secret store, or endpoint is used.
const TOKEN = "fixture_sweep_writer_never_in_argv";
const scripts = path.resolve("scripts");
type Call = { argv: string[]; header: string | null; mode: number | null; file: string | null };

function run(script: string, reply = "ok", token = TOKEN, extra: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-script-auth-"));
  try {
    const bin = path.join(dir, "bin");
    const tmp = path.join(dir, "tmp");
    const audit = path.join(dir, "curl.jsonl");
    const config = path.join(dir, "progress.json");
    fs.mkdirSync(bin, { mode: 0o700 });
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.writeFileSync(config, JSON.stringify({ repos: [], brief: { coordinator: { agentId: "fixture-coordinator" } } }));
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "curl"), String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const i = argv.findIndex(a => a === "-H" || a === "--header");
const h = i < 0 ? null : argv[i + 1];
const file = h && h.startsWith("@") ? h.slice(1) : null;
fs.appendFileSync(process.env.CURL_AUDIT, JSON.stringify({
  argv, file,
  header: file ? fs.readFileSync(file, "utf8") : h,
  mode: file ? fs.statSync(file).mode & 0o777 : null,
}) + "\n");
if (process.env.CURL_REPLY === "curl-fail") process.exit(22);
if (process.env.CURL_REPLY === "invalid-json") { console.log("invalid-json"); process.exit(0); }
const url = argv[argv.length - 1];
if (url.endsWith("/api/settings/repos")) console.log(JSON.stringify({ repos: [] }));
else if (url.endsWith("/api/fleet")) console.log(JSON.stringify({ agents: [], events: [] }));
else if (url.includes("/api/decisions?")) console.log(JSON.stringify({ demo: false, decisions: [], incomplete_repos: [] }));
else if (url.endsWith("/api/sweep")) console.log(JSON.stringify({
  checks: [{ state: process.env.CURL_REPLY === "unknown" ? "unknown" : "ok" }],
  retention: { state: "ok" },
  paused: { measured: true, generated_at: "2026-10-31T00:00:00Z", jobs_total: 0,
    jobs: [], truncated: false, counts: { held: 0, unexplained: 0, expired: 0, unknown: 0 } },
}));
else process.exit(3);
`, { mode: 0o700 });
    const args = script === "morning-brief.sh" ? ["--json", "--config", config, ...extra] : extra;
    const result = spawnSync("bash", [path.join(scripts, script), ...args], {
      encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: tmp,
        MC_URL: "https://fixture.invalid", MC_TOKEN: token, CURL_AUDIT: audit, CURL_REPLY: reply },
    });
    assert.ifError(result.error);
    const calls: Call[] = fs.existsSync(audit)
      ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Call) : [];
    const remaining = fs.readdirSync(tmp);
    for (const call of calls) {
      assert.ok(call.argv.every(arg => !arg.includes(token)), "curl argv exposes the fixture bearer");
      assert.equal(call.header, `Authorization: Bearer ${token}\n`, "curl must receive the exact bearer header");
      assert.equal(call.mode, 0o600, "header must be private before curl starts");
      assert.ok(call.file && !fs.existsSync(call.file), "header file must be removed on exit");
    }
    assert.deepEqual(remaining, [], "header and brief error files must both be cleaned up");
    assert.equal(result.stdout.includes(token), false);
    assert.equal(result.stderr.includes(token), false);
    return { status: result.status, out: result.stdout, err: result.stderr, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("sweeper shell credential transport", () => {
  it("runs the one-shot sweep without a bearer in argv and cleans up on success", () => {
    const r = run("sweep-once.sh");
    assert.equal(r.status, 0, r.err);
    assert.equal(r.calls.length, 1);
    assert.equal(JSON.parse(r.out).retention.state, "ok");
  });

  it("preserves one-shot curl failure status and removes the header", () => {
    const r = run("sweep-once.sh", "curl-fail");
    assert.equal(r.status, 1);
    assert.equal(r.calls.length, 1);
    assert.match(r.err, /POST \/api\/sweep failed/);
  });

  it("preserves unknown-check status and cleans up after invalid JSON", () => {
    const unknown = run("sweep-once.sh", "unknown");
    assert.equal(unknown.status, 2);
    assert.equal(unknown.calls.length, 1);
    const invalid = run("sweep-once.sh", "invalid-json");
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.calls.length, 1);
  });

  it("protects all four brief dashboard calls and preserves both cleanups", () => {
    const r = run("morning-brief.sh");
    assert.equal(r.status, 0, r.err);
    assert.equal(r.calls.length, 4);
    assert.equal(JSON.parse(r.out).paused.measured, true);
    assert.deepEqual(r.calls.map(c => new URL(c.argv.at(-1)!).pathname),
      ["/api/settings/repos", "/api/fleet", "/api/decisions", "/api/sweep"]);
  });

  it("keeps dashboard failures unmeasured and --no-dashboard offline", () => {
    const failed = run("morning-brief.sh", "curl-fail");
    assert.equal(failed.status, 0, failed.err);
    assert.equal(failed.calls.length, 4);
    assert.equal(JSON.parse(failed.out).paused.measured, false);
    const offline = run("morning-brief.sh", "ok", TOKEN, ["--no-dashboard"]);
    assert.equal(offline.status, 0, offline.err);
    assert.equal(offline.calls.length, 0);
  });

  it("rejects multiline bearer values without making any request", () => {
    for (const script of ["sweep-once.sh", "morning-brief.sh"]) {
      for (const newline of ["\r", "\n"]) {
        const r = run(script, "ok", `${TOKEN}${newline}Injected: header`);
        assert.equal(r.status, 1);
        assert.equal(r.calls.length, 0);
        assert.match(r.err, /MC_TOKEN must be a single line/);
      }
    }
  });
});
