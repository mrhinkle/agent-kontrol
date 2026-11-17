/**
 * Exact task_id claim against the isolated PostgreSQL fixture.
 * The database name comes from DATABASE_URL. Rows are synthetic.
 * A supplied id claims that queued row only. Eleven better-priority rows
 * stay queued, which is the case LIMIT 10 would hide. A miss writes nothing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { runWithPrincipal } from "../src/lib/actor";
import { createCredential, revokeCredential } from "../src/lib/credentials";
import { sql } from "../src/lib/db";
import { acquireStream, registerStreamConsumer } from "../src/lib/events-stream";
import { claimNextTask, claimTaskWithCoverage, report, slugify } from "../src/lib/store";
import type { TaskNoticeObserverProof } from "../src/lib/task-queue-notice";
import type { Principal } from "../src/lib/scopes";
import type { Task } from "../src/lib/types";

const HIGH = -2147483648;
const LOW = 2147483647;

function rejectUrlOverrides(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  for (const key of ["host", "port", "hostaddr"]) {
    if (url.searchParams.has(key)) throw new Error(`DATABASE_URL must not set ${key}`);
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") throw new Error("DATABASE_URL needs a host and a database");
}

function asId(id: string): number {
  const value = Number(id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`task id ${id} is outside the public safe range`);
  return value;
}

export async function testTargetedClaims(): Promise<void> {
  rejectUrlOverrides();
  const stamp = randomUUID().replace(/-/g, "").slice(0, 12);
  const lane = `t${stamp}`;
  const otherLane = `o${stamp}`;
  const ids: string[] = [];
  const credentialIds: string[] = [];
  const receiptFn = `ak_tgt_receipt_${stamp}`;
  const reportFn = `ak_tgt_report_${stamp}`;
  let receiptInstalled = false;
  let reportInstalled = false;

  const add = async (fields: {
    title: string;
    project: string;
    platform: string;
    machine?: string | null;
    priority: number;
  }): Promise<string> => {
    const rows = await sql()`
      insert into tasks (title, project, platform, machine, priority, status)
      values (
        ${fields.title},
        ${fields.project},
        ${fields.platform},
        ${fields.machine ?? null},
        ${fields.priority},
        'queued'
      )
      returning id::text as id
    `;
    const id = String(rows[0].id);
    ids.push(id);
    return id;
  };
  const copies = async (n: number, fields: {
    title: string;
    project: string;
    platform: string;
    machine?: string | null;
    priority: number;
  }): Promise<string[]> => {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) out.push(await add({ ...fields, title: `${fields.title} ${i}` }));
    return out;
  };
  const receipts = async (taskIds: string[]): Promise<number> => {
    if (!taskIds.length) return 0;
    const rows = await sql()`
      select count(*)::int as n from events
      where kind = 'task_claimed' and detail->>'task_id' = any(${taskIds}::text[])
    `;
    return Number(rows[0].n);
  };
  const statusOf = async (id: string): Promise<string> => {
    const rows = await sql()`select status from tasks where id = ${id}::bigint`;
    return String(rows[0].status);
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
  const agentCount = async (agentId: string): Promise<number> => {
    const rows = await sql()`select count(*)::int as n from agents where id = ${slugify(agentId)}`;
    return Number(rows[0].n);
  };
  const bind = async (): Promise<TaskNoticeObserverProof> => {
    const created = await createCredential({ label: `tgt-${stamp}-${credentialIds.length}`, scopes: ["events:read"], rate_limit_per_minute: 1000 });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("credential");
    credentialIds.push(created.credential.id);
    const consumer = `t${randomUUID().replace(/-/g, "").slice(0, 20)}`;
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
  const principal = (id: string): Principal => ({ kind: "agent", id, scopes: ["tasks:write"] });
  const flipDuring = async <T>(id: string, sqlText: string, next: string, run: () => Promise<T>): Promise<T> => {
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
      await holder.query(sqlText, [id, next]);
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
  const dropFn = async (name: string, table: string): Promise<void> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(`drop trigger if exists ${name} on ${table}`);
      await client.query(`drop function if exists ${name}()`);
    } finally {
      await client.end();
    }
  };

  try {
    await assert.rejects(
      () => claimNextTask({ platform: `bad${stamp}`, agent_id: `${stamp}-bad`, task_id: 0 }),
      /invalid task id filter/,
    );
    await assert.rejects(
      () => claimTaskWithCoverage({
        platform: `bad${stamp}`,
        agent_id: `${stamp}-bad`,
        task_id: Number.NaN,
        observer: null,
      }),
      /invalid task id filter/,
    );
    assert.equal(ids.length, 0);

    const beyondPlatform = `bey${stamp}`;
    const competitors = await copies(11, {
      title: `${stamp} better`,
      project: lane,
      platform: beyondPlatform,
      priority: HIGH,
    });
    const target = await add({
      title: `${stamp} target`,
      project: lane,
      platform: beyondPlatform,
      priority: LOW,
    });
    const beyond = await runWithPrincipal(principal(`actor-beyond-${stamp}`), () =>
      claimNextTask({
        platform: beyondPlatform,
        agent_id: `${stamp}-beyond`,
        project: lane,
        task_id: asId(target),
      }),
    );
    assert.equal(String(beyond?.id), target);
    assert.equal(await statusOf(target), "claimed");
    for (const id of competitors) assert.equal(await statusOf(id), "queued", id);
    assert.equal(await receipts(competitors), 0);
    assert.equal(await receipts([target]), 1);
    const beyondActor = await actorOf(target);
    assert.equal(beyondActor.actor_type, "agent");
    assert.equal(beyondActor.actor_id, `actor-beyond-${stamp}`);

    const orderPlatform = `ord${stamp}`;
    const best = await add({ title: `${stamp} best`, project: lane, platform: orderPlatform, priority: HIGH });
    const worse = await add({ title: `${stamp} worse`, project: lane, platform: orderPlatform, priority: LOW });
    const ordered = await claimNextTask({ platform: orderPlatform, agent_id: `${stamp}-order`, project: lane });
    assert.equal(String(ordered?.id), best);
    assert.equal(await statusOf(worse), "queued");
    assert.equal(await receipts([worse]), 0);

    const missingPlatform = `mis${stamp}`;
    const stillThere = await add({ title: `${stamp} stays`, project: lane, platform: missingPlatform, priority: HIGH });
    const missing = await claimNextTask({
      platform: missingPlatform,
      agent_id: `${stamp}-miss`,
      project: lane,
      task_id: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(missing, null);
    assert.equal(await statusOf(stillThere), "queued");
    assert.equal(await receipts([stillThere]), 0);

    const projectPlatform = `prj${stamp}`;
    const wrongProject = await add({ title: `${stamp} other-project`, project: otherLane, platform: projectPlatform, priority: HIGH });
    const projectMiss = await claimNextTask({
      platform: projectPlatform,
      agent_id: `${stamp}-project`,
      project: lane,
      task_id: asId(wrongProject),
    });
    assert.equal(projectMiss, null);
    assert.equal(await statusOf(wrongProject), "queued");
    assert.equal(await receipts([wrongProject]), 0);
    const projectHit = await claimNextTask({
      platform: projectPlatform,
      agent_id: `${stamp}-project`,
      project: otherLane,
      task_id: asId(wrongProject),
    });
    assert.equal(String(projectHit?.id), wrongProject);

    const casePlatform = `cse${stamp}`;
    const mixedCase = await add({ title: `${stamp} case`, project: `T${stamp}`, platform: casePlatform, priority: HIGH });
    const caseMiss = await claimNextTask({
      platform: casePlatform,
      agent_id: `${stamp}-case`,
      project: `t${stamp}`,
      task_id: asId(mixedCase),
    });
    assert.equal(caseMiss, null);
    assert.equal(await statusOf(mixedCase), "queued");
    const caseHit = await claimNextTask({
      platform: casePlatform,
      agent_id: `${stamp}-case`,
      project: `T${stamp}`,
      task_id: asId(mixedCase),
    });
    assert.equal(String(caseHit?.id), mixedCase);

    const openPlatform = `opn${stamp}`;
    const opener = await add({ title: `${stamp} opener`, project: otherLane, platform: openPlatform, priority: LOW });
    const openDecoy = await add({ title: `${stamp} open-decoy`, project: lane, platform: openPlatform, priority: HIGH });
    const opened = await claimNextTask({
      platform: openPlatform,
      agent_id: `${stamp}-open`,
      task_id: asId(opener),
    });
    assert.equal(String(opened?.id), opener);
    assert.equal(await statusOf(openDecoy), "queued");
    assert.equal(await receipts([openDecoy]), 0);

    const machinePlatform = `mac${stamp}`;
    const unassigned = await add({ title: `${stamp} free`, project: lane, platform: machinePlatform, priority: LOW });
    const pinned = await add({ title: `${stamp} pinned`, project: lane, platform: machinePlatform, machine: "box-a", priority: HIGH });
    const otherBox = await add({ title: `${stamp} other-box`, project: lane, platform: machinePlatform, machine: "box-b", priority: HIGH });
    const free = await claimNextTask({
      platform: machinePlatform,
      machine: "box-a",
      agent_id: `${stamp}-machine`,
      project: lane,
      task_id: asId(unassigned),
    });
    assert.equal(String(free?.id), unassigned);
    const wrongBox = await claimNextTask({
      platform: machinePlatform,
      machine: "box-a",
      agent_id: `${stamp}-machine`,
      project: lane,
      task_id: asId(otherBox),
    });
    assert.equal(wrongBox, null);
    const wrongPin = await claimNextTask({
      platform: machinePlatform,
      machine: "box-b",
      agent_id: `${stamp}-machine`,
      project: lane,
      task_id: asId(pinned),
    });
    assert.equal(wrongPin, null);
    assert.equal(await statusOf(pinned), "queued");
    const exactBox = await claimNextTask({
      platform: machinePlatform,
      machine: "box-a",
      agent_id: `${stamp}-machine`,
      project: lane,
      task_id: asId(pinned),
    });
    assert.equal(String(exactBox?.id), pinned);
    assert.equal(exactBox?.machine, "box-a");
    const unfilteredPinned = await add({ title: `${stamp} pinned-2`, project: lane, platform: machinePlatform, machine: "box-a", priority: HIGH });
    const noMachine = await claimNextTask({
      platform: machinePlatform,
      agent_id: `${stamp}-machine`,
      project: lane,
      task_id: asId(unfilteredPinned),
    });
    assert.equal(noMachine, null);
    assert.equal(await statusOf(unfilteredPinned), "queued");
    assert.equal(await statusOf(otherBox), "queued");
    assert.equal(await receipts([otherBox, unfilteredPinned]), 0);

    const anyPlatform = `req${stamp}`;
    const anyRow = await add({ title: `${stamp} any`, project: lane, platform: "any", priority: LOW });
    const anyDecoy = await add({ title: `${stamp} any-decoy`, project: lane, platform: anyPlatform, priority: HIGH });
    const anyClaim = await claimNextTask({
      platform: anyPlatform,
      agent_id: `${stamp}-any`,
      project: lane,
      task_id: asId(anyRow),
    });
    assert.equal(String(anyClaim?.id), anyRow);
    assert.equal(anyClaim?.platform, "any");
    assert.equal(await statusOf(anyDecoy), "queued");

    const wrongPlatform = `wrg${stamp}`;
    const foreign = await add({ title: `${stamp} foreign`, project: lane, platform: `no${stamp}`, priority: HIGH });
    const platformMiss = await claimNextTask({
      platform: wrongPlatform,
      agent_id: `${stamp}-platform`,
      project: lane,
      task_id: asId(foreign),
    });
    assert.equal(platformMiss, null);
    assert.equal(await statusOf(foreign), "queued");
    assert.equal(await receipts([foreign]), 0);

    const donePlatform = `dne${stamp}`;
    const doneRow = await add({ title: `${stamp} done`, project: lane, platform: donePlatform, priority: LOW });
    const doneDecoy = await add({ title: `${stamp} done-decoy`, project: lane, platform: donePlatform, priority: HIGH });
    await sql()`update tasks set status = 'done' where id = ${doneRow}::bigint`;
    const doneClaim = await claimNextTask({
      platform: donePlatform,
      agent_id: `${stamp}-done`,
      project: lane,
      task_id: asId(doneRow),
    });
    assert.equal(doneClaim, null);
    assert.equal(await statusOf(doneRow), "done");
    assert.equal(await statusOf(doneDecoy), "queued");
    assert.equal(await receipts([doneRow, doneDecoy]), 0);

    const racePlatform = `rce${stamp}`;
    const raced = await add({ title: `${stamp} race`, project: lane, platform: racePlatform, priority: LOW });
    const raceDecoy = await add({ title: `${stamp} race-decoy`, project: lane, platform: racePlatform, priority: HIGH });
    const racedClaim = await flipDuring(
      raced,
      "update tasks set project = $2 where id = $1::bigint",
      otherLane,
      () => claimNextTask({
        platform: racePlatform,
        agent_id: `${stamp}-race`,
        project: lane,
        task_id: asId(raced),
      }),
    );
    assert.equal(racedClaim, null);
    assert.equal(await statusOf(raced), "queued");
    assert.equal(await statusOf(raceDecoy), "queued");
    assert.equal(await receipts([raced, raceDecoy]), 0);

    const statusPlatform = `sts${stamp}`;
    const statusRow = await add({ title: `${stamp} status-race`, project: lane, platform: statusPlatform, priority: LOW });
    const statusClaim = await flipDuring(
      statusRow,
      "update tasks set status = $2 where id = $1::bigint",
      "running",
      () => claimTaskWithCoverage({
        platform: statusPlatform,
        agent_id: `${stamp}-status`,
        project: lane,
        task_id: asId(statusRow),
        observer: null,
      }),
    );
    assert.equal(statusClaim.task, null);
    assert.equal(statusClaim.coverage.reason, "ineligible_observer");
    assert.equal(statusClaim.coverage.queue_episode, null);
    assert.equal(statusClaim.coverage.notice_id, null);
    assert.equal(await statusOf(statusRow), "running");
    assert.equal(await receipts([statusRow]), 0);

    const raceActorA = `actor-a-${stamp}`;
    const raceActorB = `actor-b-${stamp}`;
    const competePlatform = `cmp${stamp}`;
    const competed = await add({ title: `${stamp} compete`, project: lane, platform: competePlatform, priority: LOW });
    const competeDecoy = await add({ title: `${stamp} compete-decoy`, project: lane, platform: competePlatform, priority: HIGH });
    const pair = await Promise.all([
      runWithPrincipal(principal(raceActorA), () => claimNextTask({
        platform: competePlatform,
        agent_id: `${stamp}-a`,
        project: lane,
        task_id: asId(competed),
      })),
      runWithPrincipal(principal(raceActorB), () => claimNextTask({
        platform: competePlatform,
        agent_id: `${stamp}-b`,
        project: lane,
        task_id: asId(competed),
      })),
    ]);
    const winners = pair.filter((task): task is Task => task !== null);
    assert.equal(winners.length, 1);
    assert.equal(String(winners[0].id), competed);
    assert.equal(await statusOf(competeDecoy), "queued");
    assert.equal(await receipts([competed]), 1);
    assert.equal(await receipts([competeDecoy]), 0);
    const winnerActor = await actorOf(competed);
    const winnerPrincipal = winners[0].assigned_agent === `${stamp}-a` ? raceActorA : raceActorB;
    assert.equal(winnerActor.actor_type, "agent");
    assert.equal(winnerActor.actor_id, winnerPrincipal);
    assert.notEqual(winnerActor.actor_id, winners[0].assigned_agent);

    const coverPlatform = `cov${stamp}`;
    const coverDecoys = await copies(11, {
      title: `${stamp} cover-decoy`,
      project: lane,
      platform: coverPlatform,
      priority: HIGH,
    });
    const coverIds: string[] = [];
    for (const title of ["valid", "wrong-gen", "revoked", "wrong-cred", "absent", "miss"]) {
      coverIds.push(await add({ title: `${stamp} ${title}`, project: lane, platform: coverPlatform, priority: LOW }));
    }
    const coverActor = `actor-cover-${stamp}`;
    const validProof = await bind();
    const valid = await runWithPrincipal(principal(coverActor), () => claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: lane,
      task_id: asId(coverIds[0]),
      observer: validProof,
    }));
    assert.equal(String(valid.task?.id), coverIds[0]);
    assert.equal(valid.coverage.notice_id, null);
    assert.equal(valid.coverage.queue_episode, null);
    const validActor = await actorOf(coverIds[0]);
    assert.equal(validActor.actor_type, "agent");
    assert.equal(validActor.actor_id, coverActor);
    assert.notEqual(validActor.actor_id, validProof.credentialId);

    const wrongGen = await runWithPrincipal(principal(coverActor), () => claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: lane,
      task_id: asId(coverIds[1]),
      observer: { ...validProof, generation: "999999" },
    }));
    assert.equal(String(wrongGen.task?.id), coverIds[1]);
    assert.equal(wrongGen.coverage.evidence, "unknown");
    assert.equal(wrongGen.coverage.queue_episode, null);
    assert.equal(wrongGen.coverage.notice_id, null);
    assert.equal((await actorOf(coverIds[1])).actor_id, coverActor);

    const revokedProof = await bind();
    const revoked = await revokeCredential(revokedProof.credentialId);
    assert.ok(revoked?.revoked_at);
    const afterRevoke = await runWithPrincipal(principal(coverActor), () => claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: lane,
      task_id: asId(coverIds[2]),
      observer: revokedProof,
    }));
    assert.equal(String(afterRevoke.task?.id), coverIds[2]);
    assert.equal(afterRevoke.coverage.evidence, "unknown");
    assert.equal(afterRevoke.coverage.queue_episode, null);
    assert.equal(afterRevoke.coverage.notice_id, null);

    const otherCred = await createCredential({ label: `tgt-other-${stamp}`, scopes: ["events:read"], rate_limit_per_minute: 1000 });
    assert.equal(otherCred.ok, true);
    if (!otherCred.ok) throw new Error("other credential");
    credentialIds.push(otherCred.credential.id);
    const wrongCred = await runWithPrincipal(principal(coverActor), () => claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: lane,
      task_id: asId(coverIds[3]),
      observer: { ...validProof, credentialId: otherCred.credential.id },
    }));
    assert.equal(String(wrongCred.task?.id), coverIds[3]);
    assert.equal(wrongCred.coverage.evidence, "unknown");
    assert.equal(wrongCred.coverage.queue_episode, null);
    assert.equal(wrongCred.coverage.notice_id, null);
    assert.equal(JSON.stringify(wrongCred.coverage).includes(coverIds[4]), false);

    const absent = await runWithPrincipal(principal(coverActor), () => claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: lane,
      task_id: asId(coverIds[4]),
      observer: null,
    }));
    assert.equal(String(absent.task?.id), coverIds[4]);
    assert.equal(absent.coverage.reason, "ineligible_observer");
    assert.equal(absent.coverage.queue_episode, null);
    assert.equal(absent.coverage.notice_id, null);
    assert.equal((await actorOf(coverIds[4])).actor_id, coverActor);

    const eligibleMiss = await runWithPrincipal(principal(coverActor), () => claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: lane,
      task_id: Number.MAX_SAFE_INTEGER,
      observer: validProof,
    }));
    assert.equal(eligibleMiss.task, null);
    assert.equal(eligibleMiss.coverage.reason, "no_claim");
    assert.equal(eligibleMiss.coverage.evidence, "unknown");
    assert.equal(eligibleMiss.coverage.queue_episode, null);
    assert.equal(eligibleMiss.coverage.notice_id, null);
    assert.equal(await statusOf(coverIds[5]), "queued");

    const nullMiss = await claimTaskWithCoverage({
      platform: coverPlatform,
      agent_id: `${stamp}-cover`,
      project: otherLane,
      task_id: asId(coverIds[5]),
      observer: null,
    });
    assert.equal(nullMiss.task, null);
    assert.equal(nullMiss.coverage.reason, "ineligible_observer");
    assert.equal(nullMiss.coverage.queue_episode, null);
    assert.equal(nullMiss.coverage.notice_id, null);
    assert.equal(await statusOf(coverIds[5]), "queued");
    for (const id of coverDecoys) assert.equal(await statusOf(id), "queued", id);
    assert.equal(await receipts(coverDecoys), 0);
    assert.equal(await receipts([coverIds[5]]), 0);

    const version = Number((await sql()`select current_setting('server_version_num')::int as v`)[0].v);
    const execute = version >= 140000 ? "function" : "procedure";
    const ddl = new Client({ connectionString: process.env.DATABASE_URL });
    await ddl.connect();
    try {
      await ddl.query(`
        create function ${receiptFn}() returns trigger
        language plpgsql as $fn$
        begin
          if new.kind = 'task_claimed' and position('AK_TARGET_RAISE' in coalesce(new.title, '')) > 0 then
            raise exception 'receipt failed';
          end if;
          if new.kind = 'task_claimed' and position('AK_TARGET_SUPPRESS' in coalesce(new.title, '')) > 0 then
            return null;
          end if;
          return new;
        end;
        $fn$
      `);
      await ddl.query(`create trigger ${receiptFn} before insert on events for each row execute ${execute} ${receiptFn}()`);
      receiptInstalled = true;
      const raised = await add({ title: `${stamp} AK_TARGET_RAISE`, project: lane, platform: `rse${stamp}`, priority: LOW });
      const suppressed = await add({ title: `${stamp} AK_TARGET_SUPPRESS`, project: lane, platform: `sup${stamp}`, priority: LOW });
      const raisedCoverage = await add({ title: `${stamp} AK_TARGET_RAISE cover`, project: lane, platform: `rcv${stamp}`, priority: LOW });
      const suppressedCoverage = await add({ title: `${stamp} AK_TARGET_SUPPRESS cover`, project: lane, platform: `scv${stamp}`, priority: LOW });
      await assert.rejects(
        () => claimNextTask({ platform: `rse${stamp}`, agent_id: `${stamp}-raise`, project: lane, task_id: asId(raised) }),
        /receipt failed/,
      );
      await assert.rejects(
        () => claimNextTask({ platform: `sup${stamp}`, agent_id: `${stamp}-suppress`, project: lane, task_id: asId(suppressed) }),
        /claim receipt was not stored/,
      );
      const proof = await bind();
      await assert.rejects(
        () => claimTaskWithCoverage({
          platform: `rcv${stamp}`,
          agent_id: `${stamp}-raise-cover`,
          project: lane,
          task_id: asId(raisedCoverage),
          observer: proof,
        }),
        /receipt failed/,
      );
      await assert.rejects(
        () => claimTaskWithCoverage({
          platform: `scv${stamp}`,
          agent_id: `${stamp}-suppress-cover`,
          project: lane,
          task_id: asId(suppressedCoverage),
          observer: proof,
        }),
        /claim receipt was not stored/,
      );
      for (const id of [raised, suppressed, raisedCoverage, suppressedCoverage]) {
        assert.equal(await statusOf(id), "queued", id);
      }
      assert.equal(await receipts([raised, suppressed, raisedCoverage, suppressedCoverage]), 0);
    } finally {
      await ddl.query(`drop trigger if exists ${receiptFn} on events`).catch(() => undefined);
      await ddl.query(`drop function if exists ${receiptFn}()`).catch(() => undefined);
      receiptInstalled = false;
      await ddl.end();
    }

    const reportPlatform = `rpt${stamp}`;
    const reported = await add({ title: `${stamp} report`, project: lane, platform: reportPlatform, priority: LOW });
    const reporter = `${stamp}-reporter`;
    assert.equal(await agentCount(reporter), 0);
    const reportedTask = await claimNextTask({
      platform: reportPlatform,
      agent_id: reporter,
      project: lane,
      task_id: asId(reported),
    });
    assert.equal(String(reportedTask?.id), reported);
    assert.equal(await agentCount(reporter), 0, "the claim statement does not write the status report");
    assert.equal(await receipts([reported]), 1);
    await report({
      agent_id: reporter,
      platform: reportPlatform,
      kind: "status",
      title: `Claimed task #${reported}`,
      detail: { task_id: asId(reported) },
    });
    assert.equal(await agentCount(reporter), 1);

    const failAgent = `${stamp}-report-fail`;
    const failPlatform = `rpf${stamp}`;
    const failRow = await add({ title: `${stamp} report-fail`, project: lane, platform: failPlatform, priority: LOW });
    const failClient = new Client({ connectionString: process.env.DATABASE_URL });
    await failClient.connect();
    try {
      await failClient.query(`
        create function ${reportFn}() returns trigger
        language plpgsql as $fn$
        begin
          if new.id = '${slugify(failAgent)}' then
            raise exception 'report failed';
          end if;
          return new;
        end;
        $fn$
      `);
      await failClient.query(`create trigger ${reportFn} before insert on agents for each row execute ${execute} ${reportFn}()`);
      reportInstalled = true;
      const failedReportTask = await claimNextTask({
        platform: failPlatform,
        agent_id: `${stamp}-held`,
        project: lane,
        task_id: asId(failRow),
      });
      assert.equal(String(failedReportTask?.id), failRow);
      await assert.rejects(
        () => report({
          agent_id: failAgent,
          platform: failPlatform,
          kind: "status",
          title: "status after claim",
          detail: { task_id: asId(failRow) },
        }),
        /report failed/,
      );
      assert.equal(await statusOf(failRow), "claimed");
      assert.equal(await receipts([failRow]), 1);
      assert.equal(await agentCount(failAgent), 0);
    } finally {
      await failClient.query(`drop trigger if exists ${reportFn} on agents`).catch(() => undefined);
      await failClient.query(`drop function if exists ${reportFn}()`).catch(() => undefined);
      reportInstalled = false;
      await failClient.end();
    }
  } finally {
    if (receiptInstalled) await dropFn(receiptFn, "events");
    if (reportInstalled) await dropFn(reportFn, "agents");
    if (ids.length) {
      await sql()`update tasks set status = 'cancelled', updated_at = now() where id = any(${ids}::bigint[]) and status = 'queued'`;
    }
    for (const id of credentialIds) await revokeCredential(id);
  }
}
