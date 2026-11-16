/**
 * Skill sync receipts. Calls the sync route and the store, then reads
 * skill_sync_runs, skills, and events on the opt-in fixture database.
 * Snapshots come from a test fetcher. This file does not call GitHub.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DASHBOARD_ACTOR_ID, LEGACY_ACTOR_ID, runWithActor } from "../src/lib/actor";
import { authCookieValue } from "../src/lib/authcrypto";
import { createCredential, resetCredentialsForTests } from "../src/lib/credentials";
import { sql } from "../src/lib/db";
import { finishSkillRun, startSkillRun } from "../src/lib/skills/runs";
import { runScheduleTick } from "../src/lib/skills/schedule";
import { SCHEDULER_ACTOR_ID } from "../src/lib/skills/schedule-store";
import { patchSkillSettings } from "../src/lib/skills/query";
import type { SkillSnapshot, SkillSnapshotFetcher } from "../src/lib/skills/source";
import {
  beginSyncRun,
  finishSyncRun,
  markSkillRemoved,
  setSkillReceiptFaultForTests,
  SKILL_SYNC_KINDS,
  SKILL_SYNC_LEASE_ACTOR,
  SyncLeaseLost,
  upsertSkill,
} from "../src/lib/skills/store";
import { setSyncFetcherForTests } from "../src/lib/skills/sync";
import { ALL_RUNTIMES, type SkillRecord } from "../src/lib/skills/types";

const PASSWORD = "actor-admin-test-password";
const TOKEN = "actor-admin-sync-mc-token";
const CANARY = "CANARY-SKILL-BODY-do-not-audit";
const KINDS = Object.values(SKILL_SYNC_KINDS);
const env = process.env as Record<string, string | undefined>;

function assertFixture(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not the actor admin fixture");
  const url = new URL(raw);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "65438" ||
    url.username !== "ak_backlog_test" ||
    url.pathname !== "/ak_actor_admin"
  ) {
    throw new Error("refusing to run skill sync tests outside ak_actor_admin");
  }
}

function skillDoc(id: string, body: string): { path: string; content: string } {
  return {
    path: `skills/${id}/SKILL.md`,
    content: `---\nname: ${id}\ndescription: ${body}\nversion: "1.0.0"\n---\n${body}\n`,
  };
}

function snap(files: { path: string; content: string }[], commit: string): SkillSnapshot {
  return { commit_sha: commit, files, skipped: [], preserved_dirs: [] };
}

function emptySnap(): SkillSnapshot {
  return snap([], "b".repeat(40));
}

type Receipt = {
  kind: string;
  title: string;
  detailText: string;
  detail: Record<string, unknown>;
  agentId: string | null;
};

async function receiptsForSkill(id: string): Promise<Receipt[]> {
  const rows = await sql()`
    select kind, title, detail::text as detail_text, detail, agent_id
    from events
    where detail->>'skill_id' = ${id}
    order by id
  `;
  return rows.map(asReceipt);
}

async function receiptsForRun(id: string): Promise<Receipt[]> {
  const rows = await sql()`
    select kind, title, detail::text as detail_text, detail, agent_id
    from events
    where detail->>'run_id' = ${id}
    order by id
  `;
  return rows.map(asReceipt);
}

function asReceipt(row: Record<string, unknown>): Receipt {
  return {
    kind: String(row.kind),
    title: String(row.title ?? ""),
    detailText: String(row.detail_text),
    detail: row.detail as Record<string, unknown>,
    agentId: row.agent_id == null ? null : String(row.agent_id),
  };
}

function assertNoCanary(receipt: Receipt): void {
  assert.equal(`${receipt.detailText} ${receipt.title}`.includes(CANARY), false, "skill body leaked into the receipt");
}

async function skillBody(id: string): Promise<string | null> {
  const rows = await sql()`select body, removed_at from skills where id = ${id}`;
  if (!rows[0]) return null;
  return String(rows[0].body);
}

async function removedAt(id: string): Promise<string | null> {
  const rows = await sql()`select removed_at from skills where id = ${id}`;
  if (!rows[0] || rows[0].removed_at == null) return null;
  return String(rows[0].removed_at);
}

async function latestRun(): Promise<{ id: string; status: string; error: string | null; trigger: string }> {
  const rows = await sql()`
    select id::text as id, status, error, trigger
    from skill_sync_runs
    order by started_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("expected a skill sync run");
  return {
    id: String(row.id),
    status: String(row.status),
    error: row.error == null ? null : String(row.error),
    trigger: String(row.trigger),
  };
}

async function runCount(): Promise<number> {
  const rows = await sql()`select count(*)::int as n from skill_sync_runs`;
  return Number(rows[0].n);
}

export async function testSkillSync(): Promise<void> {
  assertFixture();
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    MC_DASHBOARD_PASSWORD: process.env.MC_DASHBOARD_PASSWORD,
    MC_TOKEN: process.env.MC_TOKEN,
  };
  const { POST } = await import("../src/app/api/skills/sync/route");
  const sources = await sql()`select id from skill_sources where enabled order by position, id`;
  assert.ok(sources.length >= 2, "the fixture schema seeds two skill sources");
  const primary = String(sources[0].id);
  const later = String(sources[sources.length - 1].id);
  const alpha = "akadm-alpha";
  const beta = "akadm-beta";
  const gamma = "akadm-gamma";
  const delta = "akadm-delta";
  const commit = "a".repeat(40);
  const originalError = console.error;

  const install = (files: { path: string; content: string }[], failLater = false) => {
    const fetcher: SkillSnapshotFetcher = {
      async fetch(source) {
        if (failLater && source.id === later) throw new Error("synthetic fetch failed");
        if (source.id === primary) return snap(files, commit);
        return emptySnap();
      },
    };
    setSyncFetcherForTests(fetcher);
  };

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(new Request("http://127.0.0.1/api/skills/sync", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));

  try {
    delete env.MC_TOKEN;
    delete env.MC_DASHBOARD_PASSWORD;
    env.NODE_ENV = "test";
    const runsBefore = await runCount();

    install([skillDoc(alpha, CANARY), skillDoc(beta, "beta body")]);
    const forged = await post({ trigger: "manual", actor_id: "forged-actor", actor_type: "human" });
    assert.equal(forged.status, 400);
    assert.equal(await runCount(), runsBefore, "a forged actor field writes no sync run");

    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    const cookie = `mc_auth=${await authCookieValue(PASSWORD)}`;
    const minted = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      createCredential({ label: "sync-denial", scopes: ["fleet:read"] }),
    );
    assert.equal(minted.ok, true);
    if (!minted.ok) return;
    const deniedBearer = await post({ trigger: "manual" }, { authorization: `Bearer ${minted.token}`, cookie });
    assert.equal(deniedBearer.status, 403);
    assert.equal(await runCount(), runsBefore, "an agent credential cannot start a sync");
    const deniedBearerOnly = await post({ trigger: "manual" }, { authorization: "Bearer not-the-token" });
    assert.equal(deniedBearerOnly.status, 401);
    assert.equal(await runCount(), runsBefore);

    delete env.MC_DASHBOARD_PASSWORD;
    const open = await post({ trigger: "manual" });
    assert.equal(open.status, 200);
    const openBody = await open.json() as { status: string; added: { id: string }[] };
    assert.equal(openBody.status, "ok");
    assert.deepEqual(openBody.added.map((item) => item.id).sort(), [alpha, beta]);
    const openRun = await latestRun();
    assert.equal(openRun.status, "ok");
    assert.equal(openRun.trigger, "manual");
    const openRunReceipts = await receiptsForRun(openRun.id);
    const acquire = openRunReceipts.find((row) => row.kind === SKILL_SYNC_KINDS.acquire);
    const finish = openRunReceipts.find((row) => row.kind === SKILL_SYNC_KINDS.finish);
    assert.ok(acquire);
    assert.ok(finish);
    assert.equal(acquire.detail.actor_type, null);
    assert.equal(acquire.detail.actor_id, null);
    assert.equal(acquire.detail.trigger, "manual");
    assert.equal(acquire.agentId, null);
    assert.equal(finish.detail.status, "ok");
    assert.equal(finish.detailText.includes(openRun.error ?? "sync lease expired"), false);
    const alphaReceipts = await receiptsForSkill(alpha);
    assert.equal(alphaReceipts.length, 1);
    assert.equal(alphaReceipts[0].kind, SKILL_SYNC_KINDS.upsert);
    assert.equal(alphaReceipts[0].detail.actor_type, null);
    assert.equal(alphaReceipts[0].detail.run_id, openRun.id);
    assert.equal(alphaReceipts[0].detail.source_id, primary);
    assert.equal(alphaReceipts[0].detail.source_revision, commit);
    assertNoCanary(alphaReceipts[0]);
    const storedAlpha = await skillBody(alpha);
    assert.ok(storedAlpha?.includes(CANARY));
    assert.equal(alphaReceipts[0].detailText.includes(storedAlpha ?? CANARY), false);

    const again = await post({});
    assert.equal(again.status, 200);
    const againBody = await again.json() as { status: string; added: { id: string }[]; changed: { id: string }[] };
    assert.equal(againBody.status, "ok");
    assert.equal(againBody.added.length, 0);
    const againRun = await latestRun();
    const againReceipts = await receiptsForRun(againRun.id);
    const againUpserts = againReceipts.filter((row) => row.kind === SKILL_SYNC_KINDS.upsert);
    assert.deepEqual(againUpserts.map((row) => String(row.detail.skill_id)).sort(), againBody.changed.map((item) => item.id).sort());
    for (const receipt of againUpserts) {
      assert.equal(receipt.detail.actor_type, null);
      assertNoCanary(receipt);
    }
    assert.equal(againReceipts.some((row) => row.kind === SKILL_SYNC_KINDS.acquire), true);
    assert.equal(againReceipts.some((row) => row.kind === SKILL_SYNC_KINDS.finish), true);

    env.MC_DASHBOARD_PASSWORD = PASSWORD;
    const human = await post({ trigger: "scheduled" }, { cookie });
    assert.equal(human.status, 200);
    const humanRun = await latestRun();
    assert.equal(humanRun.trigger, "scheduled");
    const humanAcquire = (await receiptsForRun(humanRun.id)).find((row) => row.kind === SKILL_SYNC_KINDS.acquire);
    assert.ok(humanAcquire);
    assert.equal(humanAcquire.detail.actor_type, "human");
    assert.equal(humanAcquire.detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(humanAcquire.detail.trigger, "scheduled");
    assert.notEqual(humanAcquire.detail.actor_id, SCHEDULER_ACTOR_ID);

    const syncEventsBeforeBookkeeping = await countSyncEvents();
    const settings = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      patchSkillSettings(alpha, { trigger: "on_request" }),
    );
    assert.equal(settings.ok, true);
    const settingRow = await sql()`select updated_by from skill_settings where skill_id = ${alpha}`;
    assert.equal(String(settingRow[0].updated_by), `human:${DASHBOARD_ACTOR_ID}`);
    const started = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      startSkillRun({ id: alpha, runtime: "codex", agentId: "forged-actor" }),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const runRow = await sql()`select actor_type, actor_id, agent_id from skill_runs where run_id = ${started.runId}::uuid`;
    assert.equal(String(runRow[0].actor_type), "human");
    assert.equal(String(runRow[0].actor_id), DASHBOARD_ACTOR_ID);
    assert.equal(String(runRow[0].agent_id), DASHBOARD_ACTOR_ID);
    const finished = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      finishSkillRun({ runId: started.runId, status: "done" }),
    );
    assert.equal(finished.ok, true);
    const scheduled = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      patchSkillSettings(alpha, { trigger: "scheduled", schedule: "* * * * *" }),
    );
    assert.equal(scheduled.ok, true);
    const tick = await runScheduleTick({ now: new Date("2026-10-27T12:00:00.000Z") });
    const queued = tick.items.find((item) => item.skill_id === alpha && item.outcome === "queued");
    assert.ok(queued);
    const task = await sql()`
      select actor_type, actor_id, created_by
      from tasks
      where id = ${queued.task_id}
    `;
    assert.equal(String(task[0].actor_type), "agent");
    assert.equal(String(task[0].actor_id), SCHEDULER_ACTOR_ID);
    assert.equal(await countSyncEvents(), syncEventsBeforeBookkeeping, "settings, runs, and the scheduler add no sync receipt");

    const beforeBusy = await countKind(SKILL_SYNC_KINDS.acquire);
    const busyId = randomUUID();
    await sql()`
      insert into skill_sync_runs (id, started_at, finished_at, trigger, status, summary, error)
      values (${busyId}::uuid, now(), null, 'manual', 'running', null, null)
    `;
    const busy = await post({ trigger: "manual" }, { cookie });
    assert.equal(busy.status, 200);
    const busyBody = await busy.json() as { status: string };
    assert.equal(busyBody.status, "busy");
    assert.equal(await countKind(SKILL_SYNC_KINDS.acquire), beforeBusy, "a busy sync does not claim an acquire receipt");
    await sql()`delete from skill_sync_runs where id = ${busyId}::uuid`;

    const staleId = randomUUID();
    await sql()`
      insert into skill_sync_runs (id, started_at, finished_at, trigger, status, summary, error)
      values (${staleId}::uuid, now() - interval '11 minutes', null, 'manual', 'running', null, null)
    `;
    const renewed = await post({ trigger: "manual" }, { cookie });
    assert.equal(renewed.status, 200);
    const stale = await sql()`select status, error from skill_sync_runs where id = ${staleId}::uuid`;
    assert.equal(String(stale[0].status), "failed");
    assert.equal(String(stale[0].error), "sync lease expired");
    const expire = (await receiptsForRun(staleId)).find((row) => row.kind === SKILL_SYNC_KINDS.leaseExpire);
    assert.ok(expire);
    assert.equal(expire.detail.actor_type, SKILL_SYNC_LEASE_ACTOR.actor_type);
    assert.equal(expire.detail.actor_id, SKILL_SYNC_LEASE_ACTOR.actor_id);
    assert.notEqual(expire.detail.actor_id, DASHBOARD_ACTOR_ID);
    const renewedRun = await latestRun();
    assert.notEqual(renewedRun.id, staleId);
    assert.equal((await receiptsForRun(renewedRun.id)).find((row) => row.kind === SKILL_SYNC_KINDS.acquire)?.detail.actor_id, DASHBOARD_ACTOR_ID);

    install([skillDoc(alpha, CANARY), skillDoc(beta, "beta body"), skillDoc(gamma, "gamma body")], true);
    const partial = await post({ trigger: "manual" }, { cookie });
    assert.equal(partial.status, 200);
    const partialBody = await partial.json() as { status: string; added: { id: string }[]; errors: { severity: string }[] };
    assert.equal(partialBody.status, "failed");
    assert.equal(partialBody.added.some((item) => item.id === gamma), true);
    assert.ok(partialBody.errors.some((item) => item.severity === "fatal"));
    const gammaReceipts = await receiptsForSkill(gamma);
    assert.equal(gammaReceipts.length, 1);
    assert.equal(gammaReceipts[0].detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(gammaReceipts[0].detail.run_id, (await latestRun()).id);
    const partialFinish = (await receiptsForRun((await latestRun()).id)).find((row) => row.kind === SKILL_SYNC_KINDS.finish);
    assert.ok(partialFinish);
    assert.equal(partialFinish.detail.status, "failed");
    assert.equal(partialFinish.detailText.includes("synthetic fetch failed"), false);

    install([skillDoc(alpha, CANARY), skillDoc(beta, "beta body"), skillDoc(gamma, "gamma body"), skillDoc(delta, "delta body")]);
    setSkillReceiptFaultForTests([SKILL_SYNC_KINDS.finish]);
    console.error = () => undefined;
    let stalled: { status: string; added: unknown[] };
    try {
      const response = await post({ trigger: "manual" }, { cookie });
      assert.equal(response.status, 200);
      stalled = await response.json() as { status: string; added: unknown[] };
    } finally {
      console.error = originalError;
      setSkillReceiptFaultForTests(null);
    }
    assert.equal(stalled.status, "failed");
    assert.equal(stalled.added.length, 0, "a finish failure still reports the caught empty summary");
    assert.ok(await skillBody(delta), "the earlier skill upsert remains after finish fails");
    const deltaReceipts = await receiptsForSkill(delta);
    assert.equal(deltaReceipts.length, 1);
    assert.equal(deltaReceipts[0].detail.actor_id, DASHBOARD_ACTOR_ID);
    const stalledRun = await sql()`
      select id::text as id, status from skill_sync_runs where status = 'running' order by started_at desc limit 1
    `;
    assert.equal(stalledRun.length, 1);
    assert.equal((await receiptsForRun(String(stalledRun[0].id))).some((row) => row.kind === SKILL_SYNC_KINDS.finish), false);
    const closed = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      finishSyncRun({
        id: String(stalledRun[0].id),
        status: "failed",
        summary: { sources: [], added: [], changed: [], removed: [], conflicts: [] },
        error: null,
        finishedAt: new Date().toISOString(),
      }),
    );
    assert.equal(closed, true);
    assert.equal((await receiptsForRun(String(stalledRun[0].id))).filter((row) => row.kind === SKILL_SYNC_KINDS.finish).length, 1);

    const faultRun = randomUUID();
    const acquired = await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () =>
      beginSyncRun({
        id: faultRun,
        trigger: "manual",
        startedAt: new Date().toISOString(),
        staleBefore: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );
    assert.equal(acquired, true);
    setSkillReceiptFaultForTests([SKILL_SYNC_KINDS.upsert]);
    const faultRecord = skillRecord("akadm-fault", primary, "fault-body");
    await assert.rejects(
      () => runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () => upsertSkill(faultRecord, faultRun)),
      (err: unknown) => err instanceof Error && ! (err instanceof SyncLeaseLost),
    );
    setSkillReceiptFaultForTests(null);
    assert.equal(await skillBody("akadm-fault"), null, "a failed upsert receipt rolls the skill back");
    assert.equal((await receiptsForSkill("akadm-fault")).length, 0);
    assert.equal(await runWithActor({ actor_type: "human", actor_id: DASHBOARD_ACTOR_ID }, () => finishSyncRun({
      id: faultRun,
      status: "failed",
      summary: { sources: [] },
      error: null,
      finishedAt: new Date().toISOString(),
    })), true);

    await fence(primary);

    install([]);
    const removed = await post({ trigger: "manual" }, { cookie });
    assert.equal(removed.status, 200);
    const removedBody = await removed.json() as { removed: string[] };
    assert.ok(removedBody.removed.includes(alpha));
    assert.ok(await removedAt(alpha));
    const removeReceipts = (await receiptsForSkill(alpha)).filter((row) => row.kind === SKILL_SYNC_KINDS.remove);
    assert.equal(removeReceipts.length, 1);
    assert.equal(removeReceipts[0].detail.actor_id, DASHBOARD_ACTOR_ID);
    assert.equal(removeReceipts[0].detail.run_id, (await latestRun()).id);
    assertNoCanary(removeReceipts[0]);
    const removedAgain = await post({ trigger: "manual" }, { cookie });
    assert.equal(removedAgain.status, 200);
    assert.equal((await receiptsForSkill(alpha)).filter((row) => row.kind === SKILL_SYNC_KINDS.remove).length, 1);

    const beforeExpireFault = await countKind(SKILL_SYNC_KINDS.leaseExpire);
    const stuckId = randomUUID();
    await sql()`
      insert into skill_sync_runs (id, started_at, finished_at, trigger, status, summary, error)
      values (${stuckId}::uuid, now() - interval '11 minutes', null, 'manual', 'running', null, null)
    `;
    setSkillReceiptFaultForTests([SKILL_SYNC_KINDS.leaseExpire]);
    console.error = () => undefined;
    try {
      const blew = await post({ trigger: "manual" }, { cookie });
      assert.equal(blew.status, 500);
      const blewBody = await blew.json() as { code?: string };
      assert.equal(blewBody.code, "internal_error");
    } finally {
      console.error = originalError;
      setSkillReceiptFaultForTests(null);
    }
    const stuck = await sql()`select status from skill_sync_runs where id = ${stuckId}::uuid`;
    assert.equal(String(stuck[0].status), "running", "a failed lease receipt rolls the expiry back");
    assert.equal(await countKind(SKILL_SYNC_KINDS.leaseExpire), beforeExpireFault);
    await sql()`delete from skill_sync_runs where id = ${stuckId}::uuid`;

    delete env.MC_DASHBOARD_PASSWORD;
    env.MC_TOKEN = TOKEN;
    install([skillDoc(alpha, CANARY)]);
    const legacy = await post({ trigger: "manual" }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(legacy.status, 200);
    const legacyRun = await latestRun();
    const legacyAcquire = (await receiptsForRun(legacyRun.id)).find((row) => row.kind === SKILL_SYNC_KINDS.acquire);
    assert.ok(legacyAcquire);
    assert.equal(legacyAcquire.detail.actor_type, "agent");
    assert.equal(legacyAcquire.detail.actor_id, LEGACY_ACTOR_ID);
    const legacyUpsert = (await receiptsForSkill(alpha)).filter((row) => row.kind === SKILL_SYNC_KINDS.upsert);
    assert.equal(legacyUpsert[legacyUpsert.length - 1].detail.actor_id, LEGACY_ACTOR_ID);

    const runsAtDemo = await runCount();
    delete env.DATABASE_URL;
    const demo = await post({ trigger: "manual" });
    assert.equal(demo.status, 200);
    const demoBody = await demo.json() as { demo?: boolean };
    assert.equal(demoBody.demo, true);
    env.DATABASE_URL = saved.DATABASE_URL;
    assert.equal(await runCount(), runsAtDemo, "demo mode does not run a sync");
  } finally {
    console.error = originalError;
    setSkillReceiptFaultForTests(null);
    setSyncFetcherForTests(null);
    resetCredentialsForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    await sql()`delete from spans where name like 'skill:akadm-%'`;
    await sql()`delete from skill_runs where skill_id like 'akadm-%'`;
    await sql()`delete from skill_settings where skill_id like 'akadm-%'`;
    await sql()`delete from events where kind = any(${KINDS}::text[]) and (detail->>'skill_id' like 'akadm-%' or detail->>'run_id' is not null)`;
    await sql()`delete from skills where id like 'akadm-%'`;
    await sql()`delete from skill_sync_runs where id in (select id from skill_sync_runs)`;
    await sql()`delete from tasks where title like 'Run scheduled skill akadm-%'`;
    await sql()`delete from idempotency_keys where idempotency_key like 'skill-schedule:akadm-%'`;
    await sql()`delete from events where detail->>'credential_id' in (select id from agent_credentials where label = 'sync-denial')`;
    await sql()`delete from agent_credentials where label = 'sync-denial'`;
  }
}

async function countSyncEvents(): Promise<number> {
  const rows = await sql()`select count(*)::int as n from events where kind = any(${KINDS}::text[])`;
  return Number(rows[0].n);
}

async function countKind(kind: string): Promise<number> {
  const rows = await sql()`select count(*)::int as n from events where kind = ${kind}`;
  return Number(rows[0].n);
}

function skillRecord(id: string, sourceId: string, body: string): SkillRecord {
  return {
    id,
    source_id: sourceId,
    path: `skills/${id}/SKILL.md`,
    name: id,
    description: body,
    version: "1.0.0",
    sha: "c".repeat(64),
    commit_sha: "d".repeat(40),
    body,
    references: [],
    runtimes: { ...ALL_RUNTIMES },
    category: null,
    tags: [],
    frontmatter: {},
    removed_at: null,
    synced_at: new Date().toISOString(),
  };
}

async function fence(sourceId: string): Promise<void> {
  const skillId = "akadm-fence";
  const runId = randomUUID();
  await sql()`
    insert into skills (
      id, source_id, path, name, description, version, sha, commit_sha, body,
      "references", runtimes, frontmatter, category, tags, removed_at, synced_at
    ) values (
      ${skillId}, ${sourceId}, ${`skills/${skillId}/SKILL.md`}, ${skillId}, 'fence', '1.0.0',
      ${"e".repeat(64)}, ${"f".repeat(40)}, 'original',
      '[]'::jsonb, ${JSON.stringify(ALL_RUNTIMES)}::jsonb, '{}'::jsonb, null, '[]'::jsonb, null, now()
    )
  `;
  await sql()`
    insert into skill_sync_runs (id, started_at, finished_at, trigger, status, summary, error)
    values (${runId}::uuid, now() - interval '11 minutes', null, 'manual', 'running', null, null)
  `;
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  let settled = false;
  try {
    await holder.query("begin");
    await holder.query("select id from skill_sync_runs where id = $1 for update", [runId]);
    const pending = upsertSkill(skillRecord(skillId, sourceId, `replacement ${CANARY}`), runId).then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    const started = Date.now();
    let sawWait = false;
    while (Date.now() - started < 2000 && !settled) {
      const waits = await holder.query(
        `select count(*)::int as n
         from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'`,
      );
      if (Number(waits.rows[0].n) > 0) {
        sawWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(settled, false, "an upsert must wait while the lease row is locked");
    assert.equal(sawWait, true);
    await holder.query(
      "update skill_sync_runs set status = 'failed', finished_at = now(), error = 'sync lease expired' where id = $1",
      [runId],
    );
    await holder.query("commit");
    await assert.rejects(pending, (err: unknown) => err instanceof SyncLeaseLost);
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end();
  }
  assert.equal(await skillBody(skillId), "original");
  assert.equal((await receiptsForSkill(skillId)).length, 0, "a lost lease writes no upsert receipt");
  const removed = await markSkillRemoved(skillId, new Date().toISOString(), runId).then(
    () => "wrote",
    (err: unknown) => err,
  );
  assert.ok(removed instanceof SyncLeaseLost);
  assert.equal(await removedAt(skillId), null);
}
