import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVelocity, summarizeVelocity, VELOCITY_MAX_BYTES } from "../../src/lib/velocity";
import { velocityFixture } from "./velocity-fixture";

const root = fileURLToPath(new URL("../..", import.meta.url));
const guard = fileURLToPath(new URL("./velocity-preview-guard.mjs", import.meta.url));
const script = "scripts/preview-velocity.ts";
const dir = mkdtempSync(join(tmpdir(), "velocity-preview-"));
const statusAtStart = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });

after(() => {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  assert.equal(status, statusAtStart);
  rmSync(dir, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    USER: process.env.USER,
    LANG: "C",
    NODE_ENV: process.env.NODE_ENV ?? "test",
    NODE_OPTIONS: `--import ${guard}`,
    ...extra,
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    if (!child.stdout || !child.stderr) { reject(new Error("stdio pipes missing")); return; }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

function preview(args: string[], extra: Record<string, string> = {}) {
  return run("pnpm", ["exec", "tsx", script, ...args], childEnv(extra));
}

function nodeEval(code: string) {
  return run(process.execPath, ["--import", guard, "-e", code], childEnv({ NODE_OPTIONS: "" }));
}

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function rawCapture(): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(velocityFixture())) as {
    scope: { owners: string[] };
    repositories: { repo: string }[];
  };
  raw.scope.owners = ["EXAMPLE"];
  raw.repositories.reverse();
  raw.repositories[0].repo = raw.repositories[0].repo.toUpperCase();
  return raw;
}

function validatorMessage(value: unknown): string {
  try {
    parseVelocity(value);
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 240) : "Invalid benchmark capture.";
  }
  throw new Error("expected the shared validator to reject the capture");
}

describe("velocity preview CLI", () => {
  it("rejects network and credential reads when the guard is armed", async () => {
    const fetched = await nodeEval("fetch('https://example.com/')");
    assert.equal(fetched.code, 97);
    assert.match(fetched.stderr, /velocity-preview-guard: fetch/);
    const connected = await nodeEval("import('node:net').then((net) => net.connect(80, '93.184.216.34'))");
    assert.equal(connected.code, 97);
    assert.match(connected.stderr, /velocity-preview-guard: socket.connect 93\.184\.216\.34/);
    const secret = await nodeEval("/* velocity-preview-guard-selftest */ process.env.MC_TOKEN");
    assert.equal(secret.code, 97);
    assert.match(secret.stderr, /velocity-preview-guard: env MC_TOKEN/);
  });

  it("prints the shared normalized preview and summary and leaves the file untouched", async () => {
    const raw = rawCapture();
    const file = join(dir, "capture.json");
    writeFileSync(file, JSON.stringify(raw));
    const before = sha(file);
    const listing = readdirSync(dir).sort();
    const expectedPreview = parseVelocity(raw);
    const expectedSummary = summarizeVelocity(expectedPreview);
    const first = await preview([file], { VELOCITY_PREVIEW_CAPTURE: file });
    const second = await preview([file], { VELOCITY_PREVIEW_CAPTURE: file });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);
    const body = JSON.parse(first.stdout) as { preview: unknown; summary: { ci: { revisions: { mean: number }; firstPassRate: number }; prs: { mergeHours: { median: number }; daily: { opened: number }[] }; cd: { preview: { turns: { mean: number | null } } } } };
    assert.deepEqual(Object.keys(body), ["preview", "summary"]);
    assert.deepEqual(body.preview, expectedPreview);
    assert.deepEqual(body.summary, expectedSummary);
    assert.equal(body.summary.ci.revisions.mean, 3);
    assert.equal(body.summary.ci.firstPassRate, 1 / 5);
    assert.equal(body.summary.prs.mergeHours.median, 2);
    assert.deepEqual(body.summary.prs.daily.map((day) => day.opened), [4, 3]);
    assert.equal(body.summary.cd.preview.turns.mean, null);
    assert.equal(sha(file), before);
    assert.deepEqual(readdirSync(dir).sort(), listing);
  });

  it("rejects invalid schema, metric version, JSON, UTF-8, oversize, and missing files", async () => {
    const raw = rawCapture();
    const secret = "super-secret-marker";
    const cases: { name: string; file: string; bytes: Buffer | string; message: string }[] = [
      { name: "schema", file: "schema.json", bytes: JSON.stringify({ ...raw, schemaVersion: 2 }), message: validatorMessage({ ...raw, schemaVersion: 2 }) },
      { name: "metric", file: "metric.json", bytes: JSON.stringify({ ...raw, metricVersion: "not-a-velocity-metric" }), message: validatorMessage({ ...raw, metricVersion: "not-a-velocity-metric" }) },
      { name: "json", file: "broken.json", bytes: `{${secret}`, message: "Capture is not valid UTF-8 JSON." },
      { name: "utf8", file: "bad-utf8.json", bytes: Buffer.from([0xff, 0xfe, 0xfd]), message: "Capture is not valid UTF-8 JSON." },
      { name: "oversize", file: "oversize.json", bytes: Buffer.alloc(VELOCITY_MAX_BYTES + 1, 0x78), message: "Capture exceeds the 2 MB limit." },
      { name: "exact-limit", file: "exact.json", bytes: Buffer.alloc(VELOCITY_MAX_BYTES, 0x7b), message: "Capture is not valid UTF-8 JSON." },
    ];
    for (const item of cases) {
      const file = join(dir, item.file);
      writeFileSync(file, item.bytes);
      const before = sha(file);
      const listing = readdirSync(dir).sort();
      const result = await preview([file], { VELOCITY_PREVIEW_CAPTURE: file });
      assert.equal(result.code, 1, item.name);
      assert.equal(result.stdout, "", item.name);
      assert.deepEqual(JSON.parse(result.stderr), { error: item.message }, item.name);
      assert.equal(result.stderr.includes(secret), false, item.name);
      assert.equal(result.stderr.includes(file), false, item.name);
      assert.equal(result.stderr.includes("not-a-velocity-metric"), false, item.name);
      assert.equal(sha(file), before, item.name);
      assert.deepEqual(readdirSync(dir).sort(), listing, item.name);
    }
    const missing = join(dir, "missing-do-not-print.json");
    const missingResult = await preview([missing]);
    assert.equal(missingResult.code, 1);
    assert.deepEqual(JSON.parse(missingResult.stderr), { error: "Capture file could not be read." });
    assert.equal(missingResult.stderr.includes("missing-do-not-print"), false);
    assert.equal(missingResult.stdout, "");
  });

  it("does not read credentials, config, or a second path", async () => {
    const config = join(dir, "collector.env");
    writeFileSync(config, "MC_TOKEN=super-secret-marker\n");
    const before = sha(config);
    const usage = await preview([]);
    assert.equal(usage.code, 1);
    assert.deepEqual(JSON.parse(usage.stderr), { error: "Usage: pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json" });
    const extra = await preview([config, "--config", config], { VELOCITY_PREVIEW_CAPTURE: config });
    assert.equal(extra.code, 1);
    assert.equal(extra.stderr.includes("velocity-preview-guard"), false);
    assert.equal(extra.stderr.includes("super-secret-marker"), false);
    assert.deepEqual(JSON.parse(extra.stderr), { error: "Usage: pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json" });
    assert.equal(sha(config), before);
    const source = readFileSync(join(root, script), "utf8");
    assert.equal(source.includes("process.env"), false);
    assert.equal(source.includes("MC_TOKEN"), false);
    assert.equal(source.includes("fetch("), false);
    assert.doesNotMatch(source, /node:(http|https|net|dns|tls)/);
    assert.equal(source.includes("velocity-store"), false);
  });
});
