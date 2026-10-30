/**
 * Browser check for the skills list scope and schedule controls.
 *
 * Starts `next dev` with no database and no password (local open mode), then answers every
 * /api/skills and /api/skills/<id> call from the browser with the real route handlers running
 * in this process over the in-memory skills SQL from tests/ui/skills-memory.ts. Saved settings
 * therefore go through the real PATCH parser and come back through the real list serializer.
 * No credentials, no network beyond localhost.
 *
 * Usage: npx tsx scripts/skills-scope-e2e.ts   (PORT=3197 by default)
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page, type Route } from "playwright";
import { setSkillNowForTests } from "../src/lib/skills/clock";
import { installSkillsSql, skillsMemory, type MemSkill } from "../tests/ui/skills-memory";

const PORT = Number(process.env.PORT ?? 3197);
const BASE = `http://127.0.0.1:${PORT}`;
const NOW = "2026-10-27T12:00:00.000Z";
const TOKEN = "e2e-local-token";

function skill(id: string): MemSkill {
  return {
    id,
    source_id: "master-skills",
    path: `skills/${id}/SKILL.md`,
    name: id,
    description: `${id} description`,
    version: "1.0.0",
    sha: id.padEnd(64, "a").slice(0, 64),
    commit_sha: "c".repeat(40),
    body: `${id} body`,
    references: [],
    runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true },
    category: null,
    tags: [],
    frontmatter: {},
    removed_at: null,
    synced_at: NOW,
  };
}

async function startNext(): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
  delete env.DATABASE_URL;
  delete env.MC_DASHBOARD_PASSWORD;
  delete env.MC_TOKEN;
  const child = spawn("npx", ["next", "dev", "-p", String(PORT), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/skills`);
      if (res.ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  child.kill();
  throw new Error("next dev did not start");
}

async function main() {
  // The handlers in this process see a live (non-demo) database backed by memory.
  process.env.DATABASE_URL = "postgres://skills:skills@127.0.0.1:9/skills_e2e";
  process.env.MC_TOKEN = TOKEN;
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  installSkillsSql();
  setSkillNowForTests(() => new Date(NOW));
  skillsMemory.skills.push(skill("nightly"), skill("lanes-seed"));
  skillsMemory.settings.push({
    skill_id: "lanes-seed",
    trigger: "on_request",
    scope: { mode: "selected", lanes: ["chatterbuilt", "conference-os"] },
    schedule: null,
    updated_by: null,
    updated_at: NOW,
  });

  const list = await import("../src/app/api/skills/route");
  const item = await import("../src/app/api/skills/[id]/route");
  const patches: { id: string; body: unknown; status: number }[] = [];
  let failNextPatch = false;

  async function answer(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    let res: Response;
    if (url.pathname === "/api/skills" && req.method() === "GET") {
      res = await list.GET(new Request(url, { headers }));
    } else {
      const match = /^\/api\/skills\/([^/]+)$/.exec(url.pathname);
      if (!match) return route.continue();
      const id = decodeURIComponent(match[1]);
      const ctx = { params: Promise.resolve({ id }) };
      if (req.method() === "PATCH") {
        const body = req.postDataJSON() as unknown;
        if (failNextPatch) {
          failNextPatch = false;
          patches.push({ id, body, status: 503 });
          return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "injected failure" }) });
        }
        res = await item.PATCH(new Request(url, { method: "PATCH", headers, body: JSON.stringify(body) }), ctx);
        patches.push({ id, body, status: res.status });
      } else if (req.method() === "GET") {
        res = await item.GET(new Request(url, { headers }), ctx);
      } else {
        return route.continue();
      }
    }
    await route.fulfill({ status: res.status, contentType: "application/json", body: await res.text() });
  }

  const server = await startNext();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.clock.install();
    await page.route(/\/api\/skills(\/[^/?]+)?(\?.*)?$/, answer);
    await page.goto(`${BASE}/skills`);
    const row = rowOf(page, "nightly");
    await row.waitFor();
    const poll = () => page.clock.runFor(16_000);

    // Schedule: save a cron, then it must survive a poll and a reload.
    await row.getByRole("radio", { name: "Scheduled" }).check();
    assert.equal(patches.length, 0, "choosing Scheduled with no cron must not send");
    await row.getByLabel("Cron schedule").fill("15 6 * * 1-5");
    await row.getByRole("button", { name: "Save" }).click();
    await waitFor(() => patches.length === 1);
    assert.deepEqual(patches[0], { id: "nightly", body: { trigger: "scheduled", schedule: "15 6 * * 1-5" }, status: 200 });
    await poll();
    await assertCron(page, "15 6 * * 1-5");
    await page.reload();
    await rowOf(page, "nightly").waitFor();
    await assertCron(page, "15 6 * * 1-5");
    await poll();
    await assertCron(page, "15 6 * * 1-5");

    // Scope: Selected lanes from all/[] stays local, even across a poll.
    const r = rowOf(page, "nightly");
    await r.getByRole("radio", { name: "Selected lanes" }).check();
    await r.getByText("Not saved yet").waitFor();
    await poll();
    assert.equal(await r.getByRole("radio", { name: "Selected lanes" }).isChecked(), true, "poll clobbered local Selected");
    assert.equal(patches.length, 1, "empty Selected must not send");

    // First lane persists.
    await r.getByRole("checkbox", { name: "conference-os" }).check();
    await waitFor(() => patches.length === 2);
    assert.deepEqual(patches[1], { id: "nightly", body: { scope: { mode: "selected", lanes: ["conference-os"] } }, status: 200 });
    assert.deepEqual(stored("nightly")?.scope, { mode: "selected", lanes: ["conference-os"] });
    assert.equal(stored("nightly")?.schedule, "15 6 * * 1-5", "scope edit must keep the cron");

    // Add a second lane, then remove it.
    await r.getByRole("checkbox", { name: "chatterbuilt" }).check();
    await waitFor(() => patches.length === 3);
    assert.deepEqual(patches[2].body, { scope: { mode: "selected", lanes: ["conference-os", "chatterbuilt"] } });
    await r.getByRole("checkbox", { name: "chatterbuilt" }).uncheck();
    await waitFor(() => patches.length === 4);
    assert.deepEqual(patches[3].body, { scope: { mode: "selected", lanes: ["conference-os"] } });
    assert.ok(patches.every((p) => p.status === 200));

    // Last lane: nothing is sent, the box stays checked, and the choice is spelled out.
    await r.getByRole("checkbox", { name: "conference-os" }).click();
    await r.getByRole("status").filter({ hasText: "choose All lanes" }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(patches.length, 4, "unchecking the last lane must not send");
    assert.equal(await r.getByRole("checkbox", { name: "conference-os" }).isChecked(), true);
    assert.deepEqual(stored("nightly")?.scope, { mode: "selected", lanes: ["conference-os"] });

    // Explicit All lanes.
    await r.getByRole("radio", { name: "All lanes" }).check();
    await waitFor(() => patches.length === 5);
    assert.deepEqual(patches[4].body, { scope: { mode: "all", lanes: [] } });
    assert.deepEqual(stored("nightly")?.scope, { mode: "all", lanes: [] });

    // A failed first-lane PATCH rolls back to All lanes and says so.
    await r.getByRole("radio", { name: "Selected lanes" }).check();
    failNextPatch = true;
    await r.getByRole("checkbox", { name: "conference-os" }).check();
    await r.getByRole("alert").filter({ hasText: "Couldn't save — reverted" }).waitFor();
    assert.equal(patches[5]?.status, 503);
    assert.equal(await r.getByRole("radio", { name: "All lanes" }).isChecked(), true);
    assert.equal(await r.getByRole("checkbox").count(), 0);
    assert.deepEqual(stored("nightly")?.scope, { mode: "all", lanes: [] });

    // Reload and poll: the saved cron and scope are what the list serializer returns.
    await page.reload();
    await rowOf(page, "nightly").waitFor();
    await poll();
    await assertCron(page, "15 6 * * 1-5");
    assert.equal(await rowOf(page, "nightly").getByRole("radio", { name: "All lanes" }).isChecked(), true);
    console.log(`skills scope e2e: ok (${patches.length} PATCH requests: ${patches.map((p) => p.status).join(", ")})`);
  } finally {
    await browser.close();
    server.kill();
  }
}

function rowOf(page: Page, id: string) {
  return page.locator("article").filter({ has: page.getByRole("link", { name: id, exact: true }) });
}

function stored(id: string) {
  return skillsMemory.settings.find((row) => row.skill_id === id);
}

async function assertCron(page: Page, cron: string) {
  const row = rowOf(page, "nightly");
  assert.equal(await row.getByRole("radio", { name: "Scheduled" }).isChecked(), true);
  assert.equal(await row.getByLabel("Cron schedule").inputValue(), cron);
}

async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
