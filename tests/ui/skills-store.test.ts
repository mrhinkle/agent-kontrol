import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { runWithActor } from "../../src/lib/actor";
import { callsOf, installSkillsSql, skillsMemory } from "./skills-memory";
import { setSkillNowForTests } from "../../src/lib/skills/clock";
import { skillsDigest } from "../../src/lib/skills/digest";
import { recordDrift } from "../../src/lib/skills/drift-report";
import { listSkillsTool, getSkillTool, runSkillTool } from "../../src/lib/skills/mcp";
import { getSkillDetail, listSkillViews, patchSkillSettings } from "../../src/lib/skills/query";
import { renderLaneSkillPointers } from "../../src/lib/skills/inject";
import { finishSkillRun, startSkillRun } from "../../src/lib/skills/runs";
import { syncSkills } from "../../src/lib/skills/sync";
import type { SkillSnapshot, SkillSnapshotFetcher } from "../../src/lib/skills/source";
import { progress } from "../../src/lib/progress-store";
import { GET as listRoute } from "../../src/app/api/skills/route";
import { GET as detailRoute, PATCH as patchRoute } from "../../src/app/api/skills/[id]/route";
import { POST as syncRoute } from "../../src/app/api/skills/sync/route";
import { POST as driftRoute } from "../../src/app/api/skills/drift/route";
const NOW = "2026-10-27T12:00:00.000Z";
const ACTOR = { actor_type: "agent" as const, actor_id: "lane-a" };
const env = process.env as Record<string, string | undefined>;
const saved = {
  token: env.MC_TOKEN,
  db: env.DATABASE_URL,
  node: env.NODE_ENV,
  password: env.MC_DASHBOARD_PASSWORD,
  stall: env.AK_SKILL_STALL_MINUTES,
  dirs: env.AK_SKILL_DRIFT_DIRS,
};

function restoreEnv() {
  for (const [key, value] of [
    ["MC_TOKEN", saved.token],
    ["DATABASE_URL", saved.db],
    ["NODE_ENV", saved.node],
    ["MC_DASHBOARD_PASSWORD", saved.password],
    ["AK_SKILL_STALL_MINUTES", saved.stall],
    ["AK_SKILL_DRIFT_DIRS", saved.dirs],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function skillFile(dir: string, body: string, front = ""): { path: string; content: string } {
  return {
    path: `${dir}/SKILL.md`,
    content: `---\nname: ${dir.split("/").pop()}\ndescription: ${body}\nversion: "1.0.0"\n${front}---\n${body}\n`,
  };
}

function emptySnap(commit = "b".repeat(40)): SkillSnapshot {
  return { commit_sha: commit, files: [], skipped: [], preserved_dirs: [] };
}

function fetcher(files: Record<string, SkillSnapshot | Error>): SkillSnapshotFetcher {
  return {
    async fetch(source) {
      const hit = files[source.id];
      if (!hit) return emptySnap();
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
}

beforeEach(() => {
  installSkillsSql();
  setSkillNowForTests(() => new Date(NOW));
  env.DATABASE_URL = "postgres://unit-test.example/ak";
  env.NODE_ENV = "test";
  env.MC_TOKEN = "unit-test-token";
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.AK_SKILL_STALL_MINUTES;
  delete env.AK_SKILL_DRIFT_DIRS;
  resetCredentialsForTests();
});

afterEach(() => {
  setSqlForTests(null);
  setSkillNowForTests(null);
  resetCredentialsForTests();
  restoreEnv();
});

describe("skill sync", { concurrency: false }, () => {
  it("adds, changes, no-ops, and removes only after a successful fetch", async () => {
    const commit = "a".repeat(40);
    const first = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap(commit), files: [skillFile("skills/alpha", "Alpha body")] },
      }),
    });
    assert.equal(first.status, "ok");
    assert.deepEqual(first.added.map((row) => row.id), ["alpha"]);
    assert.equal(first.removed.length, 0);
    assert.equal(first.upstream.source, "master-skills");
    assert.equal(first.upstream.sha, commit);
    const writes = callsOf("sk:upsert-skill");

    const again = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap(commit), files: [skillFile("skills/alpha", "Alpha body")] },
      }),
    });
    assert.equal(again.status, "ok");
    assert.deepEqual(again.added, []);
    assert.deepEqual(again.changed, []);
    assert.deepEqual(again.removed, []);
    assert.equal(callsOf("sk:upsert-skill"), writes);

    const changed = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": {
          ...emptySnap("c".repeat(40)),
          files: [skillFile("skills/alpha", "Alpha body"), { path: "skills/alpha/notes.md", content: "note" }],
        },
      }),
    });
    assert.deepEqual(changed.changed.map((row) => row.id), ["alpha"]);
    assert.equal(changed.added.length, 0);

    const gone = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({ "master-skills": emptySnap("d".repeat(40)) }),
    });
    assert.deepEqual(gone.removed, ["alpha"]);
    assert.equal(skillsMemory.skills[0]?.removed_at, NOW);
  });

  it("keeps rows when a fetch fails and does not report them as removed", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap("a".repeat(40)), files: [skillFile("skills/alpha", "Alpha body")] },
      }),
    });
    const failed = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({ "master-skills": new Error("GitHub request failed with status 404") }),
    });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.removed, []);
    assert.equal(skillsMemory.skills[0]?.removed_at, null);
    assert.match(failed.errors.map((item) => item.message).join("\n"), /404/);
    assert.equal(failed.upstream.sha, "a".repeat(40));
  });

  it("keeps the earlier source on an id collision and stores malformed frontmatter as claude-only", async () => {
    const broken = "---\nname: broken\n\tdescription: tabs\n---\nbody\n";
    const result = await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap("a".repeat(40)), files: [skillFile("skills/shared", "from master"), { path: "skills/broken/SKILL.md", content: broken }] },
        "the-gibson": { ...emptySnap("e".repeat(40)), files: [skillFile("skills/shared", "from gibson")] },
      }),
    });
    assert.equal(result.status, "failed");
    const shared = skillsMemory.skills.find((row) => row.id === "shared");
    assert.equal(shared?.source_id, "master-skills");
    assert.match(shared?.body ?? "", /from master/);
    assert.equal(result.conflicts.some((item) => item.id === "shared" && item.kept_source === "master-skills"), true);
    const row = skillsMemory.skills.find((item) => item.id === "broken");
    assert.equal(row?.runtimes.claude, true);
    assert.equal(row?.runtimes.codex, false);
    assert.match(result.errors.map((item) => item.message).join("\n"), /tabs/);
  });

  it("returns busy when a sync lease is already running", async () => {
    skillsMemory.syncRuns.push({
      id: "11111111-1111-4111-8111-111111111111",
      started_at: NOW,
      finished_at: null,
      trigger: "manual",
      status: "running",
      summary: null,
      error: null,
    });
    let fetched = 0;
    const result = await syncSkills({
      trigger: "manual",
      fetcher: {
        async fetch() {
          fetched += 1;
          return emptySnap();
        },
      },
    });
    assert.equal(result.status, "busy");
    assert.equal(fetched, 0);
    assert.equal(skillsMemory.skills.length, 0);
  });
});

