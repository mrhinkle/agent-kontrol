import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Execute the real shell dispatch with deterministic network/helper boundaries.
function run(options: { dry?: boolean; writable?: boolean; partial?: boolean; written?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ak-activity-"));
  const calls = path.join(dir, "calls");
  const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content, { mode: 0o700 });
  write("gh", '#!/bin/sh\n[ "$1" = auth ] && exit 0\necho unexpected-detailed-gh >&2\nexit 77\n');
  write("python3", `#!/bin/sh
printf '%s' "$ACTIVITY_SCAN"
`);
  write("curl", `#!/bin/bash
url="\${!#}"
case "$url" in
  */api/settings/owners) printf '%s' "$OWNER_SETTINGS" ;;
  */api/settings/repos) printf '%s' '{"repos":[{"repo":"acme/app"}]}' ;;
  */api/settings/owners/discover) echo discovery >> "$CALLS"; printf '%s' '{"results":[{"ok":true}]}' ;;
  */api/progress/ingest) echo ingest >> "$CALLS"; printf '{"ok":true,"written":%s}' "$WRITTEN" ;;
  *) echo "unexpected endpoint" >&2; exit 78 ;;
esac
`);
  write("config.json", JSON.stringify({ repos: [{ repo: "acme/app", label: "App", short: "app" }] }));
  const scan = {
    discovery: { results: [{ owner: "acme", ok: !options.partial, repos: [] }] },
    snapshot: { kind: "activity", collected_at: "2026-11-04T15:00:00Z", repos: [{ repo: "acme/app", detail: { activity: { status: options.partial ? "unavailable" : "complete" } } }] },
    summary: { observed: 1 },
  };
  try {
    const result = spawnSync("bash", ["scripts/collect-progress.sh", "--activity-only", ...(options.dry ? ["--dry-run"] : [])], {
      encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MC_URL: "https://test.invalid", MC_TOKEN: "test-only",
        MC_ENV_FILE: "/dev/null", MC_REPOS_FROM_DASHBOARD: "1", MC_PROGRESS_CONFIG: path.join(dir, "config.json"),
        OWNER_SETTINGS: JSON.stringify({ writable: options.writable !== false, owners: [] }),
        ACTIVITY_SCAN: JSON.stringify(scan), CALLS: calls, WRITTEN: String(options.written ?? 1) },
    });
    return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("activity-only publishes discovery and observation, never detailed/decision/sweep producers", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, ["discovery", "ingest"]);
  assert.deepEqual(JSON.parse(result.stdout), { observed: 1 });
});
test("activity dry-run makes no writes", () => {
  const result = run({ dry: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.equal(JSON.parse(result.stdout).snapshot.kind, "activity");
});
test("unwritable settings fail without calling either write endpoint", () => {
  const result = run({ writable: false });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
});
test("partial observations are published but never reported complete", () => {
  const result = run({ partial: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ["discovery", "ingest"]);
  assert.match(result.stderr, /coverage incomplete/);
});
test("collision or dropped writes fail publication verification", () => {
  const result = run({ written: 0 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publication unconfirmed/);
});
