import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { openApiDocument } from "../../src/lib/openapi";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { authorizeRoute, authorizeTool, scopeForRoute } from "../../src/lib/scopes";
import { callsOf, installSkillsSql, skillsMemory, type MemSkill } from "./skills-memory";

const NOW = "2026-10-27T12:00:00.000Z";
const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  password: env.MC_DASHBOARD_PASSWORD,
  stall: env.AK_SKILL_STALL_MINUTES,
  node: env.NODE_ENV,
};

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["AK_SKILL_STALL_MINUTES", saved.stall],
    ["NODE_ENV", saved.node],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function skill(partial: Partial<MemSkill> & Pick<MemSkill, "id">): MemSkill {
  return {
    source_id: "master-skills",
    path: `skills/${partial.id}/SKILL.md`,
    name: partial.name ?? partial.id,
    description: partial.description ?? `${partial.id} description`,
    version: partial.version ?? "1.0.0",
    sha: partial.sha ?? `${partial.id}`.padEnd(64, "a").slice(0, 64),
    commit_sha: partial.commit_sha ?? "c".repeat(40),
    body: partial.body ?? `${partial.id} body`,
    references: partial.references ?? [],
    runtimes: partial.runtimes ?? { claude: true, codex: true, grok: true, hermes: true, mini: true },
    frontmatter: partial.frontmatter ?? {},
    removed_at: partial.removed_at ?? null,
    synced_at: partial.synced_at ?? NOW,
    ...partial,
    id: partial.id,
    category: partial.category ?? null,
    tags: partial.tags ?? [],
  };
}

async function issue(scopes: string[]) {
  const created = await createCredential({ label: "skills lane", scopes });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("credential");
  return created.token;
}