describe("skill list, detail, and settings", { concurrency: false }, () => {
  async function seed() {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": {
          ...emptySnap("a".repeat(40)),
          files: [
            skillFile("skills/alpha", "Alpha body", "runtimes:\n  - grok\n"),
            {
              path: "skills/beta/SKILL.md",
              content: "---\nname: Beta Skill\ndescription: Writes specs.\nversion: \"2.0.0\"\nruntimes:\n  - claude\n---\nBeta.\n",
            },
          ],
        },
      }),
    });
  }

  it("filters by runtime and by name or description, and omits removed skills", async () => {
    await seed();
    skillsMemory.skills.push({
      ...skillsMemory.skills[0],
      id: "gone",
      name: "gone",
      removed_at: NOW,
    });
    const grok = await listSkillViews({ runtime: "grok", q: null });
    assert.deepEqual(grok.skills.map((row) => row.id), ["alpha"]);
    assert.ok(Array.isArray(grok.skills[0]?.runtimes));
    const byName = await listSkillViews({ runtime: null, q: "BETA" });
    assert.deepEqual(byName.skills.map((row) => row.id), ["beta"]);
    const byIdOnly = await listSkillViews({ runtime: null, q: "beta" });
    assert.deepEqual(byIdOnly.skills.map((row) => row.id), ["beta"]);
    const miss = await listSkillViews({ runtime: null, q: "not-the-name" });
    assert.equal(miss.skills.some((row) => row.id === "gone"), false);
    assert.equal(miss.skills.some((row) => row.id === "alpha"), false);
  });

  it("maps a run to running, stalled, or done from the stall window", async () => {
    await seed();
    await runWithActor(ACTOR, () => patchSkillSettings("alpha", { trigger: "on_request" }));
    await runWithActor(ACTOR, () => startSkillRun({ id: "alpha", agentId: "grok-lane", runtime: "grok", lane: "conference-os" }));
    setSkillNowForTests(() => new Date("2026-10-27T12:30:00.000Z"));
    const running = await getSkillDetail("alpha");
    assert.equal(running?.triggers[0]?.status, "running");
    assert.equal(running && "demo" in running, false);
    assert.equal(Array.isArray(running?.runtimes), false);
    setSkillNowForTests(() => new Date("2026-10-27T14:00:00.000Z"));
    const stalled = await getSkillDetail("alpha");
    assert.equal(stalled?.triggers[0]?.status, "stalled");
    assert.equal(stalled?.triggers[0]?.outcome, null);
    const done = await runWithActor(ACTOR, () => finishSkillRun({ runId: skillsMemory.runs[0].run_id, status: "failed", note: "checks failed" }));
    assert.equal(done.ok, true);
    const ended = await getSkillDetail("alpha");
    assert.equal(ended?.triggers[0]?.status, "done");
    assert.equal(ended?.triggers[0]?.outcome, "failed");
    assert.equal(ended?.triggerCount7d, 1);
    assert.equal(ended?.lastRun?.agent, "grok-lane");
  });

  it("rejects a bad patch and records the actor on a good one", async () => {
    await seed();
    const bad = await patchSkillSettings("alpha", { dry_run: true });
    assert.equal(bad.ok, false);
    const saved = await runWithActor({ actor_type: "human", actor_id: "operator" }, () =>
      patchSkillSettings("alpha", { trigger: "auto_inject", scope: { mode: "selected", lanes: ["conference-os"] } }),
    );
    assert.equal(saved.ok, true);
    if (saved.ok) {
      assert.equal(saved.detail.trigger, "auto_inject");
      assert.equal(saved.detail.schedule, null);
      assert.equal("demo" in saved.detail, false);
    }
    assert.equal(skillsMemory.settings[0]?.updated_by, "human:operator");
    const none = await patchSkillSettings("missing", { trigger: "off" });
    assert.equal(none.ok, false);
  });
});

