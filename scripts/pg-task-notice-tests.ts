/**
 * Real PostgreSQL coverage for the queue episode and optional notice.
 * The string fakes do not plan UPDATE ... FROM, so they missed the ambiguous
 * status. These cases run the store statements on the isolated fixture only.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createCredential } from "../src/lib/credentials";
import { sql } from "../src/lib/db";
import { acquireStream, registerStreamConsumer } from "../src/lib/events-stream";
import { claimTaskWithCoverage, createTask, readTaskForPreview, updateTask } from "../src/lib/store";
import type { TaskNoticeObserverProof } from "../src/lib/task-queue-notice";
import type { Task } from "../src/lib/types";

const PRODUCER = "AK_TASK_NOTICE_PRODUCER";
const PRIORITY = -2147483648;

type Marker = { id: string };
type Notice = { id: string; delivery_id: string; event: string; repo: string; payload: Record<string, unknown> };

export async function testTaskQueueNotices(): Promise<void> {
  const tag = `notice-${randomUUID().slice(0, 8)}`;
  const platform = `pg-${tag}`;
  const machine = `box-${tag}`;
  const taskIds: string[] = [];
  const credentialIds: string[] = [];
  const consumerIds: string[] = [];
  const idempotencyKeys: string[] = [];
  const previous = process.env[PRODUCER];
  delete process.env[PRODUCER];

  const markers = async (id: number): Promise<Marker[]> =>
    await sql()`select id::text as id from events
      where detail->'_ak_task_queue_v1'->>'task_id' = ${String(id)}
      order by events.id` as Marker[];
  const notices = async (id: number): Promise<Notice[]> =>
    await sql()`select id::text as id, delivery_id, event, repo, payload from gh_events
      where event = 'task-ready' and payload->>'task_id' = ${String(id)}
      order by gh_events.id` as Notice[];
  const make = async (title: string, idempotencyKey?: string): Promise<Task> => {
    const task = await createTask({
      title: `${tag} ${title}`,
      platform,
      machine,
      priority: PRIORITY,
      idempotency_key: idempotencyKey,
    });
    const id = String(task.id);
    if (!taskIds.includes(id)) taskIds.push(id);
    return task;
  };
  const assertNoticeShape = (task: Task, episodeId: string, notice: Notice) => {
    assert.equal(notice.event, "task-ready");
    assert.equal(notice.repo, "agent-kontrol/task-queue");
    assert.equal(notice.delivery_id, `task:ready:${task.id}:${episodeId}`);
    assert.deepEqual(Object.keys(notice.payload).sort(), ["machine", "platform", "queue_receipt_id", "task_id", "v"]);
    assert.equal(notice.payload.v, 1);
    assert.equal(notice.payload.task_id, String(task.id));
    assert.equal(notice.payload.queue_receipt_id, episodeId);
    assert.equal(notice.payload.platform, platform);
    assert.equal(notice.payload.machine, machine);
    assert.equal(JSON.stringify(notice.payload).includes(task.title), false);
  };
  const bind = async (eventType: string): Promise<TaskNoticeObserverProof> => {
    const created = await createCredential({ label: tag, scopes: ["events:read"], rate_limit_per_minute: 1000 });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("credential");
    credentialIds.push(created.credential.id);
    const consumer = `n${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await registerStreamConsumer({
      id: consumer,
      credential_id: created.credential.id,
      repos: ["agent-kontrol/task-queue"],
      event_types: [eventType],
      enabled: true,
    });
    consumerIds.push(consumer);
    const generation = await acquireStream(consumer, created.credential.id);
    return { consumer, credentialId: created.credential.id, generation };
  };
  const claim = async (task: Task, observer: TaskNoticeObserverProof | null) => {
    const ahead = await sql()`select count(*)::int as n from tasks
      where status = 'queued' and id <> ${task.id}
        and platform = any(${[platform, "any"]}::text[])
        and (priority < ${task.priority} or (priority = ${task.priority} and created_at <= ${task.created_at}))`;
    assert.equal(Number(ahead[0].n), 0, "another queued task would be claimed first");
    return claimTaskWithCoverage({ platform, machine, agent_id: `${tag}-agent`, observer });
  };

  try {
    const off = await make("off");
    assert.equal((await markers(off.id)).length, 1);
    assert.equal((await notices(off.id)).length, 0);
    await updateTask({ id: off.id, result: "unrelated" });
    await updateTask({ id: off.id, status: "queued" });
    assert.equal((await markers(off.id)).length, 1, "queued edits keep the same episode");
    assert.equal((await notices(off.id)).length, 0);
    await updateTask({ id: off.id, status: "failed" });
    await updateTask({ id: off.id, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    assert.equal((await markers(off.id)).length, 2, "a real requeue allocates a new episode");
    assert.equal((await notices(off.id)).length, 0, "producer off writes no notice");

    const replayKey = `${tag}-off`;
    idempotencyKeys.push(replayKey);
    const replayOff = await make("replay-off", replayKey);
    const replayOffAgain = await make("replay-off", replayKey);
    assert.equal(replayOffAgain.id, replayOff.id);
    assert.equal((await markers(replayOff.id)).length, 1);
    assert.equal((await notices(replayOff.id)).length, 0);

    process.env[PRODUCER] = "1";
    const on = await make("on");
    const onMarkers = await markers(on.id);
    const onNotices = await notices(on.id);
    assert.equal(onMarkers.length, 1);
    assert.equal(onNotices.length, 1);
    assertNoticeShape(on, onMarkers[0].id, onNotices[0]);
    await updateTask({ id: on.id, status: "queued" });
    const preview = await readTaskForPreview(on.id);
    assert.ok(preview);
    await updateTask({ id: on.id, status: "queued", expected_revision: preview.revision });
    assert.equal((await markers(on.id)).length, 1);
    assert.equal((await notices(on.id)).length, 1, "queued-to-queued writes no second notice");

    await updateTask({ id: on.id, status: "failed" });
    const beforeRequeue = await readTaskForPreview(on.id);
    assert.ok(beforeRequeue);
    const requeued = await updateTask({
      id: on.id,
      status: "queued",
      expected_revision: beforeRequeue.revision,
      eventKind: "task_requeued",
      activityTool: "requeue_task",
    });
    assert.equal(requeued.status, "queued");
    const requeuedMarkers = await markers(on.id);
    const requeuedNotices = await notices(on.id);
    assert.equal(requeuedMarkers.length, 2);
    assert.equal(requeuedNotices.length, 2);
    assertNoticeShape(on, requeuedMarkers[1].id, requeuedNotices[1]);

    delete process.env[PRODUCER];
    await updateTask({ id: off.id, status: "failed" });
    process.env[PRODUCER] = "1";
    await updateTask({ id: off.id, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    const late = await notices(off.id);
    const lateMarkers = await markers(off.id);
    assert.equal(lateMarkers.length, 3);
    assert.equal(late.length, 1, "turning the producer on does not backfill older episodes");
    assert.equal(late[0].delivery_id, `task:ready:${off.id}:${lateMarkers[2].id}`);

    const onKey = `${tag}-on`;
    idempotencyKeys.push(onKey);
    const replayOn = await make("replay-on", onKey);
    const replayOnAgain = await make("replay-on", onKey);
    assert.equal(replayOnAgain.id, replayOn.id);
    assert.equal((await markers(replayOn.id)).length, 1);
    assert.equal((await notices(replayOn.id)).length, 1);

    if (taskIds.length) {
      await sql()`update tasks set status = 'cancelled', updated_at = now()
        where id = any(${taskIds}::bigint[]) and status = 'queued'`;
    }

    delete process.env[PRODUCER];
    const silent = await make("silent-claim");
    const silentClaim = await claim(silent, null);
    assert.equal(silentClaim.task?.id, silent.id);
    assert.equal(silentClaim.task?.status, "claimed");
    assert.equal(silentClaim.coverage.evidence, "unknown");
    assert.equal(silentClaim.coverage.reason, "ineligible_observer");
    assert.equal(silentClaim.coverage.queue_episode, null);
    assert.equal(silentClaim.coverage.notice_id, null);
    assert.equal("queue_episode" in (silentClaim.task ?? {}), false);

    const unbound = await make("unbound-claim");
    const unboundClaim = await claim(unbound, { consumer: "missing-consumer", credentialId: "missing-credential", generation: "1" });
    assert.equal(unboundClaim.task?.id, unbound.id);
    assert.equal(unboundClaim.coverage.evidence, "unknown");
    assert.equal(unboundClaim.coverage.reason, "ineligible_observer");
    assert.equal(unboundClaim.coverage.queue_episode, null);
    assert.equal(unboundClaim.coverage.notice_id, null);
    assert.equal((await markers(unbound.id)).length, 1);

    const wrongFilterTask = await make("wrong-filter");
    const wrongFilter = await bind("status");
    const wrongFilterClaim = await claim(wrongFilterTask, wrongFilter);
    assert.equal(wrongFilterClaim.task?.id, wrongFilterTask.id);
    assert.equal(wrongFilterClaim.coverage.evidence, "unknown");
    assert.equal(wrongFilterClaim.coverage.queue_episode, null);
    assert.equal(wrongFilterClaim.coverage.notice_id, null);

    const absent = await make("notice-absent");
    const eligibleOff = await bind("task-ready");
    const absentClaim = await claim(absent, eligibleOff);
    const absentMarkers = await markers(absent.id);
    assert.equal(absentClaim.task?.id, absent.id);
    assert.equal(absentClaim.coverage.evidence, "unnotified_or_expired");
    assert.equal(absentClaim.coverage.reason, "notice_absent");
    assert.equal(absentClaim.coverage.queue_episode, absentMarkers[0].id);
    assert.equal(absentClaim.coverage.notice_id, null);
    assert.equal((await notices(absent.id)).length, 0);

    const wrongGenTask = await make("wrong-generation");
    const wrongGenClaim = await claim(wrongGenTask, { ...eligibleOff, generation: eligibleOff.generation === "0" ? "1" : "0" });
    assert.equal(wrongGenClaim.task?.id, wrongGenTask.id);
    assert.equal(wrongGenClaim.coverage.evidence, "unknown");
    assert.equal(wrongGenClaim.coverage.queue_episode, null);
    assert.equal(wrongGenClaim.coverage.notice_id, null);

    process.env[PRODUCER] = "1";
    const visible = await make("visible-claim");
    const visibleMarkers = await markers(visible.id);
    const visibleNotices = await notices(visible.id);
    const visibleClaim = await claim(visible, eligibleOff);
    assert.equal(visibleClaim.task?.id, visible.id);
    assert.equal(visibleClaim.coverage.evidence, "notified");
    assert.equal(visibleClaim.coverage.reason, "exact_notice");
    assert.equal(visibleClaim.coverage.queue_episode, visibleMarkers[0].id);
    assert.equal(visibleClaim.coverage.notice_id, visibleNotices[0].id);
    assert.equal(visibleClaim.coverage.notice_at == null, false);
    assert.equal("notice_id" in (visibleClaim.task ?? {}), false);
    assert.equal((await notices(visible.id)).length, 1, "a claim does not write or consume a notice");

    const expiredRows = 5000;
    await sql()`insert into events (kind, detail, created_at)
      select 'ak78-expired', '{}'::jsonb, statement_timestamp() - interval '60 days'
      from generate_series(1, ${expiredRows})`;
    await sql()`analyze events`;
    const bounded = await make("bounded-scan");
    const boundedMarkers = await markers(bounded.id);
    const readsBefore = await sql()`select idx_tup_read::bigint as n from pg_stat_user_indexes where indexrelname = 'events_created_idx'`;
    const boundedClaim = await claim(bounded, eligibleOff);
    const readsAfter = await sql()`select idx_tup_read::bigint as n from pg_stat_user_indexes where indexrelname = 'events_created_idx'`;
    const readDelta = Number(readsAfter[0].n) - Number(readsBefore[0].n);
    assert.equal(boundedClaim.coverage.evidence, "notified");
    assert.equal(boundedClaim.coverage.queue_episode, boundedMarkers[0].id);
    assert.ok(readDelta < expiredRows / 2, `episode scan read ${readDelta} index tuples after inserting ${expiredRows} expired rows`);
    const explained = await sql()`explain (analyze, format json)
      with cutoff as materialized (
        select statement_timestamp() - (30::int * interval '1 day') as ts
      )
      select e.id from events e
      where e.created_at >= (select ts from cutoff)
      order by e.created_at desc
      limit 500`;
    const planRoot = explained[0]["QUERY PLAN"] as { Plan: Record<string, unknown> }[];
    const planNodes: Record<string, unknown>[] = [];
    const walkPlan = (node: Record<string, unknown>) => {
      planNodes.push(node);
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walkPlan(child);
    };
    walkPlan(planRoot[0].Plan);
    const indexScan = planNodes.find((node) => node["Index Name"] === "events_created_idx");
    assert.ok(indexScan, "bounded slice did not use events_created_idx");
    assert.match(String(indexScan["Index Cond"] ?? ""), /created_at/);
    const removed = planNodes.reduce((sum, node) => sum + Number(node["Rows Removed by Filter"] ?? 0), 0);
    assert.ok(removed < expiredRows, `plan removed ${removed} expired rows by filter`);
    await sql()`insert into events (kind, detail, created_at)
      select 'ak78-filler', '{}'::jsonb, statement_timestamp() + interval '6 hours'
      from generate_series(1, ${600})`;
    const tiedPlan = await sql()`explain (analyze, format json)
      select e.id from events e
      where e.created_at >= statement_timestamp() - interval '30 days'
      order by e.created_at desc
      limit 500`;
    const tiedRoot = tiedPlan[0]["QUERY PLAN"] as { Plan: Record<string, unknown> }[];
    const tiedNodes: Record<string, unknown>[] = [];
    const walkTied = (node: Record<string, unknown>) => {
      tiedNodes.push(node);
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walkTied(child);
    };
    walkTied(tiedRoot[0].Plan);
    const tiedScan = tiedNodes.find((node) => node["Index Name"] === "events_created_idx");
    assert.ok(tiedScan, "equal-timestamp slice did not use events_created_idx");
    assert.ok(Number(tiedScan["Actual Rows"] ?? 0) <= 500, `equal-timestamp scan read ${String(tiedScan["Actual Rows"])} rows`);
    await sql()`delete from events where kind = 'ak78-filler'`;

    const requeuedTask = await make("requeue-latest");
    await updateTask({ id: requeuedTask.id, status: "failed" });
    await updateTask({ id: requeuedTask.id, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    const latestMarkers = await markers(requeuedTask.id);
    assert.equal(latestMarkers.length, 2);
    const requeuedClaim = await claim(requeuedTask, eligibleOff);
    assert.equal(requeuedClaim.coverage.queue_episode, latestMarkers[1].id);
    assert.equal(requeuedClaim.coverage.evidence, "notified");

    const tied = await make("same-timestamp");
    await updateTask({ id: tied.id, status: "failed" });
    await updateTask({ id: tied.id, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    const tiedMarkers = await markers(tied.id);
    await sql()`update events set created_at = statement_timestamp() + interval '3 hours'
      where id = any(${tiedMarkers.map((marker) => marker.id)}::bigint[])`;
    const tiedClaim = await claim(tied, eligibleOff);
    assert.equal(tiedClaim.coverage.queue_episode, tiedMarkers[1].id, "the later receipt wins an equal timestamp");

    const buried = await make("buried-requeue");
    await updateTask({ id: buried.id, status: "failed" });
    await updateTask({ id: buried.id, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    const buriedMarkers = await markers(buried.id);
    await sql()`update events set created_at = statement_timestamp() + interval '1 hour'
      where id = any(${buriedMarkers.map((marker) => marker.id)}::bigint[])`;
    await sql()`insert into events (kind, detail, created_at)
      select 'ak78-filler', '{}'::jsonb, statement_timestamp() + interval '2 hours'
      from generate_series(1, ${500})`;
    const buriedClaim = await claim(buried, eligibleOff);
    assert.equal(buriedClaim.coverage.evidence, "unknown_history");
    assert.equal(buriedClaim.coverage.queue_episode, null);
    assert.notEqual(buriedClaim.coverage.queue_episode, buriedMarkers[0].id);

    const edge = await make("open-edge");
    await updateTask({ id: edge.id, status: "failed" });
    await updateTask({ id: edge.id, status: "queued", eventKind: "task_requeued", activityTool: "requeue_task" });
    const edgeMarkers = await markers(edge.id);
    await sql()`update events set created_at = statement_timestamp() + interval '4 hours'
      where id = any(${edgeMarkers.map((marker) => marker.id)}::bigint[])`;
    await sql()`insert into events (kind, detail, created_at)
      select 'ak78-filler', '{}'::jsonb, statement_timestamp() + interval '5 hours'
      from generate_series(1, ${499})`;
    const edgeClaim = await claim(edge, eligibleOff);
    assert.equal(edgeClaim.coverage.evidence, "unknown_history");
    assert.equal(edgeClaim.coverage.reason, "audit_window_truncated");
    assert.equal(edgeClaim.coverage.queue_episode, null);

    const stale = await make("stale-history");
    const staleMarkers = await markers(stale.id);
    await sql()`update events set created_at = statement_timestamp() - interval '60 days' where id = ${staleMarkers[0].id}::bigint`;
    const staleClaim = await claim(stale, eligibleOff);
    assert.equal(staleClaim.coverage.evidence, "unknown_history");
    assert.equal(staleClaim.coverage.queue_episode, null);

    const waitForClaim = async (proof: TaskNoticeObserverProof, mutate: (holder: Client) => Promise<void>) => {
      const held = await make("lock-race");
      const holder = new Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      let committed = false;
      try {
        await holder.query("begin");
        await holder.query("select id from event_stream_consumers where id = $1 for update", [proof.consumer]);
        const pending = claim(held, proof);
        const watcher = new Client({ connectionString: process.env.DATABASE_URL });
        await watcher.connect();
        try {
          let waiting = false;
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const state = await watcher.query(
              "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%with changed%' and pid <> pg_backend_pid()",
            );
            if (state.rowCount) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(waiting, true, "coverage claim did not wait on the consumer lock");
          await mutate(holder);
        } finally {
          await watcher.end();
        }
        await holder.query("commit");
        committed = true;
        const result = await pending;
        assert.equal(result.task?.id, held.id);
        assert.equal(result.task?.status, "claimed");
        assert.equal(result.coverage.evidence, "unknown");
        assert.equal(result.coverage.queue_episode, null);
        assert.equal(result.coverage.notice_id, null);
      } finally {
        if (!committed) await holder.query("rollback").catch(() => undefined);
        await holder.end();
      }
    };

    const revoked = await bind("task-ready");
    await waitForClaim(revoked, async (holder) => {
      await holder.query("update agent_credentials set revoked_at = clock_timestamp() where id = $1", [revoked.credentialId]);
    });
    const narrowed = await bind("task-ready");
    await waitForClaim(narrowed, async (holder) => {
      await holder.query("update agent_credentials set scopes = array['tasks:read']::text[] where id = $1", [narrowed.credentialId]);
    });
    const moved = await bind("task-ready");
    await waitForClaim(moved, async (holder) => {
      await holder.query("update event_stream_consumers set generation = generation + 1 where id = $1", [moved.consumer]);
    });
    const filtered = await bind("task-ready");
    await waitForClaim(filtered, async (holder) => {
      await holder.query("update event_stream_consumers set event_types = array['status']::text[] where id = $1", [filtered.consumer]);
    });

    const timeoutProof = await bind("task-ready");
    const timeoutTask = await make("lock-timeout");
    const timeoutHolder = new Client({ connectionString: process.env.DATABASE_URL });
    await timeoutHolder.connect();
    try {
      await timeoutHolder.query("begin");
      await timeoutHolder.query("select id from event_stream_consumers where id = $1 for update", [timeoutProof.consumer]);
      const pending = claim(timeoutTask, timeoutProof);
      const outcome = await Promise.race([
        pending.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 4000)),
      ]);
      assert.equal(outcome, "rejected");
      const status = await sql()`select status from tasks where id = ${timeoutTask.id}`;
      assert.equal(status[0].status, "queued");
      const claimedReceipts = await sql()`select count(*)::int as n from events
        where kind = 'task_claimed' and detail->>'task_id' = ${String(timeoutTask.id)}`;
      assert.equal(Number(claimedReceipts[0].n), 0, "a lock timeout must not commit a claim");
    } finally {
      await timeoutHolder.query("rollback").catch(() => undefined);
      await timeoutHolder.end();
    }

    const fk = await sql()`select count(*)::int as n from pg_constraint where confrelid = 'public.gh_events'::regclass`;
    assert.equal(Number(fk[0].n), 0, "inbox retention has no foreign key onto gh_events");
  } finally {
    if (previous === undefined) delete process.env[PRODUCER];
    else process.env[PRODUCER] = previous;
    if (taskIds.length) {
      await sql()`delete from gh_events where payload->>'task_id' = any(${taskIds}::text[])`;
      await sql()`delete from events where detail->>'task_id' = any(${taskIds}::text[])`;
      await sql()`delete from tasks where id = any(${taskIds}::bigint[])`;
    }
    if (idempotencyKeys.length) {
      await sql()`delete from idempotency_keys where idempotency_key = any(${idempotencyKeys}::text[])`;
    }
    if (consumerIds.length) {
      await sql()`delete from event_stream_consumers where id = any(${consumerIds}::text[])`;
    }
    if (credentialIds.length) {
      await sql()`delete from agent_credentials where id = any(${credentialIds}::text[])`;
    }
    await sql()`delete from events where kind in ('ak78-expired', 'ak78-filler')`;
  }
}

if (process.argv[1]?.endsWith("pg-task-notice-tests.ts")) {
  testTaskQueueNotices()
    .then(() => {
      console.log("pg task notice tests passed");
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