describe("skills routes", { concurrency: false }, () => {
  beforeEach(() => {
    delete env.DATABASE_URL;
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.MC_TOKEN;
    delete env.AK_SKILL_STALL_MINUTES;
    env.NODE_ENV = "test";
    resetCredentialsForTests();
    setSqlForTests(null);
    setSkillNowForTests(null);
  });

  afterEach(() => {
    setSqlForTests(null);
    setSkillNowForTests(null);
    resetCredentialsForTests();
    restoreEnv();
  });

  describe("demo mode and agent scope", () => {
    it("serves the fixture list and rejects an unknown runtime before the fixture", async () => {
      const { GET } = await import("../../src/app/api/skills/route");
      const { GET: GET_ID, PATCH } = await import("../../src/app/api/skills/[id]/route");
      const bad = await GET(new Request("http://localhost/api/skills?runtime=claude-code"));
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).code, "validation_failed");

      const listed = await GET(new Request("http://localhost/api/skills?q=House"));
      assert.equal(listed.status, 200);
      const body = await listed.json() as {
        demo: boolean;
        upstream: { source: string; sha: string; driftCount: number };
        skills: { id: string; runtimes: string[]; description: string }[];
      };
      assert.equal(body.demo, true);
      assert.equal(body.upstream.source, "master-skills");
      assert.equal(body.upstream.driftCount, 2);
      assert.deepEqual(body.skills.map((row) => row.id), ["operator-voice"]);
      assert.ok(Array.isArray(body.skills[0]?.runtimes));

      const codex = await GET(new Request("http://localhost/api/skills?runtime=codex"));
      const codexIds = ((await codex.json()) as { skills: { id: string }[] }).skills.map((row) => row.id);
      assert.deepEqual(codexIds, ["verify-gibson", "spec-writer"]);

      const writing = await GET(new Request("http://localhost/api/skills?category=WRITING"));
      const writingSkills = ((await writing.json()) as { skills: { id: string; category: string | null; tags: string[] }[] }).skills;
      assert.deepEqual(writingSkills.map((row) => row.id), ["operator-voice"]);
      assert.equal(writingSkills[0]?.category, "Writing");
      assert.deepEqual(writingSkills[0]?.tags, ["voice"]);
      const uncategorized = await GET(new Request("http://localhost/api/skills?category=uncategorized"));
      assert.deepEqual(
        ((await uncategorized.json()) as { skills: { id: string }[] }).skills.map((row) => row.id),
        ["verify-gibson"],
      );

      const detail = await GET_ID(new Request("http://localhost/api/skills/verify-gibson"), {
        params: Promise.resolve({ id: "verify-gibson" }),
      });
      const item = await detail.json() as { runtimes: unknown; triggers: { status: string }[]; references: { path: string }[] };
      assert.equal(Array.isArray(item.runtimes), false);
      assert.equal((item.runtimes as { claude: boolean }).claude, true);
      assert.equal(item.triggers[1]?.status, "stalled");
      assert.deepEqual(item.references.map((ref) => ref.path), ["playbook.md", "checks.sh"]);

      const missing = await GET_ID(new Request("http://localhost/api/skills/nope"), {
        params: Promise.resolve({ id: "nope" }),
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).code, "not_found");

      const patched = await PATCH(new Request("http://localhost/api/skills/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trigger: "on_request" }),
      }), { params: Promise.resolve({ id: "nope" }) });
      const patchedBody = await patched.json() as { ok: boolean; demo: boolean; note: string };
      assert.equal(patched.status, 200);
      assert.equal(patchedBody.demo, true);
      assert.match(patchedBody.note, /DATABASE_URL not set/);

      const empty = await PATCH(new Request("http://localhost/api/skills/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }), { params: Promise.resolve({ id: "nope" }) });
      assert.equal(empty.status, 400);
    });

    it("denies agent credentials on operator routes and requires skills:read to list", async () => {
      const { GET } = await import("../../src/app/api/skills/route");
      const { PATCH } = await import("../../src/app/api/skills/[id]/route");
      const { POST: SYNC } = await import("../../src/app/api/skills/sync/route");
      const { POST: DRIFT } = await import("../../src/app/api/skills/drift/route");
      const reader = await issue(["skills:read"]);
      const writer = await issue(["skills:write"]);
      const both = await issue(["skills:read", "skills:write"]);
      const none = await issue(["fleet:read"]);

      assert.equal(scopeForRoute("GET", "/api/skills"), "skills:read");
      assert.equal(scopeForRoute("GET", "/api/skills/verify-gibson"), "skills:read");
      assert.equal(scopeForRoute("GET", "/api/skills/sync"), null);
      assert.equal(scopeForRoute("GET", "/api/skills/drift"), null);
      assert.equal(scopeForRoute("PATCH", "/api/skills/verify-gibson"), null);
      assert.equal(scopeForRoute("POST", "/api/skills/sync"), null);
      assert.equal(scopeForRoute("POST", "/api/skills/drift"), null);

      const listed = await GET(new Request("http://localhost/api/skills", { headers: { authorization: `Bearer ${reader}` } }));
      assert.equal(listed.status, 200);
      const denied = await GET(new Request("http://localhost/api/skills", { headers: { authorization: `Bearer ${none}` } }));
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "insufficient_scope");
      const writerGet = await GET(new Request("http://localhost/api/skills", { headers: { authorization: `Bearer ${writer}` } }));
      assert.equal(writerGet.status, 403);

      const patch = await PATCH(new Request("http://localhost/api/skills/verify-gibson", {
        method: "PATCH",
        headers: { authorization: `Bearer ${both}`, "content-type": "application/json" },
        body: JSON.stringify({ trigger: "on_request" }),
      }), { params: Promise.resolve({ id: "verify-gibson" }) });
      assert.equal(patch.status, 403);

      const sync = await SYNC(new Request("http://localhost/api/skills/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${writer}`, "content-type": "application/json" },
        body: JSON.stringify({ trigger: "scheduled" }),
      }));
      assert.equal(sync.status, 403);

      const drift = await DRIFT(new Request("http://localhost/api/skills/drift", {
        method: "POST",
        headers: { authorization: `Bearer ${both}`, "content-type": "application/json" },
        body: JSON.stringify({ host: "lane-host", dir: "~/.codex/skills", skills: [] }),
      }));
      assert.equal(drift.status, 403);

      env.MC_TOKEN = "test-mc-token";
      const scheduled = await SYNC(new Request("http://localhost/api/skills/sync", {
        method: "POST",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json" },
        body: JSON.stringify({ trigger: "scheduled" }),
      }));
      const scheduledBody = await scheduled.json() as { ok?: boolean; demo?: boolean; status?: string; note?: string };
      assert.equal(scheduled.status, 200);
      assert.equal(scheduledBody.demo, true);
      assert.equal(scheduledBody.status, undefined);
      assert.match(scheduledBody.note ?? "", /sync not run/);

      const driftDemo = await DRIFT(new Request("http://localhost/api/skills/drift", {
        method: "POST",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json" },
        body: JSON.stringify({ host: "lane-host", dir: "~/.codex/skills", skills: [] }),
      }));
      const driftBody = await driftDemo.json() as { note?: string };
      assert.match(driftBody.note ?? "", /drift report not stored/);

      const badDir = await DRIFT(new Request("http://localhost/api/skills/drift", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "lane-host", dir: "/tmp/skills", skills: [] }),
      }));
      assert.equal(badDir.status, 400);

      const agent = { kind: "agent" as const, id: "cred", scopes: ["skills:read"] };
      assert.equal(authorizeTool(agent, "list_skills").ok, true);
      assert.equal(authorizeTool(agent, "get_skill").ok, true);
      assert.equal(authorizeTool(agent, "run_skill").ok, false);
      assert.equal(authorizeTool({ kind: "agent", id: "cred", scopes: ["skills:write"] }, "run_skill").ok, true);
      assert.equal(authorizeTool({ kind: "agent", id: "cred", scopes: ["skills:write"] }, "list_skills").ok, false);
      assert.equal(authorizeRoute({ kind: "agent", id: "cred", scopes: ["skills:write"] }, "POST", "/api/skills/sync").ok, false);
      assert.equal(authorizeRoute({ kind: "legacy" }, "POST", "/api/skills/drift").ok, true);
    });
  });

  describe("live list, detail, settings, and drift", () => {
    beforeEach(() => {
      installSkillsSql();
      setSkillNowForTests(() => new Date(NOW));
      env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_test";
      env.MC_TOKEN = "test-mc-token";
      env.AK_SKILL_STALL_MINUTES = "60";
    });

    it("filters by category, including uncategorized, and returns tags on the detail", async () => {
      const { GET } = await import("../../src/app/api/skills/route");
      const { GET: GET_ID } = await import("../../src/app/api/skills/[id]/route");
      skillsMemory.skills.push(
        skill({ id: "labeled", description: "Has a category", category: "Engineering Tools", tags: ["fleet", "voice"] }),
        skill({ id: "plain", description: "No category" }),
        skill({ id: "same-word", description: "The word itself", category: "Uncategorized", tags: ["meta"] }),
      );
      const engineering = await GET(new Request("http://localhost/api/skills?category=engineering%20tools"));
      const engineeringSkills = ((await engineering.json()) as { skills: { id: string; category: string | null; tags: string[] }[] }).skills;
      assert.deepEqual(engineeringSkills.map((row) => row.id), ["labeled"]);
      assert.equal(engineeringSkills[0]?.category, "Engineering Tools");
      assert.deepEqual(engineeringSkills[0]?.tags, ["fleet", "voice"]);

      const open = await GET(new Request("http://localhost/api/skills?category=uncategorized"));
      assert.deepEqual(
        ((await open.json()) as { skills: { id: string }[] }).skills.map((row) => row.id),
        ["plain", "same-word"],
      );

      const detail = await GET_ID(new Request("http://localhost/api/skills/labeled"), {
        params: Promise.resolve({ id: "labeled" }),
      });
      const item = await detail.json() as { category: string | null; tags: string[] };
      assert.equal(item.category, "Engineering Tools");
      assert.deepEqual(item.tags, ["fleet", "voice"]);
    });

    it("filters by runtime and query, and counts runs in one grouped query", async () => {
      const { GET } = await import("../../src/app/api/skills/route");
      skillsMemory.skills.push(
        skill({ id: "alpha", description: "Alpha work", runtimes: { claude: true, codex: false, grok: false, hermes: false, mini: false } }),
        skill({ id: "beta", description: "Beta work", runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true } }),
        skill({ id: "gone", removed_at: NOW }),
      );
      skillsMemory.runs.push({
        run_id: "00000000-0000-4000-8000-000000000010",
        skill_id: "beta",
        skill_sha: "b".repeat(64),
        agent_id: "old-agent",
        lane: null,
        runtime: "grok",
        started_at: "2026-10-01T12:00:00.000Z",
        ended_at: "2026-10-01T12:05:00.000Z",
        status: "done",
        note: null,
        actor_type: "agent",
        actor_id: "mc-token",
      });
      skillsMemory.calls.length = 0;
      const listed = await GET(new Request("http://localhost/api/skills?runtime=claude&q=beta"));
      assert.equal(listed.status, 200);
      const body = await listed.json() as {
        demo: boolean;
        skills: { id: string; runtimes: string[]; triggerCount7d: number; lastRun: { agent: string } | null; trigger: string }[];
      };
      assert.equal(body.demo, false);
      assert.deepEqual(body.skills.map((row) => row.id), ["beta"]);
      assert.ok(Array.isArray(body.skills[0]?.runtimes));
      assert.equal(body.skills[0]?.triggerCount7d, 0);
      assert.equal(body.skills[0]?.lastRun?.agent, "old-agent");
      assert.equal(body.skills[0]?.trigger, "off");
      assert.equal(callsOf("sk:run-stats"), 1);
      assert.equal(body.skills.some((row) => row.id === "gone"), false);
    });

    it("maps running, stalled, and ended runs, and caps triggers at 50", async () => {
      const { GET } = await import("../../src/app/api/skills/[id]/route");
      skillsMemory.skills.push(skill({
        id: "alpha",
        references: [{ path: "notes.md", content: "secret-body" }],
        runtimes: { claude: false, codex: false, grok: true, hermes: false, mini: false },
      }));
      skillsMemory.runs.push(
        {
          run_id: "00000000-0000-4000-8000-000000000001",
          skill_id: "alpha",
          skill_sha: "a".repeat(64),
          agent_id: "agent-done",
          lane: "conference-os",
          runtime: "grok",
          started_at: "2026-10-27T08:00:00.000Z",
          ended_at: "2026-10-27T08:10:00.000Z",
          status: "failed",
          note: "nope",
          actor_type: "agent",
          actor_id: "mc-token",
        },
        {
          run_id: "00000000-0000-4000-8000-000000000002",
          skill_id: "alpha",
          skill_sha: "a".repeat(64),
          agent_id: "agent-stall",
          lane: null,
          runtime: "grok",
          started_at: "2026-10-27T10:00:00.000Z",
          ended_at: null,
          status: "running",
          note: null,
          actor_type: "agent",
          actor_id: "mc-token",
        },
        {
          run_id: "00000000-0000-4000-8000-000000000003",
          skill_id: "alpha",
          skill_sha: "a".repeat(64),
          agent_id: "agent-live",
          lane: "chatterbuilt",
          runtime: "grok",
          started_at: "2026-10-27T11:30:00.000Z",
          ended_at: null,
          status: "running",
          note: null,
          actor_type: "agent",
          actor_id: "mc-token",
        },
      );
      for (let i = 0; i < 48; i += 1) {
        skillsMemory.runs.push({
          run_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          skill_id: "alpha",
          skill_sha: "a".repeat(64),
          agent_id: "pad",
          lane: null,
          runtime: "grok",
          started_at: `2026-10-20T12:00:${String(i).padStart(2, "0")}.000Z`,
          ended_at: null,
          status: "running",
          note: null,
          actor_type: "agent",
          actor_id: "mc-token",
        });
      }
      const res = await GET(new Request("http://localhost/api/skills/alpha"), { params: Promise.resolve({ id: "alpha" }) });
      const body = await res.json() as {
        runtimes: Record<string, boolean>;
        references: { path: string; content?: string }[];
        body: string;
        triggers: { status: string; outcome: string | null; agent: string }[];
      };
      assert.equal(body.runtimes.grok, true);
      assert.equal(body.runtimes.claude, false);
      assert.deepEqual(body.references, [{ path: "notes.md" }]);
      assert.equal(body.body.includes("secret-body"), false);
      assert.equal(body.triggers.length, 50);
      const byAgent = new Map(body.triggers.map((row) => [row.agent, row]));
      assert.equal(byAgent.get("agent-done")?.status, "done");
      assert.equal(byAgent.get("agent-done")?.outcome, "failed");
      assert.equal(byAgent.get("agent-stall")?.status, "stalled");
      assert.equal(byAgent.get("agent-stall")?.outcome, null);
      assert.equal(byAgent.get("agent-live")?.status, "running");
      assert.equal(skillsMemory.runs.find((row) => row.agent_id === "agent-stall")?.status, "running");
      const newest = body.triggers[0];
      assert.equal(newest?.agent, "agent-live");
    });

    it("records the actor and warns when every runtime is false", async () => {
      const { PATCH } = await import("../../src/app/api/skills/[id]/route");
      skillsMemory.skills.push(skill({
        id: "silent",
        runtimes: { claude: false, codex: false, grok: false, hermes: false, mini: false },
      }));
      const missing = await PATCH(new Request("http://localhost/api/skills/missing", {
        method: "PATCH",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json" },
        body: JSON.stringify({ trigger: "on_request" }),
      }), { params: Promise.resolve({ id: "missing" }) });
      assert.equal(missing.status, 404);

      const saved = await PATCH(new Request("http://localhost/api/skills/silent", {
        method: "PATCH",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json" },
        body: JSON.stringify({ trigger: "on_request", scope: { mode: "selected", lanes: ["conference-os"] } }),
      }), { params: Promise.resolve({ id: "silent" }) });
      assert.equal(saved.status, 200);
      const body = await saved.json() as { trigger: string; warnings?: string[]; scope: { lanes: string[] } };
      assert.equal(body.trigger, "on_request");
      assert.deepEqual(body.scope.lanes, ["conference-os"]);
      assert.ok((body.warnings ?? []).length > 0);
      assert.equal(skillsMemory.settings[0]?.updated_by, "agent:mc-token");
      assert.equal(skillsMemory.settings[0]?.schedule, null);
    });

    it("stores a drift report and counts a repeated name once on the list", async () => {
      const { POST } = await import("../../src/app/api/skills/drift/route");
      const { GET } = await import("../../src/app/api/skills/route");
      const sha = "ab".repeat(32);
      skillsMemory.skills.push(skill({ id: "alpha", sha }));
      const first = await POST(new Request("http://localhost/api/skills/drift", {
        method: "POST",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json" },
        body: JSON.stringify({ host: "host-a", dir: "~/.codex/skills", skills: [] }),
      }));
      const firstBody = await first.json() as { ok: boolean; host: string; missing: { name: string }[]; driftCount: number };
      assert.equal(firstBody.ok, true);
      assert.equal(firstBody.host, "host-a");
      assert.deepEqual(firstBody.missing.map((row) => row.name), ["alpha"]);
      assert.equal(firstBody.driftCount, 1);

      await POST(new Request("http://localhost/api/skills/drift", {
        method: "POST",
        headers: { authorization: "Bearer test-mc-token", "content-type": "application/json" },
        body: JSON.stringify({ host: "host-b", dir: "~/.agents/skills", skills: [{ name: "alpha", sha: "cd".repeat(32) }] }),
      }));
      const listed = await GET(new Request("http://localhost/api/skills"));
      const upstream = (await listed.json() as { upstream: { driftCount: number } }).upstream;
      assert.equal(upstream.driftCount, 1);
    });
  });
});