describe("skill runs and MCP gates", { concurrency: false }, () => {
  async function seedOnRequest() {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": {
          ...emptySnap("a".repeat(40)),
          files: [
            skillFile("skills/alpha", "Alpha body", "runtimes:\n  - grok\n  - claude\n"),
            skillFile("skills/picked", "Picked body", "runtimes:\n  - grok\n"),
          ],
        },
      }),
    });
    await runWithActor(ACTOR, () =>
      patchSkillSettings("alpha", { trigger: "on_request", scope: { mode: "all", lanes: [] } }),
    );
    await runWithActor(ACTOR, () =>
      patchSkillSettings("picked", { trigger: "on_request", scope: { mode: "selected", lanes: ["conference-os"] } }),
    );
  }

  it("hides trigger off, the wrong runtime, and selected skills with no lane", async () => {
    await seedOnRequest();
    const listed = await listSkillsTool({});
    const text = listed.content[0]?.text ?? "";
    assert.match(text, /runtime filter: none \(caller did not pass runtime\)\./);
    assert.match(text, /alpha/);
    assert.equal(text.includes("picked"), false);
    const lane = await listSkillsTool({ runtime: "grok", lane: "conference-os" });
    assert.match(lane.content[0]?.text ?? "", /picked/);
    const wrong = await getSkillTool({ id: "alpha", runtime: "hermes" });
    assert.equal(wrong.isError, true);
    const noLane = await getSkillTool({ id: "picked", runtime: "grok" });
    assert.equal(noLane.isError, true);
    const off = await runWithActor(ACTOR, () => patchSkillSettings("alpha", { trigger: "off" }));
    assert.equal(off.ok, true);
    const hidden = await getSkillTool({ id: "alpha", runtime: "grok" });
    assert.equal(hidden.isError, true);
    assert.match(hidden.content[0]?.text ?? "", /not_found/);
  });

  it("starts a span, completes once, and refuses a different actor", async () => {
    await seedOnRequest();
    const started = await runWithActor(ACTOR, () =>
      startSkillRun({ id: "alpha", agentId: "grok-lane", runtime: "grok" }),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.match(started.text, /Pinned SHA: [0-9a-f]{64}/);
    assert.match(started.text, /Call run_skill again with this run_id and complete:true/);
    const span = skillsMemory.spans[0];
    assert.equal(span?.trace_id, started.runId.replace(/-/g, ""));
    assert.equal(span?.trace_id.length, 32);
    assert.equal(span?.span_id.length, 16);
    assert.equal(span?.kind, "tool");
    assert.equal(span?.name, "skill:alpha");
    assert.equal(span?.attributes.skill_id, "alpha");
    assert.equal(span?.status, "unset");

    const other = await runWithActor({ actor_type: "agent", actor_id: "lane-b" }, () =>
      finishSkillRun({ runId: started.runId, note: "stolen" }),
    );
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.code, "forbidden");
    assert.equal(skillsMemory.runs[0]?.ended_at, null);
    assert.equal(skillsMemory.runs[0]?.note, null);

    const first = await runWithActor(ACTOR, () => finishSkillRun({ runId: started.runId, note: "shipped" }));
    assert.equal(first.ok, true);
    if (first.ok) assert.match(first.text, /note: shipped/);
    const retry = await runWithActor(ACTOR, () => finishSkillRun({ runId: started.runId, note: "x".repeat(501) }));
    assert.equal(retry.ok, true);
    if (retry.ok && first.ok) assert.equal(retry.text, first.text);
    assert.equal(skillsMemory.runs[0]?.note, "shipped");
    assert.equal(skillsMemory.spans.at(-1)?.status, "ok");

    const unknown = await runWithActor(ACTOR, () => finishSkillRun({ runId: "22222222-2222-4222-8222-222222222222" }));
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "not_found");
  });

  it("rejects a note over 500 characters before the run is closed", async () => {
    await seedOnRequest();
    const started = await runWithActor(ACTOR, () => startSkillRun({ id: "alpha", agentId: "grok-lane", runtime: "grok" }));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const tooLong = await runWithActor(ACTOR, () => finishSkillRun({ runId: started.runId, note: "x".repeat(501) }));
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.equal(tooLong.code, "validation_failed");
    assert.equal(skillsMemory.runs.find((row) => row.run_id === started.runId)?.ended_at, null);
  });

  it("refuses a start when the request has no actor", async () => {
    await seedOnRequest();
    const started = await startSkillRun({ id: "alpha", agentId: "grok-lane", runtime: "grok" });
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.code, "forbidden");
    assert.equal(skillsMemory.runs.length, 0);
  });
});

