#!/usr/bin/env node
/**
 * Skills drift collector. Single file, Node 18+, no dependencies, no repo checkout needed.
 *
 * Reads the skills a machine has on disk and posts one report per directory to
 * POST /api/skills/drift, so Agent Kontrol can show drift against the upstream mirror.
 *
 *   MC_URL=https://your-deploy.vercel.app MC_TOKEN=... node collect-skills-drift.mjs
 *   node collect-skills-drift.mjs --dry-run        # prints the reports, posts nothing, needs no token
 *
 * Environment:
 *   MC_URL, MC_TOKEN      Required to post. Environment only: never taken from arguments or files by this
 *                         script, never printed. Server response text is never printed either.
 *   AK_SKILL_DRIFT_DIRS   Comma-separated dirs, same variable the server reads. Default:
 *                         ~/.codex/skills,~/.agents/skills. Each string is posted verbatim as `dir`
 *                         and must match the server's list; a leading ~ is expanded for reading only.
 *   AK_MACHINE            Name to report as `host`. Default: os.hostname().
 *
 * Exit codes:
 *   0  every existing directory was read and posted (a missing directory is skipped, not an error)
 *   1  a post failed
 *   2  a directory exists but could not be read or enumerated; nothing was posted for it
 *   3  configuration error, or every configured directory is missing, so nothing was reported
 *
 * Why a failed read posts nothing: an empty `skills` list means "read it, found nothing", and the
 * server would then show every mirrored skill as missing on this machine.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_DIRS = ["~/.codex/skills", "~/.agents/skills"];
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export const MAX_SKILLS = 5000;
const POST_TIMEOUT_MS = 30_000;

/** SHA-256 hex of the raw bytes. Same as src/lib/skills/sha.ts: no decoding, no newline normalisation. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function expandHome(p, home = os.homedir()) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** @param {Record<string, string | undefined>} [env] */
export function configuredDirs(env = process.env) {
  const raw = env.AK_SKILL_DRIFT_DIRS;
  if (raw === undefined || !raw.trim()) return DEFAULT_DIRS.slice();
  return raw.split(",").map((d) => d.trim()).filter(Boolean);
}

/**
 * Read one directory. Returns { status: "ok", skills, warnings } | { status: "missing" } |
 * { status: "failed", reason }. Never throws for filesystem problems.
 * @returns {Promise<{ status: string, skills: { name: string, sha: string }[], warnings: string[], reason?: string }>}
 */
export async function scanDir(configured, home = os.homedir()) {
  const dir = expandHome(configured, home);
  let names;
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return { status: "failed", reason: "not a directory" };
    names = await fs.readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return { status: "missing" };
    return { status: "failed", reason: errCode(err) };
  }

  const skills = [];
  const warnings = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const entry = path.join(dir, name);
    let skillDir;
    try {
      skillDir = await resolveSkillDir(entry);
    } catch (err) {
      if (err && err.code === "ENOENT") continue; // dangling symlink: not a skill
      return { status: "failed", reason: `${name}: ${errCode(err)}` };
    }
    if (skillDir === null) continue; // plain file, or a symlink that is not a directory
    if (skillDir === "chain") {
      warnings.push(`${name}: symlink to a symlink, skipped`);
      continue;
    }
    let bytes;
    try {
      bytes = await fs.readFile(path.join(skillDir, "SKILL.md"));
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR") && !(await entryExists(path.join(skillDir, "SKILL.md")))) {
        continue; // directory without SKILL.md
      }
      // A skill we cannot read must not look like a skill that is absent.
      return { status: "failed", reason: `${name}/SKILL.md: ${errCode(err)}` };
    }
    if (!NAME_RE.test(name)) {
      warnings.push(`${name}: not a valid skill id, skipped`);
      continue;
    }
    skills.push({ name, sha: sha256Hex(bytes) });
  }
  if (skills.length > MAX_SKILLS) return { status: "failed", reason: `more than ${MAX_SKILLS} skills` };
  return { status: "ok", skills, warnings };
}

/** Directory to look in for SKILL.md: the entry itself, or its target if it is a symlink (one level only). */
async function resolveSkillDir(entry) {
  const l = await fs.lstat(entry);
  if (l.isDirectory()) return entry;
  if (!l.isSymbolicLink()) return null;
  const target = path.resolve(path.dirname(entry), await fs.readlink(entry));
  const tl = await fs.lstat(target);
  if (tl.isSymbolicLink()) return "chain";
  return tl.isDirectory() ? target : null;
}

