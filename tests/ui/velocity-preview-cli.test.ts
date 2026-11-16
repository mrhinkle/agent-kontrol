import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVelocity, summarizeVelocity, VELOCITY_MAX_BYTES } from "../../src/lib/velocity";
import { previewFile, PreviewReject } from "../../scripts/preview-velocity";
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

const VALIDATION_FIX = "Correct the capture so it matches the shared velocity contract, then run the command again.";

function failure(code: string, error: string, cause: string, fix: string) {
  return { error, code, cause, fix, retryable: false };
}

function validationFailure(message: string) {
  return failure("validation", message, message, VALIDATION_FIX);
}

const READ_FAILURE = failure(
  "read",
  "Capture file could not be read.",
  "The path could not be opened, read, or closed as a file.",
  "Pass a readable regular file and run the command again.",
);
const USAGE_FAILURE = failure(
  "usage",
  "Usage: pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json",
  "The command needs exactly one capture path.",
  "Run pnpm exec tsx scripts/preview-velocity.ts CAPTURE.json with one local JSON file.",
);

function assertRejected(result: { code: number; stdout: string; stderr: string }, expected: ReturnType<typeof failure>, label: string) {
  assert.equal(result.code, 1, label);
  assert.equal(result.stdout, "", label);
  const body = JSON.parse(result.stderr) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error", "code", "cause", "fix", "retryable"], label);
  assert.deepEqual(body, expected, label);
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
    const schemaMessage = validatorMessage({ ...raw, schemaVersion: 2 });
    const metricMessage = validatorMessage({ ...raw, metricVersion: "not-a-velocity-metric" });
    const cases: { name: string; file: string; bytes: Buffer | string; expected: ReturnType<typeof failure> }[] = [
      { name: "schema", file: "schema.json", bytes: JSON.stringify({ ...raw, schemaVersion: 2 }), expected: validationFailure(schemaMessage) },
      { name: "metric", file: "metric.json", bytes: JSON.stringify({ ...raw, metricVersion: "not-a-velocity-metric" }), expected: validationFailure(metricMessage) },
      { name: "json", file: "broken.json", bytes: `{${secret}`, expected: failure("json", "Capture is not valid UTF-8 JSON.", "The file is valid UTF-8 but is not JSON.", "Correct the JSON syntax and run the command again.") },
      { name: "utf8", file: "bad-utf8.json", bytes: Buffer.from([0xff, 0xfe, 0xfd]), expected: failure("utf8", "Capture is not valid UTF-8 JSON.", "The file is not valid UTF-8.", "Save the capture as UTF-8 JSON and run the command again.") },
      { name: "oversize", file: "oversize.json", bytes: Buffer.alloc(VELOCITY_MAX_BYTES + 1, 0x78), expected: failure("oversize", "Capture exceeds the 2 MB limit.", "The file is larger than 2 MB.", "Pass a capture of at most 2 MB and run the command again.") },
      { name: "exact-limit", file: "exact.json", bytes: Buffer.alloc(VELOCITY_MAX_BYTES, 0x7b), expected: failure("json", "Capture is not valid UTF-8 JSON.", "The file is valid UTF-8 but is not JSON.", "Correct the JSON syntax and run the command again.") },
    ];
    for (const item of cases) {
      const file = join(dir, item.file);
      writeFileSync(file, item.bytes);
      const before = sha(file);
      const listing = readdirSync(dir).sort();
      const result = await preview([file], { VELOCITY_PREVIEW_CAPTURE: file });
      assertRejected(result, item.expected, item.name);
      assert.equal(result.stderr.includes(secret), false, item.name);
      assert.equal(result.stderr.includes(file), false, item.name);
      assert.equal(result.stderr.includes("not-a-velocity-metric"), false, item.name);
      assert.equal(sha(file), before, item.name);
      assert.deepEqual(readdirSync(dir).sort(), listing, item.name);
    }
    const missing = join(dir, "missing-do-not-print.json");
    const missingResult = await preview([missing]);
    assertRejected(missingResult, READ_FAILURE, "missing");
    assert.equal(missingResult.stderr.includes("missing-do-not-print"), false);
    assert.equal(missingResult.stderr.includes("ENOENT"), false);
  });

  it("reports a directory as an unreadable file and hides the filesystem diagnostic", async () => {
    const dot = await preview(["."]);
    assertRejected(dot, READ_FAILURE, "dot");
    assert.equal(dot.stderr.includes("EISDIR"), false);
    assert.equal(dot.stderr.includes("illegal operation"), false);
    assert.equal(dot.stderr.includes(root), false);
    const directory = await preview([dir]);
    assertRejected(directory, READ_FAILURE, "directory");
    assert.equal(directory.stderr.includes(dir), false);
    assert.equal(directory.stderr.includes("EISDIR"), false);
  });

  it("does not read credentials, config, or a second path", async () => {
    const config = join(dir, "collector.env");
    writeFileSync(config, "MC_TOKEN=super-secret-marker\n");
    const before = sha(config);
    const usage = await preview([]);
    assertRejected(usage, USAGE_FAILURE, "usage");
    const extra = await preview([config, "--config", config], { VELOCITY_PREVIEW_CAPTURE: config });
    assert.equal(extra.stderr.includes("velocity-preview-guard"), false);
    assert.equal(extra.stderr.includes("super-secret-marker"), false);
    assertRejected(extra, USAGE_FAILURE, "extra");
    assert.equal(sha(config), before);
    const source = readFileSync(join(root, script), "utf8");
    assert.equal(source.includes("process.env"), false);
    assert.equal(source.includes("MC_TOKEN"), false);
    assert.equal(source.includes("fetch("), false);
    assert.doesNotMatch(source, /node:(http|https|net|dns|tls)/);
    assert.equal(source.includes("velocity-store"), false);
  });

  it("does not replace an earlier rejection with a close failure or classify a read error as validation", async () => {
    const raw = rawCapture();
    const schema = { ...raw, schemaVersion: 2 };
    const schemaMessage = validatorMessage(schema);
    const readLeak = "Repositories must be unique, ignoring case.";
    const closeLeak = "EBADF: close-marker /private/capture.json";
    const utf8Failure = failure("utf8", "Capture is not valid UTF-8 JSON.", "The file is not valid UTF-8.", "Save the capture as UTF-8 JSON and run the command again.");
    const jsonFailure = failure("json", "Capture is not valid UTF-8 JSON.", "The file is valid UTF-8 but is not JSON.", "Correct the JSON syntax and run the command again.");
    const oversizeFailure = failure("oversize", "Capture exceeds the 2 MB limit.", "The file is larger than 2 MB.", "Pass a capture of at most 2 MB and run the command again.");

    async function run(bytes: Buffer | null, faults: { open?: Error; read?: Error; close?: Error } = {}) {
      let closed = 0;
      let value: unknown;
      let error: unknown;
      try {
        value = await previewFile("capture.json", async () => {
          if (faults.open) throw faults.open;
          return {
            read: async (buffer: Buffer, offset: number, length: number) => {
              if (faults.read) throw faults.read;
              const source = bytes ?? Buffer.alloc(0);
              if (offset >= source.length) return { bytesRead: 0 };
              const n = Math.min(length, source.length - offset);
              source.copy(buffer, offset, offset, offset + n);
              return { bytesRead: n };
            },
            close: async () => {
              closed += 1;
              if (faults.close) throw faults.close;
            },
          };
        });
      } catch (caught) {
        error = caught;
      }
      return { value, error, closed };
    }

    function body(error: unknown) {
      assert.ok(error instanceof PreviewReject);
      return { error: error.message, code: error.code, cause: error.reason, fix: error.fix, retryable: error.retryable };
    }

    const readAndClose = await run(null, { read: new Error(`EISDIR: ${readLeak}`), close: new Error(closeLeak) });
    assert.equal(readAndClose.closed, 1);
    assert.deepEqual(body(readAndClose.error), READ_FAILURE);
    assert.equal(JSON.stringify(body(readAndClose.error)).includes(readLeak), false);
    assert.equal(JSON.stringify(body(readAndClose.error)).includes("EISDIR"), false);
    assert.equal(JSON.stringify(body(readAndClose.error)).includes(closeLeak), false);

    const opened = await run(null, { open: new Error(`EACCES: ${dir}`) });
    assert.equal(opened.closed, 0);
    assert.deepEqual(body(opened.error), READ_FAILURE);
    assert.equal(JSON.stringify(body(opened.error)).includes(dir), false);

    const oversize = await run(Buffer.alloc(VELOCITY_MAX_BYTES + 1, 0x78), { close: new Error(closeLeak) });
    assert.deepEqual(body(oversize.error), oversizeFailure);
    assert.equal(JSON.stringify(body(oversize.error)).includes(closeLeak), false);

    const utf8 = await run(Buffer.from([0xff, 0xfe, 0xfd]), { close: new Error(closeLeak) });
    assert.deepEqual(body(utf8.error), utf8Failure);
    assert.equal(JSON.stringify(body(utf8.error)).includes(closeLeak), false);

    const json = await run(Buffer.from("{"), { close: new Error(closeLeak) });
    assert.deepEqual(body(json.error), jsonFailure);
    assert.equal(JSON.stringify(body(json.error)).includes(closeLeak), false);

    const invalid = await run(Buffer.from(JSON.stringify(schema)), { close: new Error(closeLeak) });
    assert.deepEqual(body(invalid.error), validationFailure(schemaMessage));
    assert.equal(JSON.stringify(body(invalid.error)).includes(closeLeak), false);

    const closedValid = await run(Buffer.from(JSON.stringify(raw)), { close: new Error(closeLeak) });
    assert.deepEqual(body(closedValid.error), READ_FAILURE);
    assert.equal(JSON.stringify(body(closedValid.error)).includes(closeLeak), false);

    const accepted = await run(Buffer.from(JSON.stringify(raw)));
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.closed, 1);
    const expectedPreview = parseVelocity(raw);
    assert.deepEqual(accepted.value, { preview: expectedPreview, summary: summarizeVelocity(expectedPreview) });
  });
});
