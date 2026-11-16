/**
 * Exact task-lane claim against the isolated PostgreSQL fixture.
 * Rows are synthetic. Nothing here reads or claims a live queue.
 * A present null, blank, or non-lane throws before SQL. Omitting the key
 * keeps the unfiltered claim. The candidate filter is in front of LIMIT,
 * and the guarded update checks the same lane again.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { runWithPrincipal } from "../src/lib/actor";
import { createCredential, revokeCredential } from "../src/lib/credentials";
import { sql } from "../src/lib/db";
import { acquireStream, registerStreamConsumer } from "../src/lib/events-stream";
import { claimNextTask, claimTaskWithCoverage } from "../src/lib/store";
import type { TaskNoticeObserverProof } from "../src/lib/task-queue-notice";
import type { Task } from "../src/lib/types";

const LANE = "agent-kontrol";
const HIGH = -2147483648;
const MATCH = -2147483647;
const ANY = -2147483646;
const PIN = -2147483645;

/** The harness URL is the connection target. Query host, port, or hostaddr would aim it elsewhere. */
function rejectUrlOverrides(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  for (const key of ["host", "port", "hostaddr"]) {
    if (url.searchParams.has(key)) throw new Error(`DATABASE_URL must not set ${key}`);
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") throw new Error("DATABASE_URL needs a host and a database");
}

export async function testTaskLaneClaims(): Promise<void> {
  rejectUrlOverrides();
  const stamp = randomUUID().replace(/-/g, "").slice(0, 12);
  const platform = `lane${stamp}`;
  const ids: string[] = [];
  const credentialIds: string[] = [];

  const add = async (fields: {
    title: string;
    project: string;
    platform: string;
    machine?: string | null;
    priority: number;
    reviewer?: string | null;
  }): Promise<string> => {
    const rows = await sql()`
      insert into tasks (title, project, platform, machine, priority, status, reviewer_platform)
      values (
        ${fields.title},
        ${fields.project},
        ${fields.platform},
        ${fields.machine ?? null},
        ${fields.priority},
        'queued',
        ${fields.reviewer ?? null}
      )
      returning id::text as id
    `;
    const id = String(rows[0].id);
    ids.push(id);
    return id;
  };
  const copies = async (
    n: number,
    fields: { title: string; project: string; platform: string; machine?: string | null; priority: number; reviewer?: string | null },
  ): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push(await add({ ...fields, title: `${fields.title} ${i}` }));
    return out;
  };
  const receipts = async (taskIds: string[]): Promise<number> => {
    const rows = await sql()`
      select count(*)::int as n from events
      where kind = 'task_claimed' and detail->>'task_id' = any(${taskIds}::text[])
    `;
    return Number(rows[0].n);
  };
  const taskOf = async (id: string) => {
    const rows = await sql()`select status, project, platform, machine from tasks where id = ${id}::bigint`;
    return rows[0] as { status: string; project: string; platform: string; machine: string | null };
  };
  const actorOf = async (id: string) => {
    const rows = await sql()`
      select detail->>'actor_type' as actor_type, detail->>'actor_id' as actor_id
      from events
      where kind = 'task_claimed' and detail->>'task_id' = ${id}
    `;
    assert.equal(rows.length, 1, `task ${id} receipt`);
    return rows[0] as { actor_type: string | null; actor_id: string | null };
  };
  const bind = async (): Promise<TaskNoticeObserverProof> => {
    const created = await createCredential({ label: `lane-${stamp}`, scopes: ["events:read"], rate_limit_per_minute: 1000 });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("credential");
    credentialIds.push(created.credential.id);
    const consumer = `l${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await registerStreamConsumer({
      id: consumer,
      credential_id: created.credential.id,
      repos: ["agent-kontrol/task-queue"],
      event_types: ["task-ready"],
      enabled: true,
    });
    const generation = await acquireStream(consumer, created.credential.id);
    return { consumer, credentialId: created.credential.id, generation };
  };
  const flipDuring = async <T>(id: string, nextProject: string, run: () => Promise<T>): Promise<T> => {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    const pid = await holder.query("select pg_backend_pid()::int as pid");
    const holderPid = Number(pid.rows[0].pid);
    assert.ok(Number.isInteger(holderPid) && holderPid > 0);
    let committed = false;
    let settled = false;
    let pending: Promise<T> | null = null;
    try {
      await holder.query("begin");
      const locked = await holder.query("select id::text as id from tasks where id = $1::bigint for update", [id]);
      assert.equal(locked.rows[0]?.id, id);
      pending = run();
      const deadline = Date.now() + 800;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await sql()`
          select count(*)::int as n
          from pg_stat_activity
          where pid <> ${holderPid}
            and ${holderPid} = any(pg_blocking_pids(pid))
            and query ilike '%update tasks%'
        `;
        if (Number(locks[0].n) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.equal(waiting, true, "claim update was not blocked by the holder");
      await holder.query("update tasks set project = $2 where id = $1::bigint", [id, nextProject]);
      await holder.query("commit");
      committed = true;
      const result = await pending;
      settled = true;
      return result;
    } finally {
      if (!committed) await holder.query("rollback").catch(() => undefined);
      if (!settled && pending) await pending.catch(() => undefined);
      await holder.end();
    }
  };

  try {
    const foreign = await sql()`
      select id::text as id, project, platform, priority
      from tasks
      where status = 'queued' and platform = 'any' and priority <= ${MATCH}
    `;
    assert.equal(foreign.length, 0, `queued platform=any rows would be claimed first: ${JSON.stringify(foreign)}`);

    await assert.rejects(
      () => claimNextTask({ platform, agent_id: `${stamp}-bad`, project: null }),
      /invalid task project filter/,
    );
    await assert.rejects(
      () => claimNextTask({ platform, agent_id: `${stamp}-bad`, project: "" }),
      /invalid task project filter/,
    );
    await assert.rejects(
      () => claimNextTask({ platform, agent_id: `${stamp}-bad`, project: `${LANE}\n` }),
      /invalid task project filter/,
    );
    await assert.rejects(
      () => claimTaskWithCoverage({ platform, agent_id: `${stamp}-bad`, project: "a".repeat(101), observer: null }),
      /invalid task project filter/,
    );
    assert.equal(ids.length, 0);

    const wrongProject = await copies(11, {
      title: `${stamp} chatterbuilt`,
      project: "chatterbuilt",
      platform,
      priority: HIGH,
      reviewer: "codex",
    });
    const wrongMachine = await copies(11, {
      title: `${stamp} other-box`,
      project: LANE,
      platform,
      machine: "other-box",
      priority: HIGH,
      reviewer: "codex",
    });
    const prefix = await add({ title: `${stamp} prefix`, project: `${LANE}-extra`, platform, priority: HIGH });
    const differentCase = await add({ title: `${stamp} case`, project: "Agent-Kontrol", platform, priority: HIGH });
    const match = await add({ title: `${stamp} match`, project: LANE, platform, priority: MATCH, reviewer: "codex" });
    const anyPlatform = await add({ title: `${stamp} any`, project: LANE, platform: "any", priority: ANY, reviewer: "codex" });
    const pinned = await add({ title: `${stamp} pinned`, project: LANE, platform, machine: "box-a", priority: PIN });

    const first = await claimNextTask({ platform, agent_id: `${stamp}-worker`, project: LANE });
    assert.equal(String(first?.id), match);
    assert.equal(first?.project, LANE);
    assert.equal(first?.machine ?? null, null);
    const second = await claimNextTask({ platform, agent_id: `${stamp}-worker`, project: LANE });
    assert.equal(String(second?.id), anyPlatform);
    assert.equal(second?.platform, "any");
    const third = await claimNextTask({ platform, machine: "box-a", agent_id: `${stamp}-worker`, project: LANE });
    assert.equal(String(third?.id), pinned);
    assert.equal(third?.machine, "box-a");
    const fourth = await claimNextTask({ platform, machine: "box-a", agent_id: `${stamp}-worker`, project: LANE });
    assert.equal(fourth, null);
    for (const id of [...wrongProject, ...wrongMachine, prefix, differentCase]) {
      assert.equal((await taskOf(id)).status, "queued", id);
    }
    assert.equal(await receipts([...wrongProject, ...wrongMachine, prefix, differentCase]), 0);
    assert.equal(await receipts([match, anyPlatform, pinned]), 3);

    const openPlatform = `open${stamp}`;
    const unfiltered = await add({ title: `${stamp} open`, project: "chatterbuilt", platform: openPlatform, priority: HIGH, reviewer: "codex" });
    await add({ title: `${stamp} later`, project: LANE, platform: openPlatform, priority: MATCH });
    const opened = await claimNextTask({ platform: openPlatform, agent_id: `${stamp}-worker` });
    assert.equal(String(opened?.id), unfiltered, "an omitted project still claims the first eligible row");

    const emptyPlatform = `empty${stamp}`;
    const lonely = await add({
      title: `${stamp} lonely`,
      project: "chatterbuilt",
      platform: emptyPlatform,
      priority: HIGH,
      reviewer: "codex",
    });
    assert.equal(await claimNextTask({ platform: emptyPlatform, agent_id: `${stamp}-worker`, project: LANE }), null);
    assert.equal(await receipts([lonely]), 0);
    assert.equal((await taskOf(lonely)).status, "queued");

    const racePlatform = `race${stamp}`;
    const raced = await add({ title: `${stamp} race`, project: LANE, platform: racePlatform, priority: MATCH });
    const racedClaim = await flipDuring(raced, "chatterbuilt", () =>
      claimNextTask({ platform: racePlatform, agent_id: `${stamp}-worker`, project: LANE }),
    );
    assert.equal(racedClaim, null);
    assert.equal((await taskOf(raced)).status, "queued");
    assert.equal((await taskOf(raced)).project, "chatterbuilt");
    assert.equal(await receipts([raced]), 0);

    const competePlatform = `cmp${stamp}`;
    const competed = await add({ title: `${stamp} compete`, project: LANE, platform: competePlatform, priority: MATCH });
    const pair = await Promise.all([
      claimNextTask({ platform: competePlatform, agent_id: `${stamp}-a`, project: LANE }),
      claimNextTask({ platform: competePlatform, agent_id: `${stamp}-b`, project: LANE }),
    ]);
    const winners = pair.filter((task): task is Task => task !== null);
    assert.equal(winners.length, 1);
    assert.equal(String(winners[0].id), competed);
    assert.equal(await receipts([competed]), 1);

    const coverageRacePlatform = `cvr${stamp}`;
    const coverageRaced = await add({ title: `${stamp} coverage-race`, project: LANE, platform: coverageRacePlatform, priority: MATCH });
    const proofForRace = await bind();
    const coverageFlipped = await flipDuring(coverageRaced, "chatterbuilt", () =>
      claimTaskWithCoverage({
        platform: coverageRacePlatform,
        agent_id: `${stamp}-worker`,
        project: LANE,
        observer: proofForRace,
      }),
    );
    assert.equal(coverageFlipped.task, null);
    assert.equal((await taskOf(coverageRaced)).status, "queued");
    assert.equal(await receipts([coverageRaced]), 0);

    const fn = `ak_lane_fail_receipt_${stamp}`;
    const version = Number((await sql()`select current_setting('server_version_num')::int as v`)[0].v);
    const execute = version >= 140000 ? "function" : "procedure";
    const ddl = new Client({ connectionString: process.env.DATABASE_URL });
    await ddl.connect();
    try {
      await ddl.query(`
        create function ${fn}() returns trigger
        language plpgsql as $fn$
        begin
          if new.kind = 'task_claimed' and position('AK_LANE_FAIL_RECEIPT' in coalesce(new.title, '')) > 0 then
            raise exception 'receipt failed';
          end if;
          return new;
        end;
        $fn$
      `);
      await ddl.query(`create trigger ${fn} before insert on events for each row execute ${execute} ${fn}()`);
      const failPlatform = `fail${stamp}`;
      const failed = await add({
        title: `${stamp} AK_LANE_FAIL_RECEIPT`,
        project: LANE,
        platform: failPlatform,
        priority: MATCH,
      });
      await assert.rejects(
        () => claimNextTask({ platform: failPlatform, agent_id: `${stamp}-worker`, project: LANE }),
        /receipt failed/,
      );
      assert.equal((await taskOf(failed)).status, "queued");
      assert.equal(await receipts([failed]), 0);
    } finally {
      await ddl.query(`drop trigger if exists ${fn} on events`).catch(() => undefined);
      await ddl.query(`drop function if exists ${fn}()`).catch(() => undefined);
      await ddl.end();
    }

    const covPlatform = `cov${stamp}`;
    const decoys = await copies(11, {
      title: `${stamp} cov-decoy`,
      project: "chatterbuilt",
      platform: covPlatform,
      priority: HIGH,
      reviewer: "codex",
    });
    const covIds = [];
    for (const title of ["valid", "wrong-gen", "revoked", "absent"]) {
      covIds.push(await add({ title: `${stamp} ${title}`, project: LANE, platform: covPlatform, priority: MATCH }));
    }
    const actor = `lane-actor-${stamp}`;
    const taskPrincipal = { kind: "agent" as const, id: actor, scopes: ["tasks:write"] };
    const validProof = await bind();
    const valid = await runWithPrincipal(taskPrincipal, () =>
      claimTaskWithCoverage({
        platform: covPlatform,
        agent_id: `${stamp}-worker`,
        project: LANE,
        observer: validProof,
      }),
    );
    assert.equal(String(valid.task?.id), covIds[0]);
    assert.equal(valid.task?.project, LANE);
    const validActor = await actorOf(covIds[0]);
    assert.equal(validActor.actor_type, "agent");
    assert.equal(validActor.actor_id, actor);
    assert.notEqual(validActor.actor_id, validProof.credentialId);

    const wrong = await runWithPrincipal(taskPrincipal, () =>
      claimTaskWithCoverage({
        platform: covPlatform,
        agent_id: `${stamp}-worker`,
        project: LANE,
        observer: { ...validProof, generation: "999999" },
      }),
    );
    assert.equal(String(wrong.task?.id), covIds[1]);
    assert.equal(wrong.task?.project, LANE);
    assert.equal(wrong.coverage.evidence, "unknown");
    assert.equal(wrong.coverage.queue_episode, null);
    assert.equal(wrong.coverage.notice_id, null);
    assert.equal((await actorOf(covIds[1])).actor_id, actor);

    const revokedProof = await bind();
    const revoked = await revokeCredential(revokedProof.credentialId);
    assert.ok(revoked?.revoked_at);
    const afterRevoke = await runWithPrincipal(taskPrincipal, () =>
      claimTaskWithCoverage({
        platform: covPlatform,
        agent_id: `${stamp}-worker`,
        project: LANE,
        observer: revokedProof,
      }),
    );
    assert.equal(String(afterRevoke.task?.id), covIds[2]);
    assert.equal(afterRevoke.task?.project, LANE);
    assert.equal(afterRevoke.coverage.evidence, "unknown");
    assert.equal(afterRevoke.coverage.queue_episode, null);
    assert.equal(afterRevoke.coverage.notice_id, null);
    assert.equal((await actorOf(covIds[2])).actor_id, actor);

    const absent = await runWithPrincipal(taskPrincipal, () =>
      claimTaskWithCoverage({
        platform: covPlatform,
        agent_id: `${stamp}-worker`,
        project: LANE,
        observer: null,
      }),
    );
    assert.equal(String(absent.task?.id), covIds[3]);
    assert.equal(absent.task?.project, LANE);
    assert.equal(absent.coverage.reason, "ineligible_observer");
    assert.equal(absent.coverage.queue_episode, null);
    assert.equal((await actorOf(covIds[3])).actor_id, actor);
    for (const id of decoys) assert.equal((await taskOf(id)).status, "queued");
    assert.equal(await receipts(decoys), 0);
  } finally {
    if (ids.length) {
      await sql()`update tasks set status = 'cancelled', updated_at = now() where id = any(${ids}::bigint[]) and status = 'queued'`;
    }
    for (const id of credentialIds) await revokeCredential(id);
  }
}