describe("skill drift, digest, pointers, and HTTP", { concurrency: false }, () => {
  it("counts this report's findings and the distinct names on the list", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap("a".repeat(40)), files: [skillFile("skills/alpha", "Alpha body")] },
      }),
    });
    const sha = skillsMemory.skills[0].sha;
    const posted = await recordDrift({
      host: "lane-host",
      dir: "~/.codex/skills",
      skills: [{ name: "alpha", sha: "f".repeat(64) }, { name: "extra", sha: "e".repeat(64) }],
    });
    assert.equal(posted.host, "lane-host");
    assert.equal(posted.dir, "~/.codex/skills");
    assert.equal(posted.differs.length, 1);
    assert.equal(posted.extra.length, 1);
    assert.equal(posted.driftCount, 2);
    assert.notEqual(posted.differs[0]?.mirrorSha, "f".repeat(64));
    assert.equal(posted.differs[0]?.mirrorSha, sha);
    await recordDrift({
      host: "other-host",
      dir: "~/.agents/skills",
      skills: [{ name: "alpha", sha: "f".repeat(64) }],
    });
    const listed = await listSkillViews({ runtime: null, q: null });
    assert.equal(listed.upstream.driftCount, 2);
  });

  it("counts only runs inside the window and still reports an older open stall", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap("a".repeat(40)), files: [skillFile("skills/alpha", "Alpha body", "runtimes:\n  - grok\n")] },
      }),
    });
    await runWithActor(ACTOR, () => patchSkillSettings("alpha", { trigger: "on_request" }));
    await runWithActor(ACTOR, () => patchSkillSettings("alpha", { trigger: "auto_inject", scope: { mode: "selected", lanes: ["other-lane"] } }));
    setSkillNowForTests(() => new Date("2026-10-19T12:00:00.000Z"));
    await runWithActor(ACTOR, () => startSkillRun({ id: "alpha", agentId: "old-lane", runtime: "grok", lane: "other-lane" }));
    setSkillNowForTests(() => new Date(NOW));
    const digest = await skillsDigest("7d");
    assert.equal(digest.note, "Only triggers routed through Agent Kontrol are counted.");
    assert.deepEqual(digest.triggers_by_skill, []);
    assert.equal(digest.triggers_by_runtime.grok, 0);
    assert.equal(digest.stalled.length, 1);
    assert.deepEqual(digest.enabled_never_used, ["alpha"]);
    const pointers = await renderLaneSkillPointers({ lane: "conference-os", runtime: "grok" });
    assert.equal(pointers, "");
    await runWithActor(ACTOR, () =>
      patchSkillSettings("alpha", { trigger: "auto_inject", scope: { mode: "all", lanes: [] } }),
    );
    const block = await renderLaneSkillPointers({ lane: "conference-os", runtime: "grok" });
    assert.match(block, /<!-- ak-skills:begin -->/);
    assert.match(block, /alpha/);
  });

  it("serves the REST contract and denies agent credentials on operator routes", async () => {
    await syncSkills({
      trigger: "manual",
      fetcher: fetcher({
        "master-skills": { ...emptySnap("a".repeat(40)), files: [skillFile("skills/alpha", "Alpha body")] },
      }),
    });
    const list = await listRoute(new Request("http://ak.test/api/skills?runtime=nope"));
    assert.equal(list.status, 400);
    const ok = await listRoute(new Request("http://ak.test/api/skills?q=alpha", { headers: { authorization: "Bearer unit-test-token" } }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.demo, false);
    assert.equal(body.skills[0].id, "alpha");
    const missing = await detailRoute(new Request("http://ak.test/api/skills/missing"), { params: Promise.resolve({ id: "missing" }) });
    assert.equal(missing.status, 404);
    const detail = await detailRoute(new Request("http://ak.test/api/skills/alpha"), { params: Promise.resolve({ id: "alpha" }) });
    const detailBody = await detail.json();
    assert.equal(detailBody.runtimes.claude, true);
    assert.equal("demo" in detailBody, false);

    delete env.DATABASE_URL;
    const issued = await createCredential({ label: "writer", scopes: ["skills:write"] });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const denied = await syncRoute(new Request("http://ak.test/api/skills/sync", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
      body: "{}",
    }));
    assert.equal(denied.status, 403);
    const driftDenied = await driftRoute(new Request("http://ak.test/api/skills/drift", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({ host: "lane-host", dir: "~/.codex/skills", skills: [] }),
    }));
    assert.equal(driftDenied.status, 403);
    const patchDenied = await patchRoute(
      new Request("http://ak.test/api/skills/alpha", {
        method: "PATCH",
        headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
        body: JSON.stringify({ trigger: "on_request" }),
      }),
      { params: Promise.resolve({ id: "alpha" }) },
    );
    assert.equal(patchDenied.status, 403);
    const reader = await createCredential({ label: "reader", scopes: ["skills:read"] });
    assert.equal(reader.ok, true);
    if (!reader.ok) return;
    const demo = await listRoute(new Request("http://ak.test/api/skills", { headers: { authorization: `Bearer ${reader.token}` } }));
    assert.equal(demo.status, 200);
    const demoBody = await demo.json();
    assert.equal(demoBody.demo, true);
    assert.ok(demoBody.skills.some((row: { id: string }) => row.id === "operator-voice"));
    assert.ok(demoBody.skills.some((row: { id: string }) => row.id === "verify-gibson"));
    const bare = await createCredential({ label: "bare", scopes: ["fleet:read"] });
    assert.equal(bare.ok, true);
    if (!bare.ok) return;
    const noRead = await listRoute(new Request("http://ak.test/api/skills", { headers: { authorization: `Bearer ${bare.token}` } }));
    assert.equal(noRead.status, 403);

    env.DATABASE_URL = "postgres://unit-test.example/ak";
    const demoWrite = await driftRoute(new Request("http://ak.test/api/skills/drift", {
      method: "POST",
      headers: { authorization: "Bearer unit-test-token", "content-type": "application/json" },
      body: JSON.stringify({ host: "lane-host", dir: "/tmp/not-a-drift-dir", skills: [] }),
    }));
    assert.equal(demoWrite.status, 400);
  });

  it("omits the progress skills field only when the skill tables are missing", async () => {
    setSqlForTests(async (strings) => {
      const text = strings.join(" ");
      if (text.includes("sk:")) {
        const err = new Error('relation "skills" does not exist');
        (err as { code?: string }).code = "42P01";
        throw err;
      }
      return [];
    });
    const quiet = await progress("7d");
    assert.equal(quiet.skills, undefined);
    setSqlForTests(async (strings) => {
      const text = strings.join(" ");
      if (text.includes("sk:")) throw new Error("connection reset");
      return [];
    });
    await assert.rejects(() => progress("7d"), /connection reset/);
  });

  it("does not store a demo run", async () => {
    delete env.DATABASE_URL;
    const started = await runSkillTool({ id: "verify-gibson", agent_id: "grok-lane", runtime: "grok" });
    assert.equal(started.isError, undefined);
    assert.equal(started.content[0]?.text, "DATABASE_URL not set; skill run not stored.");
    const voice = await runSkillTool({ id: "operator-voice", agent_id: "grok-lane", runtime: "grok" });
    assert.equal(voice.isError, true);
  });
});
