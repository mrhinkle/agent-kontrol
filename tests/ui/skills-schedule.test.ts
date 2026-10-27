import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCredential, resetCredentialsForTests } from "../../src/lib/credentials";
import { setSqlForTests } from "../../src/lib/db";
import { IdempotencyConflict } from "../../src/lib/idempotency";
import { openApiDocument } from "../../src/lib/openapi";
import {
  compileCron,
  countMatchesBetween,
  cronMatches,
  latestDueSlot,
  nextDueSlot,
  slotId,
} from "../../src/lib/skills/schedule-cron";
import {
  catchupMinutes,
  idempotencyKeyFor,
  routeFor,
  runScheduleTick,
  scheduleView,
  type TickDeps,
} from "../../src/lib/skills/schedule";
import type { ScheduledTaskRow } from "../../src/lib/skills/schedule-store";
import type { SettingsRecord, SkillRecord } from "../../src/lib/skills/types";

const env = process.env as Record<string, string | undefined>;
const saved = { token: env.MC_TOKEN, db: env.DATABASE_URL, password: env.MC_DASHBOARD_PASSWORD, node: env.NODE_ENV };

function at(text: string): Date {
  return new Date(text);
}

function skill(id: string, runtimes?: Partial<SkillRecord["runtimes"]>, removed = false): SkillRecord {
  return {
    id,
    source_id: "master-skills",
    path: `skills/${id}/SKILL.md`,
    name: id,
    description: "",
    version: null,
    sha: "a".repeat(64),
    commit_sha: null,
    body: "",
    references: [],
    runtimes: { claude: true, codex: true, grok: true, hermes: true, mini: true, ...runtimes },
    category: null,
    tags: [],
    frontmatter: {},
    removed_at: removed ? "2026-10-01T00:00:00.000Z" : null,
    synced_at: "2026-10-27T00:00:00.000Z",
  };
}

function setting(id: string, over: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    skill_id: id,
    trigger: "scheduled",
    scope: { mode: "all", lanes: [] },
    schedule: "*/5 * * * *",
    updated_by: null,
    updated_at: "2026-10-27T00:00:00.000Z",
    ...over,
  };
}

function taskRow(id: string, slot: string, status = "queued", taskId = 1): ScheduledTaskRow {
  return { id: taskId, skill_id: id, status, description: `Run skill ${id}.\nScheduled slot: ${slot} (cron "x", UTC)`, created_at: "2026-10-27T12:00:00.000Z" };
}

interface Harness {
  deps: Partial<TickDeps>;
  created: Parameters<TickDeps["create"]>[0][];
}

function harness(opts: {
  skills: SkillRecord[];
  settings: SettingsRecord[];
  open?: ScheduledTaskRow[];
  last?: ScheduledTaskRow[];
  createError?: Error;
}): Harness {
  const created: Harness["created"] = [];
  return {
    created,
    deps: {
      skills: async () => opts.skills,
      settings: async () => opts.settings,
      open: async () => opts.open ?? [],
      last: async () => opts.last ?? [],
      create: async (input) => {
        if (opts.createError) throw opts.createError;
        created.push(input);
        return { id: 100 + created.length };
      },
    },
  };
}

