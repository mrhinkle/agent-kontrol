/**
 * Tests for scripts/collect-skills-drift.mjs with temp-dir fixtures and a local HTTP server.
 * No database, no secrets. The token below is a fake that must never appear in any output.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseDriftBody } from "../src/lib/skills/drift-report";
import { skillSha } from "../src/lib/skills/sha";
import { run, scanDir } from "./collect-skills-drift.mjs";

const SCRIPT = path.join(__dirname, "collect-skills-drift.mjs");
const TOKEN = "ak-drift-test-token-not-a-secret";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "drift-collector-"));
let n = 0;

function skillsDir(files: Record<string, string | Buffer>): string {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    throw e;
  }
}

async function withServer(
  status: number,
  fn: (url: string, got: { auth?: string; body?: any }[]) => Promise<void>,
) {
  const got: { auth?: string; body?: any }[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      got.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { ok: true, driftCount: 0 } : { error: "nope" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, got);
  } finally {
    server.close();
  }
}

(async () => {
  await check("hashes raw bytes and matches the server's skillSha", async () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("---\nname: bom\n---\n")]);
    const crlf = Buffer.from("---\r\nname: crlf\r\n---\r\nbody\r\n");
    const dir = skillsDir({ "bom/SKILL.md": bom, "crlf/SKILL.md": crlf, "plain/SKILL.md": "# plain\n" });
    const r = await scanDir(dir);
    assert.equal(r.status, "ok");
    const by = Object.fromEntries(r.skills.map((s: any) => [s.name, s.sha]));
    assert.equal(by.bom, skillSha(bom));
    assert.equal(by.crlf, skillSha(crlf));
    assert.notEqual(by.crlf, skillSha(crlf.toString("utf8").replace(/\r\n/g, "\n")), "CRLF must not be normalised");
    assert.notEqual(by.bom, skillSha(bom.subarray(3)), "BOM must be hashed");
    assert.equal(by.plain, skillSha("# plain\n"));
  });

  await check("follows one level of symlink, skips hidden, files and dirs without SKILL.md", async () => {
    const dir = skillsDir({ "real/SKILL.md": "r", ".system/hidden/SKILL.md": "h", "notes.txt": "x", "empty/readme.md": "y" });
    const target = skillsDir({ "linked/SKILL.md": "L" });
    fs.symlinkSync(path.join(target, "linked"), path.join(dir, "linked"));
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "chain1"));
    fs.symlinkSync(path.join(dir, "chain1"), path.join(dir, "chain2"));
    fs.symlinkSync(path.join(dir, "gone"), path.join(dir, "dangling"));
    const r = await scanDir(dir);
    assert.equal(r.status, "ok");
    const names = r.skills.map((s: any) => s.name);
    assert.deepEqual(names, ["chain1", "linked", "real"], "sorted; chain2 (two levels) is skipped");
    assert.ok(r.warnings.some((w: string) => w.startsWith("chain2")));
    assert.equal(r.skills.find((s: any) => s.name === "linked")!.sha, skillSha("L"));
  });

  await check("empty directory is ok with an empty list; missing directory is distinct", async () => {
    const empty = skillsDir({});
    assert.deepEqual(await scanDir(empty), { status: "ok", skills: [], warnings: [] });
    assert.deepEqual(await scanDir(path.join(root, "nope")), { status: "missing" });
  });

  const canChmod = process.getuid?.() !== 0;
  await check("unreadable directory fails; unreadable SKILL.md fails the whole dir", async () => {
    if (!canChmod) return console.log("skip (running as root)");
    const dir = skillsDir({ "a/SKILL.md": "a" });
    fs.chmodSync(dir, 0o000);
    try {
      assert.equal((await scanDir(dir)).status, "failed");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    const dir2 = skillsDir({ "a/SKILL.md": "a", "b/SKILL.md": "b" });
    fs.chmodSync(path.join(dir2, "b/SKILL.md"), 0o000);
    try {
      assert.equal((await scanDir(dir2)).status, "failed");
    } finally {
      fs.chmodSync(path.join(dir2, "b/SKILL.md"), 0o644);
    }
  });

  await check("a path that is a file is a failure, not empty", async () => {
    const dir = skillsDir({ "afile": "x" });
    assert.equal((await scanDir(path.join(dir, "afile"))).status, "failed");
  });

  await check("dry run prints the report, needs no token, and the payload passes the server validator", async () => {
    const dir = skillsDir({ "one/SKILL.md": "1" });
    const { lines, io } = capture();
    const code = await run(["--dry-run", "--machine", "laptop"], { HOME: root, AK_SKILL_DRIFT_DIRS: dir }, io);
    assert.equal(code, 0);
    const printed = JSON.parse(lines.join("\n"));
    assert.equal(printed.dryRun, true);
    assert.equal(printed.report.host, "laptop");
    const parsed = parseDriftBody(printed.report);
    // The server only accepts configured dirs; the fixture dir is allowed through the same variable.
    process.env.AK_SKILL_DRIFT_DIRS = dir;
    assert.equal(parseDriftBody(printed.report).ok, true);
    delete process.env.AK_SKILL_DRIFT_DIRS;
    assert.equal(parsed.ok, false, "a dir outside the server's list is still rejected");
  });

  await check("default dirs are the two documented ones and match the server default", async () => {
    const { driftDirs } = await import("../src/lib/skills/drift");
    const mod = await import("./collect-skills-drift.mjs");
    assert.deepEqual(mod.DEFAULT_DIRS, driftDirs());
  });

  await check("posts one report per dir with the bearer token; token is never printed", async () => {
    const a = skillsDir({ "x/SKILL.md": "x" });
    const b = skillsDir({});
    await withServer(200, async (url, got) => {
      const { lines, io } = capture();
      const env = { HOME: root, MC_URL: url, MC_TOKEN: TOKEN, AK_MACHINE: "mini", AK_SKILL_DRIFT_DIRS: `${a},${b}` };
      const code = await run([], env, io);
      assert.equal(code, 0);
      assert.equal(got.length, 2);
      assert.equal(got[0].auth, `Bearer ${TOKEN}`);
      assert.deepEqual(got[0].body, { host: "mini", dir: a, skills: [{ name: "x", sha: skillSha("x") }] });
      assert.deepEqual(got[1].body.skills, [], "an empty readable dir posts an empty list");
      assert.ok(!lines.join("\n").includes(TOKEN));
    });
  });

  await check("idempotent: two runs post identical bodies", async () => {
    const a = skillsDir({ "b/SKILL.md": "b", "a/SKILL.md": "a" });
    await withServer(200, async (url, got) => {
      const env = { HOME: root, MC_URL: url, MC_TOKEN: TOKEN, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: a };
      await run([], env, capture().io);
      await run([], env, capture().io);
      assert.equal(got.length, 2);
      assert.deepEqual(got[0].body, got[1].body);
    });
  });

  await check("unreadable dir posts nothing for it, still posts the others, exits 2", async () => {
    if (!canChmod) return console.log("skip (running as root)");
    const bad = skillsDir({ "a/SKILL.md": "a" });
    const good = skillsDir({ "g/SKILL.md": "g" });
    fs.chmodSync(bad, 0o000);
    try {
      await withServer(200, async (url, got) => {
        const { lines, io } = capture();
        const code = await run([], { HOME: root, MC_URL: url, MC_TOKEN: TOKEN, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: `${bad},${good}` }, io);
        assert.equal(code, 2);
        assert.deepEqual(got.map((g) => g.body.dir), [good]);
        assert.ok(lines.some((l) => l.startsWith("FAIL")));
      });
    } finally {
      fs.chmodSync(bad, 0o755);
    }
  });

  await check("missing dir is skipped with exit 0; all missing is exit 3 and posts nothing", async () => {
    const good = skillsDir({ "g/SKILL.md": "g" });
    await withServer(200, async (url, got) => {
      const base = { HOME: root, MC_URL: url, MC_TOKEN: TOKEN, AK_MACHINE: "m" };
      assert.equal(await run([], { ...base, AK_SKILL_DRIFT_DIRS: `${path.join(root, "nope")},${good}` }, capture().io), 0);
      assert.equal(got.length, 1);
      assert.equal(await run([], { ...base, AK_SKILL_DRIFT_DIRS: path.join(root, "nope") }, capture().io), 3);
      assert.equal(got.length, 1);
    });
  });

  await check("server error exits 1 and does not echo the token", async () => {
    const a = skillsDir({ "x/SKILL.md": "x" });
    await withServer(401, async (url) => {
      const { lines, io } = capture();
      const code = await run([], { HOME: root, MC_URL: url, MC_TOKEN: TOKEN, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: a }, io);
      assert.equal(code, 1);
      assert.ok(!lines.join("\n").includes(TOKEN));
    });
  });

  await check("missing token, plain-http remote URL, and token-looking args are rejected", async () => {
    const a = skillsDir({});
    const base = { HOME: root, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: a };
    assert.equal(await run([], { ...base, MC_URL: "https://example.test" }, capture().io), 3);
    assert.equal(await run([], { ...base, MC_TOKEN: TOKEN, MC_URL: "http://example.test" }, capture().io), 3);
    const { lines, io } = capture();
    assert.equal(await run([`--token=${TOKEN}`], base, io), 3);
    assert.ok(!lines.join("\n").includes(TOKEN));
  });

  await check("does not read the token from ~/.claude/mission-control.env, and never prints server error text", async () => {
    const a = skillsDir({ "x/SKILL.md": "x" });
    const home = skillsDir({});
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude/mission-control.env"), `MC_URL=http://127.0.0.1:1\nMC_TOKEN=${TOKEN}\n`);
    const { lines, io } = capture();
    assert.equal(await run([], { HOME: home, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: a }, io), 3);
    assert.ok(lines.join("\n").includes("MC_TOKEN is not set"));
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `bad bearer ${TOKEN}` }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const out = capture();
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal(await run([], { HOME: root, MC_URL: url, MC_TOKEN: TOKEN, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: a }, out.io), 1);
      assert.ok(!out.lines.join("\n").includes(TOKEN));
    } finally {
      server.close();
    }
  });

  await check("a dangling SKILL.md symlink fails the dir instead of looking absent", async () => {
    const dir = skillsDir({ "a/SKILL.md": "a", "b/notes.md": "n" });
    fs.symlinkSync(path.join(dir, "gone.md"), path.join(dir, "b/SKILL.md"));
    const r = await scanDir(dir);
    assert.equal(r.status, "failed");
  });

  await check("CLI: exit code and no token in stdout/stderr", () => {
    const a = skillsDir({ "x/SKILL.md": "x" });
    const res = spawnSync(process.execPath, [SCRIPT, "--dry-run"], {
      env: { PATH: process.env.PATH, HOME: root, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: a, MC_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.ok(!(res.stdout + res.stderr).includes(TOKEN));
    const bad = spawnSync(process.execPath, [SCRIPT, "--dry-run"], {
      env: { PATH: process.env.PATH, HOME: root, AK_MACHINE: "m", AK_SKILL_DRIFT_DIRS: path.join(root, "nope") } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    assert.equal(bad.status, 3);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
})().catch((e) => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
