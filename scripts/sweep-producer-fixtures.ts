/**
 * Fixtures for scripts/sweep-producer.sh (#79): a stub `gh` that answers the
 * producer's GraphQL queries from files, and a local ingest server that keeps
 * per-subject seq like sweep-evidence.ts. No network, no live GitHub, and no
 * real credential. Used by run-sweep-producer-tests.ts and the PG sweeper tests.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

export const PRODUCER = path.join(__dirname, "sweep-producer.sh");
export const FAKE_TOKEN = "ak-sweep-producer-test-token-not-a-secret";

const STUB_GH = `#!/usr/bin/env bash
# Fixture gh. GraphQL: <dir>/<owner>__<name>/<Operation>-<after|first>.{json,stderr,exit,sleep}
fix="$SWEEP_FIX_DIR"
if [[ "\${1:-}" == "auth" ]]; then exit 0; fi
op=""; owner=""; name=""; after="first"; jqarg=0; search=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|-F)
      case "$2" in
        query=*) op="$(printf '%s' "\${2#query=}" | sed -n 's/^query \\([A-Za-z]*\\).*/\\1/p' | head -1)" ;;
        owner=*) owner="\${2#owner=}" ;;
        name=*) name="\${2#name=}" ;;
        after=*) after="\${2#after=}" ;;
      esac
      shift 2 ;;
    --jq) jqarg=1; shift 2 ;;
    search/issues) search=1; shift ;;
    *) shift ;;
  esac
done
if [[ -z "$op" ]]; then
  printf 'other\\n' >> "$fix/calls.log"
  if [[ $jqarg -eq 1 ]]; then echo 0; elif [[ $search -eq 1 ]]; then echo '{"total_count":0,"items":[]}'; else echo '[]'; fi
  exit 0