describe("schedule cron maths", () => {
  it("matches steps, ranges, lists, and Sunday as 0 or 7", () => {
    const every5 = compileCron("*/5 * * * *")!;
    assert.equal(cronMatches(every5, at("2026-10-27T12:10:30Z")), true);
    assert.equal(cronMatches(every5, at("2026-10-27T12:11:00Z")), false);
    const weekdays = compileCron("0 9 * * 1-5")!;
    assert.equal(cronMatches(weekdays, at("2026-10-27T09:00:00Z")), true); // Tuesday
    assert.equal(cronMatches(weekdays, at("2026-10-25T09:00:00Z")), false); // Sunday
    assert.equal(cronMatches(compileCron("0 9 * * 7")!, at("2026-10-25T09:00:00Z")), true);
    assert.equal(cronMatches(compileCron("0 9 * * 0")!, at("2026-10-25T09:00:00Z")), true);
    assert.equal(cronMatches(compileCron("5/20 * * * *")!, at("2026-10-27T12:45:00Z")), true);
    assert.equal(cronMatches(compileCron("5/20 * * * *")!, at("2026-10-27T12:25:00Z")), true);
    assert.equal(cronMatches(compileCron("5/20 * * * *")!, at("2026-10-27T12:30:00Z")), false);
    assert.equal(cronMatches(compileCron("0,30 * * * *")!, at("2026-10-27T12:30:00Z")), true);
  });

  it("ORs day-of-month and day-of-week when both are restricted", () => {
    const either = compileCron("0 0 27 * 1")!; // the 27th, or a Monday
    assert.equal(cronMatches(either, at("2026-10-27T00:00:00Z")), true); // Tuesday the 27th
    assert.equal(cronMatches(either, at("2026-10-26T00:00:00Z")), true); // Monday the 26th
    assert.equal(cronMatches(either, at("2026-10-28T00:00:00Z")), false);
    assert.equal(compileCron("0 0 * * * *"), null);
    assert.equal(compileCron("MON * * * *"), null);
  });

  it("finds the latest due slot inside the look-back, counts misses, and finds the next", () => {
    const cron = compileCron("*/5 * * * *")!;
    assert.equal(slotId(latestDueSlot(cron, at("2026-10-27T12:13:40Z"), 10)!), "2026-10-27T12:10Z");
    assert.equal(latestDueSlot(compileCron("0 3 * * *")!, at("2026-10-27T12:13:00Z"), 10), null);
    assert.equal(countMatchesBetween(cron, at("2026-10-27T12:00:00Z"), at("2026-10-27T12:20:00Z")), 3);
    assert.equal(nextDueSlot(cron, at("2026-10-27T12:10:00Z"))!.toISOString(), "2026-10-27T12:15:00.000Z");
    assert.equal(nextDueSlot(compileCron("0 0 31 2 *")!, at("2026-10-27T12:10:00Z")), null);
    assert.equal(nextDueSlot(compileCron("0 0 29 2 *")!, at("2026-10-27T12:10:00Z"))!.toISOString(), "2028-02-29T00:00:00.000Z");
    assert.equal(nextDueSlot(compileCron("30 14 * * *")!, at("2026-10-27T14:30:00Z"))!.toISOString(), "2026-10-28T14:30:00.000Z");
    assert.equal(nextDueSlot(compileCron("30 14 * * *")!, at("2026-10-27T14:29:20Z"))!.toISOString(), "2026-10-27T14:30:00.000Z");
    // Vixie cron: `*/2` starts with `*`, so day-of-week stays unrestricted and ANDs with day-of-month.
    assert.equal(cronMatches(compileCron("0 0 1 * */2")!, at("2027-01-01T00:00:00Z")), false); // a Friday, not in */2

  });
});