describe("skills contract files", () => {
  it("documents the routes in OpenAPI and the tables in schema.sql", () => {
    const doc = openApiDocument() as { paths: Record<string, { get?: unknown; post?: unknown; patch?: unknown }> };
    assert.ok(doc.paths["/api/skills"]?.get);
    assert.ok(doc.paths["/api/skills/sync"]?.post);
    assert.ok(doc.paths["/api/skills/drift"]?.post);
    assert.ok(doc.paths["/api/skills/{id}"]?.get);
    assert.ok(doc.paths["/api/skills/{id}"]?.patch);
    const schema = fs.readFileSync("supabase/schema.sql", "utf8");
    const migration = fs.readFileSync("supabase/migrations/20261027_skills.sql", "utf8");
    for (const table of ["skill_sources", "skills", "skill_settings", "skill_runs", "skill_sync_runs", "skill_drift"]) {
      assert.match(schema, new RegExp(`create table if not exists ${table}`));
      assert.match(migration, new RegExp(`create table if not exists ${table}`));
    }
    assert.match(schema, /on conflict \(id\) do nothing/);
    assert.match(schema, /skill_sync_one_running_idx/);
    assert.match(schema, /char_length\(note\) <= 500/);
    const docs = fs.readFileSync("docs/MCP.md", "utf8");
    assert.match(docs, /first 7 hex characters/);
    assert.match(docs, /Any other `dir` is HTTP 400/);
    assert.match(docs, /same name on two hosts counts once/);
    assert.match(docs, /Nothing in this change runs that cron/);
    assert.match(docs, /does not store prompts/);
    assert.match(docs, /DATABASE_URL not set; skill run not stored/);
    assert.match(docs, /events\.agent_id/);
    assert.match(docs, /3 declare `runtimes`/);
    assert.match(docs, /uncategorized/);
    assert.match(schema, /category text/);
    assert.match(schema, /tags jsonb not null default '\[\]'::jsonb/);
    assert.match(schema, /add column if not exists category text/);
    const labels = fs.readFileSync("supabase/migrations/20261027_skills_labels.sql", "utf8");
    assert.match(labels, /add column if not exists category text/);
    assert.match(labels, /add column if not exists tags jsonb/);
    const list = doc.paths["/api/skills"]?.get as { parameters?: { name?: string }[] };
    assert.equal(list.parameters?.some((param) => param.name === "category"), true);
  });
});
