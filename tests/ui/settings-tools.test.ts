/**
 * MCP get_settings and set_watched_repos. Each F-test tries to break the rule it names.
 * Demo mode has no DATABASE_URL. Configured cases use the SQL test double.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { GET as getOwners } from "../../src/app/api/settings/owners/route";
import { GET as getRepos, PUT as putRepos } from "../../src/app/api/settings/repos/route";
import { runWithActor, type Actor } from "../../src/lib/actor";
import type { McpToolResult } from "../../src/lib/api-error";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { demoStoreSize, resetDemoStoreForTests } from "../../src/lib/demo-store";
import { REPOS } from "../../src/lib/progress-config";
import { authorizeTool, evaluateMcpMessages, SCOPES } from "../../src/lib/scopes";
import { readRepoSettings } from "../../src/lib/settings-read";
import { getSettingsTool, setWatchedReposTool } from "../../src/lib/settings-tools";
import { listVersion, replaceWatchedRepos } from "../../src/lib/watched-repos";

const env = process.env as Record<string, string | undefined>;
const saved = {
  db: env.DATABASE_URL,
  driver: env.MC_DB_DRIVER,
  token: env.MC_TOKEN,
  password: env.MC_DASHBOARD_PASSWORD,
  node: env.NODE_ENV,
};
const FIXTURE_URL = "postgres://test:test@127.0.0.1:5432/ak_settings_tools";

function restoreEnv() {
  for (const [key, value] of [
    ["DATABASE_URL", saved.db],
    ["MC_DB_DRIVER", saved.driver],
    ["MC_TOKEN", saved.token],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

afterEach(() => {
  setSqlForTests(null);
  resetDemoStoreForTests();
  restoreEnv();
});

function openDemo() {
  delete env.DATABASE_URL;
  delete env.MC_TOKEN;
  delete env.MC_DASHBOARD_PASSWORD;
  env.NODE_ENV = "test";
  resetDemoStoreForTests();
}

function errorOf(result: McpToolResult): {
  code: string;
  error: string;
  fix?: string;
  fields?: Record<string, string>;
  errors?: { index: number; field: string; message: string }[];
} {
  assert.equal(result.isError, true, result.content[0]?.text);
  assert.equal(result.structuredContent, undefined);
  return JSON.parse(result.content[0].text) as {
    code: string;
    error: string;
    fix?: string;
    fields?: Record<string, string>;
    errors?: { index: number; field: string; message: string }[];
  };
}

const actor: Actor = { actor_type: "agent", actor_id: "mc-token" };

function repo(name: string, short: string, label = short) {
  return { repo: name, label, short, color: "#112233", blockedLabel: null as string | null };
}

type MemRepo = {
  repo: string;
  label: string;
  short: string;
  color: string;
  blocked_label: string | null;
  position: number;
  origin: "manual" | "auto";
  pinned: boolean;
  hidden: boolean;
  gone: boolean;
  is_fork: boolean;
  is_archived: boolean;
  last_activity_at: string | null;
  fields_overridden: boolean | null;
};

function memRepo(name: string, short: string): MemRepo {
  return {
    repo: name,
    label: short,
    short,
    color: "#112233",
    blocked_label: null,
    position: 0,
    origin: "manual",
    pinned: false,
    hidden: false,
    gone: false,
    is_fork: false,
    is_archived: false,
    last_activity_at: null,
    fields_overridden: null,
  };
}

function installRepoStore(initial: MemRepo[]) {
  env.DATABASE_URL = FIXTURE_URL;
  env.MC_DB_DRIVER = "pg";
  env.NODE_ENV = "test";
  delete env.MC_TOKEN;
  delete env.MC_DASHBOARD_PASSWORD;
  const repos = initial.map((row) => ({ ...row }));
  const events: { id: number; kind: string; title: string; detail: string }[] = [];
  let writes = 0;
  const control = { failReceipt: false };
  let snap: { repos: MemRepo[]; events: typeof events; writes: number } | null = null;
  setSqlForTests(async (strings, ...values) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    if (text === "begin") {
      snap = {
        repos: repos.map((row) => ({ ...row })),
        events: events.map((row) => ({ ...row })),
        writes,
      };
      return [];
    }
    if (text === "commit") {
      snap = null;
      return [];
    }
    if (text === "rollback") {
      if (snap) {
        repos.length = 0;
        repos.push(...snap.repos);
        events.length = 0;
        events.push(...snap.events);
        writes = snap.writes;
      }
      snap = null;
      return [];
    }
    if (text.includes("pg_advisory_xact_lock")) return [];
    if (text.includes("insert into events")) {
      if (control.failReceipt) throw new Error("simulated events insert failure");
      const id = events.length + 1;
      const row = {
        id,
        kind: String(values[0]),
        title: String(values[1]),
        detail: String(values[2]),
      };
      events.push(row);
      return [{ id, kind: row.kind, created_at: "2026-10-29T12:00:00.000Z" }];
    }
    if (text.includes("insert into watched_repos")) {
      writes += 1;
      const names = values[0] as string[];
      const labels = values[1] as string[];
      const shorts = values[2] as string[];
      const colors = values[3] as string[];
      const blocked = values[4] as (string | null)[];
      const positions = values[5] as number[];
      const pinned = values[6] as boolean[];
      const hidden = values[7] as boolean[];
      const autos = repos.filter((row) => row.origin === "auto");
      repos.length = 0;
      names.forEach((name, i) => {
        repos.push({
          repo: name,
          label: labels[i],
          short: shorts[i],
          color: colors[i],
          blocked_label: blocked[i],
          position: positions[i],
          origin: "manual",
          pinned: pinned[i] === true,
          hidden: hidden[i] === true,
          gone: false,
          is_fork: false,
          is_archived: false,
          last_activity_at: null,
          fields_overridden: true,
        });
      });
      for (const row of autos) repos.push(row);
      return names.map((name) => ({ repo: name })) as Row[];
    }
    if (text.includes("from watched_repos")) return repos.map((row) => ({ ...row }));
    if (text.includes("from watched_owners")) return [];
    return [];
  });
  return {
    repos,
    events,
    control,
    writes: () => writes,
  };
}

describe("settings MCP tools", { concurrency: false }, () => {
  it("F1 an agent credential with every scope is forbidden; MC_TOKEN and OAuth are allowed", () => {
    const every = { kind: "agent" as const, id: "cred-all", scopes: [...SCOPES] };
    for (const name of ["get_settings", "set_watched_repos"]) {
      const denied = authorizeTool(every, name);
      assert.equal(denied.ok, false, name);
      if (!denied.ok) {
        assert.equal(denied.body.code, "insufficient_scope");
        assert.equal(denied.body.fix, "This route is not granted by any agent scope.");
      }
      assert.equal(authorizeTool({ kind: "legacy" }, name).ok, true, name);
      assert.equal(authorizeTool({ kind: "oauth", id: "oauth-client" }, name).ok, true, name);
      assert.equal(authorizeTool({ kind: "session" }, name).ok, true, name);
      const call = evaluateMcpMessages(every, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      assert.equal(call.ok, false, name);
      if (!call.ok) assert.equal(call.body.fix, "This route is not granted by any agent scope.");
      assert.equal(
        evaluateMcpMessages({ kind: "legacy" }, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }).ok,
        true,
        name,
      );
      assert.equal(
        evaluateMcpMessages({ kind: "oauth", id: "oauth-client" }, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }).ok,
        true,
        name,
      );
    }
  });

  it("F2 dry_run writes nothing and returns the diff plus the current version", async () => {
    openDemo();
    const before = await getSettingsTool();
    const beforeBody = JSON.parse(before.content[0].text) as { repos: { version: string; repos: { repo: string }[] } };
    const kept = REPOS[0];
    const next = [
      { ...kept, label: "Renamed" },
      repo("example-org/new-repo", "new", "New"),
    ];
    const eventsBefore = demoStoreSize().events;
    const result = await setWatchedReposTool({ repos: next, dry_run: true });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content[0].text.includes("receipt:"), false);
    const diff = JSON.parse(result.content[0].text) as {
      dry_run: true;
      applied: false;
      would_write: boolean;
      version: string;
      added: string[];
      removed: string[];
      changed: string[];
    };
    assert.equal(diff.dry_run, true);
    assert.equal(diff.applied, false);
    assert.equal(diff.would_write, false);
    assert.equal(diff.version, beforeBody.repos.version);
    assert.deepEqual(diff.added, ["example-org/new-repo"]);
    assert.ok(diff.removed.includes("example-org/web-studio"));
    assert.ok(diff.removed.includes("example-org/agent-harness"));
    assert.deepEqual(diff.changed, [kept.repo]);
    assert.equal(demoStoreSize().events, eventsBefore);
    const after = JSON.parse((await getSettingsTool()).content[0].text) as { repos: { version: string } };
    assert.equal(after.repos.version, beforeBody.repos.version);
  });

  it("F3 a real write without expected_version is validation_failed and writes nothing", async () => {
    openDemo();
    const eventsBefore = demoStoreSize().events;
    const missing = errorOf(await setWatchedReposTool({ repos: [repo("acme/app", "app", "App")] }));
    assert.equal(missing.code, "validation_failed");
    assert.match(missing.fields?.expected_version ?? "", /get_settings/);
    assert.equal(demoStoreSize().events, eventsBefore);

    const store = installRepoStore([memRepo("acme/old", "old")]);
    const again = errorOf(await runWithActor(actor, () => setWatchedReposTool({
      repos: [repo("acme/new", "new", "New")],
      dry_run: false,
    })));
    assert.equal(again.code, "validation_failed");
    assert.equal(store.writes(), 0);
    assert.equal(store.events.length, 0);
    assert.equal(store.repos[0]?.repo, "acme/old");
  });

  it("F4 a stale expected_version is stale and writes nothing", async () => {
    const store = installRepoStore([memRepo("acme/old", "old")]);
    const current = await readRepoSettings();
    const stale = errorOf(await runWithActor(actor, () => setWatchedReposTool({
      repos: [repo("acme/new", "new", "New")],
      expected_version: "not-the-version",
    })));
    const rest = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repos: [repo("acme/new", "new", "New")],
        version: "not-the-version",
      }),
    }));
    assert.equal(rest.status, 409);
    const restBody = await rest.json() as { code: string; error: string; fix: string };
    assert.equal(stale.code, "stale");
    assert.equal(stale.code, restBody.code);
    assert.equal(stale.error, restBody.error);
    assert.equal(stale.fix, restBody.fix);
    assert.equal(store.writes(), 0);
    assert.equal(store.events.length, 0);
    assert.equal(store.repos[0]?.repo, "acme/old");
    assert.notEqual(current.version, "not-the-version");
  });

  it("F5 a bad name and a case-only duplicate get the REST error and write nothing", async () => {
    openDemo();
    const cases = [
      { repos: [{ repo: "not a repo", label: "Bad", short: "bad", color: "#112233", blockedLabel: null }] },
      {
        repos: [
          repo("Acme/App", "one", "One"),
          repo("acme/app", "two", "Two"),
        ],
      },
    ];
    for (const body of cases) {
      const tool = errorOf(await setWatchedReposTool(body));
      const rest = await putRepos(new Request("http://localhost/api/settings/repos", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      assert.equal(rest.status, 400, JSON.stringify(tool));
      const restBody = await rest.json() as {
        code: string;
        error: string;
        fields?: Record<string, string>;
        errors?: { index: number; field: string; message: string }[];
      };
      assert.equal(tool.code, restBody.code);
      assert.equal(tool.error, restBody.error);
      assert.deepEqual(tool.fields, restBody.fields);
      assert.deepEqual(tool.errors, restBody.errors);
      assert.equal(demoStoreSize().events, 0);
    }
  });

  it("F6 a successful write emits one receipt, changes the list, and changes the version", async () => {
    const store = installRepoStore([memRepo("acme/old", "old")]);
    const before = await readRepoSettings();
    const result = await runWithActor(actor, () => setWatchedReposTool({
      repos: [repo("acme/new", "new", "New")],
      expected_version: before.version,
    }));
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const text = result.content[0].text;
    assert.equal(text.split("receipt:").length - 1, 1);
    assert.match(text, /actor_type=agent actor_id=mc-token/);
    const receipt = (result.structuredContent as { receipt?: { id: string; kind: string; at: string } } | undefined)?.receipt;
    assert.ok(receipt);
    assert.equal(receipt.kind, "set_watched_repos");
    assert.equal(receipt.id, "1");
    assert.equal(store.writes(), 1);
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0]?.kind, "set_watched_repos");
    const detail = JSON.parse(store.events[0]?.detail ?? "{}") as {
      actor_type?: string;
      actor_id?: string;
      tool?: string;
      version?: string;
    };
    assert.equal(detail.actor_type, "agent");
    assert.equal(detail.actor_id, "mc-token");
    assert.equal(detail.tool, "set_watched_repos");
    const after = await readRepoSettings();
    assert.equal(detail.version, after.version);
    assert.notEqual(after.version, before.version);
    assert.deepEqual(after.repos.map((row) => row.repo), ["acme/new"]);
    assert.equal(store.repos[0]?.repo, "acme/new");
  });

  it("F7 demo mode matches the REST settings reads and the refused save", async () => {
    openDemo();
    const tool = JSON.parse((await getSettingsTool()).content[0].text) as {
      repos: unknown;
      owners: unknown;
    };
    const reposRes = await getRepos(new Request("http://localhost/api/settings/repos"));
    const ownersRes = await getOwners(new Request("http://localhost/api/settings/owners"));
    assert.equal(reposRes.status, 200);
    assert.equal(ownersRes.status, 200);
    assert.deepEqual(tool.repos, await reposRes.json());
    assert.deepEqual(tool.owners, await ownersRes.json());
    assert.equal((tool.repos as { source?: string }).source, "file");
    assert.equal((tool.owners as { writable?: boolean }).writable, false);

    const payload = { repos: [repo("acme/demo", "demo", "Demo")], expected_version: "not-the-version" };
    const refused = errorOf(await setWatchedReposTool(payload));
    const rest = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: payload.repos, version: payload.expected_version }),
    }));
    assert.equal(rest.status, 409);
    const restBody = await rest.json() as { code: string; error: string; fix: string };
    assert.equal(refused.code, "conflict");
    assert.equal(refused.code, restBody.code);
    assert.equal(refused.error, restBody.error);
    assert.equal(refused.fix, restBody.fix);
    assert.equal(demoStoreSize().events, 0);
    const still = JSON.parse((await getSettingsTool()).content[0].text) as { repos: { source: string } };
    assert.equal(still.repos.source, "file");
  });

  it("F8 tool names stay in order and the two settings tools are appended", () => {
    const src = fs.readFileSync("src/app/api/[transport]/route.ts", "utf8");
    const names = [...src.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(names.slice(-3), ["list_activity", "get_settings", "set_watched_repos"]);
    assert.equal(names.indexOf("get_settings"), names.indexOf("list_activity") + 1);
    assert.equal(names.indexOf("set_watched_repos"), names.indexOf("get_settings") + 1);
    assert.equal(src.match(/server\.registerTool\(/g)?.length, 24);
    assert.match(src, /title: "Get settings",\n\s+annotations: READ_ONLY,/);
    assert.match(src, /title: "Set watched repos",\n\s+annotations: WRITE_DESTRUCTIVE,/);
    const calls = src.match(/server\.registerTool\(/g)?.length ?? 0;
    const annotated = src.match(/^\s+annotations: (READ_ONLY|WRITE|WRITE_IDEMPOTENT|WRITE_DESTRUCTIVE),$/gm)?.length ?? 0;
    assert.equal(annotated, calls);
  });

  it("F9 a failed receipt insert rolls the repo replace back", async () => {
    const store = installRepoStore([memRepo("acme/old", "old")]);
    store.control.failReceipt = true;
    const before = await readRepoSettings();
    await assert.rejects(
      () => runWithActor(actor, () => setWatchedReposTool({
        repos: [repo("acme/new", "new", "New")],
        expected_version: before.version,
      })),
      /simulated events insert failure/,
    );
    assert.equal(store.writes(), 0);
    assert.equal(store.events.length, 0);
    assert.equal(store.repos[0]?.repo, "acme/old");
    const still = await readRepoSettings();
    assert.equal(still.version, before.version);
    assert.deepEqual(still.repos.map((row) => row.repo), ["acme/old"]);
  });

  it("F10 a stale replace that was asked for a receipt inserts nothing", async () => {
    const store = installRepoStore([memRepo("acme/old", "old")]);
    const saved = await replaceWatchedRepos(
      [repo("acme/new", "new", "New")],
      "not-the-version",
      { kind: "set_watched_repos", title: "Watched repos replaced" },
    );
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.reason, "stale");
    assert.equal(store.events.length, 0);
    assert.equal(store.writes(), 0);
    assert.equal(store.repos[0]?.repo, "acme/old");
  });

  it("F11 an empty configured database versions the stored rows and a dry run diffs against empty", async () => {
    const store = installRepoStore([]);
    const body = await readRepoSettings();
    assert.equal(body.source, "file");
    assert.equal(body.writable, true);
    assert.equal(body.version, "4f53cda18c2baa0c");
    assert.equal(body.version, listVersion([]));
    assert.notEqual(body.version, listVersion(body.repos));
    assert.ok(body.repos.length > 0);
    assert.deepEqual(body.repos.map((row) => row.repo), REPOS.map((row) => row.repo));

    const tool = JSON.parse((await getSettingsTool()).content[0].text) as {
      repos: { version: string; source: string };
    };
    assert.equal(tool.repos.version, body.version);
    assert.equal(tool.repos.source, "file");

    const next = [repo("acme/from-empty", "empty", "Empty")];
    const preview = await setWatchedReposTool({ repos: next, dry_run: true });
    assert.equal(preview.isError, undefined, preview.content[0]?.text);
    const diff = JSON.parse(preview.content[0].text) as {
      source?: string;
      version: string;
      added: string[];
      removed: string[];
      would_write: boolean;
    };
    assert.equal(diff.source, "file");
    assert.equal(diff.version, body.version);
    assert.deepEqual(diff.added, ["acme/from-empty"]);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.would_write, true);
    assert.equal(store.writes(), 0);
    assert.equal(store.events.length, 0);

    const restPreview = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repos: next, version: body.version, dry_run: true }),
    }));
    assert.equal(restPreview.status, 200);
    const restDiff = await restPreview.json() as {
      source?: string;
      would_write: boolean;
      changes: { op: string }[];
    };
    assert.equal(restDiff.source, "file");
    assert.equal(restDiff.would_write, true);
    assert.equal(restDiff.changes.some((change) => change.op === "remove"), false);
    assert.equal(restDiff.changes.some((change) => change.op === "add"), true);
    assert.equal(store.writes(), 0);

    const saved = await runWithActor(actor, () => setWatchedReposTool({
      repos: next,
      expected_version: body.version,
    }));
    assert.equal(saved.isError, undefined, saved.content[0]?.text);
    assert.equal(store.writes(), 1);
    assert.equal(store.events.length, 1);
    const after = await readRepoSettings();
    assert.equal(after.source, "database");
    assert.deepEqual(after.repos.map((row) => row.repo), ["acme/from-empty"]);
    const detail = JSON.parse(store.events[0]?.detail ?? "{}") as { version?: string };
    assert.equal(detail.version, after.version);
    assert.notEqual(after.version, body.version);
  });

  it("F12 REST GET then PUT uses the empty stored version and saves", async () => {
    const store = installRepoStore([]);
    const got = await getRepos(new Request("http://localhost/api/settings/repos"));
    assert.equal(got.status, 200);
    const body = await got.json() as { source: string; version: string; repos: { repo: string }[] };
    assert.equal(body.source, "file");
    assert.equal(body.version, "4f53cda18c2baa0c");
    assert.ok(body.repos.length > 0);
    const put = await putRepos(new Request("http://localhost/api/settings/repos", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repos: [repo("acme/rest", "rest", "Rest")],
        version: body.version,
      }),
    }));
    const raw = await put.text();
    assert.equal(put.status, 200, raw);
    const saved = JSON.parse(raw) as { source: string; version: string; repos: { repo: string }[] };
    assert.equal(saved.source, "database");
    assert.deepEqual(saved.repos.map((row) => row.repo), ["acme/rest"]);
    assert.notEqual(saved.version, body.version);
    assert.equal(store.events.length, 0);
    assert.equal(store.writes(), 1);
  });

  it("F13 a populated database keeps the pre-change list version", async () => {
    const row = memRepo("acme/kept", "kept");
    row.label = "Kept";
    row.color = "#abcdef";
    row.blocked_label = "wait";
    row.pinned = true;
    row.hidden = false;
    row.origin = "auto";
    row.fields_overridden = true;
    installRepoStore([row]);
    const body = await readRepoSettings();
    assert.equal(body.source, "database");
    assert.equal(body.version, "fc16e23e1910c991");
    assert.equal(body.version, listVersion(body.repos));
    const tool = JSON.parse((await getSettingsTool()).content[0].text) as { repos: { version: string } };
    assert.equal(tool.repos.version, "fc16e23e1910c991");
    const rest = await getRepos(new Request("http://localhost/api/settings/repos"));
    assert.equal(rest.status, 200);
    assert.equal((await rest.json() as { version: string }).version, "fc16e23e1910c991");
  });
});