describe("runScheduleTick", () => {
  it("queues one task for a due skill with the slot key and an unpinned description", async () => {
    const h = harness({ skills: [skill("alpha")], settings: [setting("alpha")] });
    const result = await runScheduleTick({ now: at("2026-10-27T12:10:42Z"), deps: h.deps, env: {} });
    assert.equal(result.queued, 1);
    assert.equal(result.scheduled, 1);
    assert.equal(h.created.length, 1);
    const task = h.created[0];
    assert.equal(task.title, "Run scheduled skill alpha");
    assert.equal(task.idempotency_key, "skill-schedule:alpha:2026-10-27T12:10Z");
    assert.equal(task.platform, "any");
    assert.match(task.description, /Run skill alpha for scope: all lanes\./);
    assert.match(task.description, /Scheduled slot: 2026-10-27T12:10Z/);
    assert.match(task.description, /does not execute the skill/);
    assert.deepEqual(result.items[0], { skill_id: "alpha", slot: "2026-10-27T12:10Z", outcome: "queued", task_id: 101 });
  });

  it("queues nothing when no skill is due, or for off, removed, and unknown skills", async () => {
    const h = harness({
      skills: [skill("alpha"), skill("gone", {}, true)],
      settings: [
        setting("alpha"),
        setting("off", { trigger: "off" }),
        setting("gone"),
        setting("ghost"),
        setting("bad", { schedule: "nope" }),
      ],
    });
    const result = await runScheduleTick({ now: at("2026-10-27T12:12:00Z"), deps: h.deps, env: { AK_SKILL_SCHEDULE_CATCHUP_MINUTES: "1" } });
    assert.equal(result.queued, 0);
    assert.equal(h.created.length, 0);
    assert.equal(result.items.length, 0);
  });

  it("catches up inside the window and not outside it", async () => {
    const h = harness({ skills: [skill("alpha")], settings: [setting("alpha")] });
    const late = await runScheduleTick({ now: at("2026-10-27T12:13:00Z"), deps: h.deps, env: {} });
    assert.equal(late.items[0].slot, "2026-10-27T12:10Z");
    const hourly = harness({ skills: [skill("alpha")], settings: [setting("alpha", { schedule: "0 * * * *" })] });
    const outside = await runScheduleTick({ now: at("2026-10-27T12:30:00Z"), deps: hourly.deps, env: {} });
    assert.equal(outside.items.length, 0);
  });

  it("skips while the previous task is open, and a second tick for the same slot", async () => {
    const open = harness({ skills: [skill("alpha")], settings: [setting("alpha")], open: [taskRow("alpha", "2026-10-27T12:05Z", "claimed")], last: [taskRow("alpha", "2026-10-27T12:05Z", "claimed")] });
    const blocked = await runScheduleTick({ now: at("2026-10-27T12:10:00Z"), deps: open.deps, env: {} });
    assert.deepEqual(blocked.items.map((i) => [i.outcome, i.reason]), [["skipped", "previous_open"]]);
    assert.equal(open.created.length, 0);

    const same = harness({ skills: [skill("alpha")], settings: [setting("alpha")], last: [taskRow("alpha", "2026-10-27T12:10Z", "done", 7)] });
    const again = await runScheduleTick({ now: at("2026-10-27T12:10:50Z"), deps: same.deps, env: {} });
    assert.deepEqual(again.items.map((i) => [i.outcome, i.reason, i.task_id]), [["skipped", "already_scheduled", 7]]);
    assert.equal(same.created.length, 0);
  });

  it("folds missed ticks into the next task and reports the count", async () => {
    const h = harness({ skills: [skill("alpha")], settings: [setting("alpha")], last: [taskRow("alpha", "2026-10-27T11:30Z", "done")] });
    const result = await runScheduleTick({ now: at("2026-10-27T12:10:00Z"), deps: h.deps, env: {} });
    assert.equal(result.items[0].outcome, "queued");
    assert.equal(result.items[0].missed, 7); // 11:35 .. 12:05
    assert.equal(h.created.length, 1);
    assert.match(h.created[0].description, /Earlier due minutes with no task: 7/);
  });

  it("routes by runtime flags and names the lanes of a selected scope", async () => {
    const h = harness({
      skills: [skill("solo", { codex: false, grok: false, hermes: false, mini: false }), skill("laned", {}), skill("mini-only", { claude: false, codex: false, grok: false, hermes: false }), skill("none", { claude: false, codex: false, grok: false, hermes: false, mini: false })],
      settings: [
        setting("solo"),
        setting("laned", { scope: { mode: "selected", lanes: ["lane-a", "lane-b"] } }),
        setting("mini-only"),
        setting("none"),
      ],
    });
    const result = await runScheduleTick({ now: at("2026-10-27T12:10:00Z"), deps: h.deps, env: { AK_SKILL_MINI_MACHINE: "mac-mini" } });
    const byTitle = new Map(h.created.map((c) => [c.title, c]));
    assert.equal(byTitle.get("Run scheduled skill solo")?.platform, "claude-code");
    assert.equal(byTitle.get("Run scheduled skill laned")?.platform, "any");
    assert.match(byTitle.get("Run scheduled skill laned")?.description ?? "", /for scope: lanes lane-a, lane-b\./);
    assert.match(byTitle.get("Run scheduled skill laned")?.description ?? "", /lane set to one of the lanes/);
    assert.equal(byTitle.get("Run scheduled skill mini-only")?.machine, "mac-mini");
    assert.equal(byTitle.has("Run scheduled skill none"), false);
    assert.ok(result.items.some((i) => i.skill_id === "none" && i.reason === "no_runtime"));
  });

  it("reports a concurrent same-slot claim as a duplicate, and rethrows other errors", async () => {
    const dup = harness({ skills: [skill("alpha")], settings: [setting("alpha")], createError: new IdempotencyConflict("in progress", { retryable: true }) });
    const result = await runScheduleTick({ now: at("2026-10-27T12:10:00Z"), deps: dup.deps, env: {} });
    assert.deepEqual(result.items.map((i) => [i.outcome, i.reason]), [["skipped", "duplicate"]]);
    const broken = harness({ skills: [skill("alpha")], settings: [setting("alpha")], createError: new Error("db down") });
    await assert.rejects(runScheduleTick({ now: at("2026-10-27T12:10:00Z"), deps: broken.deps, env: {} }), /db down/);
  });

  it("reports a lost race on the one-open-task index as a duplicate", async () => {
    const h = harness({ skills: [skill("alpha")], settings: [setting("alpha")], createError: new Error('duplicate key value violates unique constraint "tasks_skill_schedule_one_open_idx"') });
    const result = await runScheduleTick({ now: at("2026-10-27T12:10:00Z"), deps: h.deps, env: {} });
    assert.deepEqual(result.items.map((i) => [i.outcome, i.reason]), [["skipped", "duplicate"]]);
  });

  it("uses the same key for two ticks inside one minute", async () => {
    const h = harness({ skills: [skill("alpha")], settings: [setting("alpha")] });
    await runScheduleTick({ now: at("2026-10-27T12:10:01Z"), deps: h.deps, env: {} });
    await runScheduleTick({ now: at("2026-10-27T12:10:59Z"), deps: h.deps, env: {} });
    assert.equal(h.created.length, 2);
    assert.equal(h.created[0].idempotency_key, h.created[1].idempotency_key);
    assert.ok(idempotencyKeyFor("x".repeat(300), "2026-10-27T12:10Z").length <= 200);
  });
});