fi
base="$fix/\${owner}__\${name}/\${op}-\${after}"
printf '%s/%s %s %s\\n' "$owner" "$name" "$op" "$after" >> "$fix/calls.log"
[[ -f "$base.sleep" ]] && sleep "$(cat "$base.sleep")"
[[ -f "$base.stderr" ]] && cat "$base.stderr" >&2
[[ -f "$base.json" ]] && cat "$base.json"
[[ -f "$base.exit" ]] && exit "$(cat "$base.exit")"
[[ -f "$base.json" ]] || { echo "no fixture" >&2; exit 1; }
exit 0
`;

export type Json = Record<string, any>;

export function sha(seed: string | number): string {
  const hex = Buffer.from(String(seed)).toString("hex");
  return (hex + "0".repeat(40)).slice(0, 40).replace(/[^0-9a-f]/g, "a");
}

export interface IssueFixture { number: number; labels: string[]; labelTotal?: number }
export interface CtxFixture { kind: "check" | "status"; name: string; status?: string; conclusion?: string | null; state?: string }
export interface PrFixture {
  number: number;
  title?: string;
  draft?: boolean;
  createdAt?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  head: string;
  commitOid?: string | null;
  contexts?: CtxFixture[] | null;
  contextsTruncated?: boolean;
  reviews?: { state: string; oid: string }[];
}

export class Fixture {
  readonly dir: string;
  readonly bin: string;
  readonly state: string;
  constructor(root: string) {
    this.dir = fs.mkdtempSync(path.join(root, "fix-"));
    this.bin = path.join(this.dir, "bin");
    this.state = path.join(this.dir, "state");
    fs.mkdirSync(this.bin);
    fs.writeFileSync(path.join(this.bin, "gh"), STUB_GH, { mode: 0o755 });
  }

  private file(repo: string, op: string, after: string, ext: string): string {
    const d = path.join(this.dir, repo.replace("/", "__"));
    fs.mkdirSync(d, { recursive: true });
    return path.join(d, `${op}-${after}.${ext}`);
  }

  clear(repo: string): void {
    fs.rmSync(path.join(this.dir, repo.replace("/", "__")), { recursive: true, force: true });
  }

  raw(repo: string, op: string, after: string, body: string | null, opts: { exit?: number; stderr?: string; sleep?: number } = {}): void {
    if (body !== null) fs.writeFileSync(this.file(repo, op, after, "json"), body);
    if (opts.exit !== undefined) fs.writeFileSync(this.file(repo, op, after, "exit"), String(opts.exit));
    if (opts.stderr !== undefined) fs.writeFileSync(this.file(repo, op, after, "stderr"), opts.stderr);
    if (opts.sleep !== undefined) fs.writeFileSync(this.file(repo, op, after, "sleep"), String(opts.sleep));
  }

  /**
   * Pages of 100; totalCount defaults to the issue count. The producer reads
   * the set twice; `verify` is what the second read sees (default: the same).
   */
  issues(repo: string, list: IssueFixture[], opts: { total?: number; lastTotal?: number; verify?: IssueFixture[] } = {}): void {
    this.issuePages(repo, "SweepIssues", list, opts);
    this.issuePages(repo, "SweepIssuesVerify", opts.verify ?? list, opts);
  }

  private issuePages(repo: string, op: string, list: IssueFixture[], opts: { total?: number; lastTotal?: number }): void {
    const pages = Math.max(1, Math.ceil(list.length / 100));
    for (let p = 0; p < pages; p++) {
      const nodes = list.slice(p * 100, p * 100 + 100).map((i) => ({
        number: i.number,
        labels: { totalCount: i.labelTotal ?? i.labels.length, nodes: i.labels.map((name) => ({ name })) },
      }));
      const more = p < pages - 1;
      const total = p === pages - 1 && opts.lastTotal !== undefined ? opts.lastTotal : opts.total ?? list.length;
      this.raw(repo, op, p === 0 ? "first" : `c${p}`, JSON.stringify({
        data: { repository: { issues: { totalCount: total, pageInfo: { hasNextPage: more, endCursor: more ? `c${p + 1}` : null }, nodes } } },
      }));
    }
  }

  /** Pages of 50 for SweepPrs and 100 for SweepPrHeads. `heads` overrides the second pass. */
  prs(repo: string, list: PrFixture[], opts: { total?: number; heads?: [number, string][] } = {}): void {
    const node = (pr: PrFixture) => {
      const oid = pr.commitOid === undefined ? pr.head : pr.commitOid;
      const ctx = pr.contexts === undefined ? [] : pr.contexts;
      return {
        number: pr.number,
        title: pr.title ?? `PR ${pr.number}`,
        url: `https://github.com/${repo}/pull/${pr.number}`,
        isDraft: pr.draft ?? false,
        createdAt: pr.createdAt ?? "2026-10-01T00:00:00Z",
        mergeable: pr.mergeable ?? "MERGEABLE",
        headRefOid: pr.head,
        commits: { nodes: oid === null ? [] : [{ commit: { oid, statusCheckRollup: ctx === null ? null : {
          contexts: {
            pageInfo: { hasNextPage: pr.contextsTruncated === true },
            nodes: ctx.map((c) => c.kind === "check"
              ? { __typename: "CheckRun", name: c.name, status: c.status ?? "COMPLETED", conclusion: c.conclusion === undefined ? "SUCCESS" : c.conclusion }
              : { __typename: "StatusContext", context: c.name, state: c.state ?? "SUCCESS" }),
          },
        } } }] },
        reviews: { totalCount: (pr.reviews ?? []).length, nodes: (pr.reviews ?? []).map((r) => ({ state: r.state, commit: { oid: r.oid } })) },
      };
    };
    const total = opts.total ?? list.length;
    const pages = Math.max(1, Math.ceil(list.length / 50));
    for (let p = 0; p < pages; p++) {
      const more = p < pages - 1;
      this.raw(repo, "SweepPrs", p === 0 ? "first" : `p${p}`, JSON.stringify({
        data: { repository: { pullRequests: { totalCount: total, pageInfo: { hasNextPage: more, endCursor: more ? `p${p + 1}` : null }, nodes: list.slice(p * 50, p * 50 + 50).map(node) } } },
      }));
    }
    const heads = opts.heads ?? list.map((pr) => [pr.number, pr.head] as [number, string]);
    const hpages = Math.max(1, Math.ceil(heads.length / 100));
    for (let p = 0; p < hpages; p++) {
      const more = p < hpages - 1;
      this.raw(repo, "SweepPrHeads", p === 0 ? "first" : `h${p}`, JSON.stringify({
        data: { repository: { pullRequests: { totalCount: heads.length, pageInfo: { hasNextPage: more, endCursor: more ? `h${p + 1}` : null },
          nodes: heads.slice(p * 100, p * 100 + 100).map(([number, headRefOid]) => ({ number, headRefOid })) } } },
      }));
    }
  }

  config(body: Json | null): string {
    const file = path.join(this.dir, "sweep-producer.config.json");
    if (body === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(body));
    return file;
  }

  calls(): string[] {
    const f = path.join(this.dir, "calls.log");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
  }

  env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = {
      PATH: `${this.bin}:${process.env.PATH}`,
      HOME: this.dir,
      TMPDIR: os.tmpdir(),
      SWEEP_FIX_DIR: this.dir,
      MC_ENV_FILE: "/dev/null",
      MC_SWEEP_PRODUCER_CONFIG: path.join(this.dir, "sweep-producer.config.json"),
      MC_SWEEP_STATE_DIR: this.state,
      MC_SWEEP_GH_TIMEOUT: "10",
      MC_SWEEP_HTTP_TIMEOUT: "5",
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    return env as NodeJS.ProcessEnv;
  }
}

