import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// quickstart.sh must not install with whatever `pnpm` is already on PATH.
// A pnpm 10 lockfile fails under pnpm 8/9, so an older binary has to be
// refused and the packageManager pin fetched instead.

const script = path.resolve("scripts/quickstart.sh");
type Call = { bin: string; args: string[] };

function toolPath(name: string): string {
  const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const loc = found.stdout.trim();
  assert.ok(loc, `${name} must be on PATH so the fixture can hide pnpm without hiding Node`);
  return loc;
}

function run(version: string | null) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ak-quickstart-pnpm-"));
  const bin = path.join(work, "bin");
  const repo = path.join(work, "repo");
  const audit = path.join(work, "audit.jsonl");
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(repo, { mode: 0o700 });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "agent-kontrol",
    packageManager: "pnpm@10.33.0",
  }));
  fs.writeFileSync(path.join(repo, ".env"), "MC_TOKEN=fixture\nMC_DASHBOARD_PASSWORD=fixture\n", { mode: 0o600 });
  fs.writeFileSync(path.join(bin, "npx"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PNPM_AUDIT, JSON.stringify({ bin: "npx", args }) + "\\n");
const spec = args.find((arg) => arg.startsWith("pnpm@"));
if (spec !== "pnpm@10.33.0" || !args.includes("install") || !args.includes("--frozen-lockfile")) process.exit(42);
`, { mode: 0o700 });
  // The "pnpm missing" case must not see the real pnpm, which lives beside node.
  // Symlink only the tools the script needs and drop the rest of PATH.
  let pathEnv = `${bin}${path.delimiter}${process.env.PATH}`;
  if (version === null) {
    for (const name of ["node", "npm", "git"]) fs.symlinkSync(toolPath(name), path.join(bin, name));
    pathEnv = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  } else {
    fs.writeFileSync(path.join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PNPM_AUDIT, JSON.stringify({ bin: "pnpm", args }) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  console.log(process.env.FAKE_PNPM_VERSION);
  process.exit(0);
}
if (process.env.FAKE_PNPM_VERSION === "10.33.0") process.exit(0);
process.exit(41);
`, { mode: 0o700 });
  }
  try {
    const result = spawnSync("bash", [script, "--local", "--no-start", "--dir", repo], {
      cwd: work,
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: pathEnv,
        PNPM_AUDIT: audit,
        FAKE_PNPM_VERSION: version ?? "",
      },
    });
    const calls: Call[] = fs.existsSync(audit)
      ? fs.readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call)
      : [];
    return { status: result.status, out: result.stdout, err: result.stderr, calls };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

describe("quickstart pnpm pin", () => {
  it("does not install with an older pnpm that is already on PATH", () => {
    const result = run("9.15.0");
    assert.equal(result.status, 0, result.err + result.out);
    assert.match(result.err, /found pnpm 9\.15\.0; using pnpm@10\.33\.0/);
    const pnpmCalls = result.calls.filter((call) => call.bin === "pnpm");
    assert.deepEqual(pnpmCalls.map((call) => call.args), [["--version"]]);
    const npxCalls = result.calls.filter((call) => call.bin === "npx");
    assert.equal(npxCalls.length, 1);
    assert.deepEqual(npxCalls[0]?.args, ["--yes", "pnpm@10.33.0", "install", "--frozen-lockfile"]);
  });

  it("uses the installed pnpm when it is exactly the pin", () => {
    const result = run("10.33.0");
    assert.equal(result.status, 0, result.err + result.out);
    assert.equal(result.err.includes("using pnpm@"), false);
    assert.equal(result.calls.some((call) => call.bin === "npx"), false);
    const installs = result.calls.filter((call) => call.bin === "pnpm" && call.args[0] === "install");
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0]?.args, ["install", "--frozen-lockfile"]);
  });

  it("fetches the pin when pnpm is not installed", () => {
    const result = run(null);
    assert.equal(result.status, 0, result.err + result.out);
    assert.equal(result.calls.some((call) => call.bin === "pnpm"), false);
    assert.deepEqual(result.calls.map((call) => call.args), [["--yes", "pnpm@10.33.0", "install", "--frozen-lockfile"]]);
  });
});