/** True for anything at the path, including a dangling symlink. */
async function entryExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function errCode(err) {
  return err && typeof err.code === "string" ? err.code : "read error";
}

export function buildReport(host, dir, skills) {
  return { host, dir, skills };
}

/** @param {Record<string, string | undefined>} [env] @param {string} [flag] */
export function machineName(env = process.env, flag) {
  const name = (flag || env.AK_MACHINE || os.hostname() || "").trim();
  return name.slice(0, 200);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** Returns a base URL, or throws a message that is safe to print (never contains the token). */
export function resolveBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw new Error("MC_URL must be an http(s) URL");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new Error("MC_URL must be https (http is allowed only for localhost)");
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

async function post(baseUrl, token, report) {
  const res = await fetch(`${baseUrl}/api/skills/drift`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(report),
    redirect: "error",
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Run the collector. `io` is { out(line), err(line) } so tests can capture output.
 * Returns the exit code.
 * @param {string[]} argv @param {Record<string, string | undefined>} [env] @param {{ out(l: string): void, err(l: string): void }} [io]
 */
export async function run(argv, env = process.env, io = { out: console.log, err: console.error }) {
  const args = parseArgs(argv);
  if (args.error) {
    io.err(args.error);
    return 3;
  }
  if (args.help) {
    io.out("usage: collect-skills-drift.mjs [--dry-run] [--machine NAME]");
    return 0;
  }

  const home = env.HOME || os.homedir();
  const dirs = configuredDirs(env);
  const host = machineName(env, args.machine);
  if (!host) {
    io.err("no machine name: set AK_MACHINE or --machine");
    return 3;
  }

  let baseUrl = "";
  let token = "";
  if (!args.dryRun) {
    token = env.MC_TOKEN || "";
    if (!token) {
      io.err("MC_TOKEN is not set in the environment");
      return 3;
    }
    try {
      baseUrl = resolveBaseUrl(env.MC_URL);
    } catch (e) {
      io.err(e.message);
      return 3;
    }
  }

  let code = 0;
  let reported = 0;
  let missing = 0;
  for (const dir of dirs) {
    const result = await scanDir(dir, home);
    if (result.status === "missing") {
      io.err(`skip ${dir}: directory does not exist`);
      missing += 1;
      continue;
    }
    if (result.status === "failed") {
      io.err(`FAIL ${dir}: could not read (${result.reason}); nothing posted for it`);
      code = 2;
      continue;
    }
    for (const w of result.warnings) io.err(`warn ${dir}: ${w}`);
    const report = buildReport(host, dir, result.skills);
    if (args.dryRun) {
      io.out(JSON.stringify({ dryRun: true, url: "(MC_URL)/api/skills/drift", report }, null, 2));
      reported += 1;
      continue;
    }
    try {
      const res = await post(baseUrl, token, report);
      if (!res.ok) {
        io.err(`FAIL ${dir}: server returned HTTP ${res.status}`);
        if (code === 0) code = 1;
        continue;
      }
      reported += 1;
      const b = res.body || {};
      io.out(
        b.demo
          ? `ok ${dir}: ${result.skills.length} skills sent; server is in demo mode and stored nothing`
          : `ok ${dir}: ${result.skills.length} skills, drift ${b.driftCount ?? "?"}`,
      );
    } catch (e) {
      // Only the error class is printed: a fetch error can carry the URL, never the token.
      io.err(`FAIL ${dir}: post failed (${e && e.name ? e.name : "error"})`);
      if (code === 0) code = 1;
    }
  }

  if (code === 0 && reported === 0) {
    io.err("no directory was reported: every configured directory is missing");
    return 3;
  }
  return code;
}

function parseArgs(argv) {
  const out = { dryRun: false, help: false, machine: undefined, error: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--machine") {
      out.machine = argv[++i];
      if (!out.machine) out.error = "--machine needs a value";
    } else out.error = "unknown argument (credentials are read from the environment, never from arguments)";
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error("unexpected error");
      process.exit(1);
    },
  );
}