export function baseConfig(repos: Json, over: Json = {}): Json {
  return { enabled: true, source: "collector-test", stale_after_minutes: 30, repos, ...over };
}

export function repoConfig(repo: string, over: Json = {}): Json {
  return {
    queue: `issues:${repo}`,
    ready_labels: ["dispatch-ready"],
    blocked_labels: ["blocked"],
    raw_exclude_labels: ["decision"],
    required_checks: ["ci", "postgres"],
    review_start: { status_context: "review/started" },
    ...over,
  };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

export function runProducer(fx: Fixture, args: string[], env: Record<string, string | undefined> = {}, script = PRODUCER): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], { env: fx.env(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export interface Received { auth: string | undefined; raw: string; body: Json }

/**
 * A local /api/ingest. Default answers mirror sweep-evidence.ts: per subject,
 * a higher seq is applied, the same seq is replay, a lower seq is older.
 * `script` overrides the answer for the next requests, in order.
 */
export class IngestServer {
  readonly got: Received[] = [];
  readonly script: { status: number; body?: Json }[] = [];
  private readonly seqs = new Map<string, number>();
  private server!: http.Server;
  url = "";

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: Json = {};
        try { body = JSON.parse(raw); } catch { /* recorded as raw */ }
        this.got.push({ auth: req.headers.authorization, raw, body });
        const next = this.script.shift();
        if (next) {
          res.writeHead(next.status, { "content-type": "application/json" });
          res.end(JSON.stringify(next.body ?? {}));
          return;
        }
        const o = body.observation ?? {};
        const subject = body.kind === "sweep.queue" ? `q:${String(o.queue).toLowerCase()}` : `p:${String(o.repo).toLowerCase()}`;
        const prev = this.seqs.get(subject) ?? 0;
        const outcome = o.seq > prev ? "applied" : o.seq === prev ? "replay" : "older";
        if (outcome === "applied") this.seqs.set(subject, o.seq);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, kind: body.kind, outcome, observation_id: String(this.got.length), received_at: new Date().toISOString() }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  reset(): void {
    this.got.length = 0;
    this.script.length = 0;
    this.seqs.clear();
  }

  of(kind: string): Json[] {
    return this.got.filter((g) => g.body.kind === kind).map((g) => g.body.observation);
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