describe("schedule helpers", () => {
  it("bounds the catch-up window and routes a single runtime", () => {
    assert.equal(catchupMinutes({}), 10);
    assert.equal(catchupMinutes({ AK_SKILL_SCHEDULE_CATCHUP_MINUTES: "30" }), 30);
    assert.equal(catchupMinutes({ AK_SKILL_SCHEDULE_CATCHUP_MINUTES: "0" }), 10);
    assert.equal(catchupMinutes({ AK_SKILL_SCHEDULE_CATCHUP_MINUTES: "9999" }), 10);
    assert.equal(catchupMinutes({ AK_SKILL_SCHEDULE_CATCHUP_MINUTES: "x" }), 10);
    assert.deepEqual(routeFor(["grok"], {}), { platform: "grok" });
    assert.deepEqual(routeFor(["mini"], {}), { platform: "any" });
    assert.deepEqual(routeFor(["claude", "codex"], {}), { platform: "any" });
  });

  it("builds the additive REST fields", () => {
    const now = at("2026-10-27T12:12:00Z");
    const view = scheduleView(setting("alpha"), taskRow("alpha", "2026-10-27T12:10Z"), now);
    assert.deepEqual(view, { lastScheduledAt: "2026-10-27T12:10:00.000Z", nextDueAt: "2026-10-27T12:15:00.000Z" });
    assert.deepEqual(scheduleView(setting("alpha", { trigger: "on_request", schedule: null }), undefined, now), { lastScheduledAt: null, nextDueAt: null });
    assert.deepEqual(scheduleView(undefined, undefined, now), { lastScheduledAt: null, nextDueAt: null });
  });
});

describe("schedule tick route", { concurrency: false }, () => {
  beforeEach(() => {
    delete env.DATABASE_URL;
    delete env.MC_DASHBOARD_PASSWORD;
    delete env.MC_TOKEN;
    env.NODE_ENV = "test";
    resetCredentialsForTests();
    setSqlForTests(null);
  });
  afterEach(() => {
    setSqlForTests(null);
    resetCredentialsForTests();
    for (const [key, value] of [["MC_TOKEN", saved.token], ["DATABASE_URL", saved.db], ["MC_DASHBOARD_PASSWORD", saved.password], ["NODE_ENV", saved.node]] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });

  it("denies agent credentials, including skills:write, and answers MC_TOKEN with a demo no-op", async () => {
    const { POST } = await import("../../src/app/api/skills/schedule/tick/route");
    const made = await createCredential({ label: "lane", scopes: ["skills:read", "skills:write", "tasks:write"] });
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const denied = await POST(new Request("http://localhost/api/skills/schedule/tick", { method: "POST", headers: { authorization: `Bearer ${made.token}` } }));
    assert.equal(denied.status, 403);
    env.MC_TOKEN = "test-mc-token";
    const ok = await POST(new Request("http://localhost/api/skills/schedule/tick", { method: "POST", headers: { authorization: "Bearer test-mc-token" } }));
    const body = (await ok.json()) as { ok?: boolean; demo?: boolean; note?: string };
    assert.equal(ok.status, 200);
    assert.equal(body.demo, true);
    assert.match(body.note ?? "", /no tasks queued/);
  });

  it("is documented in OpenAPI and MCP.md, and the old limit is gone", () => {
    const doc = openApiDocument() as { paths: Record<string, { post?: unknown }> };
    assert.ok(doc.paths["/api/skills/schedule/tick"]?.post);
    const mcp = fs.readFileSync("docs/MCP.md", "utf8");
    assert.match(mcp, /POST \/api\/skills\/schedule\/tick/);
    assert.doesNotMatch(mcp, /Nothing in this change runs that cron/);
  });
});
